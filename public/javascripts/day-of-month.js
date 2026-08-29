/* The day half of a day-and-month field — the date of marriage.

   The markup already carries min="1" max="31", which is what a browser needs
   to refuse the form on submit. What it does not do is stop the number being
   typed: `max` is checked at submission, so 45 sits in the box looking accepted
   until the whole form comes back rejected. This holds the field to a real day
   as it is typed instead.

   It also narrows the limit to the month once one is chosen — April has 30 days
   and February is allowed 29, because a date of marriage is stored without a
   year and a leap-day anniversary has to be enterable.

   Nothing here is load-bearing. With this file absent the input keeps min/max
   and lib/daymonth.js still refuses a bad pair on the server, which is the only
   check that actually decides what is saved. */
(function () {
  'use strict';

  // February gets 29: with no year, a leap-day date is always valid.
  // Kept in step with DAYS_IN_MONTH in lib/daymonth.js.
  var DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  var groups = Array.prototype.slice.call(document.querySelectorAll('.daymonth'));

  groups.forEach(function (group) {
    var day = group.querySelector('input[type=number]');
    var month = group.querySelector('select');
    if (!day) return;

    function limit() {
      var m = month ? Number(month.value) : 0;
      return (m >= 1 && m <= 12) ? DAYS_IN_MONTH[m - 1] : 31;
    }

    function clamp() {
      // Strip anything that is not a digit — a number input still accepts
      // "e", "+" and "-" from the keyboard.
      var digits = day.value.replace(/[^\d]/g, '');
      var max = limit();

      if (digits.length > 2) digits = digits.slice(0, 2);
      if (digits !== '' && Number(digits) > max) digits = String(max);

      if (day.value !== digits) day.value = digits;
    }

    function applyLimit() {
      day.max = String(limit());
      clamp();
    }

    day.addEventListener('input', clamp);
    // A spinner or a paste can land out of range without an input event that
    // clamping caught; check once more when the field is left.
    day.addEventListener('change', clamp);
    if (month) month.addEventListener('change', applyLimit);

    applyLimit();
  });
})();
