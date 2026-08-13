'use strict';

/**
 * End-to-end smoke test.
 *
 * Builds a throwaway directory in a temporary folder, starts the app against
 * it, and drives it over HTTP the way a person would: sign in, read every
 * page, search, save a family, sign out.
 *
 * It exists because the data layer moved from hand-written SQL to Sequelize,
 * and "it still parses" is not the same as "it still works". Run it after any
 * change to db/, models/ or routes/:
 *
 *     npm test
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

// These must be set before config is required — it reads them once, at load.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parish-smoke-'));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'smoke-test-secret';
process.env.NODE_ENV = 'test';
// Otherwise the session cookie is Secure-only and this test speaks plain
// HTTP, so express-session would decline to set it at all and every request
// would arrive with a brand new session.
process.env.SECURE_COOKIES = '0';

const PORT = 3999;
const PASSWORD = 'test-password-1234';

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
}

let cookie = '';
function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? new URLSearchParams(body).toString() : null;
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: urlPath,
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(data)
        } : {})
      }
    }, (res) => {
      const set = res.headers['set-cookie'];
      if (set) cookie = set.map((c) => c.split(';')[0]).join('; ');
      let out = '';
      res.on('data', (chunk) => { out += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: out,
        location: res.headers.location
      }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function cleanUp() {
  // Windows holds a lock on an open SQLite file. A run that failed before
  // closing it must not turn that into an EBUSY stack that hides the real
  // error, so the temp directory is left for the operating system to sweep.
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch (err) {
    /* nothing useful to do about it here */
  }
}

const csrfFrom = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];

async function seed(db, auth) {
  const diocese = await db.Diocese.create({ name: 'Test Diocese', created_at: db.now() });
  const zone = await db.Zone.create({
    diocese_id: diocese.id,
    name: 'Test Zone',
    created_at: db.now()
  });
  const church = await db.Church.create({
    diocese_id: diocese.id,
    zone_id: zone.id,
    name: 'Test Church',
    slug: 'test-church',
    created_at: db.now()
  });

  await db.User.create({
    username: 'tester',
    password_hash: await auth.hashPassword(PASSWORD),
    full_name: 'Test Administrator',
    role: 'admin',
    church_id: church.id,
    created_at: db.now()
  });

  const Family = require('../models/family');
  await Family.create(church.id, {
    family_id: '0001',
    head_name: 'Steve Smith',
    address: '1 Old Road',
    hometown: '',
    home_parish: '',
    spouse_home: '',
    email: 'steve@example.com',
    dom_day: 14,
    dom_month: 3,
    is_published: true,
    members: [
      {
        name: 'Mr. Steve Smith',
        relation: 'Head',
        dob_day: 2, dob_month: 8, dob_year: 1975,
        mobile: '111', links: ''
      },
      {
        name: 'Mrs. Riva Smith',
        relation: 'Wife',
        dob_day: 11, dob_month: 5, dob_year: 1978,
        mobile: '', links: ''
      }
    ]
  });
}

async function main() {
  const db = require('../db');
  const auth = require('../lib/auth');

  await db.init();
  await seed(db, auth);

  const app = require('../app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  console.log('\n--- before signing in ---');
  let res = await request('GET', '/login');
  check('the sign-in page renders', res.status === 200, `status ${res.status}`);

  const loginToken = csrfFrom(res.body);
  check('it carries a CSRF token', !!loginToken);

  res = await request('GET', '/families');
  check('an anonymous visitor is sent to sign in',
    res.status === 302 && res.location === '/login',
    `${res.status} -> ${res.location}`);

  console.log('\n--- signing in ---');
  res = await request('POST', '/login', {
    _csrf: loginToken, username: 'tester', password: PASSWORD
  });
  check('a correct password signs in', res.status === 302, `status ${res.status}`);

  console.log('\n--- every page an administrator uses ---');
  const pages = [
    ['/', 'Dashboard', ['Coming up']],
    ['/families', 'Families', ['Steve Smith', '0001']],
    ['/families/1', 'One family', ['Steve Smith', 'Mrs. Riva Smith']],
    ['/families/1/edit', 'Edit a family', ['Steve Smith']],
    ['/families/new', 'Add a family', []],
    ['/directory', 'Printed directory', ['Steve Smith', 'FAMILY ID']],
    ['/admin/users', 'User accounts', ['tester']],
    ['/admin/settings', 'Settings', []],
    ['/account', 'My account', []]
  ];

  for (const [urlPath, label, needles] of pages) {
    const page = await request('GET', urlPath);
    const missing = needles.filter((needle) => !page.body.includes(needle));
    check(`${label} (${urlPath})`,
      page.status === 200 && !missing.length,
      page.status !== 200 ? `status ${page.status}` : `missing: ${missing.join(', ')}`);
  }

  console.log('\n--- search, which reaches across to the members table ---');
  res = await request('GET', '/families?q=Riva');
  check('a member name finds their family',
    res.status === 200 && res.body.includes('Steve Smith'), `status ${res.status}`);

  res = await request('GET', '/families?q=nothingmatchesthis');
  check('a search matching nothing still renders', res.status === 200);

  console.log('\n--- saving a family ---');
  res = await request('GET', '/families/1/edit');
  res = await request('POST', '/families/1', {
    _csrf: csrfFrom(res.body),
    family_id: '0001',
    head_name: 'Steve Smith',
    address: '12 New Lane',
    hometown: '',
    home_parish: '',
    spouse_home: '',
    email: 'steve@example.com',
    dom_day: '14',
    dom_month: '3',
    is_published: '1',
    'members[0][name]': 'Mr. Steve Smith',
    'members[0][relation]': 'Head',
    'members[0][dob]': '1975-08-02',
    'members[0][mobile]': '111',
    'members[0][links]': '',
    'members[1][name]': 'Mrs. Riva Smith',
    'members[1][relation]': 'Wife',
    'members[1][dob]': '1978-05-11',
    'members[1][mobile]': '',
    'members[1][links]': ''
  });
  check('saving redirects', res.status === 302, `status ${res.status}`);

  res = await request('GET', '/families/1');
  check('the change was written', res.body.includes('12 New Lane'));
  check('members were replaced rather than duplicated',
    (res.body.match(/Mrs\. Riva Smith/g) || []).length === 1);
  check('the member count is still 2', (await db.Member.count()) === 2);

  console.log('\n--- a family reference is unique per church, not across them ---');
  const second = await db.Church.create({
    diocese_id: 1,
    zone_id: null,
    name: 'Second Church',
    slug: 'second-church',
    created_at: db.now()
  });

  const reused = await db.Family.create({
    church_id: second.id,
    family_id: '0001',
    head_name: 'Another Head',
    created_at: db.now(),
    updated_at: db.now()
  }).then(() => true).catch(() => false);
  check('another church may also number a family 0001', reused);

  const clashed = await db.Family.create({
    church_id: 1,
    family_id: '0001',
    head_name: 'Duplicate',
    created_at: db.now(),
    updated_at: db.now()
  }).then(() => false).catch(() => true);
  check('the same church may not use 0001 twice', clashed);

  console.log('');
  console.log('');
  console.log('--- settings belong to one church, with the house defaults behind them ---');
  const settingsLib = require('../lib/settings');

  await settingsLib.save(second.id, {
    parish_name: 'Second Church Name',
    color_band: '#123456'
  });

  const first = await settingsLib.load(1);
  const other = await settingsLib.load(second.id);

  check('a church sees the name it chose', other.parish_name === 'Second Church Name');
  check('the other church is untouched by that',
    first.parish_name !== 'Second Church Name',
    'church 1 parish_name is ' + first.parish_name);
  check('a key it never set falls back to the house default',
    other.per_page === first.per_page);
  check('the installation vocabulary is shared, not per church',
    other.zone_label === first.zone_label && !!other.zone_label);

  await settingsLib.save(second.id, { parish_name: 'Renamed Again' });
  check('saving again is seen immediately, so the cache invalidates',
    (await settingsLib.load(second.id)).parish_name === 'Renamed Again');

  console.log('--- a church administrator cannot make a super administrator ---');
  res = await request('GET', '/admin/users');
  check('the role menu does not offer it',
    !res.body.includes('value="superadmin"'),
    'the Users page is offering the superadmin role');

  res = await request('POST', '/admin/users', {
    _csrf: csrfFrom(res.body),
    username: 'sneaky',
    full_name: 'Escalation Attempt',
    role: 'superadmin',
    password: 'another-password-99',
    password_confirm: 'another-password-99'
  });
  check('posting the role directly is refused', res.status === 400, `status ${res.status}`);
  check('and no such account was created',
    (await db.User.count({ where: { role: 'superadmin' } })) === 0);

  console.log('\n--- signing out ---');
  res = await request('GET', '/');
  res = await request('POST', '/logout', { _csrf: csrfFrom(res.body) });
  check('signing out redirects', res.status === 302 && res.location === '/login');

  res = await request('GET', '/families');
  check('access is gone afterwards', res.status === 302 && res.location === '/login');

  server.close();
  await db.close();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    cleanUp();
    process.exit(code);
  })
  .catch((err) => {
    console.error('\nThe smoke test threw:\n', err);
    cleanUp();
    process.exit(1);
  });
