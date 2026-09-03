'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const Users = require('../models/user');
const Family = require('../models/family');
const Churches = require('../models/church');
const Pending = require('../models/pending');
const dayMonth = require('../lib/daymonth');
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
 * One of a member's two dates off the form.
 *
 * Both are day and month only now, and both come off the same pair of selects,
 * so there is one reader for the pair rather than a picker for one and a
 * fallback for the other.
 */
function readMemberDate(m, key, label) {
  return dayMonth.parse(m[`${key}_day`], m[`${key}_month`], label);
}

/** Pull a family (and its members) out of a submitted form. */
function readForm(req) {
  const text = (value) => String(value ?? '').trim();
  const errors = [];

  // qs gives an array for members[0][...], an object if the indices are sparse.
  const rawMembers = Object.values(req.body.members || {});

  const members = rawMembers
    .filter((m) => m && text(m.name))
    .map((m, i) => {
      const who = text(m.name);
      const dob = readMemberDate(m, 'dob', `Date of birth for "${who}"`);
      if (dob.error) errors.push(dob.error);

      // A date of marriage belongs to whoever is married, which in a household
      // with a married son is more than one member. See migration 11.
      const dom = readMemberDate(m, 'dom', `Date of marriage for "${who}"`);
      if (dom.error) errors.push(dom.error);

      // The browser has already objected to most of these; a form can still
      // arrive without having been through a browser at all, so the row is
      // checked again here, named by the member it belongs to — with several
      // rows on one page, "that is not a mobile number" is no help on its own.
      const badMobile = phones.listProblem(m.mobile, who);
      if (badMobile) errors.push(badMobile);

      const badEmails = emails.listProblem(m.emails, who);
      if (badEmails) errors.push(badEmails);

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
        dom_day: dom.day,
        dom_month: dom.month,
        // Stored as the ten digits alone, and comma-separated where there is
        // more than one, so the number a family typed with spaces in it and
        // the same number typed without match each other — in a search, and in
        // the diff a pending correction is read from.
        mobile: phones.normaliseList(m.mobile),
        blood_group: text(m.blood_group),
        qualification: text(m.qualification),
        occupation: text(m.occupation),
        emails: emails.normaliseList(m.emails),
        position: i
      };
    });

  const data = {
    family_id: text(req.body.family_id),
    head_name: text(req.body.head_name),
    address: text(req.body.address),
    hometown: text(req.body.hometown),
    home_parish: text(req.body.home_parish),
    prayer_group: text(req.body.prayer_group),
    area: text(req.body.area),
    email: text(req.body.email),
    is_published: req.body.is_published === '1',
    members
  };

  if (!data.family_id) errors.push('Family ID is required.');
  if (!data.head_name) errors.push('Family head is required.');
  if (!members.length) errors.push('Add at least one family member.');
  // The family's email becomes its login username, so it is checked properly
  // and the reason is handed back rather than a flat "invalid".
  const badEmail = emails.problem(data.email);
  if (badEmail) errors.push(badEmail);
  if (req.photoError) errors.push(req.photoError);

  return { data, errors };
}

const BLOOD_GROUP_OPTIONS = ['', 'O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];

async function formLocals(req, extra) {
  const parishSettings = await settings.load(req.churchId);
  return {
    months: dayMonth.MONTH_OPTIONS,
    formatDayMonth: dayMonth.format,
    emailPattern: emails.HTML_PATTERN,
    emailListPattern: emails.HTML_PATTERN_LIST,
    maxEmails: emails.MAX_ADDRESSES,
    mobilePattern: phones.HTML_PATTERN,
    mobilePatternOne: phones.HTML_PATTERN_ONE,
    mobileDigits: phones.DIGITS,
    mobileMaxInput: phones.MAX_INPUT,
    maxMobiles: phones.MAX_NUMBERS,
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
    families,
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
  if (skipped.length) {
    parts.push(`Skipped ${skipped.length} famil${skipped.length === 1 ? 'y' : 'ies'}: ` +
               `${skipped.join('; ')}.`);
  }

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
  const families = pickFrom(req, await Family.list(req.churchId, {}));

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

/**
 * The families behind each tile of the chain, so the screen can offer a step's
 * households the moment its tile is pressed.
 *
 * The chain is read whole — the status filter narrows the table underneath it,
 * not the chain itself, and a screen filtered to "Approved" must still be able
 * to move families out of "Invitation Sent". A status the code does not know
 * reads as Not Started, exactly as `statusCounts` counts it, so a stray value
 * in the column cannot leave families in a bucket with no tile.
 */
function byStage(families) {
  const stages = Object.fromEntries(verification.STATUS_KEYS.map((key) => [key, []]));
  for (const f of families) {
    const key = verification.isStatus(f.verify_status) ? f.verify_status : 'not_started';
    stages[key].push({
      id: f.id,
      family_id: f.family_id,
      head_name: f.head_name,
      area: f.area || '',
      prayer_group: f.prayer_group || '',
      is_published: !!f.is_published
    });
  }
  return stages;
}

/**
 * Which steps each step may be moved to, decided once here and sent to the
 * screen, so a destination the chain would refuse is greyed out on the tile
 * rather than accepted and quietly ignored. The rule itself stays in
 * lib/verification.js; this only asks it of every pair.
 */
function chainMoves() {
  return Object.fromEntries(verification.STATUS_KEYS.map((from) => [
    from,
    verification.STATUS_KEYS.filter((to) => to !== from && verification.canMove(from, to))
  ]));
}

router.get('/status', familyLoginsGoHome, canBrowse, wrap(async (req, res) => {
  const filter = readFilter(req);

  /*
   * One list, read once. The chain needs every step under this Area and Prayer
   * Group whatever the status filter says, and the table below wants that same
   * list narrowed to one step — so the narrowing happens here rather than in a
   * second query that would have to agree with the first.
   */
  const [{ counts, total }, everyStatus, groupings] = await Promise.all([
    Family.statusCounts(req.churchId, filter),
    Family.listByStatus(req.churchId, { ...filter, status: '' }),
    Family.groupings(req.churchId)
  ]);

  const families = verification.isStatus(filter.status)
    ? everyStatus.filter((f) => f.verify_status === filter.status)
    : everyStatus;

  res.render('families/status', {
    title: 'Verification status',
    statuses: verification.STATUSES,
    counts,
    total,
    families,
    stages: byStage(everyStatus),
    moves: chainMoves(),
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
 * The families a batch button acts on.
 *
 * The status screen posts the rows the office actually ticked, and a
 * `selection` marker alongside them so that "everything was unticked" can be
 * told apart from a bare POST that carries no list at all — the two mean
 * opposite things, and without the marker an unticked screen would read as
 * "act on all of them".
 *
 * Ticked ids are intersected with the families the filter selected rather than
 * trusted: a hand-made POST cannot reach a family this screen never showed,
 * nor one belonging to another parish.
 */
function pickFrom(req, rows) {
  const ids = new Set([].concat(req.body.family_ids || []).map(Number).filter(Number.isInteger));
  if (!req.body.selection && !ids.size) return rows;
  return rows.filter((f) => ids.has(f.id));
}

/**
 * Split a batch into the families an outright approval may touch, and the ones
 * it must not.
 *
 * A household with a correction still waiting in the review queue is approved
 * line by line, by a reviewer who can see what is being proposed — approving
 * it in a batch would bury that correction, which is the one thing this
 * exercise exists to prevent. Both routes that can reach Approved ask this,
 * so the rule cannot hold on one screen and lapse on the other.
 */
async function withoutOpenProposals(req, families) {
  const clear = [];
  let held = 0;
  for (const family of families) {
    if (await Pending.familyHasOpen(req.churchId, family.id)) held += 1;
    else clear.push(family);
  }
  return { clear, held };
}

/** Back to the status screen, keeping the filter, with a word about what happened. */
function backToStatus(res, filter, message, key = 'notice') {
  const q = filterQuery(filter);
  return res.redirect('/families/status' + q + (q ? '&' : '?') +
    `${key}=` + encodeURIComponent(message));
}

/** How many families, said in words that read properly at one. */
function howMany(n) {
  return `${n} famil${n === 1 ? 'y' : 'ies'}`;
}

const NOTHING_SELECTED = 'No family was ticked, so nothing was changed.';

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
  const targets = pickFrom(req, await Family.listByStatus(req.churchId, filter));
  if (!targets.length) return backToStatus(res, filter, NOTHING_SELECTED, 'error');

  const moved = await Family.setStatusMany(req.churchId, targets.map((f) => f.id), 'invitation_sent');
  await audit.record(req, 'family.invited', {
    churchId: req.churchId,
    detail: `${moved} family/families marked as invited`
  });

  return backToStatus(res, filter,
    `${howMany(moved)} marked as invited. ` +
    'This records that the parish office sent them, not that a mail server delivered them.');
}));

/** The run has gone to the press: everything in the book is now Printed. */
router.post('/printed', isAdmin, wrap(async (req, res) => {
  const ids = await Family.idsIn(req.churchId, { publishedOnly: true });
  const moved = await Family.setStatusMany(req.churchId, ids, 'printed');

  await audit.record(req, 'family.printed', {
    churchId: req.churchId,
    detail: `${moved} family/families marked as printed`
  });

  return backToStatus(res, {}, `${howMany(moved)} marked as printed.`);
}));

/**
 * The office approves a batch outright.
 *
 * The honest path to Approved is a family submitting corrections and a
 * reviewer clearing them one line at a time — routes/review.js, which is where
 * a proposal stops being one. But most households have nothing to correct, and
 * a parish will not hold up a directory waiting for fifty families to sign in
 * and say so. This is the office recording its own decision: these entries are
 * correct as they stand.
 *
 * Two things it deliberately will not do.
 *
 * It never approves over an open proposal. A family with corrections waiting
 * in the review queue is left where it is and counted in the notice, however
 * it was ticked on screen, because approving it here would bury a correction
 * somebody took the trouble to send — and burying those is the one thing this
 * exercise exists to prevent.
 *
 * It never runs on the whole parish by accident. The batch is exactly the rows
 * ticked on the status screen, and the confirm dialog says how many that is
 * before anything is written.
 */
router.post('/approved', isAdmin, wrap(async (req, res) => {
  const filter = readFilter(req);
  const picked = pickFrom(req, await Family.listByStatus(req.churchId, filter));
  if (!picked.length) return backToStatus(res, filter, NOTHING_SELECTED, 'error');

  const { clear: targets, held } = await withoutOpenProposals(req, picked);

  const moved = await Family.setStatusMany(req.churchId, targets.map((f) => f.id), 'approved');

  /*
   * Approval is what sets the flag the print run reads, so a family that is
   * already in the printed book follows straight on to Ready for Printing.
   * That is not a second decision anybody has to remember — it is the same
   * rule settleFamilyStatus applies in routes/review.js, and the two paths to
   * Approved must not leave families in different places.
   */
  const ready = await Family.setStatusMany(
    req.churchId,
    targets.filter((f) => f.is_published).map((f) => f.id),
    'ready_for_printing'
  );

  await audit.record(req, 'family.approved', {
    churchId: req.churchId,
    detail: `${moved} family/families approved as a batch by the parish office` +
      (held ? `; ${held} left alone with corrections still in the review queue` : '')
  });

  const parts = [`${howMany(moved)} approved by the parish office.`];
  if (ready) {
    parts.push(`${ready} of them are in the printed book and are now Ready for Printing.`);
  }
  if (held) {
    parts.push(
      `${howMany(held)} left alone — corrections are still waiting in the review ` +
      'queue, and those are approved line by line.'
    );
  }

  return backToStatus(res, filter, parts.join(' '));
}));

/**
 * The office decides which families the printed run contains.
 *
 * An import leaves every family a draft on purpose — a spreadsheet is not a
 * decision about what to print (lib/import-families.js) — so straight after
 * one the whole parish sits outside the book, and "Ready for Printing" has
 * nothing it may move. Without this the only way in was the checkbox on each
 * family's edit form, fifty times over.
 *
 * A family may never propose this about itself: inclusion in the Directory is
 * the parish office's call, which is why `is_published` is in NEVER_EDITABLE
 * (lib/verification.js). This is that call, made in one go.
 */
router.post('/published', isAdmin, wrap(async (req, res) => {
  const filter = readFilter(req);
  const picked = pickFrom(req, await Family.listByStatus(req.churchId, filter));
  if (!picked.length) return backToStatus(res, filter, NOTHING_SELECTED, 'error');

  const include = req.body.include === '1';
  const targets = picked.filter((f) => Boolean(f.is_published) !== include);
  await Family.setPublished(req.churchId, targets.map((f) => f.id), include);

  await audit.record(req, 'family.published', {
    churchId: req.churchId,
    detail: `${targets.length} family/families ` +
      `${include ? 'added to' : 'taken out of'} the printed directory`
  });

  const already = picked.length - targets.length;
  const parts = [include
    ? `${howMany(targets.length)} now included in the printed directory.`
    : `${howMany(targets.length)} taken out of the printed directory.`];
  if (already) {
    parts.push(`${howMany(already)} already ${include ? 'in' : 'out'}, and unchanged.`);
  }
  if (include && targets.length) {
    parts.push('Approved families among them can now be marked Ready for Printing.');
  }

  return backToStatus(res, filter, parts.join(' '));
}));

/**
 * The book is being assembled: approved entries become Ready for Printing.
 *
 * Only a family that has actually been approved, and is actually in the
 * printed book, is moved. The forward-only rule in lib/verification.js would
 * happily take a family here straight from Invitation Sent, which would put an
 * unverified entry into the run — so eligibility is decided here, against the
 * row, rather than left to that rule.
 */
router.post('/ready', isAdmin, wrap(async (req, res) => {
  const filter = readFilter(req);
  const picked = pickFrom(req, await Family.listByStatus(req.churchId, filter));
  if (!picked.length) return backToStatus(res, filter, NOTHING_SELECTED, 'error');

  const eligible = picked.filter((f) => f.is_published && f.verify_status === 'approved');
  const unapproved = picked.filter((f) => f.is_published &&
    verification.nextStatus(f.verify_status, 'approved') !== f.verify_status).length;
  const unpublished = picked.filter((f) => !f.is_published).length;

  const moved = await Family.setStatusMany(req.churchId, eligible.map((f) => f.id), 'ready_for_printing');

  await audit.record(req, 'family.ready_for_printing', {
    churchId: req.churchId,
    detail: `${moved} family/families marked ready for printing`
  });

  const parts = [`${howMany(moved)} marked Ready for Printing.`];
  if (unapproved) {
    parts.push(
      `${howMany(unapproved)} not approved yet, and an entry goes into the book ` +
      'only once it has been approved.'
    );
  }
  if (unpublished) {
    parts.push(
      `${howMany(unpublished)} not in the printed directory — a draft entry is ` +
      'not part of the run. Tick them and use "Include in the printed book" first.'
    );
  }

  return backToStatus(res, filter, parts.join(' '));
}));


/**
 * Moving a batch from one step of the chain to another.
 *
 * The chain on the status screen is a pair of tiles as well as a set of
 * counts: one step to move families *from*, one to move them *to*, and the
 * families themselves ticked in between. This is the single route behind that,
 * and the named buttons above it — invited, approved, ready for printing —
 * remain as the shorthand for the three moves an office makes most often.
 *
 * It is deliberately not a free "set verify_status to whatever was posted".
 * Every rule those buttons enforce is enforced here as well, because the same
 * move made from a different control has to mean the same thing:
 *
 *   the chain's direction   a family is never taken backwards down the chain,
 *                           except by the steps lib/verification.js allows to
 *                           rewind — an entry does not become unapproved
 *                           because somebody dropped it on an earlier tile
 *   an open correction      a family with a proposal waiting in the review
 *                           queue is never swept into Approved
 *   the printed run         only an approved family already in the book is
 *                           marked Ready for Printing
 *
 * Nothing the rules hold back is dropped quietly: every family left behind is
 * counted, and the notice says which rule left it there.
 */
router.post('/status/move', isAdmin, wrap(async (req, res) => {
  const filter = readFilter(req);
  const from = String(req.body.from || '');
  const to = String(req.body.to || '');

  if (!verification.isStatus(to)) {
    return backToStatus(res, filter,
      'That is not a step on the chain, so nothing was changed.', 'error');
  }
  if (from === to) {
    return backToStatus(res, filter,
      'Those families are already at that step, so nothing was changed.', 'error');
  }

  /*
   * The families the panel actually offered: the step being moved from, under
   * this screen's Area and Prayer Group filter — and never the status the page
   * happens to be filtered to, which narrows the table below and has nothing
   * to do with which step the office is emptying.
   */
  const inSource = await Family.listByStatus(req.churchId, {
    ...filter,
    status: verification.isStatus(from) ? from : ''
  });

  const picked = pickFrom(req, inSource);
  if (!picked.length) return backToStatus(res, filter, NOTHING_SELECTED, 'error');

  const label = verification.statusLabel(to);
  const notes = [];
  let targets = picked;

  if (to === 'approved') {
    const { clear, held } = await withoutOpenProposals(req, targets);
    targets = clear;
    if (held) {
      notes.push(
        `${howMany(held)} left alone — corrections are still waiting in the ` +
        'review queue, and those are approved line by line.'
      );
    }
  }

  if (to === 'ready_for_printing') {
    const unapproved = targets.filter((f) => f.is_published && f.verify_status !== 'approved').length;
    const unpublished = targets.filter((f) => !f.is_published).length;
    targets = targets.filter((f) => f.is_published && f.verify_status === 'approved');

    if (unapproved) {
      notes.push(
        `${howMany(unapproved)} not approved yet, and an entry goes into the ` +
        'book only once it has been approved.'
      );
    }
    if (unpublished) {
      notes.push(
        `${howMany(unpublished)} not in the printed directory — a draft entry ` +
        'is not part of the run. Use "Include in the printed book" first.'
      );
    }
  }

  const backwards = targets.filter((f) => !verification.canMove(f.verify_status, to));
  targets = targets.filter((f) => verification.canMove(f.verify_status, to));
  if (backwards.length) {
    notes.push(
      `${howMany(backwards.length)} left where they were — the chain does not ` +
      `run backwards to ${label}.`
    );
  }

  const moved = await Family.setStatusMany(req.churchId, targets.map((f) => f.id), to);

  /*
   * Approval is what the print run reads, so a family already in the book
   * follows straight on to Ready for Printing — the same rule the Approve
   * button and routes/review.js both apply. The two paths to Approved must not
   * leave families in different places.
   */
  let ready = 0;
  if (to === 'approved') {
    ready = await Family.setStatusMany(
      req.churchId,
      targets.filter((f) => f.is_published).map((f) => f.id),
      'ready_for_printing'
    );
  }

  await audit.record(req, 'family.stage_moved', {
    churchId: req.churchId,
    detail: `${moved} family/families moved from ` +
      `${verification.statusLabel(from)} to ${label}` +
      (notes.length ? `; ${picked.length - moved} left behind` : '')
  });

  const parts = [`${howMany(moved)} moved to ${label}.`];
  if (ready) {
    parts.push(`${ready} of them are in the printed book and are now Ready for Printing.`);
  }

  return backToStatus(res, filter, parts.concat(notes).join(' '),
    moved ? 'notice' : 'error');
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
    prayer_group: '',
    area: '',
    email: '',
    photo: null,
    is_published: true,
    members: [
      {
        name: '', relation: 'Head',
        dob_day: null, dob_month: null, dom_day: null, dom_month: null,
        mobile: '', blood_group: '', qualification: '', occupation: '', emails: ''
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

/**
 * Deleting a batch of families the office has ticked on the list.
 *
 * This exists for one job in particular: a parish that has imported a sheet,
 * found it wrong, and wants the old entries out before importing the corrected
 * one. Family IDs are unique within a parish and an import never overwrites
 * one, so without a way to clear the old rows the second import skips every
 * family in the file — and doing it one household at a time through the edit
 * form is not a realistic instruction for four hundred of them.
 *
 * Two things it will not do.
 *
 * It will not act on a POST that carries no ids. On the status screen a bare
 * POST means "the whole view", which is a convenience for the buttons that
 * mark and approve; for a button that deletes it would be a way to lose a
 * parish by pressing the wrong thing, so here an empty list means nothing and
 * says so.
 *
 * It will not reach outside this church. The ticked ids are intersected with
 * the families this church actually holds rather than trusted, so a hand-made
 * POST cannot delete another parish's households.
 */
router.post('/delete', isAdmin, wrap(async (req, res) => {
  const search = String(req.query.q || '');
  const back = '/families' + (search ? '?q=' + encodeURIComponent(search) : '');
  const say = (message, key = 'notice') =>
    res.redirect(back + (search ? '&' : '?') + `${key}=` + encodeURIComponent(message));

  const ids = [...new Set(
    [].concat(req.body.family_ids || []).map(Number).filter(Number.isInteger)
  )];
  if (!ids.length) {
    return say('No family was ticked, so nothing was deleted.', 'error');
  }

  /*
   * Read each one first. `remove` is scoped to the church itself and would
   * refuse anything else, but the rows are wanted anyway: the photograph has
   * to be unlinked once the row that pointed at it is gone, and the audit line
   * should name the families that went rather than only count them.
   */
  const found = [];
  for (const id of ids) {
    const family = await Family.findById(req.churchId, id);
    if (family) found.push(family);
  }
  if (!found.length) {
    return say('Those families are no longer in the directory.', 'error');
  }

  const gone = [];
  for (const family of found) {
    if (!await Family.remove(req.churchId, family.id)) continue;
    if (family.photo) removePhoto(req.churchId, family.photo);
    gone.push(`${family.family_id} ${family.head_name}`);
  }

  await audit.record(req, 'family.deleted', {
    churchId: req.churchId,
    detail: `${gone.length} family/families deleted: ${gone.join('; ')}`
  });

  return say(
    `${howMany(gone.length)} deleted, with their members, photographs, logins ` +
    'and any corrections that were waiting for review.'
  );
}));

router.post('/:id(\\d+)/delete', canEdit, wrap(async (req, res, next) => {
  const family = await Family.findById(req.churchId, req.params.id);
  if (!family) return next();

  await Family.remove(req.churchId, family.id);
  if (family.photo) removePhoto(req.churchId, family.photo);

  res.redirect('/families');
}));

module.exports = router;
