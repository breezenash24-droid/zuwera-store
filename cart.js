// ===================== SHARED MODAL HELPERS =====================
// Declared globally — consumed by cart.js, checkout.js, and auth.js

function _openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  // Defer to the centralized lock (it compensates the scrollbar so the page
  // doesn't shift sideways on open). Fallback: lock <html> (not <body>, which
  // becomes a scroll container and breaks position:sticky) and add the scrollbar
  // width as padding so the content never moves.
  if (window.ZWModalScrollLock) { window.ZWModalScrollLock.refresh(); return; }
  const r = document.documentElement;
  const gap = Math.max(0, window.innerWidth - r.clientWidth);
  r.style.overflow = 'hidden';
  if (gap > 0) r.style.paddingRight = `${gap}px`;
}

function _closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
  if (window.ZWModalScrollLock) { window.ZWModalScrollLock.refresh(); return; }
  document.documentElement.style.overflow = '';
  document.documentElement.style.paddingRight = '';
}

// ===================== TOAST =====================
let _toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  clearTimeout(_toastTimer);
  t.classList.add('on');
  _toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

// ===================== ANNOUNCEMENT BAR =====================
(function () {
  const bar      = document.getElementById('announcement-bar');
  const closeBtn = document.getElementById('announcement-close');
  if (!bar || !closeBtn) return;
  if (sessionStorage.getItem('bar-closed')) {
    bar.style.display = 'none';
  } else {
    document.body.classList.add('has-bar');
  }
  closeBtn.addEventListener('click', () => {
    bar.style.display = 'none';
    document.body.classList.remove('has-bar');
    sessionStorage.setItem('bar-closed', '1');
  });
})();

// ===================== CART STATE =====================
let cartItems = [];

// ── Cache cart DOM refs once (avoids repeated getElementById on every interaction) ──
const _cart = {
  modal:         document.getElementById('cart-modal'),
  closeBtn:      document.getElementById('cart-close'),
  cartBtn:       document.getElementById('cart-btn'),
  itemsList:     document.getElementById('cart-items-list'),
  emptyMsg:      document.getElementById('cart-empty-msg'),
  checkoutBtn:   document.getElementById('checkout-btn'),
  cartCount:     document.querySelector('.cart-count'),
  subtotalEl:    document.getElementById('summary-subtotal'),
  favJoinLink:   document.getElementById('fav-join-link'),
  favSigninLink: document.getElementById('fav-signin-link'),
};

// ===================== CART MODAL =====================
_cart.cartBtn?.addEventListener('click',  () => _openModal('cart-modal'));
_cart.closeBtn?.addEventListener('click', () => _closeModal('cart-modal'));

// Favorites links in cart → open auth modal
_cart.favJoinLink?.addEventListener('click', () => {
  _closeModal('cart-modal');
  openAuthModal('signup');
});
_cart.favSigninLink?.addEventListener('click', () => {
  _closeModal('cart-modal');
  openAuthModal('signin');
});

// ===================== CHECKOUT BUTTON =====================
_cart.checkoutBtn?.addEventListener('click', () => {
  _closeModal('cart-modal');
  _openModal('payment-modal');
  const _payErr = document.getElementById('pay-error');
  if (_payErr) _payErr.textContent = '';

  const subtotalText  = _cart.subtotalEl?.textContent?.replace(/[^0-9.]/g, '') || '0';
  const subtotalCents = Math.round(parseFloat(subtotalText) * 100) || 100;
  initPaymentRequest(subtotalCents);
});
