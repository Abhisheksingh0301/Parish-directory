'use strict';

/**
 * Signing out a session that has been left alone.
 *
 * A parish office is a shared room. The machine on the desk is signed in as
 * somebody with the whole register behind it, and whoever was using it has
 * gone to answer the door. This expires that session.
 *
 * The rule is inactivity, not age: `last_seen` moves forward on every request
 * the person actually caused, so somebody working steadily is never signed out
 * mid-sentence however long they have been at it, and a session nobody has
 * touched for `config.session.idleMs` is finished whether it was opened five
 * minutes ago or yesterday.
 *
 * The decision is made here, on the server, from a timestamp held in the
 * session record. The countdown in the browser (public/javascripts/session-
 * timeout.js) is a courtesy on top of it — it gives warning and it redirects
 * tidily, but with JavaScript off, the clock changed, or the script blocked,
 * the next request still arrives at this file and is still refused. Nothing
 * about the expiry depends on the page having run any code.
 *
 * Three pieces:
 *
 *   touch      the middleware that expires or extends, on every request
 *   snapshot   what is left, for the browser's countdown to read
 *   isExempt   the requests that must NOT count as activity
 */

const config = require('../config');

/**
 * Requests that keep a session alive without a person being there.
 *
 * The status endpoint is polled by the countdown, and a poll that renewed the
 * session would make the timeout unreachable: the tab would hold the session
 * open all weekend by asking every thirty seconds whether it was still open.
 * So it reads and never writes.
 *
 * `/session/extend` is deliberately absent from this list — that one is a
 * person pressing a button, which is exactly what activity means.
 */
const EXEMPT_PATHS = new Set(['/session/status']);

function isExempt(req) {
  return EXEMPT_PATHS.has(req.path);
}

/** Milliseconds since this session was last used, or null if never marked. */
function idleFor(session) {
  const seen = session && session.lastSeen;
  return typeof seen === 'number' ? Date.now() - seen : null;
}

/**
 * Mark a session as active now.
 *
 * Called on sign-in as well as from the middleware, so the first page after
 * signing in starts a full window rather than inheriting whatever the
 * pre-login session happened to hold.
 */
function markActive(session) {
  if (session) session.lastSeen = Date.now();
}

/**
 * Expire an idle session, and extend one that is being used.
 *
 * Runs before `auth.loadUser`, so a session destroyed here is simply a request
 * with no `userId` by the time anything looks: `requireAuth` redirects it to
 * the sign-in page and every route behind it is unreachable, with no separate
 * "is it expired" check to remember anywhere else.
 *
 * `req.idleSignOut` survives the destroy so the sign-in page can say why they
 * are looking at it, rather than appearing to have forgotten them.
 */
function touch(req, res, next) {
  if (!req.session || !req.session.userId) return next();

  const idle = idleFor(req.session);

  if (idle !== null && idle >= config.session.idleMs) {
    return req.session.destroy((err) => {
      if (err) return next(err);
      req.idleSignOut = true;
      next();
    });
  }

  /*
   * A poll may not renew the session, but it must not be treated as an
   * expiry either — the session is left exactly as the last real request
   * left it, and the countdown reads a shrinking number.
   */
  if (!isExempt(req)) markActive(req.session);

  next();
}

/**
 * What the browser needs to run its countdown.
 *
 * `idleMs` and `warnMs` come from configuration rather than being repeated in
 * the script, so changing SESSION_IDLE_MINUTES changes the warning, the
 * countdown and the server's own patience together — there is one number and
 * the page is told what it is.
 */
function snapshot(req) {
  const signedIn = !!(req.session && req.session.userId);
  const idle = idleFor(req.session);

  const remaining = !signedIn
    ? 0
    : Math.max(0, config.session.idleMs - (idle === null ? 0 : idle));

  return {
    signedIn,
    remainingMs: remaining,
    idleMs: config.session.idleMs,
    warnMs: config.session.warnMs
  };
}

/**
 * Keep signed-in pages out of the browser's cache.
 *
 * Without this the timeout is honest and the Back button still isn't: the
 * browser re-shows the last family it rendered, straight from its own cache,
 * without asking this server anything — names, telephone numbers and addresses
 * on screen for whoever sat down next, after the session behind them was
 * destroyed.
 *
 * `no-store` is the part that does the work. It also takes the page out of the
 * back/forward cache in every current browser, which is the other half of the
 * same problem: bfcache restores a live page, script state and all, without a
 * request being made at all. `Pragma` and `Expires` are there for proxies old
 * enough not to read Cache-Control.
 *
 * Photographs are exempt. They are served with a 7-day max-age on purpose and
 * are already guarded by the church check in app.js; a directory that re-fetched
 * every face on every page would be unusable over a parish's connection.
 */
function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
}

module.exports = { touch, snapshot, markActive, noStore, isExempt };
