'use strict';

const express = require('express');
const Family = require('../models/family');
const Pending = require('../models/pending');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const tenancy = require('../lib/tenancy');
const verification = require('../lib/verification');
const wrap = require('../lib/async');
const { removePhoto } = require('../lib/upload');

const router = express.Router();

/**
 * The review queue.
 *
 * A family's submission is a proposal; this is where it stops being one. The
 * screen shows the existing value and the proposed value side by side, one
 * line per field that actually changed, and each line is approved or rejected
 * on its own — a reviewer can accept a new mobile number and reject a proposed
 * address in the same submission, and the rest of the record is left untouched.
 *
 * ── Who may clear what ─────────────────────────────────────────────────────
 * With one queue (the pilot default) every line is significant and needs an
 * administrator. With two, routine lines — mobile, email, occupation,
 * qualification, photograph — may be cleared by an editor and offered as a
 * batch. It is the same screen either way; the tier only decides who may act
 * and whether the batch button appears. See lib/verification.js.
 *
 * Nothing here reaches another parish: `req.churchId` goes into every query,
 * and models/pending.js refuses to build one without it.
 */

router.use(tenancy.requireChurch);
// A household login has no business in anybody's review queue, including its
// own — approving your own proposal is the one thing this whole exercise
// exists to prevent.
router.use(auth.requireRole('editor'));

/** Which tiers this user may actually clear. */
function reviewableTiers(user) {
  return Object.keys(verification.TIERS)
    .filter((tier) => verification.canReview(user.role, tier, (role) => (auth.ROLES[role] || {}).rank || 0));
}

function readFilter(req) {
  return {
    tier: verification.TIERS[req.query.tier] ? String(req.query.tier) : '',
    area: String(req.query.area || '').trim(),
    prayerGroup: String(req.query.group || '').trim()
  };
}

function filterQuery(filter, extra = {}) {
  const parts = [];
  if (filter.tier) parts.push(`tier=${encodeURIComponent(filter.tier)}`);
  if (filter.area) parts.push(`area=${encodeURIComponent(filter.area)}`);
  if (filter.prayerGroup) parts.push(`group=${encodeURIComponent(filter.prayerGroup)}`);
  for (const [key, value] of Object.entries(extra)) {
    if (value) parts.push(`${key}=${encodeURIComponent(value)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

router.get('/', wrap(async (req, res) => {
  const filter = readFilter(req);

  const [blocks, groupings, settled] = await Promise.all([
    Pending.queueByFamily(req.churchId, {
      status: Pending.OPEN,
      tier: filter.tier,
      area: filter.area,
      prayerGroup: filter.prayerGroup
    }),
    Family.groupings(req.churchId),
    Pending.queueByFamily(req.churchId, { status: Pending.APPROVED })
  ]);

  /*
   * A reviewer opening the queue is what "Under Parish Review" means. Recorded
   * for the families actually on screen rather than for the whole parish, so
   * the dashboard count says what a reviewer has in fact looked at.
   */
  for (const block of blocks) {
    await Family.setStatus(req.churchId, block.family.id, 'under_parish_review', {
      current: block.family.verify_status
    });
  }

  res.render('review/list', {
    title: 'Review queue',
    blocks,
    filter,
    query: filterQuery(filter),
    groupings,
    tiers: verification.TIERS,
    twoTier: verification.twoTierEnabled(req.settings),
    mayClear: reviewableTiers(req.user),
    recentlyApproved: settled.slice(0, 5),
    notice: req.query.notice || null,
    error: req.query.error || null
  });
}));

// ---------------------------------------------------------------------------
// One family's proposal, in full
// ---------------------------------------------------------------------------

router.get('/:familyId(\\d+)', wrap(async (req, res, next) => {
  const family = await Family.findById(req.churchId, req.params.familyId);
  if (!family) return next();

  const changes = await Pending.listQueue(req.churchId, {
    status: Pending.OPEN,
    familyId: family.id
  });

  await Family.setStatus(req.churchId, family.id, 'under_parish_review', {
    current: family.verify_status
  });

  res.render('review/show', {
    title: `Review ${family.head_name}`,
    family,
    changes,
    history: await Pending.forFamily(req.churchId, family.id),
    tiers: verification.TIERS,
    twoTier: verification.twoTierEnabled(req.settings),
    mayClear: reviewableTiers(req.user),
    notice: req.query.notice || null,
    error: req.query.error || null
  });
}));

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

/**
 * Once a family has nothing left waiting, it is Approved — and if it is also
 * in the printed book, Ready for Printing. That second step is not a separate
 * decision somebody has to remember: approval is what sets the flag the print
 * run reads, so the status follows it.
 */
async function settleFamilyStatus(req, familyId) {
  if (await Pending.familyHasOpen(req.churchId, familyId)) return;

  const family = await Family.findById(req.churchId, familyId);
  if (!family) return;

  await Family.setStatus(req.churchId, familyId, 'approved', {
    current: family.verify_status
  });
  if (family.is_published) {
    await Family.setStatus(req.churchId, familyId, 'ready_for_printing', { current: 'approved' });
  }
}

/**
 * Approve or reject a set of lines.
 *
 * One handler for all three ways of arriving here — a single Approve button, a
 * single Reject with a reason, and the batch approval of a family's routine
 * lines — because they differ only in how many ids come in.
 */
router.post('/decide', wrap(async (req, res) => {
  const back = String(req.body.back || '/review');
  const outcome = req.body.outcome === 'approve' ? Pending.APPROVED : Pending.REJECTED;
  const ids = [].concat(req.body.change_ids || []).map(Number).filter(Number.isInteger);

  const done = (message, key = 'notice') =>
    res.redirect((back.startsWith('/') && !back.startsWith('//') ? back : '/review') +
      (back.includes('?') ? '&' : '?') + `${key}=` + encodeURIComponent(message));

  if (!ids.length) return done('Nothing was selected, so nothing was changed.', 'error');

  /*
   * Refuse a line this reviewer's role may not clear.
   *
   * The buttons are hidden for tiers they cannot act on, but hiding a button is
   * a courtesy and not a control — the check is here, against the rows the
   * database actually holds, and it is done before anything is written.
   */
  const allowed = reviewableTiers(req.user);
  const lines = [];
  for (const id of ids) {
    const line = await Pending.findLine(req.churchId, id);
    if (!line || line.status !== Pending.OPEN) continue;
    if (!allowed.includes(line.tier)) {
      return done(
        'Some of those changes are significant, and only an administrator may approve them.',
        'error'
      );
    }
    lines.push(line);
  }

  if (!lines.length) return done('Those changes have already been decided.');

  const result = await Pending.decide(req.churchId, lines.map((l) => l.id), {
    outcome,
    reason: req.body.reason,
    user: req.user
  });

  // Photographs nothing points at any more: the one a rejected proposal
  // uploaded, or the one an approved proposal replaced. Unlinked only after
  // the rows that referred to them have been written.
  for (const filename of result.orphanedPhotos) removePhoto(req.churchId, filename);

  for (const familyId of result.families) await settleFamilyStatus(req, familyId);

  const verb = outcome === Pending.APPROVED ? 'approved' : 'rejected';
  await audit.record(req, `family.${verb}`, {
    churchId: req.churchId,
    detail: `${result.decided} change(s) ${verb}` +
      (outcome === Pending.APPROVED ? ', master record updated' : '') +
      (req.body.reason ? `: ${String(req.body.reason).slice(0, 120)}` : '')
  });

  return done(
    `${result.decided} ${result.decided === 1 ? 'change' : 'changes'} ${verb}` +
    (outcome === Pending.APPROVED
      ? ' and applied to the parish record.'
      : '. The family will see the reason the next time it signs in.')
  );
}));

// ---------------------------------------------------------------------------
// The queue as a spreadsheet
// ---------------------------------------------------------------------------

/** One CSV field: quoted, with embedded quotes doubled. */
function cell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * The Pending Changes export, in the columns the Parish asked for.
 *
 * This doubles as the working paper for a review meeting — the queue can be
 * read on paper and cleared on screen afterwards — so it carries the lines
 * already decided as well as the outstanding ones, unless one status is asked
 * for.
 */
router.get('/export.csv', wrap(async (req, res) => {
  const status = ['pending', 'approved', 'rejected', 'superseded'].includes(req.query.status)
    ? String(req.query.status)
    : '';

  const rows = await Pending.exportRows(req.churchId, { status });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="pending-changes-${new Date().toISOString().slice(0, 10)}.csv"`
  );

  // Data leaving the system entirely is exactly the event a parish is entitled
  // to see written down.
  await audit.record(req, 'export.pending', {
    churchId: req.churchId,
    detail: `${rows.length} pending-change row(s)${status ? ` (${status})` : ''}`
  });

  // A UTF-8 byte order mark, so Excel opens Malayalam and accented names as
  // names rather than as symbols. Three bytes; see routes/super-reports.js.
  res.write('﻿');

  res.write([
    'Family ID', 'Family', 'Field', 'Existing Value', 'Proposed Value',
    'Submitted By', 'Submitted On', 'Reviewed By', 'Status', 'Reason'
  ].map(cell).join(',') + '\r\n');

  for (const row of rows) {
    res.write([
      row.family_ref, row.family_head, row.field, row.existing_value, row.proposed_value,
      row.submitted_by, row.submitted_on, row.reviewed_by, row.status, row.reason
    ].map(cell).join(',') + '\r\n');
  }

  res.end();
}));

module.exports = router;
