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

/**
 * The heading the template prints for each column.
 *
 * These are the export's own headings wherever the two files hold the same
 * thing, so a spreadsheet downloaded from Download your data can be edited and
 * handed straight back without renaming a single column.
 */
const LABELS = {
  family_id: 'Family ID',
  head_name: 'Head of family',
  address: 'Address',
  hometown: 'Home Town',
  home_parish: 'Home parish',
  spouse_home: 'Spouse home',
  prayer_group: 'Prayer group',
  area: 'Area',
  email: 'Email',
  dom: 'Date of marriage',
  member_name: 'Member',
  relation: 'Relation',
  dob: 'Date of birth',
  mobile: 'Mobile',
  blood_group: 'Blood group',
  qualification: 'Qualification',
  occupation: 'Occupation',
  links: 'Links'
};

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

module.exports = { COLUMNS, LABELS, FIELDS, REQUIRED, normalise, mapHeader, headerRow };
