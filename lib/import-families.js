'use strict';

/**
 * Reading a parish's family sheet into the directory.
 *
 * This was the whole of bin/import-families.js, and it is out here for the
 * same reason lib/import-columns.js is: a second caller needs exactly the same
 * behaviour. That caller is the upload form on the Import members page, and
 * "exactly the same" is not a nicety — an office that has had a sheet checked
 * on screen and then hands the same file to whoever has a shell must not get a
 * different answer the second time. One implementation, two front ends.
 *
 * Nothing in here prints, reads a file or exits. The command line keeps its
 * console output and its rejects file; the route keeps its rendered page. What
 * they share is the reading, the grouping and the writing, which is all of the
 * part that could be wrong.
 *
 * The rules are unchanged and are documented at the head of
 * bin/import-families.js: one row per member, the Family ID groups them, a
 * family with any unreadable row is held back whole, a Family ID already in
 * the church is never overwritten, and nothing is discarded in silence.
 */

const csv = require('./csv');
const phones = require('./phone');
const addresses = require('./email');
const Family = require('../models/family');
const { readDate } = require('./import-dates');
const { mapHeader } = require('./import-columns');

const cellAt = (row, index) => (index === undefined ? '' : String(row[index] ?? '').trim());

/**
 * One sheet row, read into the shape the directory holds.
 *
 * Errors are collected rather than thrown: a row with an unreadable date of
 * birth is one reject line, and the other four hundred rows still read.
 */
function readRow(row, map, lineNumber) {
  const get = (field) => cellAt(row, map[field]);
  const errors = [];

  const familyRef = get('family_id');
  if (!familyRef) errors.push('no Family ID');

  // Both dates belong to the member now — a household with a married son in
  // it has two anniversaries, and one column on the family could hold one.
  const dom = readDate(get('dom'), { label: 'Date of marriage' });
  if (dom.error) errors.push(dom.error);

  const dob = readDate(get('dob'), { label: 'Date of birth' });
  if (dob.error) errors.push(dob.error);

  /*
   * Numbers and addresses are straightened out on the way in and checked the
   * same way the form checks them. A sheet may hold several of either in one
   * cell, which is why the list forms are used for the member's two.
   *
   * A bad one is a reject line, not a silent blank: importing "98771 9065" as
   * a mobile number would put a household nobody can ring into the printed
   * book, and nothing in the sheet would say so afterwards. The same goes
   * doubly for the family's own address, which is the household's login
   * username — a typo there is a family that cannot sign in to verify its own
   * entry, discovered weeks later when nobody can explain why.
   *
   * Each message names its column, because a sheet has two email columns and
   * "that is not an email address" against a line number does not say which.
   */
  const who = get('member_name') || familyRef;

  const badFamilyEmail = addresses.problem(get('email'));
  if (badFamilyEmail) errors.push(`Email (the family's own): ${badFamilyEmail}`);

  const badEmails = addresses.listProblem(get('emails'), who);
  if (badEmails) errors.push(`Emails: ${badEmails}`);

  const badMobile = phones.listProblem(get('mobile'), who);
  if (badMobile) errors.push(`Mobile: ${badMobile}`);

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
      prayer_group: get('prayer_group'),
      area: get('area'),
      email: get('email')
    },
    member: {
      name: get('member_name'),
      relation: get('relation'),
      dob_day: dob.day,
      dob_month: dob.month,
      dom_day: dom.day,
      dom_month: dom.month,
      mobile: phones.normaliseList(get('mobile')),
      blood_group: get('blood_group'),
      qualification: get('qualification'),
      occupation: get('occupation'),
      emails: addresses.normaliseList(get('emails'))
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

/**
 * A problem with the file as a whole, rather than with a row in it.
 *
 * Carried as its own error type so a caller can tell "this is not a sheet I
 * can read at all" from a bug, and put the message in front of the person
 * instead of on an error page.
 */
class SheetError extends Error {}

/**
 * Read a whole sheet: parse it, work out which column is which, and read every
 * row. No database, so this is the pass that can be run on anything.
 *
 * Throws SheetError when there is nothing worth reporting row by row.
 */
function readSheet(text) {
  const sheet = csv.parse(text);

  if (!sheet.length) {
    throw new SheetError('That file is empty.');
  }
  if (sheet.length < 2) {
    throw new SheetError('That file has a header row and nothing else.');
  }

  const [headerRow, ...bodyRows] = sheet;
  const { map, unknown } = mapHeader(headerRow);

  if (map.family_id === undefined) {
    throw new SheetError(
      'No Family ID column was found. One is required — it is what groups a ' +
      "family's rows together, and it is the parish's permanent reference."
    );
  }

  // Line 1 is the header, so the first row of data is line 2 — the number the
  // person will see down the side of their own spreadsheet.
  const rows = bodyRows.map((row, i) => readRow(row, map, i + 2));
  const { usable, rejects } = holdBackWholeFamilies(rows);

  return {
    headerRow,
    map,
    unknown,
    rows,
    usable,
    rejects,
    families: groupFamilies(usable)
  };
}

/**
 * The family's own columns, in the order the sheet carries them. `family_id`
 * is deliberately not among them: the reference a household is filed under is
 * the parish's own, it is what matched this row to this family in the first
 * place, and a sheet that spells it "a-12" does not get to renumber "A-12".
 */
const FAMILY_SHEET_FIELDS = [
  'head_name', 'address', 'hometown', 'home_parish', 'prayer_group', 'area', 'email'
];

/**
 * Bring a family the directory already holds up to date from the sheet.
 *
 * This is the second import a parish runs: the first one loaded four hundred
 * households, somebody found the addresses in it were a year out, and the
 * corrected sheet has the same four hundred Family IDs on it. Without this
 * every row of it is skipped as "already there", and the only way through is
 * to delete the parish and start again.
 *
 * What it writes, and what it deliberately leaves alone.
 *
 * A blank cell changes nothing. A sheet exported with only the columns
 * somebody was fixing is a normal thing to be handed, and reading its empty
 * cells as "delete what you hold" would quietly strip home parishes and
 * hometowns out of a directory nobody asked to change. Only a cell with
 * something in it overwrites.
 *
 * The members are replaced whole where the sheet lists any. That is the
 * office's own instruction — the sheet is the household as it now stands, so a
 * member who has left it is not on the sheet and should not survive it. Where
 * the sheet carries no member rows for the family at all, the existing members
 * are kept: a family-level sheet is correcting addresses, not emptying
 * households.
 *
 * The photograph, and whether the family is in the printed book, are not the
 * sheet's business. Neither has a column, and `Family.update` writes every
 * field it is given — so both are read off the record and handed back
 * unchanged rather than left to default themselves away. Where a family stands
 * on the verification chain is untouched for the same reason: `update` does
 * not write it, and an office correcting an address has not un-approved
 * anybody.
 *
 * One consequence worth knowing, because it is the price of replacing the
 * members: a correction sitting in the review queue against a member who is
 * rebuilt here no longer points at a row that exists. It is not lost and it
 * does not break the queue — models/pending.js folds a change whose member has
 * gone by leaving the record alone and marking the line applied — but it will
 * not arrive. The page says so before the office presses the button.
 */
async function updateFamily({ churchId, existing, family, line, dryRun, adjusted }) {
  const current = await Family.findById(churchId, existing.id);

  const values = {};
  for (const field of FAMILY_SHEET_FIELDS) {
    values[field] = family[field] || current[field] || '';
  }

  if (!values.head_name && family.members.length) {
    values.head_name = family.members[0].name;
    adjusted.push({
      reason: 'head-adopted',
      family_id: current.family_id,
      line,
      message: `${current.family_id}: no family head on the sheet, so ` +
               `"${values.head_name}" was taken from the first member`
    });
  }

  const members = family.members.length ? family.members : current.members;

  if (!dryRun) {
    await Family.update(churchId, current.id, {
      ...values,
      family_id: current.family_id,
      photo: current.photo,
      is_published: current.is_published,
      members
    });
  }

  return {
    family_id: current.family_id,
    head_name: values.head_name,
    members: members.length,
    members_replaced: family.members.length > 0,
    line,
    message: `${current.family_id} ${values.head_name} (${members.length} member(s))`
  };
}

/**
 * Create the families, or work out what creating them would do.
 *
 * `dryRun` reaches the database to ask what is already there but writes
 * nothing, and it is the same code path as the real run rather than a
 * description of it — which is the only way the check the parish is shown can
 * be trusted to match what the import then does.
 *
 * Everything comes back as an object with a `family_id`, a `line` and a
 * `reason` on it as well as a sentence: the command line prints the sentence,
 * and the page wants to point at the row and say it in its own words. A caller
 * that switches on `reason` is not parsing a message to find out what
 * happened, which is the thing that quietly breaks the day somebody improves
 * the wording.
 */
async function runImport({ churchId, churchName, families, dryRun = false, onExisting = 'skip' }) {
  const created = [];
  const updated = [];
  const skipped = [];
  const adjusted = [];
  const failed = [];

  for (const family of families) {
    const line = family.lines[0];

    try {
      const existing = await Family.findByRef(churchId, family.family_id);

      if (existing && onExisting !== 'update') {
        skipped.push({
          reason: 'already-there',
          family_id: family.family_id,
          line,
          message: `${family.family_id} is already in ${churchName}`
        });
        continue;
      }

      if (existing) {
        updated.push(await updateFamily({ churchId, existing, family, line, dryRun, adjusted }));
        continue;
      }

      // A family with no head named anywhere still has to be somebody, or the
      // printed entry has no title. The first member is the honest guess, and
      // it is reported rather than done in silence.
      if (!family.head_name && family.members.length) {
        family.head_name = family.members[0].name;
        adjusted.push({
          reason: 'head-adopted',
          family_id: family.family_id,
          line,
          message: `${family.family_id}: no family head on the sheet, so ` +
                   `"${family.head_name}" was taken from the first member`
        });
      }
      if (!family.head_name) {
        failed.push({
          reason: 'no-head',
          family_id: family.family_id,
          line,
          message: `${family.family_id} (line ${line}): no family head and no members`
        });
        continue;
      }

      if (!dryRun) {
        await Family.create(churchId, {
          ...family,
          // Imported entries start as drafts, so a sheet with half a parish in
          // it cannot put half a parish into the printed book before anybody
          // has looked at it.
          is_published: false,
          members: family.members
        });
      }

      created.push({
        family_id: family.family_id,
        head_name: family.head_name,
        members: family.members.length,
        line,
        message: `${family.family_id} ${family.head_name} (${family.members.length} member(s))`
      });
    } catch (err) {
      failed.push({
        reason: 'error',
        family_id: family.family_id,
        line,
        message: `${family.family_id}: ${err.message}`
      });
    }
  }

  return { created, updated, skipped, adjusted, failed };
}

module.exports = { SheetError, readSheet, runImport, readRow, groupFamilies, holdBackWholeFamilies };
