/* "Same as the address above" on the family form.

   Plenty of families live in the house they are from, and typing the address
   twice is how the two drift apart. Ticking the box copies the address into
   the hometown field and keeps it there while the address is edited; the copy
   is read-only so it cannot be half-corrected. Unticking hands back whatever
   was in the field before, so a tick by mistake costs nothing.

   The offer is hidden in the markup and revealed here, because without this
   script it would be a checkbox that does nothing. */
(function () {
  'use strict';

  var address = document.getElementById('address');
  var hometown = document.getElementById('hometown');
  var toggle = document.getElementById('same-address');
  if (!address || !hometown || !toggle) return;

  var offer = toggle.closest('.checkline');
  if (offer) offer.hidden = false;

  var kept = hometown.value; // what the family had typed before the tick

  function apply(fromUser) {
    if (toggle.checked) {
      if (fromUser) kept = hometown.value;
      hometown.value = address.value;
    } else if (fromUser) {
      hometown.value = kept;
    }

    hometown.readOnly = toggle.checked;
    hometown.classList.toggle('is-copied', toggle.checked);
  }

  toggle.addEventListener('change', function () { apply(true); });
  address.addEventListener('input', function () { if (toggle.checked) apply(false); });

  apply(false);
})();
