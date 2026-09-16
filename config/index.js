'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const env = process.env.NODE_ENV || 'development';
const isProduction = env === 'production';

const dataDir = path.resolve(
  __dirname,
  '..',
  process.env.DATA_DIR || './data'
);

fs.mkdirSync(dataDir, { recursive: true });

const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

/**
 * In production the secret must be supplied — a rotating secret would log
 * everyone out on every restart, and a hard-coded one is not a secret.
 * In development we generate one once and keep it beside the database so
 * restarts during development don't drop the session.
 */
function resolveSessionSecret() {
  const fromEnv = (process.env.SESSION_SECRET || '').trim();
  if (fromEnv) return fromEnv;

  if (isProduction) {
    throw new Error(
      'SESSION_SECRET is not set. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n' +
      'and put it in your .env file before starting in production.'
    );
  }

  const cached = path.join(dataDir, '.session-secret');
  if (fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8').trim();

  const generated = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(cached, generated, { mode: 0o600 });
  return generated;
}

/**
 * A number from the environment, or the default when it is missing, not a
 * number, or outside what the setting can mean.
 *
 * Silently falling back matters more here than shouting: a typo in
 * SESSION_IDLE_MINUTES that produced NaN would otherwise expire every session
 * on its first request and lock the parish out of its own directory.
 */
function numberEnv(name, fallback, min, max) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.warn(
      `${name}="${raw}" is not a number between ${min} and ${max}; using ${fallback}.`
    );
    return fallback;
  }
  return value;
}

/*
 * The floor is there to catch a typo — a negative, a NaN, an empty product of
 * some deployment script — and not to second-guess an operator who means it.
 * A parish that writes 5 gets 5. The sub-minute end of the range is what
 * test/idle.js runs on, so the timeout can be proved in ten seconds rather
 * than by waiting out a real window.
 */
const idleMs = numberEnv('SESSION_IDLE_MINUTES', 30, 0.05, 24 * 60) * 60 * 1000;

/*
 * The warning has to fit inside the timeout, and leave room to be read and
 * acted on. Half the window is the ceiling: with a 2-minute timeout the notice
 * comes at one minute, not at the 60 seconds asked for, which would put it
 * almost at sign-in.
 */
const warnMs = Math.min(
  numberEnv('SESSION_WARNING_SECONDS', 60, 1, 30 * 60) * 1000,
  Math.floor(idleMs / 2)
);

/**
 * How long the cookie and the stored row outlive the idle window.
 *
 * They have to outlive it a little, or the two expiries race and the cookie
 * usually wins: the session record vanishes underneath the request, lib/idle.js
 * sees an anonymous visitor rather than an expired one, and the person is
 * dropped on the sign-in page with no explanation of what happened to their
 * afternoon.
 *
 * With the grace, the decision is always lib/idle.js's and it is always able to
 * say so. The cookie and the row are then a backstop rather than the mechanism:
 * they clear up a session the server never hears from again. Nothing is granted
 * by holding a cookie inside the grace — every request is still checked against
 * `lastSeen` on arrival, and one past the window is refused.
 */
const cookieMs = idleMs + 5 * 60 * 1000;

module.exports = {
  env,
  isProduction,
  port: Number(process.env.PORT || 3000),
  /**
   * The public URL prefix, when a reverse proxy serves this install under a
   * sub-path and strips it before forwarding — `location /parishdir/` with
   * `proxy_pass http://127.0.0.1:3001/;`. The app still sees paths from the
   * root, so this is needed only for the URLs it writes into a page.
   *
   * Empty when the app owns its domain, which is the ordinary case: every URL
   * then comes out exactly as it did before this setting existed.
   */
  basePath: (process.env.BASE_PATH || '').trim().replace(/\/+$/, ''),
  dataDir,
  uploadDir,
  dbFile: path.join(dataDir, 'parish.db'),
  /**
   * The database, described rather than assumed.
   *
   * Every query in the app is written against Sequelize's model API instead of
   * SQL, so moving to PostgreSQL or MySQL is setting `DATABASE_URL` and running
   * the schema — not rewriting the code. The one part that does not travel for
   * free is the schema history; see the note at the top of db/migrations.js.
   */
  db: {
    url: (process.env.DATABASE_URL || '').trim() || null,
    dialect: (process.env.DB_DIALECT || 'sqlite').trim(),
    storage: path.join(dataDir, 'parish.db'),
    logSql: process.env.LOG_SQL === '1'
  },
  sessionSecret: resolveSessionSecret(),
  /**
   * Idle timeout: how long a signed-in session survives with nothing happening
   * on it, and how long before that the browser offers to keep it alive.
   *
   * Measured from the last request the person actually caused, not from when
   * they signed in — a clerk working steadily through the afternoon is never
   * interrupted, and one who walks away from an unlocked machine in the parish
   * office is signed out whether or not the browser is still open.
   *
   * Two numbers so the warning can be tuned separately: a 5-minute timeout
   * wants a shorter notice than an hour-long one. The warning is clamped below
   * the timeout because a notice that appears before the countdown starts would
   * never be shown at all.
   */
  session: { idleMs, warnMs, cookieMs },
  trustProxy: process.env.TRUST_PROXY === '1',
  secureCookies:
    process.env.SECURE_COOKIES === '1' ||
    (process.env.SECURE_COOKIES === undefined && isProduction) ||
    (process.env.SECURE_COOKIES === '' && isProduction),
  /**
   * The password every family login is created with. It is deliberately one
   * shared value the parish office can put in a single email to everybody;
   * each family is asked to change it once they are in.
   */
  defaultUserPassword:
    (process.env.DEFAULT_USER_PASSWORD || 'Churchmembers@2026').trim(),
  // Used once, when the database is first created.
  seed: {
    parishName: process.env.PARISH_NAME || 'Your Parish Church, City',
    directoryTitle: process.env.DIRECTORY_TITLE || 'Family Parish Directory',
    // The diocese an already-running single-parish install is folded into when
    // it is upgraded to hold many churches. Renamed in the console afterwards.
    dioceseName: process.env.DIOCESE_NAME || 'Unnamed Diocese'
  },
  maxPhotoBytes: 5 * 1024 * 1024
};
