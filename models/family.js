'use strict';

const { Op, fn, col, where: whereFn } = require('sequelize');
const db = require('../db');
const dayMonth = require('../lib/daymonth');

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
      likeLower('Family.home_parish', term)
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

async function replaceMembers(familyId, members, transaction) {
  await Member.destroy({ where: { family_id: familyId }, transaction });
  if (!members.length) return;

  await Member.bulkCreate(
    members.map((m, i) => ({
      family_id: familyId,
      position: i,
      name: m.name,
      relation: m.relation,
      dob_day: m.dob_day,
      dob_month: m.dob_month,
      dob_year: m.dob_year,
      mobile: m.mobile,
      links: m.links
    })),
    { transaction }
  );
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

async function remove(churchId, id) {
  // The members go with it: Family hasMany Member with ON DELETE CASCADE.
  const removed = await Family.destroy({ where: { ...scope(churchId), id } });
  return removed > 0;
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

module.exports = {
  list,
  emails,
  withoutLogins,
  listWithMembers,
  findById,
  familyIdTaken,
  nextFamilyId,
  create,
  update,
  remove,
  stats,
  upcoming
};
