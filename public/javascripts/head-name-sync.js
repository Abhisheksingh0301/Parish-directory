/* Keeps "Family head" and the first member row's name the same.

   The family's head is always its first member row — the help text on this
   form already asks for the spouse second — so the two fields are really one
   piece of information typed twice. Editing either one mirrors it into the
   other, for as long as the two agree. The moment they stop agreeing — one of
   them was edited to something the other doesn't have — mirroring stops for
   both fields, so an intentional difference (an honorific spelled out
   differently, say) is never overwritten. */
(function () {
  'use strict';

  var headName = document.getElementById('head_name');
  var editor = document.getElementById('members-editor');
  if (!headName || !editor) return;

  function firstMemberNameInput() {
    var firstRow = editor.querySelector('[data-member-row]');
    return firstRow ? firstRow.querySelector('input[name$="[name]"]') : null;
  }

  // What both fields held immediately after the last edit either of us made —
  // equal to each other exactly when the two are still in sync.
  var lastHead = headName.value;
  var lastMember = firstMemberNameInput() ? firstMemberNameInput().value : '';

  function onEdit(source, target) {
    if (lastHead === lastMember) target.value = source.value;
    lastHead = headName.value;
    var memberInput = firstMemberNameInput();
    lastMember = memberInput ? memberInput.value : '';
  }

  headName.addEventListener('input', function () {
    var memberInput = firstMemberNameInput();
    if (memberInput) onEdit(headName, memberInput);
  });

  editor.addEventListener('input', function (event) {
    if (event.target !== firstMemberNameInput()) return;
    onEdit(event.target, headName);
  });
})();
