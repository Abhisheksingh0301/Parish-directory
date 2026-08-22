'use strict';

const csv = require('./csv');
const columns = require('./import-columns');

/**
 * The blank sheet the parish fills in.
 *
 * The import has always been able to read the office's own spreadsheet, which
 * is the point of the alias list — nobody should have to retype four hundred
 * families into somebody else's layout. But a parish that has *no* sheet, or
 * one that would rather start from the right shape than find out afterwards
 * which of its columns were ignored, had nothing to start from. This is that
 * starting point.
 *
 * Two things it deliberately does:
 *
 *   The headings come from the importer's own column list, so a heading
 *   printed here is a heading the importer reads back. The two cannot drift.
 *
 *   The relation codes in the example rows are this church's, out of its own
 *   settings, rather than a fixed "Head / Spouse / Son". A parish that has
 *   renamed them to HF / W / S should see HF / W / S in its template, because
 *   those are the codes its printed directory is expecting.
 */

/** The example a parish reads before it reads any instructions. */
function exampleRows(relations) {
  // Whatever this church calls the head, the spouse and the children. Falling
  // back rather than indexing blindly: a parish may have cut the list short.
  const head = relations[0] || 'Head';
  const spouse = relations[1] || 'Spouse';
  const son = relations[2] || 'Son';
  const daughter = relations[3] || son;

  const family = {
    family_id: 'F-001',
    head_name: 'Thomas Varghese',
    address: '12 Church Road\nKakkanad, Kochi 682030',
    hometown: 'Pala',
    home_parish: 'St Thomas Church, Pala',
    spouse_home: 'Chirayath',
    prayer_group: 'St Joseph Unit',
    area: 'Ward 3',
    email: 'thomas.varghese@example.com',
    // No year: this directory prints the day and month of a wedding, and a
    // year typed here is read and then dropped rather than refused.
    dom: '14-Jan'
  };

  const rows = [
    // The family's own columns are read from its first row, so the rest of the
    // household repeats the Family ID and leaves them blank. Repeating them
    // is allowed too — the sheet is not wrong either way.
    [family, {
      member_name: 'Thomas Varghese',
      relation: head,
      dob: '02-Aug-1975',
      mobile: '9876543210',
      blood_group: 'O+',
      qualification: 'B.Com',
      occupation: 'Accountant',
      links: ''
    }],
    [{ family_id: family.family_id }, {
      member_name: 'Mary Thomas',
      relation: spouse,
      // A second way of writing a date, on purpose: day first, and both are
      // read. "03/04/1978" is the third of April.
      dob: '03/04/1978',
      mobile: '9876543211',
      blood_group: 'A+',
      qualification: 'B.Sc Nursing',
      occupation: 'Nurse',
      links: ''
    }],
    [{ family_id: family.family_id }, {
      member_name: 'Anna Thomas',
      relation: daughter,
      // A date of birth nobody wrote the year of still keeps its day and
      // month, and the entry still prints its birthday.
      dob: '19-Sep',
      mobile: '',
      blood_group: '',
      qualification: 'Student',
      occupation: '',
      links: 'Studying in Bengaluru'
    }],
    [{
      family_id: 'F-002',
      head_name: 'Joseph Fernandes',
      address: '5 Beach Lane, Vypin 682508',
      hometown: 'Vypin',
      home_parish: '',
      spouse_home: '',
      prayer_group: 'Little Flower Unit',
      area: 'Ward 1',
      email: '',
      dom: ''
    }, {
      member_name: 'Joseph Fernandes',
      relation: head,
      dob: '1962-12-05',
      mobile: '9847000000',
      blood_group: 'B+',
      qualification: '',
      occupation: 'Fisherman',
      links: ''
    }],
    [{ family_id: 'F-002' }, {
      member_name: 'Peter Fernandes',
      relation: son,
      dob: '',
      mobile: '',
      blood_group: '',
      qualification: 'ITI',
      occupation: 'Electrician',
      links: ''
    }]
  ];

  return rows.map(([family_, member]) => {
    const values = { ...family_, ...member };
    return columns.FIELDS.map((field) => values[field] ?? '');
  });
}

/**
 * The template as a CSV file, ready to be written to a response.
 *
 * A byte order mark and CRLF line endings, the same as the export and the
 * rejects file: it is what makes Excel open the file as UTF-8 rather than
 * turning a Malayalam name into mojibake on the way in.
 */
function build({ relations = [], withExamples = true } = {}) {
  const lines = [csv.row(columns.headerRow())];

  if (withExamples) {
    for (const row of exampleRows(relations)) lines.push(csv.row(row));
  }

  return '﻿' + lines.join('');
}

module.exports = { build, exampleRows };
