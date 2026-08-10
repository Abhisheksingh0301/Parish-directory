/**
 * Copy the comma-separated family email addresses to the clipboard, so the
 * parish office can paste them straight into the Bcc line of one message.
 *
 * Falls back to selecting the text when the clipboard API is unavailable —
 * over plain HTTP on a LAN, for instance — so the button always does
 * something useful.
 */
(function () {
  'use strict';

  var button = document.querySelector('[data-copy-emails]');
  var source = document.getElementById('all-emails');
  if (!button || !source) return;

  var original = button.textContent;
  var timer = null;

  function flash(message) {
    button.textContent = message;
    clearTimeout(timer);
    timer = setTimeout(function () {
      button.textContent = original;
    }, 2500);
  }

  button.addEventListener('click', function () {
    var text = source.value;

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        function () { flash('Copied ✓'); },
        function () { select(); }
      );
      return;
    }
    select();
  });

  function select() {
    source.hidden = false;
    source.focus();
    source.select();
    flash('Press Ctrl+C');
  }
})();
