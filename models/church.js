'use strict';

const { Op, fn, col, where: whereFn } = require('sequelize');
const db = require('../db');
const config = require('../config');
const { uniqueSlug } = require('../lib/slug');

const { sequelize, Diocese, Zone, Church, Family, User } = db;

/**
 * The hierarchy above a parish: diocese → zone → church.
 *
 * Only grouping lives here. A family is owned by its church and by nothing
 * else — `families.church_id` is the whole of tenancy, and no query in this
 * file changes who owns what.
 *
 * ── The one invariant ──────────────────────────────────────────────────────
 * `churches.diocese_id` is stored rather than reached through the zone, so a
 * parish whose zone is not yet decided still belongs somewhere, and so that
 * "every church in this diocese" stays one indexed predicate. The price is
 * that the two columns could contradict each other: a church in diocese A
 * carrying a zone that belongs to diocese B.
 *
 * No database can express that rule — SQLite has no CHECK that can reach
 * another table — so it is enforced here, in `assertZoneBelongsToDiocese`,
 * and this module is the only thing allowed to set either column.
 */

class HierarchyError extends Error {}

/** Reject a zone that belongs to a different diocese than the church does. */
async function assertZoneBelongsToDiocese(zoneId, dioceseId, transaction) {
  if (zoneId === null || zoneId === undefined || zoneId === '') return null;

  const zone = await Zone.findByPk(Number(zoneId), { transaction });
  if (!zone) throw new HierarchyError('That zone no longer exists.');

  if (Number(zone.diocese_id) !== Number(dioceseId)) {
    throw new HierarchyError(
      `"${zone.name}" belongs to a different diocese, so this church cannot be put in it.`
    );
  }
  return zone.id;
}

const nameMatches = (name) =>
  whereFn(fn('lower', col('name')), String(name || '').trim().toLowerCase());

// ---------------------------------------------------------------------------
// Dioceses
// ---------------------------------------------------------------------------

/** Every diocese, with how many zones and churches it holds. */
async function listDioceses() {
  const [dioceses, zoneCounts, churchCounts] = await Promise.all([
    Diocese.findAll({ order: [['name', 'ASC']], raw: true }),
    Zone.findAll({
      attributes: ['diocese_id', [fn('COUNT', col('id')), 'n']],
      group: ['diocese_id'],
      raw: true
    }),
    Church.findAll({
      attributes: ['diocese_id', [fn('COUNT', col('id')), 'n']],
      group: ['diocese_id'],
      raw: true
    })
  ]);

  const zones = new Map(zoneCounts.map((r) => [r.diocese_id, Number(r.n)]));
  const churches = new Map(churchCounts.map((r) => [r.diocese_id, Number(r.n)]));

  return dioceses.map((d) => ({
    ...d,
    zone_count: zones.get(d.id) || 0,
    church_count: churches.get(d.id) || 0
  }));
}

function findDiocese(id) {
  return Diocese.findByPk(id);
}

async function createDiocese(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new HierarchyError('A diocese needs a name.');
  if (await Diocese.count({ where: nameMatches(trimmed) })) {
    throw new HierarchyError(`There is already a diocese called "${trimmed}".`);
  }
  return Diocese.create({ name: trimmed, created_at: db.now() });
}

/**
 * Rename a diocese, and optionally set what it calls itself and its zones.
 *
 * A blank label is stored as NULL rather than as an empty string, so it falls
 * back to the installation default instead of printing nothing.
 */
async function renameDiocese(id, name, { dioceseLabel, zoneLabel } = {}) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new HierarchyError('A diocese needs a name.');

  const clash = await Diocese.count({
    where: { [Op.and]: [nameMatches(trimmed), { id: { [Op.ne]: id } }] }
  });
  if (clash) throw new HierarchyError(`There is already a diocese called "${trimmed}".`);

  const values = { name: trimmed };
  if (dioceseLabel !== undefined) values.diocese_label = String(dioceseLabel || '').trim() || null;
  if (zoneLabel !== undefined) values.zone_label = String(zoneLabel || '').trim() || null;

  return Diocese.update(values, { where: { id } });
}

function setDioceseActive(id, isActive) {
  return Diocese.update({ is_active: !!isActive }, { where: { id } });
}

/**
 * Deleting a diocese is refused while it still holds churches. Deactivating is
 * the reversible thing to do, and losing a diocese should never be a way to
 * lose parishes by accident.
 */
async function removeDiocese(id) {
  const churches = await Church.count({ where: { diocese_id: id } });
  if (churches) {
    throw new HierarchyError(
      `This diocese still has ${churches} ${churches === 1 ? 'church' : 'churches'}. ` +
      'Move them elsewhere first, or deactivate the diocese instead of deleting it.'
    );
  }
  await Zone.destroy({ where: { diocese_id: id } });
  return Diocese.destroy({ where: { id } });
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/** Every zone, grouped under its diocese, with a church count each. */
async function listZones() {
  const [zones, counts] = await Promise.all([
    Zone.findAll({
      include: [{ model: Diocese, as: 'diocese', attributes: ['id', 'name'] }],
      order: [[{ model: Diocese, as: 'diocese' }, 'name', 'ASC'], ['name', 'ASC']]
    }),
    Church.findAll({
      attributes: ['zone_id', [fn('COUNT', col('id')), 'n']],
      where: { zone_id: { [Op.ne]: null } },
      group: ['zone_id'],
      raw: true
    })
  ]);

  const byZone = new Map(counts.map((r) => [r.zone_id, Number(r.n)]));

  return zones.map((row) => {
    const zone = row.get({ plain: true });
    return {
      ...zone,
      diocese_name: zone.diocese ? zone.diocese.name : null,
      church_count: byZone.get(zone.id) || 0
    };
  });
}

/** The zones a church in this diocese may be put in. */
function listZonesInDiocese(dioceseId) {
  return Zone.findAll({
    where: { diocese_id: dioceseId },
    order: [['name', 'ASC']],
    raw: true
  });
}

function findZone(id) {
  return Zone.findByPk(id);
}

async function createZone(dioceseId, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new HierarchyError('A zone needs a name.');

  if (!(await Diocese.findByPk(dioceseId))) {
    throw new HierarchyError('Choose the diocese this zone belongs to.');
  }
  const clash = await Zone.count({
    where: { [Op.and]: [nameMatches(trimmed), { diocese_id: dioceseId }] }
  });
  if (clash) {
    throw new HierarchyError(`That diocese already has a zone called "${trimmed}".`);
  }

  return Zone.create({ diocese_id: dioceseId, name: trimmed, created_at: db.now() });
}

async function renameZone(id, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new HierarchyError('A zone needs a name.');

  const zone = await Zone.findByPk(id);
  if (!zone) throw new HierarchyError('That zone no longer exists.');

  const clash = await Zone.count({
    where: {
      [Op.and]: [nameMatches(trimmed), { diocese_id: zone.diocese_id, id: { [Op.ne]: id } }]
    }
  });
  if (clash) throw new HierarchyError(`That diocese already has a zone called "${trimmed}".`);

  return Zone.update({ name: trimmed }, { where: { id } });
}

/**
 * Dissolving a zone leaves its churches unzoned. It must never remove a
 * parish, which is why churches.zone_id is ON DELETE SET NULL — this is only
 * the explicit version of the same promise.
 */
async function removeZone(id) {
  return sequelize.transaction(async (transaction) => {
    await Church.update({ zone_id: null }, { where: { zone_id: id }, transaction });
    return Zone.destroy({ where: { id }, transaction });
  });
}

// ---------------------------------------------------------------------------
// Churches
// ---------------------------------------------------------------------------

function decorateChurch(row) {
  const church = row.get ? row.get({ plain: true }) : row;
  return {
    ...church,
    diocese_name: church.diocese ? church.diocese.name : null,
    zone_name: church.zone ? church.zone.name : null,
    // Kept whole so callers can ask lib/settings.labels() about it.
    diocese: church.diocese || null
  };
}

const withParents = [
  // The labels come along, so a page about one church can name its tier the
  // way that church's denomination does.
  {
    model: Diocese,
    as: 'diocese',
    attributes: ['id', 'name', 'diocese_label', 'zone_label'],
    required: false
  },
  { model: Zone, as: 'zone', attributes: ['id', 'name'], required: false }
];

/**
 * Churches, filtered and counted for the console.
 *
 * Two hundred of them is too many for one flat list, so name and city are
 * searchable and the diocese and zone are selectable.
 */
async function listChurches({ search = '', dioceseId = null, zoneId = null } = {}) {
  const where = {};
  if (dioceseId) where.diocese_id = dioceseId;
  if (zoneId) where.zone_id = zoneId;

  if (String(search).trim()) {
    const term = `%${String(search).trim().toLowerCase()}%`;
    where[Op.or] = [
      whereFn(fn('lower', col('Church.name')), { [Op.like]: term }),
      whereFn(fn('lower', col('Church.city')), { [Op.like]: term })
    ];
  }

  const [churches, familyCounts] = await Promise.all([
    Church.findAll({ where, include: withParents, order: [['name', 'ASC']] }),
    Family.findAll({
      attributes: ['church_id', [fn('COUNT', col('id')), 'n']],
      group: ['church_id'],
      raw: true
    })
  ]);

  const byChurch = new Map(familyCounts.map((r) => [r.church_id, Number(r.n)]));

  return churches.map((row) => {
    const church = decorateChurch(row);
    return { ...church, family_count: byChurch.get(church.id) || 0 };
  });
}

/**
 * Every church name, for the "Home parish" suggestions on the family form.
 *
 * A household's home parish is usually not the parish they now attend — it is
 * the one they came from, anywhere in the church — so this is deliberately the
 * whole installation rather than anything scoped to the current church.
 *
 * Names only, and no counts: this runs on every render of the family form, and
 * listChurches() would join families and count them to answer a question the
 * form never asks.
 */
function listNames() {
  return Church.findAll({
    attributes: ['name'],
    where: { is_active: true },
    order: [['name', 'ASC']],
    raw: true
  }).then((rows) => rows.map((r) => r.name));
}

async function findChurch(id) {
  const row = await Church.findByPk(id, { include: withParents });
  return row ? decorateChurch(row) : null;
}

async function findChurchBySlug(slug) {
  const row = await Church.findOne({ where: { slug }, include: withParents });
  return row ? decorateChurch(row) : null;
}

/** Churches for a selection: the ones given, or every church in these zones or dioceses. */
async function idsFor({ churchIds = [], zoneIds = [], dioceseIds = [], activeOnly = true } = {}) {
  const matches = [];
  if (churchIds.length) matches.push({ id: { [Op.in]: churchIds } });
  if (zoneIds.length) matches.push({ zone_id: { [Op.in]: zoneIds } });
  // Diocese is a stored column, so this needs no join through zones — and it
  // picks up churches that have no zone yet, which is the point of storing it.
  if (dioceseIds.length) matches.push({ diocese_id: { [Op.in]: dioceseIds } });

  if (!matches.length) return [];

  const where = { [Op.or]: matches };
  if (activeOnly) where.is_active = true;

  const rows = await Church.findAll({ attributes: ['id'], where, raw: true });
  return rows.map((r) => r.id);
}

async function allActiveIds() {
  const rows = await Church.findAll({
    attributes: ['id'], where: { is_active: true }, raw: true
  });
  return rows.map((r) => r.id);
}

/**
 * The diocese a church gets when nobody is asked to choose one.
 *
 * Church creation no longer makes a super administrator set up a diocese and
 * zone before they can add their first church — most installs run one church
 * at a time, and the hierarchy only matters once there are several. Every
 * church still needs a diocese_id (see the note above `assertZoneBelongsToDiocese`),
 * so this hands back the first diocese that already exists, or creates one
 * named from the installation's seed default the first time it is needed.
 */
async function defaultDiocese(transaction = null) {
  const existing = await Diocese.findOne({ order: [['id', 'ASC']], transaction });
  if (existing) return existing;
  return Diocese.create(
    { name: config.seed.dioceseName, created_at: db.now() },
    { transaction }
  );
}

/**
 * Create a church.
 *
 * The zone is checked against the diocese before anything is written — this is
 * the invariant this module exists to hold. A diocese is optional here: leave
 * it out and the church lands in `defaultDiocese()` instead, which is how a
 * church gets created without anyone picking one.
 */
async function createChurch({ name, city = '', dioceseId = null, zoneId = null } = {}, transaction = null) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new HierarchyError('A church needs a name.');

  const diocese = dioceseId
    ? await Diocese.findByPk(dioceseId, { transaction })
    : await defaultDiocese(transaction);
  if (!diocese) throw new HierarchyError('Choose the diocese this church belongs to.');

  const checkedZoneId = await assertZoneBelongsToDiocese(zoneId, diocese.id, transaction);

  const slug = await uniqueSlug(trimmed, async (candidate) =>
    (await Church.count({ where: { slug: candidate }, transaction })) > 0);

  const church = await Church.create({
    diocese_id: diocese.id,
    zone_id: checkedZoneId,
    name: trimmed,
    slug,
    city: String(city || '').trim(),
    created_at: db.now()
  }, { transaction });

  // A new church inherits every default except the two that are obviously its
  // own. Writing only these means changing a house default later still reaches
  // churches that never overrode it — that is the point of the two layers.
  await db.ChurchSetting.bulkCreate([
    { church_id: church.id, key: 'parish_name', value: trimmed },
    { church_id: church.id, key: 'directory_title', value: db.DEFAULT_SETTINGS.directory_title }
  ], { transaction });

  return church;
}

async function updateChurch(id, { name, city, dioceseId, zoneId }) {
  const church = await Church.findByPk(id);
  if (!church) throw new HierarchyError('That church no longer exists.');

  const trimmed = String(name || '').trim();
  if (!trimmed) throw new HierarchyError('A church needs a name.');

  const targetDiocese = dioceseId === undefined ? church.diocese_id : Number(dioceseId);
  if (!(await Diocese.findByPk(targetDiocese))) {
    throw new HierarchyError('Choose the diocese this church belongs to.');
  }

  // Moving a church to another diocese abandons a zone that belonged to the
  // old one — silently keeping it is exactly the contradiction this guards.
  const requestedZone = zoneId === undefined ? church.zone_id : zoneId;
  const checkedZoneId = await assertZoneBelongsToDiocese(requestedZone, targetDiocese, null);

  return Church.update({
    name: trimmed,
    city: city === undefined ? church.city : String(city || '').trim(),
    diocese_id: targetDiocese,
    zone_id: checkedZoneId
  }, { where: { id } });
}

function setChurchActive(id, isActive) {
  return Church.update({ is_active: !!isActive }, { where: { id } });
}

/**
 * Move several churches at once.
 *
 * Rare — a zone is reorganised every few years, a diocese splits less often
 * than that — but when it happens it touches ten to eighty parishes, and doing
 * that one edit form at a time is an afternoon nobody should spend.
 */
async function reassign(churchIds, { dioceseId, zoneId = null }) {
  if (!churchIds.length) return 0;

  const diocese = await Diocese.findByPk(dioceseId);
  if (!diocese) throw new HierarchyError('Choose the diocese to move them to.');

  const checkedZoneId = await assertZoneBelongsToDiocese(zoneId, diocese.id, null);

  const [count] = await Church.update(
    { diocese_id: diocese.id, zone_id: checkedZoneId },
    { where: { id: { [Op.in]: churchIds } } }
  );
  return count;
}

/** Everything the overview shows, in one grouped query per table. */
async function overview() {
  const [dioceses, zones, churches, families, members, users] = await Promise.all([
    Diocese.count(),
    Zone.count(),
    Church.count(),
    Family.count(),
    db.Member.count(),
    User.count()
  ]);
  return { dioceses, zones, churches, families, members, users };
}

module.exports = {
  HierarchyError,
  listDioceses,
  findDiocese,
  createDiocese,
  renameDiocese,
  setDioceseActive,
  removeDiocese,
  listZones,
  listZonesInDiocese,
  findZone,
  createZone,
  renameZone,
  removeZone,
  listChurches,
  listNames,
  findChurch,
  findChurchBySlug,
  idsFor,
  allActiveIds,
  defaultDiocese,
  createChurch,
  updateChurch,
  setChurchActive,
  reassign,
  overview
};
