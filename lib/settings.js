'use strict';

const db = require('../db');

/**
 * Settings, in two layers.
 *
 * A church's name, its printed palette, how many families fit on a page — all
 * of it used to be one flat table, which was right when an install was one
 * parish. Now each church needs its own, and the two layers are:
 *
 *   church_settings   what this church has chosen
 *   settings          the installation's defaults, and the vocabulary
 *                     (diocese_label, zone_label) that is not per-church
 *
 * A key is looked for in that order, falling back to DEFAULT_SETTINGS in code
 * if neither table has it. So a church created this morning already has a
 * working Settings page and a printable directory without a single row of its
 * own, and writing one only records where it differs from the house style.
 */

/** The `settings` table: installation defaults plus the platform vocabulary. */
let platformCache = null;

/** churchId -> fully merged settings for that church. */
const churchCache = new Map();

async function loadPlatform() {
  if (platformCache) return platformCache;
  const rows = await db.Setting.findAll({ attributes: ['key', 'value'], raw: true });
  platformCache = { ...db.DEFAULT_SETTINGS, ...db.PLATFORM_SETTINGS };
  for (const row of rows) platformCache[row.key] = row.value;
  return platformCache;
}

/**
 * Settings as this church sees them.
 *
 * `churchId` may be null — a super administrator who has not picked a church
 * yet still renders a page header, and the installation defaults are the
 * honest thing to show them.
 */
async function load(churchId = null) {
  const platform = await loadPlatform();
  if (!churchId) return platform;

  const cached = churchCache.get(churchId);
  if (cached) return cached;

  const rows = await db.ChurchSetting.findAll({
    attributes: ['key', 'value'],
    where: { church_id: churchId },
    raw: true
  });

  const merged = { ...platform };
  for (const row of rows) merged[row.key] = row.value;

  churchCache.set(churchId, merged);
  return merged;
}

/** Forget one church's settings, or every cache if called bare. */
function invalidate(churchId = undefined) {
  if (churchId === undefined) {
    platformCache = null;
    churchCache.clear();
    return;
  }
  churchCache.delete(churchId);
}

/** Write settings belonging to one church. */
async function save(churchId, updates) {
  if (!churchId) throw new Error('Settings must be saved against a church.');

  await db.sequelize.transaction(async (transaction) => {
    for (const [key, value] of Object.entries(updates)) {
      await db.ChurchSetting.upsert(
        { church_id: churchId, key, value: String(value) },
        { transaction }
      );
    }
  });
  invalidate(churchId);
}

/**
 * Write installation-wide settings — the diocese and zone labels, and the
 * defaults a new church inherits. Changing a default does not disturb a church
 * that has already chosen its own, because its row wins.
 */
async function savePlatform(updates) {
  await db.sequelize.transaction(async (transaction) => {
    for (const [key, value] of Object.entries(updates)) {
      await db.Setting.upsert({ key, value: String(value) }, { transaction });
    }
  });
  // Every church merges the platform layer, so all of them are now stale.
  invalidate();
}

/** Relation names offered in the member editor, e.g. "Head, Spouse, Son". */
function relationOptions(settings) {
  return String(settings.relation_options || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * What this installation calls the two levels above a parish.
 *
 * Indian denominations do not agree: Eparchy and Forane, Diocese and Pastorate,
 * Region and Centre.
 *
 * The installation setting is the default. A diocese may override it, because
 * once this is run as a service its churches can come from different
 * denominations and one vocabulary would be wrong for some of them. Pass the
 * diocese when the page is about a particular one; leave it out for the
 * navigation, which is not about any single diocese.
 */
function labels(settings, diocese = null) {
  return {
    diocese: (diocese && diocese.diocese_label) || settings.diocese_label || 'Diocese',
    zone: (diocese && diocese.zone_label) || settings.zone_label || 'Zone'
  };
}

/** Expose the acting church's settings to every view as `settings`. */
function middleware(req, res, next) {
  load(req.churchId || null)
    .then((values) => {
      res.locals.settings = values;
      res.locals.labels = labels(values);
      req.settings = values;
      next();
    })
    .catch(next);
}

module.exports = {
  load,
  loadPlatform,
  save,
  savePlatform,
  invalidate,
  relationOptions,
  labels,
  middleware
};
