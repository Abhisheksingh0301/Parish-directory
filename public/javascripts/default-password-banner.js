/**
 * The "you are still on the default password" reminder.
 *
 * It is a nudge, not a wall — dismissing it lasts for this browser tab only
 * (sessionStorage), so it comes back next time they sign in and stops for good
 * once they actually change the password, which clears the flag server-side.
 *
 * The banner is rendered hidden and shown from here, so a visitor with
 * JavaScript off is never left with a reminder they cannot dismiss.
 */
(function () {
  'use strict';

  var banner = document.getElementById('default-password-banner');
  if (!banner) return;

  var KEY = 'parish.defaultPasswordBanner.dismissed';

  try {
    if (sessionStorage.getItem(KEY) === '1') return;
  } catch (err) {
    // Private browsing can refuse sessionStorage; showing the banner is fine.
  }

  banner.hidden = false;

  var dismiss = banner.querySelector('[data-dismiss-banner]');
  if (!dismiss) return;

  dismiss.addEventListener('click', function () {
    banner.hidden = true;
    try {
      sessionStorage.setItem(KEY, '1');
    } catch (err) {
      // Nothing to do — it will simply reappear on the next page.
    }
  });
})();
