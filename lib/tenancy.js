'use strict';

const createError = require('http-errors');
const auth = require('./auth');
const Churches = require('../models/church');

/**
 * Which church is this request about?
 *
 * Everyone except a super administrator belongs to exactly one church, and it
 * is the one on their account. A super administrator belongs to none, so to
 * use the ordinary screens they must be *acting as* a church, chosen in the
 * console and remembered in their session.
 *
 * The distinction the rest of the app relies on:
 *
 *   req.churchId  the church whose data this request may touch, or null
 *   req.church    that church's row, for the header, or null
 *   req.actingAs  set only when a super administrator has borrowed a church
 *
 * `req.churchId` is meant to be passed into a WHERE clause, never compared
 * against a row after it has been fetched. Scoping in the query means a church
 * administrator asking for another church's family gets nothing back, rather
 * than getting the row and relying on somebody having remembered to check it.
 */

const ACTING_KEY = 'actingChurchId';

async function resolveChurch(req, res, next) {
  req.churchId = null;
  req.church = null;
  req.actingAs = false;
  res.locals.church = null;
  res.locals.churchId = null;
  res.locals.actingAs = false;
  res.locals.isSuperAdmin = false;

  if (!req.user) return next();

  try {
    if (auth.isSuperAdmin(req.user)) {
      res.locals.isSuperAdmin = true;

      const actingId = req.session && req.session[ACTING_KEY];
      if (actingId) {
        const church = await Churches.findChurch(actingId);
        // The church may have been deleted since they picked it.
        if (church) {
          req.churchId = church.id;
          req.church = church;
          req.actingAs = true;
          res.locals.church = church;
          res.locals.churchId = church.id;
          res.locals.actingAs = true;
        } else {
          delete req.session[ACTING_KEY];
        }
      }
      return next();
    }

    // Everyone else is fixed to the church on their account.
    if (req.user.church_id) {
      const church = await Churches.findChurch(req.user.church_id);

      // A church that has been deactivated takes its people with it, rather
      // than leaving them signed in to something the console says is closed.
      if (!church || !church.is_active) {
        req.user = null;
        res.locals.currentUser = null;
        return req.session.destroy(() => next());
      }

      req.churchId = church.id;
      req.church = church;
      res.locals.church = church;
      res.locals.churchId = church.id;
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Refuse a request that has no church to act on.
 *
 * For a super administrator this is not an error but a missing choice, so they
 * are sent to pick one instead of being shown a refusal.
 */
function requireChurch(req, res, next) {
  if (req.churchId) return next();

  if (auth.isSuperAdmin(req.user)) {
    if (req.method === 'GET' && req.accepts('html')) {
      req.session.returnTo = req.originalUrl;
    }
    return res.redirect('/super/churches?pick=1');
  }

  // A staff account with no church is a broken row, not a normal state.
  return next(createError(403, 'Your account is not attached to a church.'));
}

function requireSuperAdmin(req, res, next) {
  if (auth.isSuperAdmin(req.user)) return next();
  return next(createError(403, 'You do not have permission to do that.'));
}

/** Start acting as a church, or stop. */
function actAs(req, churchId) {
  req.session[ACTING_KEY] = Number(churchId);
}

function stopActing(req) {
  delete req.session[ACTING_KEY];
}

module.exports = {
  ACTING_KEY,
  resolveChurch,
  requireChurch,
  requireSuperAdmin,
  actAs,
  stopActing
};
