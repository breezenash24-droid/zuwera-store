(() => {
  if (window.ZWModalScrollLock) return;

  const TRACKED_SELECTORS = [
    '.modal',
    '[role="dialog"]:not(#zw-lang-modal)',
    '#payment-success',
    '#apple-pay-qr-modal',
    '#mobile-menu.open'
  ].join(',');

  let locked = false;
  let lockedScrollY = 0;
  let lockUsedFixed = false;
  let previousRootScrollBehavior = '';
  let previousBodyScrollBehavior = '';

  function isVisibleOverlay(el) {
    if (!el || !el.isConnected) return false;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    // A closing modal fades out via CSS. storefront-cohesion.css hides modals
    // with `visibility:hidden` on a TRANSITION DELAY (visibility 0s linear
    // <dur>), so right after `.open` is removed `visibility` still computes to
    // `visible` for the whole fade — and the eventual flip to hidden is a
    // transition, not a DOM mutation, so the observer never re-checks and the
    // page stays scroll-locked. `pointer-events` flips to `none` immediately
    // when `.open` is removed, so treat a non-interactive overlay as closed.
    if (style.pointerEvents === 'none') return false;

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
    // Content width before the scrollbar is hidden. We compare the body's width
    // *after* locking against this to add back exactly what the page lost. With
    // html{scrollbar-gutter:stable} the gutter stays reserved, so the width is
    // unchanged and this resolves to 0 (no double-compensation); on browsers
    // without scrollbar-gutter it resolves to the scrollbar width. Measuring the
    // real boxes means the page never shifts sideways either way.
    const clientWidthBefore = root.clientWidth;
    // Width of the (always-present, html{overflow-y:scroll}) scrollbar that
    // overflow:hidden is about to remove. Exposed so fixed full-width bars can
    // pad their right edge back by it (flow content is compensated below).
    root.style.setProperty('--zw-lock-gap', `${Math.max(0, window.innerWidth - clientWidthBefore)}px`);
    previousRootScrollBehavior = root.style.scrollBehavior || '';
    previousBodyScrollBehavior = body.style.scrollBehavior || '';

    root.dataset.scrollLocked = 'true';
    body.dataset.scrollLocked = 'true';

    root.style.overflow = 'hidden';
    root.style.overscrollBehavior = 'none';
    root.style.scrollBehavior = 'auto';

    // Desktop locks with overflow ONLY. body{position:fixed} breaks
    // position:sticky (the product image gallery jumped out of place every time
    // a modal opened, and the page lost the sticky-follow that filled the column).
    // overflow:hidden already freezes the scroll in place on desktop and leaves
    // sticky intact. Mobile/iOS still needs position:fixed — overflow:hidden does
    // not stop iOS touch-scrolling behind the modal — and the <=1024px layouts
    // are single-column with no sticky, so nothing breaks there.
    lockUsedFixed = window.matchMedia('(max-width: 1024px)').matches;

    if (lockUsedFixed) {
      // Signal that a scroll position snap is about to happen (body→fixed snaps to 0)
      window.__zwScrollLocking = true;
      body.style.position = 'fixed';
      body.style.setProperty('top', `-${lockedScrollY}px`, 'important');
      body.style.left = '0';
      body.style.right = '0';
      body.style.width = '100%';
      body.style.overflow = 'hidden';
      body.style.overscrollBehavior = 'none';
      body.style.scrollBehavior = 'auto';

      const scrollbarGap = Math.max(0, body.clientWidth - clientWidthBefore);
      if (scrollbarGap > 0) {
        body.style.paddingRight = `${scrollbarGap}px`;
      }

      // Clear locking flag after paint — any scroll event during this frame is suppressed
      requestAnimationFrame(() => { window.__zwScrollLocking = false; });
    } else {
      // Desktop: lock the page on <html> ONLY (set above). Do NOT also set
      // overflow:hidden on <body> — that turns body into a scroll container, and
      // position:sticky then resolves against body (whose scrollTop is 0, since
      // the page scrolls on <html>), which un-sticks and SHIFTS the product
      // gallery on modal open. Locking html alone freezes the page while sticky
      // keeps resolving against the viewport, so the gallery stays put.
      // Compensate the removed scrollbar so flow content doesn't shift sideways:
      // pad <html> by the width the scrollbar occupied (html{overflow-y:scroll}
      // keeps it present, so this is the real ~15px). Fixed bars are handled
      // separately via --zw-lock-gap in the CSS above.
      const scrollbarGap = Math.max(0, root.clientWidth - clientWidthBefore);
      if (scrollbarGap > 0) {
        root.style.paddingRight = `${scrollbarGap}px`;
      }
    }
  }

  function unlockScroll() {
    if (!document.body) return;

    const root = document.documentElement;
    const body = document.body;
    const wasLocked = locked;
    const restoreY = lockedScrollY;

    // Always clear the lock styles when asked to unlock — even if `locked` is
    // already false. Three different mechanisms can pin the body (this module,
    // the base.css :has(.modal.open) rule, and inline body.style.overflow in
    // the page handlers); a desynced `locked` flag must never be able to strand
    // body{position:fixed}/overflow:hidden, which body.style.overflow='' alone
    // cannot undo and which leaves the page scroll-frozen (clicks still work).
    locked = false;

    delete root.dataset.scrollLocked;
    delete body.dataset.scrollLocked;

    root.style.overflow = '';
    root.style.overscrollBehavior = '';
    root.style.removeProperty('--zw-lock-gap');
    root.style.paddingRight = '';
    // Disable smooth-scroll momentarily so the position restore is instant,
    // not an animated scroll from 0 → restoreY (the visible "jump to top").
    root.style.scrollBehavior = 'auto';

    body.style.position = '';
    body.style.removeProperty('top');
    body.style.left = '';
    body.style.right = '';
    body.style.width = '';
    body.style.overflow = '';
    body.style.overscrollBehavior = '';
    body.style.scrollBehavior = previousBodyScrollBehavior;
    body.style.paddingRight = '';

    // Only the fixed path moved the document scroll (body→fixed snaps to 0); the
    // desktop overflow path froze it in place, so there's nothing to restore there.
    if (wasLocked && lockUsedFixed) {
      // Signal restore BEFORE scrollTo so scroll handlers ignore the programmatic jump
      window.__zwScrollRestoring = true;
      try {
        window.scrollTo({ top: restoreY, left: 0, behavior: 'instant' });
      } catch (_) {
        window.scrollTo(0, restoreY);
      }
    }

    // Restore scroll-behavior and clear flag after the browser has painted
    requestAnimationFrame(() => {
      root.style.scrollBehavior = previousRootScrollBehavior;
      window.__zwScrollRestoring = false;
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
