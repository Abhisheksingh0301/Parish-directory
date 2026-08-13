'use strict';

const express = require('express');
const Family = require('../models/family');
const settings = require('../lib/settings');
const relations = require('../lib/relations');
const auth = require('../lib/auth');
const tenancy = require('../lib/tenancy');
const wrap = require('../lib/async');

const router = express.Router();

// The whole parish's addresses in one document — not for a member login.
router.use(auth.requireRole('viewer'));
router.use(tenancy.requireChurch);

/**
 * The printable directory — a server-rendered version of
 * public/parish-directory-template.html, fed from the database.
 */
router.get('/', wrap(async (req, res) => {
  const parishSettings = await settings.load(req.churchId);

  // Editors can preview unpublished families; the printed book never has them.
  const includeDrafts = req.query.drafts === '1' && auth.atLeast(req.user, 'editor');
  const families = await Family.listWithMembers(req.churchId, { publishedOnly: !includeDrafts });

  const perPage = Math.max(1, parseInt(parishSettings.per_page, 10) || 2);
  const startingPage = parseInt(parishSettings.starting_page, 10) || 1;

  const pages = [];
  for (let i = 0; i < families.length; i += perPage) {
    pages.push({ folio: startingPage + pages.length, families: families.slice(i, i + perPage) });
  }

  res.render('directory/print', {
    title: parishSettings.directory_title || 'Parish Directory',
    pages,
    domSpan: relations.domSpan,
    total: families.length,
    includeDrafts,
    canEdit: auth.atLeast(req.user, 'editor')
  });
}));

module.exports = router;
