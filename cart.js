// ===================== SHARED MODAL HELPERS =====================
// Declared globally — consumed by cart.js, checkout.js, and auth.js

function _openModal(id) {
  document.getElementById(id).classList.add('open');
  document.body.style.overflow = 'hidden';
}

function _closeModal(id) {
  document.getElementById(id).classList.remove('open');
  document.body.style.overflow = '';
}

// ===================== TOAST =====================
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ===================== ANNOUNCEMENT BAR =====================
(function () {
  const bar      = document.getElementById('announcement-bar');
  const closeBtn = document.getElementById('announcement-close');
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
_cart.cartBtn.addEventListener('click',  () => _openModal('cart-modal'));
_cart.closeBtn.addEventListener('click', () => _closeModal('cart-modal'));

// Favorites links in cart → open auth modal
_cart.favJoinLink.addEventListener('click', () => {
  _closeModal('cart-modal');
  openAuthModal('signup');
});
_cart.favSigninLink.addEventListener('click', () => {
  _closeModal('cart-modal');
  openAuthModal('signin');
});

// ===================== CHECKOUT BUTTON =====================
_cart.checkoutBtn.addEventListener('click', () => {
  _closeModal('cart-modal');
  _openModal('payment-modal');
  document.getElementById('pay-error').textContent = '';

  const subtotalText  = _cart.subtotalEl?.textContent?.replace(/[^0-9.]/g, '') || '0';
  const subtotalCents = Math.round(parseFloat(subtotalText) * 100) || 100;
  initPaymentRequest(subtotalCents);
});
