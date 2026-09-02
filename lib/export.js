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
 * Every column, in the order the entry itself reads.
 *
 * This order changed once, with the Parish's revision of what an entry says
 * (migration 11), and the change is not cosmetic: Spouse home has gone, Links
 * is now Emails, and the date of marriage has moved out of the family block
 * into the member block, because a household can hold more than one married
 * couple. A spreadsheet built on an older export needs remapping — which is
 * exactly what lib/import-columns.js exists to make survivable, and why every
 * old heading is still an accepted alias there.
 *
 * `Area / Unit` is new here. It was missing from the export while being one of
 * the two ways the whole directory is filtered, so an exported sheet could not
 * reproduce the follow-up lists the parish works from.
 *
 * `Photograph` stays appended rather than slotted in beside the family's other
 * details, so turning photographs on does not move every column after it.
 */
function headings(labels, withPhoto) {
  const columns = [
    labels.diocese, labels.zone, 'Church', 'Family ID', 'Head of family',
    'Residence', 'Prayer group', 'Area / Unit', 'Home parish (HOF)',
    'Home Town Name / Address (HOF)', 'Email',
    'Member', 'Relation', 'Date of birth', 'Date of marriage', 'Mobile',
    'Blood group', 'Qualification', 'Occupation', 'Emails'
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
    family.prayer_group,
    family.area,
    family.home_parish,
    family.hometown,
    family.email
  ];

  // A family with no members still deserves a row, or it vanishes.
  const members = family.members && family.members.length
    ? family.members
    : [{
      name: '', relation: '', dob: '', dom: '', mobile: '',
      blood_group: '', qualification: '', occupation: '', emails: ''
    }];

  return members.map((m) => csv.row([
    ...base, m.name, m.relation, m.dob, m.dom, m.mobile,
    m.blood_group, m.qualification, m.occupation, m.emails,
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

/**
 * The photographs on their own, each named after its family and nothing else.
 *
 * Deliberately named differently from the photographs inside `bundle`. There,
 * a file is `F-001-thomas-mathew.jpg`, because it sits beside a spreadsheet
 * and a person is matching faces to rows by eye. Here the file is exactly
 * `F-001.jpg`, because this archive is the one the Import photographs page
 * reads back: download the folder, replace the half-dozen pictures that are
 * wrong, upload the same folder again. A name with the head of family in it
 * would not survive that trip, and a round trip that needs the parish to
 * rename two hundred files is not a round trip.
 *
 * For the same reason there is no README.txt in here. Every explanation this
 * archive needs is on the page that offers it, and a text file in the folder
 * would come back on the next upload as a file that is not a photograph.
 *
 * One image is read, written and released at a time, so a parish of two
 * thousand photographs costs one image of memory rather than all of them.
 */
async function photoBundle(stream, churchId, { folder = 'photos', includeDrafts = true } = {}) {
  const archive = zip.create(stream);
  const families = await Family.photoFiles(churchId, { publishedOnly: !includeDrafts });
  const taken = new Set();

  let written = 0;
  let missing = 0;

  for (const family of families) {
    const source = upload.photoPath(churchId, family.photo);
    if (!source || !fs.existsSync(source)) {
      missing += 1;
      continue;
    }

    const extension = String(family.photo).includes('.')
      ? String(family.photo).slice(String(family.photo).lastIndexOf('.')).toLowerCase()
      : '.jpg';

    /*
     * The Family ID as the parish wrote it, with only the characters a file
     * name cannot hold replaced. `slugify` is not used here and must not be:
     * it would turn "F-001" into "f-001" and "12/A" into "12-a", and the point
     * of this name is that it is the reference the office recognises.
     *
     * A Family ID is unique within a church and this export is one church, so
     * the counter below should never fire. It is here because a name silently
     * overwriting another inside a zip is not a failure anyone would notice.
     */
    const stem = String(family.family_id).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim()
      || `family-${family.id}`;

    let name = `${folder}/${stem}${extension}`;
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
      name = `${folder}/${stem}-${n}${extension}`;
    }
    taken.add(name.toLowerCase());

    if (await archive.addFile(name, source)) written += 1;
  }

  await archive.finish();
  return { photos: written, missing };
}

module.exports = { writeRows, bundle, photoBundle, streamTo, headings, familyRows, BOM };
