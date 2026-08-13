'use strict';

/**
 * Cross-tenant access. This is the security model, written down and executed.
 *
 * Two churches, each with its own administrator, its own family and its own
 * member login. Every check below asks one church's account for something
 * belonging to the other, and expects to be told no.
 *
 * If this file passes, tenancy holds. If a future change breaks it you find
 * out here, rather than from a parish discovering another parish's telephone
 * numbers in their directory.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parish-tenancy-'));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'tenancy-test-secret';
process.env.NODE_ENV = 'test';
process.env.SECURE_COOKIES = '0';

const PORT = 4002;
const PASSWORD = 'test-password-1234';

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
}

function cleanUp() {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch (err) {
    /* Windows may still hold the SQLite file; the OS will sweep it. */
  }
}

function makeClient() {
  let cookie = '';
  return function request(method, urlPath, body) {
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
          status: res.statusCode, body: out, location: res.headers.location
        }));
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  };
}

const csrfFrom = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];

async function signIn(request, username) {
  const page = await request('GET', '/login');
  return request('POST', '/login', {
    _csrf: csrfFrom(page.body), username, password: PASSWORD
  });
}

async function post(request, from, action, body = {}) {
  const page = await request('GET', from);
  return request('POST', action, { _csrf: csrfFrom(page.body), ...body });
}

/** Anything that is not a success — the route may 404, 403 or redirect away. */
const refused = (res) => res.status === 404 || res.status === 403 || res.status === 302;

async function buildChurch(db, auth, { name, slug, admin, head, email }) {
  const church = await db.Church.create({
    diocese_id: 1, zone_id: null, name, slug, created_at: db.now()
  });

  const adminUser = await db.User.create({
    username: admin,
    password_hash: await auth.hashPassword(PASSWORD),
    full_name: admin,
    role: 'admin',
    church_id: church.id,
    created_at: db.now()
  });

  const Family = require('../models/family');
  const familyId = await Family.create(church.id, {
    // Both churches deliberately number their first family 0001.
    family_id: '0001',
    head_name: head,
    address: `${name} address`,
    hometown: '',
    home_parish: '',
    spouse_home: '',
    email,
    dom_day: null,
    dom_month: null,
    is_published: true,
    members: [
      { name: `${head} senior`, relation: 'Head', dob_day: null, dob_month: null, dob_year: null, mobile: '', links: '' }
    ]
  });

  const memberUser = await db.User.create({
    username: email,
    password_hash: await auth.hashPassword(PASSWORD),
    full_name: head,
    role: 'family',
    church_id: church.id,
    family_id: familyId,
    created_at: db.now()
  });

  return { church, adminUser, familyId, memberUser };
}

async function main() {
  const db = require('../db');
  const auth = require('../lib/auth');

  await db.init();
  await db.Diocese.create({ name: 'Test Diocese', created_at: db.now() });

  const a = await buildChurch(db, auth, {
    name: 'Church A', slug: 'church-a', admin: 'admin-a',
    head: 'Alpha Family', email: 'alpha@example.com'
  });
  const b = await buildChurch(db, auth, {
    name: 'Church B', slug: 'church-b', admin: 'admin-b',
    head: 'Bravo Family', email: 'bravo@example.com'
  });

  const app = require('../app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const alice = makeClient();
  await signIn(alice, 'admin-a');

  console.log('');
  console.log('--- both churches numbered a family 0001, and both kept it ---');
  check('two families share the reference across churches',
    (await db.Family.count({ where: { family_id: '0001' } })) === 2);

  console.log('');
  console.log("--- reading the other church's family ---");
  let res = await alice('GET', `/families/${b.familyId}`);
  check('by id, it is not found', res.status === 404, `status ${res.status}`);

  res = await alice('GET', `/families/${b.familyId}/edit`);
  check('nor is its edit form', res.status === 404, `status ${res.status}`);

  res = await alice('GET', '/families');
  check('the list shows only this church',
    res.body.includes('Alpha Family') && !res.body.includes('Bravo Family'));

  res = await alice('GET', '/families?q=Bravo');
  check('searching for them finds nothing', !res.body.includes('Bravo Family'));

  res = await alice('GET', '/directory');
  check('the printed directory holds only this church',
    res.body.includes('Alpha Family') && !res.body.includes('Bravo Family'));

  res = await alice('GET', '/');
  check('the dashboard counts only this church',
    res.body.includes('>1<') && !res.body.includes('Bravo'),
    'dashboard may be counting across churches');

  console.log('');
  console.log("--- writing to the other church's family ---");
  res = await post(alice, '/families', `/families/${b.familyId}`, {
    family_id: '0001',
    head_name: 'Hijacked',
    address: 'nowhere',
    hometown: '', home_parish: '', spouse_home: '', email: '',
    is_published: '1',
    'members[0][name]': 'Intruder',
    'members[0][relation]': 'Head',
    'members[0][mobile]': '',
    'members[0][links]': ''
  });
  check('an update is refused', refused(res), `status ${res.status}`);

  const bravo = await db.Family.findByPk(b.familyId);
  check('and their family is untouched', bravo.head_name === 'Bravo Family', bravo.head_name);

  res = await post(alice, '/families', `/families/${b.familyId}/delete`);
  check('a delete is refused', refused(res), `status ${res.status}`);
  check('and their family still exists', !!(await db.Family.findByPk(b.familyId)));

  console.log('');
  console.log("--- reaching the other church's accounts ---");
  res = await alice('GET', '/admin/users');
  check('the users page lists only this church',
    res.body.includes('admin-a') && !res.body.includes('admin-b'));

  for (const [action, body, label] of [
    ['password', { password: 'hijacked-password-1', password_confirm: 'hijacked-password-1' }, 'resetting their password'],
    ['role', { role: 'viewer' }, 'changing their role'],
    ['active', { is_active: '0' }, 'deactivating them'],
    ['delete', {}, 'deleting them']
  ]) {
    res = await post(alice, '/admin/users', `/admin/users/${b.adminUser.id}/${action}`, body);
    check(`${label} is refused`, refused(res), `status ${res.status}`);
  }

  await b.adminUser.reload();
  check('their administrator still exists', !!(await db.User.findByPk(b.adminUser.id)));
  check('with their role intact', b.adminUser.role === 'admin', b.adminUser.role);
  check('and still active', b.adminUser.is_active === true);
  check('and their password unchanged',
    await auth.verifyPassword(PASSWORD, b.adminUser.password_hash));

  console.log('');
  console.log('--- the last administrator is counted per church ---');
  res = await post(alice, '/admin/users', `/admin/users/${a.adminUser.id}/delete`);
  check('church A cannot delete its only administrator',
    !!(await db.User.findByPk(a.adminUser.id)),
    'it was deleted even though church B still has one');

  console.log('');
  console.log('--- a member login reaches one family and no other ---');
  const member = makeClient();
  await signIn(member, 'alpha@example.com');

  res = await member('GET', `/families/${a.familyId}`);
  check('their own entry opens', res.status === 200, `status ${res.status}`);

  res = await member('GET', `/families/${b.familyId}`);
  check("another church's family is refused", refused(res), `status ${res.status}`);

  res = await member('GET', '/families');
  check('the list sends them back to their own entry',
    res.status === 302 && res.location === `/families/${a.familyId}`,
    `${res.status} -> ${res.location}`);

  res = await member('GET', '/directory');
  check('the printed directory is refused', refused(res), `status ${res.status}`);

  res = await member('GET', '/admin/users');
  check('the accounts page is refused', refused(res), `status ${res.status}`);

  res = await member('GET', '/super');
  check('the console is refused', refused(res), `status ${res.status}`);

  console.log('');
  console.log('');
  console.log("--- photographs stay in the folder of the church that owns them ---");
  const uploadDir = path.join(dataDir, "uploads");

  // A photograph for each church, written where the app would write it.
  for (const c of [a, b]) {
    const dir = path.join(uploadDir, String(c.church.id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "photo.jpg"), "not really a jpeg");
  }

  res = await alice("GET", `/uploads/${a.church.id}/photo.jpg`);
  check('a church can fetch its own photograph', res.status === 200, `status ${res.status}`);

  res = await alice("GET", `/uploads/${b.church.id}/photo.jpg`);
  check("another church's photograph is refused", res.status === 403, `status ${res.status}`);

  res = await alice("GET", `/uploads/${b.church.id}/../${a.church.id}/photo.jpg`);
  check('climbing out of the folder does not reach one either',
    res.status !== 200 || !res.body.includes("not really a jpeg"),
    `status ${res.status}`);

  const memberPeek = makeClient();
  await signIn(memberPeek, 'alpha@example.com');
  res = await memberPeek("GET", `/uploads/${b.church.id}/photo.jpg`);
  check('and a member login cannot reach it either', res.status === 403, `status ${res.status}`);

  console.log('--- settings stay with their church ---');
  res = await post(alice, '/admin/settings', '/admin/settings', {
    parish_name: 'Church A Renamed',
    directory_title: 'A Directory',
    default_member_password: 'church-a-members-2026',
    relation_options: 'Head, Wife',
    starting_page: '1',
    per_page: '2',
    color_band: '#111111',
    color_band_dark: '#222222',
    color_member_a: '#333333',
    color_member_b: '#444444',
    color_rule: '#555555'
  });
  check('church A can save its own settings', res.status === 200, `status ${res.status}`);

  const settingsLib = require('../lib/settings');
  check('church B did not inherit the change',
    (await settingsLib.load(b.church.id)).parish_name !== 'Church A Renamed');
  check("church B cannot see church A's member password",
    (await settingsLib.load(b.church.id)).default_member_password !== 'church-a-members-2026',
    "one church can read the password that opens another church's new accounts");

  check('church B has no stray rows',
    (await db.ChurchSetting.count({ where: { church_id: b.church.id } })) === 0);

  server.close();
  await db.close();

  console.log('');
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  console.log('');
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    cleanUp();
    process.exit(code);
  })
  .catch((err) => {
    console.error('\nThe tenancy test threw:\n', err);
    cleanUp();
    process.exit(1);
  });
