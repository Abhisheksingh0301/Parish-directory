'use strict';

const Churches = require('../models/church');

/**
 * Turning "which churches?" into a list of ids.
 *
 * A super administrator picks any set of churches, or whole zones, or whole
 * dioceses, and then wants to look at them, print them or export them. Three
 * outputs, and without this they would be three features.
 *
 * Everything resolves to the same thing — a list of church ids — so the view,
 * the printed book and the spreadsheet share one query path:
 *
 *   ?churches=1,5,9   the ids given
 *   ?zones=3,4        every church in those zones
 *   ?dioceses=2       every church in those dioceses, zoned or not
 *   ?all=1            every active church
 *
 * The forms combine. `?dioceses=2&churches=17` is that diocese plus one extra
 * parish; the results are unioned and de-duplicated.
 */

/** "1,5,9" or ["1","5"] to [1, 5, 9]; anything unparseable is dropped. */
function ids(value) {
  if (value === undefined || value === null) return [];
  const parts = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(
    parts
      .map((v) => Number(String(v).trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
  )];
}

/** A phrase naming the selection, for a cover page and a download filename. */
function describe({ all, dioceseNames, zoneNames, churchCount, churchIds }) {
  if (all) return 'All churches';

  const parts = [];
  if (dioceseNames.length) parts.push(dioceseNames.join(', '));
  if (zoneNames.length) parts.push(zoneNames.join(', '));

  if (parts.length) return parts.join(' and ');
  if (churchIds.length === 1) return churchCount === 1 ? 'One church' : 'One church';
  return `${churchIds.length} churches`;
}

/**
 * Resolve a query into the churches it names.
 *
 * Ids that no longer exist are ignored rather than raising: a bookmark that
 * outlived a church should degrade to a smaller report, not a 500.
 */
async function resolve(query = {}) {
  const wantAll = query.all === '1' || query.all === 'true';

  const churchIds = ids(query.churches);
  const zoneIds = ids(query.zones);
  const dioceseIds = ids(query.dioceses);

  const resolved = wantAll
    ? await Churches.allActiveIds()
    : await Churches.idsFor({ churchIds, zoneIds, dioceseIds });

  // Named for the cover, and only for the parts actually asked for.
  const [allDioceses, allZones] = await Promise.all([
    dioceseIds.length ? Churches.listDioceses() : [],
    zoneIds.length ? Churches.listZones() : []
  ]);

  const label = describe({
    all: wantAll,
    dioceseNames: allDioceses.filter((d) => dioceseIds.includes(d.id)).map((d) => d.name),
    zoneNames: allZones.filter((z) => zoneIds.includes(z.id)).map((z) => z.name),
    churchCount: resolved.length,
    churchIds: resolved
  });

  return {
    churchIds: resolved,
    label,
    empty: resolved.length === 0,
    // Echoed back so the form can show what is currently ticked.
    chosen: { churches: churchIds, zones: zoneIds, dioceses: dioceseIds, all: wantAll }
  };
}

/** A filename-safe version of the label, with today's date. */
function filename(label, extension) {
  const slug = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'directory';

  const today = new Date().toISOString().slice(0, 10);
  return `${slug}-${today}.${extension}`;
}

module.exports = { resolve, ids, filename };
