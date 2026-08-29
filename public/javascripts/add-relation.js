/* Add a relation to the list the member editor suggests, without leaving a
   half-filled family form.

   The relation box on each member row is free text with a datalist, so an
   unusual relation can always be typed straight into the row. This is for the
   other case: a relation the parish will keep using, which should be offered
   from now on. It appends to the relation_options setting and adds the option
   to the datalist in this page immediately, so the row being filled in can use
   it at once.

   The block starts hidden and is revealed here. Without JavaScript there is
   nothing this control could do, and the whole list stays editable on the
   settings page — which is where the help text points. */
(function () {
  'use strict';

  var box = document.getElementById('add-relation');
  var input = document.getElementById('new-relation');
  var button = document.getElementById('add-relation-go');
  var note = document.getElementById('add-relation-note');
  var list = document.getElementById('relation-codes');
  var token = document.querySelector('input[name=_csrf]');
  if (!box || !input || !button || !list || !token) return;

  var endpoint = box.dataset.endpoint;
  if (!endpoint) return;

  var original = note ? note.innerHTML : '';
  box.hidden = false;

  function say(message, bad) {
    if (!note) return;
    note.textContent = message;
    note.style.color = bad ? 'var(--danger)' : 'var(--ok, inherit)';
  }

  function reset() {
    if (!note) return;
    note.innerHTML = original;
    note.style.color = '';
  }

  /* What went wrong, when the answer was not this endpoint's. */
  function statusMessage(status) {
    if (status === 404) {
      return 'The server does not have this feature yet — it needs restarting.';
    }
    if (status === 401 || status === 403) {
      return 'You are no longer signed in as an administrator. Reload the page.';
    }
    if (status >= 500) {
      return 'The server failed while adding that — check its log.';
    }
    return 'That could not be added (HTTP ' + status + ').';
  }

  function add() {
    var name = input.value.trim();
    if (!name) { input.focus(); return; }

    button.disabled = true;
    say('Adding…', false);

    fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token.value
      },
      // Same-origin by default, but the session cookie is the whole of auth
      // here, so say so rather than depend on the default.
      credentials: 'same-origin',
      body: JSON.stringify({ name: name })
    })
      .then(function (res) {
        /* Only this endpoint answers in JSON. Anything else on the wire is a
           sign-in page, an error page, or a server that predates this feature
           — parsing it as JSON would throw and be reported below as a network
           problem, which sends people to look at their wifi over a 404. */
        var type = res.headers.get('content-type') || '';
        if (type.indexOf('application/json') === -1) {
          return { ok: false, data: { message: statusMessage(res.status) } };
        }
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (result) {
        if (!result.ok || !result.data.ok) {
          say((result.data && result.data.message) || 'That could not be added.', true);
          return;
        }

        // Rebuild the datalist from what the server says the list now is, so
        // the page agrees with the setting rather than with what we hoped.
        list.innerHTML = '';
        result.data.relations.forEach(function (relation) {
          var option = document.createElement('option');
          option.value = relation;
          list.appendChild(option);
        });

        input.value = '';
        say(result.data.message || 'Added.', false);
      })
      .catch(function () {
        // Only a genuine transport failure reaches here now.
        say('That could not be added — check your connection and try again.', true);
      })
      .then(function () {
        button.disabled = false;
      });
  }

  button.addEventListener('click', add);

  input.addEventListener('keydown', function (event) {
    // Enter here means "add this relation", not "submit the family".
    if (event.key !== 'Enter') return;
    event.preventDefault();
    add();
  });

  input.addEventListener('input', reset);
})();
