'use strict';

const express = require('express');
const Family = require('../models/family');
const auth = require('../lib/auth');
const wrap = require('../lib/async');

const router = express.Router();

router.get('/', wrap(async (req, res) => {
  const [stats, upcoming] = await Promise.all([
    Family.stats(),
    Family.upcoming(30)
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
