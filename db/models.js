'use strict';

/**
 * The shape of the data, as Sequelize models.
 *
 * These describe the tables for querying; db/migrations.js is what creates and
 * changes them. The two must be kept in step by hand — `sequelize.sync()` is
 * deliberately never called, because a directory that is already in use should
 * only ever change schema through a migration somebody wrote and read.
 *
 * Timestamps are plain strings in 'YYYY-MM-DD HH:MM:SS', which is what the
 * existing rows hold and what the views print. They are set explicitly by the
 * repository layer rather than by a database default, so no engine has to
 * supply its own idea of "now".
 */

const { DataTypes } = require('sequelize');
const { sequelize } = require('./sequelize');

/** The timestamp format already stored in this database. */
function now() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

const id = { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true };
const text = (defaultValue = '') => ({
  type: DataTypes.TEXT,
  allowNull: false,
  defaultValue
});

// ---------------------------------------------------------------------------
// Above the parish: diocese → zone → church
// ---------------------------------------------------------------------------

const Diocese = sequelize.define('Diocese', {
  id,
  name: { type: DataTypes.TEXT, allowNull: false },
  // What this diocese calls itself, and its sub-groups. NULL means take the
  // installation default; only a diocese whose denomination says something
  // different carries a value. See migration 4.
  diocese_label: { type: DataTypes.TEXT, allowNull: true },
  zone_label: { type: DataTypes.TEXT, allowNull: true },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  created_at: { type: DataTypes.STRING, allowNull: false, defaultValue: now }
}, { tableName: 'dioceses' });

const Zone = sequelize.define('Zone', {
  id,
  diocese_id: { type: DataTypes.INTEGER, allowNull: false },
  name: { type: DataTypes.TEXT, allowNull: false },
  created_at: { type: DataTypes.STRING, allowNull: false, defaultValue: now }
}, { tableName: 'zones' });

const Church = sequelize.define('Church', {
  id,
  diocese_id: { type: DataTypes.INTEGER, allowNull: false },
  // Nullable on purpose: a parish exists before its zone is settled, and
  // dissolving a zone must never cascade into deleting parishes.
  zone_id: { type: DataTypes.INTEGER, allowNull: true },
  name: { type: DataTypes.TEXT, allowNull: false },
  slug: { type: DataTypes.TEXT, allowNull: false },
  city: text(),
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  created_at: { type: DataTypes.STRING, allowNull: false, defaultValue: now }
}, { tableName: 'churches' });

// ---------------------------------------------------------------------------
// The directory itself
// ---------------------------------------------------------------------------

const Family = sequelize.define('Family', {
  id,
  church_id: { type: DataTypes.INTEGER, allowNull: false },
  // The parish's own reference, "0001" or "A-12" — unique within its church,
  // not across the system. Two parishes both starting at 0001 is normal.
  family_id: { type: DataTypes.TEXT, allowNull: false },
  head_name: { type: DataTypes.TEXT, allowNull: false },
  address: text(),
  hometown: text(),
  home_parish: text(),
  // A neighbourhood-based group within this church, for local prayer
  // meetings — not part of the diocese/zone hierarchy above the church.
  prayer_group: text(),
  // The division an Area Representative follows up, which is a different
  // question from which prayer group a family attends.
  area: text(),
  // The household's own address, which is also its login username. A family
  // has one; its members each have their own list. See Member.emails.
  email: text(),
  photo: { type: DataTypes.TEXT, allowNull: true },
  is_published: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  // Where this family has got to in the verification chain. The keys are
  // lib/verification.js's STATUSES; nothing else may be written here.
  verify_status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'not_started' },
  verify_status_at: { type: DataTypes.STRING, allowNull: true },
  invited_at: { type: DataTypes.STRING, allowNull: true },
  printed_at: { type: DataTypes.STRING, allowNull: true },
  created_at: { type: DataTypes.STRING, allowNull: false, defaultValue: now },
  updated_at: { type: DataTypes.STRING, allowNull: false, defaultValue: now }
}, { tableName: 'families' });

const Member = sequelize.define('Member', {
  id,
  family_id: { type: DataTypes.INTEGER, allowNull: false },
  position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  name: { type: DataTypes.TEXT, allowNull: false },
  relation: text(),
  // Date of birth: day and month, never a year. The directory says when to
  // wish a member, not how old they are.
  dob_day: { type: DataTypes.INTEGER, allowNull: true },
  dob_month: { type: DataTypes.INTEGER, allowNull: true },
  // Date of marriage, per member rather than per family: a household holds
  // more than one married couple often enough that a single date on the
  // family cannot describe it.
  dom_day: { type: DataTypes.INTEGER, allowNull: true },
  dom_month: { type: DataTypes.INTEGER, allowNull: true },
  // Both of these hold a short list, comma-separated. lib/phone.js and
  // lib/email.js are the only places that spelling is decided.
  mobile: text(),
  blood_group: text(),
  qualification: text(),
  occupation: text(),
  emails: text()
}, { tableName: 'members' });

const User = sequelize.define('User', {
  id,
  username: { type: DataTypes.TEXT, allowNull: false },
  password_hash: { type: DataTypes.TEXT, allowNull: false },
  full_name: text(),
  role: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'viewer' },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  // NULL for a super administrator, who belongs to no single church. Every
  // other role must have one; lib/auth.js is what enforces that, since no
  // engine can express "NOT NULL unless role = superadmin".
  church_id: { type: DataTypes.INTEGER, allowNull: true },
  // Set on a member login: the one family this account may reach.
  family_id: { type: DataTypes.INTEGER, allowNull: true },
  on_default_password: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  created_at: { type: DataTypes.STRING, allowNull: false, defaultValue: now },
  last_login_at: { type: DataTypes.STRING, allowNull: true }
}, { tableName: 'users' });

// ---------------------------------------------------------------------------
// Settings, in two layers
// ---------------------------------------------------------------------------

/** Installation-wide: the vocabulary, and the fallback a new church starts from. */
const Setting = sequelize.define('Setting', {
  key: { type: DataTypes.TEXT, primaryKey: true },
  value: { type: DataTypes.TEXT, allowNull: false }
}, { tableName: 'settings' });

/** One church's own: its name, its palette, its page layout. */
const ChurchSetting = sequelize.define('ChurchSetting', {
  church_id: { type: DataTypes.INTEGER, primaryKey: true },
  key: { type: DataTypes.TEXT, primaryKey: true },
  value: { type: DataTypes.TEXT, allowNull: false }
}, { tableName: 'church_settings' });

/**
 * What the operator did, and to whom.
 *
 * The username is copied in rather than joined, because the answer has to
 * survive the account being deleted — which is exactly when somebody would be
 * asking for it.
 */
const AuditLog = sequelize.define('AuditLog', {
  id,
  at: { type: DataTypes.STRING, allowNull: false, defaultValue: now },
  user_id: { type: DataTypes.INTEGER, allowNull: true },
  username: text(),
  action: { type: DataTypes.TEXT, allowNull: false },
  church_id: { type: DataTypes.INTEGER, allowNull: true },
  detail: text()
}, { tableName: 'audit_log' });

// ---------------------------------------------------------------------------
// Proposals, waiting to be approved
// ---------------------------------------------------------------------------

/**
 * One family's proposal, made at one moment.
 *
 * `submitted_by_name` and `submitted_via` are copied in for the same reason
 * the audit log copies a username: the answer to "who submitted this, and was
 * it the family or somebody acting for them" has to survive the account.
 */
const Submission = sequelize.define('Submission', {
  id,
  church_id: { type: DataTypes.INTEGER, allowNull: false },
  family_id: { type: DataTypes.INTEGER, allowNull: false },
  submitted_by: { type: DataTypes.INTEGER, allowNull: true },
  submitted_by_name: text(),
  submitted_via: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'family' },
  submitted_at: { type: DataTypes.STRING, allowNull: false, defaultValue: now },
  status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'open' }
}, { tableName: 'submissions' });

/**
 * One line of a proposal — one field, approved or rejected on its own.
 *
 * The outcome cannot live on the submission: a reviewer accepts a new mobile
 * number and rejects a proposed address in the same breath, and the rest of
 * the record is left untouched.
 */
const PendingChange = sequelize.define('PendingChange', {
  id,
  submission_id: { type: DataTypes.INTEGER, allowNull: false },
  church_id: { type: DataTypes.INTEGER, allowNull: false },
  family_id: { type: DataTypes.INTEGER, allowNull: false },
  kind: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'family' },
  field: text(),
  label: text(),
  tier: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'significant' },
  existing_value: text(),
  proposed_value: text(),
  // The machine-readable half: which member, which column, what value.
  payload: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
  status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
  reviewed_by: { type: DataTypes.INTEGER, allowNull: true },
  reviewed_by_name: text(),
  reviewed_at: { type: DataTypes.STRING, allowNull: true },
  reason: text(),
  applied_at: { type: DataTypes.STRING, allowNull: true }
}, { tableName: 'pending_changes' });

const Session = sequelize.define('Session', {
  sid: { type: DataTypes.TEXT, primaryKey: true },
  expires: { type: DataTypes.INTEGER, allowNull: false },
  data: { type: DataTypes.TEXT, allowNull: false }
}, { tableName: 'sessions' });

// ---------------------------------------------------------------------------
// Associations
// ---------------------------------------------------------------------------

Diocese.hasMany(Zone, { foreignKey: 'diocese_id', as: 'zones' });
Zone.belongsTo(Diocese, { foreignKey: 'diocese_id', as: 'diocese' });

Diocese.hasMany(Church, { foreignKey: 'diocese_id', as: 'churches' });
Church.belongsTo(Diocese, { foreignKey: 'diocese_id', as: 'diocese' });

Zone.hasMany(Church, { foreignKey: 'zone_id', as: 'churches' });
Church.belongsTo(Zone, { foreignKey: 'zone_id', as: 'zone' });

Church.hasMany(Family, { foreignKey: 'church_id', as: 'families', onDelete: 'CASCADE' });
Family.belongsTo(Church, { foreignKey: 'church_id', as: 'church' });

Family.hasMany(Member, { foreignKey: 'family_id', as: 'members', onDelete: 'CASCADE' });
Member.belongsTo(Family, { foreignKey: 'family_id', as: 'family' });

// A family has at most one login — the household's own account.
Family.hasOne(User, { foreignKey: 'family_id', as: 'login', onDelete: 'CASCADE' });
User.belongsTo(Family, { foreignKey: 'family_id', as: 'family' });

Church.hasMany(User, { foreignKey: 'church_id', as: 'users' });
User.belongsTo(Church, { foreignKey: 'church_id', as: 'church' });

Church.hasMany(ChurchSetting, { foreignKey: 'church_id', as: 'settings', onDelete: 'CASCADE' });
ChurchSetting.belongsTo(Church, { foreignKey: 'church_id', as: 'church' });

// A deleted family takes its outstanding proposals with it — a queue item
// pointing at a row that no longer exists cannot be reviewed.
Family.hasMany(Submission, { foreignKey: 'family_id', as: 'submissions', onDelete: 'CASCADE' });
Submission.belongsTo(Family, { foreignKey: 'family_id', as: 'family' });

Submission.hasMany(PendingChange, { foreignKey: 'submission_id', as: 'changes', onDelete: 'CASCADE' });
PendingChange.belongsTo(Submission, { foreignKey: 'submission_id', as: 'submission' });

Family.hasMany(PendingChange, { foreignKey: 'family_id', as: 'pendingChanges', onDelete: 'CASCADE' });
PendingChange.belongsTo(Family, { foreignKey: 'family_id', as: 'family' });

module.exports = {
  now,
  Diocese,
  Zone,
  Church,
  Family,
  Member,
  User,
  Setting,
  ChurchSetting,
  AuditLog,
  Submission,
  PendingChange,
  Session
};
