'use strict';

/**
 * express-session store backed by the same database as everything else.
 *
 * The default MemoryStore leaks and logs everyone out on restart; a separate
 * session server would be one more thing for a parish to run. Sessions live in
 * the `sessions` table so a deployment stays this app plus one database.
 *
 * Written against the Session model rather than a ready-made store because the
 * schema predates the ORM: `expires` holds epoch milliseconds as an integer,
 * where connect-session-sequelize would want a DATE. Keeping the column as it
 * is avoids migrating a table whose contents are disposable but whose `data`
 * column is matched on by models/user.js when signing an account out
 * everywhere.
 */

const { Op } = require('sequelize');
const db = require('../db');

const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

module.exports = function createStore(session) {
  class DatabaseStore extends session.Store {
    constructor(options = {}) {
      super(options);
      this.ttlSeconds = options.ttl || 14 * 24 * 60 * 60;

      this.pruneTimer = setInterval(() => {
        this.prune().catch((err) => console.error('session prune failed:', err.message));
      }, PRUNE_INTERVAL_MS);
      this.pruneTimer.unref();
    }

    expiryFor(sess) {
      const cookieExpires = sess && sess.cookie && sess.cookie.expires;
      if (cookieExpires) return new Date(cookieExpires).getTime();
      return Date.now() + this.ttlSeconds * 1000;
    }

    get(sid, callback) {
      db.Session.findByPk(sid, { attributes: ['data', 'expires'], raw: true })
        .then((row) => {
          if (!row) return callback(null, null);
          if (row.expires <= Date.now()) {
            return this.destroy(sid, () => callback(null, null));
          }
          callback(null, JSON.parse(row.data));
        })
        .catch((err) => callback(err));
    }

    set(sid, sess, callback) {
      db.Session.upsert({
        sid,
        expires: this.expiryFor(sess),
        data: JSON.stringify(sess)
      })
        .then(() => callback(null))
        .catch((err) => callback(err));
    }

    touch(sid, sess, callback) {
      db.Session.update({ expires: this.expiryFor(sess) }, { where: { sid } })
        .then(() => callback(null))
        .catch((err) => callback(err));
    }

    destroy(sid, callback) {
      db.Session.destroy({ where: { sid } })
        .then(() => callback(null))
        .catch((err) => callback(err));
    }

    length(callback) {
      db.Session.count({ where: { expires: { [Op.gt]: Date.now() } } })
        .then((n) => callback(null, n))
        .catch((err) => callback(err));
    }

    clear(callback) {
      db.Session.destroy({ where: {} })
        .then(() => callback(null))
        .catch((err) => callback(err));
    }

    prune() {
      return db.Session.destroy({ where: { expires: { [Op.lte]: Date.now() } } });
    }
  }

  return DatabaseStore;
};
