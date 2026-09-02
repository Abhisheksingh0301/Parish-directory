'use strict';

const express = require('express');
const Churches = require('../models/church');
const Family = require('../models/family');
const selection = require('../lib/selection');
const exporter = require('../lib/export');
const settings = require('../lib/settings');
const tenancy = require('../lib/tenancy');
const audit = require('../lib/audit');
const wrap = require('../lib/async');

const router = express.Router();

/**
 * Reading, printing and exporting across churches.
 *
 * One selection — any churches, any zones, any dioceses — feeding three
 * outputs. The selection layer is lib/selection.js; everything here just
 * decides what to do with the list of church ids it hands back.
 */

router.use(tenancy.requireSuperAdmin);

/** Keep the current selection on links between the three outputs. */
function queryString(req) {
  const keep = ['churches', 'zones', 'dioceses', 'all'];
  const parts = keep
    .filter((k) => req.query[k])
    .map((k) => `${k}=${encodeURIComponent(req.query[k])}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

// ---------------------------------------------------------------------------
// Choosing, and looking
// ---------------------------------------------------------------------------

router.get('/reports', wrap(async (req, res) => {
  const chosen = await selection.resolve(req.query);

  // Only fetch the families once something has actually been picked.
  const families = chosen.empty ? [] : await Family.list(chosen.churchIds, {});
  const churches = chosen.empty ? [] : await Promise.all(
    chosen.churchIds.map((id) => Churches.findChurch(id))
  );
  const byId = new Map(churches.filter(Boolean).map((c) => [c.id, c]));

  res.render('super/reports', {
    title: 'View, print and export',
    dioceses: await Churches.listDioceses(),
    zones: await Churches.listZones(),
    allChurches: await Churches.listChurches({}),
    chosen,
    query: queryString(req),
    families: families.map((f) => ({ ...f, church: byId.get(f.church_id) || null })),
    notice: req.query.notice || null,
    error: req.query.error || null
  });
}));

// ---------------------------------------------------------------------------
// The combined book
// ---------------------------------------------------------------------------

router.get('/print', wrap(async (req, res) => {
  const chosen = await selection.resolve(req.query);

  const platform = await settings.loadPlatform();
  const includeDrafts = req.query.drafts === '1';

  /*
   * Page numbering runs continuously across the whole document. A church's own
   * `starting_page` applies only when it prints alone — in a combined book
   * every section would restart at its own number and the folios would collide.
   *
   * `per_page` stays each church's own, because sections break anyway.
   */
  let folio = 1;
  const sections = [];

  for (const churchId of chosen.churchIds) {
    const [church, churchSettings, families] = await Promise.all([
      Churches.findChurch(churchId),
      settings.load(churchId),
      Family.listWithMembers(churchId, { publishedOnly: !includeDrafts })
    ]);

    if (!church || !families.length) continue;

    const perPage = Math.max(1, parseInt(churchSettings.per_page, 10) || 1);
    const pages = [];
    for (let i = 0; i < families.length; i += perPage) {
      pages.push({ folio: folio++, families: families.slice(i, i + perPage), single: perPage === 1 });
    }

    sections.push({ church, settings: churchSettings, families: families.length, pages });
  }

  res.render('directory/multi', {
    title: chosen.label,
    labels: settings.labels(platform),
    sections,
    totalFamilies: sections.reduce((n, s) => n + s.families, 0),
    totalPages: sections.reduce((n, s) => n + s.pages.length, 0),
    query: queryString(req)
  });
}));

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * The selection as a spreadsheet.
 *
 * The columns, the byte order mark and the row-per-member shape live in
 * lib/export.js, because the church's own export and the archive below have to
 * produce exactly the same file — a parish comparing the two and finding
 * different columns has no reason to trust either.
 */
router.get('/export.csv', wrap(async (req, res) => {
  const chosen = await selection.resolve(req.query);
  const labels = settings.labels(await settings.loadPlatform());

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${selection.filename(chosen.label, 'csv')}"`
  );

  // Data leaving the system entirely — the one report worth a line each time.
  await audit.record(req, 'export.csv', {
    churchId: chosen.churchIds.length === 1 ? chosen.churchIds[0] : null,
    detail: `${chosen.label} (${chosen.churchIds.length} church(es))`
  });

  await exporter.writeRows(exporter.streamTo(res), chosen.churchIds, { labels });
  res.end();
}));

/**
 * The selection as a spreadsheet *and* its photographs, in one archive.
 *
 * The photographs are the reason this exists. A CSV describes a directory; it
 * does not contain one, and a parish moving to another system or handing a
 * diocese its records needs the faces as well as the names.
 *
 * Sized honestly: this is every image of every church chosen, so a whole
 * installation is gigabytes and minutes. It streams — nothing is staged on
 * disk, and the download starts as soon as the rows are counted — but the page
 * that links here says so, because an operator who thinks it has hung will
 * click it again and pay for it twice.
 */
router.get('/export.zip', wrap(async (req, res) => {
  const chosen = await selection.resolve(req.query);
  const labels = settings.labels(await settings.loadPlatform());

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${selection.filename(chosen.label, 'zip')}"`
  );
  // An export is a point in time, and a proxy holding one is a proxy handing
  // somebody else a church's addresses.
  res.setHeader('Cache-Control', 'no-store');

  await audit.record(req, 'export.bundle', {
    churchId: chosen.churchIds.length === 1 ? chosen.churchIds[0] : null,
    detail: `${chosen.label} (${chosen.churchIds.length} church(es)), with photographs`
  });

  const result = await exporter.bundle(res, chosen.churchIds, {
    labels,
    label: chosen.label
  });
  res.end();

  if (result.missing) {
    console.warn(
      `Export of ${chosen.label}: ${result.missing} photograph(s) on record were not on disk.`
    );
  }
}));

module.exports = router;
