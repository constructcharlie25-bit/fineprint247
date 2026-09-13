/* js/nav.js — mobile hamburger menu toggle.
 * Defensive: no-ops when #navToggle / #mobileMenu are absent, so pages that
 * predate the mobile menu (or future pages without one) never throw. */
(function () {
  var toggle = document.getElementById('navToggle');
  var menu = document.getElementById('mobileMenu');
  if (!toggle || !menu) return;

  function setOpen(open) {
    menu.classList.toggle('open', open);
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    if (document.body && document.body.classList) {
      document.body.classList.toggle('menu-open', open);
    }
  }

  function isOpen() {
    return menu.classList.contains('open');
  }

  toggle.addEventListener('click', function (e) {
    e.preventDefault();
    setOpen(!isOpen());
  });

  // Tapping any link in the menu navigates and closes the menu.
  menu.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.closest && t.closest('a')) setOpen(false);
  });

  // Escape closes the menu.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen()) setOpen(false);
  });
})();
