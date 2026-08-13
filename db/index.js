'use strict';

/**
 * Opening, migrating and seeding the database.
 *
 * The engine is chosen in config and connected in db/sequelize.js; the shape of
 * the data is db/models.js; the history of that shape is db/migrations.js. This
 * file is the start-up sequence that puts the three together, plus the two sets
 * of default settings a new installation begins with.
 */

const { QueryTypes, DataTypes, Op } = require('sequelize');
const config = require('../config');
const { sequelize, applyDialectPragmas } = require('./sequelize');
const models = require('./models');
const { MIGRATIONS, CHURCH_SETTING_KEYS } = require('./migrations');

/**
 * Settings that belong to one church. These live in `settings` as the fallback
 * a newly created church starts from, and are copied into `church_settings`
 * the moment that church edits any of them.
 */
const DEFAULT_SETTINGS = {
  parish_name: config.seed.parishName,
  directory_title: config.seed.directoryTitle,
  starting_page: '1',
  per_page: '2',
  relation_options: 'Head, Wife, Son, Daughter, Father, Mother, Brother, Sister, Grandfather, Grandmother',
  // The password every member login in this church is created with. It was a
  // single environment variable shared by the whole installation, which meant
  // one church's staff could read the string that opened every other church's
  // new member accounts. DEFAULT_USER_PASSWORD is now only the starting value.
  default_member_password: config.defaultUserPassword,
  color_band: '#cec4b3',
  color_band_dark: '#b6ab97',
  color_member_a: '#d9d2c4',
  color_member_b: '#cec6b6',
  color_rule: '#a99e8a'
};

/**
 * Settings that belong to the installation rather than to any church.
 *
 * The two nouns are configurable because Indian denominations do not share
 * them: a Syro-Malabar install says Eparchy and Forane, a CSI one says Diocese
 * and Pastorate, and hard-coding either would read as wrong to half the users.
 * One deployment serves one structure, so these are not per-church.
 */
const PLATFORM_SETTINGS = {
  diocese_label: 'Diocese',
  zone_label: 'Zone'
};

/**
 * The applied schema version.
 *
 * Recorded in a table rather than SQLite's `PRAGMA user_version`, which no
 * other engine has. An install created before that table existed carries its
 * version in the pragma, so it is read across once and never consulted again.
 */
async function readVersion(qi) {
  await qi.createTable('schema_version', {
    version: { type: DataTypes.INTEGER, primaryKey: true, allowNull: false }
  });

  const rows = await sequelize.query(
    'SELECT version FROM schema_version',
    { type: QueryTypes.SELECT }
  );
  if (rows.length) return Number(rows[0].version);

  let legacy = 0;
  if (sequelize.getDialect() === 'sqlite') {
    const [row] = await sequelize.query('PRAGMA user_version', { type: QueryTypes.SELECT });
    legacy = (row && Number(row.user_version)) || 0;
  }

  await sequelize.query('INSERT INTO schema_version (version) VALUES (:v)', {
    replacements: { v: legacy }
  });
  return legacy;
}

function bumpVersion(version, transaction) {
  return sequelize.query('UPDATE schema_version SET version = :v', {
    replacements: { v: version },
    transaction
  });
}

/**
 * One migration, in a transaction, rolled back whole if any part of it fails.
 *
 * SQLite needs its transaction issued by hand, and the reason is worth writing
 * down because the failure it prevents is silent and total.
 *
 * `sequelize.transaction()` takes a connection from the pool, and the SQLite
 * driver runs `PRAGMA FOREIGN_KEYS=ON` on every connection it opens. Pragmas
 * are per-connection, so `foreign_keys = OFF` set before the transaction does
 * not apply inside it. That matters because rebuilding `families` has to drop
 * it, and `DROP TABLE` with foreign keys enabled performs an implicit
 * `DELETE FROM` first — which cascades into `members` and into the household
 * logins in `users`, emptying both. The migration reports success and the
 * directory is gone.
 *
 * Issuing BEGIN and COMMIT as plain statements keeps every statement on the one
 * connection the SQLite pool is capped at, where the pragma holds. Other
 * engines have neither the pragma nor the problem, and use the managed
 * transaction.
 */
async function runMigration(qi, step, version, isSqlite) {
  const label = `Migration ${version + 1}`;

  if (!isSqlite) {
    return sequelize.transaction(async (transaction) => {
      await step({ qi, sequelize, transaction, DataTypes });
      await bumpVersion(version + 1, transaction);
    }).catch((err) => {
      throw new Error(`${label} failed and was rolled back: ${err.message}`);
    });
  }

  await sequelize.query('BEGIN IMMEDIATE');
  try {
    await step({ qi, sequelize, transaction: null, DataTypes });

    // Enforcement is off; this check is not, and it is the last chance to
    // notice that a rebuild has orphaned something.
    const broken = await sequelize.query('PRAGMA foreign_key_check', {
      type: QueryTypes.SELECT
    });
    if (broken.length) {
      throw new Error(`it left ${broken.length} broken foreign key reference(s)`);
    }

    await bumpVersion(version + 1, null);
    await sequelize.query('COMMIT');
  } catch (err) {
    await sequelize.query('ROLLBACK').catch(() => {});
    throw new Error(`${label} failed and was rolled back: ${err.message}`);
  }
}

async function migrate() {
  const qi = sequelize.getQueryInterface();
  const current = await readVersion(qi);

  // A database newer than the code means someone has gone backwards — an older
  // copy of the app pointed at a directory that has already been upgraded. Say
  // so rather than running queries against a schema we do not know.
  if (current > MIGRATIONS.length) {
    throw new Error(
      `This database is at schema version ${current}, but this copy of the app ` +
      `only knows ${MIGRATIONS.length}. Update the app before opening it.`
    );
  }
  if (current === MIGRATIONS.length) return;

  const isSqlite = sequelize.getDialect() === 'sqlite';
  if (isSqlite) await sequelize.query('PRAGMA foreign_keys = OFF');

  try {
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      await runMigration(qi, MIGRATIONS[version], version, isSqlite);
    }
  } finally {
    if (isSqlite) await sequelize.query('PRAGMA foreign_keys = ON');
  }
}

/** Settings a fresh installation starts with. Existing values are never touched. */
async function seedSettings() {
  const all = { ...DEFAULT_SETTINGS, ...PLATFORM_SETTINGS };

  for (const [key, value] of Object.entries(all)) {
    await models.Setting.findOrCreate({ where: { key }, defaults: { key, value } });
  }
}

async function init() {
  await sequelize.authenticate();
  await applyDialectPragmas();
  await migrate();
  await seedSettings();
  return module.exports;
}

function close() {
  return sequelize.close();
}

module.exports = {
  init,
  close,
  sequelize,
  Op,
  QueryTypes,
  ...models,
  DEFAULT_SETTINGS,
  PLATFORM_SETTINGS,
  CHURCH_SETTING_KEYS
};
