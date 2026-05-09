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
    document.body.classList.remove('zw-mobile-menu-open');
    document.documentElement.classList.remove('zw-mobile-menu-open');
    setButtonState(false);
    syncScrollLock();
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
    document.querySelectorAll('[data-history-back]').forEach(function (trigger) {
      trigger.addEventListener('click', goBackOrHome);
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
    if (event.key === 'Escape' && menu()?.classList.contains('open')) {
      window.closeMobileMenu();
    }
  });

  window.addEventListener('resize', syncMenuOffset, { passive: true });
  window.addEventListener('orientationchange', syncMenuOffset, { passive: true });
  window.addEventListener('storage', syncMenuBagCount);
  document.addEventListener('visibilitychange', syncMenuBagCount);
})();
