'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const Users = require('../models/user');
const auth = require('../lib/auth');
const tenancy = require('../lib/tenancy');
const settings = require('../lib/settings');
const wrap = require('../lib/async');

const router = express.Router();

router.use(auth.requireRole('admin'));
// Settings and accounts belong to one church, so there has to be one.
router.use(tenancy.requireChurch);

// ---------------------------------------------------------------------------
// Parish settings — the knobs that make this install "this church's" copy
// ---------------------------------------------------------------------------

const COLOR_KEYS = ['color_band', 'color_band_dark', 'color_member_a', 'color_member_b', 'color_rule'];

router.get('/settings', wrap(async (req, res) => {
  res.render('admin/settings', {
    title: 'Parish settings',
    values: await settings.load(req.churchId),
    colorKeys: COLOR_KEYS,
    errors: [],
    notice: null
  });
}));

router.post('/settings', wrap(async (req, res) => {
  const text = (v) => String(v ?? '').trim();
  const errors = [];

  const perPage = parseInt(req.body.per_page, 10);
  const startingPage = parseInt(req.body.starting_page, 10);

  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 6) {
    errors.push('Families per printed page must be between 1 and 6.');
  }
  if (!Number.isInteger(startingPage) || startingPage < 0) {
    errors.push('Starting page number must be 0 or more.');
  }
  if (!text(req.body.parish_name)) {
    errors.push('Parish name is required — it prints in the footer of every page.');
  }

  const memberPassword = text(req.body.default_member_password);
  if (memberPassword.length < 8) {
    errors.push('The member password must be at least 8 characters.');
  }

  const updates = {
    parish_name: text(req.body.parish_name),
    default_member_password: memberPassword,
    directory_title: text(req.body.directory_title) || 'Parish Directory',
    relation_options: text(req.body.relation_options),
    starting_page: String(startingPage),
    per_page: String(perPage)
  };

  for (const key of COLOR_KEYS) {
    const value = text(req.body[key]);
    if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
      errors.push(`${key.replace(/_/g, ' ')} must be a colour like #cec4b3.`);
    } else {
      updates[key] = value.toLowerCase();
    }
  }

  if (errors.length) {
    const current = await settings.load(req.churchId);
    return res.status(400).render('admin/settings', {
      title: 'Parish settings',
      values: { ...current, ...req.body },
      colorKeys: COLOR_KEYS,
      errors,
      notice: null
    });
  }

  await settings.save(req.churchId, updates);

  res.render('admin/settings', {
    title: 'Parish settings',
    values: await settings.load(req.churchId),
    colorKeys: COLOR_KEYS,
    errors: [],
    notice: 'Settings saved.'
  });
}));

router.post('/settings/reset-colors', wrap(async (req, res) => {
  const defaults = Object.fromEntries(
    COLOR_KEYS.map((key) => [key, db.DEFAULT_SETTINGS[key]])
  );
  await settings.save(req.churchId, defaults);
  res.redirect('/admin/settings');
}));

// ---------------------------------------------------------------------------
// User accounts
// ---------------------------------------------------------------------------

async function renderUsers(req, res, extra = {}) {
  res.render('admin/users', {
    title: 'User accounts',
    users: await Users.listWithFamilies(req.churchId),
    // Member logins are made from the family, not typed in here.
    roles: auth.STAFF_ROLE_LIST,
    allRoles: auth.ROLES,
    defaultPassword: req.settings.default_member_password,
    error: null,
    notice: null,
    form: {},
    ...extra
  });
}

router.get('/users', wrap(async (req, res) => renderUsers(req, res)));

router.post('/users', wrap(async (req, res) => {
  const form = {
    username: (req.body.username || '').trim(),
    full_name: (req.body.full_name || '').trim(),
    role: req.body.role
  };

  const fail = (error) => {
    res.status(400);
    return renderUsers(req, res, { error, form });
  };

  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(form.username)) {
    return fail('Username may use letters, numbers, dot, dash and underscore (3–40 characters).');
  }
  // Not a bare "is this a real role?" check: a super administrator is a real
  // role, and offering it here would let any church administrator create one
  // and reach every other church in the system.
  if (!auth.isAssignableByChurchAdmin(form.role)) {
    return fail('Choose a role. Member logins are created from the families list.');
  }

  const passwordError = auth.validatePassword(req.body.password, req.body.password_confirm);
  if (passwordError) return fail(passwordError);

  if (await Users.usernameTaken(form.username)) {
    return fail(`The username "${form.username}" is already taken.`);
  }

  await Users.create({
    username: form.username,
    password_hash: await auth.hashPassword(req.body.password),
    full_name: form.full_name,
    role: form.role,
    church_id: req.churchId
  });

  return renderUsers(req, res, { notice: `Account created for ${form.username}.` });
}));

// The last active administrator must not be able to demote, deactivate or
// delete themselves out of the only account that can manage this install —
// Users.wouldOrphanAdmins is what every one of the routes below asks first.

router.post('/users/:id(\\d+)/role', wrap(async (req, res, next) => {
  const user = await Users.findInChurch(req.churchId, req.params.id);
  if (!user) return next();

  const role = req.body.role;
  if (!auth.isAssignableByChurchAdmin(role)) {
    res.status(400);
    return renderUsers(req, res, { error: 'Choose a valid role.' });
  }

  // A member login is defined by the family it belongs to; promoting it would
  // hand one household the whole directory.
  if (user.family_id) {
    res.status(400);
    return renderUsers(req, res, {
      error: `${user.username} is a member login — its role cannot be changed here.`
    });
  }

  if (user.role === 'admin' && role !== 'admin' && (await Users.wouldOrphanAdmins(req.churchId, user.id))) {
    res.status(400);
    return renderUsers(req, res, { error: 'This is the only administrator — promote someone else first.' });
  }

  await Users.setRole(user.id, role);
  return renderUsers(req, res, { notice: `${user.username} is now a ${auth.ROLES[role].label}.` });
}));

router.post('/users/:id(\\d+)/active', wrap(async (req, res, next) => {
  const user = await Users.findInChurch(req.churchId, req.params.id);
  if (!user) return next();

  const activate = req.body.is_active === '1';

  if (!activate && user.role === 'admin' && (await Users.wouldOrphanAdmins(req.churchId, user.id))) {
    res.status(400);
    return renderUsers(req, res, { error: 'This is the only administrator — they cannot be deactivated.' });
  }

  await Users.setActive(user.id, activate);

  // Deactivating someone should log them out everywhere, not at their leisure.
  if (!activate) await Users.signOutEverywhere(user.id);

  return renderUsers(req, res, {
    notice: `${user.username} has been ${activate ? 'reactivated' : 'deactivated'}.`
  });
}));

router.post('/users/:id(\\d+)/password', wrap(async (req, res, next) => {
  const user = await Users.findInChurch(req.churchId, req.params.id);
  if (!user) return next();

  const passwordError = auth.validatePassword(req.body.password, req.body.password_confirm);
  if (passwordError) {
    res.status(400);
    return renderUsers(req, res, { error: `${user.username}: ${passwordError}` });
  }

  await Users.setPassword(user.id, await auth.hashPassword(req.body.password));

  return renderUsers(req, res, { notice: `Password reset for ${user.username}.` });
}));

router.post('/users/:id(\\d+)/delete', wrap(async (req, res, next) => {
  const user = await Users.findInChurch(req.churchId, req.params.id);
  if (!user) return next();

  if (user.id === req.user.id) {
    res.status(400);
    return renderUsers(req, res, { error: 'You cannot delete your own account.' });
  }
  if (user.role === 'admin' && (await Users.wouldOrphanAdmins(req.churchId, user.id))) {
    res.status(400);
    return renderUsers(req, res, { error: 'This is the only administrator — they cannot be deleted.' });
  }

  await Users.remove(user.id);
  await Users.signOutEverywhere(user.id);

  return renderUsers(req, res, { notice: `${user.username}'s account has been deleted.` });
}));

module.exports = router;
