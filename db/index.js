'use strict';

/**
 * SQLite data layer (node-sqlite3).
 *
 * node-sqlite3 is callback-based; everything below is wrapped in promises so
 * route handlers can use async/await. One connection is used for the whole
 * process and is put into serialized mode, so statements — including the ones
 * inside a transaction — never interleave.
 */

const sqlite3 = require('sqlite3');
const config = require('../config');

let db = null;

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function exec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

/** Run `fn` inside a transaction, rolling back if it throws. */
async function tx(fn) {
  await run('BEGIN IMMEDIATE');
  try {
    const result = await fn();
    await run('COMMIT');
    return result;
  } catch (err) {
    try {
      await run('ROLLBACK');
    } catch (rollbackErr) {
      // The original error is the useful one; keep it.
    }
    throw err;
  }
}

/**
 * Schema migrations, applied in order and tracked with PRAGMA user_version.
 * Never edit a migration that has shipped — append a new one instead, so
 * parishes already running an older copy upgrade cleanly.
 */
const MIGRATIONS = [
  // 1 — initial schema
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    full_name     TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'viewer',
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );

  CREATE TABLE families (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    family_id    TEXT NOT NULL UNIQUE COLLATE NOCASE,
    head_name    TEXT NOT NULL,
    address      TEXT NOT NULL DEFAULT '',
    hometown     TEXT NOT NULL DEFAULT '',
    home_parish  TEXT NOT NULL DEFAULT '',
    spouse_home  TEXT NOT NULL DEFAULT '',
    email        TEXT NOT NULL DEFAULT '',
    photo        TEXT,
    dom_day      INTEGER,
    dom_month    INTEGER,
    is_published INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE members (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL DEFAULT 0,
    name      TEXT NOT NULL,
    relation  TEXT NOT NULL DEFAULT '',
    dob_day   INTEGER,
    dob_month INTEGER,
    mobile    TEXT NOT NULL DEFAULT '',
    links     TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX idx_members_family ON members(family_id, position);
  CREATE INDEX idx_families_head  ON families(head_name COLLATE NOCASE);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE sessions (
    sid     TEXT PRIMARY KEY,
    expires INTEGER NOT NULL,
    data    TEXT NOT NULL
  );

  CREATE INDEX idx_sessions_expires ON sessions(expires);
  `,

  // 2 — family logins: an account tied to one family, created with the
  // shared default password so the parish can invite everybody in one email.
  `
  ALTER TABLE users ADD COLUMN family_id INTEGER
    REFERENCES families(id) ON DELETE CASCADE;

  ALTER TABLE users ADD COLUMN on_default_password INTEGER NOT NULL DEFAULT 0;

  CREATE UNIQUE INDEX idx_users_family ON users(family_id)
    WHERE family_id IS NOT NULL;
  `,

  // 3 — a year on dates of birth. The date of marriage stays day + month, but
  // a birthday is a full date, so `dob_year` joins the day and month already
  // stored. Nullable: entries collected before this, and families who would
  // rather not give a year, keep working.
  `
  ALTER TABLE members ADD COLUMN dob_year INTEGER;
  `
];

/** Settings a fresh install starts with. Editable in-app under Settings. */
const DEFAULT_SETTINGS = {
  parish_name: config.seed.parishName,
  directory_title: config.seed.directoryTitle,
  starting_page: '1',
  per_page: '2',
  relation_options: 'HF, W, S, D, F, M, B, Sr, GF, GM',
  color_band: '#cec4b3',
  color_band_dark: '#b6ab97',
  color_member_a: '#d9d2c4',
  color_member_b: '#cec6b6',
  color_rule: '#a99e8a'
};

async function migrate() {
  const row = await get('PRAGMA user_version');
  const current = row ? row.user_version : 0;

  for (let version = current; version < MIGRATIONS.length; version += 1) {
    await exec(MIGRATIONS[version]);
    // PRAGMA does not accept bound parameters.
    await exec(`PRAGMA user_version = ${version + 1}`);
  }
}

async function seedSettings() {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, value]);
  }
}

function open() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(config.dbFile, (err) => (err ? reject(err) : resolve()));
  });
}

async function init() {
  await open();
  db.serialize();
  await run('PRAGMA journal_mode = WAL');
  await run('PRAGMA foreign_keys = ON');
  await run('PRAGMA busy_timeout = 5000');
  await migrate();
  await seedSettings();
  return module.exports;
}

function close() {
  return new Promise((resolve) => {
    if (!db) return resolve();
    db.close(() => resolve());
  });
}

module.exports = { init, close, run, get, all, exec, tx, DEFAULT_SETTINGS };
