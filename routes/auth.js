'use strict';

const express = require('express');
const db = require('../db');
const Users = require('../models/user');
const Family = require('../models/family');
const Churches = require('../models/church');
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

  await db.sequelize.transaction(async (transaction) => {
    await db.User.create({
      username: form.username,
      password_hash: hash,
      full_name: form.full_name,
      role: 'admin',
      created_at: db.now()
    }, { transaction });

    if (form.parish_name) {
      await db.Setting.upsert({ key: 'parish_name', value: form.parish_name }, { transaction });
    }
  });

  require('../lib/settings').invalidate();

  const user = await Users.findByUsername(form.username);
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

  const user = await Users.findByUsername(username);

  // Same message either way, so the form never reveals which usernames exist.
  if (!user || !user.is_active || !(await auth.verifyPassword(password, user.password_hash))) {
    recordFailure(key);
    return fail('That username and password did not match.');
  }

  attempts.delete(key);
  await Users.recordLogin(user.id);

  const returnTo = req.session.returnTo;
  await startSession(req, user);

  // Only ever bounce back to a path on this site.
  res.redirect(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
}));

// ---------------------------------------------------------------------------
// Signing in with a Family ID and a PIN
//
// No family is excluded for want of an email address. A household that has one
// signs in with it above; a household that has not signs in here, with the
// Family ID the parish has always used and the short PIN printed on the
// verification slip handed to it. No email address is involved at any step.
//
// The parish is asked for because a Family ID is the parish's own numbering
// and is unique inside it and nowhere else — two parishes may both number a
// family 0001, and neither may see the other's records.
// ---------------------------------------------------------------------------

async function parishOptions() {
  const churches = await Churches.listChurches({});
  return churches.filter((c) => c.is_active);
}

function renderFamilyLogin(res, status, locals) {
  return res.status(status).render('auth/family-login', {
    title: 'Family sign in',
    family_ref: '',
    church_id: '',
    error: null,
    ...locals
  });
}

router.get('/family-login', wrap(async (req, res) => {
  if (req.user) return res.redirect('/');

  const churches = await parishOptions();
  return renderFamilyLogin(res, 200, {
    churches,
    church_id: churches.length === 1 ? String(churches[0].id) : String(req.query.church || '')
  });
}));

router.post('/family-login', wrap(async (req, res) => {
  const churchId = Number(req.body.church_id);
  const familyRef = String(req.body.family_ref || '').trim();
  const pin = String(req.body.pin || '');
  const churches = await parishOptions();

  const key = attemptKey(req, `${churchId}:${familyRef}`);
  const fail = (error, status = 401) => renderFamilyLogin(res, status, {
    churches,
    family_ref: familyRef,
    church_id: req.body.church_id || '',
    error
  });

  if (isLockedOut(key)) {
    return fail('Too many failed attempts. Please wait 15 minutes and try again.', 429);
  }
  if (!Number.isInteger(churchId) || !familyRef || !pin) {
    return fail('Choose your parish, and enter your Family ID and PIN.', 400);
  }
  if (!churches.some((c) => c.id === churchId)) {
    return fail('That parish is not open for sign-in.', 400);
  }

  const family = await Family.findByRef(churchId, familyRef);
  const user = family ? await Users.findByFamily(family.id) : null;

  /*
   * One message for every kind of failure. A form that said "no such Family
   * ID" would confirm which numbers a parish uses to anybody who asked, and
   * the Family ID is printed on the front of every entry in the book.
   */
  if (!user || !user.is_active || user.role !== 'family' ||
      !(await auth.verifyPassword(pin, user.password_hash))) {
    recordFailure(key);
    return fail('That Family ID and PIN did not match.');
  }

  attempts.delete(key);
  await Users.recordLogin(user.id);
  await startSession(req, user);

  res.redirect(`/families/${family.id}`);
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
  await Users.setFullName(req.user.id, fullName);
  req.user.full_name = fullName;

  const { current_password: current, password, password_confirm: confirm } = req.body;

  if (!password && !confirm) {
    return render({ notice: 'Your name has been updated.' });
  }

  const stored = await Users.findById(req.user.id);
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

  // Choosing your own password is what clears the "still on the default"
  // banner — so it can only go away by actually being fixed.
  await Users.setPassword(req.user.id, await auth.hashPassword(password));
  req.user.on_default_password = 0;

  render({ notice: 'Your password has been changed.' });
}));

module.exports = router;
