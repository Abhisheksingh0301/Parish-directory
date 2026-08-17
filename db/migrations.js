'use strict';

/**
 * Schema history, applied in order and recorded in `schema_version`.
 *
 * ── On portability ─────────────────────────────────────────────────────────
 * The application's queries are engine-agnostic; this file is the one place
 * that is not entirely. Migrations 1 and 2 are the SQLite SQL that has already
 * shipped to a running parish, kept verbatim: rewriting them through
 * queryInterface risks producing a subtly different schema for new installs
 * than the one existing installs already have, and that is a bad trade for
 * tidiness. Everything from migration 3 onwards is written with queryInterface
 * and standard SQL, so it runs anywhere.
 *
 * Pointing this app at PostgreSQL therefore means writing one baseline
 * migration that creates the tables migrations 1–2 create. It is an afternoon,
 * once — not a rewrite of the app.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * Never edit a migration that has shipped. Append a new one, so a directory
 * already running an older copy upgrades cleanly.
 */

const { DataTypes, QueryTypes } = require('sequelize');
const config = require('../config');
const { slugify } = require('../lib/slug');

/**
 * Settings that belong to one church rather than to the installation.
 * Migration 3 copies these into `church_settings`; the originals stay behind
 * in `settings` as the fallback a newly created church starts from.
 */
const CHURCH_SETTING_KEYS = [
  'parish_name',
  'directory_title',
  'starting_page',
  'per_page',
  'relation_options',
  'approval_tiers',
  'routine_fields',
  'color_band',
  'color_band_dark',
  'color_member_a',
  'color_member_b',
  'color_rule'
];


// ---------------------------------------------------------------------------
// 1 — the original schema, as shipped. SQLite SQL, kept verbatim.
// ---------------------------------------------------------------------------

const SCHEMA_V1 = [
  `CREATE TABLE families (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     family_id    TEXT NOT NULL UNIQUE COLLATE NOCASE,
     head_name    TEXT NOT NULL,
     address      TEXT NOT NULL DEFAULT '',
     hometown     TEXT NOT NULL DEFAULT '',
     home_parish  TEXT NOT NULL DEFAULT '',
     spouse_home  TEXT NOT NULL DEFAULT '',
     email        TEXT NOT NULL DEFAULT '',
     photo        TEXT,
     dom_day      INTEGER,
     dom_month    INTEGER,
     is_published INTEGER NOT NULL DEFAULT 1,
     created_at   TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE members (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     position  INTEGER NOT NULL DEFAULT 0,
     name      TEXT NOT NULL,
     relation  TEXT NOT NULL DEFAULT '',
     dob_day   INTEGER,
     dob_month INTEGER,
     dob_year  INTEGER,
     mobile    TEXT NOT NULL DEFAULT '',
     links     TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE TABLE users (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
     password_hash TEXT NOT NULL,
     full_name     TEXT NOT NULL DEFAULT '',
     role          TEXT NOT NULL DEFAULT 'viewer',
     is_active     INTEGER NOT NULL DEFAULT 1,
     family_id     INTEGER UNIQUE REFERENCES families(id) ON DELETE CASCADE,
     on_default_password INTEGER NOT NULL DEFAULT 0,
     created_at    TEXT NOT NULL DEFAULT (datetime('now')),
     last_login_at TEXT
   )`,
  `CREATE INDEX idx_members_family ON members(family_id, position)`,
  `CREATE INDEX idx_families_head  ON families(head_name COLLATE NOCASE)`,
  `CREATE TABLE settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE sessions (
     sid     TEXT PRIMARY KEY,
     expires INTEGER NOT NULL,
     data    TEXT NOT NULL
   )`,
  `CREATE INDEX idx_sessions_expires ON sessions(expires)`
];

// ---------------------------------------------------------------------------
// 2 — relation codes become words. As shipped.
// ---------------------------------------------------------------------------

const RELATIONS_V2 = [
  `UPDATE members SET relation = CASE UPPER(TRIM(relation))
     WHEN 'HF' THEN 'Head'
     WHEN 'W'  THEN 'Wife'
     WHEN 'S'  THEN 'Son'
     WHEN 'D'  THEN 'Daughter'
     WHEN 'F'  THEN 'Father'
     WHEN 'M'  THEN 'Mother'
     WHEN 'B'  THEN 'Brother'
     WHEN 'SR' THEN 'Sister'
     WHEN 'GF' THEN 'Grandfather'
     WHEN 'GM' THEN 'Grandmother'
     ELSE relation
   END`,
  `UPDATE settings
      SET value = 'Head, Wife, Son, Daughter, Father, Mother, Brother, Sister, Grandfather, Grandmother'
    WHERE key = 'relation_options'
      AND value = 'HF, W, S, D, F, M, B, Sr, GF, GM'`
];

// ---------------------------------------------------------------------------
// 3 — one install stops being one church
// ---------------------------------------------------------------------------

const TIMESTAMP = { type: DataTypes.STRING, allowNull: false };
const ID = { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true };

async function addChurchHierarchy({ qi, sequelize, transaction }) {
  const opts = { transaction };
  const nowLiteral = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const countRows = async (table) => {
    const [row] = await sequelize.query(`SELECT COUNT(*) AS n FROM ${table}`, {
      type: QueryTypes.SELECT,
      transaction
    });
    return Number(row.n);
  };

  /**
   * This migration rebuilds `families`, which means dropping a table that
   * `members` and the household logins in `users` both point at. Get that
   * wrong — leave foreign keys enabled, and the drop cascades — and the
   * directory empties itself while the migration reports success.
   *
   * So the counts are taken before and checked after. Nothing here is supposed
   * to remove a single row; if one goes missing the migration fails and the
   * whole thing rolls back, rather than a parish discovering it later.
   */
  const before = {
    families: await countRows('families'),
    members: await countRows('members'),
    users: await countRows('users')
  };

  await qi.createTable('dioceses', {
    id: ID,
    name: { type: DataTypes.TEXT, allowNull: false, unique: true },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_at: TIMESTAMP
  }, opts);

  await qi.createTable('zones', {
    id: ID,
    diocese_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'dioceses', key: 'id' }
    },
    name: { type: DataTypes.TEXT, allowNull: false },
    created_at: TIMESTAMP
  }, {
    ...opts,
    // Two dioceses may each have a "St Thomas" zone; one diocese may not.
    uniqueKeys: { zones_diocese_name: { fields: ['diocese_id', 'name'] } }
  });

  await qi.createTable('churches', {
    id: ID,
    diocese_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'dioceses', key: 'id' }
    },
    // Nullable, and never cascading: dissolving a zone must not delete parishes.
    zone_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'zones', key: 'id' },
      onDelete: 'SET NULL'
    },
    name: { type: DataTypes.TEXT, allowNull: false },
    slug: { type: DataTypes.TEXT, allowNull: false, unique: true },
    city: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_at: TIMESTAMP
  }, opts);

  await qi.addIndex('zones', ['diocese_id', 'name'], { name: 'idx_zones_diocese', ...opts });
  await qi.addIndex('churches', ['diocese_id', 'name'], { name: 'idx_churches_diocese', ...opts });
  await qi.addIndex('churches', ['zone_id', 'name'], { name: 'idx_churches_zone', ...opts });

  await qi.createTable('church_settings', {
    church_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      references: { model: 'churches', key: 'id' },
      onDelete: 'CASCADE'
    },
    key: { type: DataTypes.TEXT, primaryKey: true },
    value: { type: DataTypes.TEXT, allowNull: false }
  }, opts);

  // A database with rows in it is one parish's directory, so it becomes church
  // 1 of diocese 1 and nothing it holds changes hands. A fresh database gets
  // neither — the super administrator builds the real hierarchy, and a phantom
  // church would only be something to delete. No zone is invented either way:
  // guessing a forane name would be fiction.
  const [counts] = await sequelize.query(
    'SELECT (SELECT COUNT(*) FROM families) + (SELECT COUNT(*) FROM users) AS n',
    { type: QueryTypes.SELECT, transaction }
  );
  const isUpgrade = Number(counts.n) > 0;

  if (isUpgrade) {
    const [row] = await sequelize.query(
      `SELECT value FROM settings WHERE key = 'parish_name'`,
      { type: QueryTypes.SELECT, transaction }
    );
    const churchName = (row && String(row.value).trim()) || 'This church';

    await qi.bulkInsert('dioceses', [{
      id: 1, name: config.seed.dioceseName, is_active: true, created_at: nowLiteral
    }], opts);

    await qi.bulkInsert('churches', [{
      id: 1,
      diocese_id: 1,
      zone_id: null,
      name: churchName,
      slug: slugify(churchName, 'church-1'),
      city: '',
      is_active: true,
      created_at: nowLiteral
    }], opts);
  }

  // `families.family_id` was unique across the whole table — right for one
  // parish, wrong the moment there are two, since both numbering from "0001"
  // is normal rather than a clash. A constraint cannot be altered in place on
  // SQLite, so the table is rebuilt. Every step here is standard SQL or a
  // queryInterface call, so this runs on any engine.
  //
  // One deliberate loss: the old column carried COLLATE NOCASE, which has no
  // portable equivalent. Case-insensitive matching of a family reference now
  // lives in models/family.js (`familyIdTaken`), which compares on lower().
  await qi.createTable('families_new', {
    id: ID,
    church_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'churches', key: 'id' },
      onDelete: 'CASCADE'
    },
    family_id: { type: DataTypes.TEXT, allowNull: false },
    head_name: { type: DataTypes.TEXT, allowNull: false },
    address: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    hometown: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    home_parish: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    spouse_home: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    email: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    photo: { type: DataTypes.TEXT, allowNull: true },
    dom_day: { type: DataTypes.INTEGER, allowNull: true },
    dom_month: { type: DataTypes.INTEGER, allowNull: true },
    is_published: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP
  }, {
    ...opts,
    uniqueKeys: { families_church_family: { fields: ['church_id', 'family_id'] } }
  });

  await sequelize.query(
    `INSERT INTO families_new
       (id, church_id, family_id, head_name, address, hometown, home_parish,
        spouse_home, email, photo, dom_day, dom_month, is_published,
        created_at, updated_at)
     SELECT
        id, 1, family_id, head_name, address, hometown, home_parish,
        spouse_home, email, photo, dom_day, dom_month, is_published,
        created_at, updated_at
     FROM families`,
    { transaction }
  );

  // Dropped rather than renamed aside: renaming `families` would rewrite the
  // references in `members` and `users` to follow it.
  await qi.dropTable('families', opts);
  await qi.renameTable('families_new', 'families', opts);

  await qi.addIndex('families', ['head_name'], { name: 'idx_families_head', ...opts });
  await qi.addIndex('families', ['church_id', 'family_id'], { name: 'idx_families_church', ...opts });

  await qi.addColumn('users', 'church_id', {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: 'churches', key: 'id' }
  }, opts);

  if (isUpgrade) {
    await sequelize.query('UPDATE users SET church_id = 1', { transaction });

    await sequelize.query(
      `INSERT INTO church_settings (church_id, key, value)
       SELECT 1, key, value FROM settings WHERE key IN (:keys)`,
      { replacements: { keys: CHURCH_SETTING_KEYS }, transaction }
    );
  }

  const after = {
    families: await countRows('families'),
    members: await countRows('members'),
    users: await countRows('users')
  };

  const lost = Object.keys(before)
    .filter((table) => after[table] !== before[table])
    .map((table) => `${table} went from ${before[table]} to ${after[table]}`);

  if (lost.length) {
    throw new Error(`it changed the number of rows it was only meant to move — ${lost.join('; ')}`);
  }
}

// ---------------------------------------------------------------------------
// 4 — a vocabulary per diocese, and a record of what the operator did
// ---------------------------------------------------------------------------

async function perDioceseLabelsAndAudit({ qi, transaction }) {
  const opts = { transaction };

  /*
   * Migration 3 put diocese_label and zone_label in the installation-wide
   * settings, on the reasoning that one deployment serves one denomination.
   * That holds for a diocese running its own copy. It does not hold when the
   * installation is a service and its churches are customers: a Syro-Malabar
   * eparchy saying "Forane" and a CSI diocese saying "Pastorate" can then sit
   * in the same database, and one label would be wrong for one of them.
   *
   * Nullable, and the installation setting stays as the default — a diocese
   * only carries a value where it differs.
   */
  await qi.addColumn('dioceses', 'diocese_label', {
    type: DataTypes.TEXT, allowNull: true
  }, opts);
  await qi.addColumn('dioceses', 'zone_label', {
    type: DataTypes.TEXT, allowNull: true
  }, opts);

  /*
   * What the super administrator did.
   *
   * They can reach every church's members — names, addresses, telephone
   * numbers — and when the operator is a supplier rather than the diocese
   * itself, "who looked at our data, and when" is a question a customer is
   * entitled to ask. The acting-as bar prevents accidents; it records nothing.
   *
   * The username is copied in rather than joined: the answer has to survive
   * the account being deleted, which is exactly when it would be asked for.
   */
  await qi.createTable('audit_log', {
    id: ID,
    at: TIMESTAMP,
    user_id: { type: DataTypes.INTEGER, allowNull: true },
    username: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    action: { type: DataTypes.TEXT, allowNull: false },
    church_id: { type: DataTypes.INTEGER, allowNull: true },
    detail: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' }
  }, opts);

  await qi.addIndex('audit_log', ['at'], { name: 'idx_audit_at', ...opts });
  await qi.addIndex('audit_log', ['church_id'], { name: 'idx_audit_church', ...opts });
}

// ---------------------------------------------------------------------------
// 5 — a member's blood group and education/qualification
// ---------------------------------------------------------------------------

async function memberBloodGroupAndEducation({ qi, transaction }) {
  const opts = { transaction };

  await qi.addColumn('members', 'blood_group', {
    type: DataTypes.TEXT, allowNull: false, defaultValue: ''
  }, opts);
  await qi.addColumn('members', 'education', {
    type: DataTypes.TEXT, allowNull: false, defaultValue: ''
  }, opts);
}

// ---------------------------------------------------------------------------
// 6 — "Education & qualification" splits into qualification and occupation
// ---------------------------------------------------------------------------

async function memberQualificationAndOccupation({ qi, transaction }) {
  const opts = { transaction };

  // The single free-text field migration 5 added turned out to conflate two
  // different questions — what a member studied and what they do — so it is
  // replaced rather than kept alongside a second field nobody asked for.
  // Nothing has shipped with data in it yet, but the column is still removed
  // through a migration rather than in place: a directory already running
  // migration 5 needs the same schema everyone gets from a fresh install.
  await qi.removeColumn('members', 'education', opts);
  await qi.addColumn('members', 'qualification', {
    type: DataTypes.TEXT, allowNull: false, defaultValue: ''
  }, opts);
  await qi.addColumn('members', 'occupation', {
    type: DataTypes.TEXT, allowNull: false, defaultValue: ''
  }, opts);
}

// ---------------------------------------------------------------------------
// 7 — "Wife" becomes "Spouse", so the word does not assume who married in
// ---------------------------------------------------------------------------

async function wifeBecomesSpouse({ sequelize, transaction }) {
  await sequelize.query(
    `UPDATE members SET relation = 'Spouse' WHERE relation = 'Wife'`,
    { transaction }
  );

  // relation_options is a comma list a parish can have customised, not a fixed
  // set of choices, so this only touches the word "Wife" wherever it appears
  // in one rather than replacing the whole value.
  for (const table of ['settings', 'church_settings']) {
    await sequelize.query(
      `UPDATE ${table} SET value = REPLACE(value, 'Wife', 'Spouse')
        WHERE key = 'relation_options' AND value LIKE '%Wife%'`,
      { transaction }
    );
  }
}

// ---------------------------------------------------------------------------
// 8 — a member login's own church_id, which nothing ever set
// ---------------------------------------------------------------------------

/**
 * A household login has always been created with `family_id` set and
 * `church_id` left null — tenancy.js only ever reads `church_id` to work out
 * which church a signed-in request belongs to, so every member login this
 * installation has ever handed out has been unable to reach its own family's
 * page, failing `requireChurch` with "Your account is not attached to a
 * church." The route is fixed alongside this migration; this repairs the rows
 * it already created.
 */
async function memberLoginChurchId({ sequelize, transaction }) {
  await sequelize.query(
    `UPDATE users
        SET church_id = (SELECT church_id FROM families WHERE families.id = users.family_id)
      WHERE role = 'family' AND church_id IS NULL AND family_id IS NOT NULL`,
    { transaction }
  );
}

// ---------------------------------------------------------------------------
// 9 — a family's prayer group
// ---------------------------------------------------------------------------

async function familyPrayerGroup({ qi, transaction }) {
  await qi.addColumn('families', 'prayer_group', {
    type: DataTypes.TEXT, allowNull: false, defaultValue: ''
  }, { transaction });
}

// ---------------------------------------------------------------------------
// 10 — family self-verification: proposals, a review queue, and where each
//      family has got to
// ---------------------------------------------------------------------------

/**
 * Nothing a family submits changes the parish master record on its own.
 *
 * Until now a family login's edit saved straight to its own row. That is the
 * one change of substance the Parish asked for: the submission is written to
 * a separate pending store instead, and the master record is left untouched
 * until Achen or an authorised administrator approves it line by line.
 *
 * Three things are added:
 *
 *   submissions       one family's proposal, made at one moment, by whoever
 *                     was signed in — which may be an Area Representative or
 *                     the Parish office entering it on the family's behalf
 *   pending_changes   one line of that proposal: one field, its existing value,
 *                     its proposed value, and its own outcome. A reviewer can
 *                     accept a new mobile number and reject a proposed address
 *                     in the same submission, so the outcome cannot live on
 *                     the submission
 *   families.*        where this family has got to in the verification chain,
 *                     its Area, and the moments the office marked it invited
 *                     or printed
 *
 * `payload` is the machine-readable half of a change — which member, which
 * column, and the value in the shape the database wants. `existing_value` and
 * `proposed_value` are the human halves, rendered once at submission time in
 * the Directory's own format, so the review screen and the export both read
 * what will actually be printed rather than re-deriving it.
 */
async function familyVerificationWorkflow({ qi, sequelize, transaction }) {
  const opts = { transaction };

  await qi.createTable('submissions', {
    id: ID,
    church_id: { type: DataTypes.INTEGER, allowNull: false },
    family_id: { type: DataTypes.INTEGER, allowNull: false },
    submitted_by: { type: DataTypes.INTEGER, allowNull: true },
    // Copied in, like the audit log's, so the record survives the account.
    submitted_by_name: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    // 'family' when the household submitted it themselves, 'assisted' when an
    // Area Representative or the office did it for them. An assisted entry is
    // never mistaken for one the family made itself.
    submitted_via: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'family' },
    submitted_at: TIMESTAMP,
    // open while any line is still undecided, closed once none is.
    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'open' }
  }, opts);

  await qi.addIndex('submissions', ['church_id', 'status'], {
    name: 'idx_submissions_church', ...opts
  });
  await qi.addIndex('submissions', ['family_id'], { name: 'idx_submissions_family', ...opts });

  await qi.createTable('pending_changes', {
    id: ID,
    submission_id: { type: DataTypes.INTEGER, allowNull: false },
    // Repeated from the submission rather than joined: every query the review
    // queue makes is "this church's undecided lines", and the export is one
    // flat sheet.
    church_id: { type: DataTypes.INTEGER, allowNull: false },
    family_id: { type: DataTypes.INTEGER, allowNull: false },
    // 'family', 'member', 'member_add' or 'member_remove'.
    kind: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'family' },
    field: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    label: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    tier: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'significant' },
    existing_value: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    proposed_value: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    payload: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
    reviewed_by: { type: DataTypes.INTEGER, allowNull: true },
    reviewed_by_name: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    reviewed_at: { type: DataTypes.STRING, allowNull: true },
    // A rejection may carry a short reason, which the family sees the next
    // time it signs in — so a rejected correction is not silently lost.
    reason: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    // The moment the approved value reached the parish record, which is a
    // different question from when it was approved.
    applied_at: { type: DataTypes.STRING, allowNull: true }
  }, opts);

  await qi.addIndex('pending_changes', ['church_id', 'status'], {
    name: 'idx_pending_church_status', ...opts
  });
  await qi.addIndex('pending_changes', ['submission_id'], {
    name: 'idx_pending_submission', ...opts
  });
  await qi.addIndex('pending_changes', ['family_id'], { name: 'idx_pending_family', ...opts });

  /*
   * The Area, which is not the Prayer Group.
   *
   * A Prayer Group is a neighbourhood group that meets; an Area is the
   * division the Parish gives an Area Representative to follow up. The status
   * views filter by either, and the printable follow-up sheet is per Area,
   * so it needs a column of its own.
   */
  await qi.addColumn('families', 'area', {
    type: DataTypes.TEXT, allowNull: false, defaultValue: ''
  }, opts);

  await qi.addColumn('families', 'verify_status', {
    type: DataTypes.TEXT, allowNull: false, defaultValue: 'not_started'
  }, opts);
  await qi.addColumn('families', 'verify_status_at', {
    type: DataTypes.STRING, allowNull: true
  }, opts);
  await qi.addColumn('families', 'invited_at', {
    type: DataTypes.STRING, allowNull: true
  }, opts);
  await qi.addColumn('families', 'printed_at', {
    type: DataTypes.STRING, allowNull: true
  }, opts);

  await qi.addIndex('families', ['church_id', 'verify_status'], {
    name: 'idx_families_verify', ...opts
  });

  /*
   * A family that already has a login has already been reached, so it starts
   * at "Invitation Sent" rather than pretending nobody has spoken to it. An
   * existing directory is otherwise all "Not Started", which is the truth.
   */
  await sequelize.query(
    `UPDATE families
        SET verify_status = 'invitation_sent'
      WHERE id IN (SELECT family_id FROM users WHERE role = 'family' AND family_id IS NOT NULL)`,
    { transaction }
  );
}

const MIGRATIONS = [
  async ({ sequelize, transaction }) => {
    for (const sql of SCHEMA_V1) await sequelize.query(sql, { transaction });
  },
  async ({ sequelize, transaction }) => {
    for (const sql of RELATIONS_V2) await sequelize.query(sql, { transaction });
  },
  addChurchHierarchy,
  perDioceseLabelsAndAudit,
  memberBloodGroupAndEducation,
  memberQualificationAndOccupation,
  wifeBecomesSpouse,
  memberLoginChurchId,
  familyPrayerGroup,
  familyVerificationWorkflow
];

module.exports = { MIGRATIONS, CHURCH_SETTING_KEYS };
