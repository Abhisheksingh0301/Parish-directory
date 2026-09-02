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
