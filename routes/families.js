'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const Family = require('../models/family');
const dayMonth = require('../lib/daymonth');
const relations = require('../lib/relations');
const emails = require('../lib/email');
const settings = require('../lib/settings');
const auth = require('../lib/auth');
const wrap = require('../lib/async');
const { removePhoto, maxBytes } = require('../lib/upload');

const router = express.Router();

const canEdit = auth.requireRole('editor');
const canBrowse = auth.requireRole('viewer');
const isAdmin = auth.requireRole('admin');

/** A family login has no business on the list — send it to its own entry. */
function familyLoginsGoHome(req, res, next) {
  if (auth.isFamilyLogin(req.user)) return res.redirect(`/families/${req.user.family_id}`);
  next();
}

/**
 * Guard an entry. Staff from `minRole` upwards reach any family; a family
 * login reaches only its own. `minRole` is 'viewer' to look and 'editor' to
 * change, so the same guard covers both directions.
 */
function allowOwnFamily(minRole) {
  return function (req, res, next) {
    if (auth.atLeast(req.user, minRole)) return next();
    if (auth.isFamilyLogin(req.user) && auth.ownsFamily(req.user, req.params.id)) return next();

    // A photo uploaded with a request we are about to refuse must not be left behind.
    if (req.file) removePhoto(req.file.filename);

    res.status(403).render('error', {
      title: 'Not allowed',
      message: 'You do not have permission to do that.',
      error: {}
    });
  };
}

// Photo uploads are parsed in app.js, before the CSRF check — by the time a
// handler here runs, req.file and req.photoError are already populated.

/**
 * A member's date of birth off the form. The picker sends one full date; a
 * member recorded before the year was collected sends the day and month it
 * already had on the "keep" checkbox instead, so editing the rest of that row
 * does not quietly throw the date away.
 */
function readDob(m, label) {
  if (String(m.dob ?? '').trim()) return dayMonth.parseISO(m.dob, label);

  const [day, month] = String(m.dob_partial ?? '').split('-');
  return { ...dayMonth.parse(day, month, label), year: null };
}

/** Pull a family (and its members) out of a submitted form. */
function readForm(req) {
  const text = (value) => String(value ?? '').trim();
  const errors = [];

  const dom = dayMonth.parse(req.body.dom_day, req.body.dom_month, 'Date of marriage');
  if (dom.error) errors.push(dom.error);

  // qs gives an array for members[0][...], an object if the indices are sparse.
  const rawMembers = Object.values(req.body.members || {});

  const members = rawMembers
    .filter((m) => m && text(m.name))
    .map((m, i) => {
      const dob = readDob(m, `Date of birth for "${text(m.name)}"`);
      if (dob.error) errors.push(dob.error);

      return {
        name: text(m.name),
        relation: text(m.relation),
        dob_day: dob.day,
        dob_month: dob.month,
        dob_year: dob.year,
        mobile: text(m.mobile),
        links: text(m.links),
        position: i
      };
    });

  // Only worth asking once every date on the form is a date: comparing ages
  // against numbers the member has already been told to fix helps nobody.
  if (!errors.length) errors.push(...relations.generationErrors(members));

  const data = {
    family_id: text(req.body.family_id),
    head_name: text(req.body.head_name),
    address: text(req.body.address),
    hometown: text(req.body.hometown),
    home_parish: text(req.body.home_parish),
    spouse_home: text(req.body.spouse_home),
    email: text(req.body.email),
    dom_day: dom.day,
    dom_month: dom.month,
    is_published: req.body.is_published === '1',
    members
  };

  if (!data.family_id) errors.push('Family ID is required.');
  if (!data.head_name) errors.push('Family head name is required.');
  if (!members.length) errors.push('Add at least one family member.');
  // The address becomes the family's login, so it is checked properly and the
  // reason is handed back rather than a flat "invalid".
  const badEmail = emails.problem(data.email);
  if (badEmail) errors.push(badEmail);
  if (req.photoError) errors.push(req.photoError);

  return { data, errors };
}

/** Today as "2026-08-11", in the parish's own timezone rather than UTC. */
function todayISO() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

async function formLocals(req, extra) {
  const parishSettings = await settings.load();
  return {
    months: dayMonth.MONTH_OPTIONS,
    // The date picker offers 1900 up to today — nobody in the directory was
    // born before that, and nobody is born tomorrow.
    earliestBirthDate: `${dayMonth.EARLIEST_BIRTH_YEAR}-01-01`,
    today: todayISO(),
    toISO: dayMonth.toISO,
    formatDayMonth: dayMonth.format,
    emailPattern: emails.HTML_PATTERN,
    relationOptions: settings.relationOptions(parishSettings),
    maxPhotoMb: Math.round(maxBytes / (1024 * 1024)),
    errors: [],
    // A household editing its own entry gets a shorter form: no family ID,
    // no draft switch, no delete.
    isOwnEntry: auth.isFamilyLogin(req.user),
    ...extra
  };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

router.get('/', familyLoginsGoHome, canBrowse, wrap(async (req, res) => {
  const search = String(req.query.q || '');
  const [families, allEmails, pendingLogins] = await Promise.all([
    Family.list({ search }),
    Family.emails(),
    Family.withoutLogins()
  ]);

  res.render('families/list', {
    title: 'Families',
    families: families.map((f) => ({ ...f, dom: dayMonth.format(f.dom_day, f.dom_month) })),
    search,
    canEdit: auth.atLeast(req.user, 'editor'),
    isAdmin: auth.atLeast(req.user, 'admin'),
    allEmails,
    pendingLoginCount: pendingLogins.length,
    defaultPassword: config.defaultUserPassword,
    notice: req.query.notice || null,
    error: req.query.error || null
  });
}));

// ---------------------------------------------------------------------------
// Family logins — one account per household, so a family can complete its own
// entry. Created with the shared default password, which the parish office
// sends out with the comma-separated address list from the page above.
// ---------------------------------------------------------------------------

/**
 * One bcrypt hash is computed per run and reused for every account created in
 * it. They all hold the same, deliberately public, default password, so a
 * salt each would buy nothing — and hashing 12 rounds per family would make
 * inviting a parish of 300 households take minutes.
 */
async function createLogins(families) {
  const hash = await auth.hashPassword(config.defaultUserPassword);
  const skipped = [];
  let created = 0;

  for (const family of families) {
    const username = String(family.email || '').trim();
    if (!username) {
      skipped.push(`${family.family_id} (${family.head_name}) has no email address`);
      continue;
    }
    if (await db.get('SELECT id FROM users WHERE username = ?', [username])) {
      skipped.push(`${username} is already a username`);
      continue;
    }

    await db.run(
      `INSERT INTO users
         (username, password_hash, full_name, role, family_id, on_default_password)
       VALUES (?, ?, ?, 'family', ?, 1)`,
      [username, hash, family.head_name, family.id]
    );
    created += 1;
  }

  return { created, skipped };
}

router.post('/logins', isAdmin, wrap(async (req, res) => {
  const pending = await Family.withoutLogins();

  if (!pending.length) {
    return res.redirect('/families?notice=' + encodeURIComponent(
      'Every family with an email address already has a login.'
    ));
  }

  const { created, skipped } = await createLogins(pending);

  const parts = [`Created ${created} family ${created === 1 ? 'login' : 'logins'}, ` +
                 `each with the default password.`];
  if (skipped.length) parts.push(`Skipped ${skipped.length}: ${skipped.join('; ')}.`);

  res.redirect('/families?notice=' + encodeURIComponent(parts.join(' ')));
}));

// ---------------------------------------------------------------------------
// New / create
// ---------------------------------------------------------------------------

router.get('/new', canEdit, wrap(async (req, res) => {
  const family = {
    family_id: await Family.nextFamilyId(),
    head_name: '',
    address: '',
    hometown: '',
    home_parish: '',
    spouse_home: '',
    email: '',
    photo: null,
    dom_day: null,
    dom_month: null,
    is_published: true,
    members: [
      { name: '', relation: 'HF', dob_day: null, dob_month: null, dob_year: null, mobile: '', links: '' }
    ]
  };

  res.render('families/form', await formLocals(req, {
    title: 'Add a family',
    family,
    isNew: true
  }));
}));

router.post('/', canEdit, wrap(async (req, res) => {
  const { data, errors } = readForm(req);

  if (!errors.length && (await Family.familyIdTaken(data.family_id))) {
    errors.push(`Family ID "${data.family_id}" is already used by another family.`);
  }

  if (errors.length) {
    if (req.file) removePhoto(req.file.filename);
    return res.status(400).render('families/form', await formLocals(req, {
      title: 'Add a family',
      family: { ...data, photo: null },
      isNew: true,
      errors
    }));
  }

  data.photo = req.file ? req.file.filename : null;
  const id = await Family.create(data);
  res.redirect(`/families/${id}`);
}));

// ---------------------------------------------------------------------------
// Show / edit / update / delete
// ---------------------------------------------------------------------------

router.get('/:id(\\d+)', allowOwnFamily('viewer'), wrap(async (req, res, next) => {
  const family = await Family.findById(req.params.id);
  if (!family) return next();

  const login = await db.get(
    `SELECT username, is_active, on_default_password, last_login_at
     FROM users WHERE family_id = ?`,
    [family.id]
  );

  res.render('families/show', {
    title: family.head_name,
    family,
    login: login || null,
    canEdit: auth.atLeast(req.user, 'editor') || auth.ownsFamily(req.user, family.id),
    isOwnEntry: auth.isFamilyLogin(req.user),
    isAdmin: auth.atLeast(req.user, 'admin'),
    defaultPassword: config.defaultUserPassword,
    notice: req.query.notice || null,
    error: null
  });
}));

/** Give one family a login, or put it back to the default password. */
router.post('/:id(\\d+)/login', isAdmin, wrap(async (req, res, next) => {
  const family = await Family.findById(req.params.id);
  if (!family) return next();

  const existing = await db.get('SELECT id FROM users WHERE family_id = ?', [family.id]);
  const done = (message) =>
    res.redirect(`/families/${family.id}?notice=` + encodeURIComponent(message));

  if (existing) {
    await db.run(
      `UPDATE users SET password_hash = ?, on_default_password = 1, is_active = 1 WHERE id = ?`,
      [await auth.hashPassword(config.defaultUserPassword), existing.id]
    );
    return done('That login is back on the default password.');
  }

  const { created, skipped } = await createLogins([family]);
  return done(created
    ? `Login created for ${family.email}, with the default password.`
    : `No login created — ${skipped[0]}.`);
}));

router.get('/:id(\\d+)/edit', allowOwnFamily('editor'), wrap(async (req, res, next) => {
  const family = await Family.findById(req.params.id);
  if (!family) return next();

  res.render('families/form', await formLocals(req, {
    title: `Edit ${family.head_name}`,
    family,
    isNew: false
  }));
}));

router.post('/:id(\\d+)', allowOwnFamily('editor'), wrap(async (req, res, next) => {
  const existing = await Family.findById(req.params.id);
  if (!existing) return next();

  // A household may correct its own details, but not renumber itself or put
  // itself into the printed book — those stay where the parish office left
  // them. Substituted before the form is read, so the fields their shorter
  // form never sends are not reported back to them as missing.
  if (auth.isFamilyLogin(req.user)) {
    req.body.family_id = existing.family_id;
    req.body.is_published = existing.is_published ? '1' : '';
  }

  const { data, errors } = readForm(req);

  if (!errors.length && (await Family.familyIdTaken(data.family_id, existing.id))) {
    errors.push(`Family ID "${data.family_id}" is already used by another family.`);
  }

  if (errors.length) {
    if (req.file) removePhoto(req.file.filename);
    return res.status(400).render('families/form', await formLocals(req, {
      title: `Edit ${existing.head_name}`,
      family: { ...data, id: existing.id, photo: existing.photo },
      isNew: false,
      errors
    }));
  }

  const removingPhoto = req.body.remove_photo === '1';
  data.photo = req.file ? req.file.filename : (removingPhoto ? null : existing.photo);

  await Family.update(existing.id, data);

  // Only unlink the old file once the row that pointed at it is updated.
  if (existing.photo && existing.photo !== data.photo) removePhoto(existing.photo);

  res.redirect(`/families/${existing.id}`);
}));

router.post('/:id(\\d+)/delete', canEdit, wrap(async (req, res, next) => {
  const family = await Family.findById(req.params.id);
  if (!family) return next();

  await Family.remove(family.id);
  if (family.photo) removePhoto(family.photo);

  res.redirect('/families');
}));

module.exports = router;
