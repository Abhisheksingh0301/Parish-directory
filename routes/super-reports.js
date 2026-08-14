'use strict';

const express = require('express');
const Churches = require('../models/church');
const Family = require('../models/family');
const selection = require('../lib/selection');
const settings = require('../lib/settings');
const relations = require('../lib/relations');
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

    const perPage = Math.max(1, parseInt(churchSettings.per_page, 10) || 2);
    const pages = [];
    for (let i = 0; i < families.length; i += perPage) {
      pages.push({ folio: folio++, families: families.slice(i, i + perPage) });
    }

    sections.push({ church, settings: churchSettings, families: families.length, pages });
  }

  res.render('directory/multi', {
    title: chosen.label,
    labels: settings.labels(platform),
    sections,
    totalFamilies: sections.reduce((n, s) => n + s.families, 0),
    totalPages: sections.reduce((n, s) => n + s.pages.length, 0),
    query: queryString(req),
    domSpan: relations.domSpan
  });
}));

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** One CSV field: quoted, with embedded quotes doubled. */
function cell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

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

  /*
   * A UTF-8 byte order mark, first.
   *
   * Excel assumes the system codepage for a CSV without one and mangles every
   * non-ASCII name — which, in an Indian parish directory, is most of them.
   * Three bytes, and the difference between a usable file and a support call.
   */
  res.write('﻿');

  res.write([
    labels.diocese, labels.zone, 'Church', 'Family ID', 'Head of family',
    'Address', 'Home Town', 'Home parish', 'Spouse home', 'Prayer group', 'Email',
    'Date of marriage', 'Member', 'Relation', 'Date of birth', 'Mobile',
    'Blood group', 'Qualification', 'Occupation', 'Links'
  ].map(cell).join(',') + '\r\n');

  /*
   * One row per member, with the family and church columns repeated. That is
   * the shape that pivots in a spreadsheet, which is what an export is for —
   * a family-per-row file cannot represent members at all without inventing
   * numbered columns.
   *
   * Written church by church rather than assembled in memory: a whole-system
   * export is on the order of a hundred and sixty thousand rows.
   */
  for (const churchId of chosen.churchIds) {
    const church = await Churches.findChurch(churchId);
    if (!church) continue;

    const families = await Family.listWithMembers(churchId, { publishedOnly: false });

    for (const family of families) {
      const base = [
        church.diocese_name,
        // An unzoned church exports an empty cell, not the word "None".
        church.zone_name || '',
        church.name,
        family.family_id,
        family.head_name,
        family.address,
        family.hometown,
        family.home_parish,
        family.spouse_home,
        family.prayer_group,
        family.email,
        family.dom
      ];

      // A family with no members still deserves a row, or it vanishes.
      const members = family.members.length
        ? family.members
        : [{
          name: '', relation: '', dob: '', mobile: '',
          blood_group: '', qualification: '', occupation: '', links: ''
        }];

      for (const m of members) {
        res.write([
          ...base, m.name, m.relation, m.dob, m.mobile,
          m.blood_group, m.qualification, m.occupation, m.links
        ].map(cell).join(',') + '\r\n');
      }
    }
  }

  res.end();
}));

module.exports = router;
