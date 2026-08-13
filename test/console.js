'use strict';

/**
 * The super administrator's console.
 *
 * Covers the things that would be expensive to discover later: that the
 * hierarchy can actually be built through the forms, that the diocese/zone
 * invariant is enforced by the route and not only by the model, that borrowing
 * a church works and can be given back, and that a church administrator cannot
 * reach any of it.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parish-console-'));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'console-test-secret';
process.env.NODE_ENV = 'test';
process.env.SECURE_COOKIES = '0';

const PORT = 4001;
const PASSWORD = 'test-password-1234';

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
}

/** One cookie jar per signed-in person, so two sessions can coexist. */
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
          status: res.statusCode,
          body: out,
          location: res.headers.location
        }));
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  };
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

async function signIn(request, username) {
  const page = await request('GET', '/login');
  return request('POST', '/login', {
    _csrf: csrfFrom(page.body), username, password: PASSWORD
  });
}

/** Post to `action`, taking a fresh CSRF token from `from`. */
async function post(request, from, action, body) {
  const page = await request('GET', from);
  return request('POST', action, { _csrf: csrfFrom(page.body), ...body });
}

async function main() {
  const db = require('../db');
  const auth = require('../lib/auth');

  await db.init();

  const hash = await auth.hashPassword(PASSWORD);
  await db.User.create({
    username: 'root', password_hash: hash, full_name: 'Super',
    role: 'superadmin', church_id: null, created_at: db.now()
  });

  const app = require('../app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const root = makeClient();

  console.log('');
  console.log('--- the console is reachable, and empty ---');
  await signIn(root, 'root');

  let res = await root('GET', '/');
  check('a super administrator with no church lands on the console',
    res.status === 302 && res.location === '/super', `${res.status} -> ${res.location}`);

  for (const p of ['/super', '/super/dioceses', '/super/zones', '/super/churches']) {
    const page = await root('GET', p);
    check(`${p} renders`, page.status === 200, `status ${page.status}`);
  }

  console.log('');
  console.log('--- building the hierarchy through the forms ---');
  res = await post(root, '/super/dioceses', '/super/dioceses', { name: 'Diocese of Trichy' });
  check('a diocese can be added', res.status === 302);

  res = await post(root, '/super/dioceses', '/super/dioceses', { name: 'diocese of trichy' });
  check('a duplicate name is refused, case-insensitively',
    decodeURIComponent(res.location || '').includes('already a diocese'),
    'redirected to ' + res.location);
  check('and no second row was written', (await db.Diocese.count()) === 1,
    'there are now ' + (await db.Diocese.count()));

  await post(root, '/super/dioceses', '/super/dioceses', { name: 'Diocese of Madurai' });
  const dioceses = await db.Diocese.findAll({ order: [['id', 'ASC']], raw: true });
  check('both dioceses exist', dioceses.length === 2, `got ${dioceses.length}`);

  const trichy = dioceses.find((d) => d.name === 'Diocese of Trichy');
  const madurai = dioceses.find((d) => d.name === 'Diocese of Madurai');

  await post(root, '/super/zones', '/super/zones', {
    name: 'Chalakudy', diocese_id: trichy.id
  });
  await post(root, '/super/zones', '/super/zones', {
    name: 'Thanjavur', diocese_id: madurai.id
  });
  const zones = await db.Zone.findAll({ order: [['id', 'ASC']], raw: true });
  check('a zone can be added to each diocese', zones.length === 2, `got ${zones.length}`);

  const chalakudy = zones.find((z) => z.name === 'Chalakudy');
  const thanjavur = zones.find((z) => z.name === 'Thanjavur');

  res = await post(root, '/super/zones', '/super/zones', {
    name: 'Chalakudy', diocese_id: madurai.id
  });
  check('the same zone name is allowed in a different diocese',
    (await db.Zone.count()) === 3, `got ${await db.Zone.count()}`);

  console.log('');
  console.log('--- the invariant the model exists to hold ---');
  res = await post(root, '/super/churches', '/super/churches', {
    name: 'St Mary Church',
    city: 'Trichy',
    diocese_id: trichy.id,
    // Thanjavur belongs to Madurai, not Trichy.
    zone_id: thanjavur.id,
    admin_username: 'stmary',
    admin_full_name: 'St Mary Admin',
    admin_password: PASSWORD,
    admin_password_confirm: PASSWORD
  });
  check('a zone from another diocese is refused', res.status === 400, `status ${res.status}`);
  check('and nothing was half-created',
    (await db.Church.count()) === 0 && !(await db.User.findOne({ where: { username: 'stmary' } })),
    'a church or its administrator was left behind');

  console.log('');
  console.log('--- a church and its administrator, created together ---');
  res = await post(root, '/super/churches', '/super/churches', {
    name: 'St Mary Church',
    city: 'Trichy',
    diocese_id: trichy.id,
    zone_id: chalakudy.id,
    admin_username: 'stmary',
    admin_full_name: 'St Mary Admin',
    admin_password: PASSWORD,
    admin_password_confirm: PASSWORD
  });
  check('the church is created', res.status === 302, `status ${res.status}`);

  const church = await db.Church.findOne({ where: { name: 'St Mary Church' } });
  check('it has a slug', !!church && church.slug === 'st-mary-church', church && church.slug);
  check('its administrator exists and belongs to it',
    !!(await db.User.findOne({ where: { username: 'stmary', church_id: church.id } })));
  check('it starts with its own name as the printed parish name',
    (await require('../lib/settings').load(church.id)).parish_name === 'St Mary Church');

  res = await root('GET', `/super/churches/${church.id}`);
  check('its page renders', res.status === 200, `status ${res.status}`);

  console.log('');
  console.log('--- borrowing a church, and giving it back ---');
  res = await root('GET', '/families');
  check('without one, an ordinary page sends them to pick',
    res.status === 302 && res.location === '/super/churches?pick=1',
    `${res.status} -> ${res.location}`);

  res = await post(root, `/super/churches/${church.id}`, `/super/churches/${church.id}/act`, {});
  check('borrowing redirects', res.status === 302);

  res = await root('GET', '/families');
  check('now the families page opens', res.status === 200, `status ${res.status}`);
  check('and every page says which church they are in',
    res.body.includes('You are working in') && res.body.includes('St Mary Church'));

  res = await post(root, '/families', '/super/stop-acting', {});
  check('giving it back redirects', res.status === 302);
  res = await root('GET', '/families');
  check('and the ordinary pages are closed again',
    res.status === 302 && res.location === '/super/churches?pick=1');

  console.log('');
  console.log('--- moving churches in bulk ---');
  await post(root, '/super/churches', '/super/churches', {
    name: 'St Peter Church',
    city: 'Trichy',
    diocese_id: trichy.id,
    zone_id: '',
    admin_username: 'stpeter',
    admin_password: PASSWORD,
    admin_password_confirm: PASSWORD
  });
  const peter = await db.Church.findOne({ where: { name: 'St Peter Church' } });
  check('a church can be created with no zone', !!peter && peter.zone_id === null);

  res = await post(root, '/super/churches', '/super/churches/reassign', {
    church_ids: String(peter.id),
    diocese_id: madurai.id,
    zone_id: thanjavur.id
  });
  await peter.reload();
  check('a church can be moved to another diocese and zone',
    peter.diocese_id === madurai.id && peter.zone_id === thanjavur.id,
    `diocese ${peter.diocese_id}, zone ${peter.zone_id}`);

  res = await post(root, '/super/churches', '/super/churches/reassign', {
    church_ids: String(peter.id),
    diocese_id: trichy.id,
    zone_id: thanjavur.id
  });
  await peter.reload();
  check('a bulk move into a mismatched zone is refused',
    peter.diocese_id === madurai.id,
    `it moved anyway: diocese ${peter.diocese_id}`);

  console.log('');
  console.log('--- dissolving a zone keeps its churches ---');
  const before = await db.Church.count();
  await post(root, '/super/zones', `/super/zones/${thanjavur.id}/delete`, {});
  await peter.reload();
  check('the churches survive', (await db.Church.count()) === before);
  check('and are simply unzoned', peter.zone_id === null, `zone is ${peter.zone_id}`);

  console.log('');
  console.log('--- a diocese holding churches cannot be deleted ---');
  res = await post(root, '/super/dioceses', `/super/dioceses/${madurai.id}/delete`, {});
  check('the attempt is refused', !!(await db.Diocese.findByPk(madurai.id)));

  console.log('');
  console.log('--- none of this is reachable by a church administrator ---');
  const parish = makeClient();
  await signIn(parish, 'stmary');

  for (const p of ['/super', '/super/dioceses', '/super/zones', '/super/churches']) {
    const page = await parish('GET', p);
    check(`${p} is refused`, page.status === 403, `status ${page.status}`);
  }

  res = await post(parish, '/', '/super/dioceses', { name: 'Sneaky Diocese' });
  check('and so is posting to it', res.status === 403, `status ${res.status}`);
  check('no diocese was created', !(await db.Diocese.findOne({ where: { name: 'Sneaky Diocese' } })));

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
    console.error('\nThe console test threw:\n', err);
    cleanUp();
    process.exit(1);
  });
