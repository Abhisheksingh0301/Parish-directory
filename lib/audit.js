'use strict';

const { Op } = require('sequelize');
const db = require('../db');

/**
 * A record of what the operator did.
 *
 * The super administrator of this installation is not a bishop with authority
 * over one diocese — it is whoever runs the service, and they can reach every
 * church's members: names, home addresses, telephone numbers. "Who looked at
 * our data, and when" is a question a church is entitled to ask, and without
 * this there is no answer to give them.
 *
 * What is recorded, and why only these:
 *
 *   Borrowing a church      the moment the operator gains access to a parish's
 *                           own screens, which is the access worth knowing about
 *   Exports                 data leaving the system entirely
 *   Hierarchy changes       creating, renaming, moving or deactivating anything
 *
 * Page views are not recorded. Logging every GET would bury the three things
 * above in noise, and a log nobody can read is not evidence of anything.
 *
 * Writing is deliberately best-effort: a failure here must never take down the
 * action being recorded. A missing line is a smaller problem than a super
 * administrator who cannot deactivate a compromised church.
 */

async function record(req, action, { churchId = null, detail = '' } = {}) {
  try {
    await db.AuditLog.create({
      at: db.now(),
      user_id: req.user ? req.user.id : null,
      username: req.user ? req.user.username : '(signed out)',
      action,
      church_id: churchId,
      detail: String(detail).slice(0, 500)
    });
  } catch (err) {
    console.error('audit log write failed:', err.message);
  }
}

/**
 * The log, newest first, optionally narrowed.
 *
 * `churchId` answers the question a church actually asks — what happened to
 * *us* — rather than making somebody read the whole installation's history.
 */
async function list({ churchId = null, action = null, limit = 200 } = {}) {
  const where = {};
  if (churchId) where.church_id = Number(churchId);
  if (action) where.action = { [Op.like]: `%${action}%` };

  const rows = await db.AuditLog.findAll({
    where,
    order: [['at', 'DESC'], ['id', 'DESC']],
    limit: Math.min(Number(limit) || 200, 1000),
    raw: true
  });

  // Names, resolved for display only. The log keeps its own copy of the
  // username precisely so this join can fail without losing the record.
  const churchIds = [...new Set(rows.map((r) => r.church_id).filter(Boolean))];
  const churches = churchIds.length
    ? await db.Church.findAll({
      attributes: ['id', 'name'],
      where: { id: { [Op.in]: churchIds } },
      raw: true
    })
    : [];
  const names = new Map(churches.map((c) => [c.id, c.name]));

  return rows.map((r) => ({
    ...r,
    church_name: r.church_id ? (names.get(r.church_id) || `church ${r.church_id} (deleted)`) : null
  }));
}

module.exports = { record, list };
