'use strict';

const express = require('express');
const Family = require('../models/family');
const auth = require('../lib/auth');
const wrap = require('../lib/async');

const router = express.Router();

router.get('/', wrap(async (req, res) => {
  // A member login has no dashboard — its home is its own entry.
  if (auth.isFamilyLogin(req.user)) return res.redirect(`/families/${req.user.family_id}`);

  // Nor has a super administrator who has not borrowed a church yet: there is
  // no single parish for the statistics to be about.
  if (!req.churchId) return res.redirect('/super');

  const [stats, upcoming] = await Promise.all([
    Family.stats(req.churchId),
    Family.upcoming(req.churchId, 30)
  ]);

  res.render('dashboard', {
    title: 'Dashboard',
    stats,
    upcoming: upcoming.slice(0, 12),
    canEdit: auth.atLeast(req.user, 'editor'),
    isAdmin: auth.atLeast(req.user, 'admin')
  });
}));

module.exports = router;
