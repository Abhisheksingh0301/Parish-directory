/**
 * Ticking the families a batch button acts on.
 *
 * Two screens use this, and they start from opposite ends on purpose.
 *
 * On the verification status screen the list starts with every row ticked,
 * which is what the buttons did before there were any tick-boxes, so the
 * ordinary case — "all of them" — still takes no clicks. Unticking is the
 * deliberate act.
 *
 * On the families list, where the batch button deletes, nothing starts ticked.
 * The ordinary case there is "none of them", and a delete button that arrives
 * pre-loaded with the whole parish is a different kind of control altogether.
 * `data-batch-start="none"` on the form is what says which.
 *
 * Either way the count on the buttons follows the ticks, so the office can see
 * what it is about to write before it writes it.
 *
 * With scripting off the boxes still work: they are real form controls inside
 * a real form, the server reads whatever came back, and only the live count
 * and the header's select-all are lost.
 */
(function () {
  'use strict';

  function wire(form) {
    var id = form.getAttribute('id');

    var all = form.querySelector('[data-batch-all]');
    var boxes = [].slice.call(form.querySelectorAll('input[name="family_ids"]'));
    if (!boxes.length) return;

    /*
     * The buttons this form's ticks act on, wherever they sit on the page. The
     * status screen puts its batch buttons in a card of their own above the
     * table and joins the two with `form=`, so they cannot simply be looked
     * for inside the form element — and the live counts ride inside them.
     */
    var buttons = [].slice.call(document.querySelectorAll('button[form="' + id + '"]'))
      .concat([].slice.call(form.querySelectorAll('button[type="submit"]')));

    var counts = [];
    buttons.concat([form]).forEach(function (host) {
      [].slice.call(host.querySelectorAll('[data-batch-count]')).forEach(function (span) {
        if (counts.indexOf(span) === -1) counts.push(span);
      });
    });

    if (form.getAttribute('data-batch-start') === 'none') {
      boxes.forEach(function (b) { b.checked = false; });
    }

    function ticked() {
      return boxes.filter(function (b) { return b.checked; });
    }

    function refresh() {
      var n = ticked().length;

      counts.forEach(function (span) { span.textContent = String(n); });

      // A button that would act on nothing is not offered. The server refuses
      // an empty selection too — this only saves the round trip.
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
     * Confirm against the live count rather than the number the page was
     * rendered with. "Approve 49" after unticking forty of them would be a
     * lie, and this dialog is the last thing between the office and a batch it
     * cannot undo.
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
  }

  [].slice.call(document.querySelectorAll('form[data-batch-form]')).forEach(wire);
})();
