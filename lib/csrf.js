'use strict';

const crypto = require('crypto');

/**
 * Per-session CSRF token. Every state-changing form posts it back in a hidden
 * `_csrf` field; `res.locals.csrfToken` makes it available to all views.
 */

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function csrf(req, res, next) {
  if (!req.session) return next();

  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const submitted =
    (req.body && req.body._csrf) ||
    req.get('x-csrf-token') ||
    '';

  if (timingSafeEqual(submitted, req.session.csrfToken)) return next();

  const err = new Error('This form has expired. Please go back and try again.');
  err.status = 403;
  next(err);
}

module.exports = csrf;
