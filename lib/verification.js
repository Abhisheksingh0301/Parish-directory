'use strict';

/**
 * The vocabulary of the verification exercise.
 *
 * A family may propose any correction it likes to its own entry, and nothing
 * it proposes touches the parish master record until Achen or an authorised
 * administrator has approved it. That single rule needs three things written
 * down in one place, because the review screen, the dashboard, the export and
 * the audit log all have to agree on them:
 *
 *   FIELDS     what may be proposed, what each one is called on the review
 *              screen, and which of them a family may never touch at all
 *   TIERS      routine or significant — who may clear it, and whether a batch
 *              approval is offered
 *   STATUSES   where a family has got to, from "not started" to "printed"
 *
 * Nothing here reads or writes the database. models/pending.js is what turns a
 * submitted form into rows against these definitions.
 */

// ---------------------------------------------------------------------------
// The fields
// ---------------------------------------------------------------------------

/**
 * Fields a family may never propose a change to.
 *
 * The Family ID is the parish's own permanent identifier — a household cannot
 * renumber itself — and inclusion in the printed Directory is the parish
 * office's decision, not the family's. Both are dropped before a submission is
 * read, so they cannot appear in the queue even from a hand-made POST.
 */
const NEVER_EDITABLE = ['family_id', 'is_published'];

/** A family's own fields, in the order the review screen lists them. */
const FAMILY_FIELDS = [
  { key: 'head_name', label: 'Family Head' },
  { key: 'address', label: 'Address', multiline: true },
  { key: 'hometown', label: 'Home Town address', multiline: true },
  { key: 'home_parish', label: 'Home parish' },
  { key: 'spouse_home', label: 'Spouse home' },
  { key: 'area', label: 'Area' },
  { key: 'prayer_group', label: 'Prayer Group' },
  { key: 'email', label: 'Email' },
  { key: 'dom', label: 'Wedding anniversary' },
  { key: 'photo', label: 'Photograph', photo: true }
];

/** A member's fields, likewise. */
const MEMBER_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'relation', label: 'Relation' },
  { key: 'dob', label: 'Date of birth' },
  { key: 'mobile', label: 'Mobile' },
  { key: 'blood_group', label: 'Blood group' },
  { key: 'qualification', label: 'Qualification' },
  { key: 'occupation', label: 'Occupation' },
  { key: 'links', label: 'Links' }
];

const FAMILY_FIELD_BY_KEY = new Map(FAMILY_FIELDS.map((f) => [f.key, f]));
const MEMBER_FIELD_BY_KEY = new Map(MEMBER_FIELDS.map((f) => [f.key, f]));

/**
 * The default routine set, as answered to the Parish: mobile number, email,
 * occupation, qualification and photograph. Everything else is significant.
 *
 * This is a per-church setting rather than a constant in the code, so moving a
 * field from one tier to the other is something the Parish does itself on the
 * Settings page. See `tierOf`.
 */
const DEFAULT_ROUTINE_FIELDS = 'mobile, email, occupation, qualification, photo';

/** Every field a Parish may put in the routine tier, for the Settings page. */
const TIERABLE_FIELDS = [
  ...FAMILY_FIELDS.map((f) => ({ key: f.key, label: f.label, scope: 'Family' })),
  ...MEMBER_FIELDS.map((f) => ({ key: f.key, label: f.label, scope: 'Member' }))
];

// ---------------------------------------------------------------------------
// The two tiers
// ---------------------------------------------------------------------------

const TIERS = {
  routine: {
    label: 'Routine',
    blurb: 'Reviewed in a single batch; an authorised Admin may approve them together.',
    minRole: 'editor',
    batch: true
  },
  significant: {
    label: 'Significant',
    blurb: 'Approved individually, by Achen or a specifically authorised Admin.',
    minRole: 'admin',
    batch: false
  }
};

/** The routine field list as this church has set it. */
function routineFields(settings) {
  const raw = settings && settings.routine_fields !== undefined
    ? settings.routine_fields
    : DEFAULT_ROUTINE_FIELDS;

  return new Set(
    String(raw || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * One queue, or two?
 *
 * The pilot runs on one queue for everything: with five to ten families the
 * volume is small, there is no risk of a field being mis-classified, and it is
 * the simplest thing to operate. Switching this on is a setting, not a
 * rebuild — the review screen is the same either way, and the tier only
 * decides who may clear an item and whether batch approval is offered.
 */
function twoTierEnabled(settings) {
  return String((settings && settings.approval_tiers) || '1') === '2';
}

/**
 * Which tier a proposed change falls into.
 *
 * With one queue everything is significant, which is the safe reading: every
 * line is approved on its own, by an administrator.
 */
function tierOf(fieldKey, settings) {
  if (!twoTierEnabled(settings)) return 'significant';
  return routineFields(settings).has(String(fieldKey).toLowerCase()) ? 'routine' : 'significant';
}

// ---------------------------------------------------------------------------
// Where a family has got to
// ---------------------------------------------------------------------------

/**
 * The chain the Parish set out, in order. A family sits at exactly one of
 * these, and the dashboard counts each one.
 *
 * `invitation_sent` is recorded when the Parish office marks a batch as sent.
 * The application sends no email itself — messages go out from the Parish's
 * own mail account — so this is an accurate record of the Parish's action and
 * not a delivery receipt from a mail server. It should not be read as one.
 */
const STATUSES = [
  { key: 'not_started', label: 'Not Started' },
  { key: 'invitation_sent', label: 'Invitation Sent' },
  { key: 'family_reviewing', label: 'Family Reviewing' },
  { key: 'changes_submitted', label: 'Changes Submitted' },
  { key: 'under_parish_review', label: 'Under Parish Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'ready_for_printing', label: 'Ready for Printing' },
  { key: 'printed', label: 'Printed' }
];

const STATUS_KEYS = STATUSES.map((s) => s.key);
const STATUS_RANK = new Map(STATUSES.map((s, i) => [s.key, i]));

function statusLabel(key) {
  const found = STATUSES.find((s) => s.key === key);
  return found ? found.label : 'Not Started';
}

function isStatus(key) {
  return STATUS_RANK.has(String(key));
}

/**
 * Never move a family backwards down the chain by accident.
 *
 * A family that has already been approved and opens its entry again should not
 * silently drop back to "Family Reviewing" — but a family that actually
 * submits something must, because there is a real proposal waiting. So the
 * forward-only rule applies to the passive steps, and the two steps that
 * record an action of substance (`changes_submitted`, and the office marking a
 * batch) are allowed to pull a family back.
 */
const REWINDABLE = new Set(['changes_submitted', 'invitation_sent', 'printed']);

function nextStatus(current, wanted) {
  const from = STATUS_RANK.has(current) ? STATUS_RANK.get(current) : 0;
  const to = STATUS_RANK.get(wanted);
  if (to === undefined) return current;
  if (to >= from) return wanted;
  return REWINDABLE.has(wanted) ? wanted : current;
}

// ---------------------------------------------------------------------------
// Reading a change back in plain words
// ---------------------------------------------------------------------------

/**
 * What a reviewer sees on the left of the line.
 *
 * A missing value prints as an em dash rather than as an empty cell, so
 * "nothing was recorded" and "the column failed to render" do not look alike.
 */
function display(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  return text || '—';
}

/** The action buttons offered against a change, given who is reviewing. */
function canReview(userRole, tier, rankOf) {
  const needed = (TIERS[tier] || TIERS.significant).minRole;
  return rankOf(userRole) >= rankOf(needed);
}

module.exports = {
  NEVER_EDITABLE,
  FAMILY_FIELDS,
  MEMBER_FIELDS,
  FAMILY_FIELD_BY_KEY,
  MEMBER_FIELD_BY_KEY,
  TIERABLE_FIELDS,
  DEFAULT_ROUTINE_FIELDS,
  TIERS,
  STATUSES,
  STATUS_KEYS,
  routineFields,
  twoTierEnabled,
  tierOf,
  statusLabel,
  isStatus,
  nextStatus,
  display,
  canReview
};
