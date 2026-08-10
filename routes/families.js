'use strict';

const express = require('express');
const Family = require('../models/family');
const dayMonth = require('../lib/daymonth');
const settings = require('../lib/settings');
const auth = require('../lib/auth');
const wrap = require('../lib/async');
const { removePhoto, maxBytes } = require('../lib/upload');

const router = express.Router();

const canEdit = auth.requireRole('editor');

// Photo uploads are parsed in app.js, before the CSRF check — by the time a
// handler here runs, req.file and req.photoError are already populated.

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
      const dob = dayMonth.parse(m.dob_day, m.dob_month, `Date of birth for "${text(m.name)}"`);
      if (dob.error) errors.push(dob.error);

      return {
        name: text(m.name),
        relation: text(m.relation),
        dob_day: dob.day,
        dob_month: dob.month,
        mobile: text(m.mobile),
        links: text(m.links),
        position: i
      };
    });

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
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    errors.push('That email address does not look valid.');
  }
  if (req.photoError) errors.push(req.photoError);

  return { data, errors };
}

async function formLocals(req, extra) {
  const parishSettings = await settings.load();
  return {
    months: dayMonth.MONTH_OPTIONS,
    relationOptions: settings.relationOptions(parishSettings),
    maxPhotoMb: Math.round(maxBytes / (1024 * 1024)),
    errors: [],
    ...extra
  };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

router.get('/', wrap(async (req, res) => {
  const search = String(req.query.q || '');
  const families = await Family.list({ search });

  res.render('families/list', {
    title: 'Families',
    families: families.map((f) => ({ ...f, dom: dayMonth.format(f.dom_day, f.dom_month) })),
    search,
    canEdit: auth.atLeast(req.user, 'editor')
  });
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
    members: [{ name: '', relation: 'HF', dob_day: null, dob_month: null, mobile: '', links: '' }]
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

router.get('/:id(\\d+)', wrap(async (req, res, next) => {
  const family = await Family.findById(req.params.id);
  if (!family) return next();

  res.render('families/show', {
    title: family.head_name,
    family,
    canEdit: auth.atLeast(req.user, 'editor')
  });
}));

router.get('/:id(\\d+)/edit', canEdit, wrap(async (req, res, next) => {
  const family = await Family.findById(req.params.id);
  if (!family) return next();

  res.render('families/form', await formLocals(req, {
    title: `Edit ${family.head_name}`,
    family,
    isNew: false
  }));
}));

router.post('/:id(\\d+)', canEdit, wrap(async (req, res, next) => {
  const existing = await Family.findById(req.params.id);
  if (!existing) return next();

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
