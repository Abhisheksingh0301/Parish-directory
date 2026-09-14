'use strict';

/**
 * The columns a family sheet may have, in one place.
 *
 * This started inside bin/import-families.js, which was the only thing that
 * needed it. It is out here now because a second thing needs exactly the same
 * list: the blank sheet the parish downloads to fill in. A template written
 * against a copy of the list is a template that goes stale the first time an
 * alias is added — the office fills in a column the importer has since stopped
 * recognising, and nobody finds out until four hundred rows are rejected.
 *
 * So the importer and the template are generated from this one list, and the
 * headings the template prints are guaranteed to be headings the importer
 * reads back.
 */

/**
 * Header names this will recognise, and what each becomes.
 *
 * Aliases rather than one fixed spelling, because the mapping is written
 * against the parish's actual sheet and no two parishes name these columns the
 * same way. Matching ignores case, spaces and punctuation, so "Family ID",
 * "family_id" and "FAMILY  ID." are one column.
 */
/*
 * The order of the keys below is the order of the file — the template prints
 * them in it, the export writes them in it, and it is the order of the
 * Parish's own working sheet: who the family is, then who this row is, then
 * where they live and how to reach them.
 *
 * Reordering is safe for reading a sheet back, because a column is found by
 * its heading and not by its position. It is not cosmetic for writing one: it
 * is what makes a downloaded export and a downloaded blank template the same
 * file, so a parish can export, edit in Excel and upload the result.
 */
const COLUMNS = {
  // A parish's own printed order, when it keeps one that Family ID does not
  // reproduce — see bySortOrder in models/family.js. Optional: a sheet with
  // no such column, or a blank cell on one row, just leaves that family
  // ordered by Family ID the way the book has always sorted it.
  sort_order: ['sort order', 'sl no', 'sr no', 'serial no', 'serial number', 'sequence'],
  family_id: ['family id', 'familyid', 'id', 'family no', 'family number', 'house no'],
  head_name: ['family head', 'head of family', 'head name', 'head', 'family head name'],
  member_name: ['member', 'member name', 'name', 'person'],
  relation: ['relation', 'relationship', 'relation to head'],
  dob: ['date of birth', 'dob', 'birth date', 'birthday'],
  address: ['residence', 'address', 'present address', 'residential address'],
  hometown: [
    'home town name address hof', 'home town name address',
    'home town', 'home town address', 'hometown', 'native place'
  ],
  home_parish: ['home parish hof', 'home parish', 'native parish'],
  /*
   * The one grouping a family has. "Area" and "Unit" are aliases rather than
   * a column of their own: the Area was dropped (migration 13) because this
   * Parish files a household under exactly one grouping, and a sheet written
   * before that — or by a parish that calls the same thing an Area — still
   * has to import into the field that survived.
   */
  prayer_group: [
    'prayer group', 'prayergroup', 'unit', 'kootayma',
    'area unit', 'area', 'ward', 'zone within parish'
  ],
  email: ['email', 'email id', 'e mail', 'mail id'],
  dom: ['date of marriage', 'dom', 'wedding date', 'marriage date', 'wedding anniversary'],
  mobile: ['mobile', 'phone', 'mobile no', 'contact', 'contact number', 'phone number'],
  blood_group: ['blood group', 'bloodgroup', 'blood'],
  qualification: ['qualification', 'education', 'educational qualification'],
  occupation: ['occupation', 'job', 'profession', 'work'],
  // Was `links`, free text that in practice held addresses. The old heading
  // still maps, so a sheet exported before the change imports unchanged.
  emails: ['emails', 'email addresses', 'member email', 'links']
};

/**
 * The heading the template prints for each column.
 *
 * These are the export's own headings wherever the two files hold the same
 * thing, so a spreadsheet downloaded from Download your data can be edited and
 * handed straight back without renaming a single column.
 */
const LABELS = {
  sort_order: 'Sort Order',
  family_id: 'Family ID',
  head_name: 'Head of family',
  member_name: 'Member',
  relation: 'Relation',
  dob: 'Date of birth',
  address: 'Residence',
  hometown: 'Home Town Name / Address (HOF)',
  home_parish: 'Home Parish (HOF)',
  prayer_group: 'Prayer Group',
  email: 'Email',
  dom: 'Date of marriage',
  mobile: 'Mobile',
  blood_group: 'Blood group',
  qualification: 'Qualification',
  occupation: 'Occupation',
  emails: 'Emails'
};

/**
 * Which of those belong to the family rather than to the person on the row.
 *
 * A sheet repeats the Family ID down a household and fills these in once, on
 * its first row — that is the shape the Parish's own spreadsheet has, it is
 * what the importer reads (see `groupFamilies`), and it is what the export
 * writes. Naming the split here keeps the two ends of the round trip agreeing
 * about it.
 */
const FAMILY_FIELDS = [
  'sort_order', 'head_name', 'address', 'hometown',
  'home_parish', 'prayer_group', 'email'
];

/** The one column the importer refuses a sheet without. */
const REQUIRED = ['family_id'];

const FIELDS = Object.keys(COLUMNS);

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

/** The template's header row, in the order the columns are printed. */
function headerRow() {
  return FIELDS.map((field) => LABELS[field]);
}

module.exports = {
  COLUMNS, LABELS, FIELDS, FAMILY_FIELDS, REQUIRED, normalise, mapHeader, headerRow
};
