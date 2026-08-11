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
 *
 * Migration 1 is the whole schema as one set of CREATE TABLEs — no parish is
 * running an older copy yet, so there is nothing to migrate *from* and every
 * column belongs in the table that owns it. Once this has gone out to a
 * church, that stops being true: never edit a migration that has shipped,
 * append a new one instead, so parishes already running an older copy upgrade
 * cleanly.
 *
 * Tables are created in dependency order — families before the members and
 * logins that point at them.
 */
const MIGRATIONS = [
  // 1 — the schema
  `
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
    -- Date of marriage: day and month only, never a year.
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
    -- Date of birth: a full date, but the year is optional, so an entry can
    -- be recorded before anyone has asked the family for it. Day and month
    -- stay in their own columns to keep the birthday list sortable.
    dob_day   INTEGER,
    dob_month INTEGER,
    dob_year  INTEGER,
    mobile    TEXT NOT NULL DEFAULT '',
    links     TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    full_name     TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'viewer',
    is_active     INTEGER NOT NULL DEFAULT 1,
    -- Set on a family login: the one family this account may reach. NULL for
    -- staff accounts. UNIQUE gives a family at most one login — SQLite treats
    -- NULLs as distinct, so any number of staff accounts still fit.
    family_id     INTEGER UNIQUE REFERENCES families(id) ON DELETE CASCADE,
    -- Still using the password everyone was given, so the reminder shows.
    on_default_password INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
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

  // 2 — relation codes become words
  //
  // "HF, W, S, D" is obvious to whoever compiled the last directory and to
  // nobody else — least of all a family filling in its own entry. The words
  // print just as well and read without a key, so the codes already recorded
  // are converted here rather than left as a second vocabulary nobody can
  // look up. Only the ten codes this app shipped with are touched; a parish
  // that invented its own keeps them untouched, and so does one that has
  // already edited the list of suggestions.
  `
  UPDATE members SET relation = CASE UPPER(TRIM(relation))
    WHEN 'HF' THEN 'Head'
    WHEN 'W'  THEN 'Wife'
    WHEN 'S'  THEN 'Son'
    WHEN 'D'  THEN 'Daughter'
    WHEN 'F'  THEN 'Father'
    WHEN 'M'  THEN 'Mother'
    WHEN 'B'  THEN 'Brother'
    WHEN 'SR' THEN 'Sister'
    WHEN 'GF' THEN 'Grandfather'
    WHEN 'GM' THEN 'Grandmother'
    ELSE relation
  END;

  UPDATE settings
     SET value = 'Head, Wife, Son, Daughter, Father, Mother, Brother, Sister, Grandfather, Grandmother'
   WHERE key = 'relation_options'
     AND value = 'HF, W, S, D, F, M, B, Sr, GF, GM';
  `
];

/** Settings a fresh install starts with. Editable in-app under Settings. */
const DEFAULT_SETTINGS = {
  parish_name: config.seed.parishName,
  directory_title: config.seed.directoryTitle,
  starting_page: '1',
  per_page: '2',
  relation_options: 'Head, Wife, Son, Daughter, Father, Mother, Brother, Sister, Grandfather, Grandmother',
  color_band: '#cec4b3',
  color_band_dark: '#b6ab97',
  color_member_a: '#d9d2c4',
  color_member_b: '#cec6b6',
  color_rule: '#a99e8a'
};

async function migrate() {
  const row = await get('PRAGMA user_version');
  const current = row ? row.user_version : 0;

  // A database newer than the code means someone has gone backwards — an
  // older copy of the app pointed at a parish that has already been upgraded.
  // Say so rather than running queries against a schema we don't know.
  if (current > MIGRATIONS.length) {
    throw new Error(
      `This database is at schema version ${current}, but this copy of the app ` +
      `only knows ${MIGRATIONS.length}. Update the app before opening it.`
    );
  }

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
