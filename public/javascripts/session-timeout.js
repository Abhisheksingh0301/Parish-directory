/**
 * The idle countdown, and the warning before it runs out.
 *
 * None of this is the security. lib/idle.js expires the session on the server
 * from its own clock, and a request arriving after the window has passed is
 * refused whether or not this file ever ran. What this adds is manners: a
 * notice before the session goes, a way to say "I'm still here", and a tidy
 * landing on the sign-in page instead of a form that throws away ten minutes
 * of typing the next time Save is pressed.
 *
 * So everything below may fail safely. With the script blocked, the clocks
 * disagreeing, or the tab asleep for an hour, the worst outcome is the old
 * behaviour — you find out you were signed out when you next click something.
 *
 * Three things keep it honest:
 *
 *   - The deadline is the SERVER's. Every poll and every extend returns
 *     `remainingMs`, and the countdown is reset to it rather than trusting the
 *     local timer, which drifts and stops dead when a laptop is shut.
 *   - Activity is reported by ordinary page requests. Typing does not call the
 *     server — it only moves the local clock, and the next real request is what
 *     actually renews the session. A page somebody is reading without clicking
 *     is genuinely idle, and the warning appearing on it is correct.
 *   - Tabs share one deadline through localStorage, so working in one tab does
 *     not leave another counting down to a warning that is no longer true.
 */
(function () {
  'use strict';

  var root = document.getElementById('session-timeout');
  if (!root) return;

  var BASE = root.dataset.base || '';
  var IDLE_MS = Number(root.dataset.idleMs);
  var WARN_MS = Number(root.dataset.warnMs);
  var TOKEN = root.dataset.csrf || '';

  if (!Number.isFinite(IDLE_MS) || IDLE_MS <= 0) return;

  /* How often the countdown is compared against the server. Frequent enough
     that a session ended somewhere else — signed out in another tab, an
     account deactivated — is noticed within the minute, and rare enough that
     a directory left open all day is not a stream of requests. The endpoint
     is exempt from renewing the session, so polling costs nothing but a row
     read. */
  var POLL_MS = 60 * 1000;
  var SHARED_KEY = 'parish.session.deadline';

  var dialog = document.getElementById('session-timeout-dialog');
  var counter = document.getElementById('session-timeout-remaining');
  var stayButton = document.getElementById('session-timeout-stay');

  var deadline = Date.now() + IDLE_MS;
  var warningShown = false;
  var finished = false;
  var ticker = null;
  var poller = null;

  // ---- the shared deadline -------------------------------------------------

  function publish() {
    try {
      localStorage.setItem(SHARED_KEY, String(deadline));
    } catch (err) {
      // Private browsing refuses localStorage. Each tab then counts on its
      // own, which is the behaviour without this feature at all.
    }
  }

  function setDeadline(ms, share) {
    deadline = Date.now() + ms;
    if (warningShown && ms > WARN_MS) hideWarning();
    if (share !== false) publish();
  }

  // Another tab moved the deadline. Only ever accept one further away than
  // ours: a tab that has just been used knows more than a tab that has not,
  // and taking the later value is what keeps activity shared. Never share it
  // back, or two tabs bounce the value between them.
  window.addEventListener('storage', function (event) {
    if (event.key !== SHARED_KEY || !event.newValue) return;
    var shared = Number(event.newValue);
    if (Number.isFinite(shared) && shared > deadline) {
      deadline = shared;
      if (warningShown && shared - Date.now() > WARN_MS) hideWarning();
    }
  });

  // ---- talking to the server ----------------------------------------------

  /**
   * Ask what is left, or say that somebody is here.
   *
   * A failed request is ignored on purpose: the parish's connection dropping
   * for thirty seconds is not a reason to throw somebody out of a form they
   * are in the middle of. The local countdown carries on, and if the session
   * really has gone the next page they open says so.
   */
  function ask(path, method) {
    var options = {
      method: method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    };
    if (method === 'POST') options.headers['x-csrf-token'] = TOKEN;

    return fetch(BASE + path, options)
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .catch(function () {
        return null;
      });
  }

  function apply(state) {
    if (!state) return;
    if (!state.signedIn) return expire();
    setDeadline(state.remainingMs);
  }

  function poll() {
    if (finished) return;
    ask('/session/status', 'GET').then(apply);
  }

  // ---- the warning ---------------------------------------------------------

  function words(ms) {
    var seconds = Math.max(0, Math.ceil(ms / 1000));
    if (seconds < 60) return seconds + (seconds === 1 ? ' second' : ' seconds');
    var minutes = Math.ceil(seconds / 60);
    return minutes + (minutes === 1 ? ' minute' : ' minutes');
  }

  function showWarning() {
    warningShown = true;
    dialog.hidden = false;
    if (stayButton) stayButton.focus();
  }

  function hideWarning() {
    warningShown = false;
    dialog.hidden = true;
  }

  /**
   * Out of time. Hand over to the server rather than deciding anything here —
   * the session is already refused, and loading the sign-in page is how the
   * person is told so. `replace` rather than `assign` so the Back button does
   * not step onto the page they were just signed out of.
   */
  function expire() {
    if (finished) return;
    finished = true;
    clearInterval(ticker);
    clearInterval(poller);
    window.location.replace(BASE + '/login?timeout=1');
  }

  function tick() {
    if (finished) return;

    var left = deadline - Date.now();

    if (left <= 0) {
      /*
       * The local clock says it is over. Check before acting: a laptop that
       * was asleep wakes with a deadline long past, and the session may have
       * been renewed from another window in the meantime. The server decides,
       * and only its "signed out" redirects.
       */
      ask('/session/status', 'GET').then(function (state) {
        if (!state) return expire();
        apply(state);
      });
      return;
    }

    if (left <= WARN_MS && !warningShown) showWarning();
    if (warningShown && counter) counter.textContent = words(left);
  }

  // ---- what counts as being here ------------------------------------------

  /*
   * Pressing the button is a real request and renews the session on the
   * server; the reply carries the new window back.
   */
  if (stayButton) {
    stayButton.addEventListener('click', function () {
      hideWarning();
      ask('/session/extend', 'POST').then(function (state) {
        // A session that expired while the notice was on screen is gone, and
        // the reply says so. Better to land on the sign-in page than to leave
        // somebody typing into a form that cannot be saved.
        if (!state) return setDeadline(IDLE_MS);
        apply(state);
      });
    });
  }

  /*
   * Ordinary use moves the local clock only. The server is renewed by the
   * requests the person is already making — opening a family, saving a form,
   * running a search — so reading and typing hold the warning off without a
   * heartbeat, and a page nobody is touching counts down as it should.
   */
  ['mousedown', 'keydown', 'touchstart', 'scroll'].forEach(function (name) {
    window.addEventListener(name, function () {
      if (finished || warningShown) return;
      setDeadline(IDLE_MS);
    }, { passive: true, capture: true });
  });

  /*
   * Coming back to the tab, including from the back/forward cache. The
   * no-store headers in lib/idle.js keep signed-in pages out of that cache in
   * current browsers, but this is the belt to that braces: a restored page is
   * checked against the server before it is believed.
   */
  window.addEventListener('pageshow', poll);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) poll();
  });

  publish();
  ticker = setInterval(tick, 1000);
  poller = setInterval(poll, POLL_MS);
})();
