'use strict';

/**
 * Selection, the combined book, and the export.
 *
 * The check that matters most here is the boring one: an empty selection must
 * produce nothing. A resolver that quietly falls back to "everything" when it
 * is given nothing would hand a whole installation's addresses to whoever
 * clicked the wrong link, and would look like it was working.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parish-reports-'));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'reports-test-secret';
process.env.NODE_ENV = 'test';
process.env.SECURE_COOKIES = '0';

const PORT = 4003;
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
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { out += chunk; });
        res.on('end', () => resolve({
          status: res.statusCode, body: out,
          location: res.headers.location, headers: res.headers
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
  const Family = require('../models/family');
  const settingsLib = require('../lib/settings');

  await db.init();

  const trichy = await db.Diocese.create({ name: 'Trichy', created_at: db.now() });
  const madurai = await db.Diocese.create({ name: 'Madurai', created_at: db.now() });
  const chalakudy = await db.Zone.create({
    diocese_id: trichy.id, name: 'Chalakudy', created_at: db.now()
  });

  async function church(name, slug, dioceseId, zoneId, head) {
    const c = await db.Church.create({
      diocese_id: dioceseId, zone_id: zoneId, name, slug, city: 'Town', created_at: db.now()
    });
    await Family.create(c.id, {
      family_id: '0001', head_name: head, address: '1 Road',
      hometown: '', home_parish: '', spouse_home: '', email: '',
      dom_day: null, dom_month: null, is_published: true,
      members: [
        { name: head + ' one', relation: 'Head', dob_day: null, dob_month: null, dob_year: null, mobile: '1', links: '' },
        { name: head + ' two', relation: 'Spouse', dob_day: null, dob_month: null, dob_year: null, mobile: '2', links: '' }
      ]
    });
    return c;
  }

  // Alpha is zoned; Beta is in the same diocese but unzoned; Gamma is elsewhere.
  const alpha = await church('Alpha Church', 'alpha', trichy.id, chalakudy.id, 'HeadOne');
  const beta = await church('Beta Church', 'beta', trichy.id, null, 'HeadTwo');
  const gamma = await church('Gamma Church', 'gamma', madurai.id, null, 'HeadThree');

  // Give two churches different palettes, to prove the book keeps them apart.
  await settingsLib.save(alpha.id, { color_band: '#aa1111', parish_name: 'Alpha Parish' });
  await settingsLib.save(gamma.id, { color_band: '#00cc00', parish_name: 'Gamma Parish' });

  await db.User.create({
    username: 'root', password_hash: await auth.hashPassword(PASSWORD),
    full_name: 'Super', role: 'superadmin', church_id: null, created_at: db.now()
  });
  await db.User.create({
    username: 'alpha-admin', password_hash: await auth.hashPassword(PASSWORD),
    full_name: 'Alpha Admin', role: 'admin', church_id: alpha.id, created_at: db.now()
  });

  const app = require('../app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const root = makeClient();
  await signIn(root, 'root');

  console.log('');
  console.log('--- an empty selection means nothing, never everything ---');
  let res = await root('GET', '/super/reports');
  check('the page renders with nothing chosen', res.status === 200, `status ${res.status}`);
  check('and lists no families',
    !res.body.includes('HeadOne') && !res.body.includes('HeadTwo')
    && !res.body.includes('HeadThree'),
    'families leaked into an empty selection');

  res = await root('GET', '/super/export.csv');
  const emptyRows = res.body.trim().split('\r\n').length;
  check('an export of nothing has only its header row', emptyRows === 1, `${emptyRows} rows`);

  res = await root('GET', '/super/print');
  check('a book of nothing says so', res.body.includes('Nothing to print'));

  console.log('');
  console.log('--- the four ways of choosing ---');
  res = await root('GET', `/super/reports?churches=${alpha.id}`);
  check('by church', res.body.includes('HeadOne') && !res.body.includes('HeadThree'));

  res = await root('GET', `/super/reports?zones=${chalakudy.id}`);
  check('by zone', res.body.includes('HeadOne') && !res.body.includes('HeadTwo'));

  res = await root('GET', `/super/reports?dioceses=${trichy.id}`);
  check('by diocese, including its unzoned church',
    res.body.includes('HeadOne') && res.body.includes('HeadTwo')
    && !res.body.includes('HeadThree'),
    'an unzoned church was missed, which is what churches.diocese_id exists to prevent');

  res = await root('GET', '/super/reports?all=1');
  check('all churches',
    res.body.includes('HeadOne') && res.body.includes('HeadTwo')
    && res.body.includes('HeadThree'));

  res = await root('GET', `/super/reports?dioceses=${madurai.id}&churches=${alpha.id}`);
  check('a diocese plus one extra church',
    res.body.includes('HeadThree') && res.body.includes('HeadOne')
    && !res.body.includes('HeadTwo'));

  res = await root('GET', '/super/reports?churches=9999');
  check('an id that no longer exists degrades rather than failing', res.status === 200);

  console.log('');
  console.log('--- the combined book ---');
  res = await root('GET', '/super/print?all=1');
  check('it renders', res.status === 200, `status ${res.status}`);
  check('with a section per church',
    (res.body.match(/class="church-section"/g) || []).length === 3,
    `${(res.body.match(/class="church-section"/g) || []).length} sections`);

  check('each church in its own colours',
    res.body.includes('--band: #aa1111') && res.body.includes('--band: #00cc00'),
    'the per-section palettes did not come through');

  check('the section titles use each parish name',
    res.body.includes('Alpha Parish') && res.body.includes('Gamma Parish'));

  const folios = (res.body.match(/class="folio">(\d+)</g) || [])
    .map((m) => Number(m.replace(/\D/g, '')));
  check('page numbers run continuously across churches',
    folios.length === 3 && folios[0] === 1 && folios[1] === 2 && folios[2] === 3,
    `folios: ${folios.join(', ')}`);

  check('every family is in it',
    res.body.includes('HeadOne') && res.body.includes('HeadTwo')
    && res.body.includes('HeadThree'));

  console.log('');
  console.log('--- the export ---');
  res = await root('GET', '/super/export.csv?all=1');
  check('it is served as a CSV download',
    res.headers['content-type'].includes('text/csv')
    && (res.headers['content-disposition'] || '').includes('attachment'),
    res.headers['content-disposition']);

  check('the filename carries the selection and the date',
    /all-churches-\d{4}-\d{2}-\d{2}\.csv/.test(res.headers['content-disposition'] || ''),
    res.headers['content-disposition']);

  check('it begins with a UTF-8 byte order mark, so Excel reads names correctly',
    res.body.charCodeAt(0) === 0xFEFF,
    'first char is ' + res.body.charCodeAt(0).toString(16));

  const rows = res.body.replace(/^﻿/, '').trim().split('\r\n');
  check('the header names the two levels above a church',
    rows[0].startsWith('"Diocese","Zone","Church"'), rows[0].slice(0, 60));

  check('there is one row per member, not per family',
    rows.length === 1 + 6, `${rows.length} rows for 3 families of 2`);

  check('an unzoned church exports an empty zone cell, not the word None',
    rows.some((r) => r.includes('"Trichy","","Beta Church"')),
    rows.find((r) => r.includes('Beta Church')));

  check('a zoned church carries its zone',
    rows.some((r) => r.includes('"Trichy","Chalakudy","Alpha Church"')));

  console.log('');
  console.log('--- none of it is reachable by a church administrator ---');
  const parish = makeClient();
  await signIn(parish, 'alpha-admin');

  for (const p of ['/super/reports', '/super/print?all=1', '/super/export.csv?all=1']) {
    const page = await parish('GET', p);
    check(`${p} is refused`, page.status === 403, `status ${page.status}`);
  }

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
    console.error('\nThe reports test threw:\n', err);
    cleanUp();
    process.exit(1);
  });
