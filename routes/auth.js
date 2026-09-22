'use strict';

const express = require('express');
const db = require('../db');
const Users = require('../models/user');
const Family = require('../models/family');
const Churches = require('../models/church');
const auth = require('../lib/auth');
const guard = require('../lib/login-guard');
const idle = require('../lib/idle');
const wrap = require('../lib/async');

const router = express.Router();

/** Regenerate the session on sign-in so a pre-login session ID can't be reused. */
function startSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = user.id;
      // Start the idle window here. Without this the first page after signing
      // in has no `lastSeen`, and lib/idle.js would be measuring from whenever
      // the request after it happened to arrive.
      idle.markActive(req.session);
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

  /*
   * `?timeout=1` is set by whatever noticed the expiry — lib/auth.js on a
   * blocked request, or the countdown in the browser when it ran out with the
   * page still open. Saying so is the difference between a directory that
   * signs you out for safety and one that appears to have lost your session.
   */
  res.render('auth/login', {
    title: 'Sign in',
    username: '',
    error: null,
    notice: req.query.timeout
      ? 'You were signed out because the directory was left idle. Please sign in again.'
      : null
  });
}));

/**
 * Sign in.
 *
 * The order of what follows is the security of it, so it is worth reading as a
 * sequence rather than as steps. The blocked address is turned away before any
 * password is verified, because verification is a deliberately slow bcrypt
 * comparison and running it for a known attacker is doing their work for them.
 * The wait is then served *before* the answer and whatever the answer turns out
 * to be — a delay applied only to failures would time the difference between a
 * username that exists and one that does not, which is the very thing the
 * single error message below exists to hide.
 */
router.post('/login', wrap(async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';

  const fail = (error, status = 401) =>
    res.status(status).render('auth/login', { title: 'Sign in', username, error, notice: null });

  const until = await guard.blockedUntil(req);
  if (until) {
    await guard.record(req, {
      kind: 'staff', identifier: username, success: false, reason: guard.REASONS.BLOCKED
    });
    return fail(
      'Too many failed sign-ins have come from this connection. Please try again later.',
      429
    );
  }

  await guard.sleep(await guard.delayFor('staff', username), req);

  const user = await Users.findByUsername(username);
  const reason = !user
    ? guard.REASONS.NO_SUCH_USER
    : !user.is_active
      ? guard.REASONS.INACTIVE
      : !(await auth.verifyPassword(password, user.password_hash))
        ? guard.REASONS.BAD_PASSWORD
        : guard.REASONS.OK;

  // Same message either way, so the form never reveals which usernames exist.
  // The reason above is for the log, which nobody signing in ever sees.
  if (reason !== guard.REASONS.OK) {
    await guard.record(req, {
      kind: 'staff',
      identifier: username,
      success: false,
      reason,
      userId: user ? user.id : null,
      churchId: user ? user.church_id : null
    });
    await guard.noteRepeatedFailures(req, {
      kind: 'staff',
      identifier: username,
      failures: await guard.failuresSinceSuccess('staff', username),
      churchId: user ? user.church_id : null
    });
    return fail('That username and password did not match.');
  }

  await guard.record(req, {
    kind: 'staff',
    identifier: username,
    success: true,
    reason: guard.REASONS.OK,
    userId: user.id,
    churchId: user.church_id
  });
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

  // Counted as parish-and-Family-ID together: a family numbered 0147 in one
  // parish is a different household from 0147 in the next, and the two must
  // not share a counter.
  const who = `${churchId}:${familyRef}`;

  const fail = (error, status = 401) => renderFamilyLogin(res, status, {
    churches,
    family_ref: familyRef,
    church_id: req.body.church_id || '',
    error
  });

  const until = await guard.blockedUntil(req);
  if (until) {
    await guard.record(req, {
      kind: 'family', identifier: who, success: false, reason: guard.REASONS.BLOCKED
    });
    return fail(
      'Too many failed sign-ins have come from this connection. Please try again later.',
      429
    );
  }

  /*
   * A malformed submission is logged and refused, but without the wait. It is
   * the form not being filled in rather than a credential being guessed, and
   * making a household that forgot to choose its parish sit through a growing
   * delay teaches it nothing.
   */
  if (!Number.isInteger(churchId) || !familyRef || !pin) {
    await guard.record(req, {
      kind: 'family', identifier: who, success: false, reason: guard.REASONS.MALFORMED
    });
    return fail('Choose your parish, and enter your Family ID and PIN.', 400);
  }
  if (!churches.some((c) => c.id === churchId)) {
    await guard.record(req, {
      kind: 'family', identifier: who, success: false, reason: guard.REASONS.MALFORMED
    });
    return fail('That parish is not open for sign-in.', 400);
  }

  await guard.sleep(await guard.delayFor('family', who), req);

  const family = await Family.findByRef(churchId, familyRef);
  const user = family ? await Users.findByFamily(family.id) : null;

  const reason = !user || user.role !== 'family'
    ? guard.REASONS.NO_SUCH_USER
    : !user.is_active
      ? guard.REASONS.INACTIVE
      : !(await auth.verifyPassword(pin, user.password_hash))
        ? guard.REASONS.BAD_PASSWORD
        : guard.REASONS.OK;

  /*
   * One message for every kind of failure. A form that said "no such Family
   * ID" would confirm which numbers a parish uses to anybody who asked, and
   * the Family ID is printed on the front of every entry in the book. The
   * reason above separates them for the log and nowhere else.
   */
  if (reason !== guard.REASONS.OK) {
    await guard.record(req, {
      kind: 'family',
      identifier: who,
      success: false,
      reason,
      userId: user ? user.id : null,
      churchId
    });
    await guard.noteRepeatedFailures(req, {
      kind: 'family',
      identifier: who,
      failures: await guard.failuresSinceSuccess('family', who),
      churchId
    });
    return fail('That Family ID and PIN did not match.');
  }

  await guard.record(req, {
    kind: 'family',
    identifier: who,
    success: true,
    reason: guard.REASONS.OK,
    userId: user.id,
    churchId
  });
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
      error: 'Your current password is incorrect.',
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
