(() => {
  if (window.ZWModalScrollLock) return;

  const TRACKED_SELECTORS = [
    '.modal',
    '[role="dialog"]',
    '#payment-success',
    '#apple-pay-qr-modal'
  ].join(',');

  let locked = false;
  let lockedScrollY = 0;

  function isVisibleOverlay(el) {
    if (!el || !el.isConnected) return false;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function hasActiveOverlay() {
    const candidates = document.querySelectorAll(TRACKED_SELECTORS);
    for (const el of candidates) {
      if (isVisibleOverlay(el)) return true;
    }
    return false;
  }

  function lockScroll() {
    if (locked || !document.body) return;

    locked = true;
    lockedScrollY = window.scrollY || window.pageYOffset || 0;

    const root = document.documentElement;
    const body = document.body;
    const scrollbarGap = Math.max(0, window.innerWidth - root.clientWidth);

    root.dataset.scrollLocked = 'true';
    body.dataset.scrollLocked = 'true';

    root.style.overflow = 'hidden';
    root.style.overscrollBehavior = 'none';

    body.style.position = 'fixed';
    body.style.setProperty('top', `-${lockedScrollY}px`, 'important');
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    body.style.overscrollBehavior = 'none';

    if (scrollbarGap > 0) {
      body.style.paddingRight = `${scrollbarGap}px`;
    }
  }

  function unlockScroll() {
    if (!locked || !document.body) return;

    locked = false;

    const root = document.documentElement;
    const body = document.body;
    const restoreY = lockedScrollY;

    delete root.dataset.scrollLocked;
    delete body.dataset.scrollLocked;

    root.style.overflow = '';
    root.style.overscrollBehavior = '';

    // Disable smooth-scroll momentarily so the position restore is instant,
    // not an animated scroll from 0 → restoreY (which causes the visible "jump to top").
    const prevScrollBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';

    body.style.position = '';
    body.style.removeProperty('top');
    body.style.left = '';
    body.style.right = '';
    body.style.width = '';
    body.style.overflow = '';
    body.style.overscrollBehavior = '';
    body.style.paddingRight = '';

    try {
      window.scrollTo({ top: restoreY, left: 0, behavior: 'instant' });
    } catch (_) {
      window.scrollTo(0, restoreY);
    }

    // Restore scroll-behavior after the browser has painted
    requestAnimationFrame(() => {
      root.style.scrollBehavior = prevScrollBehavior;
    });
  }

  function refresh() {
    if (hasActiveOverlay()) {
      lockScroll();
    } else {
      unlockScroll();
    }
  }

  let refreshQueued = false;
  function queueRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    window.requestAnimationFrame(() => {
      refreshQueued = false;
      refresh();
    });
  }

  function init() {
    refresh();

    const observer = new MutationObserver(queueRefresh);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden']
    });

    window.addEventListener('pageshow', queueRefresh, { passive: true });
    window.addEventListener('resize', queueRefresh, { passive: true });
    window.addEventListener('orientationchange', queueRefresh, { passive: true });
  }

  window.ZWModalScrollLock = { refresh };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
