'use strict';

/**
 * The blank sheet the parish downloads before importing.
 *
 * The check that matters is the round trip. A template is only worth having if
 * the importer reads back every heading it prints — a column the office fills
 * in and the import silently ignores is worse than no template at all, because
 * the data looks like it arrived and did not. So the file the route serves is
 * put through the importer's own header mapper and its own date reader, and
 * every column has to land somewhere.
 *
 * The rest is who may take it, and that the relation codes in the examples are
 * this parish's own rather than a fixed set that would contradict its Settings
 * page.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parish-template-'));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'template-test-secret';
process.env.NODE_ENV = 'test';
process.env.SECURE_COOKIES = '0';

const PORT = 4006;
const PASSWORD = 'test-password-1234';

const csv = require('../lib/csv');
const importColumns = require('../lib/import-columns');
const { readDate } = require('../lib/import-dates');

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

/** A client that keeps its cookie. */
function makeClient() {
  let cookie = '';
  return function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const data = body ? new URLSearchParams(body).toString() : null;
      const req = http.request({
        host: '127.0.0.1', port: PORT, path: urlPath, method,
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

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          location: res.headers.location,
          body: Buffer.concat(chunks).toString('utf8')
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

async function main() {
  const db = require('../db');
  const auth = require('../lib/auth');

  await db.init();

  const diocese = await db.Diocese.create({ name: 'Trichy', created_at: db.now() });
  const church = await db.Church.create({
    diocese_id: diocese.id, zone_id: null,
    name: 'Alpha Church', slug: 'alpha', city: 'Town', created_at: db.now()
  });

  // This parish uses short codes rather than the shipped defaults. The
  // template has to follow it.
  await db.ChurchSetting.create({
    church_id: church.id, key: 'relation_options', value: 'HF, W, S, D'
  });

  await db.User.create({
    username: 'alpha-admin', password_hash: await auth.hashPassword(PASSWORD),
    full_name: 'Alpha Admin', role: 'admin', church_id: church.id, created_at: db.now()
  });
  await db.User.create({
    username: 'alpha-editor', password_hash: await auth.hashPassword(PASSWORD),
    full_name: 'Alpha Editor', role: 'editor', church_id: church.id, created_at: db.now()
  });
  await db.User.create({
    username: 'root', password_hash: await auth.hashPassword(PASSWORD),
    full_name: 'Super', role: 'superadmin', church_id: null, created_at: db.now()
  });

  const app = require('../app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const admin = makeClient();
  await signIn(admin, 'alpha-admin');

  console.log('');
  console.log('--- the page that offers it ---');
  let res = await admin('GET', '/admin/import');
  check('renders for an administrator', res.status === 200, `status ${res.status}`);
  check('and names every column the importer knows',
    importColumns.FIELDS.every((f) => res.body.includes(importColumns.LABELS[f])),
    'a column was missing from the page');
  check('with this parish’s own relation codes',
    res.body.includes('<code>HF</code>') && res.body.includes('<code>W</code>'),
    'the page offered relation codes this parish does not use');
  check('and offers the administrator somewhere to upload the filled-in sheet',
    res.body.includes('name="sheet"') && res.body.includes('enctype="multipart/form-data"'),
    'the page had no upload form on it');
  // A parish administrator has no shell. Printing the load command to them
  // describes a job they cannot do, so it belongs to the super administrator.
  check('without a command line they cannot run',
    !res.body.includes('npm run import-families'),
    'the page showed an administrator the import command');

  // --- and the person who actually runs it ---
  const root = makeClient();
  await signIn(root, 'root');
  const console_ = await root('GET', '/super/churches');
  await root('POST', `/super/churches/${church.id}/act`, {
    _csrf: csrfFrom(console_.body)
  });
  const rootPage = await root('GET', '/admin/import');
  check('a super administrator is shown the command',
    rootPage.status === 200 && rootPage.body.includes('--church alpha'),
    `status ${rootPage.status}; the command was not offered to a super administrator`);


  console.log('');
  console.log('--- the template itself ---');
  res = await admin('GET', '/admin/import-template.csv');
  check('is served as a CSV download',
    res.headers['content-type'].includes('text/csv')
    && (res.headers['content-disposition'] || '').includes('attachment'),
    res.headers['content-disposition']);
  check('named after the parish',
    (res.headers['content-disposition'] || '').includes('alpha-church-members-template.csv'),
    res.headers['content-disposition']);
  check('and opens in Excel as UTF-8',
    res.body.startsWith('﻿'), 'no byte order mark');

  const rows = csv.parse(res.body);
  const { map, unknown } = importColumns.mapHeader(rows[0]);

  console.log('');
  console.log('--- the round trip, which is the whole point ---');
  check('the importer recognises every heading it prints',
    unknown.length === 0, `ignored: ${unknown.join(', ')}`);
  check('and finds a column for every field it can store',
    importColumns.FIELDS.every((f) => map[f] !== undefined),
    `missing: ${importColumns.FIELDS.filter((f) => map[f] === undefined).join(', ')}`);
  check('including the one column it refuses a sheet without',
    importColumns.REQUIRED.every((f) => map[f] !== undefined),
    'no Family ID column');

  const body = rows.slice(1);
  check('the examples are one row per person, not per family',
    body.length === 5 && new Set(body.map((r) => r[map.family_id])).size === 2,
    `${body.length} rows`);

  check('a family’s rows share its Family ID',
    body.filter((r) => r[map.family_id] === 'F-001').length === 3,
    'the grouping example does not group');

  check('the family details sit on the first row of the family',
    body[0][map.address] !== '' && body[1][map.address] === '',
    'the example does not show where family columns go');

  check('a two-line address survives as one cell',
    body[0][map.address].includes('\n'),
    JSON.stringify(body[0][map.address]));

  const badDates = body
    .flatMap((r) => [
      readDate(r[map.dob], { label: 'Date of birth', full: true }),
      readDate(r[map.dom], { label: 'Date of marriage', full: false })
    ])
    .filter((d) => d.error);
  check('every example date is one the importer can read',
    badDates.length === 0, badDates.map((d) => d.error).join('; '));

  const codes = new Set(body.map((r) => r[map.relation]));
  check('and every example relation is a code this parish offers',
    [...codes].every((c) => ['HF', 'W', 'S', 'D'].includes(c)),
    [...codes].join(', '));

  console.log('');
  console.log('--- the headings-only sheet ---');
  res = await admin('GET', '/admin/import-template.csv?examples=0');
  const blank = csv.parse(res.body);
  check('is the same headings with nothing under them',
    blank.length === 1 && blank[0].join('|') === rows[0].join('|'),
    `${blank.length} row(s)`);

  console.log('');
  console.log('--- who may take it ---');
  const editor = makeClient();
  await signIn(editor, 'alpha-editor');

  for (const p of ['/admin/import', '/admin/import-template.csv']) {
    const page = await editor('GET', p);
    check(`an editor is refused ${p}`, page.status === 403, `status ${page.status}`);
  }

  const anonymous = makeClient();
  const out = await anonymous('GET', '/admin/import-template.csv');
  check('a signed-out request is sent to the sign-in page',
    out.status === 302 && String(out.location).startsWith('/login'),
    `status ${out.status} to ${out.location}`);

  server.close();
  await db.close();

  console.log('');
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  console.log('');
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => { cleanUp(); process.exit(code); })
  .catch((err) => {
    console.error(err);
    cleanUp();
    process.exit(1);
  });
