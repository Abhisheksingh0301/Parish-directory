/* "Same as the address above" checkboxes on the family form.

   Both the hometown and the spouse's home are often the address the family
   already typed above, and typing it twice is how the copies drift apart.
   Ticking either box copies the address into that field and keeps it there
   while the address is edited; the copy is read-only so it cannot be
   half-corrected. Unticking hands back whatever was in the field before, so a
   tick by mistake costs nothing.

   Each offer is hidden in the markup and revealed here, because without this
   script it would be a checkbox that does nothing. */
(function () {
  'use strict';

  var address = document.getElementById('address');
  if (!address) return;

  function link(targetId, toggleId) {
    var target = document.getElementById(targetId);
    var toggle = document.getElementById(toggleId);
    if (!target || !toggle) return;

    var offer = toggle.closest('.checkline');
    if (offer) offer.hidden = false;

    var kept = target.value; // what was typed before the tick

    function apply(fromUser) {
      if (toggle.checked) {
        if (fromUser) kept = target.value;
        target.value = address.value;
      } else if (fromUser) {
        target.value = kept;
      }

      target.readOnly = toggle.checked;
      target.classList.toggle('is-copied', toggle.checked);
    }

    toggle.addEventListener('change', function () { apply(true); });
    address.addEventListener('input', function () { if (toggle.checked) apply(false); });

    apply(false);
  }

  link('hometown', 'same-address');
})();
