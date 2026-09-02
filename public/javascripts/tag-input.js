/* The comma-separated boxes on the family form — mobile numbers and emails.

   A member may list up to three of either, stored in one column and separated
   by commas (lib/phone.js, lib/email.js). Typed into a plain text box that is
   a hard thing to read back: "9876543210,9847012345" is twenty digits in a row
   and there is no telling by eye where one number ends. So each committed
   value becomes a chip, and the box beside them stays empty and ready for the
   next.

   Committed on a comma, on Enter, and on leaving the box — the last of those
   because somebody who types a number and clicks Save has finished entering
   it, whatever they did or did not press, and losing it would be the worst
   thing this file could do.

   Backspace in an empty box takes the last chip back apart rather than
   dropping it: a mistyped digit in a ten-digit number is fixed by editing it,
   and deleting outright would mean typing the whole thing again.

   Each chip is checked on its own against the field's single-value pattern and
   shown in red if it fails, which is what a `pattern` on the box cannot do —
   that says only "one of these is wrong". Red here is a warning, not a
   refusal: lib/phone.js and lib/email.js decide on the server, and they are
   the only checks that decide what is saved.

   Nothing here is load-bearing. With this file absent every box stays exactly
   what it is in the markup — a text input holding a comma-separated list, with
   its own `pattern` and its own title — and the form works as it always did. */
(function () {
  'use strict';

  var SPLIT_ON = /[,;]+/;

  function textOf(value) {
    return String(value == null ? '' : value);
  }

  function enhance(source) {
    if (source.dataset.tagsReady) return;
    source.dataset.tagsReady = '1';

    var max = Number(source.dataset.tagMax) || 0;
    var strip = source.dataset.tagStrip ? new RegExp(source.dataset.tagStrip, 'g') : null;
    var one = null;
    if (source.dataset.tagPattern) {
      try { one = new RegExp('^(?:' + source.dataset.tagPattern + ')$'); } catch (e) { one = null; }
    }

    var field = document.createElement('div');
    field.className = 'tag-field';

    var entry = document.createElement('input');
    entry.type = 'text';
    entry.className = 'tag-entry';
    var placeholder = source.getAttribute('placeholder') || '';
    entry.placeholder = placeholder;

    // The label in the markup wraps nothing and points at nothing, so a
    // screen reader would meet this box unnamed. Borrow the words above it.
    var label = source.closest('.field') && source.closest('.field').querySelector('label, .label');
    if (label) entry.setAttribute('aria-label', label.textContent.trim());
    // The box people actually type in inherits how the original behaved, so
    // the numeric keypad still comes up and mobile-digits.js still cleans it.
    if (source.hasAttribute('inputmode')) entry.setAttribute('inputmode', source.inputMode);
    if (source.hasAttribute('data-mobile')) entry.setAttribute('data-mobile', '');
    if (source.hasAttribute('autocomplete')) entry.setAttribute('autocomplete', source.autocomplete);
    if (source.hasAttribute('title')) field.title = source.title;

    // The original keeps its name and its value: it is still what the form
    // posts, and the server reads exactly what it always read.
    source.type = 'hidden';
    source.parentNode.insertBefore(field, source);
    field.appendChild(entry);
    field.appendChild(source);

    field.addEventListener('mousedown', function (event) {
      if (event.target === field) { event.preventDefault(); entry.focus(); }
    });

    function values() {
      return Array.prototype.slice.call(field.querySelectorAll('.tag'))
        .map(function (tag) { return tag.dataset.value; });
    }

    function sync() {
      var all = values();
      source.value = all.join(',');

      // "9876543210, then comma" is an instruction for an empty box. Once
      // there is a chip in there it is answered, and it only adds noise.
      entry.placeholder = all.length ? '' : placeholder;

      // Past the limit the extra chips are marked too, so the person can see
      // which ones are the extras rather than being told a number.
      all.forEach(function (value, i) {
        var tag = field.querySelectorAll('.tag')[i];
        var bad = (one && !one.test(value)) || (max && i >= max);
        tag.classList.toggle('is-bad', !!bad);
        tag.title = !bad ? ''
          : (max && i >= max)
            ? 'Only ' + max + ' fit in the printed entry — this one will be refused.'
            : 'This does not look right, and will be refused when you save.';
      });
    }

    function add(raw) {
      var value = textOf(raw).trim();
      if (strip) value = value.replace(strip, '');
      if (!value) return;
      if (values().indexOf(value) !== -1) return; // the same one twice is not two

      var tag = document.createElement('span');
      tag.className = 'tag';
      tag.dataset.value = value;

      var text = document.createElement('span');
      text.className = 'tag-label';
      text.textContent = value;
      tag.appendChild(text);

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'tag-remove';
      remove.setAttribute('aria-label', 'Remove ' + value);
      remove.textContent = '×';
      remove.addEventListener('click', function () {
        field.removeChild(tag);
        sync();
        entry.focus();
      });
      tag.appendChild(remove);

      field.insertBefore(tag, entry);
    }

    /** Commit whatever is in the box. Returns false when there was nothing. */
    function commit() {
      var typed = entry.value;
      if (!typed.trim()) { entry.value = ''; return false; }

      typed.split(SPLIT_ON).forEach(add);
      entry.value = '';
      sync();
      return true;
    }

    entry.addEventListener('keydown', function (event) {
      if (event.key === ',' || event.key === ';' || event.key === 'Enter') {
        // Enter in a form submits it; a comma is just a character. Neither
        // should happen while the box still holds something uncommitted.
        if (commit() || event.key !== 'Enter') event.preventDefault();
        return;
      }

      if (event.key === 'Backspace' && entry.value === '') {
        var tags = field.querySelectorAll('.tag');
        if (!tags.length) return;
        event.preventDefault();
        var last = tags[tags.length - 1];
        entry.value = last.dataset.value;
        field.removeChild(last);
        sync();
      }
    });

    // Pasting a whole list at once is how a sheet's cell gets in here.
    entry.addEventListener('paste', function (event) {
      var text = (event.clipboardData || window.clipboardData);
      if (!text) return;
      var pasted = text.getData('text');
      if (!SPLIT_ON.test(pasted)) return;
      event.preventDefault();
      entry.value = pasted;
      commit();
    });

    // Clicking Save with a number still in the box must not lose it.
    entry.addEventListener('blur', commit);

    textOf(source.value).split(SPLIT_ON).forEach(add);
    sync();
  }

  function enhanceAll() {
    Array.prototype.slice.call(document.querySelectorAll('input[data-tags]')).forEach(enhance);
  }

  enhanceAll();

  /*
   * "Add another member" clones a row after this file has run. Watching for it
   * rather than exporting a hook keeps the two files from knowing about each
   * other — the same arrangement day-of-month.js uses.
   *
   * Filtered to mutations that actually brought a field with them, because
   * every chip this file adds is itself a mutation: an unfiltered callback
   * would sweep the whole document on every keystroke.
   */
  function broughtAField(records) {
    for (var i = 0; i < records.length; i += 1) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j += 1) {
        var node = added[j];
        if (node.nodeType !== 1) continue;
        if (node.matches('input[data-tags]') || node.querySelector('input[data-tags]')) return true;
      }
    }
    return false;
  }

  if (window.MutationObserver) {
    new MutationObserver(function (records) {
      if (broughtAField(records)) enhanceAll();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
})();
