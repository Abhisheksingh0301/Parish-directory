'use strict';

const express = require('express');
const Family = require('../models/family');
const Pending = require('../models/pending');
const auth = require('../lib/auth');
const verification = require('../lib/verification');
const settings = require('../lib/settings');
const wrap = require('../lib/async');

const router = express.Router();

router.get('/', wrap(async (req, res) => {
  // A member login has no dashboard — its home is its own entry.
  if (auth.isFamilyLogin(req.user)) return res.redirect(`/families/${req.user.family_id}`);

  // Nor has a super administrator who has not borrowed a church yet: there is
  // no single parish for the statistics to be about.
  if (!req.churchId) return res.redirect('/super');

  const prayerGroup = String(req.query.group || '').trim();
  const filter = { prayerGroup };

  const [stats, upcoming, status, groupings, waiting, parishSettings, families] = await Promise.all([
    Family.stats(req.churchId),
    Family.upcoming(req.churchId, 30),
    Family.statusCounts(req.churchId, filter),
    Family.groupings(req.churchId),
    Pending.openCount(req.churchId),
    settings.load(req.churchId),
    Family.listWithMembers(req.churchId, { publishedOnly: true })
  ]);

  /*
   * The Family index, below the fold: one line per family, with the Family
   * ID and the printed page it falls on. The page numbers use the same
   * perPage / starting_page arithmetic as the printed directory, so a
   * number here always points at the sheet that actually carries that
   * family. It is read straight off the database on every visit to this
   * page, so editing a family or importing a CSV is reflected the next
   * time anyone opens the dashboard — there is no separate copy to update.
   */
  const perPage = Math.max(1, parseInt(parishSettings.per_page, 10) || 1);
  const startingPage = parseInt(parishSettings.starting_page, 10) || 1;
  const indexEntries = families.map((f, i) => ({
    id: f.id,
    code: f.family_id,
    name: f.head_name,
    group: f.prayer_group || '',
    page: startingPage + Math.floor(i / perPage)
  }));
  const indexGroups = [...new Set(indexEntries.map((e) => e.group).filter(Boolean))].sort();

  res.render('dashboard', {
    title: 'Dashboard',
    stats,
    upcoming: upcoming.slice(0, 12),
    /*
     * A count against each step of the verification chain, each one clicking
     * through to the list of those families — so "17 families still not
     * started" is one click away from the names of those seventeen. Narrowed
     * to one Prayer Group when the header's filter is set.
     */
    statuses: verification.STATUSES,
    statusCounts: status.counts,
    statusTotal: status.total,
    groupings,
    filter,
    waiting,
    indexEntries,
    indexGroups,
    canEdit: auth.atLeast(req.user, 'editor'),
    isAdmin: auth.atLeast(req.user, 'admin')
  });
}));

module.exports = router;
