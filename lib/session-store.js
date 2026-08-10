'use strict';

/**
 * express-session store backed by the same SQLite file as everything else.
 *
 * The default MemoryStore leaks and logs everyone out on restart; a separate
 * session server would be one more thing for a parish to run. Sessions live in
 * the `sessions` table so a deployment stays a single file plus this app.
 */

const db = require('../db');

const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

module.exports = function createStore(session) {
  class SqliteStore extends session.Store {
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
      db.get('SELECT data, expires FROM sessions WHERE sid = ?', [sid])
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
      db.run(
        `INSERT INTO sessions (sid, expires, data) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires, data = excluded.data`,
        [sid, this.expiryFor(sess), JSON.stringify(sess)]
      )
        .then(() => callback(null))
        .catch((err) => callback(err));
    }

    touch(sid, sess, callback) {
      db.run('UPDATE sessions SET expires = ? WHERE sid = ?', [this.expiryFor(sess), sid])
        .then(() => callback(null))
        .catch((err) => callback(err));
    }

    destroy(sid, callback) {
      db.run('DELETE FROM sessions WHERE sid = ?', [sid])
        .then(() => callback(null))
        .catch((err) => callback(err));
    }

    length(callback) {
      db.get('SELECT COUNT(*) AS n FROM sessions WHERE expires > ?', [Date.now()])
        .then((row) => callback(null, row ? row.n : 0))
        .catch((err) => callback(err));
    }

    clear(callback) {
      db.run('DELETE FROM sessions')
        .then(() => callback(null))
        .catch((err) => callback(err));
    }

    prune() {
      return db.run('DELETE FROM sessions WHERE expires <= ?', [Date.now()]);
    }
  }

  return SqliteStore;
};
