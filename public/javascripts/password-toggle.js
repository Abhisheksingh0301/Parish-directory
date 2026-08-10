/* Show/hide toggle for every password box on the page.
   Applied by script rather than written into each form, so any password field
   added later — including the per-user reset fields on the Users page — gets
   one without the view having to remember. */
(function () {
  'use strict';

  var EYE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M1.8 12S5.5 5 12 5s10.2 7 10.2 7-3.7 7-10.2 7S1.8 12 1.8 12z"/>' +
    '<circle cx="12" cy="12" r="3.2"/></svg>';

  var EYE_OFF =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10.2 7 10.2 7a17.8 17.8 0 0 1-3.3 4.2"/>' +
    '<path d="M6.4 6.5A17.6 17.6 0 0 0 1.8 12S5.5 19 12 19a9.7 9.7 0 0 0 4-.8"/>' +
    '<path d="M9.8 9.9a3.2 3.2 0 0 0 4.4 4.4"/>' +
    '<path d="M3 3l18 18"/></svg>';

  function attach(input) {
    if (input.dataset.hasToggle) return;
    input.dataset.hasToggle = '1';

    var wrap = document.createElement('div');
    wrap.className = 'password-field';

    // Some fields are sized with an inline width (the compact reset form on
    // the Users page). Move it to the wrapper so the layout is unchanged.
    if (input.style.width) {
      wrap.style.width = input.style.width;
      input.style.width = '';
    }

    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'toggle-password';
    button.innerHTML = EYE;
    button.setAttribute('aria-label', 'Show password');
    button.setAttribute('aria-pressed', 'false');
    button.title = 'Show password';
    wrap.appendChild(button);

    button.addEventListener('click', function () {
      var showing = input.type === 'text';
      var start = input.selectionStart;
      var end = input.selectionEnd;

      input.type = showing ? 'password' : 'text';
      button.innerHTML = showing ? EYE : EYE_OFF;

      var label = showing ? 'Show password' : 'Hide password';
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', showing ? 'false' : 'true');
      button.title = label;

      // Changing `type` drops the caret to the end; put it back.
      input.focus();
      if (start !== null) {
        try { input.setSelectionRange(start, end); } catch (e) { /* not selectable */ }
      }
    });
  }

  function scan(root) {
    (root || document).querySelectorAll('input[type=password]').forEach(attach);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { scan(); });
  } else {
    scan();
  }
})();
