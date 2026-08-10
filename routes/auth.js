'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const wrap = require('../lib/async');

const router = express.Router();

/**
 * A small in-memory throttle on failed sign-ins. A parish install is a single
 * process, so a Map is enough; it is not meant to survive a restart.
 */
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map();

function attemptKey(req, username) {
  return `${req.ip}|${String(username || '').toLowerCase()}`;
}

function isLockedOut(key) {
  const record = attempts.get(key);
  if (!record) return false;
  if (Date.now() - record.first > LOCKOUT_MS) {
    attempts.delete(key);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function recordFailure(key) {
  const record = attempts.get(key);
  if (!record || Date.now() - record.first > LOCKOUT_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
    return;
  }
  record.count += 1;
}

/** Regenerate the session on sign-in so a pre-login session ID can't be reused. */
function startSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

// ---------------------------------------------------------------------------
// First run — create the administrator account
// ---------------------------------------------------------------------------

const setupGuard = wrap(async (req, res, next) => {
  if ((await auth.countUsers()) > 0) return res.redirect('/login');
  next();
});

router.get('/setup', setupGuard, (req, res) => {
  res.render('auth/setup', { title: 'Set up this directory', form: {}, error: null });
});

router.post('/setup', setupGuard, wrap(async (req, res) => {
  const form = {
    full_name: (req.body.full_name || '').trim(),
    username: (req.body.username || '').trim(),
    parish_name: (req.body.parish_name || '').trim()
  };

  const fail = (error) =>
    res.status(400).render('auth/setup', { title: 'Set up this directory', form, error });

  if (!form.username) return fail('Choose a username.');
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(form.username)) {
    return fail('Username may use letters, numbers, dot, dash and underscore (3–40 characters).');
  }

  const passwordError = auth.validatePassword(req.body.password, req.body.password_confirm);
  if (passwordError) return fail(passwordError);

  const hash = await auth.hashPassword(req.body.password);

  await db.tx(async () => {
    await db.run(
      `INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, 'admin')`,
      [form.username, hash, form.full_name]
    );
    if (form.parish_name) {
      await db.run(
        `INSERT INTO settings (key, value) VALUES ('parish_name', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [form.parish_name]
      );
    }
  });

  require('../lib/settings').invalidate();

  const user = await db.get('SELECT * FROM users WHERE username = ?', [form.username]);
  await startSession(req, user);
  res.redirect('/');
}));

// ---------------------------------------------------------------------------
// Sign in / sign out
// ---------------------------------------------------------------------------

router.get('/login', wrap(async (req, res) => {
  if ((await auth.countUsers()) === 0) return res.redirect('/setup');
  if (req.user) return res.redirect('/');

  res.render('auth/login', { title: 'Sign in', username: '', error: null });
}));

router.post('/login', wrap(async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const key = attemptKey(req, username);

  const fail = (error, status = 401) =>
    res.status(status).render('auth/login', { title: 'Sign in', username, error });

  if (isLockedOut(key)) {
    return fail('Too many failed attempts. Please wait 15 minutes and try again.', 429);
  }

  const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);

  // Same message either way, so the form never reveals which usernames exist.
  if (!user || !user.is_active || !(await auth.verifyPassword(password, user.password_hash))) {
    recordFailure(key);
    return fail('That username and password did not match.');
  }

  attempts.delete(key);
  await db.run(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`, [user.id]);

  const returnTo = req.session.returnTo;
  await startSession(req, user);

  // Only ever bounce back to a path on this site.
  res.redirect(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('parish.sid');
    res.redirect('/login');
  });
});

// ---------------------------------------------------------------------------
// Own account
// ---------------------------------------------------------------------------

router.get('/account', auth.requireAuth, (req, res) => {
  res.render('auth/account', { title: 'My account', error: null, notice: null });
});

router.post('/account', auth.requireAuth, wrap(async (req, res) => {
  const render = (opts) => res.render('auth/account', { title: 'My account', error: null, notice: null, ...opts });

  const fullName = (req.body.full_name || '').trim();
  await db.run('UPDATE users SET full_name = ? WHERE id = ?', [fullName, req.user.id]);
  req.user.full_name = fullName;

  const { current_password: current, password, password_confirm: confirm } = req.body;

  if (!password && !confirm) {
    return render({ notice: 'Your name has been updated.' });
  }

  const stored = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!(await auth.verifyPassword(current || '', stored.password_hash))) {
    return res.status(400).render('auth/account', {
      title: 'My account',
      error: 'Your current password is not correct.',
      notice: null
    });
  }

  const passwordError = auth.validatePassword(password, confirm);
  if (passwordError) {
    return res.status(400).render('auth/account', { title: 'My account', error: passwordError, notice: null });
  }

  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [
    await auth.hashPassword(password),
    req.user.id
  ]);

  render({ notice: 'Your password has been changed.' });
}));

module.exports = router;
