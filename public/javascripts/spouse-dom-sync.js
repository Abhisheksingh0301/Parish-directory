/* Mirrors the Head of Family's date of marriage into the spouse's row.

   A married couple share one wedding date, so typing it once into the head's
   row (the first row) is enough — a row recognised as the spouse (its
   Relation field reads "spouse") picks the date up automatically, the moment
   it is marked. It keeps following the head's row for as long as the two
   agree, exactly like head-name-sync.js does for the name field. The moment
   the spouse's own date is edited to disagree, mirroring stops for that row,
   so an intentional difference is never overwritten. */
(function () {
  'use strict';

  var editor = document.getElementById('members-editor');
  if (!editor) return;

  function headRow() {
    return editor.querySelector('[data-member-row]');
  }

  function isSpouseRelation(row) {
    var relation = row.querySelector('input[name$="[relation]"]');
    return !!relation && relation.value.trim().toLowerCase() === 'spouse';
  }

  function domFields(row) {
    var day = row.querySelector('input[name$="[dom_day]"]');
    var month = row.querySelector('select[name$="[dom_month]"]');
    return (day && month) ? { day: day, month: month } : null;
  }

  function sameDate(a, b) {
    return a.day.value === b.day.value && a.month.value === b.month.value;
  }

  function copyDate(from, to) {
    to.day.value = from.day.value;
    to.month.value = from.month.value;
  }

  // Whether a spouse row is still in step with the head's date — set the
  // moment a row is recognised as the spouse, cleared the moment its own
  // date is edited to disagree.
  var synced = new WeakMap();

  function refresh() {
    var head = headRow();
    var headDom = head && domFields(head);
    if (!headDom) return;

    Array.prototype.forEach.call(editor.querySelectorAll('[data-member-row]'), function (row) {
      if (row === head || !isSpouseRelation(row)) return;
      var dom = domFields(row);
      if (!dom) return;

      if (!synced.has(row)) {
        var empty = !dom.day.value && !dom.month.value;
        synced.set(row, empty || sameDate(headDom, dom));
      }
      if (synced.get(row)) copyDate(headDom, dom);
    });
  }

  editor.addEventListener('input', function (event) {
    var row = event.target.closest('[data-member-row]');
    if (!row) return;

    if (row !== headRow()) {
      var dom = domFields(row);
      if (dom && (event.target === dom.day || event.target === dom.month)) {
        var head = headRow();
        var headDom = head && domFields(head);
        synced.set(row, !!headDom && sameDate(headDom, dom));
      }
    }

    refresh();
  });

  editor.addEventListener('change', refresh);

  refresh();
})();
