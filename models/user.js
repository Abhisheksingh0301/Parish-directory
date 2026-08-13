'use strict';

const { Op, fn, col, where: whereFn } = require('sequelize');
const db = require('../db');

const { User, Family, Session } = db;

/**
 * Accounts.
 *
 * Every query about a user lives here rather than in the routes that ask. The
 * routes used to run their own SQL — fourteen statements in routes/admin.js
 * alone — which meant that adding "and only this church's users" to the system
 * would have been fourteen separate chances to forget. One place to change is
 * the point.
 */

/** Usernames are case-insensitive: "Steve" and "steve" are the same account. */
function byUsername(username) {
  return whereFn(fn('lower', col('username')), String(username || '').trim().toLowerCase());
}

function count() {
  return User.count();
}

/**
 * Any account, by id, with no church attached to the question.
 *
 * For the console and the command line, which are allowed to see everything.
 * A church's own Users page must use findInChurch instead — see the comment
 * there for why the difference matters.
 */
function findById(id) {
  return User.findByPk(id);
}

/**
 * An account, but only if it belongs to this church.
 *
 * The church goes into the WHERE clause. Without it, the four routes behind
 * /admin/users — role, active, password, delete — would each load a user by a
 * bare integer, and one church's administrator could reset another church's
 * administrator's password by guessing a small number.
 */
function findInChurch(churchId, id) {
  return User.findOne({ where: { id, church_id: churchId } });
}

function findByUsername(username) {
  return User.findOne({ where: byUsername(username) });
}

async function usernameTaken(username) {
  return (await User.count({ where: byUsername(username) })) > 0;
}

/** The fields a signed-in request needs on every page. */
function findForSession(id) {
  return User.findByPk(id, {
    attributes: [
      'id', 'username', 'full_name', 'role', 'is_active',
      'church_id', 'family_id', 'on_default_password'
    ],
    raw: true
  });
}

/** The account belonging to one family, if it has been given a login. */
function findByFamily(familyId) {
  return User.findOne({ where: { family_id: familyId } });
}

/** Every account in one church, or every account anywhere if churchId is null. */
async function listWithFamilies(churchId = null) {
  const rows = await User.findAll({
    ...(churchId ? { where: { church_id: churchId } } : {}),
    attributes: [
      'id', 'username', 'full_name', 'role', 'is_active', 'created_at',
      'last_login_at', 'church_id', 'family_id', 'on_default_password'
    ],
    include: [{
      model: Family,
      as: 'family',
      required: false,
      attributes: ['family_id', 'head_name']
    }],
    order: [['role', 'ASC'], ['username', 'ASC']]
  });

  return rows.map((row) => {
    const { family, ...user } = row.get({ plain: true });
    return {
      ...user,
      family_ref: family ? family.family_id : null,
      family_head: family ? family.head_name : null
    };
  });
}

function create(values) {
  return User.create({ ...values, created_at: db.now() });
}

function bulkCreate(rows) {
  const created_at = db.now();
  return User.bulkCreate(rows.map((r) => ({ ...r, created_at })));
}

function setRole(id, role) {
  return User.update({ role }, { where: { id } });
}

function setActive(id, isActive) {
  return User.update({ is_active: !!isActive }, { where: { id } });
}

function setFullName(id, fullName) {
  return User.update({ full_name: fullName }, { where: { id } });
}

/**
 * Choosing a password is what clears the "still on the one everybody was
 * given" reminder, so the two always move together.
 */
function setPassword(id, passwordHash, { onDefault = false } = {}) {
  return User.update(
    { password_hash: passwordHash, on_default_password: !!onDefault },
    { where: { id } }
  );
}

/** Put a household login back to the shared default and re-enable it. */
function resetToDefaultPassword(id, passwordHash) {
  return User.update(
    { password_hash: passwordHash, on_default_password: true, is_active: true },
    { where: { id } }
  );
}

function recordLogin(id) {
  return User.update({ last_login_at: db.now() }, { where: { id } });
}

function remove(id) {
  return User.destroy({ where: { id } });
}

/**
 * Is this the last administrator who could still manage the install?
 *
 * Demoting, deactivating or deleting them would leave nobody able to add
 * accounts or change settings, so every one of those routes asks first.
 */
/**
 * Scoped to the church, and it has to be: counting administrators across the
 * whole installation would let a parish delete its last one because some other
 * parish still has theirs.
 */
async function wouldOrphanAdmins(churchId, userId) {
  const others = await User.count({
    where: {
      church_id: churchId,
      role: 'admin',
      is_active: true,
      id: { [Op.ne]: userId }
    }
  });
  return others === 0;
}

/**
 * Drop this account's sessions, so losing access happens now rather than
 * whenever they next choose to sign out.
 *
 * The session store keeps its payload as JSON in a text column, so this is a
 * substring match on that column — the same test the previous hand-written
 * store used, and the reason `userId` is stored under a stable key.
 */
function signOutEverywhere(userId) {
  return Session.destroy({ where: { data: { [Op.like]: `%"userId":${Number(userId)}%` } } });
}

module.exports = {
  count,
  findById,
  findInChurch,
  findByUsername,
  findForSession,
  findByFamily,
  usernameTaken,
  listWithFamilies,
  create,
  bulkCreate,
  setRole,
  setActive,
  setFullName,
  setPassword,
  resetToDefaultPassword,
  recordLogin,
  remove,
  wouldOrphanAdmins,
  signOutEverywhere
};
