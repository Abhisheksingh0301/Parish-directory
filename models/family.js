'use strict';

const db = require('../db');
const dayMonth = require('../lib/daymonth');

/**
 * Families and their members.
 *
 * A family always carries its members with it — the printed directory renders
 * them as one block, and there is no screen that wants a member without its
 * family — so writes replace the whole member list inside one transaction.
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

function decorate(family, members) {
  return {
    ...family,
    is_published: !!family.is_published,
    dom: dayMonth.format(family.dom_day, family.dom_month),
    members: members.map((m) => ({
      ...m,
      dob: dayMonth.formatFull(m.dob_day, m.dob_month, m.dob_year)
    }))
  };
}

/**
 * Family IDs are text ("0001", "A-12") so parishes can keep their existing
 * numbering, but they should still sort the way a person expects. Ordering by
 * the numeric prefix first puts "9" before "10" while leaving odd IDs at the
 * end in alphabetical order.
 */
const orderBy = (col = 'family_id') => `
  ORDER BY
    CASE WHEN ${col} GLOB '[0-9]*' THEN 0 ELSE 1 END,
    CAST(${col} AS INTEGER),
    ${col} COLLATE NOCASE
`;

async function list({ search = '', publishedOnly = false } = {}) {
  const where = [];
  const params = [];

  if (publishedOnly) where.push('f.is_published = 1');

  if (search.trim()) {
    const term = `%${search.trim()}%`;
    where.push(`(
      f.family_id LIKE ? OR f.head_name LIKE ? OR f.address LIKE ?
      OR f.email LIKE ? OR f.hometown LIKE ? OR f.home_parish LIKE ?
      OR EXISTS (
        SELECT 1 FROM members m
        WHERE m.family_id = f.id AND (m.name LIKE ? OR m.mobile LIKE ?)
      )
    )`);
    params.push(term, term, term, term, term, term, term, term);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return db.all(
    `SELECT f.*,
            (SELECT COUNT(*) FROM members m WHERE m.family_id = f.id) AS member_count,
            u.id       AS login_id,
            u.username AS login_username,
            u.is_active AS login_active,
            u.on_default_password AS login_on_default_password,
            u.last_login_at AS login_last_seen
     FROM families f
     LEFT JOIN users u ON u.family_id = f.id
     ${clause}
     ${orderBy('f.family_id')}`,
    params
  );
}

/**
 * Every family email address, in printed-directory order, ready to be pasted
 * into the "To" line of one message to the whole parish.
 */
async function emails() {
  const rows = await db.all(
    `SELECT email FROM families WHERE TRIM(email) != '' ${orderBy()}`
  );
  return rows.map((r) => r.email.trim());
}

/** Families with an email address and no login yet — the ones an invite would reach. */
function withoutLogins() {
  return db.all(
    `SELECT f.id, f.family_id, f.head_name, f.email
     FROM families f
     LEFT JOIN users u ON u.family_id = f.id
     WHERE TRIM(f.email) != '' AND u.id IS NULL
     ${orderBy('f.family_id')}`
  );
}

/** Every family with its members, for the printed directory. */
async function listWithMembers({ publishedOnly = true } = {}) {
  const families = await db.all(
    `SELECT * FROM families ${publishedOnly ? 'WHERE is_published = 1' : ''} ${orderBy()}`
  );
  if (!families.length) return [];

  const members = await db.all(
    `SELECT * FROM members
     WHERE family_id IN (${families.map(() => '?').join(',')})
     ORDER BY family_id, position, id`,
    families.map((f) => f.id)
  );

  const byFamily = new Map(families.map((f) => [f.id, []]));
  for (const m of members) byFamily.get(m.family_id).push(m);

  return families.map((f) => decorate(f, byFamily.get(f.id)));
}

async function findById(id) {
  const family = await db.get('SELECT * FROM families WHERE id = ?', [id]);
  if (!family) return null;

  const members = await db.all(
    'SELECT * FROM members WHERE family_id = ? ORDER BY position, id',
    [id]
  );
  return decorate(family, members);
}

async function familyIdTaken(familyId, exceptId = null) {
  const row = await db.get(
    `SELECT id FROM families WHERE family_id = ? COLLATE NOCASE ${exceptId ? 'AND id != ?' : ''}`,
    exceptId ? [familyId, exceptId] : [familyId]
  );
  return !!row;
}

/** Suggest the next numeric family ID, keeping the width of existing IDs. */
async function nextFamilyId() {
  const row = await db.get(
    `SELECT family_id FROM families
     WHERE family_id GLOB '[0-9]*'
     ORDER BY CAST(family_id AS INTEGER) DESC LIMIT 1`
  );
  if (!row) return '0001';

  const next = String(Number(row.family_id) + 1);
  return next.padStart(Math.max(row.family_id.length, next.length), '0');
}

async function replaceMembers(familyId, members) {
  await db.run('DELETE FROM members WHERE family_id = ?', [familyId]);

  for (let i = 0; i < members.length; i += 1) {
    const m = members[i];
    await db.run(
      `INSERT INTO members
         (family_id, position, name, relation, dob_day, dob_month, dob_year, mobile, links)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [familyId, i, m.name, m.relation, m.dob_day, m.dob_month, m.dob_year, m.mobile, m.links]
    );
  }
}

async function create(data) {
  return db.tx(async () => {
    const result = await db.run(
      `INSERT INTO families
        (family_id, head_name, address, hometown, home_parish, spouse_home, email,
         photo, dom_day, dom_month, is_published)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ...FIELDS.map((f) => data[f]),
        data.photo || null,
        data.dom_day,
        data.dom_month,
        data.is_published ? 1 : 0
      ]
    );
    await replaceMembers(result.lastID, data.members);
    return result.lastID;
  });
}

async function update(id, data) {
  return db.tx(async () => {
    await db.run(
      `UPDATE families SET
         family_id = ?, head_name = ?, address = ?, hometown = ?, home_parish = ?,
         spouse_home = ?, email = ?, photo = ?, dom_day = ?, dom_month = ?,
         is_published = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [
        ...FIELDS.map((f) => data[f]),
        data.photo || null,
        data.dom_day,
        data.dom_month,
        data.is_published ? 1 : 0,
        id
      ]
    );
    await replaceMembers(id, data.members);
  });
}

async function remove(id) {
  // ON DELETE CASCADE clears the members (foreign_keys pragma is on).
  await db.run('DELETE FROM families WHERE id = ?', [id]);
}

async function stats() {
  const row = await db.get(`
    SELECT
      (SELECT COUNT(*) FROM families) AS families,
      (SELECT COUNT(*) FROM families WHERE is_published = 1) AS published,
      (SELECT COUNT(*) FROM members) AS members
  `);
  return row || { families: 0, published: 0, members: 0 };
}

/**
 * Upcoming birthdays and anniversaries within `days` of today, wrapping around
 * the end of the year. Purely day+month — no ages, because we don't store years.
 */
async function upcoming(days = 30) {
  const [members, families] = await Promise.all([
    db.all(`
      SELECT m.name, m.dob_day AS day, m.dob_month AS month, f.head_name, f.family_id, f.id AS fid
      FROM members m JOIN families f ON f.id = m.family_id
      WHERE m.dob_day IS NOT NULL AND m.dob_month IS NOT NULL
    `),
    db.all(`
      SELECT head_name, family_id, id AS fid, dom_day AS day, dom_month AS month
      FROM families
      WHERE dom_day IS NOT NULL AND dom_month IS NOT NULL
    `)
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

  const birthdays = members
    .map(withinWindow)
    .filter(Boolean)
    .map((r) => ({ ...r, kind: 'birthday' }));

  const anniversaries = families
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
