(function () {
  var previousBodyOverflow = '';
  var previousHtmlOverflow = '';

  function menu() {
    return document.getElementById('mobile-menu');
  }

  function lockScroll() {
    previousBodyOverflow = document.body.style.overflow || '';
    previousHtmlOverflow = document.documentElement.style.overflow || '';
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
  }

  function unlockScroll() {
    if (document.querySelector('.modal.open:not(#mobile-menu)')) return;
    document.body.style.overflow = previousBodyOverflow;
    document.documentElement.style.overflow = previousHtmlOverflow;
  }

  window.openMobileMenu = function openMobileMenu() {
    var el = menu();
    if (!el) return false;
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    lockScroll();
    setTimeout(function () {
      var close = document.getElementById('mobile-menu-close');
      if (close) close.focus({ preventScroll: true });
    }, 0);
    return false;
  };

  window.closeMobileMenu = function closeMobileMenu() {
    var el = menu();
    if (!el) return false;
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    unlockScroll();
    return false;
  };

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('mobile-menu-btn');
    var close = document.getElementById('mobile-menu-close');
    var el = menu();

    if (el) el.setAttribute('aria-hidden', el.classList.contains('open') ? 'false' : 'true');
    if (btn) btn.addEventListener('click', function (event) {
      event.preventDefault();
      window.openMobileMenu();
    });
    if (close) close.addEventListener('click', function (event) {
      event.preventDefault();
      window.closeMobileMenu();
    });
    if (el) {
      el.addEventListener('click', function (event) {
        if (event.target === el) window.closeMobileMenu();
      });
      el.querySelectorAll('a').forEach(function (link) {
        link.addEventListener('click', function () {
          window.closeMobileMenu();
        });
      });
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && menu()?.classList.contains('open')) {
      window.closeMobileMenu();
    }
  });
})();
