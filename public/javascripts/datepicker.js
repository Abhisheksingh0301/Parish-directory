/* A date picker for dates of birth.

   The browser's own calendar walks a month at a time, which is no way to
   reach 1948. This one puts the month and the year in dropdowns above the
   grid, so any year between the field's min and max is one click away.

   It enhances <input type="date"> and nothing more: without JavaScript the
   field stays a native date input, and the value that reaches the server is
   the same "1975-08-02" either way — carried by a hidden field once the
   visible box turns into a readable "02 - Aug - 1975". */
(function (window, document) {
  'use strict';

  var MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                     'August', 'September', 'October', 'November', 'December'];
  var WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  var open = null; // the one popup on screen, if any

  function pad(number, width) {
    var text = String(number);
    while (text.length < width) text = '0' + text;
    return text;
  }

  /** A local Date from "1975-08-02", or null if that is not a real date. */
  function parseISO(text) {
    var parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || '').trim());
    if (!parts) return null;

    var year = Number(parts[1]);
    var month = Number(parts[2]) - 1;
    var day = Number(parts[3]);
    var date = new Date(year, month, day);

    // Rejects the likes of "2001-02-30", which Date would roll into March.
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
      return null;
    }
    return date;
  }

  function toISO(date) {
    return pad(date.getFullYear(), 4) + '-' + pad(date.getMonth() + 1, 2) + '-' + pad(date.getDate(), 2);
  }

  /** "02 - Aug - 1975" — how the rest of the directory writes a date. */
  function display(date) {
    return pad(date.getDate(), 2) + ' - ' + MONTHS_SHORT[date.getMonth()] + ' - ' + date.getFullYear();
  }

  var startOfDay = function (date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  };

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, text, label) {
    var node = element('button', className, text);
    node.type = 'button'; // never a submit button: this lives inside a form
    if (label) node.setAttribute('aria-label', label);
    return node;
  }

  function closeOpen() {
    if (!open) return;
    open.pop.hidden = true;
    open.input.setAttribute('aria-expanded', 'false');
    open = null;
  }

  function build(input) {
    var min = parseISO(input.getAttribute('min')) || new Date(1900, 0, 1);
    var max = parseISO(input.getAttribute('max')) || new Date();
    var selected = parseISO(input.value);
    var today = startOfDay(new Date());

    // The visible box becomes a readable, read-only summary; the hidden field
    // keeps the name and the machine-readable value the server parses.
    var hidden = element('input');
    hidden.type = 'hidden';
    hidden.name = input.getAttribute('name') || '';
    hidden.value = selected ? toISO(selected) : '';

    input.removeAttribute('name');
    input.type = 'text';
    input.readOnly = true;
    input.autocomplete = 'off';
    input.placeholder = 'Pick a date';
    input.value = selected ? display(selected) : '';
    input.setAttribute('aria-haspopup', 'dialog');
    input.setAttribute('aria-expanded', 'false');

    var wrap = element('div', 'datepicker');
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    wrap.appendChild(hidden);

    var pop = element('div', 'dp-pop');
    pop.hidden = true;
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Choose a date');

    var head = element('div', 'dp-head');
    var previous = button('dp-nav', '‹', 'Previous month');
    var next = button('dp-nav', '›', 'Next month');

    var monthSelect = element('select', 'dp-month');
    monthSelect.setAttribute('aria-label', 'Month');
    MONTHS_LONG.forEach(function (name, i) {
      var option = element('option', null, name);
      option.value = String(i);
      monthSelect.appendChild(option);
    });

    // Newest first: a date of birth is far more often in living memory than
    // in 1900, and the list is over a century long.
    var yearSelect = element('select', 'dp-year');
    yearSelect.setAttribute('aria-label', 'Year');
    for (var year = max.getFullYear(); year >= min.getFullYear(); year -= 1) {
      var option = element('option', null, String(year));
      option.value = String(year);
      yearSelect.appendChild(option);
    }

    head.appendChild(previous);
    head.appendChild(monthSelect);
    head.appendChild(yearSelect);
    head.appendChild(next);

    var names = element('div', 'dp-weekdays');
    WEEKDAYS.forEach(function (day) { names.appendChild(element('span', null, day)); });

    var grid = element('div', 'dp-grid');
    var foot = element('div', 'dp-foot');
    var clear = button('dp-clear', 'Clear');
    var picked = element('span', 'dp-picked');
    foot.appendChild(picked);
    foot.appendChild(clear);

    pop.appendChild(head);
    pop.appendChild(names);
    pop.appendChild(grid);
    pop.appendChild(foot);
    wrap.appendChild(pop);

    // The month on show, which is not the same as the date chosen — someone
    // may page around and change their mind without picking anything.
    var view = selected || (today > max ? max : (today < min ? min : today));

    function inRange(date) { return date >= startOfDay(min) && date <= startOfDay(max); }

    function render() {
      monthSelect.value = String(view.getMonth());
      yearSelect.value = String(view.getFullYear());

      var first = new Date(view.getFullYear(), view.getMonth(), 1);
      var days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();

      previous.disabled = !inRange(new Date(view.getFullYear(), view.getMonth(), 0));
      next.disabled = !inRange(new Date(view.getFullYear(), view.getMonth() + 1, 1));

      grid.textContent = '';
      for (var blank = 0; blank < first.getDay(); blank += 1) {
        grid.appendChild(element('span', 'dp-blank'));
      }

      for (var day = 1; day <= days; day += 1) {
        var date = new Date(view.getFullYear(), view.getMonth(), day);
        var cell = button('dp-day', String(day));
        cell.dataset.iso = toISO(date);
        cell.disabled = !inRange(date);
        if (date.getTime() === today.getTime()) cell.classList.add('is-today');
        if (selected && date.getTime() === selected.getTime()) {
          cell.classList.add('is-selected');
          cell.setAttribute('aria-current', 'date');
        }
        grid.appendChild(cell);
      }

      picked.textContent = selected ? display(selected) : 'No date yet';
      clear.hidden = !selected;
    }

    // Focusing the box opens the calendar, so putting focus back after a pick
    // must not open it again.
    var refocusing = false;
    function refocus() {
      refocusing = true;
      input.focus();
      refocusing = false;
    }

    function show() {
      if (refocusing) return;
      if (open && open.input === input) return;
      closeOpen();

      // Re-read in case the value was changed from outside while closed.
      selected = parseISO(hidden.value);
      if (selected) view = selected;

      pop.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      render();

      // Flip to the right edge rather than off the side of the window.
      pop.classList.remove('to-left');
      if (pop.getBoundingClientRect().right > document.documentElement.clientWidth - 8) {
        pop.classList.add('to-left');
      }

      open = { input: input, pop: pop };
    }

    function choose(date) {
      selected = date;
      view = date;
      hidden.value = toISO(date);
      input.value = display(date);
      closeOpen();
      refocus();
    }

    input.addEventListener('click', show);
    input.addEventListener('focus', show);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        show();
      }
    });

    monthSelect.addEventListener('change', function () {
      view = new Date(view.getFullYear(), Number(monthSelect.value), 1);
      render();
    });
    yearSelect.addEventListener('change', function () {
      view = new Date(Number(yearSelect.value), view.getMonth(), 1);
      render();
    });

    previous.addEventListener('click', function () {
      view = new Date(view.getFullYear(), view.getMonth() - 1, 1);
      render();
    });
    next.addEventListener('click', function () {
      view = new Date(view.getFullYear(), view.getMonth() + 1, 1);
      render();
    });

    grid.addEventListener('click', function (event) {
      var cell = event.target.closest('.dp-day');
      if (cell && !cell.disabled) choose(parseISO(cell.dataset.iso));
    });

    clear.addEventListener('click', function () {
      selected = null;
      hidden.value = '';
      input.value = '';
      closeOpen();
      refocus();
    });

    pop.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      closeOpen();
      refocus();
    });

    /** Pick the state back up from the hidden field, after a row is reset. */
    wrap.dpSync = function () {
      selected = parseISO(hidden.value);
      input.value = selected ? display(selected) : '';
      if (open && open.input === input) render();
    };
  }

  /** Turn every date field inside `scope` into one of these pickers. */
  function enhance(scope) {
    var root = scope || document;
    var fields = root.querySelectorAll('input[type=date]');
    Array.prototype.forEach.call(fields, build);
  }

  /** Re-read the fields inside `scope` — for rows cleared by other scripts. */
  function sync(scope) {
    var wraps = (scope || document).querySelectorAll('.datepicker');
    Array.prototype.forEach.call(wraps, function (wrap) { wrap.dpSync(); });
  }

  document.addEventListener('mousedown', function (event) {
    if (open && !event.target.closest('.datepicker')) closeOpen();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeOpen();
  });

  window.ParishDatePicker = { enhance: enhance, sync: sync };
  enhance(document);
})(window, document);
