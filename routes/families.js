'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const Users = require('../models/user');
const Family = require('../models/family');
const Churches = require('../models/church');
const Pending = require('../models/pending');
const dayMonth = require('../lib/daymonth');
const relations = require('../lib/relations');
const emails = require('../lib/email');
const phones = require('../lib/phone');
const freeText = require('../lib/free-text');
const settings = require('../lib/settings');
const auth = require('../lib/auth');
const verification = require('../lib/verification');
const audit = require('../lib/audit');
const tenancy = require('../lib/tenancy');
const wrap = require('../lib/async');
const { removePhoto, maxBytes } = require('../lib/upload');

const router = express.Router();

// Every family belongs to a church; a request that has not established which
// one has no business reading or writing any of them.
router.use(tenancy.requireChurch);

const canEdit = auth.requireRole('editor');
const canBrowse = auth.requireRole('viewer');
const isAdmin = auth.requireRole('admin');

/** A member login has no business on the list — send it to its own entry. */
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
    if (req.file) removePhoto(req.churchId, req.file.filename);

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
      const who = text(m.name);
      const dob = readDob(m, `Date of birth for "${who}"`);
      if (dob.error) errors.push(dob.error);

      // The browser has already objected to most of these; a form can still
      // arrive without having been through a browser at all, so the row is
      // checked again here, named by the member it belongs to — with several
      // rows on one page, "that is not a mobile number" is no help on its own.
      const badMobile = phones.problem(m.mobile, who);
      if (badMobile) errors.push(badMobile);

      for (const field of Object.keys(freeText.LIMITS)) {
        const bad = freeText.problem(field, m[field], who);
        if (bad) errors.push(bad);
      }

      return {
        // Carried back so a correction lands on the member it is about. See
        // replaceMembers in models/family.js — a member row now keeps its id
        // across an edit, because a pending change refers to it by that id.
        id: text(m.id),
        name: text(m.name),
        relation: text(m.relation),
        dob_day: dob.day,
        dob_month: dob.month,
        dob_year: dob.year,
        // Stored as the ten digits alone, so the number a family typed with
        // spaces in it and the same number typed without match each other —
        // in a search, and in the diff a pending correction is read from.
        mobile: phones.normalise(m.mobile),
        blood_group: text(m.blood_group),
        qualification: text(m.qualification),
        occupation: text(m.occupation),
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
    prayer_group: text(req.body.prayer_group),
    area: text(req.body.area),
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

const BLOOD_GROUP_OPTIONS = ['', 'O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];

/** Today as "2026-08-11", in the parish's own timezone rather than UTC. */
function todayISO() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

async function formLocals(req, extra) {
  const parishSettings = await settings.load(req.churchId);
  return {
    months: dayMonth.MONTH_OPTIONS,
    // The date picker offers 1900 up to today — nobody in the directory was
    // born before that, and nobody is born tomorrow.
    earliestBirthDate: `${dayMonth.EARLIEST_BIRTH_YEAR}-01-01`,
    today: todayISO(),
    toISO: dayMonth.toISO,
    formatDayMonth: dayMonth.format,
    emailPattern: emails.HTML_PATTERN,
    mobilePattern: phones.HTML_PATTERN,
    mobileDigits: phones.DIGITS,
    mobileMaxInput: phones.MAX_INPUT,
    textLimits: freeText.LIMITS,
    textPattern: freeText.htmlPattern,
    relationOptions: settings.relationOptions(parishSettings),
    // Offered as suggestions on the Area and Prayer Group fields, so a parish
    // settles on a spelling without the fields becoming a fixed list.
    groupings: await Family.groupings(req.churchId),
    // The same idea for Home parish, from the churches this installation knows
    // about. A suggestion, not a fixed list: a family's home parish may be one
    // that was never imported, and the ones already recorded as free text must
    // survive being edited.
    parishNames: await Churches.listNames(),
    bloodGroupOptions: BLOOD_GROUP_OPTIONS,
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
    Family.list(req.churchId, { search }),
    Family.emails(req.churchId),
    Family.withoutLogins(req.churchId)
  ]);

  res.render('families/list', {
    title: 'Families',
    families: families.map((f) => ({ ...f, dom: dayMonth.format(f.dom_day, f.dom_month) })),
    search,
    canEdit: auth.atLeast(req.user, 'editor'),
    isAdmin: auth.atLeast(req.user, 'admin'),
    statusLabel: verification.statusLabel,
    allEmails,
    pendingLoginCount: pendingLogins.length,
    defaultPassword: req.settings.default_member_password,
    notice: req.query.notice || null,
    error: req.query.error || null
  });
}));

// ---------------------------------------------------------------------------
// Member logins — one account per household, so a family can complete its own
// entry. Created with the shared default password, which the parish office
// sends out with the comma-separated address list from the page above.
// ---------------------------------------------------------------------------

/**
 * One bcrypt hash is computed per run and reused for every account created in
 * it. They all hold the same, deliberately public, default password, so a
 * salt each would buy nothing — and hashing 12 rounds per family would make
 * inviting a parish of 300 households take minutes.
 */
async function createLogins(churchId, families, defaultPassword) {
  const hash = await auth.hashPassword(defaultPassword);
  const skipped = [];
  let created = 0;

  for (const family of families) {
    const username = String(family.email || '').trim();
    if (!username) {
      skipped.push(`${family.family_id} (${family.head_name}) has no email address`);
      continue;
    }
    if (await Users.usernameTaken(username)) {
      skipped.push(`${username} is already a username`);
      continue;
    }

    await Users.create({
      username,
      password_hash: hash,
      full_name: family.head_name,
      role: 'family',
      church_id: churchId,
      family_id: family.id,
      on_default_password: true
    });
    created += 1;
  }

  return { created, skipped };
}

router.post('/logins', isAdmin, wrap(async (req, res) => {
  const pending = await Family.withoutLogins(req.churchId);

  if (!pending.length) {
    return res.redirect('/families?notice=' + encodeURIComponent(
      'Every family with an email address already has a login.'
    ));
  }

  const { created, skipped } = await createLogins(req.churchId, pending, req.settings.default_member_password);

  const parts = [`Created ${created} family ${created === 1 ? 'login' : 'logins'}, ` +
                 `each with the default password.`];
  if (skipped.length) parts.push(`Skipped ${skipped.length}: ${skipped.join('; ')}.`);

  res.redirect('/families?notice=' + encodeURIComponent(parts.join(' ')));
}));

// ---------------------------------------------------------------------------
// Family ID and PIN logins — the households with no email address
//
// No family is excluded for want of an email address. A household signs in
// with its Parish Family ID and a short PIN printed on the verification slip
// handed to it; no email address is involved at any step. The PIN is the
// account's password, so everything downstream — sessions, the queue, the
// audit trail — is the same login as any other, and there is one credential
// per family rather than two that can disagree.
// ---------------------------------------------------------------------------

/** A six-digit PIN, from the system's own randomness rather than Math.random. */
function makePin() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/**
 * Give one family a PIN, creating its login if it has not got one.
 *
 * A family with an email address keeps it as the username and gains the PIN as
 * its password; a family without one is given a username it never has to type,
 * built from the parish slug and its Family ID. Both are unique across the
 * installation, and neither is ever shown to the household — the sign-in form
 * asks for the parish, the Family ID and the PIN.
 *
 * The PIN is returned once, for the slip, and stored only as a bcrypt hash.
 * Reprinting a slip therefore means issuing a new PIN, which is one click and
 * is the honest trade: a directory that could reprint the old one would be a
 * directory storing it in the clear.
 */
async function issuePin(church, family) {
  const pin = makePin();
  const hash = await auth.hashPassword(pin);
  const existing = await Users.findByFamily(family.id);

  if (existing) {
    await Users.setPassword(existing.id, hash, { onDefault: true });
    await Users.setActive(existing.id, true);
  } else {
    const username = String(family.email || '').trim() || `${church.slug}/${family.family_id}`;
    if (await Users.usernameTaken(username)) {
      return { pin: null, skipped: `${username} is already a username` };
    }
    await Users.create({
      username,
      password_hash: hash,
      full_name: family.head_name,
      role: 'family',
      church_id: church.id,
      family_id: family.id,
      on_default_password: true
    });
  }

  return { pin, skipped: null };
}

/** Issue PINs and hand back the printable slips. */
async function issueSlips(req, families) {
  const slips = [];
  const skipped = [];

  for (const family of families) {
    const { pin, skipped: why } = await issuePin(req.church, family);
    if (!pin) {
      skipped.push(`${family.family_id} (${family.head_name}): ${why}`);
      continue;
    }
    slips.push({
      family_id: family.family_id,
      head_name: family.head_name,
      area: family.area || '',
      pin
    });
  }

  await audit.record(req, 'family.pin_issued', {
    churchId: req.churchId,
    detail: `${slips.length} verification slip(s) issued`
  });

  return { slips, skipped };
}

router.post('/pins', isAdmin, wrap(async (req, res) => {
  const ids = [].concat(req.body.family_ids || []).map(Number).filter(Number.isInteger);
  const families = ids.length
    ? (await Family.list(req.churchId, {})).filter((f) => ids.includes(f.id))
    : await Family.list(req.churchId, {});

  const { slips, skipped } = await issueSlips(req, families);

  res.render('families/slips', {
    title: 'Verification slips',
    slips,
    skipped,
    church: req.church
  });
}));

router.post('/:id(\\d+)/pin', isAdmin, wrap(async (req, res, next) => {
  const family = await Family.findById(req.churchId, req.params.id);
  if (!family) return next();

  const { slips, skipped } = await issueSlips(req, [family]);

  res.render('families/slips', {
    title: 'Verification slip',
    slips,
    skipped,
    church: req.church
  });
}));

// ---------------------------------------------------------------------------
// Verification status — where every family has got to
// ---------------------------------------------------------------------------

/** The filter three screens share: one status, one Area, one Prayer Group. */
function readFilter(req) {
  return {
    status: verification.isStatus(req.query.status) ? String(req.query.status) : '',
    area: String(req.query.area || '').trim(),
    prayerGroup: String(req.query.group || '').trim()
  };
}

function filterQuery(filter) {
  const parts = [];
  if (filter.status) parts.push(`status=${encodeURIComponent(filter.status)}`);
  if (filter.area) parts.push(`area=${encodeURIComponent(filter.area)}`);
  if (filter.prayerGroup) parts.push(`group=${encodeURIComponent(filter.prayerGroup)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

router.get('/status', familyLoginsGoHome, canBrowse, wrap(async (req, res) => {
  const filter = readFilter(req);

  const [{ counts, total }, families, groupings] = await Promise.all([
    Family.statusCounts(req.churchId, filter),
    Family.listByStatus(req.churchId, filter),
    Family.groupings(req.churchId)
  ]);

  res.render('families/status', {
    title: 'Verification status',
    statuses: verification.STATUSES,
    counts,
    total,
    families,
    filter,
    query: filterQuery(filter),
    groupings,
    isAdmin: auth.atLeast(req.user, 'admin'),
    notice: req.query.notice || null,
    error: req.query.error || null
  });
}));

/**
 * The sheet the Area Representative actually carries: Family ID, family head,
 * contact number and current status, for one Area or Prayer Group. This is the
 * practical value of the whole dashboard, so it is a plain printable page
 * rather than another screen to read on a phone.
 */
router.get('/status/print', familyLoginsGoHome, canBrowse, wrap(async (req, res) => {
  const filter = readFilter(req);

  res.render('families/followup', {
    title: 'Follow-up sheet',
    families: await Family.listByStatus(req.churchId, filter),
    filter,
    statusLabel: verification.statusLabel(filter.status),
    church: req.church,
    printedOn: new Date().toISOString().slice(0, 10)
  });
}));

/**
 * The office marks a batch as invited.
 *
 * One honest note, which belongs next to the code as much as in the answer to
 * the Parish: the application sends no email itself. This records the moment
 * the Parish office says it has sent the invitations. It is an accurate record
 * of the Parish's action; it is not a delivery receipt from a mail server, and
 * it should not be read as one.
 */
router.post('/invitations', isAdmin, wrap(async (req, res) => {
  const filter = readFilter(req);
  const ids = [].concat(req.body.family_ids || []).map(Number).filter(Number.isInteger);
  const targets = ids.length ? ids : await Family.idsIn(req.churchId, filter);

  const moved = await Family.setStatusMany(req.churchId, targets, 'invitation_sent');
  await audit.record(req, 'family.invited', {
    churchId: req.churchId,
    detail: `${moved} family/families marked as invited`
  });

  res.redirect('/families/status' + filterQuery(filter) +
    (filterQuery(filter) ? '&' : '?') + 'notice=' + encodeURIComponent(
    `${moved} famil${moved === 1 ? 'y' : 'ies'} marked as invited. ` +
    'This records that the parish office sent them, not that a mail server delivered them.'
  ));
}));

/** The run has gone to the press: everything in the book is now Printed. */
router.post('/printed', isAdmin, wrap(async (req, res) => {
  const ids = await Family.idsIn(req.churchId, { publishedOnly: true });
  const moved = await Family.setStatusMany(req.churchId, ids, 'printed');

  await audit.record(req, 'family.printed', {
    churchId: req.churchId,
    detail: `${moved} family/families marked as printed`
  });

  res.redirect('/families/status?notice=' + encodeURIComponent(
    `${moved} famil${moved === 1 ? 'y' : 'ies'} marked as printed.`
  ));
}));

// ---------------------------------------------------------------------------
// New / create
// ---------------------------------------------------------------------------

router.get('/new', canEdit, wrap(async (req, res) => {
  const family = {
    family_id: await Family.nextFamilyId(req.churchId),
    head_name: '',
    address: '',
    hometown: '',
    home_parish: '',
    spouse_home: '',
    prayer_group: '',
    area: '',
    email: '',
    photo: null,
    dom_day: null,
    dom_month: null,
    is_published: true,
    members: [
      {
        name: '', relation: 'Head', dob_day: null, dob_month: null, dob_year: null,
        mobile: '', blood_group: '', qualification: '', occupation: '', links: ''
      }
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

  if (!errors.length && (await Family.familyIdTaken(req.churchId, data.family_id))) {
    errors.push(`Family ID "${data.family_id}" is already used by another family.`);
  }

  if (errors.length) {
    if (req.file) removePhoto(req.churchId, req.file.filename);
    return res.status(400).render('families/form', await formLocals(req, {
      title: 'Add a family',
      family: { ...data, photo: null },
      isNew: true,
      errors
    }));
  }

  data.photo = req.file ? req.file.filename : null;
  const id = await Family.create(req.churchId, data);
  res.redirect(`/families/${id}`);
}));

// ---------------------------------------------------------------------------
// Show / edit / update / delete
// ---------------------------------------------------------------------------

router.get('/:id(\\d+)', allowOwnFamily('viewer'), wrap(async (req, res, next) => {
  const family = await Family.findById(req.churchId, req.params.id);
  if (!family) return next();

  const [login, proposals] = await Promise.all([
    Users.findByFamily(family.id),
    Pending.forFamily(req.churchId, family.id)
  ]);

  res.render('families/show', {
    title: family.head_name,
    family,
    login: login || null,
    // What has become of this family's corrections — what is still waiting,
    // and what was rejected with the reason the reviewer gave. Shown to the
    // family itself as well as to staff, so a rejected correction is not
    // silently lost.
    proposals,
    statusLabel: verification.statusLabel(family.verify_status),
    canEdit: auth.atLeast(req.user, 'editor') || auth.ownsFamily(req.user, family.id),
    isOwnEntry: auth.isFamilyLogin(req.user),
    isAdmin: auth.atLeast(req.user, 'admin'),
    defaultPassword: req.settings.default_member_password,
    notice: req.query.notice || null,
    error: null
  });
}));

/** Give one family a login, or put it back to the default password. */
router.post('/:id(\\d+)/login', isAdmin, wrap(async (req, res, next) => {
  const family = await Family.findById(req.churchId, req.params.id);
  if (!family) return next();

  const existing = await Users.findByFamily(family.id);
  const done = (message) =>
    res.redirect(`/families/${family.id}?notice=` + encodeURIComponent(message));

  if (existing) {
    await Users.resetToDefaultPassword(
      existing.id,
      await auth.hashPassword(req.settings.default_member_password)
    );
    return done('That login is back on the default password.');
  }

  const { created, skipped } = await createLogins(req.churchId, [family], req.settings.default_member_password);
  return done(created
    ? `Login created for ${family.email}, with the default password.`
    : `No login created — ${skipped[0]}.`);
}));

router.get('/:id(\\d+)/edit', allowOwnFamily('editor'), wrap(async (req, res, next) => {
  const family = await Family.findById(req.churchId, req.params.id);
  if (!family) return next();

  // A household opening its own entry is the moment "Family Reviewing" becomes
  // true, and it is the only moment the application can honestly observe it.
  // Staff opening the same form is not — that is the office at work.
  if (auth.isFamilyLogin(req.user)) {
    await Family.setStatus(req.churchId, family.id, 'family_reviewing', {
      current: family.verify_status
    });
  }

  res.render('families/form', await formLocals(req, {
    title: `Edit ${family.head_name}`,
    family,
    isNew: false
  }));
}));

router.post('/:id(\\d+)', allowOwnFamily('editor'), wrap(async (req, res, next) => {
  const existing = await Family.findById(req.churchId, req.params.id);
  if (!existing) return next();

  // A household may correct its own details, but not renumber itself or put
  // itself into the printed book — those stay where the parish office left
  // them. Substituted before the form is read, so the fields their shorter
  // form never sends are not reported back to them as missing, and so a
  // hand-made POST carrying them changes nothing. See NEVER_EDITABLE in
  // lib/verification.js, which is the same rule written down once.
  const isProposal = auth.isFamilyLogin(req.user);
  if (isProposal) {
    req.body.family_id = existing.family_id;
    req.body.is_published = existing.is_published ? '1' : '';
  }

  const { data, errors } = readForm(req);

  if (!errors.length && (await Family.familyIdTaken(req.churchId, data.family_id, existing.id))) {
    errors.push(`Family ID "${data.family_id}" is already used by another family.`);
  }

  if (errors.length) {
    if (req.file) removePhoto(req.churchId, req.file.filename);
    return res.status(400).render('families/form', await formLocals(req, {
      title: `Edit ${existing.head_name}`,
      family: { ...data, id: existing.id, photo: existing.photo },
      isNew: false,
      errors
    }));
  }

  const removingPhoto = req.body.remove_photo === '1';
  data.photo = req.file ? req.file.filename : (removingPhoto ? null : existing.photo);

  /*
   * The one change of substance the Parish asked for.
   *
   * A household's edit used to save straight to its own row. It is now written
   * to the pending-changes store instead and the master record is left exactly
   * as the Parish office left it, until Achen or an authorised administrator
   * approves the proposal line by line. Staff editing a family still write
   * directly — they are the master record.
   */
  if (isProposal) {
    const changes = Pending.diff(existing, data, req.settings);

    if (!changes.length) {
      // Nothing was actually altered. Say so rather than opening an empty item
      // in somebody's review queue.
      if (req.file) removePhoto(req.churchId, req.file.filename);
      return res.redirect(`/families/${existing.id}?notice=` + encodeURIComponent(
        'Thank you — nothing on the form differs from what the parish already holds.'
      ));
    }

    const { orphanedPhotos } = await Pending.submit(
      req.churchId, existing.id, changes, req.user, { via: 'family' }
    );
    for (const filename of orphanedPhotos) removePhoto(req.churchId, filename);

    await Family.setStatus(req.churchId, existing.id, 'changes_submitted', {
      current: existing.verify_status
    });
    await audit.record(req, 'family.submitted', {
      churchId: req.churchId,
      detail: `${existing.family_id} ${existing.head_name}: ${changes.length} proposed change(s)`
    });

    return res.redirect(`/families/${existing.id}?notice=` + encodeURIComponent(
      `Thank you. ${changes.length} ${changes.length === 1 ? 'correction has' : 'corrections have'} ` +
      'been sent to the parish office for approval. Nothing is changed in the ' +
      'directory until they have approved it.'
    ));
  }

  await Family.update(req.churchId, existing.id, data);

  // Only unlink the old file once the row that pointed at it is updated.
  if (existing.photo && existing.photo !== data.photo) removePhoto(req.churchId, existing.photo);

  res.redirect(`/families/${existing.id}`);
}));

router.post('/:id(\\d+)/delete', canEdit, wrap(async (req, res, next) => {
  const family = await Family.findById(req.churchId, req.params.id);
  if (!family) return next();

  await Family.remove(req.churchId, family.id);
  if (family.photo) removePhoto(req.churchId, family.photo);

  res.redirect('/families');
}));

module.exports = router;
