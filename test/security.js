'use strict';

/**
 * Sign-in security, driven over HTTP the way an attacker would drive it.
 *
 * Four things are being proved, and the third is the one worth stating plainly
 * because it is a deliberate choice rather than an oversight:
 *
 *   every attempt is written down, with no credential in the record
 *   a wrong password is answered more and more slowly
 *   NO ACCOUNT IS EVER LOCKED — the right password works on the hundredth try
 *   the address doing the guessing is what gets shut out
 *
 * The delay ladder and the address limit are set through the same environment
 * variables a parish would use, which is also the test that they are honoured.
 *
 *     npm run test:security
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

// Set before config is required — it reads the environment once, at load.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parish-security-'));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'security-test-secret';
process.env.NODE_ENV = 'test';
process.env.SECURE_COOKIES = '0';

/*
 * The proxy header is believed, which is what lets this file pose as several
 * different addresses from one machine. It is also the condition the address
 * rule insists on: without it every request here would arrive from 127.0.0.1
 * and the rule would rightly stand down rather than block the whole parish.
 */
process.env.TRUST_PROXY = '1';

// A tenth of a second, doubling, capped at three tenths. The same shape as the
// shipped default, small enough to run the whole ladder in a few seconds.
process.env.LOGIN_DELAY_AFTER = '2';
process.env.LOGIN_DELAY_STEP_SECONDS = '0.1';
process.env.LOGIN_DELAY_MAX_SECONDS = '0.3';
process.env.LOGIN_IP_MAX_FAILURES = '15';
process.env.LOGIN_IP_WINDOW_MINUTES = '60';
process.env.LOGIN_IP_BLOCK_MINUTES = '60';

/*
 * One address per scenario, and the reason is not tidiness.
 *
 * The account ladder and the address block are separate rules, and a file that
 * ran both through one address would prove neither: the address trips its own
 * limit partway through the account run, and every check after that is being
 * answered by the rule it was not testing. In particular "the right password
 * still works after fifteen wrong ones" would come back 429 and look like the
 * lockout this design exists to avoid.
 */
const LOGGING_IP = '203.0.113.5';   // the plain recording checks
const LADDER_IP = '203.0.113.20';   // the growing delay, and the no-lockout proof
const ATTACKER_IP = '198.51.100.77'; // the one that gets blocked
const BYSTANDER_IP = '203.0.113.9'; // must stay unaffected throughout

const PORT = 3996;
const PASSWORD = 'test-password-1234';
const WRONG = 'not-the-password';
const PIN = '246813';
const WRONG_PIN = '999999';

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
        'User-Agent': 'ParishTest/1.0 (checks)',
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

const csrfFrom = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];

/**
 * One sign-in attempt from a given address, with a fresh cookie jar.
 *
 * The jar is emptied first because a failed attempt must be judged on its own:
 * a session carried over from an earlier check would make the second attempt a
 * different request from the first.
 */
async function attempt(username, password, ip = LOGGING_IP) {
  cookie = '';
  const page = await request('GET', '/login', null, { 'X-Forwarded-For': ip });
  return request('POST', '/login', {
    _csrf: csrfFrom(page.body),
    username,
    password
  }, { 'X-Forwarded-For': ip });
}

function cleanUp() {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch (err) {
    /* Windows holds the SQLite file open; leave it to the OS to sweep. */
  }
}

async function seed(db, auth) {
  const diocese = await db.Diocese.create({ name: 'Test Diocese', created_at: db.now() });
  const church = await db.Church.create({
    diocese_id: diocese.id,
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

  await db.User.create({
    username: 'root',
    password_hash: await auth.hashPassword(PASSWORD),
    full_name: 'Test Super Administrator',
    role: 'superadmin',
    created_at: db.now()
  });

  /*
   * A household login as well, because it is a different door with a different
   * shaped identifier — parish and Family ID together, not a username — and a
   * PIN rather than a password. Both have to reach the same log.
   */
  const family = await db.Family.create({
    church_id: church.id,
    family_id: '0147',
    head_name: 'Test Household',
    created_at: db.now(),
    updated_at: db.now()
  });

  await db.User.create({
    username: 'test-church/0147',
    password_hash: await auth.hashPassword(PIN),
    full_name: 'Test Household',
    role: 'family',
    church_id: church.id,
    family_id: family.id,
    created_at: db.now()
  });

  return church;
}

/** One household sign-in attempt, with a fresh cookie jar. */
async function familyAttempt(churchId, ref, pin, ip) {
  cookie = '';
  const page = await request('GET', '/family-login', null, { 'X-Forwarded-For': ip });
  return request('POST', '/family-login', {
    _csrf: csrfFrom(page.body),
    church_id: String(churchId),
    family_ref: ref,
    pin
  }, { 'X-Forwarded-For': ip });
}

async function main() {
  const db = require('../db');
  const auth = require('../lib/auth');
  const config = require('../config');
  const guard = require('../lib/login-guard');

  console.log('--- the ladder is arithmetic, and the settings are honoured ---');

  check('the first two failures cost nothing',
    guard.delayForFailures(0) === 0
    && guard.delayForFailures(1) === 0
    && guard.delayForFailures(2) === 0);

  check('then it doubles from the configured step',
    guard.delayForFailures(3) === 100
    && guard.delayForFailures(4) === 200,
    `${guard.delayForFailures(3)}, ${guard.delayForFailures(4)}`);

  check('and stops at the cap rather than growing without limit',
    guard.delayForFailures(5) === 300
    && guard.delayForFailures(40) === 300,
    `${guard.delayForFailures(5)}, ${guard.delayForFailures(40)}`);

  check('the address limit is read from the environment',
    config.login.ipMaxFailures === 15, String(config.login.ipMaxFailures));

  await db.init();
  const church = await seed(db, auth);

  const app = require('../app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  console.log('\n--- every attempt is written down ---');

  await attempt('tester', WRONG);
  let row = await db.LoginAttempt.findOne({ order: [['id', 'DESC']], raw: true });
  check('a failure records who was asked for, from where, and on what',
    row && row.identifier === 'staff:tester'
      && row.ip === '203.0.113.5'
      && row.user_agent.includes('ParishTest')
      && !row.success
      && row.reason === 'bad_password',
    JSON.stringify(row));

  await attempt('nobody-at-all', WRONG);
  row = await db.LoginAttempt.findOne({ order: [['id', 'DESC']], raw: true });
  check('a username that does not exist is recorded as such',
    row && row.reason === 'no_such_user', row && row.reason);

  const ok = await attempt('tester', PASSWORD);
  row = await db.LoginAttempt.findOne({ order: [['id', 'DESC']], raw: true });
  check('a success is recorded too, with the account it belongs to',
    ok.status === 302 && !!row.success && row.reason === 'ok' && row.user_id,
    `${ok.status} / ${JSON.stringify(row)}`);

  console.log('\n--- and no credential is written down with it ---');
  /*
   * The whole table, read back as text. Neither the real password nor the one
   * that was guessed may appear anywhere in it — not in the reason, not in the
   * identifier, not in the user agent. This is the check that would fail if
   * somebody later added "what they tried" to the log for debugging.
   */
  const everything = JSON.stringify(await db.LoginAttempt.findAll({ raw: true }));
  check('the attempt log holds neither the password nor the guess',
    !everything.includes(PASSWORD) && !everything.includes(WRONG));

  const auditText = JSON.stringify(await db.AuditLog.findAll({ raw: true }));
  check('nor does the audit log',
    !auditText.includes(PASSWORD) && !auditText.includes(WRONG));

  console.log('\n--- the counter resets on a successful sign-in ---');

  check('a fresh account starts at nothing',
    (await guard.failuresSinceSuccess('staff', 'tester')) === 0,
    String(await guard.failuresSinceSuccess('staff', 'tester')));

  await attempt('tester', WRONG, LADDER_IP);
  await attempt('tester', WRONG, LADDER_IP);
  check('failures since that sign-in are counted',
    (await guard.failuresSinceSuccess('staff', 'tester')) === 2,
    String(await guard.failuresSinceSuccess('staff', 'tester')));

  await attempt('tester', PASSWORD, LADDER_IP);
  check('signing in wipes the slate',
    (await guard.failuresSinceSuccess('staff', 'tester')) === 0,
    String(await guard.failuresSinceSuccess('staff', 'tester')));

  console.log('\n--- the wait grows, and is actually served ---');

  for (let i = 0; i < 4; i += 1) await attempt('tester', WRONG, LADDER_IP);
  check('four failures put the account on the ladder',
    (await guard.delayFor('staff', 'tester')) === 200,
    String(await guard.delayFor('staff', 'tester')));

  const startedAt = Date.now();
  await attempt('tester', WRONG, LADDER_IP);
  const elapsed = Date.now() - startedAt;
  check('and the next attempt really is made to wait for it',
    elapsed >= 190, `the request came back in ${elapsed}ms`);

  console.log('\n--- but the account is never locked ---');
  /*
   * The point of the whole design. A parish administrator's username is
   * guessable by anybody; an account that locked on five wrong guesses would
   * hand any passer-by the power to shut the office out of its own directory.
   * So after a long run of failures the right password must still work.
   */
  /*
   * Each wrong guess from a different address, and the right one from a
   * fresh address again.
   *
   * That spread is the whole point of the check rather than a convenience. The
   * failures all count against the account, because the ladder follows the
   * identifier wherever it is attacked from — but no single address goes near
   * its own limit, so what answers the final request is the account rule and
   * only the account rule. Run through one address instead and this comes back
   * 429, and the file would be quietly proving the address block while
   * appearing to prove the absence of a lockout.
   */
  for (let i = 0; i < 16; i += 1) {
    await attempt('tester', WRONG, `192.0.2.${i + 1}`);
  }
  check('the account is deep on the ladder',
    (await guard.failuresSinceSuccess('staff', 'tester')) >= 16,
    String(await guard.failuresSinceSuccess('staff', 'tester')));

  const after = await attempt('tester', PASSWORD, '192.0.2.200');
  check('and the right password still signs in after all of them',
    after.status === 302 && after.location === '/',
    `${after.status} -> ${after.location}`);

  check('the wait it served was the capped one, not a refusal',
    guard.delayForFailures(16) === config.login.delayMaxMs,
    String(guard.delayForFailures(16)));

  console.log('\n--- the address doing the guessing is what gets shut out ---');
  /*
   * A different address from the one above, working through a list of
   * usernames rather than hammering one. This is what the old per-pair counter
   * could never see: each username fails only once or twice, so no single
   * account is anywhere near the ladder, and yet the address is plainly
   * running a script.
   */
  const attacker = ATTACKER_IP;
  for (let i = 0; i < config.login.ipMaxFailures; i += 1) {
    await attempt(`victim-${i}`, WRONG, attacker);
  }

  const blocked = await attempt('victim-99', WRONG, attacker);
  check('the address is refused once it passes the limit',
    blocked.status === 429, `status ${blocked.status}`);

  const blockedWithGoodPassword = await attempt('tester', PASSWORD, attacker);
  check('and refused even with a password that is correct',
    blockedWithGoodPassword.status === 429,
    `status ${blockedWithGoodPassword.status}`);

  const block = await db.IpBlock.findByPk(attacker);
  check('the block is recorded, with what it was working through',
    block && block.failures >= config.login.ipMaxFailures && block.tried.includes('victim-'),
    JSON.stringify(block));

  const blockEvent = await db.AuditLog.findOne({
    where: { action: 'security.ip_blocked', detail: { [db.Op.like]: `${attacker}%` } },
    raw: true
  });
  check('and the audit log says so',
    blockEvent && blockEvent.detail.includes(attacker),
    JSON.stringify(blockEvent));

  const elsewhere = await attempt('tester', PASSWORD, BYSTANDER_IP);
  check('every other address is unaffected',
    elsewhere.status === 302, `status ${elsewhere.status}`);

  console.log('\n--- an account being ground on is reported, once ---');
  const noticed = await db.AuditLog.findAll({
    where: { action: 'security.repeated_failures' }, raw: true
  });
  const aboutTester = noticed.filter((e) => e.detail.includes('staff:tester'));
  check('the parish is told which of its accounts was being guessed at',
    aboutTester.length >= 1, `${aboutTester.length} entries`);

  check('one line per episode, not one per guess',
    aboutTester.length <= 3, `${aboutTester.length} entries for one account`);

  console.log('\n--- the household door is logged the same way ---');

  const householdIp = '203.0.113.60';
  await familyAttempt(church.id, '0147', WRONG_PIN, householdIp);
  let familyRow = await db.LoginAttempt.findOne({ order: [['id', 'DESC']], raw: true });
  check('a wrong PIN is recorded against parish and Family ID together',
    familyRow && familyRow.kind === 'family'
      && familyRow.identifier === `family:${church.id}:0147`
      && !familyRow.success
      && familyRow.reason === 'bad_password',
    JSON.stringify(familyRow));

  const householdIn = await familyAttempt(church.id, '0147', PIN, householdIp);
  familyRow = await db.LoginAttempt.findOne({ order: [['id', 'DESC']], raw: true });
  check('and the right PIN signs the household in, and is recorded',
    householdIn.status === 302 && !!familyRow.success && familyRow.church_id === church.id,
    `${householdIn.status} / ${JSON.stringify(familyRow)}`);

  const familyText = JSON.stringify(await db.LoginAttempt.findAll({
    where: { kind: 'family' }, raw: true
  }));
  check('with neither the PIN nor the guess anywhere in the log',
    !familyText.includes(PIN) && !familyText.includes(WRONG_PIN));

  /*
   * The two doors are counted apart. A household is identified by a number the
   * parish prints on the front of every entry in the book, so if the two shared
   * a namespace a family's own fumbled PIN could put a staff account of the
   * same name on the ladder.
   */
  check('the two doors do not share a counter',
    (await guard.failuresSinceSuccess('family', `${church.id}:0147`)) === 0
    && (await guard.failuresSinceSuccess('staff', 'tester')) === 0,
    `family ${await guard.failuresSinceSuccess('family', `${church.id}:0147`)}, `
    + `staff ${await guard.failuresSinceSuccess('staff', 'tester')}`);

  console.log('\n--- who may read any of this ---');

  cookie = '';
  let page = await request('GET', '/login');
  await request('POST', '/login', {
    _csrf: csrfFrom(page.body), username: 'tester', password: PASSWORD
  });
  const asAdmin = await request('GET', '/super/security');
  check('a parish administrator may not read the installation-wide log',
    asAdmin.status === 403, `status ${asAdmin.status}`);

  const parishLog = await request('GET', '/admin/audit?action=security');
  check('but does see its own security events on its own audit log',
    parishLog.status === 200 && parishLog.body.includes('Sign-in security'),
    `status ${parishLog.status}`);

  cookie = '';
  page = await request('GET', '/login');
  await request('POST', '/login', {
    _csrf: csrfFrom(page.body), username: 'root', password: PASSWORD
  });
  const asSuper = await request('GET', '/super/security');
  check('a super administrator sees the attempts and the blocks',
    asSuper.status === 200
      && asSuper.body.includes(attacker)
      && asSuper.body.includes(LOGGING_IP),
    `status ${asSuper.status}`);

  check('and the page shows no password anywhere on it',
    !asSuper.body.includes(PASSWORD) && !asSuper.body.includes(WRONG));

  console.log('\n--- lifting a block by hand ---');

  const unblocked = await request('POST', '/super/security/unblock', {
    _csrf: csrfFrom(asSuper.body),
    ip: attacker
  });
  check('the block is released',
    unblocked.status === 302 && !(await db.IpBlock.findByPk(attacker)),
    `status ${unblocked.status}`);

  const lifted = await attempt('tester', PASSWORD, attacker);
  check('and that address may sign in again',
    lifted.status === 302, `status ${lifted.status}`);

  const unblockEvent = await db.AuditLog.findOne({
    where: { action: 'security.ip_unblocked' }, raw: true
  });
  check('lifting it is itself recorded',
    unblockEvent && unblockEvent.detail.includes(attacker),
    JSON.stringify(unblockEvent));

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
