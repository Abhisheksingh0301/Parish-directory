/**
 * Moving families from one step of the verification chain to another.
 *
 * The chain has always been eight tiles carrying eight counts, each one a link
 * to the families standing at that step. This makes the same tiles the two
 * ends of a move: press the step to take families *from*, press the step to
 * take them *to*, tick the households in between, and the panel posts them to
 * /families/status/move.
 *
 * Three things this deliberately does not do.
 *
 * It does not move anything itself. The panel is a real form with real
 * checkboxes, and the server decides what the move means — an entry nobody has
 * approved does not become Ready for Printing because a tile was pressed, and
 * a family with a correction waiting in the review queue is not swept into
 * Approved. Everything here is about choosing; routes/families.js is where the
 * choosing stops and the writing starts.
 *
 * It does not offer a destination the chain would refuse. The steps each step
 * may move to are decided by lib/verification.js and sent down with the page,
 * so a step that cannot be reached is greyed out rather than accepted and
 * quietly ignored.
 *
 * It does not take the tiles away from anyone without scripting. They stay
 * ordinary links, and a modified click — a new tab, a middle button — still
 * follows the link rather than starting a move.
 */
(function () {
  'use strict';

  var chain = document.getElementById('chain');
  var panel = document.getElementById('chain-move');
  var blob = document.getElementById('chain-data');
  if (!chain || !panel || !blob) return;

  var data;
  try {
    data = JSON.parse(blob.textContent);
  } catch (err) {
    return; // Without the families there is nothing to offer; the links remain.
  }

  var stages = data.stages || {};
  var moves = data.moves || {};

  var tiles = [].slice.call(chain.querySelectorAll('.chain-step'));
  var hint = document.getElementById('chain-hint');
  var list = panel.querySelector('[data-move-list]');
  var fromField = panel.querySelector('[data-move-from]');
  var toField = panel.querySelector('[data-move-to]');
  var fromLabel = panel.querySelector('[data-move-from-label]');
  var toLabel = panel.querySelector('[data-move-to-label]');
  var countLabel = panel.querySelector('[data-move-count]');
  var note = panel.querySelector('[data-move-note]');
  var go = panel.querySelector('[data-move-go]');
  var see = panel.querySelector('[data-move-see]');

  var source = null;
  var target = null;
  var picked = {};

  var labels = {};
  tiles.forEach(function (tile) {
    labels[tile.getAttribute('data-stage')] = tile.getAttribute('data-label');
  });

  function familiesAt(stage) {
    return (stage && stages[stage]) || [];
  }

  function allowed(from, to) {
    return (moves[from] || []).indexOf(to) !== -1;
  }

  function phrase(n) {
    return n + ' famil' + (n === 1 ? 'y' : 'ies');
  }

  function tickedIds() {
    return Object.keys(picked).filter(function (id) { return picked[id]; });
  }

  // ---- the tiles -----------------------------------------------------------

  function paintTiles() {
    tiles.forEach(function (tile) {
      var stage = tile.getAttribute('data-stage');
      var role = tile.querySelector('.role');

      tile.classList.toggle('is-source', stage === source);
      tile.classList.toggle('is-target', stage === target);

      /*
       * Once a step is chosen, the steps it cannot reach are dimmed rather
       * than removed: the count on a step nobody may move to is still worth
       * reading, and a tile that vanished under the pointer would move the
       * seven others out from under it.
       */
      var unreachable = !!source && stage !== source && !allowed(source, stage);
      tile.classList.toggle('is-unreachable', unreachable);

      if (role) {
        role.textContent = stage === source ? 'From' : (stage === target ? 'To' : '');
      }
    });
  }

  function say(text) {
    if (!hint) return;
    hint.innerHTML = text;
    hint.hidden = !text;
  }

  function bold(stage) {
    return '<strong>' + labels[stage] + '</strong>';
  }

  function updateHint() {
    if (!source) return say('');
    if (!target) {
      return say('Moving from ' + bold(source) + '. Now press the step to move them to.');
    }
    say(bold(source) + ' &rarr; ' + bold(target) + '. Tick the families below and confirm.');
  }

  // ---- the list ------------------------------------------------------------

  function renderList() {
    var families = familiesAt(source);
    list.innerHTML = '';

    if (!families.length) {
      var empty = document.createElement('p');
      empty.className = 'move-empty';
      empty.textContent = 'No family is standing at this step.';
      list.appendChild(empty);
      return;
    }

    families.forEach(function (family) {
      var row = document.createElement('label');
      row.className = 'move-row';

      var box = document.createElement('input');
      box.type = 'checkbox';
      box.name = 'family_ids';
      box.value = String(family.id);
      box.checked = !!picked[family.id];
      box.addEventListener('change', function () {
        picked[family.id] = box.checked;
        refresh();
      });

      var who = document.createElement('span');
      who.className = 'move-who';
      who.textContent = family.head_name;

      var meta = document.createElement('span');
      meta.className = 'move-meta';
      var bits = [family.family_id];
      if (family.area) bits.push(family.area);
      if (family.prayer_group) bits.push(family.prayer_group);
      if (!family.is_published) bits.push('Draft');
      meta.textContent = bits.join(' · ');

      row.appendChild(box);
      row.appendChild(who);
      row.appendChild(meta);
      list.appendChild(row);
    });
  }

  function tickAll(state) {
    picked = {};
    familiesAt(source).forEach(function (family) { picked[family.id] = state; });
    renderList();
    refresh();
  }

  // ---- what the button says it will do -------------------------------------

  function refresh() {
    var n = tickedIds().length;

    countLabel.textContent = String(n);
    fromField.value = source || '';
    toField.value = target || '';
    fromLabel.textContent = source ? labels[source] : '—';
    toLabel.textContent = target ? labels[target] : 'Pick a step above';

    go.disabled = !(source && target && n);
    go.textContent = 'Move ' + phrase(n) + (target ? ' to ' + labels[target] : '');

    /* The step's own link, so "see them" and the tile agree on the filter. */
    if (see) {
      var tile = source && chain.querySelector('.chain-step[data-stage="' + source + '"]');
      see.hidden = !tile;
      if (tile) see.href = tile.getAttribute('href');
    }

    if (!target) {
      note.textContent = 'Choose the step to move them to.';
    } else if (!n) {
      note.textContent = 'Tick at least one family.';
    } else if (target === 'ready_for_printing') {
      note.textContent = 'Only approved families already in the printed book are moved; ' +
        'the rest are reported back and left alone.';
    } else if (target === 'approved') {
      note.textContent = 'A family with corrections still waiting in the review queue ' +
        'is left alone — those are approved line by line.';
    } else {
      note.textContent = '';
    }
  }

  // ---- opening, closing --------------------------------------------------

  function open(stage) {
    source = stage;
    target = null;
    panel.hidden = false;
    tickAll(true); // The ordinary case is "all of them", as the table below is.
  }

  function close() {
    source = null;
    target = null;
    picked = {};
    panel.hidden = true;
    list.innerHTML = '';
    paintTiles();
    updateHint();
  }

  tiles.forEach(function (tile) {
    tile.addEventListener('click', function (event) {
      // A modified click is somebody opening the step in a tab of its own.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
          event.button !== 0) return;

      var stage = tile.getAttribute('data-stage');
      event.preventDefault();

      if (!source) {
        if (!familiesAt(stage).length) {
          say('No family is standing at ' + bold(stage) + ', so there is nothing to move.');
          return;
        }
        open(stage);
      } else if (stage === source) {
        close();
        return;
      } else if (!allowed(source, stage)) {
        say('The chain does not run backwards from ' + bold(source) + ' to ' +
            bold(stage) + '. Pick another step, or press ' + bold(source) +
            ' again to start over.');
        paintTiles();
        return;
      } else {
        target = stage;
      }

      paintTiles();
      updateHint();
      refresh();
    });
  });

  panel.querySelector('[data-move-all]').addEventListener('click', function () { tickAll(true); });
  panel.querySelector('[data-move-none]').addEventListener('click', function () { tickAll(false); });
  panel.querySelector('[data-move-cancel]').addEventListener('click', close);

  /*
   * The last thing between the office and a batch it cannot undo, counted from
   * what is ticked now rather than from what the panel opened with.
   */
  panel.addEventListener('submit', function (event) {
    var n = tickedIds().length;
    if (!source || !target || !n) {
      event.preventDefault();
      return;
    }
    var question = 'Move ' + phrase(n) + ' from ' + labels[source] + ' to ' +
      labels[target] + '?';
    if (!window.confirm(question)) event.preventDefault();
  });

  paintTiles();
  refresh();
})();
