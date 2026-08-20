'use strict';

const { Op, fn, col, where: whereFn } = require('sequelize');
const db = require('../db');
const dayMonth = require('../lib/daymonth');
const verification = require('../lib/verification');

const { sequelize, Family, Member, User } = db;

/**
 * Families and their members.
 *
 * A family always carries its members with it — the printed directory renders
 * them as one block, and there is no screen that wants a member without its
 * family — so writes replace the whole member list inside one transaction.
 *
 * ── Every function here takes a church ─────────────────────────────────────
 * `churchId` is the first argument of everything, and it goes into the WHERE
 * clause rather than being compared against a row afterwards. That difference
 * is the whole of tenancy: a church administrator asking for another parish's
 * family by guessing an id gets nothing back, so the route sees a missing row
 * and 404s. There is no permission check to forget, because there is no
 * permission check — the query cannot see the other church.
 *
 * A few functions accept an array of church ids instead of one, for the super
 * administrator's cross-church reports. `scope()` handles both.
 *
 * Two other deliberate choices: ordering and the "next family ID" arithmetic
 * happen in JavaScript, because they used to be SQLite's GLOB and a lenient
 * CAST and PostgreSQL refuses to cast 'A-12' to an integer at all; and text
 * matching compares lower() on both sides rather than relying on COLLATE
 * NOCASE, which is SQLite's own spelling of the idea.
 */

const FIELDS = [
  'family_id',
  'head_name',
  'address',
  'hometown',
  'home_parish',
  'spouse_home',
  'prayer_group',
  'area',
  'email'
];

/** One church, or several. Refuses to build a query that reaches all of them. */
function scope(churchId) {
  if (Array.isArray(churchId)) {
    const ids = churchId.map(Number).filter(Number.isInteger);
    // An empty selection means "no churches", which must return nothing —
    // never everything.
    return { church_id: { [Op.in]: ids.length ? ids : [-1] } };
  }
  if (!Number.isInteger(Number(churchId))) {
    throw new Error('A church is required to read or write families.');
  }
  return { church_id: Number(churchId) };
}

/** Case-insensitive LIKE that means the same thing on every engine. */
function likeLower(column, term) {
  return whereFn(fn('lower', col(column)), { [Op.like]: term.toLowerCase() });
}

/**
 * Family IDs are text ("0001", "A-12") so parishes can keep their existing
 * numbering, but they should still sort the way a person expects: numeric ones
 * first and in numeric order, so "9" comes before "10", with anything else
 * after them alphabetically.
 */
function byFamilyId(a, b) {
  const aId = String(a.family_id || '');
  const bId = String(b.family_id || '');
  const aNum = /^\d/.test(aId);
  const bNum = /^\d/.test(bId);

  if (aNum !== bNum) return aNum ? -1 : 1;
  if (aNum && bNum) {
    const diff = parseInt(aId, 10) - parseInt(bId, 10);
    if (diff !== 0) return diff;
  }
  return aId.localeCompare(bId, undefined, { sensitivity: 'base' });
}

function decorate(family, members) {
  return {
    ...family,
    is_published: !!family.is_published,
    // Where the photograph is served from. Built here so no view has to know
    // that the path carries the church, and so it changes in one place.
    photo_url: family.photo ? `/uploads/${family.church_id}/${family.photo}` : null,
    dom: dayMonth.format(family.dom_day, family.dom_month),
    members: members.map((m) => ({
      ...m,
      dob: dayMonth.formatFull(m.dob_day, m.dob_month, m.dob_year)
    }))
  };
}

/** Family ids whose members match a search term, within this church. */
async function familyIdsMatchingMembers(churchId, term) {
  const rows = await Member.findAll({
    attributes: ['family_id'],
    where: { [Op.or]: [likeLower('Member.name', term), likeLower('Member.mobile', term)] },
    include: [{ model: Family, as: 'family', attributes: [], required: true, where: scope(churchId) }],
    raw: true
  });
  return [...new Set(rows.map((r) => r.family_id))];
}

/** How many members each of these families has. */
async function memberCounts(familyIds) {
  if (!familyIds.length) return new Map();
  const rows = await Member.findAll({
    attributes: ['family_id', [fn('COUNT', col('id')), 'n']],
    where: { family_id: { [Op.in]: familyIds } },
    group: ['family_id'],
    raw: true
  });
  return new Map(rows.map((r) => [r.family_id, Number(r.n)]));
}

async function list(churchId, { search = '', publishedOnly = false } = {}) {
  const where = { ...scope(churchId) };
  if (publishedOnly) where.is_published = true;

  if (search.trim()) {
    const term = `%${search.trim()}%`;
    const matches = [
      likeLower('Family.family_id', term),
      likeLower('Family.head_name', term),
      likeLower('Family.address', term),
      likeLower('Family.email', term),
      likeLower('Family.hometown', term),
      likeLower('Family.home_parish', term),
      likeLower('Family.prayer_group', term),
      likeLower('Family.area', term)
    ];

    // Members are matched with their own query rather than a correlated
    // subquery: one extra round trip, and no raw SQL to carry between engines.
    const memberFamilyIds = await familyIdsMatchingMembers(churchId, term);
    if (memberFamilyIds.length) matches.push({ id: { [Op.in]: memberFamilyIds } });

    where[Op.or] = matches;
  }

  const families = await Family.findAll({
    where,
    include: [{
      model: User,
      as: 'login',
      required: false,
      attributes: ['id', 'username', 'is_active', 'on_default_password', 'last_login_at']
    }]
  });

  const counts = await memberCounts(families.map((f) => f.id));

  return families
    .map((row) => {
      const family = row.get({ plain: true });
      const login = family.login || null;
      delete family.login;

      return {
        ...family,
        member_count: counts.get(family.id) || 0,
        login_id: login ? login.id : null,
        login_username: login ? login.username : null,
        login_active: login ? login.is_active : null,
        login_on_default_password: login ? login.on_default_password : null,
        login_last_seen: login ? login.last_login_at : null
      };
    })
    .sort(byFamilyId);
}

/**
 * Every family email address in this church, in printed-directory order, ready
 * to be pasted into the "To" line of one message to the whole parish.
 */
async function emails(churchId) {
  const rows = await Family.findAll({
    attributes: ['family_id', 'email'],
    where: { ...scope(churchId), email: { [Op.ne]: '' } },
    raw: true
  });

  return rows
    .filter((r) => String(r.email).trim())
    .sort(byFamilyId)
    .map((r) => r.email.trim());
}

/** Families with an email address and no login yet — the ones an invite reaches. */
async function withoutLogins(churchId) {
  const rows = await Family.findAll({
    attributes: ['id', 'family_id', 'head_name', 'email'],
    where: { ...scope(churchId), email: { [Op.ne]: '' } },
    include: [{ model: User, as: 'login', required: false, attributes: ['id'] }]
  });

  return rows
    .map((row) => row.get({ plain: true }))
    .filter((f) => !f.login && String(f.email).trim())
    .map(({ login, ...family }) => family) // eslint-disable-line no-unused-vars
    .sort(byFamilyId);
}

/**
 * Every family with its members, for the printed directory.
 * `churchId` may be an array — one book covering several parishes.
 */
async function listWithMembers(churchId, { publishedOnly = true } = {}) {
  const where = { ...scope(churchId) };
  if (publishedOnly) where.is_published = true;

  const rows = await Family.findAll({
    where,
    include: [{ model: Member, as: 'members', required: false }],
    order: [[{ model: Member, as: 'members' }, 'position', 'ASC'],
      [{ model: Member, as: 'members' }, 'id', 'ASC']]
  });

  return rows
    .map((row) => row.get({ plain: true }))
    .sort(byFamilyId)
    .map((family) => {
      const { members, ...rest } = family;
      return decorate(rest, members || []);
    });
}

/**
 * One family, if it belongs to this church.
 *
 * The church is part of the lookup, not a check afterwards — another parish's
 * id simply does not match, and the route treats it as missing.
 */
async function findById(churchId, id) {
  const row = await Family.findOne({
    where: { ...scope(churchId), id },
    include: [{ model: Member, as: 'members', required: false }],
    order: [[{ model: Member, as: 'members' }, 'position', 'ASC'],
      [{ model: Member, as: 'members' }, 'id', 'ASC']]
  });
  if (!row) return null;

  const { members, ...family } = row.get({ plain: true });
  return decorate(family, members || []);
}

/**
 * Is this reference already used by another family *in this church*?
 *
 * Two parishes both numbering from "0001" is normal, so the question is only
 * ever asked within one. Case-insensitively: "a-12" and "A-12" are the same
 * reference to everybody except a database.
 */
async function familyIdTaken(churchId, familyId, exceptId = null) {
  const where = {
    ...scope(churchId),
    [Op.and]: [whereFn(fn('lower', col('family_id')), String(familyId).toLowerCase())]
  };
  if (exceptId) where.id = { [Op.ne]: exceptId };

  return (await Family.count({ where })) > 0;
}

/**
 * One family by the parish's own reference, within one church.
 *
 * This is how the Family ID and PIN sign-in finds a household: the ID is
 * unique within a parish and nowhere else, so the church is half the lookup
 * rather than a check afterwards. Case-insensitively, because "a-12" and
 * "A-12" are the same reference to everybody except a database.
 */
async function findByRef(churchId, familyRef) {
  const row = await Family.findOne({
    where: {
      ...scope(churchId),
      [Op.and]: [whereFn(fn('lower', col('family_id')), String(familyRef || '').trim().toLowerCase())]
    },
    raw: true
  });
  return row || null;
}

/** Suggest the next numeric family ID for this church, keeping the ID width. */
async function nextFamilyId(churchId) {
  const rows = await Family.findAll({
    attributes: ['family_id'],
    where: scope(churchId),
    raw: true
  });

  const numeric = rows
    .map((r) => String(r.family_id))
    .filter((value) => /^\d+$/.test(value));

  if (!numeric.length) return '0001';

  const widest = numeric.reduce((a, b) => (Number(a) >= Number(b) ? a : b));
  const next = String(Number(widest) + 1);
  return next.padStart(Math.max(widest.length, next.length), '0');
}

const MEMBER_COLUMNS = [
  'name', 'relation', 'dob_day', 'dob_month', 'dob_year',
  'mobile', 'blood_group', 'qualification', 'occupation', 'links'
];

function memberValues(m, position) {
  const values = { position };
  for (const column of MEMBER_COLUMNS) values[column] = m[column];
  return values;
}

/**
 * Write the member list, keeping the rows that were already there.
 *
 * This used to delete every member and insert the list again, which was
 * simpler and was fine while nothing outside the family referred to a member.
 * A pending change does: it names the member whose mobile number is proposed,
 * and it may sit in the queue for a fortnight while the parish office edits
 * the same family for other reasons. Recreating the rows would renumber them,
 * and the approval would land on somebody else — or on nobody.
 *
 * So a member the form sends back with its own id is updated in place; one
 * without is new; one that has stopped being sent has been removed. An id the
 * form invents for a member of another family is ignored rather than obeyed,
 * because the ids that count are the ones already in this family.
 */
async function replaceMembers(familyId, members, transaction) {
  const existing = await Member.findAll({
    attributes: ['id'],
    where: { family_id: familyId },
    transaction,
    raw: true
  });
  const known = new Set(existing.map((r) => r.id));

  const kept = new Set();
  const fresh = [];

  for (let i = 0; i < members.length; i += 1) {
    const m = members[i];
    const id = Number(m.id);

    if (Number.isInteger(id) && known.has(id)) {
      kept.add(id);
      await Member.update(memberValues(m, i), { where: { id, family_id: familyId }, transaction });
    } else {
      fresh.push({ ...memberValues(m, i), family_id: familyId });
    }
  }

  const gone = [...known].filter((id) => !kept.has(id));
  if (gone.length) {
    await Member.destroy({ where: { id: { [Op.in]: gone }, family_id: familyId }, transaction });
  }

  if (fresh.length) await Member.bulkCreate(fresh, { transaction });
}

function writableFields(data) {
  const values = {};
  for (const field of FIELDS) values[field] = data[field];
  values.photo = data.photo || null;
  values.dom_day = data.dom_day;
  values.dom_month = data.dom_month;
  values.is_published = !!data.is_published;
  return values;
}

async function create(churchId, data) {
  const { church_id: owner } = scope(churchId);

  return sequelize.transaction(async (transaction) => {
    const family = await Family.create({
      ...writableFields(data),
      church_id: owner,
      created_at: db.now(),
      updated_at: db.now()
    }, { transaction });

    await replaceMembers(family.id, data.members, transaction);
    return family.id;
  });
}

/** Update, but only if the family is this church's. Returns false if it is not. */
async function update(churchId, id, data) {
  return sequelize.transaction(async (transaction) => {
    const [changed] = await Family.update(
      { ...writableFields(data), updated_at: db.now() },
      { where: { ...scope(churchId), id }, transaction }
    );
    if (!changed) {
      // Either it does not exist or it is not ours; the caller cannot tell the
      // difference, and should not be able to.
      const exists = await Family.count({ where: { ...scope(churchId), id }, transaction });
      if (!exists) return false;
    }
    await replaceMembers(id, data.members, transaction);
    return true;
  });
}

/**
 * Delete a family, and everything that only exists because it does.
 *
 * The children are deleted here rather than left to the database, and the
 * reason is worth writing down.
 *
 * `members` was created with ON DELETE CASCADE in migration 1, but adding a
 * column to it in SQLite rebuilds the table, and the rebuild does not carry
 * the cascade across — so on any directory that has run migration 5 the
 * constraint is NO ACTION, and `DELETE FROM families` fails outright with a
 * foreign key error rather than taking its members with it. Deleting a family
 * has been quietly impossible since.
 *
 * Repairing that would mean rebuilding `members` in place, which is the exact
 * operation the header of db/migrations.js warns about. Doing it in one
 * transaction here fixes every existing directory without touching the schema,
 * works the same on every engine whatever its constraints happen to say, and
 * covers the two tables added since — a proposal waiting on a family that no
 * longer exists can never be reviewed.
 */
async function remove(churchId, id) {
  const { church_id: owner } = scope(churchId);

  return sequelize.transaction(async (transaction) => {
    const family = await Family.findOne({
      attributes: ['id'],
      where: { church_id: owner, id },
      transaction,
      raw: true
    });
    if (!family) return false;

    const where = { family_id: family.id };
    await db.PendingChange.destroy({ where, transaction });
    await db.Submission.destroy({ where, transaction });
    await Member.destroy({ where, transaction });
    // The household's own login, which reaches this family and nothing else.
    await User.destroy({ where, transaction });

    await Family.destroy({ where: { church_id: owner, id: family.id }, transaction });
    return true;
  });
}

async function stats(churchId) {
  const where = scope(churchId);

  const [families, published, members] = await Promise.all([
    Family.count({ where }),
    Family.count({ where: { ...where, is_published: true } }),
    Member.count({
      include: [{ model: Family, as: 'family', attributes: [], required: true, where }]
    })
  ]);
  return { families, published, members };
}

/**
 * How many families have a photograph on record.
 *
 * Counted from the rows, not from the folder on disk: the export names each
 * image after its family, so a file with no row pointing at it is not part of
 * this parish's data and would not go into the archive either.
 */
async function photoCount(churchId) {
  return Family.count({
    where: { ...scope(churchId), photo: { [Op.ne]: null } }
  });
}

/**
 * Upcoming birthdays and anniversaries within `days` of today, wrapping around
 * the end of the year. Purely day+month — no ages, because we don't store years.
 *
 * Scoped, and it matters more here than anywhere: this reads every dated row
 * into memory and filters in JavaScript. For one parish that is a few hundred
 * rows; across two hundred churches it would be a hundred and sixty thousand.
 */
async function upcoming(churchId, days = 30) {
  const where = scope(churchId);

  const [memberRows, familyRows] = await Promise.all([
    Member.findAll({
      attributes: ['name', 'dob_day', 'dob_month', 'family_id'],
      where: { dob_day: { [Op.ne]: null }, dob_month: { [Op.ne]: null } },
      include: [{
        model: Family,
        as: 'family',
        attributes: ['head_name', 'family_id', 'id'],
        required: true,
        where
      }]
    }),
    Family.findAll({
      attributes: ['head_name', 'family_id', 'id', 'dom_day', 'dom_month'],
      where: { ...where, dom_day: { [Op.ne]: null }, dom_month: { [Op.ne]: null } },
      raw: true
    })
  ]);

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  /** Days until the next occurrence of this day+month, or null if outside the window. */
  const withinWindow = (row) => {
    let next = new Date(today.getFullYear(), row.month - 1, row.day);

    // 29 Feb in a non-leap year: JS rolls it to 1 Mar, which is where most
    // parishes mark it anyway. Roll to next year once the date has passed.
    if (next < today) next = new Date(today.getFullYear() + 1, row.month - 1, row.day);

    const inDays = Math.round((next - today) / MS_PER_DAY);
    return inDays <= days ? { ...row, inDays, label: dayMonth.format(row.day, row.month) } : null;
  };

  const birthdays = memberRows
    .map((row) => {
      const m = row.get({ plain: true });
      return {
        name: m.name,
        day: m.dob_day,
        month: m.dob_month,
        head_name: m.family.head_name,
        family_id: m.family.family_id,
        fid: m.family.id
      };
    })
    .map(withinWindow)
    .filter(Boolean)
    .map((r) => ({ ...r, kind: 'birthday' }));

  const anniversaries = familyRows
    .map((f) => ({
      head_name: f.head_name,
      family_id: f.family_id,
      fid: f.id,
      day: f.dom_day,
      month: f.dom_month
    }))
    .map(withinWindow)
    .filter(Boolean)
    .map((r) => ({ ...r, kind: 'anniversary', name: r.head_name }));

  return [...birthdays, ...anniversaries].sort((a, b) => a.inDays - b.inDays);
}

// ---------------------------------------------------------------------------
// Where each family has got to in the verification exercise
// ---------------------------------------------------------------------------

/**
 * Move a family along the chain.
 *
 * The chain itself and the forward-only rule live in lib/verification.js; this
 * only writes the answer. Passing the current status in avoids a second read
 * when the caller already has the row.
 */
async function setStatus(churchId, id, wanted, { current = null, transaction = null } = {}) {
  let from = current;
  if (from === null) {
    const row = await Family.findOne({
      attributes: ['verify_status'],
      where: { ...scope(churchId), id },
      transaction,
      raw: true
    });
    if (!row) return null;
    from = row.verify_status;
  }

  const to = verification.nextStatus(from, wanted);
  if (to === from) return to;

  const values = { verify_status: to, verify_status_at: db.now() };
  if (to === 'invitation_sent') values.invited_at = db.now();
  if (to === 'printed') values.printed_at = db.now();

  await Family.update(values, { where: { ...scope(churchId), id }, transaction });
  return to;
}

/** The same, for a whole batch — the office marking invitations sent or a run printed. */
async function setStatusMany(churchId, ids, wanted) {
  if (!ids.length) return 0;

  const rows = await Family.findAll({
    attributes: ['id', 'verify_status'],
    where: { ...scope(churchId), id: { [Op.in]: ids.map(Number) } },
    raw: true
  });

  let moved = 0;
  for (const row of rows) {
    const to = verification.nextStatus(row.verify_status, wanted);
    if (to === row.verify_status) continue;
    await setStatus(churchId, row.id, wanted, { current: row.verify_status });
    moved += 1;
  }
  return moved;
}

/** Narrow a status view to one Area or one Prayer Group. */
function areaWhere({ area = '', prayerGroup = '' } = {}) {
  const where = {};
  if (String(area).trim()) {
    where[Op.and] = [whereFn(fn('lower', col('area')), String(area).trim().toLowerCase())];
  }
  if (String(prayerGroup).trim()) {
    const clause = whereFn(fn('lower', col('prayer_group')), String(prayerGroup).trim().toLowerCase());
    where[Op.and] = where[Op.and] ? [...where[Op.and], clause] : [clause];
  }
  return where;
}

/**
 * How many families sit at each status, so the dashboard can say "17 families
 * still not started" and have that number click through to their names.
 *
 * Every status is present in the answer even at zero — a missing key would
 * read on the dashboard as a step that does not exist.
 */
async function statusCounts(churchId, filter = {}) {
  const rows = await Family.findAll({
    attributes: ['verify_status', [fn('COUNT', col('id')), 'n']],
    where: { ...scope(churchId), ...areaWhere(filter) },
    group: ['verify_status'],
    raw: true
  });

  const counts = Object.fromEntries(verification.STATUS_KEYS.map((key) => [key, 0]));
  let total = 0;
  for (const row of rows) {
    const key = verification.isStatus(row.verify_status) ? row.verify_status : 'not_started';
    counts[key] += Number(row.n);
    total += Number(row.n);
  }
  return { counts, total };
}

/**
 * The families behind one of those numbers, in printed-directory order.
 *
 * This is also the printable follow-up sheet an Area Representative carries:
 * Family ID, family head, a contact number and the current status. The number
 * is the first one any member of the household has recorded, because a sheet
 * with an empty phone column is no use to the person walking the Area.
 */
async function listByStatus(churchId, { status = '', area = '', prayerGroup = '' } = {}) {
  const where = { ...scope(churchId), ...areaWhere({ area, prayerGroup }) };
  if (verification.isStatus(status)) where.verify_status = status;

  const rows = await Family.findAll({
    where,
    attributes: [
      'id', 'family_id', 'head_name', 'area', 'prayer_group', 'email',
      'verify_status', 'verify_status_at', 'is_published'
    ],
    include: [{
      model: Member,
      as: 'members',
      required: false,
      attributes: ['mobile', 'position']
    }],
    order: [[{ model: Member, as: 'members' }, 'position', 'ASC']]
  });

  return rows
    .map((row) => {
      const { members, ...family } = row.get({ plain: true });
      const contact = (members || []).map((m) => String(m.mobile || '').trim()).find(Boolean);
      return {
        ...family,
        contact: contact || '',
        status_label: verification.statusLabel(family.verify_status)
      };
    })
    .sort(byFamilyId);
}

/** The Areas and Prayer Groups this church actually uses, for the filter menus. */
async function groupings(churchId) {
  const rows = await Family.findAll({
    attributes: ['area', 'prayer_group'],
    where: scope(churchId),
    raw: true
  });

  const tidy = (key) => [...new Set(rows.map((r) => String(r[key] || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  return { areas: tidy('area'), prayerGroups: tidy('prayer_group') };
}

/** Every family id in this church, for a batch the office is about to mark. */
async function idsIn(churchId, filter = {}) {
  const where = { ...scope(churchId), ...areaWhere(filter) };
  if (verification.isStatus(filter.status)) where.verify_status = filter.status;
  if (filter.publishedOnly) where.is_published = true;

  const rows = await Family.findAll({ attributes: ['id'], where, raw: true });
  return rows.map((r) => r.id);
}

module.exports = {
  list,
  emails,
  withoutLogins,
  setStatus,
  setStatusMany,
  statusCounts,
  listByStatus,
  groupings,
  idsIn,
  listWithMembers,
  findById,
  findByRef,
  familyIdTaken,
  nextFamilyId,
  create,
  update,
  remove,
  stats,
  photoCount,
  upcoming
};
