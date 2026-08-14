'use strict';

const express = require('express');
const db = require('../db');
const Churches = require('../models/church');
const Users = require('../models/user');
const auth = require('../lib/auth');
const tenancy = require('../lib/tenancy');
const settings = require('../lib/settings');
const audit = require('../lib/audit');
const wrap = require('../lib/async');

const router = express.Router();

/**
 * The super administrator's console: dioceses, zones, churches.
 *
 * Nothing here touches a family. It manages the hierarchy above them and lets
 * a super administrator borrow a church in order to use the ordinary screens —
 * which is the only way they can, since every other page is scoped to the
 * church on the signed-in account and they have none.
 */

router.use(tenancy.requireSuperAdmin);

/** Turn a HierarchyError into a message on the page rather than a 500. */
function withHierarchyErrors(handler, back) {
  return wrap(async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      if (!(err instanceof Churches.HierarchyError)) throw err;
      res.redirect(`${back}?error=` + encodeURIComponent(err.message));
    }
  });
}

const flash = (req) => ({
  notice: req.query.notice || null,
  error: req.query.error || null
});

const redirectWith = (res, path, notice) =>
  res.redirect(`${path}?notice=` + encodeURIComponent(notice));

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

router.get('/', wrap(async (req, res) => {
  res.render('super/overview', {
    title: 'System overview',
    counts: await Churches.overview(),
    dioceses: await Churches.listDioceses(),
    ...flash(req)
  });
}));

// ---------------------------------------------------------------------------
// Dioceses
// ---------------------------------------------------------------------------

router.get('/dioceses', wrap(async (req, res) => {
  res.render('super/dioceses', {
    title: `${res.locals.labels.diocese}s`,
    dioceses: await Churches.listDioceses(),
    ...flash(req)
  });
}));

router.post('/dioceses', withHierarchyErrors(async (req, res) => {
  const diocese = await Churches.createDiocese(req.body.name);
  await audit.record(req, 'diocese.create', { detail: diocese.name });
  redirectWith(res, '/super/dioceses', `"${diocese.name}" added.`);
}, '/super/dioceses'));

router.post('/dioceses/:id(\\d+)', withHierarchyErrors(async (req, res) => {
  await Churches.renameDiocese(req.params.id, req.body.name, {
    dioceseLabel: req.body.diocese_label,
    zoneLabel: req.body.zone_label
  });
  await audit.record(req, 'diocese.update', { detail: req.body.name });
  redirectWith(res, '/super/dioceses', 'Saved.');
}, '/super/dioceses'));

router.post('/dioceses/:id(\\d+)/active', withHierarchyErrors(async (req, res) => {
  const activate = req.body.is_active === '1';
  await Churches.setDioceseActive(req.params.id, activate);
  await audit.record(req, activate ? 'diocese.activate' : 'diocese.deactivate',
    { detail: 'diocese ' + req.params.id });
  redirectWith(res, '/super/dioceses', activate ? 'Reactivated.' : 'Deactivated.');
}, '/super/dioceses'));

router.post('/dioceses/:id(\\d+)/delete', withHierarchyErrors(async (req, res) => {
  await Churches.removeDiocese(req.params.id);
  await audit.record(req, 'diocese.delete', { detail: 'diocese ' + req.params.id });
  redirectWith(res, '/super/dioceses', 'Deleted.');
}, '/super/dioceses'));

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

router.get('/zones', wrap(async (req, res) => {
  res.render('super/zones', {
    title: `${res.locals.labels.zone}s`,
    zones: await Churches.listZones(),
    dioceses: await Churches.listDioceses(),
    ...flash(req)
  });
}));

router.post('/zones', withHierarchyErrors(async (req, res) => {
  const zone = await Churches.createZone(req.body.diocese_id, req.body.name);
  await audit.record(req, 'zone.create', { detail: zone.name });
  redirectWith(res, '/super/zones', `"${zone.name}" added.`);
}, '/super/zones'));

router.post('/zones/:id(\\d+)', withHierarchyErrors(async (req, res) => {
  await Churches.renameZone(req.params.id, req.body.name);
  await audit.record(req, 'zone.rename', { detail: req.body.name });
  redirectWith(res, '/super/zones', 'Renamed.');
}, '/super/zones'));

router.post('/zones/:id(\\d+)/delete', withHierarchyErrors(async (req, res) => {
  await Churches.removeZone(req.params.id);
  await audit.record(req, 'zone.dissolve', { detail: 'zone ' + req.params.id });
  redirectWith(res, '/super/zones', 'Dissolved. Its churches are now unzoned.');
}, '/super/zones'));

// ---------------------------------------------------------------------------
// Churches
// ---------------------------------------------------------------------------

async function churchesPage(req, res, extra = {}) {
  const dioceseId = req.query.diocese ? Number(req.query.diocese) : null;

  res.render('super/churches', {
    title: 'Churches',
    churches: await Churches.listChurches({
      search: req.query.q || '',
      dioceseId,
      zoneId: req.query.zone ? Number(req.query.zone) : null
    }),
    dioceses: await Churches.listDioceses(),
    zones: await Churches.listZones(),
    search: req.query.q || '',
    filterDiocese: dioceseId,
    filterZone: req.query.zone ? Number(req.query.zone) : null,
    // Set when a super administrator arrived here because a page needed a
    // church and they had not chosen one.
    pick: req.query.pick === '1',
    form: {},
    ...flash(req),
    ...extra
  });
}

router.get('/churches', wrap(async (req, res) => churchesPage(req, res)));

/**
 * Add a church, and the account that will run it, in one transaction.
 *
 * A church with no administrator is useless — somebody would have to go and
 * make one before anything could happen — so the form asks for both and either
 * both are created or neither is.
 */
router.post('/churches', wrap(async (req, res) => {
  const text = (v) => String(v ?? '').trim();
  const form = {
    name: text(req.body.name),
    city: text(req.body.city),
    // Neither field is on the form any more — a church no longer has to be put
    // into a diocese or zone to be created — but both are still honoured if
    // sent, so a diocese/zone mismatch is still caught rather than silently
    // ignored.
    diocese_id: req.body.diocese_id || null,
    zone_id: req.body.zone_id || null,
    admin_username: text(req.body.admin_username),
    admin_full_name: text(req.body.admin_full_name)
  };

  const fail = async (error) => {
    res.status(400);
    return churchesPage(req, res, { error, form });
  };

  if (!form.name) return fail('The church needs a name.');
  if (!/^[a-zA-Z0-9._@-]{3,60}$/.test(form.admin_username)) {
    return fail('The administrator needs a username of 3–60 letters, numbers, dot, dash, underscore or @.');
  }

  const passwordError = auth.validatePassword(req.body.admin_password, req.body.admin_password_confirm);
  if (passwordError) return fail(passwordError);

  if (await Users.usernameTaken(form.admin_username)) {
    return fail(`The username "${form.admin_username}" is already taken.`);
  }

  const passwordHash = await auth.hashPassword(req.body.admin_password);

  try {
    const church = await db.sequelize.transaction(async (transaction) => {
      // A diocese/zone lands here only if the caller sent one — the form no
      // longer offers the choice, so ordinarily neither does, and the church
      // lands in Churches.defaultDiocese() instead.
      const created = await Churches.createChurch({
        name: form.name,
        city: form.city,
        dioceseId: form.diocese_id,
        zoneId: form.zone_id
      }, transaction);

      await db.User.create({
        username: form.admin_username,
        password_hash: passwordHash,
        full_name: form.admin_full_name,
        role: 'admin',
        church_id: created.id,
        created_at: db.now()
      }, { transaction });

      return created;
    });

    await audit.record(req, 'church.create',
      { churchId: church.id, detail: `${church.name}, admin ${form.admin_username}` });

    return redirectWith(res, `/super/churches/${church.id}`,
      `"${church.name}" added, with ${form.admin_username} as its administrator.`);
  } catch (err) {
    if (err instanceof Churches.HierarchyError) return fail(err.message);
    throw err;
  }
}));

router.get('/churches/:id(\\d+)', wrap(async (req, res, next) => {
  const church = await Churches.findChurch(req.params.id);
  if (!church) return next();

  const [zones, staff, churchSettings] = await Promise.all([
    Churches.listZonesInDiocese(church.diocese_id),
    Users.listWithFamilies(church.id),
    settings.load(church.id)
  ]);

  res.render('super/church', {
    title: church.name,
    church,
    dioceses: await Churches.listDioceses(),
    zones,
    // Only this church's staff; household logins are the church's own business.
    staff: staff.filter((u) => !u.family_id),
    families: await db.Family.count({ where: { church_id: church.id } }),
    churchSettings,
    ...flash(req)
  });
}));

router.post('/churches/:id(\\d+)', withHierarchyErrors(async (req, res) => {
  await Churches.updateChurch(req.params.id, {
    name: req.body.name,
    city: req.body.city,
    dioceseId: req.body.diocese_id,
    // An empty select means "no zone", which is a real answer, not a missing one.
    zoneId: req.body.zone_id || null
  });
  await audit.record(req, 'church.update',
    { churchId: Number(req.params.id), detail: req.body.name });
  redirectWith(res, `/super/churches/${req.params.id}`, 'Saved.');
}, '/super/churches'));

router.post('/churches/:id(\\d+)/active', wrap(async (req, res, next) => {
  const church = await Churches.findChurch(req.params.id);
  if (!church) return next();

  const activate = req.body.is_active === '1';
  await Churches.setChurchActive(church.id, activate);

  // Deactivating a church should sign its people out now, the same way
  // deactivating one person does.
  if (!activate) {
    const staff = await db.User.findAll({
      attributes: ['id'], where: { church_id: church.id }, raw: true
    });
    for (const u of staff) await Users.signOutEverywhere(u.id);
  }

  await audit.record(req, activate ? 'church.activate' : 'church.deactivate',
    { churchId: church.id, detail: church.name });
  redirectWith(res, `/super/churches/${church.id}`,
    activate ? 'Reactivated.' : 'Deactivated, and everyone signed out.');
}));

/**
 * Move several churches at once.
 *
 * A zone is reorganised every few years and a diocese splits less often than
 * that, but when it happens it touches ten to eighty parishes. One form beats
 * eighty.
 */
router.post('/churches/reassign', withHierarchyErrors(async (req, res) => {
  const ids = []
    .concat(req.body.church_ids || [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);

  if (!ids.length) {
    return redirectWith(res, '/super/churches', 'No churches were selected.');
  }

  const moved = await Churches.reassign(ids, {
    dioceseId: req.body.diocese_id,
    zoneId: req.body.zone_id || null
  });

  await audit.record(req, 'church.reassign',
    { detail: `${moved} church(es) -> diocese ${req.body.diocese_id}` });
  redirectWith(res, '/super/churches',
    `Moved ${moved} ${moved === 1 ? 'church' : 'churches'}.`);
}, '/super/churches'));

// ---------------------------------------------------------------------------
// The activity log
// ---------------------------------------------------------------------------

router.get('/audit', wrap(async (req, res) => {
  const filterChurch = req.query.church ? Number(req.query.church) : null;
  const filterAction = req.query.action || '';

  res.render('super/audit', {
    title: 'Activity log',
    entries: await audit.list({ churchId: filterChurch, action: filterAction }),
    churches: await Churches.listChurches({}),
    filterChurch,
    filterAction,
    ...flash(req)
  });
}));

// ---------------------------------------------------------------------------
// Borrowing a church
// ---------------------------------------------------------------------------

router.post('/churches/:id(\\d+)/act', wrap(async (req, res, next) => {
  const church = await Churches.findChurch(req.params.id);
  if (!church) return next();

  tenancy.actAs(req, church.id);
  await audit.record(req, 'church.open', { churchId: church.id, detail: church.name });

  // If they were sent here by a page that needed a church, go back to it.
  const returnTo = req.session.returnTo;
  delete req.session.returnTo;

  const safe = returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//');
  res.redirect(safe ? returnTo : '/');
}));

router.post('/stop-acting', (req, res) => {
  tenancy.stopActing(req);
  res.redirect('/super/churches');
});

module.exports = router;
