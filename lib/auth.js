'use strict';

const bcrypt = require('bcryptjs');
const db = require('../db');

const BCRYPT_ROUNDS = 12;

/**
 * Three roles, most to least privileged. A role inherits everything the roles
 * below it can do, so `atLeast` is a simple rank comparison.
 */
const ROLES = {
  admin: {
    rank: 3,
    label: 'Administrator',
    blurb: 'Full access, including parish settings and user accounts.'
  },
  editor: {
    rank: 2,
    label: 'Editor',
    blurb: 'Can add, edit and remove families. Cannot manage users or settings.'
  },
  viewer: {
    rank: 1,
    label: 'Viewer',
    blurb: 'Can browse and print the directory. Cannot change anything.'
  }
};

const ROLE_LIST = Object.entries(ROLES).map(([value, meta]) => ({ value, ...meta }));

function rankOf(role) {
  return ROLES[role] ? ROLES[role].rank : 0;
}

function atLeast(user, role) {
  return !!user && rankOf(user.role) >= rankOf(role);
}

function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

/**
 * Password rules kept deliberately mild — these accounts belong to parish
 * volunteers, and rules that are too strict just produce sticky notes.
 */
function validatePassword(password, confirm) {
  if (!password || password.length < 8) {
    return 'Password must be at least 8 characters.';
  }
  if (password.length > 200) {
    return 'Password is too long.';
  }
  if (confirm !== undefined && password !== confirm) {
    return 'The two passwords do not match.';
  }
  return null;
}

async function countUsers() {
  const row = await db.get('SELECT COUNT(*) AS n FROM users');
  return row ? row.n : 0;
}

/** Load the signed-in user onto req.user and res.locals for every request. */
async function loadUser(req, res, next) {
  res.locals.currentUser = null;
  req.user = null;

  const userId = req.session && req.session.userId;
  if (!userId) return next();

  try {
    const user = await db.get(
      'SELECT id, username, full_name, role, is_active FROM users WHERE id = ?',
      [userId]
    );

    // A user deleted or deactivated mid-session loses access immediately.
    if (!user || !user.is_active) {
      return req.session.destroy(() => next());
    }

    req.user = user;
    res.locals.currentUser = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAuth(req, res, next) {
  if (req.user) return next();

  if (req.method === 'GET' && req.accepts('html')) {
    req.session.returnTo = req.originalUrl;
  }
  return res.redirect('/login');
}

/** Guard a route on a minimum role. */
function requireRole(role) {
  return function (req, res, next) {
    if (!req.user) return requireAuth(req, res, next);
    if (atLeast(req.user, role)) return next();

    res.status(403).render('error', {
      title: 'Not allowed',
      message: 'You do not have permission to do that.',
      error: {}
    });
  };
}

module.exports = {
  ROLES,
  ROLE_LIST,
  atLeast,
  hashPassword,
  verifyPassword,
  validatePassword,
  countUsers,
  loadUser,
  requireAuth,
  requireRole
};
