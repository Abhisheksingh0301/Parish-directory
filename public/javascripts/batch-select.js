/**
 * Ticking the families a batch button acts on, on the verification status
 * screen.
 *
 * The list starts with every row ticked, which is what the buttons did before
 * there were any tick-boxes, so the ordinary case — "all of them" — still takes
 * no clicks. Unticking is the deliberate act, and the count on the buttons
 * follows it so the office can see what it is about to write before it writes
 * it.
 *
 * With scripting off the boxes still work: they are real form controls inside
 * a real form, the server reads whatever came back, and only the live count
 * and the header's select-all are lost.
 */
(function () {
  'use strict';

  var form = document.getElementById('batch-selection');
  if (!form) return;

  var all = document.querySelector('[data-batch-all]');
  var boxes = [].slice.call(form.querySelectorAll('input[name="family_ids"]'));
  var counts = [].slice.call(document.querySelectorAll('[data-batch-count]'));
  var buttons = [].slice.call(document.querySelectorAll('button[form="batch-selection"]'));
  if (!boxes.length) return;

  function ticked() {
    return boxes.filter(function (b) { return b.checked; });
  }

  function refresh() {
    var n = ticked().length;

    counts.forEach(function (span) { span.textContent = String(n); });

    // A button that would act on nothing is not offered. The server refuses an
    // empty selection too — this only saves the round trip.
    buttons.forEach(function (button) { button.disabled = n === 0; });

    if (all) {
      all.checked = n === boxes.length;
      all.indeterminate = n > 0 && n < boxes.length;
    }
  }

  if (all) {
    all.addEventListener('change', function () {
      boxes.forEach(function (b) { b.checked = all.checked; });
      refresh();
    });
  }

  boxes.forEach(function (b) { b.addEventListener('change', refresh); });

  /*
   * Confirm against the live count rather than the number the page was rendered
   * with. "Approve 49" after unticking forty of them would be a lie, and this
   * dialog is the last thing between the office and a batch it cannot undo.
   */
  buttons.forEach(function (button) {
    var template = button.getAttribute('data-batch-confirm');
    if (!template) return;

    button.addEventListener('click', function (event) {
      var n = ticked().length;
      var phrase = n + ' famil' + (n === 1 ? 'y' : 'ies');
      if (!window.confirm(template.replace('%n', phrase))) event.preventDefault();
    });
  });

  refresh();
})();
