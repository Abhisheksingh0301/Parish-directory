'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const auth = require('../lib/auth');
const settings = require('../lib/settings');
const wrap = require('../lib/async');

const router = express.Router();

router.use(auth.requireRole('admin'));

// ---------------------------------------------------------------------------
// Parish settings — the knobs that make this install "this church's" copy
// ---------------------------------------------------------------------------

const COLOR_KEYS = ['color_band', 'color_band_dark', 'color_member_a', 'color_member_b', 'color_rule'];

router.get('/settings', wrap(async (req, res) => {
  res.render('admin/settings', {
    title: 'Parish settings',
    values: await settings.load(),
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

  const updates = {
    parish_name: text(req.body.parish_name),
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
    const current = await settings.load();
    return res.status(400).render('admin/settings', {
      title: 'Parish settings',
      values: { ...current, ...req.body },
      colorKeys: COLOR_KEYS,
      errors,
      notice: null
    });
  }

  await settings.save(updates);

  res.render('admin/settings', {
    title: 'Parish settings',
    values: await settings.load(),
    colorKeys: COLOR_KEYS,
    errors: [],
    notice: 'Settings saved.'
  });
}));

router.post('/settings/reset-colors', wrap(async (req, res) => {
  const defaults = Object.fromEntries(
    COLOR_KEYS.map((key) => [key, db.DEFAULT_SETTINGS[key]])
  );
  await settings.save(defaults);
  res.redirect('/admin/settings');
}));

// ---------------------------------------------------------------------------
// User accounts
// ---------------------------------------------------------------------------

function listUsers() {
  return db.all(
    `SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.created_at,
            u.last_login_at, u.family_id, u.on_default_password,
            f.family_id AS family_ref, f.head_name AS family_head
     FROM users u
     LEFT JOIN families f ON f.id = u.family_id
     ORDER BY u.role, u.username COLLATE NOCASE`
  );
}

async function renderUsers(res, extra = {}) {
  res.render('admin/users', {
    title: 'User accounts',
    users: await listUsers(),
    // Family logins are made from the family, not typed in here.
    roles: auth.STAFF_ROLE_LIST,
    allRoles: auth.ROLES,
    defaultPassword: config.defaultUserPassword,
    error: null,
    notice: null,
    form: {},
    ...extra
  });
}

router.get('/users', wrap(async (req, res) => renderUsers(res)));

router.post('/users', wrap(async (req, res) => {
  const form = {
    username: (req.body.username || '').trim(),
    full_name: (req.body.full_name || '').trim(),
    role: req.body.role
  };

  const fail = (error) => {
    res.status(400);
    return renderUsers(res, { error, form });
  };

  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(form.username)) {
    return fail('Username may use letters, numbers, dot, dash and underscore (3–40 characters).');
  }
  if (!auth.ROLES[form.role] || auth.ROLES[form.role].familyLogin) {
    return fail('Choose a role. Family logins are created from the families list.');
  }

  const passwordError = auth.validatePassword(req.body.password, req.body.password_confirm);
  if (passwordError) return fail(passwordError);

  if (await db.get('SELECT id FROM users WHERE username = ?', [form.username])) {
    return fail(`The username "${form.username}" is already taken.`);
  }

  await db.run(
    'INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
    [form.username, await auth.hashPassword(req.body.password), form.full_name, form.role]
  );

  return renderUsers(res, { notice: `Account created for ${form.username}.` });
}));

/**
 * The last active administrator must not be able to demote, deactivate or
 * delete themselves out of the only account that can manage this install.
 */
async function wouldOrphanAdmins(userId) {
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?`,
    [userId]
  );
  return row.n === 0;
}

router.post('/users/:id(\\d+)/role', wrap(async (req, res, next) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return next();

  const role = req.body.role;
  if (!auth.ROLES[role] || auth.ROLES[role].familyLogin) {
    res.status(400);
    return renderUsers(res, { error: 'Choose a valid role.' });
  }

  // A family login is defined by the family it belongs to; promoting it would
  // hand one household the whole directory.
  if (user.family_id) {
    res.status(400);
    return renderUsers(res, {
      error: `${user.username} is a family login — its role cannot be changed here.`
    });
  }

  if (user.role === 'admin' && role !== 'admin' && (await wouldOrphanAdmins(user.id))) {
    res.status(400);
    return renderUsers(res, { error: 'This is the only administrator — promote someone else first.' });
  }

  await db.run('UPDATE users SET role = ? WHERE id = ?', [role, user.id]);
  return renderUsers(res, { notice: `${user.username} is now a ${auth.ROLES[role].label}.` });
}));

router.post('/users/:id(\\d+)/active', wrap(async (req, res, next) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return next();

  const activate = req.body.is_active === '1';

  if (!activate && user.role === 'admin' && (await wouldOrphanAdmins(user.id))) {
    res.status(400);
    return renderUsers(res, { error: 'This is the only administrator — they cannot be deactivated.' });
  }

  await db.run('UPDATE users SET is_active = ? WHERE id = ?', [activate ? 1 : 0, user.id]);

  // Deactivating someone should log them out everywhere, not at their leisure.
  if (!activate) {
    await db.run(`DELETE FROM sessions WHERE data LIKE ?`, [`%"userId":${user.id}%`]);
  }

  return renderUsers(res, {
    notice: `${user.username} has been ${activate ? 'reactivated' : 'deactivated'}.`
  });
}));

router.post('/users/:id(\\d+)/password', wrap(async (req, res, next) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return next();

  const passwordError = auth.validatePassword(req.body.password, req.body.password_confirm);
  if (passwordError) {
    res.status(400);
    return renderUsers(res, { error: `${user.username}: ${passwordError}` });
  }

  await db.run(
    'UPDATE users SET password_hash = ?, on_default_password = 0 WHERE id = ?',
    [await auth.hashPassword(req.body.password), user.id]
  );

  return renderUsers(res, { notice: `Password reset for ${user.username}.` });
}));

router.post('/users/:id(\\d+)/delete', wrap(async (req, res, next) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return next();

  if (user.id === req.user.id) {
    res.status(400);
    return renderUsers(res, { error: 'You cannot delete your own account.' });
  }
  if (user.role === 'admin' && (await wouldOrphanAdmins(user.id))) {
    res.status(400);
    return renderUsers(res, { error: 'This is the only administrator — they cannot be deleted.' });
  }

  await db.run('DELETE FROM users WHERE id = ?', [user.id]);
  await db.run(`DELETE FROM sessions WHERE data LIKE ?`, [`%"userId":${user.id}%`]);

  return renderUsers(res, { notice: `${user.username}'s account has been deleted.` });
}));

module.exports = router;
