'use strict';

const { Op, fn, col, where: whereFn } = require('sequelize');
const db = require('../db');
const Family = require('./family');
const dayMonth = require('../lib/daymonth');
const verification = require('../lib/verification');

const { sequelize, Submission, PendingChange, Family: FamilyRow } = db;

/**
 * Proposals, and what becomes of them.
 *
 * The rule the whole exercise rests on: nothing a family submits changes the
 * parish master record on its own. A submission is a proposal until Achen or
 * an authorised administrator approves it, and it is approved one line at a
 * time — a reviewer may accept a new mobile number and reject a proposed
 * address in the same submission, leaving the rest of the record untouched.
 *
 * ── The three jobs ─────────────────────────────────────────────────────────
 *   diff()      compare what the family sent against the master record, and
 *               produce one line per field that actually changed. A reviewer
 *               reads three lines, not the whole record, which is what makes
 *               a hundred families reviewable in an evening.
 *   submit()    write those lines to the queue, and leave the master alone.
 *   decide()    record an outcome per line, and apply the approved ones —
 *               that, and only that, is what writes to the master record.
 *
 * ── Two halves of a line ───────────────────────────────────────────────────
 * `existing_value` and `proposed_value` are text, rendered once at submission
 * time in the Directory's own format ("02 - Aug - 1975", "14 - Mar"), so the
 * reviewer is comparing what will actually be printed and the export needs no
 * second opinion. `payload` is the machine half — which member, which column,
 * what value — and is the only thing `apply` reads.
 *
 * Every function takes a church, and it goes in the WHERE clause. See the note
 * at the top of models/family.js: that is the whole of tenancy.
 */

const OPEN = 'pending';
const APPROVED = 'approved';
const REJECTED = 'rejected';
/** Overtaken by a later submission for the same field, so never reviewed. */
const SUPERSEDED = 'superseded';

function scope(churchId) {
  if (!Number.isInteger(Number(churchId))) {
    throw new Error('A church is required to read or write pending changes.');
  }
  return { church_id: Number(churchId) };
}

const text = (value) => String(value === null || value === undefined ? '' : value).trim();

// ---------------------------------------------------------------------------
// Working out what actually changed
// ---------------------------------------------------------------------------

/**
 * Pair the members the family sent against the ones on record.
 *
 * Three passes, most reliable first. The form now carries each saved member's
 * id, so an ordinary correction matches on that and a renamed member still
 * reads as "Name: X → Y" rather than as a removal and an addition. A member
 * the form has lost the id for is matched by name, and anything still
 * unmatched is paired off in order — which is what a straight re-typing of the
 * list looks like. Only what is left over after all three is genuinely an
 * addition or a removal.
 */
function pairMembers(existing, proposed) {
  const pairs = [];
  const freeExisting = [...existing];
  const freeProposed = [...proposed];

  const take = (predicate) => {
    for (let p = 0; p < freeProposed.length; p += 1) {
      const e = freeExisting.findIndex((candidate) => predicate(candidate, freeProposed[p]));
      if (e === -1) continue;
      pairs.push({ existing: freeExisting[e], proposed: freeProposed[p] });
      freeExisting.splice(e, 1);
      freeProposed.splice(p, 1);
      p -= 1;
    }
  };

  take((e, p) => Number(p.id) === Number(e.id));
  take((e, p) => text(p.name).toLowerCase() === text(e.name).toLowerCase());

  while (freeExisting.length && freeProposed.length) {
    pairs.push({ existing: freeExisting.shift(), proposed: freeProposed.shift() });
  }

  return { pairs, added: freeProposed, removed: freeExisting };
}

/** "Mr John Dsouza, Son" — a member named the way a reviewer reads one. */
function describeMember(m) {
  const name = text(m.name) || '(no name)';
  const relation = text(m.relation);
  return relation ? `${name}, ${relation}` : name;
}

function line({ kind, field, label, existing, proposed, payload, settings }) {
  return {
    kind,
    field,
    label,
    tier: verification.tierOf(field, settings),
    existing_value: existing,
    proposed_value: proposed,
    payload
  };
}

/**
 * Every line on which the proposal differs from the record.
 *
 * `existing` is a family as models/family.js hands it back — decorated, with
 * its members and their ids. `proposed` is what came off the form.
 */
function diff(existing, proposed, settings) {
  const changes = [];

  // --- the family's own fields ---
  for (const field of verification.FAMILY_FIELDS) {
    if (field.key === 'photo') continue;

    const was = text(existing[field.key]);
    const now = text(proposed[field.key]);
    if (was === now) continue;

    changes.push(line({
      kind: 'family',
      field: field.key,
      label: field.label,
      existing: was,
      proposed: now,
      payload: { kind: 'family', key: field.key, value: now },
      settings
    }));
  }

  // A photograph is compared by filename, and the two are shown side by side
  // on the review screen — the existing one against the proposed one.
  const photoWas = text(existing.photo);
  const photoNow = text(proposed.photo);
  if (photoWas !== photoNow) {
    changes.push(line({
      kind: 'family',
      field: 'photo',
      label: 'Photograph',
      existing: photoWas ? 'Existing photograph' : '',
      proposed: photoNow ? 'New photograph' : 'Photograph removed',
      payload: {
        kind: 'family',
        key: 'photo',
        photo: photoNow || null,
        previous: photoWas || null
      },
      settings
    }));
  }

  // --- members ---
  const { pairs, added, removed } = pairMembers(existing.members || [], proposed.members || []);

  for (const { existing: was, proposed: now } of pairs) {
    for (const field of verification.MEMBER_FIELDS) {
      /*
       * A date is two columns and one idea, so it moves as a single line and
       * is shown in the Directory's own format rather than as a pair of
       * numbers a reviewer would have to decode.
       */
      if (field.key === 'dob' || field.key === 'dom') {
        const day = `${field.key}_day`;
        const month = `${field.key}_month`;

        const dateWas = dayMonth.format(was[day], was[month]);
        const dateNow = dayMonth.format(now[day], now[month]);
        if (dateWas === dateNow) continue;

        changes.push(line({
          kind: 'member',
          field: field.key,
          label: `${describeMember(was)} — ${field.label}`,
          existing: dateWas,
          proposed: dateNow,
          payload: {
            kind: 'member',
            member_id: was.id,
            key: field.key,
            [day]: now[day],
            [month]: now[month]
          },
          settings
        }));
        continue;
      }

      const valueWas = text(was[field.key]);
      const valueNow = text(now[field.key]);
      if (valueWas === valueNow) continue;

      changes.push(line({
        kind: 'member',
        field: field.key,
        label: `${describeMember(was)} — ${field.label}`,
        existing: valueWas,
        proposed: valueNow,
        payload: { kind: 'member', member_id: was.id, key: field.key, value: valueNow },
        settings
      }));
    }
  }

  /*
   * Family composition reads in plain words. "Member added: Anu Dsouza,
   * Daughter" is what a reviewer can act on; a comparison of table rows is
   * not, and this is the change most likely to be got wrong in a hurry.
   */
  for (const m of added) {
    changes.push(line({
      kind: 'member_add',
      field: 'members',
      label: `Member added: ${describeMember(m)}`,
      existing: '',
      proposed: describeMember(m),
      payload: { kind: 'member_add', member: m },
      settings
    }));
  }

  for (const m of removed) {
    changes.push(line({
      kind: 'member_remove',
      field: 'members',
      label: `Member removed: ${describeMember(m)}`,
      existing: describeMember(m),
      proposed: '',
      payload: { kind: 'member_remove', member_id: m.id },
      settings
    }));
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Submitting
// ---------------------------------------------------------------------------

/**
 * Write a proposal to the queue. The master record is not touched.
 *
 * A family that submits twice does not leave two competing proposals for the
 * same field in the queue: the earlier line is marked superseded, so a
 * reviewer never has to decide which of two versions of an address the family
 * meant, and never approves the older one by accident.
 *
 * `via` is 'family' when the household submitted it themselves and 'assisted'
 * when an Area Representative or the Parish office submitted on their behalf.
 * It enters the same approval queue either way; the difference is recorded so
 * an assisted entry is never mistaken for one the family made itself.
 */
async function submit(churchId, familyId, changes, user, { via = 'family' } = {}) {
  if (!changes.length) return { submissionId: null, orphanedPhotos: [] };

  const owner = scope(churchId).church_id;
  const at = db.now();
  // Photographs proposed earlier and now overtaken. Nothing will ever point at
  // them again, so the caller unlinks them.
  const orphanedPhotos = [];

  return sequelize.transaction(async (transaction) => {
    const submission = await Submission.create({
      church_id: owner,
      family_id: Number(familyId),
      submitted_by: user ? user.id : null,
      submitted_by_name: user ? (user.full_name || user.username) : '(unknown)',
      submitted_via: via,
      submitted_at: at,
      status: 'open'
    }, { transaction });

    for (const change of changes) {
      // One field, one outstanding proposal. Composition lines are exempt:
      // "member added" and "member removed" are about different people, and
      // they all share the field name `members`.
      if (change.kind === 'family' || change.kind === 'member') {
        const clash = { field: change.field, family_id: Number(familyId), status: OPEN };
        if (change.kind === 'member') {
          // Only the same member's line, not every member's.
          clash.payload = { [Op.like]: `%"member_id":${Number(change.payload.member_id)}%` };
        }

        if (change.field === 'photo') {
          const overtaken = await PendingChange.findAll({
            where: { ...scope(churchId), ...clash },
            transaction
          });
          for (const row of overtaken) {
            const payload = hydrate(row.get({ plain: true })).payload;
            if (payload.photo) orphanedPhotos.push(payload.photo);
          }
        }

        await PendingChange.update(
          { status: SUPERSEDED, reviewed_at: at, reason: 'Replaced by a later submission.' },
          { where: { ...scope(churchId), ...clash }, transaction }
        );
      }

      await PendingChange.create({
        submission_id: submission.id,
        church_id: owner,
        family_id: Number(familyId),
        kind: change.kind,
        field: change.field,
        label: change.label,
        tier: change.tier,
        existing_value: change.existing_value,
        proposed_value: change.proposed_value,
        payload: JSON.stringify(change.payload),
        status: OPEN
      }, { transaction });
    }

    return { submissionId: submission.id, orphanedPhotos };
  });
}

// ---------------------------------------------------------------------------
// Reading the queue
// ---------------------------------------------------------------------------

function hydrate(row) {
  let payload = {};
  try {
    payload = JSON.parse(row.payload || '{}');
  } catch (err) {
    // A line whose payload will not parse can still be read and rejected; it
    // must never take the queue down for every other family.
    payload = {};
  }
  return { ...row, payload };
}

/**
 * The queue, newest submission first.
 *
 * Narrowed by tier when the church runs two of them, and by Area or Prayer
 * Group so one representative's families can be cleared together.
 */
async function listQueue(churchId, { status = OPEN, tier = '', familyId = null, area = '', prayerGroup = '' } = {}) {
  const where = { ...scope(churchId) };
  if (status) where.status = status;
  if (tier) where.tier = tier;
  if (familyId) where.family_id = Number(familyId);

  const familyWhere = {};
  if (text(area)) {
    familyWhere[Op.and] = [whereFn(fn('lower', col('family.area')), text(area).toLowerCase())];
  }
  if (text(prayerGroup)) {
    const clause = whereFn(fn('lower', col('family.prayer_group')), text(prayerGroup).toLowerCase());
    familyWhere[Op.and] = familyWhere[Op.and] ? [...familyWhere[Op.and], clause] : [clause];
  }

  const rows = await PendingChange.findAll({
    where,
    include: [
      {
        model: FamilyRow,
        as: 'family',
        required: true,
        attributes: ['id', 'family_id', 'head_name', 'area', 'prayer_group', 'photo', 'verify_status'],
        ...(Object.keys(familyWhere).length ? { where: familyWhere } : {})
      },
      {
        model: Submission,
        as: 'submission',
        required: true,
        attributes: ['id', 'submitted_at', 'submitted_by_name', 'submitted_via']
      }
    ],
    order: [['family_id', 'ASC'], ['id', 'ASC']]
  });

  return rows.map((row) => hydrate(row.get({ plain: true })));
}

/**
 * The queue as the review screen wants it: one block per family, so a reviewer
 * reads a household at a time rather than a flat list of unrelated lines.
 */
async function queueByFamily(churchId, options = {}) {
  const rows = await listQueue(churchId, options);

  const families = new Map();
  for (const row of rows) {
    const key = row.family.id;
    if (!families.has(key)) {
      families.set(key, {
        family: row.family,
        submitted_at: row.submission.submitted_at,
        submitted_by_name: row.submission.submitted_by_name,
        submitted_via: row.submission.submitted_via,
        changes: []
      });
    }
    const block = families.get(key);
    block.changes.push(row);
    // The block is dated by the most recent proposal in it.
    if (row.submission.submitted_at > block.submitted_at) {
      block.submitted_at = row.submission.submitted_at;
      block.submitted_by_name = row.submission.submitted_by_name;
      block.submitted_via = row.submission.submitted_via;
    }
  }

  return [...families.values()].sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
}

/** How many lines are waiting, for the navigation badge and the dashboard. */
async function openCount(churchId) {
  return PendingChange.count({ where: { ...scope(churchId), status: OPEN } });
}

/**
 * What has become of this family's proposals, for the family itself.
 *
 * A rejection carries the reason the reviewer gave, and the family sees it the
 * next time it signs in — so a rejected correction is not silently lost.
 */
async function forFamily(churchId, familyId, { limit = 60 } = {}) {
  const rows = await PendingChange.findAll({
    where: { ...scope(churchId), family_id: Number(familyId) },
    include: [{
      model: Submission,
      as: 'submission',
      required: true,
      attributes: ['submitted_at', 'submitted_by_name', 'submitted_via']
    }],
    order: [['id', 'DESC']],
    limit
  });

  const all = rows.map((row) => hydrate(row.get({ plain: true })));
  return {
    waiting: all.filter((r) => r.status === OPEN),
    approved: all.filter((r) => r.status === APPROVED),
    rejected: all.filter((r) => r.status === REJECTED)
  };
}

/** One line, if it is this church's. */
async function findLine(churchId, id) {
  const row = await PendingChange.findOne({ where: { ...scope(churchId), id } });
  return row ? hydrate(row.get({ plain: true })) : null;
}

// ---------------------------------------------------------------------------
// Applying an approval to the master record
// ---------------------------------------------------------------------------

/** The family as `Family.update` wants it back, before anything is applied. */
function asFormData(family) {
  return {
    family_id: family.family_id,
    head_name: family.head_name,
    address: family.address,
    hometown: family.hometown,
    home_parish: family.home_parish,
    prayer_group: family.prayer_group,
    area: family.area,
    email: family.email,
    photo: family.photo,
    is_published: family.is_published,
    members: (family.members || []).map((m) => ({
      id: m.id,
      name: m.name,
      relation: m.relation,
      dob_day: m.dob_day,
      dob_month: m.dob_month,
      dom_day: m.dom_day,
      dom_month: m.dom_month,
      mobile: m.mobile,
      blood_group: m.blood_group,
      qualification: m.qualification,
      occupation: m.occupation,
      emails: m.emails
    }))
  };
}

/**
 * Fold one approved line into the working copy.
 *
 * A line that names a member who has since been removed applies to nothing,
 * and that is not an error: it is two approvals that between them say the
 * member is gone. It is still marked applied, so it leaves the queue.
 */
function fold(data, payload) {
  if (!payload || !payload.kind) return data;

  if (payload.kind === 'family') {
    if (payload.key === 'photo') {
      data.photo = payload.photo || null;
    } else {
      data[payload.key] = payload.value ?? '';
    }
    return data;
  }

  if (payload.kind === 'member') {
    const member = data.members.find((m) => Number(m.id) === Number(payload.member_id));
    if (!member) return data;

    if (payload.key === 'dob' || payload.key === 'dom') {
      member[`${payload.key}_day`] = payload[`${payload.key}_day`] ?? null;
      member[`${payload.key}_month`] = payload[`${payload.key}_month`] ?? null;
    } else {
      member[payload.key] = payload.value ?? '';
    }
    return data;
  }

  if (payload.kind === 'member_add') {
    const m = payload.member || {};
    // No id: replaceMembers reads that as a new row.
    data.members.push({
      name: text(m.name),
      relation: text(m.relation),
      dob_day: m.dob_day ?? null,
      dob_month: m.dob_month ?? null,
      dom_day: m.dom_day ?? null,
      dom_month: m.dom_month ?? null,
      mobile: text(m.mobile),
      blood_group: text(m.blood_group),
      qualification: text(m.qualification),
      occupation: text(m.occupation),
      emails: text(m.emails)
    });
    return data;
  }

  if (payload.kind === 'member_remove') {
    data.members = data.members.filter((m) => Number(m.id) !== Number(payload.member_id));
    return data;
  }

  return data;
}

/**
 * Apply every approved-but-not-yet-applied line for one family.
 *
 * Read, fold, write once. Doing it per family rather than per line means the
 * member list is rebuilt a single time however many lines were approved
 * together, and the family's `updated_at` moves once.
 *
 * Returns the photo filenames the master record no longer points at, so the
 * caller can unlink them — after the row that referred to them is written,
 * never before.
 */
async function applyApproved(churchId, familyId) {
  const family = await Family.findById(churchId, familyId);
  if (!family) return { applied: 0, orphanedPhotos: [] };

  const rows = await PendingChange.findAll({
    where: { ...scope(churchId), family_id: Number(familyId), status: APPROVED, applied_at: null },
    order: [['id', 'ASC']]
  });
  if (!rows.length) return { applied: 0, orphanedPhotos: [] };

  const lines = rows.map((row) => hydrate(row.get({ plain: true })));

  let data = asFormData(family);
  const orphanedPhotos = [];

  for (const change of lines) {
    if (change.payload.kind === 'family' && change.payload.key === 'photo') {
      // The photograph being replaced, whatever the record actually holds now.
      if (data.photo && data.photo !== change.payload.photo) orphanedPhotos.push(data.photo);
    }
    data = fold(data, change.payload);
  }

  await Family.update(churchId, familyId, data);

  const at = db.now();
  await PendingChange.update(
    { applied_at: at },
    { where: { id: { [Op.in]: lines.map((l) => l.id) } } }
  );

  return { applied: lines.length, orphanedPhotos, at };
}

/**
 * Record an outcome against one or more lines, and apply the approved ones.
 *
 * Every line is decided on its own — that is the point of the screen — so this
 * takes a list of ids and one outcome, which is what both a single Approve
 * button and a batch approval of the routine tier need.
 */
async function decide(churchId, ids, { outcome, reason = '', user }) {
  const wanted = outcome === APPROVED ? APPROVED : REJECTED;
  const numeric = ids.map(Number).filter(Number.isInteger);
  if (!numeric.length) return { decided: 0, families: [], orphanedPhotos: [] };

  const rows = await PendingChange.findAll({
    where: { ...scope(churchId), id: { [Op.in]: numeric }, status: OPEN }
  });
  if (!rows.length) return { decided: 0, families: [], orphanedPhotos: [] };

  const lines = rows.map((row) => hydrate(row.get({ plain: true })));
  const at = db.now();

  await PendingChange.update({
    status: wanted,
    reviewed_by: user ? user.id : null,
    reviewed_by_name: user ? (user.full_name || user.username) : '',
    reviewed_at: at,
    // A reason belongs to a rejection; an approval that carried one would read
    // on the family's screen as an objection to a change that was accepted.
    reason: wanted === REJECTED ? String(reason || '').slice(0, 300) : ''
  }, {
    where: { id: { [Op.in]: lines.map((l) => l.id) } }
  });

  const families = [...new Set(lines.map((l) => l.family_id))];
  const orphanedPhotos = [];

  if (wanted === APPROVED) {
    for (const familyId of families) {
      const result = await applyApproved(churchId, familyId);
      orphanedPhotos.push(...result.orphanedPhotos);
    }
  } else {
    // A rejected photograph was uploaded and is on disk; nothing will ever
    // point at it, so it goes with the rejection.
    for (const l of lines) {
      if (l.payload.kind === 'family' && l.payload.key === 'photo' && l.payload.photo) {
        orphanedPhotos.push(l.payload.photo);
      }
    }
  }

  await closeSettledSubmissions(churchId, [...new Set(lines.map((l) => l.submission_id))]);

  return { decided: lines.length, families, orphanedPhotos, at };
}

/** A submission with no undecided lines left is closed. */
async function closeSettledSubmissions(churchId, submissionIds) {
  for (const id of submissionIds) {
    const open = await PendingChange.count({
      where: { ...scope(churchId), submission_id: id, status: OPEN }
    });
    if (!open) {
      await Submission.update({ status: 'closed' }, { where: { ...scope(churchId), id } });
    }
  }
}

/** Does this family still have anything waiting? Drives its status. */
async function familyHasOpen(churchId, familyId) {
  const n = await PendingChange.count({
    where: { ...scope(churchId), family_id: Number(familyId), status: OPEN }
  });
  return n > 0;
}

/**
 * The queue as a flat sheet, in the columns the Parish asked for.
 *
 * This doubles as the working paper for a review meeting — the queue can be
 * read on paper and cleared on screen — so it carries decided lines too, not
 * only the outstanding ones.
 */
async function exportRows(churchId, { status = '' } = {}) {
  const where = { ...scope(churchId) };
  if (status) where.status = status;

  const rows = await PendingChange.findAll({
    where,
    include: [
      {
        model: FamilyRow,
        as: 'family',
        required: true,
        attributes: ['family_id', 'head_name']
      },
      {
        model: Submission,
        as: 'submission',
        required: true,
        attributes: ['submitted_at', 'submitted_by_name', 'submitted_via']
      }
    ],
    order: [['id', 'ASC']]
  });

  return rows.map((row) => {
    const r = row.get({ plain: true });
    return {
      family_ref: r.family.family_id,
      family_head: r.family.head_name,
      field: r.label,
      existing_value: r.existing_value,
      proposed_value: r.proposed_value,
      submitted_by: r.submission.submitted_by_name +
        (r.submission.submitted_via === 'assisted' ? ' (assisted entry)' : ''),
      submitted_on: r.submission.submitted_at,
      reviewed_by: r.reviewed_by_name || '',
      status: r.status,
      reason: r.reason || ''
    };
  });
}

module.exports = {
  OPEN,
  APPROVED,
  REJECTED,
  SUPERSEDED,
  diff,
  submit,
  listQueue,
  queueByFamily,
  openCount,
  forFamily,
  findLine,
  decide,
  applyApproved,
  familyHasOpen,
  exportRows
};
