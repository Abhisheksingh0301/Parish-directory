'use strict';

const express = require('express');
const Family = require('../models/family');
const Pending = require('../models/pending');
const auth = require('../lib/auth');
const verification = require('../lib/verification');
const wrap = require('../lib/async');

const router = express.Router();

router.get('/', wrap(async (req, res) => {
  // A member login has no dashboard — its home is its own entry.
  if (auth.isFamilyLogin(req.user)) return res.redirect(`/families/${req.user.family_id}`);

  // Nor has a super administrator who has not borrowed a church yet: there is
  // no single parish for the statistics to be about.
  if (!req.churchId) return res.redirect('/super');

  const area = String(req.query.area || '').trim();
  const prayerGroup = String(req.query.group || '').trim();
  const filter = { area, prayerGroup };

  const [stats, upcoming, status, groupings, waiting] = await Promise.all([
    Family.stats(req.churchId),
    Family.upcoming(req.churchId, 30),
    Family.statusCounts(req.churchId, filter),
    Family.groupings(req.churchId),
    Pending.openCount(req.churchId)
  ]);

  res.render('dashboard', {
    title: 'Dashboard',
    stats,
    upcoming: upcoming.slice(0, 12),
    /*
     * A count against each step of the verification chain, each one clicking
     * through to the list of those families — so "17 families still not
     * started" is one click away from the names of those seventeen. Narrowed
     * to one Area or Prayer Group when the header's filter is set.
     */
    statuses: verification.STATUSES,
    statusCounts: status.counts,
    statusTotal: status.total,
    groupings,
    filter,
    waiting,
    canEdit: auth.atLeast(req.user, 'editor'),
    isAdmin: auth.atLeast(req.user, 'admin')
  });
}));

module.exports = router;
