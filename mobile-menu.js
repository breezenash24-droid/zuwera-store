(function () {
  var HOME_URL = '/';
  var previousBodyOverflow = '';
  var previousHtmlOverflow = '';
  var previousBodyPosition = '';
  var previousBodyTop = '';
  var previousBodyLeft = '';
  var previousBodyRight = '';
  var previousBodyWidth = '';
  var previousBodyOverscroll = '';
  var previousHtmlOverscroll = '';
  var lockedScrollY = 0;

  // Stop history-driven scroll restoration from fighting our manual restore.
  // Opening the menu pushState()s a history entry while the body is locked at
  // the top (position:fixed → document scroll snaps to 0), so the browser
  // records scrollY=0 for that entry. Closing calls history.back(), and with
  // the default 'auto' restoration the browser snaps the page back to that
  // recorded 0 — overriding the scroll-lock's scrollTo(savedY) and jumping you
  // to the very top. 'manual' hands restoration to us; we flip back to 'auto'
  // on pagehide so normal cross-page back/forward still restores scroll.
  // (drop001 already did this locally; doing it here fixes every page at once.)
  try {
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
      window.addEventListener('pagehide', function () {
        try { window.history.scrollRestoration = 'auto'; } catch (_) {}
      });
    }
  } catch (_) {}

  function menu() {
    return document.getElementById('mobile-menu');
  }

  function buttons() {
    return Array.prototype.slice.call(document.querySelectorAll('#mobile-menu-btn, .hamburger-btn'));
  }

  function goBackOrHome(event) {
    if (event) event.preventDefault();
    if (window.history && window.history.length > 1) {
      window.history.back();
      return false;
    }
    window.location.assign(HOME_URL);
    return false;
  }

  function setButtonState(isOpen) {
    buttons().forEach(function (btn) {
      btn.classList.toggle('open', isOpen);
      btn.classList.toggle('is-active', isOpen);
      btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      btn.setAttribute('aria-label', isOpen ? 'Close menu' : 'Menu');
    });
  }

  function cartCount() {
    try {
      var cart = JSON.parse(localStorage.getItem('cart') || '[]');
      if (!Array.isArray(cart)) return 0;
      return cart.reduce(function (sum, item) {
        return sum + (Number(item && item.quantity) || 0);
      }, 0);
    } catch (_) {
      return 0;
    }
  }

  function syncMenuBagCount() {
    var count = String(cartCount());
    document.querySelectorAll('.zw-mobile-bag-count').forEach(function (el) {
      el.textContent = count;
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
    previousBodyPosition = document.body.style.position || '';
    previousBodyTop = document.body.style.top || '';
    previousBodyLeft = document.body.style.left || '';
    previousBodyRight = document.body.style.right || '';
    previousBodyWidth = document.body.style.width || '';
    previousBodyOverscroll = document.body.style.overscrollBehavior || '';
    previousHtmlOverscroll = document.documentElement.style.overscrollBehavior || '';
    lockedScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = '-' + lockedScrollY + 'px';
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
    document.body.style.overscrollBehavior = 'none';
    document.documentElement.style.overscrollBehavior = 'none';
  }

  function unlockScrollFallback() {
    if (document.querySelector('.modal.open:not(#mobile-menu)')) return;
    document.body.style.overflow = previousBodyOverflow;
    document.documentElement.style.overflow = previousHtmlOverflow;
    document.body.style.position = previousBodyPosition;
    document.body.style.top = previousBodyTop;
    document.body.style.left = previousBodyLeft;
    document.body.style.right = previousBodyRight;
    document.body.style.width = previousBodyWidth;
    document.body.style.overscrollBehavior = previousBodyOverscroll;
    document.documentElement.style.overscrollBehavior = previousHtmlOverscroll;
    window.scrollTo(0, lockedScrollY || 0);
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
    syncMenuBagCount();
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('zw-mobile-menu-open');
    document.documentElement.classList.add('zw-mobile-menu-open');
    setButtonState(true);
    syncScrollLock();
    if (window.history && window.history.pushState) {
      window.history.pushState({ zwMenu: true }, '');
    }
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
    el.classList.add('closing');
    el.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('zw-mobile-menu-open');
    document.documentElement.classList.remove('zw-mobile-menu-open');
    setButtonState(false);
    var panel = el.querySelector('.zw-mobile-menu-panel');
    var done = false;
    function finish() {
      if (done) return; done = true;
      el.classList.remove('closing');
      syncScrollLock();
      if (window.history.state && window.history.state.zwMenu) {
        window.history.back();
      }
    }
    if (panel) panel.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, 400);
    return false;
  };

  window.toggleMobileMenu = function toggleMobileMenu() {
    var el = menu();
    if (!el) return false;
    return el.classList.contains('open') ? window.closeMobileMenu() : window.openMobileMenu();
  };

  window.ZuweraNavHistory = window.ZuweraNavHistory || {};
  window.ZuweraNavHistory.goBackOrHome = goBackOrHome;

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('mobile-menu-btn');
    var close = document.getElementById('mobile-menu-close');
    var el = menu();

    if (el) {
      var isOpen = el.classList.contains('open');
      el.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
      document.body.classList.toggle('zw-mobile-menu-open', isOpen);
      document.documentElement.classList.toggle('zw-mobile-menu-open', isOpen);
    }
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

    // Swipe down to dismiss, like every other sheet on the site. zwAttachSwipeClose
    // (storefront-features.js) fires closeBtn.click() when you drag the scroller down
    // >80px while it's scrolled to the top — so it never fights a scrolling list. The
    // panel is the scroller (overflow-y:auto). Guarded: the helper only exists once
    // storefront-features has loaded, and this runs at DOMContentLoaded after it.
    var panel = el && el.querySelector('.zw-mobile-menu-panel');
    if (panel && close && window.zwAttachSwipeClose) {
      window.zwAttachSwipeClose(panel, close);
    }
    document.querySelectorAll('[data-history-back]').forEach(function (trigger) {
      trigger.addEventListener('click', goBackOrHome);
    });
    window.addEventListener('popstate', function () {
      var el = menu();
      if (el && el.classList.contains('open')) {
        window.closeMobileMenu();
      }
    });
    if (el) {
      el.addEventListener('click', function (event) {
        if (event.target === el) {
          window.closeMobileMenu();
          return;
        }
        if (event.target.closest && event.target.closest('a')) window.closeMobileMenu();
      });
    }

    syncScrollLock();
    syncMenuOffset();
    syncMenuBagCount();
  });

  document.addEventListener('keydown', function (event) {
    var el = menu();
    if (!el || !el.classList.contains('open')) return;

    if (event.key === 'Escape') {
      window.closeMobileMenu();
      var btn = document.getElementById('mobile-menu-btn') || document.querySelector('.hamburger-btn');
      if (btn) btn.focus({ preventScroll: true });
      return;
    }

    if (event.key === 'Tab') {
      var focusable = Array.prototype.slice.call(
        el.querySelectorAll('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])')
      ).filter(function (node) {
        return window.getComputedStyle(node).display !== 'none';
      });
      if (focusable.length === 0) { event.preventDefault(); return; }
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey) {
        if (document.activeElement === first) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else {
        if (document.activeElement === last) {
          event.preventDefault();
          first.focus({ preventScroll: true });
        }
      }
    }
  });

  window.addEventListener('resize', syncMenuOffset, { passive: true });
  window.addEventListener('orientationchange', syncMenuOffset, { passive: true });
  window.addEventListener('storage', syncMenuBagCount);
  document.addEventListener('visibilitychange', syncMenuBagCount);
})();
