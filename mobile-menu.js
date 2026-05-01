(function () {
  var previousBodyOverflow = '';
  var previousHtmlOverflow = '';

  function menu() {
    return document.getElementById('mobile-menu');
  }

  function buttons() {
    return Array.prototype.slice.call(document.querySelectorAll('#mobile-menu-btn, .hamburger-btn'));
  }

  function setButtonState(isOpen) {
    buttons().forEach(function (btn) {
      btn.classList.toggle('open', isOpen);
      btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
  }

  function syncMenuOffset() {
    var el = menu();
    if (!el) return;
    var bottom = 0;
    var nav = document.querySelector('#mhdr, #nav, header.nav, .nav');
    if (nav) {
      var navRect = nav.getBoundingClientRect();
      bottom = Math.max(bottom, navRect.bottom || 0);
    }
    var bar = document.getElementById('bar') || document.getElementById('m-bar');
    if (bar) {
      var barStyle = window.getComputedStyle(bar);
      var barRect = bar.getBoundingClientRect();
      if (barStyle.display !== 'none' && barStyle.visibility !== 'hidden' && barRect.height > 0) {
        bottom = Math.max(bottom, barRect.bottom || 0);
      }
    }
    el.style.setProperty('--zw-mobile-menu-offset', Math.max(0, Math.round(bottom)) + 'px');
  }

  function hasSharedScrollLock() {
    return !!(window.ZWModalScrollLock && typeof window.ZWModalScrollLock.refresh === 'function');
  }

  function lockScrollFallback() {
    previousBodyOverflow = document.body.style.overflow || '';
    previousHtmlOverflow = document.documentElement.style.overflow || '';
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
  }

  function unlockScrollFallback() {
    if (document.querySelector('.modal.open:not(#mobile-menu)')) return;
    document.body.style.overflow = previousBodyOverflow;
    document.documentElement.style.overflow = previousHtmlOverflow;
  }

  function syncScrollLock() {
    if (hasSharedScrollLock()) {
      window.ZWModalScrollLock.refresh();
      return;
    }

    if (menu() && menu().classList.contains('open')) {
      lockScrollFallback();
    } else {
      unlockScrollFallback();
    }
  }

  window.openMobileMenu = function openMobileMenu() {
    var el = menu();
    if (!el) return false;
    if (el.classList.contains('open')) return false;
    syncMenuOffset();
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    setButtonState(true);
    syncScrollLock();
    setTimeout(function () {
      var close = document.getElementById('mobile-menu-close');
      var btn = document.getElementById('mobile-menu-btn') || document.querySelector('.hamburger-btn');
      if (close && window.getComputedStyle(close).display !== 'none') close.focus({ preventScroll: true });
      else if (btn) btn.focus({ preventScroll: true });
    }, 0);
    return false;
  };

  window.closeMobileMenu = function closeMobileMenu() {
    var el = menu();
    if (!el) return false;
    if (!el.classList.contains('open')) return false;
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    setButtonState(false);
    syncScrollLock();
    return false;
  };

  window.toggleMobileMenu = function toggleMobileMenu() {
    var el = menu();
    if (!el) return false;
    return el.classList.contains('open') ? window.closeMobileMenu() : window.openMobileMenu();
  };

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('mobile-menu-btn');
    var close = document.getElementById('mobile-menu-close');
    var el = menu();

    if (el) el.setAttribute('aria-hidden', el.classList.contains('open') ? 'false' : 'true');
    if (btn) {
      btn.onclick = null;
      btn.removeAttribute('onclick');
      btn.setAttribute('aria-expanded', el && el.classList.contains('open') ? 'true' : 'false');
    }
    if (btn) btn.addEventListener('click', function (event) {
      event.preventDefault();
      window.toggleMobileMenu();
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

    syncScrollLock();
    syncMenuOffset();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && menu()?.classList.contains('open')) {
      window.closeMobileMenu();
    }
  });

  window.addEventListener('resize', syncMenuOffset, { passive: true });
  window.addEventListener('orientationchange', syncMenuOffset, { passive: true });
})();
