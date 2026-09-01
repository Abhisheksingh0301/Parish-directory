'use strict';

/**
 * Importing a folder of photographs, zipped, from the browser.
 *
 * Two things are being checked, and the second is the one that would hurt.
 *
 * The first is that the archive is read at all: a real deflated zip, the kind
 * Windows and macOS produce from "Send to → Compressed folder", not only the
 * stored archives this application writes itself.
 *
 * The second is that a refusal refuses *everything*. Every rejected archive
 * below is followed by a count of the photograph files actually on disk and of
 * the rows pointing at them, because the failure this design exists to prevent
 * is an import that reports a problem and has quietly stored ninety images
 * anyway — leaving a parish unable to tell which of its families were changed.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parish-photos-'));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'photos-test-secret';
process.env.NODE_ENV = 'test';
process.env.SECURE_COOKIES = '0';

const PORT = 4008;
const PASSWORD = 'test-password-1234';

const { crc32 } = require('../lib/zip');

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

// ---------------------------------------------------------------------------
// Making files to import
// ---------------------------------------------------------------------------

/** A PNG chunk: length, type, body, CRC — the same CRC-32 the zip format uses. */
function pngChunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** A genuine, decodable PNG: solid mid-grey, 8-bit RGB, at the size asked for. */
function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  // 10, 11, 12 stay zero: deflate, adaptive filtering, no interlace.

  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * A JPEG carrying a Start Of Frame and nothing else.
 *
 * Not a decodable picture, and deliberately so: what this application reads
 * from a JPEG is the signature and the two numbers in its SOF0 segment, which
 * is exactly what this has. Encoding a real one would test a JPEG encoder.
 */
function makeJpeg(width, height) {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);     // segment length
  sof[4] = 8;                   // sample precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;                   // three components, nine bytes of them
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    sof,
    Buffer.from([0xff, 0xd9])
  ]);
}

/**
 * A zip, written here rather than with lib/zip.js, because this has to be able
 * to produce a *deflated* archive — which is what every real parish will
 * upload, and which lib/zip.js deliberately never writes.
 */
function makeZip(files, { deflate = true } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, contents] of Object.entries(files)) {
    const body = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), 'utf8');
    const stored = deflate ? zlib.deflateRawSync(body) : body;
    const method = deflate ? 8 : 0;
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);         // the name is UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += 30 + nameBytes.length + stored.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

// ---------------------------------------------------------------------------
// A client that keeps its cookie and can post a file
// ---------------------------------------------------------------------------

function makeClient() {
  let cookie = '';

  function send(method, urlPath, { headers = {}, payload = null } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: PORT, path: urlPath, method,
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers }
      }, (res) => {
        const set = res.headers['set-cookie'];
        if (set) cookie = set.map((c) => c.split(';')[0]).join('; ');
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          // The raw bytes as well as the text: the round-trip check downloads
          // an archive and posts it straight back.
          const buffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            location: res.headers.location,
            buffer,
            body: buffer.toString('utf8')
          });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  const client = (method, urlPath, form) => {
    if (!form) return send(method, urlPath);
    const data = new URLSearchParams(form).toString();
    return send(method, urlPath, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data)
      },
      payload: data
    });
  };

  client.upload = (urlPath, { field, filename, content, csrf, type = 'application/zip' }) => {
    const boundary = `----parishtest${Date.now().toString(16)}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n`
        + 'Content-Disposition: form-data; name="_csrf"\r\n\r\n'
        + `${csrf}\r\n`
        + `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n`
        + `Content-Type: ${type}\r\n\r\n`, 'utf8'
      ),
      Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    ]);

    return send('POST', urlPath, {
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      },
      payload: body
    });
  };

  return client;
}

const csrfFrom = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];

/**
 * Wait for the scratch folder to empty.
 *
 * The upload is deleted when the *response* ends, which is deliberately not
 * the same instant the client finishes reading it — the unlink is a promise
 * the server settles a tick or two later. Asserting the moment the response
 * arrives is a race that passes most of the time, which is the worst kind.
 */
async function scratchEmpties(dir, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const left = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
    if (left === 0) return 0;
    if (Date.now() > until) return left;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function signIn(request, username) {
  const page = await request('GET', '/login');
  return request('POST', '/login', {
    _csrf: csrfFrom(page.body), username, password: PASSWORD
  });
}

async function main() {
  const db = require('../db');
  const auth = require('../lib/auth');
  const config = require('../config');

  await db.init();

  const diocese = await db.Diocese.create({ name: 'Trichy', created_at: db.now() });
  const church = await db.Church.create({
    diocese_id: diocese.id, zone_id: null,
    name: 'Alpha Church', slug: 'alpha', city: 'Town', created_at: db.now()
  });
  const other = await db.Church.create({
    diocese_id: diocese.id, zone_id: null,
    name: 'Beta Church', slug: 'beta', city: 'Town', created_at: db.now()
  });

  const mk = (churchId, familyId, head, photo = null) => db.Family.create({
    church_id: churchId, family_id: familyId, head_name: head, photo,
    is_published: true, created_at: db.now(), updated_at: db.now()
  });

  await mk(church.id, 'F-001', 'Thomas Mathew');
  await mk(church.id, 'F-002', 'George Kurian');
  await mk(church.id, 'F-003', 'Anna Varghese', 'already-there.jpg');
  // The same reference in another parish, which this import must never reach.
  await mk(other.id, 'F-009', 'Somebody Else');

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

  // The photograph F-003 already has, so replacement can be seen to happen.
  const churchUploads = path.join(config.uploadDir, String(church.id));
  fs.mkdirSync(churchUploads, { recursive: true });
  fs.writeFileSync(path.join(churchUploads, 'already-there.jpg'), makeJpeg(400, 300));

  const app = require('../app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const admin = makeClient();
  await signIn(admin, 'alpha-admin');
  const token = csrfFrom((await admin('GET', '/admin/photos')).body);

  const post = (files, opts) => admin.upload('/admin/photos', {
    field: 'archive', filename: 'photos.zip', csrf: token,
    content: Buffer.isBuffer(files) ? files : makeZip(files, opts)
  });

  const onDisk = () => fs.readdirSync(churchUploads).length;
  const withPhotos = () => db.Family.count({
    where: { church_id: church.id, photo: { [db.Op.ne]: null } }
  });

  const LANDSCAPE_PNG = makePng(400, 300);
  const LANDSCAPE_JPEG = makeJpeg(640, 480);

  console.log('');
  console.log('--- an archive with anything wrong in it stores nothing at all ---');

  const before = onDisk();

  let res = await post({ 'photos/F-999.png': LANDSCAPE_PNG, 'photos/F-001.png': LANDSCAPE_PNG });
  check('a file named for a family that is not here is refused',
    res.status === 200 && res.body.includes('no family in this directory has that'),
    `status ${res.status}`);
  check('and the good file beside it was not stored either',
    onDisk() === before && (await withPhotos()) === 1,
    `${onDisk()} files on disk, ${await withPhotos()} rows with photos`);

  res = await post({ 'photos/F-001.png': makePng(300, 400) });
  check('a portrait photograph is refused, with its size in the message',
    res.body.includes('300×400') && res.body.includes('taller than it is wide'),
    'wrong message');

  res = await post({ 'photos/F-001.png': makePng(500, 500) });
  check('and a square one is called square',
    res.body.includes('is square'), 'wrong message');

  res = await post({ 'photos/F-001.jpg': LANDSCAPE_PNG });
  check('a PNG renamed to .jpg is caught by its own bytes',
    res.body.includes('is a PNG image with a .jpg name'), 'wrong message');

  res = await post({ 'photos/F-001.png': LANDSCAPE_PNG, 'photos/notes.txt': 'hello' });
  check('a file that is not a photograph at all is refused',
    res.body.includes('is not a photograph'), 'wrong message');

  res = await post({ 'photos/F-001.png': LANDSCAPE_PNG, 'photos/F-001.jpg': LANDSCAPE_JPEG });
  check('two files named for one family are refused rather than guessed between',
    res.body.includes('are both named for family'), 'wrong message');

  res = await post({ 'photos/F-009.png': LANDSCAPE_PNG });
  check('a family belonging to another parish is not reachable',
    res.body.includes('no family in this directory has that'),
    'one church reached another church’s family');

  res = await post({ 'photos/big.png': LANDSCAPE_PNG, 'photos/F-001.png': Buffer.alloc(6 * 1024 * 1024, 0x41) });
  check('an image past the size cap is refused before it is even read',
    res.body.includes('6.0 MB') && res.body.includes('largest a photograph may be'),
    'wrong message');

  res = await post({ 'photos/' : '' });
  check('an archive with no photographs in it says so',
    res.body.includes('no photographs in that archive'), 'wrong message');

  res = await admin.upload('/admin/photos', {
    field: 'archive', filename: 'photos.rar', content: 'not a zip', csrf: token
  });
  check('a .rar is refused with how to make a .zip instead',
    res.body.includes('Compressed (zipped) folder'), 'wrong message');

  res = await admin.upload('/admin/photos', {
    field: 'archive', filename: 'photos.zip', content: 'this is not an archive', csrf: token
  });
  check('and a .zip that is not one is refused as damaged or incomplete',
    res.body.includes('not a zip archive, or it did not finish uploading'), 'wrong message');

  check('after every one of those, the directory is untouched',
    onDisk() === before && (await withPhotos()) === 1,
    `${onDisk()} files on disk, ${await withPhotos()} rows with photos`);

  console.log('');
  console.log('--- a clean archive imports, whole ---');

  res = await post({
    'photos/F-001.png': LANDSCAPE_PNG,
    'photos/F-002.jpg': LANDSCAPE_JPEG,
    // Every operating system leaves these behind; the parish cannot see them
    // and must not be asked to delete them.
    'photos/Thumbs.db': 'junk',
    '__MACOSX/photos/._F-001.png': 'junk'
  });
  check('the page says what arrived',
    res.status === 200 && res.body.includes('2 photographs added'),
    `status ${res.status}`);

  const f1 = await db.Family.findOne({ where: { church_id: church.id, family_id: 'F-001' }, raw: true });
  const f2 = await db.Family.findOne({ where: { church_id: church.id, family_id: 'F-002' }, raw: true });
  check('both families now point at a stored photograph',
    !!f1.photo && !!f2.photo, `${f1.photo} / ${f2.photo}`);
  check('stored under a name of this application’s choosing, not the archive’s',
    !f1.photo.includes('F-001'), f1.photo);
  check('and the files are on disk, in this church’s own folder',
    fs.existsSync(path.join(churchUploads, f1.photo))
    && fs.existsSync(path.join(churchUploads, f2.photo)),
    'a row points at a file that is not there');
  check('the PNG kept its extension, so it is served as what it is',
    f1.photo.endsWith('.png') && f2.photo.endsWith('.jpg'),
    `${f1.photo} / ${f2.photo}`);
  check('system files were passed over without complaint',
    !res.body.includes('Thumbs.db'), 'the page complained about Thumbs.db');
  // SQLite hands booleans back as 1/0 through a raw query, so this asks the
  // question truthily — the point is that the entry is still published.
  check('and nothing else about the family changed',
    !!f1.is_published && f1.head_name === 'Thomas Mathew',
    `published=${f1.is_published}, head=${f1.head_name}`);

  console.log('');
  console.log('--- a stored archive, the kind this application writes itself ---');

  res = await post({ 'F-001.png': makePng(800, 600) }, { deflate: false });
  check('reads as well as a deflated one',
    res.body.includes('1 photograph replaced'), 'a stored archive was not read');

  console.log('');
  console.log('--- replacing a photograph a family already has ---');

  const oldPhoto = f1.photo;
  res = await post({ 'F-003.png': LANDSCAPE_PNG, 'F-001.png': LANDSCAPE_PNG });
  check('the summary says replaced, not added',
    res.body.includes('2 photographs replaced'), 'wrong summary');
  check('and names the families whose photograph was changed',
    res.body.includes('F-001') && res.body.includes('F-003'), 'the summary named no families');

  const f3 = await db.Family.findOne({ where: { church_id: church.id, family_id: 'F-003' }, raw: true });
  check('the old file is gone from the disk',
    !fs.existsSync(path.join(churchUploads, 'already-there.jpg'))
    && !fs.existsSync(path.join(churchUploads, oldPhoto)),
    'a replaced photograph was left behind');
  check('and the row points at the new one, which is there',
    f3.photo !== 'already-there.jpg' && fs.existsSync(path.join(churchUploads, f3.photo)),
    f3.photo);

  console.log('');
  console.log('--- the round trip, which is why the download exists ---');

  /*
   * Download the parish's photographs, then upload that very archive back
   * without touching it. This is the trip the office actually makes: take the
   * folder out, replace the half-dozen pictures that are wrong, put it back.
   *
   * It only works if the exported names are exactly what the importer reads —
   * `F-001.jpg`, not the bundle's `F-001-thomas-mathew.jpg` — so if anyone ever
   * "tidies" the two namings into one, this is the check that objects.
   */
  const settledBefore = await withPhotos();
  const exported = await admin('GET', '/admin/export-photos.zip');
  check('the photographs download is a zip',
    exported.status === 200 && exported.buffer[0] === 0x50 && exported.buffer[1] === 0x4b,
    `status ${exported.status}`);

  res = await admin.upload('/admin/photos', {
    field: 'archive', filename: 'alpha-church-photos.zip', csrf: token,
    content: exported.buffer
  });
  check('and goes straight back in, unedited and unrenamed',
    res.body.includes('replaced') && !res.body.includes('No photographs were imported'),
    'the exported folder was not accepted by the importer');
  check('every family that had one still has one',
    (await withPhotos()) === settledBefore,
    `${await withPhotos()} of ${settledBefore}`);

  console.log('');
  console.log('--- the scratch upload does not accumulate ---');
  const scratch = path.join(config.dataDir, 'tmp');
  const readLeft = await scratchEmpties(scratch);
  check('every uploaded archive was deleted after it was read',
    readLeft === 0, `${readLeft} left behind`);

  console.log('');
  console.log('--- nothing to upload ---');
  res = await admin('POST', '/admin/photos', { _csrf: token });
  check('posting the form with no file chosen says so',
    res.status === 200 && res.body.includes('No file was chosen'), `status ${res.status}`);

  console.log('');
  console.log('--- who may do it ---');

  const settled = await withPhotos();

  const editor = makeClient();
  await signIn(editor, 'alpha-editor');
  res = await editor.upload('/admin/photos', {
    field: 'archive', filename: 'photos.zip', csrf: 'whatever',
    content: makeZip({ 'F-001.png': LANDSCAPE_PNG })
  });
  check('an editor may not import photographs', res.status === 403, `status ${res.status}`);

  const anonymous = makeClient();
  res = await anonymous.upload('/admin/photos', {
    field: 'archive', filename: 'photos.zip', csrf: 'whatever',
    content: makeZip({ 'F-001.png': LANDSCAPE_PNG })
  });
  check('and a signed-out request certainly may not', res.status === 403, `status ${res.status}`);

  res = await admin.upload('/admin/photos', {
    field: 'archive', filename: 'photos.zip', csrf: 'not-the-token',
    content: makeZip({ 'F-001.png': LANDSCAPE_PNG })
  });
  check('an administrator posting a stale form is refused',
    res.status === 403, `status ${res.status}`);
  // The archive was on disk before the CSRF check could run — the multipart
  // body has to be parsed before `_csrf` inside it can be read — so a rejected
  // form is exactly the path that would leave a file behind.
  const staleLeft = await scratchEmpties(scratch);
  check('and the archive it had already written is cleaned up',
    staleLeft === 0, `${staleLeft} left behind`);

  check('none of those three changed anything',
    (await withPhotos()) === settled, 'an unauthorised upload reached the database');

  /*
   * A super administrator who has not borrowed a church passes the role check
   * and then gets redirected by `tenancy.requireChurch` — so the route never
   * runs, and the `finally` that deletes the upload never runs either. The
   * archive has to be refused before multer writes it, or every attempt leaves
   * a file in the scratch folder for ever.
   */
  const root = makeClient();
  await signIn(root, 'root');
  res = await root.upload('/admin/photos', {
    field: 'archive', filename: 'photos.zip', csrf: 'whatever',
    content: makeZip({ 'F-001.png': LANDSCAPE_PNG })
  });
  check('a super administrator with no church chosen is refused',
    res.status === 403, `status ${res.status}`);
  const rootLeft = await scratchEmpties(scratch);
  check('and left nothing behind in the scratch folder',
    rootLeft === 0, `${rootLeft} left behind`);

  console.log('');
  console.log('--- and anything a crash did leave behind is swept at start-up ---');
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'photos-abandoned.zip'), 'left by a killed process');
  const swept = await require('../lib/import-upload').sweepScratch();
  check('the abandoned upload is cleared',
    swept === 1 && fs.readdirSync(scratch).length === 0, `swept ${swept}`);

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
