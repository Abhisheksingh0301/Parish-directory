/* The "Manage" and "System" menus in the top bar.

   They are <details> elements, so they already open, close and keep their
   keyboard behaviour with this file absent — which is the point of building
   them that way. Nothing here is load-bearing.

   What it adds is the three things a <details> used as a menu does not do on
   its own: close when you click anywhere else, close on Escape, and close the
   other one when you open this one, so two panels never overlap. */
(function () {
  'use strict';

  var menus = Array.prototype.slice.call(document.querySelectorAll('.nav-menu'));
  if (!menus.length) return;

  function closeAll(except) {
    menus.forEach(function (menu) {
      if (menu !== except) menu.open = false;
    });
  }

  menus.forEach(function (menu) {
    menu.addEventListener('toggle', function () {
      if (menu.open) closeAll(menu);
    });
  });

  document.addEventListener('click', function (event) {
    // A click inside the menu that is open is the menu being used.
    var inside = menus.some(function (menu) {
      return menu.open && menu.contains(event.target);
    });
    if (!inside) closeAll(null);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;

    var open = menus.filter(function (menu) { return menu.open; });
    if (!open.length) return;

    closeAll(null);
    // Escape should leave the keyboard where it can reopen the menu, not
    // adrift at the top of the document.
    var summary = open[0].querySelector('summary');
    if (summary) summary.focus();
  });
})();
