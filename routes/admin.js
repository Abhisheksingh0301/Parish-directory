'use strict';

const fs = require('fs');
const express = require('express');
const config = require('../config');
const db = require('../db');
const Users = require('../models/user');
const Family = require('../models/family');
const auth = require('../lib/auth');
const tenancy = require('../lib/tenancy');
const settings = require('../lib/settings');
const audit = require('../lib/audit');
const verification = require('../lib/verification');
const exporter = require('../lib/export');
const importColumns = require('../lib/import-columns');
const importTemplate = require('../lib/import-template');
const importUpload = require('../lib/import-upload');
const importer = require('../lib/import-families');
const photoImporter = require('../lib/import-photos');
const unzip = require('../lib/unzip');
const { removePhoto } = require('../lib/upload');
const { slugify } = require('../lib/slug');
const wrap = require('../lib/async');

const router = express.Router();

router.use(auth.requireRole('admin'));
// Settings and accounts belong to one church, so there has to be one.
router.use(tenancy.requireChurch);

// ---------------------------------------------------------------------------
// Parish settings — the knobs that make this install "this church's" copy
// ---------------------------------------------------------------------------

const COLOR_KEYS = ['color_band', 'color_band_dark', 'color_member_a', 'color_member_b', 'color_rule'];

/** Everything the settings page needs beyond the stored values themselves. */
function settingsLocals() {
  return {
    colorKeys: COLOR_KEYS,
    // The field list is a parish setting rather than something fixed in the
    // code, so moving a field from one tier to the other is something the
    // parish does itself.
    tierableFields: verification.TIERABLE_FIELDS,
    tiers: verification.TIERS,
    neverEditable: verification.NEVER_EDITABLE
  };
}

router.get('/settings', wrap(async (req, res) => {
  res.render('admin/settings', {
    title: 'Parish settings',
    values: await settings.load(req.churchId),
    ...settingsLocals(),
    errors: [],
    error: req.query.error || null,
    notice: req.query.notice || null
  });
}));

router.post('/settings', wrap(async (req, res) => {
  const text = (v) => String(v ?? '').trim();
  const errors = [];

  const perPage = parseInt(req.body.per_page, 10);
  const startingPage = parseInt(req.body.starting_page, 10);

  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 6) {
    errors.push('Families per printed page must be between 1 and 6.');
  }
  if (!Number.isInteger(startingPage) || startingPage < 0) {
    errors.push('Starting page number must be 0 or more.');
  }
  if (!text(req.body.parish_name)) {
    errors.push('Parish name is required — it prints in the footer of every page.');
  }

  const memberPassword = text(req.body.default_member_password);
  if (memberPassword.length < 8) {
    errors.push('The member password must be at least 8 characters.');
  }

  /*
   * Which fields are routine, kept as the parish typed them but filtered to
   * fields that actually exist. A misspelling silently promoting a field to
   * "significant" would be a change nobody could see on this page.
   */
  const known = new Set(verification.TIERABLE_FIELDS.map((f) => f.key));
  const routine = [].concat(req.body.routine_fields || [])
    .map((key) => String(key).trim().toLowerCase())
    .filter((key) => known.has(key));

  const updates = {
    parish_name: text(req.body.parish_name),
    default_member_password: memberPassword,
    directory_title: text(req.body.directory_title) || 'Family Parish Directory',
    relation_options: text(req.body.relation_options),
    approval_tiers: req.body.approval_tiers === '2' ? '2' : '1',
    routine_fields: routine.join(', '),
    starting_page: String(startingPage),
    per_page: String(perPage)
  };

  for (const key of COLOR_KEYS) {
    const value = text(req.body[key]);
    if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
      errors.push(`${key.replace(/_/g, ' ')} must be a colour like #cec4b3.`);
    } else {
      updates[key] = value.toLowerCase();
    }
  }

  if (errors.length) {
    const current = await settings.load(req.churchId);
    return res.status(400).render('admin/settings', {
      title: 'Parish settings',
      values: { ...current, ...req.body, routine_fields: routine.join(', ') },
      ...settingsLocals(),
      errors,
      notice: null
    });
  }

  await settings.save(req.churchId, updates);

  res.render('admin/settings', {
    title: 'Parish settings',
    values: await settings.load(req.churchId),
    ...settingsLocals(),
    errors: [],
    notice: 'Settings saved.'
  });
}));

// ---------------------------------------------------------------------------
// The audit log, as this parish reads it
// ---------------------------------------------------------------------------

/**
 * What happened to us, and who did it.
 *
 * The same log the console shows, narrowed to this church in the query rather
 * than filtered afterwards — a parish administrator cannot read another
 * parish's history by removing the filter, because there is no query here that
 * reaches one.
 *
 * There is no screen anywhere in this application that edits or deletes a log
 * line, and this page is deliberately not the exception.
 */
const AUDIT_EVENTS = [
  { value: '', label: 'Everything' },
  { value: 'family.submitted', label: 'Changes submitted' },
  { value: 'family.approved', label: 'Changes approved' },
  { value: 'family.rejected', label: 'Changes rejected' },
  { value: 'family.invited', label: 'Invitations marked sent' },
  { value: 'family.stage_moved', label: 'Moved along the chain' },
  { value: 'family.deleted', label: 'Families deleted' },
  { value: 'family.pin_issued', label: 'Verification slips issued' },
  { value: 'family.published', label: 'Printed-directory inclusion' },
  { value: 'family.ready_for_printing', label: 'Marked ready for printing' },
  { value: 'family.printed', label: 'Marked as printed' },
  { value: 'family.imported', label: 'Data imported' },
  { value: 'family.photos.imported', label: 'Photographs imported' },
  { value: 'export', label: 'Exports' },
  { value: 'church', label: 'Parish structure' }
];

router.get('/audit', wrap(async (req, res) => {
  const action = AUDIT_EVENTS.some((e) => e.value && e.value === req.query.action)
    ? String(req.query.action)
    : '';

  res.render('admin/audit', {
    title: 'Audit log',
    entries: await audit.list({ churchId: req.churchId, action, limit: 400 }),
    events: AUDIT_EVENTS,
    action
  });
}));

router.post('/settings/reset-colors', wrap(async (req, res) => {
  const defaults = Object.fromEntries(
    COLOR_KEYS.map((key) => [key, db.DEFAULT_SETTINGS[key]])
  );
  await settings.save(req.churchId, defaults);
  res.redirect('/admin/settings');
}));

/**
 * Empty the directory, on purpose.
 *
 * Every family, member, login and pending change this church holds, gone in
 * one transaction — the escape hatch for a parish re-importing a corrected
 * sheet that would otherwise collide on every Family ID already here.
 * Settings are untouched: the church itself is not being un-created, just
 * emptied.
 *
 * The typed parish name is not a security boundary — the role guard above
 * already is one — it is a second look at what is about to happen, matched
 * server-side so a stale or replayed form cannot slip through on the
 * confirmation dialog alone.
 */
router.post('/settings/delete-database', wrap(async (req, res) => {
  const typed = String(req.body.confirm_name || '').trim();
  if (typed !== req.church.name) {
    return res.redirect('/admin/settings?error=' +
      encodeURIComponent('Type the parish name exactly to confirm. Nothing was deleted.'));
  }

  const result = await Family.removeAll(req.churchId);
  for (const filename of result.photos) removePhoto(req.churchId, filename);

  await audit.record(req, 'family.deleted', {
    churchId: req.churchId,
    detail: `Entire directory cleared: ${result.count} famil${result.count === 1 ? 'y' : 'ies'} deleted`
  });

  res.redirect('/admin/settings?notice=' +
    encodeURIComponent(`${result.count} famil${result.count === 1 ? 'y' : 'ies'} deleted. The directory is now empty.`));
}));

// ---------------------------------------------------------------------------
// Taking the parish's own data out
// ---------------------------------------------------------------------------

/**
 * A church's copy of its own directory.
 *
 * The console has been able to export across churches since reports were
 * added; a parish had no way to get its own records out at all, which is the
 * wrong way round — the data is theirs, and "may we have a copy?" should not
 * have to go through whoever runs the server.
 *
 * Three forms, and what differs is which half of the data comes out:
 *
 *   export.csv          the spreadsheet — opened in Excel, mailed to whoever
 *                       asked
 *   export.zip          the same spreadsheet and every photograph, each named
 *                       after the family it belongs to, which is what a printer
 *                       or another system actually needs
 *   export-photos.zip   the photographs alone, each named for its Family ID and
 *                       nothing else — the shape the Import photographs page
 *                       reads back, so a parish can take its folder out, fix
 *                       the pictures that are wrong and put the same folder
 *                       straight back
 *
 * Drafts are included by default: they are the parish's own unfinished
 * entries, and an export that quietly dropped them would be a backup with
 * holes in it. `?drafts=0` leaves them out, for the copy that goes to a
 * printer rather than into a filing cabinet.
 *
 * Admin only, like the rest of this router. An export is every address and
 * telephone number in the parish in one file, which is a different thing from
 * being able to read them a page at a time.
 */

/** The download's name: the parish, and the day it was taken. */
function downloadName(church, extension) {
  const day = new Date().toISOString().slice(0, 10);
  return `${slugify(church.name, 'parish')}-${day}.${extension}`;
}

router.get('/export', wrap(async (req, res) => {
  const [stats, photos] = await Promise.all([
    Family.stats(req.churchId),
    Family.photoCount(req.churchId)
  ]);

  res.render('admin/export', {
    title: 'Download your data',
    stats,
    photos
  });
}));

router.get('/export.csv', wrap(async (req, res) => {
  const includeDrafts = req.query.drafts !== '0';

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName(req.church, 'csv')}"`);
  // A parish's whole address book. Nothing between here and the browser has
  // any business keeping a copy.
  res.setHeader('Cache-Control', 'no-store');

  await audit.record(req, 'export.csv', {
    churchId: req.churchId,
    detail: `${req.church.name}${includeDrafts ? '' : ', printed entries only'}`
  });

  await exporter.writeRows(exporter.streamTo(res), [req.churchId], {
    labels: res.locals.labels,
    includeDrafts
  });
  res.end();
}));

router.get('/export.zip', wrap(async (req, res) => {
  const includeDrafts = req.query.drafts !== '0';

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName(req.church, 'zip')}"`);
  res.setHeader('Cache-Control', 'no-store');

  await audit.record(req, 'export.bundle', {
    churchId: req.churchId,
    detail: `${req.church.name}, with photographs${includeDrafts ? '' : ', printed entries only'}`
  });

  const result = await exporter.bundle(res, [req.churchId], {
    labels: res.locals.labels,
    label: req.church.name,
    includeDrafts
  });
  res.end();

  // A photograph on record but not on disk means a file was lost behind the
  // application's back. The export still completed, so this is a note for
  // whoever reads the logs, not an error for the person downloading.
  if (result.missing) {
    console.warn(
      `Export of ${req.church.name}: ${result.missing} photograph(s) on record were not on disk.`
    );
  }
}));

/**
 * The photographs on their own.
 *
 * The bundle above already carries them, so this exists for the trip back
 * rather than the trip out: the names in here are exactly what Import
 * photographs expects, so the folder a parish downloads is the folder it can
 * correct and upload again without renaming anything.
 */
router.get('/export-photos.zip', wrap(async (req, res) => {
  const includeDrafts = req.query.drafts !== '0';

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition',
    `attachment; filename="${downloadName(req.church, 'zip').replace(/\.zip$/, '-photos.zip')}"`);
  res.setHeader('Cache-Control', 'no-store');

  await audit.record(req, 'export.photos', {
    churchId: req.churchId,
    detail: `${req.church.name}, photographs only${includeDrafts ? '' : ', printed entries only'}`
  });

  const result = await exporter.photoBundle(res, req.churchId, {
    folder: slugify(req.church.name, 'parish') + '-photos',
    includeDrafts
  });
  res.end();

  if (result.missing) {
    console.warn(
      `Photograph export of ${req.church.name}: ${result.missing} on record were not on disk.`
    );
  }
}));

// ---------------------------------------------------------------------------
// The other direction — the sheet a parish fills in before importing
// ---------------------------------------------------------------------------

/*
 * Loading a parish's existing families is `npm run import-families`, run at
 * the command line by whoever installed this. That is deliberate: several
 * hundred families arriving at once is not something to do from a web form on
 * a first attempt, and the dry run and rejects file are what make it safe.
 *
 * But the parish office, not the installer, is the one who has to produce the
 * spreadsheet — and it had nothing to produce it from. So the sheet itself is
 * downloadable here, in the church's own login, with the columns and the rules
 * on the page beside it. The office fills it in and hands it over; the import
 * is still a deliberate, supervised step.
 */

/**
 * Add one relation to the list the member editor offers.
 *
 * The list has always been editable, as a comma-separated field on this page.
 * That is the wrong shape for the moment it is actually wanted: someone is
 * halfway through entering a household, needs "Father-in-law", and the only
 * way to have it offered is to abandon the half-filled form, come here, edit a
 * comma string and go back. So the family form can append to it in place.
 *
 * It appends and never removes or reorders — this is a convenience reached
 * mid-entry, and curating the list stays a deliberate act on the settings page
 * where the whole thing is visible at once.
 *
 * Admin-only, like everything on this router. An editor may type any relation
 * they like into a member row; changing what the parish is *offered* is a
 * settings change, and settings belong to an administrator.
 */
router.post('/relations', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  const current = settings.relationOptions(req.settings);

  const fail = (message) => res.status(400).json({ ok: false, message });

  if (!name) return fail('Type a relation before adding it.');
  if (name.length > 40) return fail('A relation may be up to 40 characters.');
  // The setting is one comma-separated string, so a comma would split it in two.
  if (name.includes(',')) return fail('A relation cannot contain a comma.');

  const already = current.find((r) => r.toLowerCase() === name.toLowerCase());
  if (already) {
    return res.json({ ok: true, relations: current, message: `"${already}" is already offered.` });
  }

  const relations = current.concat(name);
  await settings.save(req.churchId, { relation_options: relations.join(', ') });
  await audit.record(req, 'settings.relations.add', {
    churchId: req.churchId,
    detail: name
  });

  res.json({ ok: true, relations, message: `"${name}" added to the relations offered.` });
}));

/**
 * Everything the import page needs, whether it has just been asked for or has
 * just been posted to. The reporting fields are here with nothing in them so
 * the view can read them unconditionally rather than guarding every block.
 */
function importLocals(req) {
  return {
    title: 'Import members from a spreadsheet',
    // What to do about a Family ID the directory already holds. Carried back
    // so a sheet that comes back with problems does not also silently reset
    // the choice the office made about it.
    onExisting: req.body && req.body.on_existing === 'update' ? 'update' : 'skip',
    fields: importColumns.FIELDS,
    // Not `labels`: that name already belongs to the diocese/zone vocabulary
    // every view is given.
    columnLabels: importColumns.LABELS,
    aliases: importColumns.COLUMNS,
    required: importColumns.REQUIRED,
    relations: settings.relationOptions(req.settings),
    maxSheetMb: Math.round(importUpload.maxBytes / (1024 * 1024)),
    fileName: null,
    problems: [],
    problemCount: 0,
    problemsHidden: 0,
    unknownColumns: [],
    result: null
  };
}

router.get('/import', wrap(async (req, res) => {
  res.render('admin/import', importLocals(req));
}));

/**
 * How many problems are worth putting on the page.
 *
 * A sheet with the Family ID column shifted by one produces a problem for
 * every row in it, and eight hundred of them is not a report — it is the same
 * sentence often enough to hide the one line that explains it. The count is
 * always exact; the list is what gets cut.
 */
const PROBLEMS_SHOWN = 50;

/**
 * Upload a filled-in sheet.
 *
 * The whole file is read and checked before a single row is written, and one
 * problem anywhere stops all of it. That is stricter than the command line,
 * which imports what it can and writes the rest to a rejects file, and the
 * difference is deliberate: the operator running the command has the rejects
 * file and a shell, while the person at this form has neither. "47 of your 60
 * families arrived, and these 13 did not" leaves them with a half-loaded
 * directory and no way to tell which half — so nothing arrives until the sheet
 * is right, and then all of it does.
 *
 * A Family ID already in the directory counts as a problem for the same
 * reason. It is not dangerous — it is skipped, never overwritten — but it
 * means the file on the office's desk is not the file in the directory, and
 * saying so is more use than importing around it in silence.
 */
router.post('/import', wrap(async (req, res) => {
  const page = (extra) => res.render('admin/import', { ...importLocals(req), ...extra });

  // Set by lib/import-upload, which runs before the CSRF check because the
  // form is multipart and `_csrf` is inside the body it parses.
  if (req.sheetError || !req.file) {
    return page({
      problems: [{
        message: req.sheetError
          || 'No file was chosen. Pick the spreadsheet you filled in and try again.'
      }]
    });
  }

  const fileName = req.file.originalname;

  let sheet;
  try {
    sheet = importer.readSheet(req.file.buffer.toString('utf8'));
  } catch (err) {
    // Anything the reader could not make a sheet of at all: no rows, no Family
    // ID column. It has already said so in words the office can act on.
    if (!(err instanceof importer.SheetError)) throw err;
    return page({ fileName, problems: [{ message: err.message }] });
  }

  // The check. This is the import itself with the writing turned off — the
  // same code, reaching the same tables — rather than a second implementation
  // that describes what the first one would do and drifts away from it.
  /*
   * A Family ID this directory already holds is either a mistake or the whole
   * point, and only the office knows which. Left alone it is a problem that
   * stops the import, as it always was — a record somebody corrected by hand
   * is not overwritten by an import run twice by accident. Asked for, it is an
   * update: the second sheet a parish uploads is usually the first one with
   * the addresses put right, and every Family ID on it is already here.
   */
  const onExisting = req.body.on_existing === 'update' ? 'update' : 'skip';

  const check = await importer.runImport({
    churchId: req.churchId,
    churchName: req.church.name,
    families: sheet.families,
    dryRun: true,
    onExisting
  });

  const problems = [];

  for (const row of sheet.rows) {
    if (row.errors.length) problems.push({ line: row.line, message: row.errors.join('; ') });
  }

  for (const clash of check.skipped) {
    problems.push({
      line: clash.line,
      message: `Family ID "${clash.family_id}" is already in the directory. Take that `
        + "family's rows out of the sheet, or give this one a Family ID of its own."
    });
  }

  for (const bad of check.failed) {
    problems.push({
      line: bad.line,
      message: bad.reason === 'no-head'
        ? `Family "${bad.family_id}" has neither a head of family nor any members. `
          + 'A printed entry has to have a name at the top of it — fill in one column or the other.'
        : bad.message
    });
  }

  if (!problems.length && !sheet.families.length) {
    problems.push({ message: 'That file has headings and no families under them.' });
  }

  if (problems.length) {
    problems.sort((a, b) => (a.line || 0) - (b.line || 0));
    return page({
      fileName,
      unknownColumns: sheet.unknown,
      problems: problems.slice(0, PROBLEMS_SHOWN),
      problemsHidden: Math.max(0, problems.length - PROBLEMS_SHOWN),
      problemCount: problems.length
    });
  }

  const outcome = await importer.runImport({
    churchId: req.churchId,
    churchName: req.church.name,
    families: sheet.families,
    dryRun: false,
    onExisting
  });

  await audit.record(req, 'family.imported', {
    churchId: req.churchId,
    detail: `${outcome.created.length} family/families imported` +
      (outcome.updated.length ? `, ${outcome.updated.length} updated` : '') +
      ` from ${fileName}`
  });

  return page({
    fileName,
    unknownColumns: sheet.unknown,
    result: {
      families: outcome.created.length,
      rows: sheet.usable.length,
      people: outcome.created.reduce((total, f) => total + f.members, 0),
      updated: outcome.updated.length,
      // How many of the updated families had their member list rebuilt from
      // the sheet, as against the ones whose rows carried family columns only
      // and whose households were left as they were.
      membersReplaced: outcome.updated.filter((f) => f.members_replaced).length,
      adjusted: outcome.adjusted,
      // The check said there was nothing wrong, so anything here happened in
      // the seconds between the two passes — somebody else importing or adding
      // the same family. Vanishingly rare, and never silent.
      unexpected: [...outcome.skipped, ...outcome.failed]
    }
  });
}));

router.get('/import-template.csv', wrap(async (req, res) => {
  // Headings only, for a parish that would rather not delete somebody else's
  // examples out of its own sheet before starting.
  const withExamples = req.query.examples !== '0';

  const name = `${slugify(req.church.name, 'parish')}-members-template.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);

  res.send(importTemplate.build({
    relations: settings.relationOptions(req.settings),
    withExamples
  }));
}));

// ---------------------------------------------------------------------------
// Photographs, a folder at a time
// ---------------------------------------------------------------------------

/**
 * Everything the photograph import page needs, empty of any report until a
 * post fills one in.
 */
async function photoLocals(req) {
  const [stats, withPhotos] = await Promise.all([
    Family.stats(req.churchId),
    Family.photoCount(req.churchId)
  ]);

  return {
    title: 'Import photographs',
    maxArchiveMb: Math.round(importUpload.archiveMaxBytes / (1024 * 1024)),
    maxPhotoMb: Math.round(config.maxPhotoBytes / (1024 * 1024)),
    extensions: Object.keys(photoImporter.BY_EXTENSION),
    totalFamilies: stats.families,
    withPhotos,
    fileName: null,
    problems: [],
    problemCount: 0,
    problemsHidden: 0,
    result: null
  };
}

/**
 * What the import did, as one sentence.
 *
 * Built here rather than in the template because EJS emits a line break
 * wherever the template has one, and a headline assembled from four tags
 * across four lines arrives with newlines inside it.
 */
function photoHeadline({ added, replaced }, fileName) {
  const count = (n) => `${n} photograph${n === 1 ? '' : 's'}`;
  const from = fileName ? ` from ${fileName}` : '';

  if (added.length && replaced.length) {
    return `${count(added.length)} added and ${replaced.length} replaced${from}.`;
  }
  if (replaced.length) return `${count(replaced.length)} replaced${from}.`;
  return `${count(added.length)} added${from}.`;
}

router.get('/photos', wrap(async (req, res) => {
  res.render('admin/photos', await photoLocals(req));
}));

/**
 * Upload a folder of photographs, zipped, one file per family.
 *
 * The archive is unpacked twice on purpose. The first pass reads every image
 * and checks it — that its name is a Family ID this parish has, that no two
 * files claim the same family, that the bytes are the kind of image the name
 * says, and that it is landscape — and writes nothing at all. Only if every
 * file passes does the second pass store them.
 *
 * The same all-or-nothing rule as the spreadsheet import, for the same reason:
 * a partial result leaves the office with no way to tell which half of their
 * folder arrived. Here it also has a cheaper answer than it looks — images are
 * already-compressed formats, so unpacking one twice costs almost nothing, and
 * only one photograph is ever held in memory.
 */
router.post('/photos', wrap(async (req, res) => {
  const page = async (extra) => res.render('admin/photos', { ...(await photoLocals(req)), ...extra });

  if (req.archiveError || !req.file) {
    return page({
      problems: [{
        message: req.archiveError
          || 'No file was chosen. Pick the zip of photographs and try again.'
      }],
      problemCount: 1
    });
  }

  const fileName = req.file.originalname;
  const uploaded = req.file.path;
  let archive = null;

  try {
    try {
      archive = await unzip.open(uploaded);
    } catch (err) {
      if (!(err instanceof unzip.ArchiveError)) throw err;
      return page({ fileName, problems: [{ message: err.message }], problemCount: 1 });
    }

    const families = await Family.photoTargets(req.churchId);
    const { problems, ready, ignored } = await photoImporter.check({ archive, families });

    if (!problems.length && !ready.length) {
      return page({
        fileName,
        problems: [{
          message: 'There are no photographs in that archive. Check that the folder you '
            + 'compressed has the images in it.'
        }],
        problemCount: 1
      });
    }

    if (problems.length) {
      return page({
        fileName,
        problems: problems.slice(0, PROBLEMS_SHOWN),
        problemsHidden: Math.max(0, problems.length - PROBLEMS_SHOWN),
        problemCount: problems.length
      });
    }

    const outcome = await photoImporter.store({ archive, churchId: req.churchId, ready });

    await audit.record(req, 'family.photos.imported', {
      churchId: req.churchId,
      detail: `${outcome.added.length} added, ${outcome.replaced.length} replaced, from ${fileName}`
    });

    return page({
      fileName,
      result: {
        headline: photoHeadline(outcome, fileName),
        added: outcome.added.length,
        replaced: outcome.replaced.length,
        replacedFamilies: outcome.replaced.map((item) => item.ref),
        ignored,
        // The check passed, so anything here happened in the seconds since —
        // a family deleted from under the import, or a disk that filled.
        failed: outcome.failed
      }
    });
  } finally {
    if (archive) await archive.close();
    // The upload is scratch space and nothing else keeps a reference to it.
    await fs.promises.unlink(uploaded).catch(() => {});
  }
}));

// ---------------------------------------------------------------------------
// User accounts
// ---------------------------------------------------------------------------

async function renderUsers(req, res, extra = {}) {
  res.render('admin/users', {
    title: 'User accounts',
    users: await Users.listWithFamilies(req.churchId),
    // Member logins are made from the family, not typed in here.
    roles: auth.STAFF_ROLE_LIST,
    allRoles: auth.ROLES,
    defaultPassword: req.settings.default_member_password,
    error: null,
    notice: null,
    form: {},
    ...extra
  });
}

router.get('/users', wrap(async (req, res) => renderUsers(req, res)));

router.post('/users', wrap(async (req, res) => {
  const form = {
    username: (req.body.username || '').trim(),
    full_name: (req.body.full_name || '').trim(),
    role: req.body.role
  };

  const fail = (error) => {
    res.status(400);
    return renderUsers(req, res, { error, form });
  };

  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(form.username)) {
    return fail('Username may use letters, numbers, dot, dash and underscore (3–40 characters).');
  }
  // Not a bare "is this a real role?" check: a super administrator is a real
  // role, and offering it here would let any church administrator create one
  // and reach every other church in the system.
  if (!auth.isAssignableByChurchAdmin(form.role)) {
    return fail('Choose a role. Member logins are created from the families list.');
  }

  const passwordError = auth.validatePassword(req.body.password, req.body.password_confirm);
  if (passwordError) return fail(passwordError);

  if (await Users.usernameTaken(form.username)) {
    return fail(`The username "${form.username}" is already taken.`);
  }

  await Users.create({
    username: form.username,
    password_hash: await auth.hashPassword(req.body.password),
    full_name: form.full_name,
    role: form.role,
    church_id: req.churchId
  });

  return renderUsers(req, res, { notice: `Account created for ${form.username}.` });
}));

// The last active administrator must not be able to demote, deactivate or
// delete themselves out of the only account that can manage this install —
// Users.wouldOrphanAdmins is what every one of the routes below asks first.

router.post('/users/:id(\\d+)/role', wrap(async (req, res, next) => {
  const user = await Users.findInChurch(req.churchId, req.params.id);
  if (!user) return next();

  const role = req.body.role;
  if (!auth.isAssignableByChurchAdmin(role)) {
    res.status(400);
    return renderUsers(req, res, { error: 'Choose a valid role.' });
  }

  // A member login is defined by the family it belongs to; promoting it would
  // hand one household the whole directory.
  if (user.family_id) {
    res.status(400);
    return renderUsers(req, res, {
      error: `${user.username} is a member login — its role cannot be changed here.`
    });
  }

  if (user.role === 'admin' && role !== 'admin' && (await Users.wouldOrphanAdmins(req.churchId, user.id))) {
    res.status(400);
    return renderUsers(req, res, { error: 'This is the only administrator — promote someone else first.' });
  }

  await Users.setRole(user.id, role);
  return renderUsers(req, res, { notice: `${user.username} is now a ${auth.ROLES[role].label}.` });
}));

router.post('/users/:id(\\d+)/active', wrap(async (req, res, next) => {
  const user = await Users.findInChurch(req.churchId, req.params.id);
  if (!user) return next();

  const activate = req.body.is_active === '1';

  if (!activate && user.role === 'admin' && (await Users.wouldOrphanAdmins(req.churchId, user.id))) {
    res.status(400);
    return renderUsers(req, res, { error: 'This is the only administrator — they cannot be deactivated.' });
  }

  await Users.setActive(user.id, activate);

  // Deactivating someone should log them out everywhere, not at their leisure.
  if (!activate) await Users.signOutEverywhere(user.id);

  return renderUsers(req, res, {
    notice: `${user.username} has been ${activate ? 'reactivated' : 'deactivated'}.`
  });
}));

router.post('/users/:id(\\d+)/password', wrap(async (req, res, next) => {
  const user = await Users.findInChurch(req.churchId, req.params.id);
  if (!user) return next();

  const passwordError = auth.validatePassword(req.body.password, req.body.password_confirm);
  if (passwordError) {
    res.status(400);
    return renderUsers(req, res, { error: `${user.username}: ${passwordError}` });
  }

  await Users.setPassword(user.id, await auth.hashPassword(req.body.password));

  return renderUsers(req, res, { notice: `Password reset for ${user.username}.` });
}));

router.post('/users/:id(\\d+)/delete', wrap(async (req, res, next) => {
  const user = await Users.findInChurch(req.churchId, req.params.id);
  if (!user) return next();

  if (user.id === req.user.id) {
    res.status(400);
    return renderUsers(req, res, { error: 'You cannot delete your own account.' });
  }
  if (user.role === 'admin' && (await Users.wouldOrphanAdmins(req.churchId, user.id))) {
    res.status(400);
    return renderUsers(req, res, { error: 'This is the only administrator — they cannot be deleted.' });
  }

  await Users.remove(user.id);
  await Users.signOutEverywhere(user.id);

  return renderUsers(req, res, { notice: `${user.username}'s account has been deleted.` });
}));

module.exports = router;
