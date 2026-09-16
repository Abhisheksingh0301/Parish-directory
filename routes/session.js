'use strict';

/**
 * The two endpoints the idle countdown in the browser talks to.
 *
 * Both are deliberately thin. The timeout is decided in lib/idle.js on every
 * request; these only let the page ask what it has left and say that somebody
 * is still there.
 *
 * Mounted above `auth.requireAuth` because both have to answer a session that
 * has just expired — a redirect to the sign-in page is not something a fetch()
 * can act on, and following it would hand the countdown a page of HTML where
 * it expected a number.
 */

const express = require('express');
const idle = require('../lib/idle');

const router = express.Router();

/**
 * How long is left, without spending any of it.
 *
 * `/session/status` is on the exempt list in lib/idle.js, so polling this does
 * not renew the session — which is the whole point of it. Answers 200 either
 * way; `signedIn: false` is the expiry, and the page acts on that.
 */
router.get('/session/status', (req, res) => {
  res.json(idle.snapshot(req));
});

/**
 * "Continue working" — a person pressed the button in the warning.
 *
 * A POST, so the CSRF check in front of it applies: without that, any page in
 * another tab could hold a parish session open indefinitely with an image tag.
 * Not exempt, so `idle.touch` has already renewed the session by the time this
 * runs and the snapshot returned is the fresh window.
 *
 * A session that expired while the warning was on screen is already gone, and
 * this answers `signedIn: false` rather than reviving it. Pressing the button
 * two seconds late signs you out, as it should — otherwise the timeout is only
 * as strong as the slowest hand on the mouse.
 */
router.post('/session/extend', (req, res) => {
  res.json(idle.snapshot(req));
});

module.exports = router;
