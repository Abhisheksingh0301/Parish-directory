'use strict';

/**
 * What happens to somebody who keeps getting the sign-in wrong.
 *
 * This replaces a Map that lived in routes/auth.js and held ten failures per
 * address-and-username pair for fifteen minutes. That Map had three faults: it
 * was lost on restart, so a script only had to wait for a deploy; it counted
 * the pair, so an address working through a list of usernames never tripped
 * anything; and it recorded nothing, so a parish asking whether somebody had
 * been trying to get in last night had nothing to read.
 *
 * Two rules, aimed at two different people:
 *
 *   The delay      is aimed at the guess. Failures against one identifier make
 *                  the next answer slower, doubling each time. No account is
 *                  ever locked — see the note in config/index.js for why a
 *                  lockout would hand any passer-by the power to shut the
 *                  parish office out of its own directory.
 *
 *   The IP block   is aimed at the guesser. Enough failures from one address,
 *                  whatever it was aiming at, and the address is refused
 *                  outright for a while.
 *
 * The delay resets on a successful sign-in; the block's counter does not, or
 * an attacker holding one valid account could clear it at will.
 *
 * Nothing here ever sees a password or a PIN. `record` is given a reason code
 * from REASONS below and nothing else — a security log that stored the guesses
 * would be a list of passwords to try on the next system.
 */

const { Op } = require('sequelize');
const db = require('../db');
const config = require('../config');
const audit = require('./audit');

/**
 * Why an attempt failed. Codes, for the log and for nothing else: the sign-in
 * forms go on saying one thing however the attempt failed, so that the form
 * never reveals which usernames or Family IDs exist.
 */
const REASONS = {
  OK: 'ok',
  NO_SUCH_USER: 'no_such_user',
  BAD_PASSWORD: 'bad_password',
  INACTIVE: 'inactive',
  BLOCKED: 'ip_blocked',
  MALFORMED: 'malformed'
};

/** The longest User-Agent kept. Long enough to name a browser and an OS. */
const MAX_USER_AGENT = 255;

function nowMs() {
  return Date.now();
}

/** The 'YYYY-MM-DD HH:MM:SS' this database stores, for a given moment. */
function stamp(ms = nowMs()) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * One identifier, spelled the same way every time it is counted.
 *
 * A staff sign-in is counted by username; a household one by parish and Family
 * ID together, because a family numbered 0147 in one parish is a different
 * household from 0147 in the next and the two must not share a counter.
 */
function identify(kind, value) {
  return `${kind === 'family' ? 'family' : 'staff'}:${String(value || '').trim().toLowerCase()}`;
}

/**
 * The address this request came from.
 *
 * `req.ip` is only the caller's address if Express has been told whether to
 * believe X-Forwarded-For. Behind nginx with TRUST_PROXY unset every request
 * appears to come from 127.0.0.1, and the IP rule would then count the whole
 * parish as one guesser and block all of it at once. `ipRuleApplies` below is
 * what refuses to do that; this just reports what was seen.
 */
function addressOf(req) {
  return String((req && req.ip) || '').replace(/^::ffff:/, '') || 'unknown';
}

/**
 * Is the address we have worth acting on?
 *
 * A loopback address on an install that has not been told to trust its proxy
 * is not evidence about anybody: it is the proxy's own address wearing the
 * whole parish's traffic. Logging it is still useful — the attempt happened,
 * and the log should say so — but blocking on it would take the parish offline
 * on the fifteenth wrong password anyone typed.
 */
function ipRuleApplies(ip) {
  if (!ip || ip === 'unknown') return false;
  const loopback = ip === '127.0.0.1' || ip === '::1';
  return !loopback || config.trustProxy;
}

// ---------------------------------------------------------------------------
// Writing it down
// ---------------------------------------------------------------------------

/**
 * Record one attempt, and apply the address rule to it.
 *
 * Writing is best-effort for the same reason lib/audit.js's is — a log that
 * cannot be written must not be able to stop a parish administrator signing
 * in — but a failure is reported to the console rather than swallowed, because
 * a security log that has quietly stopped recording is worse than none.
 */
async function record(req, { kind, identifier, success, reason, userId = null, churchId = null }) {
  const key = identify(kind, identifier);
  const ip = addressOf(req);

  try {
    await db.LoginAttempt.create({
      at: stamp(),
      kind: kind === 'family' ? 'family' : 'staff',
      identifier: key,
      ip,
      user_agent: String((req && req.get && req.get('user-agent')) || '').slice(0, MAX_USER_AGENT),
      success: Boolean(success),
      reason: String(reason || '').slice(0, 40),
      user_id: userId,
      church_id: churchId
    });
  } catch (err) {
    console.error('login attempt log write failed:', err.message);
    return;
  }

  if (success || !ipRuleApplies(ip)) return;

  await maybeBlock(req, ip, churchId);
  await maybePrune();
}

/**
 * Block an address that has failed too often inside the window.
 *
 * The count is of failures, not of attempts: an address where somebody is
 * working normally and mistyping occasionally never approaches fifteen, and an
 * address running a list does so in seconds.
 *
 * A block already in force is left alone rather than extended on every further
 * attempt, so that a script hammering a blocked address cannot push its own
 * release date out indefinitely — the refusal is already free by then, and the
 * parish gets a predictable answer to "when does this lift".
 */
async function maybeBlock(req, ip, churchId) {
  const existing = await db.IpBlock.findByPk(ip);
  if (existing && existing.blocked_until > stamp()) return;

  const since = stamp(nowMs() - config.login.ipWindowMs);
  const failures = await db.LoginAttempt.count({
    where: { ip, success: false, at: { [Op.gte]: since } }
  });

  if (failures < config.login.ipMaxFailures) return;

  const until = stamp(nowMs() + config.login.ipBlockMs);

  /*
   * A few of the identifiers it was aiming at, for the page that lists blocks.
   * Distinct, capped and truncated: the point being made is "it was working
   * through a list", which five entries make as well as five hundred.
   */
  const recent = await db.LoginAttempt.findAll({
    attributes: ['identifier'],
    where: { ip, success: false, at: { [Op.gte]: since } },
    order: [['at', 'DESC'], ['id', 'DESC']],
    limit: 50,
    raw: true
  });
  const tried = [...new Set(recent.map((r) => r.identifier))].slice(0, 5).join(', ');

  await db.IpBlock.upsert({
    ip,
    blocked_at: stamp(),
    blocked_until: until,
    failures,
    tried: tried.slice(0, 500)
  });

  await audit.record(req, 'security.ip_blocked', {
    churchId,
    username: '(signed out)',
    detail: `${ip} blocked until ${until} after ${failures} failed sign-ins; `
      + `tried ${tried || 'nothing recorded'}`
  });
}

/**
 * Is this address currently refused?
 *
 * Asked before a password is verified, so a blocked address costs one indexed
 * primary-key lookup rather than a bcrypt comparison — which is the expensive
 * half, and the half an attacker would like to make us run.
 */
async function blockedUntil(req) {
  const ip = addressOf(req);
  if (!ipRuleApplies(ip)) return null;

  const row = await db.IpBlock.findByPk(ip);
  if (!row) return null;
  if (row.blocked_until <= stamp()) {
    await db.IpBlock.destroy({ where: { ip } });
    return null;
  }
  return row.blocked_until;
}

// ---------------------------------------------------------------------------
// The delay
// ---------------------------------------------------------------------------

/**
 * How many times this identifier has failed since it last succeeded.
 *
 * "Since it last succeeded" is what "reset the counter after a successful
 * login" means: an administrator who fumbles their password twice, gets in,
 * and comes back tomorrow starts from zero. Failures from any address count,
 * because the address is the attacker's to change.
 */
async function failuresSinceSuccess(kind, identifier) {
  const key = identify(kind, identifier);

  /*
   * "Since" is measured by row id and not by `at`.
   *
   * The timestamps in this database are 'YYYY-MM-DD HH:MM:SS' — whole
   * seconds — and a scripted attack puts many attempts inside one of them. A
   * comparison on `at` therefore drops every failure that shares a second with
   * the last success, which is exactly the burst worth counting: get the
   * password right once, and the next half-dozen guesses are free. The id is
   * monotonic per insert, so ordering on it is exact whatever the clock is
   * doing.
   */
  const lastSuccess = await db.LoginAttempt.findOne({
    attributes: ['id'],
    where: { identifier: key, success: true },
    order: [['id', 'DESC']],
    raw: true
  });

  const where = { identifier: key, success: false };
  if (lastSuccess) where.id = { [Op.gt]: lastSuccess.id };

  return db.LoginAttempt.count({ where });
}

/**
 * How long this attempt should be made to wait before it is answered.
 *
 * Doubling from `delayStepMs`, capped at `delayMaxMs`. The cap is not
 * politeness: each delayed request holds a connection open, and an uncapped
 * ladder is a way to exhaust them.
 */
async function delayFor(kind, identifier) {
  return delayForFailures(await failuresSinceSuccess(kind, identifier));
}

/** The ladder itself, as arithmetic, so a test can read it without a database. */
function delayForFailures(failures) {
  const over = failures - config.login.delayAfter;
  if (over <= 0) return 0;
  return Math.min(config.login.delayStepMs * (2 ** (over - 1)), config.login.delayMaxMs);
}

/**
 * Wait, unless the person has given up and closed the tab.
 *
 * A wait that outlives its request is a connection held for nothing, so the
 * sleep is abandoned the moment the client hangs up. The caller carries on and
 * answers into a socket nobody is listening to, which is harmless and is over
 * at once.
 */
function sleep(ms, req) {
  if (!ms) return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      if (req && req.off) req.off('close', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (req && req.once) req.once('close', done);
  });
}

/**
 * Note in the audit log that an identifier is being worked on.
 *
 * The delay is silent by design, so without this a parish would see a blocked
 * address in the log and never learn which of its accounts somebody had been
 * grinding on. Recorded only on the attempt that crosses the threshold — one
 * line per episode rather than one per guess, or the audit log becomes noise
 * and stops being the thing that makes an incident readable.
 */
async function noteRepeatedFailures(req, { kind, identifier, failures, churchId = null }) {
  if (failures !== config.login.repeatedFailureNotice) return;

  await audit.record(req, 'security.repeated_failures', {
    churchId,
    username: '(signed out)',
    detail: `${failures} consecutive failed sign-ins for ${identify(kind, identifier)} `
      + `from ${addressOf(req)}`
  });
}

// ---------------------------------------------------------------------------
// Keeping the table a sensible size
// ---------------------------------------------------------------------------

let lastPrune = 0;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/**
 * Drop attempts past the retention period, and blocks that have lifted.
 *
 * On a write rather than on a timer, so nothing has to be started or stopped,
 * and at most once an hour, so the attack that fills the table fastest is not
 * also the thing that makes us sweep it on every request.
 */
async function maybePrune() {
  if (nowMs() - lastPrune < PRUNE_EVERY_MS) return;
  lastPrune = nowMs();

  try {
    const cutoff = stamp(nowMs() - config.login.retentionDays * 24 * 60 * 60 * 1000);
    await db.LoginAttempt.destroy({ where: { at: { [Op.lt]: cutoff } } });
    await db.IpBlock.destroy({ where: { blocked_until: { [Op.lt]: stamp() } } });
  } catch (err) {
    console.error('login attempt log prune failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

/** The attempt log, newest first, optionally narrowed. */
async function list({ identifier = null, ip = null, failuresOnly = false, limit = 200 } = {}) {
  const where = {};
  if (identifier) where.identifier = { [Op.like]: `%${String(identifier).trim().toLowerCase()}%` };
  if (ip) where.ip = { [Op.like]: `%${String(ip).trim()}%` };
  if (failuresOnly) where.success = false;

  return db.LoginAttempt.findAll({
    where,
    order: [['at', 'DESC'], ['id', 'DESC']],
    limit: Math.min(Number(limit) || 200, 1000),
    raw: true
  });
}

/** Addresses currently refused, soonest to lift first. */
async function blocks() {
  await db.IpBlock.destroy({ where: { blocked_until: { [Op.lt]: stamp() } } });
  return db.IpBlock.findAll({ order: [['blocked_until', 'ASC']], raw: true });
}

/** Lift a block by hand. */
async function unblock(req, ip) {
  const removed = await db.IpBlock.destroy({ where: { ip: String(ip || '') } });
  if (removed) {
    await audit.record(req, 'security.ip_unblocked', { detail: `${ip} unblocked` });
  }
  return removed > 0;
}

module.exports = {
  REASONS,
  record,
  blockedUntil,
  failuresSinceSuccess,
  delayFor,
  delayForFailures,
  sleep,
  noteRepeatedFailures,
  list,
  blocks,
  unblock,
  addressOf,
  identify,
  stamp
};
