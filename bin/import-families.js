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
 */

const fs = require('fs');
const path = require('path');
const db = require('../db');
const csv = require('../lib/csv');
const Family = require('../models/family');
const Churches = require('../models/church');
const audit = require('../lib/audit');
const { readDate } = require('../lib/import-dates');

// ---------------------------------------------------------------------------
// The column mapping
// ---------------------------------------------------------------------------

/**
 * Header names this will recognise, and what each becomes.
 *
 * Aliases rather than one fixed spelling, because the mapping is written
 * against the parish's actual sheet and no two parishes name these columns the
 * same way. Matching ignores case, spaces and punctuation, so "Family ID",
 * "family_id" and "FAMILY  ID." are one column.
 */
const COLUMNS = {
  family_id: ['family id', 'familyid', 'id', 'family no', 'family number', 'house no'],
  head_name: ['family head', 'head of family', 'head name', 'head', 'family head name'],
  address: ['address', 'present address', 'residential address'],
  hometown: ['home town', 'home town address', 'hometown', 'native place'],
  home_parish: ['home parish', 'native parish'],
  spouse_home: ['spouse home', 'spouse house', 'wife home'],
  prayer_group: ['prayer group', 'prayergroup', 'unit', 'kootayma'],
  area: ['area', 'ward', 'zone within parish'],
  email: ['email', 'email id', 'e mail', 'mail id'],
  dom: ['date of marriage', 'dom', 'wedding date', 'marriage date', 'wedding anniversary'],
  member_name: ['member', 'member name', 'name', 'person'],
  relation: ['relation', 'relationship', 'relation to head'],
  dob: ['date of birth', 'dob', 'birth date', 'birthday'],
  mobile: ['mobile', 'phone', 'mobile no', 'contact', 'contact number', 'phone number'],
  blood_group: ['blood group', 'bloodgroup', 'blood'],
  qualification: ['qualification', 'education', 'educational qualification'],
  occupation: ['occupation', 'job', 'profession', 'work'],
  links: ['links', 'notes', 'remarks']
};

const normalise = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const HEADER_LOOKUP = new Map();
for (const [field, aliases] of Object.entries(COLUMNS)) {
  for (const alias of aliases) HEADER_LOOKUP.set(normalise(alias), field);
}

/** Which column of the sheet holds which field, and which columns it ignores. */
function mapHeader(headerRow) {
  const map = {};
  const unknown = [];

  headerRow.forEach((raw, index) => {
    const key = normalise(raw);
    if (!key) return;

    const field = HEADER_LOOKUP.get(key);
    if (!field) {
      unknown.push(String(raw).trim());
      return;
    }
    // First occurrence wins: a sheet with two "Name" columns means the first.
    if (map[field] === undefined) map[field] = index;
  });

  return { map, unknown };
}

// ---------------------------------------------------------------------------
// Reading the sheet
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

const cellAt = (row, index) => (index === undefined ? '' : String(row[index] ?? '').trim());

/**
 * One sheet row, read into the shape the directory holds.
 *
 * Errors are collected rather than thrown: a row with an unreadable date of
 * birth is one reject line, and the other four hundred rows still import.
 */
function readRow(row, map, lineNumber) {
  const get = (field) => cellAt(row, map[field]);
  const errors = [];

  const familyRef = get('family_id');
  if (!familyRef) errors.push('no Family ID');

  const dom = readDate(get('dom'), { label: 'Date of marriage', full: false });
  if (dom.error) errors.push(dom.error);

  const dob = readDate(get('dob'), { label: 'Date of birth', full: true });
  if (dob.error) errors.push(dob.error);

  return {
    line: lineNumber,
    raw: row,
    errors,
    family_ref: familyRef,
    family: {
      family_id: familyRef,
      head_name: get('head_name'),
      address: get('address'),
      hometown: get('hometown'),
      home_parish: get('home_parish'),
      spouse_home: get('spouse_home'),
      prayer_group: get('prayer_group'),
      area: get('area'),
      email: get('email'),
      dom_day: dom.day,
      dom_month: dom.month
    },
    member: {
      name: get('member_name'),
      relation: get('relation'),
      dob_day: dob.day,
      dob_month: dob.month,
      dob_year: dob.year,
      mobile: get('mobile'),
      blood_group: get('blood_group'),
      qualification: get('qualification'),
      occupation: get('occupation'),
      links: get('links')
    }
  };
}

/**
 * Group the rows into families.
 *
 * The family's own columns come from the first row carrying that Family ID; a
 * later row that repeats them is not a contradiction to resolve, it is a
 * spreadsheet repeating itself down a merged block. Where a later row fills in
 * a family column the first row left blank, that value is taken — the sheet
 * knows something the first row did not.
 */
function groupFamilies(rows) {
  const families = new Map();

  for (const row of rows) {
    const key = row.family_ref.toLowerCase();

    if (!families.has(key)) {
      families.set(key, { ...row.family, lines: [], members: [], rows: [] });
    }
    const family = families.get(key);
    family.lines.push(row.line);
    family.rows.push(row);

    for (const [field, value] of Object.entries(row.family)) {
      if (!family[field] && value) family[field] = value;
    }

    if (row.member.name) family.members.push(row.member);
  }

  return [...families.values()];
}

/**
 * A family is imported whole, or not at all.
 *
 * One unreadable date in the third row of a family used to cost that one
 * member: the other rows imported, the family was created without them, and a
 * re-import after correcting the sheet would report the family as already
 * there and never add the missing person. Silent, permanent, and exactly the
 * failure the rejects file exists to prevent.
 *
 * So a family with any unreadable row is held back entirely, and every one of
 * its rows is written to the rejects file — the offending row with its own
 * reason, its siblings with the reason they are keeping it company. Correct
 * that one cell, import again, and the whole family arrives.
 */
function holdBackWholeFamilies(rows) {
  const spoiled = new Map();
  for (const row of rows) {
    if (!row.errors.length || !row.family_ref) continue;
    const key = row.family_ref.toLowerCase();
    if (!spoiled.has(key)) spoiled.set(key, row.family_ref);
  }

  const usable = [];
  const rejects = [];

  for (const row of rows) {
    const key = String(row.family_ref).toLowerCase();

    if (row.errors.length) {
      rejects.push(row);
    } else if (spoiled.has(key)) {
      rejects.push({
        ...row,
        errors: [`Another row for family ${spoiled.get(key)} could not be read, ` +
                 'so the whole family was held back. Correct that row and import again.']
      });
    } else {
      usable.push(row);
    }
  }

  return { usable, rejects };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

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

  const sheet = csv.parse(fs.readFileSync(file, 'utf8'));
  if (sheet.length < 2) throw new Error('That file has a header row and nothing else.');

  const [headerRow, ...bodyRows] = sheet;
  const { map, unknown } = mapHeader(headerRow);

  if (map.family_id === undefined) {
    throw new Error(
      'No Family ID column was found. One is required — it is what groups a ' +
      "family's rows together, and it is the parish's permanent reference."
    );
  }

  await db.init();
  const church = await resolveChurch(flags.church);

  const rows = bodyRows.map((row, i) => readRow(row, map, i + 2));
  const { usable, rejects } = holdBackWholeFamilies(rows);

  const families = groupFamilies(usable);

  const created = [];
  const skipped = [];
  const adjusted = [];
  const failed = [];

  for (const family of families) {
    try {
      if (await Family.familyIdTaken(church.id, family.family_id)) {
        skipped.push(`${family.family_id} is already in ${church.name}`);
        continue;
      }

      // A family with no head named anywhere still has to be somebody, or the
      // printed entry has no title. The first member is the honest guess, and
      // it is reported rather than done in silence.
      if (!family.head_name && family.members.length) {
        family.head_name = family.members[0].name;
        adjusted.push(
          `${family.family_id}: no family head on the sheet, so "${family.head_name}" was taken from the first member`
        );
      }
      if (!family.head_name) {
        failed.push(`${family.family_id} (line ${family.lines[0]}): no family head and no members`);
        continue;
      }

      if (!dryRun) {
        await Family.create(church.id, {
          ...family,
          // Imported entries start as drafts, so a sheet with half a parish in
          // it cannot put half a parish into the printed book before anybody
          // has looked at it.
          is_published: false,
          members: family.members
        });
      }
      created.push(`${family.family_id} ${family.head_name} (${family.members.length} member(s))`);
    } catch (err) {
      failed.push(`${family.family_id}: ${err.message}`);
    }
  }

  // --- the report ---

  console.log(`\n${dryRun ? 'Would import' : 'Imported'} into ${church.name} from ${path.basename(file)}:`);
  console.log(`  ${created.length} famil${created.length === 1 ? 'y' : 'ies'}`);
  console.log(`  ${usable.length} member row(s) read`);

  if (unknown.length) {
    console.log(`\nColumns this directory has no home for (nothing was dropped in silence):`);
    unknown.forEach((name) => console.log(`  "${name}"`));
  }

  if (skipped.length) {
    console.log(`\nAlready there, so not touched (${skipped.length}):`);
    skipped.slice(0, 15).forEach((m) => console.log(`  ${m}`));
    if (skipped.length > 15) console.log(`  …and ${skipped.length - 15} more`);
  }

  if (adjusted.length) {
    console.log(`\nRead, with a decision made for you (${adjusted.length}):`);
    adjusted.forEach((m) => console.log(`  ${m}`));
  }

  if (failed.length) {
    console.log(`\nRefused (${failed.length}):`);
    failed.forEach((m) => console.log(`  ${m}`));
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
