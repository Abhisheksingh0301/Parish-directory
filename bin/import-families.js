#!/usr/bin/env node
'use strict';

/**
 * Load the parish's existing families from its own spreadsheet.
 *
 * This is a precondition of the verification exercise rather than an optional
 * extra. The whole objective — that no family should key in what the parish
 * already holds — depends on every family finding its existing record already
 * on screen, with only the corrections left to make.
 *
 *     node bin/import-families.js --church st-marys --file parish.csv --dry-run
 *     node bin/import-families.js --church st-marys --file parish.csv --rejects bad.csv
 *
 * The reading, grouping and writing moved to lib/import-families.js when the
 * Import members page grew an upload form: the office checking a sheet in the
 * browser and the operator running it here have to get the same answer, and
 * the only way to promise that is one implementation. What is left in this
 * file is the parts a shell has and a browser does not — arguments, a file on
 * disk, a rejects file, and a report printed to a terminal.
 *
 * ── The rules, which are the ones the hierarchy import already proved ───────
 *
 *   One row per member.       The Family ID groups a family's rows together,
 *                             so the family's own columns are read from the
 *                             first row carrying that ID and the member
 *                             columns from every row.
 *
 *   A dry run first.          `--dry-run` reports everything it would create
 *                             and every row it cannot read, without writing
 *                             anything at all. The parish sees the outcome
 *                             before committing to it.
 *
 *   Safe to run more than     A Family ID already in this church is reported
 *   once.                     as skipped, never duplicated and never
 *                             overwritten — a correction the office has
 *                             already made by hand is not undone by an import
 *                             somebody runs again.
 *
 *   A rejects file.           `--rejects` writes precisely the rows that could
 *                             not be read, and why, in the same columns. The
 *                             parish fixes those rows in the spreadsheet and
 *                             imports again, instead of hunting for what went
 *                             missing.
 *
 *   Nothing is discarded      A date of birth recorded without a year keeps
 *   silently.                 its day and month, and the entry still prints
 *                             correctly. A column this directory has no home
 *                             for is reported, not dropped in silence.
 *
 *   No logins are created.    Accounts are a separate, deliberate step. A few
 *                             hundred families should not quietly become a few
 *                             hundred live accounts.
 *
 * One difference from the upload form, and it is deliberate. This keeps going:
 * it imports what it can and reports what it could not, because the operator
 * running it has the rejects file, a shell and the ability to re-run. The form
 * refuses the whole file unless it is clean, because the parish administrator
 * has none of those and "47 of your 60 families arrived" is not an outcome
 * anybody can act on from a web page.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db');
const csv = require('../lib/csv');
const Churches = require('../models/church');
const audit = require('../lib/audit');
const importer = require('../lib/import-families');

// The column list a sheet is read with is shared with the template the parish
// downloads, so a heading offered there is a heading read back here.
const { COLUMNS } = require('../lib/import-columns');

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      flags[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return flags;
}

function usage() {
  console.log(`
Usage:
  node bin/import-families.js --church <slug or id> --file <sheet.csv> [--dry-run] [--rejects <file.csv>]

The sheet has one row per member; the Family ID groups a family's rows together.
Recognised column headings (any letter case, any punctuation):

${Object.entries(COLUMNS)
    .map(([field, aliases]) => `  ${field.padEnd(16)} ${aliases.slice(0, 4).join(' / ')}`)
    .join('\n')}

Run it with --dry-run first. Nothing is written, and it reports exactly what it
would create and every row it cannot read.
`);
}

async function resolveChurch(reference) {
  const asNumber = Number(reference);
  const church = Number.isInteger(asNumber) && asNumber > 0
    ? await Churches.findChurch(asNumber)
    : await Churches.findChurchBySlug(String(reference).trim());

  if (!church) throw new Error(`No church matches "${reference}".`);
  if (!church.is_active) throw new Error(`"${church.name}" is not active.`);
  return church;
}

function writeRejects(file, headerRow, rejects) {
  const out = [csv.row([...headerRow, 'Why this row was not imported'])];
  for (const reject of rejects) {
    out.push(csv.row([...reject.raw, reject.errors.join('; ')]));
  }
  fs.writeFileSync(file, '﻿' + out.join(''), 'utf8');
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const dryRun = !!flags['dry-run'];

  if (!flags.file || flags.file === true || !flags.church || flags.church === true) {
    usage();
    return 0;
  }

  const file = path.resolve(String(flags.file));
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);

  const sheet = importer.readSheet(fs.readFileSync(file, 'utf8'));
  const { headerRow, unknown, usable, rejects, families } = sheet;

  await db.init();
  const church = await resolveChurch(flags.church);

  const { created, skipped, adjusted, failed } = await importer.runImport({
    churchId: church.id,
    churchName: church.name,
    families,
    dryRun
  });

  // --- the report ---

  console.log(`\n${dryRun ? 'Would import' : 'Imported'} into ${church.name} from ${path.basename(file)}:`);
  console.log(`  ${created.length} famil${created.length === 1 ? 'y' : 'ies'}`);
  console.log(`  ${usable.length} member row(s) read`);

  if (unknown.length) {
    console.log('\nColumns this directory has no home for (nothing was dropped in silence):');
    unknown.forEach((name) => console.log(`  "${name}"`));
  }

  if (skipped.length) {
    console.log(`\nAlready there, so not touched (${skipped.length}):`);
    skipped.slice(0, 15).forEach((m) => console.log(`  ${m.message}`));
    if (skipped.length > 15) console.log(`  …and ${skipped.length - 15} more`);
  }

  if (adjusted.length) {
    console.log(`\nRead, with a decision made for you (${adjusted.length}):`);
    adjusted.forEach((m) => console.log(`  ${m.message}`));
  }

  if (failed.length) {
    console.log(`\nRefused (${failed.length}):`);
    failed.forEach((m) => console.log(`  ${m.message}`));
  }

  if (rejects.length) {
    console.log(`\nRows that could not be read (${rejects.length}):`);
    rejects.slice(0, 10).forEach((r) => console.log(`  line ${r.line}: ${r.errors.join('; ')}`));
    if (rejects.length > 10) console.log(`  …and ${rejects.length - 10} more`);

    if (flags.rejects && flags.rejects !== true) {
      const rejectFile = path.resolve(String(flags.rejects));
      writeRejects(rejectFile, headerRow, rejects);
      console.log(`\n  Written to ${rejectFile} — correct those rows and import again.`);
    } else {
      console.log('\n  Pass --rejects <file.csv> to have exactly these rows written out.');
    }
  }

  if (dryRun) {
    console.log('\nNothing was written. Run it again without --dry-run.');
  } else if (created.length) {
    await audit.record({ user: { id: null, username: 'command line' } }, 'family.imported', {
      churchId: church.id,
      detail: `${created.length} family/families imported from ${path.basename(file)}`
    });
    console.log('\nImported families are drafts, so nothing has entered the printed book.');
    console.log('No logins were created — accounts are a separate, deliberate step.');
  }
  console.log('');

  return rejects.length || failed.length ? 1 : 0;
}

main()
  .then(async (code) => { await db.close().catch(() => {}); process.exit(code); })
  .catch(async (err) => {
    console.error(`\n${err.message}\n`);
    await db.close().catch(() => {});
    process.exit(1);
  });
