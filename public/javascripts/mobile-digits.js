/* The mobile number boxes on the family form.

   The markup already carries maxlength and a pattern, which is what a browser
   needs to refuse the form on submit. What it does not do is stop the letters
   going in: "Jomon's phone" sits in the box looking accepted until the whole
   form comes back rejected, and the person who typed it has to work out which
   of several member rows the complaint was about.

   So anything that is not a digit is taken out as it is typed. What is pasted
   in is only cleaned, never shortened — a number pasted with its country code
   is left whole and long, so the pattern objects to it and the person sees the
   number they actually pasted, rather than a silently truncated one that looks
   right and would ring nobody.

   Delegated from the document because "Add another member" clones a row after
   this file has run, and the clone has to behave like the rows that were here
   at load.

   Nothing here is load-bearing. With this file absent the boxes keep their
   maxlength and pattern, and lib/phone.js still refuses a bad number on the
   server, which is the only check that decides what is saved. */
(function () {
  'use strict';

  document.addEventListener('input', function (event) {
    var field = event.target;
    if (!field || !field.hasAttribute || !field.hasAttribute('data-mobile')) return;

    var digits = field.value.replace(/[^0-9]/g, '');
    if (field.value === digits) return;

    // Where the caret was, counting only the digits before it, so cleaning up
    // a paste in the middle of a number does not throw the caret to the end.
    var caret = field.selectionStart;
    var kept = typeof caret === 'number'
      ? field.value.slice(0, caret).replace(/[^0-9]/g, '').length
      : null;

    field.value = digits;
    if (kept !== null) {
      try { field.setSelectionRange(kept, kept); } catch (e) { /* not a field that has a caret */ }
    }
  });
})();
