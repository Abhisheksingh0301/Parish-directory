/* Add and remove member rows on the family form.
   Row indices only have to be unique and increasing — the server reads the
   submitted rows in order and renumbers them on save — so removing a row
   never needs the remaining ones to be re-indexed. */
(function () {
  'use strict';

  var editor = document.getElementById('members-editor');
  var template = document.getElementById('member-template');
  var addButton = document.getElementById('add-member');
  if (!editor || !template || !addButton) return;

  var nextIndex = editor.querySelectorAll('[data-member-row]').length;

  function rowCount() {
    return editor.querySelectorAll('[data-member-row]').length;
  }

  addButton.addEventListener('click', function () {
    var markup = template.innerHTML.replace(/__INDEX__/g, String(nextIndex));
    nextIndex += 1;

    var holder = document.createElement('div');
    holder.innerHTML = markup;

    var row = holder.querySelector('[data-member-row]');
    editor.appendChild(row);

    // The cloned row carries a plain date field; give it the same picker the
    // rows rendered by the server got.
    if (window.ParishDatePicker) window.ParishDatePicker.enhance(row);

    var firstInput = row.querySelector('input[type=text]');
    if (firstInput) firstInput.focus();
  });

  editor.addEventListener('click', function (event) {
    var button = event.target.closest('[data-remove-member]');
    if (!button) return;

    var row = button.closest('[data-member-row]');
    if (!row) return;

    // Always leave one row, so the form never looks broken.
    if (rowCount() <= 1) {
      // The "keep the recorded day and month" offer belongs to the member
      // being cleared, not to whoever is typed in over them.
      row.querySelectorAll('[data-keep-dob]').forEach(function (keep) { keep.remove(); });
      row.querySelectorAll('input').forEach(function (input) { input.value = ''; });
      row.querySelectorAll('select').forEach(function (select) { select.selectedIndex = 0; });
      if (window.ParishDatePicker) window.ParishDatePicker.sync(row);
      return;
    }

    row.remove();
  });
})();
