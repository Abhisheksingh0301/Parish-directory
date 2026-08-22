'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const Users = require('../models/user');
const Family = require('../models/family');
const auth = require('../lib/auth');
const tenancy = require('../lib/tenancy');
const settings = require('../lib/settings');
const audit = require('../lib/audit');
const verification = require('../lib/verification');
const exporter = require('../lib/export');
const importColumns = require('../lib/import-columns');
const importTemplate = require('../lib/import-template');
const { slugify } = require('../lib/slug');
const wrap = require('../lib/async');

const router = express.Router();

router.use(auth.requireRole('admin'));
// Settings and accounts belong to one church, so there has to be one.
router.use(tenancy.requireChurch);

// ---------------------------------------------------------------------------
// Parish settings — the knobs that make this install "this church's" copy
// ---------------------------------------------------------------------------

const COLOR_KEYS = ['color_band', 'color_band_dark', 'color_member_a', 'color_member_b', 'color_rule'];

/** Everything the settings page needs beyond the stored values themselves. */
function settingsLocals() {
  return {
    colorKeys: COLOR_KEYS,
    // The field list is a parish setting rather than something fixed in the
    // code, so moving a field from one tier to the other is something the
    // parish does itself.
    tierableFields: verification.TIERABLE_FIELDS,
    tiers: verification.TIERS,
    neverEditable: verification.NEVER_EDITABLE
  };
}

router.get('/settings', wrap(async (req, res) => {
  res.render('admin/settings', {
    title: 'Parish settings',
    values: await settings.load(req.churchId),
    ...settingsLocals(),
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

  /*
   * Which fields are routine, kept as the parish typed them but filtered to
   * fields that actually exist. A misspelling silently promoting a field to
   * "significant" would be a change nobody could see on this page.
   */
  const known = new Set(verification.TIERABLE_FIELDS.map((f) => f.key));
  const routine = [].concat(req.body.routine_fields || [])
    .map((key) => String(key).trim().toLowerCase())
    .filter((key) => known.has(key));

  const updates = {
    parish_name: text(req.body.parish_name),
    default_member_password: memberPassword,
    directory_title: text(req.body.directory_title) || 'Parish Directory',
    relation_options: text(req.body.relation_options),
    approval_tiers: req.body.approval_tiers === '2' ? '2' : '1',
    routine_fields: routine.join(', '),
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
      values: { ...current, ...req.body, routine_fields: routine.join(', ') },
      ...settingsLocals(),
      errors,
      notice: null
    });
  }

  await settings.save(req.churchId, updates);

  res.render('admin/settings', {
    title: 'Parish settings',
    values: await settings.load(req.churchId),
    ...settingsLocals(),
    errors: [],
    notice: 'Settings saved.'
  });
}));

// ---------------------------------------------------------------------------
// The audit log, as this parish reads it
// ---------------------------------------------------------------------------

/**
 * What happened to us, and who did it.
 *
 * The same log the console shows, narrowed to this church in the query rather
 * than filtered afterwards — a parish administrator cannot read another
 * parish's history by removing the filter, because there is no query here that
 * reaches one.
 *
 * There is no screen anywhere in this application that edits or deletes a log
 * line, and this page is deliberately not the exception.
 */
const AUDIT_EVENTS = [
  { value: '', label: 'Everything' },
  { value: 'family.submitted', label: 'Changes submitted' },
  { value: 'family.approved', label: 'Changes approved' },
  { value: 'family.rejected', label: 'Changes rejected' },
  { value: 'family.invited', label: 'Invitations marked sent' },
  { value: 'family.pin_issued', label: 'Verification slips issued' },
  { value: 'family.printed', label: 'Marked as printed' },
  { value: 'family.imported', label: 'Data imported' },
  { value: 'export', label: 'Exports' },
  { value: 'church', label: 'Parish structure' }
];

router.get('/audit', wrap(async (req, res) => {
  const action = AUDIT_EVENTS.some((e) => e.value && e.value === req.query.action)
    ? String(req.query.action)
    : '';

  res.render('admin/audit', {
    title: 'Audit log',
    entries: await audit.list({ churchId: req.churchId, action, limit: 400 }),
    events: AUDIT_EVENTS,
    action
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
// Taking the parish's own data out
// ---------------------------------------------------------------------------

/**
 * A church's copy of its own directory.
 *
 * The console has been able to export across churches since reports were
 * added; a parish had no way to get its own records out at all, which is the
 * wrong way round — the data is theirs, and "may we have a copy?" should not
 * have to go through whoever runs the server.
 *
 * Two forms, and the only difference is the photographs:
 *
 *   export.csv   the spreadsheet — opened in Excel, mailed to whoever asked
 *   export.zip   the same spreadsheet and every photograph, each named after
 *                the family it belongs to, which is what a printer or another
 *                system actually needs
 *
 * Drafts are included by default: they are the parish's own unfinished
 * entries, and an export that quietly dropped them would be a backup with
 * holes in it. `?drafts=0` leaves them out, for the copy that goes to a
 * printer rather than into a filing cabinet.
 *
 * Admin only, like the rest of this router. An export is every address and
 * telephone number in the parish in one file, which is a different thing from
 * being able to read them a page at a time.
 */

/** The download's name: the parish, and the day it was taken. */
function downloadName(church, extension) {
  const day = new Date().toISOString().slice(0, 10);
  return `${slugify(church.name, 'parish')}-${day}.${extension}`;
}

router.get('/export', wrap(async (req, res) => {
  const [stats, photos] = await Promise.all([
    Family.stats(req.churchId),
    Family.photoCount(req.churchId)
  ]);

  res.render('admin/export', {
    title: 'Download your data',
    stats,
    photos
  });
}));

router.get('/export.csv', wrap(async (req, res) => {
  const includeDrafts = req.query.drafts !== '0';

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName(req.church, 'csv')}"`);
  // A parish's whole address book. Nothing between here and the browser has
  // any business keeping a copy.
  res.setHeader('Cache-Control', 'no-store');

  await audit.record(req, 'export.csv', {
    churchId: req.churchId,
    detail: `${req.church.name}${includeDrafts ? '' : ', printed entries only'}`
  });

  await exporter.writeRows(exporter.streamTo(res), [req.churchId], {
    labels: res.locals.labels,
    includeDrafts
  });
  res.end();
}));

router.get('/export.zip', wrap(async (req, res) => {
  const includeDrafts = req.query.drafts !== '0';

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName(req.church, 'zip')}"`);
  res.setHeader('Cache-Control', 'no-store');

  await audit.record(req, 'export.bundle', {
    churchId: req.churchId,
    detail: `${req.church.name}, with photographs${includeDrafts ? '' : ', printed entries only'}`
  });

  const result = await exporter.bundle(res, [req.churchId], {
    labels: res.locals.labels,
    label: req.church.name,
    includeDrafts
  });
  res.end();

  // A photograph on record but not on disk means a file was lost behind the
  // application's back. The export still completed, so this is a note for
  // whoever reads the logs, not an error for the person downloading.
  if (result.missing) {
    console.warn(
      `Export of ${req.church.name}: ${result.missing} photograph(s) on record were not on disk.`
    );
  }
}));

// ---------------------------------------------------------------------------
// The other direction — the sheet a parish fills in before importing
// ---------------------------------------------------------------------------

/*
 * Loading a parish's existing families is `npm run import-families`, run at
 * the command line by whoever installed this. That is deliberate: several
 * hundred families arriving at once is not something to do from a web form on
 * a first attempt, and the dry run and rejects file are what make it safe.
 *
 * But the parish office, not the installer, is the one who has to produce the
 * spreadsheet — and it had nothing to produce it from. So the sheet itself is
 * downloadable here, in the church's own login, with the columns and the rules
 * on the page beside it. The office fills it in and hands it over; the import
 * is still a deliberate, supervised step.
 */

router.get('/import', wrap(async (req, res) => {
  res.render('admin/import', {
    title: 'Import members from a spreadsheet',
    fields: importColumns.FIELDS,
    // Not `labels`: that name already belongs to the diocese/zone vocabulary
    // every view is given.
    columnLabels: importColumns.LABELS,
    aliases: importColumns.COLUMNS,
    required: importColumns.REQUIRED,
    relations: settings.relationOptions(req.settings)
  });
}));

router.get('/import-template.csv', wrap(async (req, res) => {
  // Headings only, for a parish that would rather not delete somebody else's
  // examples out of its own sheet before starting.
  const withExamples = req.query.examples !== '0';

  const name = `${slugify(req.church.name, 'parish')}-members-template.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);

  res.send(importTemplate.build({
    relations: settings.relationOptions(req.settings),
    withExamples
  }));
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
