'use strict';

/**
 * The idle timeout, driven over HTTP the way a browser drives it.
 *
 * The point of this file is that the enforcement is on the server. Every check
 * below is made with plain requests and a cookie jar — no JavaScript runs, no
 * countdown exists — and the session still has to expire on time, stay alive
 * while it is being used, and refuse the pages behind it once it has gone.
 *
 * The window is set to a few seconds through the same environment variable a
 * parish would use, which is also the test that the setting is honoured at all.
 *
 *     npm run test:idle
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

// Set before config is required — it reads the environment once, at load.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parish-idle-'));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'idle-test-secret';
process.env.NODE_ENV = 'test';
process.env.SECURE_COOKIES = '0';

/*
 * Four seconds of patience, warning at two.
 *
 * Long enough that the requests below are comfortably inside it on a slow
 * machine, short enough that the whole file runs in about ten seconds. The
 * warning is at half the window, which is also the cap config applies.
 */
const IDLE_SECONDS = 4;
process.env.SESSION_IDLE_MINUTES = String(IDLE_SECONDS / 60);
process.env.SESSION_WARNING_SECONDS = '2';

const PORT = 3997;
const PASSWORD = 'test-password-1234';

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
}

let cookie = '';
function request(method, urlPath, body, headers = {}) {
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
        } : {}),
        ...headers
      }
    }, (res) => {
      const set = res.headers['set-cookie'];
      if (set) cookie = set.map((c) => c.split(';')[0]).join('; ');
      let out = '';
      res.on('data', (chunk) => { out += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: out,
        headers: res.headers,
        location: res.headers.location
      }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const csrfFrom = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];

function cleanUp() {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch (err) {
    /* Windows holds the SQLite file open; leave it to the OS to sweep. */
  }
}

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
}

async function signIn() {
  cookie = '';
  const page = await request('GET', '/login');
  const res = await request('POST', '/login', {
    _csrf: csrfFrom(page.body),
    username: 'tester',
    password: PASSWORD
  });
  if (res.status !== 302) throw new Error(`could not sign in: status ${res.status}`);
}

async function main() {
  const db = require('../db');
  const auth = require('../lib/auth');
  const config = require('../config');

  check('SESSION_IDLE_MINUTES is honoured',
    config.session.idleMs === IDLE_SECONDS * 1000,
    `idleMs is ${config.session.idleMs}`);

  check('the warning is capped at half the window',
    config.session.warnMs === (IDLE_SECONDS / 2) * 1000,
    `warnMs is ${config.session.warnMs}`);

  await db.init();
  await seed(db, auth);

  const app = require('../app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  console.log('\n--- a session in use is not interrupted ---');
  await signIn();

  /*
   * Kept alive past the idle window by ordinary use — six requests a second
   * apart, over four seconds of patience. This is the check that the timeout
   * is inactivity and not age: a clerk working steadily through a long
   * afternoon must never be signed out mid-sentence.
   */
  let stillIn = true;
  for (let i = 0; i < 6; i += 1) {
    await wait(1000);
    const res = await request('GET', '/families');
    if (res.status !== 200) stillIn = false;
  }
  check(`working steadily for ${IDLE_SECONDS + 2}s keeps the session`, stillIn);

  console.log('\n--- how long is left, and what asking costs ---');
  let status = JSON.parse((await request('GET', '/session/status')).body);
  check('the countdown is told the window and the warning',
    status.signedIn === true
    && status.idleMs === IDLE_SECONDS * 1000
    && status.warnMs === (IDLE_SECONDS / 2) * 1000,
    JSON.stringify(status));

  /*
   * The poll must not renew the session, or a tab left open would hold the
   * parish register unlocked for ever by asking whether it was still open.
   * Two polls a second apart: the second must report less time than the first.
   */
  await wait(1200);
  const later = JSON.parse((await request('GET', '/session/status')).body);
  check('polling the countdown does not renew the session',
    later.remainingMs < status.remainingMs,
    `${status.remainingMs} then ${later.remainingMs}`);

  console.log('\n--- "Continue working" ---');
  const page = await request('GET', '/families');
  const extended = JSON.parse((await request('POST', '/session/extend', null, {
    'x-csrf-token': csrfFrom(page.body)
  })).body);
  check('pressing it restores the whole window',
    extended.signedIn === true && extended.remainingMs > later.remainingMs,
    JSON.stringify(extended));

  check('it is refused without a CSRF token',
    (await request('POST', '/session/extend')).status === 403);

  console.log('\n--- left alone ---');
  await signIn();
  await wait((IDLE_SECONDS + 1) * 1000);

  const blocked = await request('GET', '/families');
  check('a page behind the sign-in is refused',
    blocked.status === 302 && blocked.location === '/login?timeout=1',
    `${blocked.status} -> ${blocked.location}`);

  const expired = JSON.parse((await request('GET', '/session/status')).body);
  check('the countdown is told the session has gone',
    expired.signedIn === false, JSON.stringify(expired));

  const login = await request('GET', '/login?timeout=1');
  check('the sign-in page says why',
    login.status === 200 && login.body.includes('left idle'),
    `status ${login.status}`);

  console.log('\n--- the Back button ---');
  /*
   * A browser only re-shows a page from its cache if it was allowed to keep
   * it. Signed-in pages say no-store, which also takes them out of the
   * back/forward cache — without this the timeout is honest and the Back
   * button is not, and the last family rendered stays on screen for whoever
   * sits down next.
   */
  await signIn();
  const family = await request('GET', '/families');
  const cacheControl = String(family.headers['cache-control'] || '');
  check('a signed-in page refuses to be cached',
    cacheControl.includes('no-store') && cacheControl.includes('private'),
    `Cache-Control: ${cacheControl || '(none)'}`);

  console.log('\n--- an expired cookie is not a key ---');
  /*
   * The cookie is the browser's copy of the decision, and a copy taken before
   * it expired is exactly what a replay looks like. The server keeps its own
   * `lastSeen` and is asked again on arrival, so a cookie held past the window
   * reaches a session that is already over.
   */
  const stolen = cookie;
  await wait((IDLE_SECONDS + 1) * 1000);
  cookie = stolen;
  const replayed = await request('GET', '/families');
  check('replaying it after the window reaches nothing',
    replayed.status === 302 && String(replayed.location).startsWith('/login'),
    `${replayed.status} -> ${replayed.location}`);

  server.close();
  await db.sequelize.close();
}

main()
  .then(() => {
    cleanUp();
    console.log(`\n${failures ? `${failures} check(s) failed` : 'All checks passed'}`);
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    cleanUp();
    console.error('\nThe test itself broke:\n', err);
    process.exit(1);
  });
