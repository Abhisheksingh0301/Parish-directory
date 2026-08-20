'use strict';

const fs = require('fs');
const Churches = require('../models/church');
const Family = require('../models/family');
const csv = require('./csv');
const zip = require('./zip');
const upload = require('./upload');
const { slugify } = require('./slug');

/**
 * Taking the directory out of the directory.
 *
 * Two things leave this system, and a parish asking for "our data" means both:
 * the spreadsheet, and the photographs it names. Sent separately they arrive as
 * a file of rows and a folder of `1755431129-9f3c2a.jpg`, and nobody can say
 * which face belongs to which family. So the archive names each photograph
 * after the family it belongs to, and the spreadsheet carries the name in its
 * last column. Opening the zip beside the sheet is enough to match them by eye.
 *
 * One walk over the data serves both outputs. The rows go out as they are
 * built — down a response for the plain spreadsheet, into a buffer for the one
 * inside an archive, which has to be complete before its entry header can be
 * written — and the photographs are noted as they are passed and streamed
 * afterwards, so no image is ever held while the rows are being made.
 */

/**
 * Every column, in the order the parish already has them.
 *
 * `Photograph` is appended rather than slotted in beside the family's other
 * details: somebody has a spreadsheet built on last month's export, and a new
 * column in the middle moves every one after it.
 */
function headings(labels, withPhoto) {
  const columns = [
    labels.diocese, labels.zone, 'Church', 'Family ID', 'Head of family',
    'Address', 'Home Town', 'Home parish', 'Spouse home', 'Prayer group', 'Email',
    'Date of marriage', 'Member', 'Relation', 'Date of birth', 'Mobile',
    'Blood group', 'Qualification', 'Occupation', 'Links'
  ];
  return withPhoto ? [...columns, 'Photograph'] : columns;
}

/**
 * One family as CSV lines — one per member, with the family and church columns
 * repeated. That is the shape that pivots in a spreadsheet, which is what an
 * export is for; a family-per-row file cannot hold members at all without
 * inventing numbered columns.
 */
function familyRows(church, family, photoName) {
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
  const members = family.members && family.members.length
    ? family.members
    : [{
      name: '', relation: '', dob: '', mobile: '',
      blood_group: '', qualification: '', occupation: '', links: ''
    }];

  return members.map((m) => csv.row([
    ...base, m.name, m.relation, m.dob, m.mobile,
    m.blood_group, m.qualification, m.occupation, m.links,
    ...(photoName === null ? [] : [photoName || ''])
  ]));
}

/**
 * A UTF-8 byte order mark.
 *
 * Excel assumes the system codepage for a CSV without one and mangles every
 * non-ASCII name — which, in an Indian parish directory, is most of them.
 * Three bytes, and the difference between a usable file and a support call.
 */
const BOM = '﻿';

/**
 * Walk the chosen churches, writing rows as they are built.
 *
 * `write` is given a string at a time, so the caller decides where the file
 * goes: straight down a response for a download, or into a buffer for the copy
 * that goes inside an archive. `photoName`, when given, is asked for the name
 * this family's photograph will have in that archive and decides whether the
 * last column exists at all.
 *
 * Church by church rather than assembled in one query: a whole-installation
 * export is on the order of a hundred and sixty thousand rows.
 */
async function writeRows(write, churchIds, { labels, includeDrafts = true, photoName = null } = {}) {
  await write(BOM);
  await write(csv.row(headings(labels, !!photoName)));

  for (const churchId of churchIds) {
    const church = await Churches.findChurch(churchId);
    if (!church) continue;

    const families = await Family.listWithMembers(churchId, { publishedOnly: !includeDrafts });

    for (const family of families) {
      const name = photoName ? photoName(church, family) : null;
      for (const line of familyRows(church, family, photoName ? name : null)) {
        await write(line);
      }
    }
  }
}

/**
 * A `write` for `writeRows` that sends straight down a response, waiting for
 * the socket to drain rather than queueing a whole installation in memory.
 */
function streamTo(stream) {
  return (text) => {
    if (stream.write(text)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onDrain = () => { stream.off('error', onError); resolve(); };
      const onError = (err) => { stream.off('drain', onDrain); reject(err); };
      stream.once('drain', onDrain);
      stream.once('error', onError);
    });
  };
}

/**
 * Where a family's photograph sits inside the archive.
 *
 * Named after the family, because a random filename is what makes a folder of
 * images useless. `taken` keeps two families that somehow share an id — across
 * churches in a combined export, or after an import that repeated one — from
 * overwriting each other on the way out of the zip.
 */
function photoEntry(church, family, { perChurch, taken }) {
  const extension = String(family.photo).includes('.')
    ? String(family.photo).slice(String(family.photo).lastIndexOf('.')).toLowerCase()
    : '.jpg';

  const stem = [family.family_id, family.head_name]
    .map((part) => slugify(part, ''))
    .filter(Boolean)
    .join('-') || `family-${family.id}`;

  const folder = perChurch ? `photos/${slugify(church.slug || church.name, 'church')}` : 'photos';

  let candidate = `${folder}/${stem}${extension}`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) {
    candidate = `${folder}/${stem}-${n}${extension}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

function readme({ label, families, photos, missing, when }) {
  return [
    `${label}`,
    `Exported ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    'families.csv   One row per person, with the family and church repeated.',
    '               Its last column names that family\'s photograph in this archive.',
    'photos/        The photographs, named after the family they belong to.',
    '',
    `Families: ${families}`,
    `Photographs: ${photos}`,
    missing
      ? `Photographs recorded but missing from the server: ${missing}`
      : 'Every photograph on record was included.',
    '',
    'Open families.csv in a spreadsheet. If accented names look wrong, the',
    'file was opened as plain text rather than as UTF-8 — import it instead',
    'of double-clicking it.',
    ''
  ].join('\r\n');
}

/**
 * The whole export: a spreadsheet and the photographs it names, as one archive
 * written straight to `stream`.
 *
 * The rows are held while they are built — the entry has to be measured and
 * checksummed before its header goes out — but the photographs are not: each
 * is read, written and released, so an installation-sized export costs one
 * image of memory rather than all of them.
 */
async function bundle(stream, churchIds, { labels, label = 'Directory export', includeDrafts = true } = {}) {
  const archive = zip.create(stream);
  const perChurch = churchIds.length > 1;
  const taken = new Set();
  const photos = [];
  const rows = [];
  let families = 0;
  let missing = 0;

  await writeRows((text) => { rows.push(text); }, churchIds, {
    labels,
    includeDrafts,
    photoName(church, family) {
      families += 1;
      if (!family.photo) return '';

      const source = upload.photoPath(church.id, family.photo);
      // Named in the sheet only if the file is really there — a column
      // pointing at something the archive does not contain is worse than an
      // empty one.
      if (!source || !fs.existsSync(source)) {
        missing += 1;
        return '';
      }

      const name = photoEntry(church, family, { perChurch, taken });
      photos.push({ name, source });
      return name;
    }
  });

  await archive.add('families.csv', rows.join(''));
  await archive.add('README.txt', readme({
    label,
    families,
    photos: photos.length,
    missing,
    when: new Date()
  }));

  let written = 0;
  for (const photo of photos) {
    if (await archive.addFile(photo.name, photo.source)) written += 1;
  }

  await archive.finish();
  return { families, photos: written, missing };
}

module.exports = { writeRows, bundle, streamTo, headings, familyRows, BOM };
