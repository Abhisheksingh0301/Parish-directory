'use strict';

/**
 * The one Sequelize instance for the process.
 *
 * Why an ORM at all: the app used to write SQLite SQL directly in its routes,
 * which meant the choice of database was spread across sixty-odd call sites.
 * Everything now goes through Sequelize's model API, so the engine is named in
 * one place — here — and changing it does not mean rewriting queries.
 *
 * What still knows it is SQLite: the pragmas below, and the first two entries
 * in db/migrations.js. Both are explicitly marked.
 */

const { Sequelize } = require('sequelize');
const config = require('../config');

const options = {
  logging: config.db.logSql ? (sql) => console.log(sql) : false,
  define: {
    // Columns are snake_case in this schema and the views read them directly,
    // so no name mangling in either direction.
    underscored: true,
    freezeTableName: true,
    timestamps: false
  }
};

/**
 * SQLite gets a pool of exactly one connection.
 *
 * Pragmas are per-connection, not per-database — `foreign_keys` set on one
 * pooled connection says nothing about the next. The migration runner turns
 * foreign keys off while it rebuilds a table, and that has to mean the same
 * connection the rebuild runs on. A single connection also removes SQLITE_BUSY
 * between the app's own queries, which is what the previous hand-rolled layer
 * achieved by opening one handle in serialized mode.
 *
 * A server engine has none of this problem and keeps a normal pool.
 */
const pool = config.db.dialect === 'sqlite' && !config.db.url
  ? { max: 1, min: 0, idle: 10000 }
  : undefined;

const sequelize = config.db.url
  ? new Sequelize(config.db.url, { ...options, pool })
  : new Sequelize({
    ...options,
    pool,
    dialect: config.db.dialect,
    storage: config.db.storage
  });

/**
 * SQLite needs telling how to behave; other engines do these by default or not
 * at all. Foreign keys are off by default in SQLite, which would quietly make
 * every ON DELETE CASCADE in the schema a decoration.
 */
async function applyDialectPragmas() {
  if (sequelize.getDialect() !== 'sqlite') return;

  // WAL survives across connections, so it is set once and stays set.
  await sequelize.query('PRAGMA journal_mode = WAL');
  await sequelize.query('PRAGMA foreign_keys = ON');
  await sequelize.query('PRAGMA busy_timeout = 5000');
}

module.exports = { sequelize, Sequelize, applyDialectPragmas };
