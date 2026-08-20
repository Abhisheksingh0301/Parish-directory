'use strict';

/**
 * Downloading the data, and the photographs that go with it.
 *
 * The check that matters here is that the two halves agree. A spreadsheet
 * whose photograph column names a file the archive does not contain is worse
 * than no column at all — it sends somebody looking for an image that was
 * never sent — so every name in the sheet is looked up in the archive, and
 * every photograph in the archive is checked byte for byte against what was
 * uploaded.
 *
 * The archive is read back by this file rather than by a library, for the same
 * reason lib/zip.js writes it by hand: a writer tested only by its own reader
 * proves nothing, so the reader here parses the central directory the way any
 * other tool would and verifies the checksums the writer put in.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parish-export-'));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'export-test-secret';
process.env.NODE_ENV = 'test';
process.env.SECURE_COOKIES = '0';

const PORT = 4005;
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

/** A client that keeps its cookie and can take a response as bytes. */
function makeClient() {
  let cookie = '';
  return function request(method, urlPath, body, { binary = false } = {}) {
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
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            location: res.headers.location,
            buffer,
            body: binary ? '' : buffer.toString('utf8')
          });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  };
}

// ---------------------------------------------------------------------------
// Reading a zip, the way anything else would
// ---------------------------------------------------------------------------

const { crc32 } = require('../lib/zip');

/** Every entry in an archive: its name, its bytes, and whether they check out. */
function readZip(buffer) {
  // The end record is last, after a comment this writer never writes.
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error('no end-of-central-directory record — this is not a zip');

  let count = buffer.readUInt16LE(eocd + 10);
  let start = buffer.readUInt32LE(eocd + 16);

  // ZIP64, when the counts did not fit. The locator sits just before the end
  // record and points at the record that holds the real numbers.
  if (count === 0xffff || start === 0xffffffff) {
    const locator = eocd - 20;
    const record = Number(buffer.readBigUInt64LE(locator + 8));
    count = Number(buffer.readBigUInt64LE(record + 32));
    start = Number(buffer.readBigUInt64LE(record + 48));
  }

  const entries = [];
  let at = start;

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('central directory is malformed');

    const crc = buffer.readUInt32LE(at + 16);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const offset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);

    // Where the data starts depends on this entry's own header, whose name and
    // extra field may be a different length from the central copy.
    const localName = buffer.readUInt16LE(offset + 26);
    const localExtra = buffer.readUInt16LE(offset + 28);
    const from = offset + 30 + localName + localExtra;
    const data = buffer.subarray(from, from + size);

    entries.push({ name, data, size, crcOk: crc32(data) === crc });
    at += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
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
  const config = require('../config');

  await db.init();

  const diocese = await db.Diocese.create({ name: 'Trichy', created_at: db.now() });

  async function church(name, slug) {
    return db.Church.create({
      diocese_id: diocese.id, zone_id: null, name, slug, city: 'Town', created_at: db.now()
    });
  }

  /** A family, optionally with a photograph really written to disk. */
  async function family(churchId, familyId, head, { photo = null, published = true } = {}) {
    let stored = null;
    if (photo) {
      const dir = path.join(config.uploadDir, String(churchId));
      fs.mkdirSync(dir, { recursive: true });
      stored = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`;
      fs.writeFileSync(path.join(dir, stored), photo);
    }

    const id = await Family.create(churchId, {
      family_id: familyId, head_name: head, address: '1 Road',
      hometown: '', home_parish: '', spouse_home: '', email: '',
      photo: stored, dom_day: null, dom_month: null, is_published: published,
      members: [
        { name: `${head} one`, relation: 'Head', dob_day: null, dob_month: null, dob_year: null, mobile: '1', links: '' },
        { name: `${head} two`, relation: 'Spouse', dob_day: null, dob_month: null, dob_year: null, mobile: '2', links: '' }
      ]
    });

    // The stored filename comes back with it: a test that wants to delete the
    // file behind the application's back has to know what it was called.
    return { id, photo: stored };
  }

  const alpha = await church('Alpha Church', 'alpha');
  const beta = await church('Beta Church', 'beta');

  // Deliberately not a real JPEG: what matters is that the bytes survive the
  // archive unchanged, and random bytes prove that better than a valid image.
  const photoOne = crypto.randomBytes(2048);
  const photoTwo = crypto.randomBytes(1024);
  const photoGone = crypto.randomBytes(512);

  await family(alpha.id, '0001', 'Kandathil', { photo: photoOne });
  await family(alpha.id, '0002', 'Vadakkan');
  await family(alpha.id, '0003', 'Puthenpurayil', { photo: photoTwo, published: false });
  const orphan = await family(beta.id, '0001', 'Chackalayil', { photo: photoGone });

  // A photograph on record whose file has gone missing — a restored database,
  // an interrupted copy. The export must still complete.
  fs.unlinkSync(path.join(config.uploadDir, String(beta.id), orphan.photo));

  await db.User.create({
    username: 'root', password_hash: await auth.hashPassword(PASSWORD),
    full_name: 'Super', role: 'superadmin', church_id: null, created_at: db.now()
  });
  await db.User.create({
    username: 'alpha-admin', password_hash: await auth.hashPassword(PASSWORD),
    full_name: 'Alpha Admin', role: 'admin', church_id: alpha.id, created_at: db.now()
  });
  await db.User.create({
    username: 'alpha-editor', password_hash: await auth.hashPassword(PASSWORD),
    full_name: 'Alpha Editor', role: 'editor', church_id: alpha.id, created_at: db.now()
  });

  const app = require('../app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const admin = makeClient();
  await signIn(admin, 'alpha-admin');

  console.log('');
  console.log('--- the page that offers it ---');
  let res = await admin('GET', '/admin/export');
  check('renders for an administrator', res.status === 200, `status ${res.status}`);
  check('and counts what will go into the file',
    res.body.includes('>3<') && res.body.includes('>6<'),
    'families and people were not both counted');

  console.log('');
  console.log('--- the spreadsheet on its own ---');
  res = await admin('GET', '/admin/export.csv');
  check('is served as a CSV download',
    res.headers['content-type'].includes('text/csv')
    && (res.headers['content-disposition'] || '').includes('attachment'),
    res.headers['content-disposition']);

  check('named after the parish and the day',
    /alpha-church-\d{4}-\d{2}-\d{2}\.csv/.test(res.headers['content-disposition'] || ''),
    res.headers['content-disposition']);

  check('and is never cached on the way',
    (res.headers['cache-control'] || '').includes('no-store'),
    res.headers['cache-control']);

  let rows = res.body.replace(/^﻿/, '').trim().split('\r\n');
  check('one row per member, drafts included',
    rows.length === 1 + 6, `${rows.length} rows for 3 families of 2`);

  check('a spreadsheet without photographs has no photograph column',
    rows[0].endsWith('"Links"'), rows[0].slice(-40));

  res = await admin('GET', '/admin/export.csv?drafts=0');
  rows = res.body.replace(/^﻿/, '').trim().split('\r\n');
  check('drafts=0 leaves the unpublished family out',
    rows.length === 1 + 4 && !res.body.includes('Puthenpurayil'),
    `${rows.length} rows`);

  console.log('');
  console.log('--- the archive ---');
  res = await admin('GET', '/admin/export.zip', null, { binary: true });
  check('is served as a zip download',
    res.headers['content-type'] === 'application/zip'
    && /alpha-church-\d{4}-\d{2}-\d{2}\.zip/.test(res.headers['content-disposition'] || ''),
    `${res.headers['content-type']} ${res.headers['content-disposition']}`);

  const entries = readZip(res.buffer);
  const names = entries.map((e) => e.name).sort();
  check('it holds the spreadsheet, a note, and the photographs',
    names.length === 4
    && names.includes('families.csv')
    && names.includes('README.txt')
    && names.filter((n) => n.startsWith('photos/')).length === 2,
    names.join(', '));

  check('every entry passes its own checksum',
    entries.every((e) => e.crcOk),
    entries.filter((e) => !e.crcOk).map((e) => e.name).join(', '));

  check('one church means no per-church folders inside photos/',
    names.filter((n) => n.startsWith('photos/')).every((n) => n.split('/').length === 2),
    names.join(', '));

  check('a photograph is named after its family, not the stored filename',
    names.includes('photos/0001-kandathil.jpg'),
    names.join(', '));

  const stored = entries.find((e) => e.name === 'photos/0001-kandathil.jpg');
  check('and arrives byte for byte as it was uploaded',
    stored && stored.data.equals(photoOne),
    stored ? `${stored.size} bytes, expected ${photoOne.length}` : 'not in the archive');

  const sheet = entries.find((e) => e.name === 'families.csv').data.toString('utf8');
  check('the spreadsheet inside begins with a byte order mark',
    sheet.charCodeAt(0) === 0xFEFF, `first char ${sheet.charCodeAt(0).toString(16)}`);

  const sheetRows = sheet.replace(/^﻿/, '').trim().split('\r\n');
  check('and gains a photograph column',
    sheetRows[0].endsWith('"Photograph"'), sheetRows[0].slice(-40));

  /*
   * The point of the whole feature: every name the sheet gives is a file that
   * is actually in the archive, and a family with no photograph is an empty
   * cell rather than a name that goes nowhere.
   */
  const named = sheetRows.slice(1)
    .map((row) => (row.match(/"([^"]*)"\s*$/) || [])[1])
    .filter(Boolean);
  check('every photograph the sheet names is really in the archive',
    named.length === 4 && named.every((n) => names.includes(n)),
    `${named.length} named: ${[...new Set(named)].join(', ')}`);

  check('a family without a photograph leaves the cell empty',
    sheetRows.some((row) => row.includes('Vadakkan') && row.endsWith('""')),
    sheetRows.find((row) => row.includes('Vadakkan')));

  res = await admin('GET', '/admin/export.zip?drafts=0', null, { binary: true });
  const printable = readZip(res.buffer).map((e) => e.name);
  check('drafts=0 drops the draft family and its photograph too',
    printable.length === 3 && printable.filter((n) => n.startsWith('photos/')).length === 1,
    printable.join(', '));

  console.log('');
  console.log('--- a photograph on record but missing from the disk ---');
  const root = makeClient();
  await signIn(root, 'root');

  res = await root('GET', `/super/export.zip?churches=${beta.id}`, null, { binary: true });
  const betaEntries = readZip(res.buffer);
  const betaNames = betaEntries.map((e) => e.name);
  check('the export still completes', res.status === 200 && betaNames.includes('families.csv'),
    `status ${res.status}: ${betaNames.join(', ')}`);
  check('with no photograph entry for the lost file',
    betaNames.filter((n) => n.startsWith('photos/')).length === 0, betaNames.join(', '));

  const betaSheet = betaEntries.find((e) => e.name === 'families.csv').data.toString('utf8');
  check('and an empty cell rather than a name pointing at nothing',
    betaSheet.trim().split('\r\n').slice(1).every((row) => row.endsWith('""')),
    betaSheet.trim().split('\r\n')[1]);

  console.log('');
  console.log('--- across churches ---');
  res = await root('GET', '/super/export.zip?all=1', null, { binary: true });
  const allNames = readZip(res.buffer).map((e) => e.name);
  check('more than one church puts each one in its own folder',
    allNames.includes('photos/alpha/0001-kandathil.jpg'),
    allNames.join(', '));
  check('so two churches sharing a family id cannot collide',
    new Set(allNames).size === allNames.length, allNames.join(', '));

  console.log('');
  console.log('--- who may take it ---');
  const editor = makeClient();
  await signIn(editor, 'alpha-editor');

  for (const p of ['/admin/export', '/admin/export.csv', '/admin/export.zip']) {
    const page = await editor('GET', p);
    check(`an editor is refused ${p}`, page.status === 403, `status ${page.status}`);
  }

  for (const p of ['/super/export.zip?all=1']) {
    const page = await admin('GET', p);
    check(`a parish administrator is refused ${p}`, page.status === 403, `status ${page.status}`);
  }

  const anonymous = makeClient();
  const out = await anonymous('GET', '/admin/export.zip');
  check('a signed-out request is sent to the sign-in page',
    out.status === 302 && String(out.location).startsWith('/login'),
    `status ${out.status} to ${out.location}`);

  console.log('');
  console.log('--- and it is written down ---');
  const log = await admin('GET', '/admin/audit?action=export');
  check('the downloads are in the audit log',
    log.body.includes('export.bundle') && log.body.includes('export.csv'),
    'an export left no trace');

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
