// ===================== SUPABASE AUTH =====================
// Note: SUPABASE_URL and SUPABASE_ANON are intentionally NOT declared as top-level
// consts here — some pages (product.html) declare them as consts too, which would
// cause a SyntaxError and crash all of auth.js on those pages.
window.sb = window.sb || ((typeof supabase !== 'undefined')
  ? supabase.createClient(
      'https://qfgnrsifcwdubkolsgsq.supabase.co',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY',
      {
      auth: { persistSession: true, storageKey: 'zuwera-auth', flowType: 'implicit' },
      global: { headers: { 'X-Client-Info': 'zuwera-store' } }
    })
  : null);
const _sb = window.sb;

let _currentUser   = null;
let _userFavorites = []; // full objects: { product_id, product_name, price }
let _authReturnModalId = null;
const _favoriteProductCache = new Map();

// ── Shorthand helpers ──────────────────────────────────────────────
const $  = id => document.getElementById(id);

// Disable/re-enable a button with a loading label
function setBtn(id, loading, defaultLabel) {
  const btn = $(id);
  btn.disabled    = loading;
  btn.textContent = loading ? defaultLabel.replace(/.$/, '…') : defaultLabel;
  return btn;
}

// ── Safe global helpers ────────────────────────────────────────────
window._openModal = window._openModal || function(id) {
  const m = document.getElementById(id);
  if (m) { m.classList.add('open'); document.body.style.overflow = 'hidden'; document.documentElement.style.overflow = 'hidden'; }
};
window._closeModal = window._closeModal || function(id) {
  const m = document.getElementById(id);
  if (m) {
    m.classList.remove('open');
    if (!document.querySelector('.modal.open')) {
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
    }
  }
};
window.togglePwd = window.togglePwd || function(id, btn) {
  const inp = document.getElementById(id);
  if (!inp) return;
  if (inp.type === 'password') {
    inp.type = 'text';
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
  } else {
    inp.type = 'password';
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  }
};

// ── Cache header auth elements (updated on every auth state change) ──
const _authEls = {
  loginBtn:   $('login-btn'),
  accountBtn: $('account-btn'),
  logoutBtn:  $('logout-btn'),
};

// ── Auth state listener ────────────────────────────────────────────
if (_sb) {
  _sb.auth.onAuthStateChange((event, session) => {
    _currentUser = session?.user ?? null;

    updateHeaderForAuth();
    if (event === 'PASSWORD_RECOVERY') {
      openAuthModal('update-password');
    }
    if (_currentUser) {
      void loadFavorites();
      const expectedUserId = _currentUser.id;
      setTimeout(async () => {
        try {
          const { data, error } = await _sb.auth.getUser();
          // Only sign out if we definitively confirm a DIFFERENT user — never on errors
          if (!error && data?.user && data.user.id !== expectedUserId) {
            await _sb.auth.signOut().catch(() => {});
            _currentUser = null;
            updateHeaderForAuth();
            _userFavorites = [];
            refreshHeartButtons();
            refreshCartFavs();
          }
        } catch (_) {}
      }, 0);
    } else {
      _userFavorites = [];
      refreshHeartButtons();
      refreshCartFavs();
    }
  });
}

if (_sb?.auth?.getSession) {
  _sb.auth.getSession()
    .then(({ data }) => {
      _currentUser = data?.session?.user ?? null;
      updateHeaderForAuth();
      if (_currentUser) {
        void loadFavorites();
      } else {
        _userFavorites = [];
        refreshHeartButtons();
        refreshCartFavs();
      }
    })
    .catch(() => {
      updateHeaderForAuth();
      refreshCartFavs();
    });
}

function updateHeaderForAuth() {
  const loggedIn = !!_currentUser;
  if (_authEls.loginBtn)   _authEls.loginBtn.style.display   = loggedIn ? 'none' : 'inline-flex';
  if (_authEls.accountBtn) {
    _authEls.accountBtn.style.display = loggedIn ? 'inline-flex' : 'none';
    if (loggedIn) {
      const name = _currentUser.user_metadata?.full_name || _currentUser.email.split('@')[0];
      _authEls.accountBtn.textContent = name.split(' ')[0];
    }
  }
  if (_authEls.logoutBtn)  _authEls.logoutBtn.style.display  = loggedIn ? 'inline-flex' : 'none';
}

// ── Auth Modal ─────────────────────────────────────────────────────
function openAuthModal(tab) {
  const cart = document.getElementById('cart-modal');
  _authReturnModalId = cart?.classList.contains('open') ? 'cart-modal' : null;
  if (cart?.classList.contains('open')) {
    cart.classList.remove('open');
  }
  _openModal('auth-modal');
  switchAuthTab(tab || 'signin');
}
function closeAuthModal() {
  _closeModal('auth-modal');
  if (_authReturnModalId) {
    const returnModal = document.getElementById(_authReturnModalId);
    const returnId = _authReturnModalId;
    _authReturnModalId = null;
    if (returnModal) {
      returnModal.classList.add('open');
      document.body.style.overflow = 'hidden';
      if (returnId === 'cart-modal') {
        if (typeof window.renderProductCartItems === 'function') window.renderProductCartItems();
        if (typeof renderCart === 'function') renderCart();
      }
    }
  }
}
function switchAuthTab(tab) {
  document.querySelectorAll('#auth-modal .auth-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('#auth-modal .auth-panel').forEach(p => p.classList.remove('active'));
  $('panel-' + tab)?.classList.add('active');
  ['signin-error', 'signup-error', 'forgot-error', 'update-password-error'].forEach(id => {
    const el = $(id);
    if (el) el.textContent = '';
  });
  const fs = $('forgot-success');
  if (fs) fs.style.display = 'none';
  const ss = $('signup-success');
  if (ss) { ss.style.display = 'none'; $('signup-submit').style.display = 'block'; }
}

document.querySelectorAll('#auth-modal .auth-tab').forEach(btn => {
  btn.addEventListener('click', () => switchAuthTab(btn.dataset.tab));
});
$('auth-modal-close').addEventListener('click', closeAuthModal);
$('auth-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeAuthModal(); });
_authEls.loginBtn.addEventListener('click', () => openAuthModal('signin'));
$('forgot-link').addEventListener('click', e => { e.preventDefault(); switchAuthTab('forgot'); });
$('back-to-signin').addEventListener('click', e => { e.preventDefault(); switchAuthTab('signin'); });

// ── Cloudflare Turnstile Helper ────────────────────────────────────
const ZW_TS_KEY = '0x4AAAAAACzvvg-l2dT2z35l';
let _zwTsWidgetId = null;
let _zwTsPendingCb = null;

// Called by Turnstile on success
window._zwTsSuccess = function(token) {
  if (_zwTsPendingCb) {
    const cb = _zwTsPendingCb;
    _zwTsPendingCb = null;
    cb(token);
  }
};

// Called by Turnstile on error/expiry — fail open so UX is not broken
window._zwTsError = function() {
  if (_zwTsPendingCb) {
    const cb = _zwTsPendingCb;
    _zwTsPendingCb = null;
    cb(null); // proceed without token
  }
};

// Initialize the invisible widget once Turnstile SDK loads
function _zwInitTurnstile() {
  const el = document.getElementById('zw-ts-widget');
  if (!el || !window.turnstile || _zwTsWidgetId !== null) return;
  _zwTsWidgetId = window.turnstile.render(el, {
    sitekey: ZW_TS_KEY,
    size: 'invisible',
    callback: '_zwTsSuccess',
    'error-callback': '_zwTsError',
    'expired-callback': function() {
      if (_zwTsWidgetId !== null) window.turnstile.reset(_zwTsWidgetId);
    }
  });
}

// Retry init if SDK loads asynchronously
window._zwTsLoad = function() { _zwInitTurnstile(); };
document.addEventListener('DOMContentLoaded', function() {
  // Try after small delay in case SDK script is still loading
  setTimeout(_zwInitTurnstile, 800);
});

function _zwWaitForTurnstile(timeoutMs = 2500) {
  _zwInitTurnstile();
  if (_zwTsWidgetId !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const started = Date.now();
    const tick = () => {
      _zwInitTurnstile();
      if (_zwTsWidgetId !== null) { resolve(true); return; }
      if (Date.now() - started >= timeoutMs) { resolve(false); return; }
      setTimeout(tick, 50);
    };
    tick();
  });
}

// Verify token server-side and execute action
async function zwRunTurnstile(action) {
  await _zwWaitForTurnstile();
  if (!window.turnstile || _zwTsWidgetId === null) {
    // Turnstile not available — fail open
    await action(null);
    return;
  }
  let settled = false;
  const finish = async (token) => {
    if (settled) return;
    settled = true;
    _zwTsPendingCb = null;
    await action(token);
    if (_zwTsWidgetId !== null) window.turnstile.reset(_zwTsWidgetId);
  };
  _zwTsPendingCb = async (token) => {
    if (token) {
      try {
        const res = await fetch('/api/verify-turnstile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        const data = await res.json();
        if (!data.success) {
          console.warn('[Turnstile] Server rejected token:', data.error);
          // Fail open — don't block legitimate users if server has issues
        }
      } catch(e) {
        console.warn('[Turnstile] Verify error:', e);
      }
    }
    await finish(token);
  };
  try {
    window.turnstile.execute(_zwTsWidgetId);
  } catch (e) {
    console.warn('[Turnstile] Execute error:', e);
    await finish(null);
    return;
  }
  setTimeout(() => { void finish(null); }, 4500);
}

// ── Sign In ────────────────────────────────────────────────────────
$('signin-submit').addEventListener('click', async () => {
  const email = $('signin-email').value.trim();
  const pass  = $('signin-password').value;
  const err   = $('signin-error');
  err.textContent = '';
  if (!email || !pass) { err.textContent = 'Please fill in all fields.'; return; }
  setBtn('signin-submit', true, 'Login');

  await zwRunTurnstile(async (captchaToken) => {
    if (_sb) {
      const signInOpts = captchaToken ? { captchaToken } : {};
      const { error } = await _sb.auth.signInWithPassword({ email, password: pass, options: signInOpts });
      if (error) {
        err.textContent = error.message === 'Email not confirmed' ? 'Please check your email and verify your account first.' : error.message;
        setBtn('signin-submit', false, 'Login');
        return;
      }
    }
    setBtn('signin-submit', false, 'Login');
    closeAuthModal();
    showToast('Welcome back!');
  });
});

// ── Sign Up ────────────────────────────────────────────────────────
$('signup-submit').addEventListener('click', async () => {
  const name  = $('signup-name').value.trim();
  const email = $('signup-email').value.trim();
  const pass  = $('signup-password').value;
  const err   = $('signup-error');
  const suc   = $('signup-success');
  err.textContent = '';
  if (suc) suc.style.display = 'none';
  if (!name || !email || !pass) { err.textContent = 'Please fill in all fields.'; return; }
  if (pass.length < 6)         { err.textContent = 'Password must be at least 6 characters.'; return; }
  setBtn('signup-submit', true, 'Create Account');

  await zwRunTurnstile(async (captchaToken) => {
    if (_sb) {
      const signUpOpts = { data: { full_name: name }, emailRedirectTo: 'https://zuwera.store/confirm.html' };
      if (captchaToken) signUpOpts.captchaToken = captchaToken;
      const { data, error } = await _sb.auth.signUp({ email, password: pass, options: signUpOpts });
      if (error) {
        err.textContent = error.message;
        setBtn('signup-submit', false, 'Create Account'); return;
      }
      setBtn('signup-submit', false, 'Create Account');
      if (typeof gtag === 'function') gtag('event', 'sign_up', { method: 'Email' });

      if (!data?.session) {
        if (suc) suc.style.display = 'block';
        $('signup-submit').style.display = 'none';
      } else {
        closeAuthModal();
        showToast('Account created! Welcome to Zuwera.');
      }
    }
  });
});

// ── Forgot Password ────────────────────────────────────────────────
$('forgot-submit').addEventListener('click', async () => {
  const email = $('forgot-email').value.trim();
  const err   = $('forgot-error');
  const suc   = $('forgot-success');
  err.textContent = '';
  suc.style.display = 'none';
  if (!email) { err.textContent = 'Please enter your email.'; return; }
  setBtn('forgot-submit', true, 'Send Reset Link');
  await zwRunTurnstile(async (captchaToken) => {
    if (_sb) {
      const resetOpts = { redirectTo: 'https://zuwera.store/confirm.html' };
      if (captchaToken) resetOpts.captchaToken = captchaToken;
      const { error } = await _sb.auth.resetPasswordForEmail(email, resetOpts);
      if (error) { err.textContent = error.message; setBtn('forgot-submit', false, 'Send Reset Link'); return; }
    }
    setBtn('forgot-submit', false, 'Send Reset Link');
    suc.style.display = 'block';
  });
});

// ── Update Password ────────────────────────────────────────────────
const updatePassBtn = $('update-password-submit');
if (updatePassBtn) {
  updatePassBtn.addEventListener('click', async () => {
    const pass = $('update-password-input').value;
    const err = $('update-password-error');
    err.textContent = '';
    if (pass.length < 6) { err.textContent = 'Password must be at least 6 characters.'; return; }
    setBtn('update-password-submit', true, 'Updating');
    if (_sb) { const { error } = await _sb.auth.updateUser({ password: pass }); if (error) { err.textContent = error.message; setBtn('update-password-submit', false, 'Update Password'); return; } }
    setBtn('update-password-submit', false, 'Update Password');
    closeAuthModal(); showToast('Password updated successfully!');
  });
}

// ── Logout ─────────────────────────────────────────────────────────
_authEls.logoutBtn.addEventListener('click', async () => {
  if (_sb) {
    // scope:'global' revokes the refresh token server-side so the session
    // cannot be silently re-established on the next page load.
    await _sb.auth.signOut({ scope: 'global' }).catch(()=>{});
    localStorage.removeItem('zuwera-auth');
  }
  showToast('Signed out.');
  _currentUser = null;
  updateHeaderForAuth();
});

// ── Account Modal ──────────────────────────────────────────────────
_authEls.accountBtn.addEventListener('click', () => {
  _openModal('account-modal');
  switchAcctTab('orders');
  loadOrderHistory();
  // Reset danger zone each time modal opens
  const conf = $('acct-delete-confirm');
  if (conf) conf.style.display = 'none';
  const err = $('acct-delete-error');
  if (err) err.textContent = '';
});
$('account-modal-close').addEventListener('click', () => _closeModal('account-modal'));
$('account-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) _closeModal('account-modal');
});

// ── Delete Account ─────────────────────────────────────────────────
const _zwDeleteBtn        = $('acct-delete-btn');
const _zwDeleteConfirmBox = $('acct-delete-confirm');
const _zwDeleteConfirmBtn = $('acct-delete-confirm-btn');
const _zwDeleteCancelBtn  = $('acct-delete-cancel-btn');
const _zwDeleteErr        = $('acct-delete-error');

if (_zwDeleteBtn) {
  _zwDeleteBtn.addEventListener('click', () => {
    if (_zwDeleteConfirmBox) _zwDeleteConfirmBox.style.display = 'block';
    _zwDeleteBtn.style.display = 'none';
  });
}
if (_zwDeleteCancelBtn) {
  _zwDeleteCancelBtn.addEventListener('click', () => {
    if (_zwDeleteConfirmBox) _zwDeleteConfirmBox.style.display = 'none';
    if (_zwDeleteBtn) _zwDeleteBtn.style.display = 'block';
    if (_zwDeleteErr) _zwDeleteErr.textContent = '';
  });
}
if (_zwDeleteConfirmBtn) {
  _zwDeleteConfirmBtn.addEventListener('click', async () => {
    if (!_sb) return;
    _zwDeleteConfirmBtn.disabled = true;
    _zwDeleteConfirmBtn.textContent = 'Deleting…';
    if (_zwDeleteErr) _zwDeleteErr.textContent = '';

    try {
      const { data: { session } } = await _sb.auth.getSession();
      if (!session) throw new Error('Not signed in.');

      const res = await fetch(
        'https://qfgnrsifcwdubkolsgsq.supabase.co/functions/v1/delete-account',
        {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + session.access_token,
            'Content-Type': 'application/json'
          }
        }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Deletion failed.');

      // Sign out locally and go home
      await _sb.auth.signOut().catch(() => {});
      localStorage.removeItem('zuwera-auth');
      _closeModal('account-modal');
      showToast('Your account has been deleted.');
      _currentUser = null;
      updateHeaderForAuth();
    } catch (e) {
      if (_zwDeleteErr) _zwDeleteErr.textContent = e.message;
      _zwDeleteConfirmBtn.disabled = false;
      _zwDeleteConfirmBtn.textContent = 'Yes, delete my account';
    }
  });
}

function switchAcctTab(tab) {
  document.querySelectorAll('#account-modal .auth-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.acctab === tab);
  });
  document.querySelectorAll('#account-modal .auth-panel').forEach(p => p.classList.remove('active'));
  $('acct-panel-' + tab)?.classList.add('active');
}
document.querySelectorAll('#account-modal .auth-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    switchAcctTab(btn.dataset.acctab);
    if (btn.dataset.acctab === 'orders')    loadOrderHistory();
    if (btn.dataset.acctab === 'favorites') loadAcctFavs();
  });
});

async function loadOrderHistory() {
  if (!_sb || !_currentUser) return;
  const loading = $('orders-loading');
  const empty   = $('orders-empty');
  const list    = $('orders-list');
  if (!loading || !list) return;
  loading.style.display = 'block'; empty.style.display = 'none'; list.innerHTML = '';
  const { data, error } = await _sb
    .from('orders')
    .select('id, created_at, status')   // only fetch columns we actually use
    .eq('user_id', _currentUser.id)
    .order('created_at', { ascending: false });
  loading.style.display = 'none';
  if (error || !data?.length) { empty.style.display = 'block'; return; }
  list.innerHTML = data.map(order => `
    <div style="padding:1rem 0;border-bottom:1px solid rgba(245,245,240,0.08);">
      <div style="font-family:'Bebas Neue',sans-serif;letter-spacing:0.1em;">Order #${order.id?.slice(-8).toUpperCase()}</div>
      <div style="font-size:0.78rem;opacity:0.45;margin-top:0.2rem;">${new Date(order.created_at).toLocaleDateString()}</div>
      <div style="font-size:0.78rem;opacity:0.6;margin-top:0.3rem;">${order.status || 'Confirmed'}</div>
    </div>
  `).join('');
}

function escapeFavoriteHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function favoriteSlug(value) {
  return String(value || 'product')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'product';
}

function favoriteHref(productId, productName) {
  const slug = favoriteSlug(productName);
  return `/product/${slug}?id=${encodeURIComponent(productId)}`;
}

function favoriteNumericPrice(value) {
  if (typeof value === 'string') {
    const parsed = parseFloat(value.replace(/[^0-9.]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return parseFloat(value ?? 0) || 0;
}

function favoriteEffectivePrice(detail, fallbackPrice) {
  const regular = favoriteNumericPrice(detail?.current_price ?? detail?.regularPrice ?? fallbackPrice);
  const member = favoriteNumericPrice(detail?.member_price ?? detail?.memberPrice);
  if (_currentUser && member > 0 && (!regular || member < regular)) return member;
  return regular;
}

function favoriteOptimizeImage(url, width) {
  if (!url) return '';
  return typeof window.optimizeImage === 'function' ? window.optimizeImage(url, width || 160) : url;
}

function compareFavoriteSizeLabels(left, right) {
  const normalize = (value) => String(value || '')
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/\bfits\s+most\b/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const canonicalize = (value) => {
    const normalized = normalize(value);
    const compact = normalized.replace(/\s+/g, '');
    const aliases = {
      xxxxs: '4xs',
      xxxs: '3xs',
      xxs: '2xs',
      xxxxl: '4xl',
      xxxl: '3xl',
      xxl: '2xl'
    };
    return aliases[compact] || (/^one(?:\s|-)?size$/.test(normalized) ? 'one size' : compact || normalized);
  };
  const rank = (value) => {
    const token = canonicalize(value);
    if (!token) return null;
    if (token === 'one size' || token === 'one-size' || token === 'onesize') return 0;
    const exact = {
      '5xs': 5, '4xs': 10, '3xs': 15, '2xs': 20, 'xs': 30, 'xs/s': 35,
      's': 40, 's/m': 45, 'm': 50, 'm/l': 55, 'l': 60, 'l/xl': 65,
      'xl': 70, '2xl': 80, '3xl': 90, '4xl': 100, '5xl': 110
    };
    if (exact[token] != null) return exact[token];
    return null;
  };
  const leftRank = rank(left);
  const rightRank = rank(right);
  if (leftRank !== null || rightRank !== null) {
    if (leftRank === null) return 1;
    if (rightRank === null) return -1;
    return leftRank - rightRank;
  }
  return String(left || '').localeCompare(String(right || ''), undefined, { numeric: true, sensitivity: 'base' });
}

function pickFavoriteSize(sizeRows) {
  const rows = (Array.isArray(sizeRows) ? sizeRows : [])
    .map((row) => ({
      label: row?.size || row?.size_label || '',
      stock: Number(row?.stock_quantity ?? row?.stock ?? 0)
    }))
    .filter((row) => row.label);
  const inStock = rows.filter((row) => row.stock > 0);
  const source = inStock.length ? inStock : rows;
  if (!source.length) return 'One Size';
  return source.sort((left, right) => compareFavoriteSizeLabels(left.label, right.label))[0].label;
}

function buildFavoriteDetail(product, extra, fallbackFavorite) {
  const images = Array.isArray(extra?.images) ? extra.images : [];
  const colors = Array.isArray(extra?.colors) ? extra.colors : [];
  const sizes = Array.isArray(extra?.sizes) ? extra.sizes : [];
  const primaryImage = images[0]?.image_url || product?.image_url || product?.images?.[0]?.image_url || '';
  const primaryColor = colors[0] || null;
  const detail = {
    id: product?.id || fallbackFavorite?.product_id,
    title: product?.title || fallbackFavorite?.product_name || 'Saved Item',
    subtitle: product?.subtitle || product?.category || '',
    image: primaryImage,
    colorName: primaryColor?.color_name || product?.colorway || 'Standard',
    sku: primaryColor?.variant_sku || product?.sku || '',
    current_price: favoriteNumericPrice(product?.current_price ?? product?.price ?? fallbackFavorite?.price),
    member_price: favoriteNumericPrice(product?.member_price),
    sizes,
  };
  detail.href = favoriteHref(detail.id, detail.title);
  _favoriteProductCache.set(String(detail.id || ''), detail);
  return detail;
}

async function getFavoriteProductDetail(productId, fallbackFavorite) {
  const normalizedProductId = String(productId || '');
  if (!normalizedProductId) return null;
  if (_favoriteProductCache.has(normalizedProductId)) return _favoriteProductCache.get(normalizedProductId);

  if (typeof currentProduct !== 'undefined' && String(currentProduct?.id || '') === normalizedProductId) {
    return buildFavoriteDetail(currentProduct, {
      images: currentProduct.images || [],
      colors: currentProduct.colors || [],
      sizes: currentProduct.inventory || []
    }, fallbackFavorite);
  }

  try {
    const cachedProducts = JSON.parse(sessionStorage.getItem('zw_home_products') || '[]');
    const cachedProduct = Array.isArray(cachedProducts) ? cachedProducts.find((product) => String(product?.id || '') === normalizedProductId) : null;
    if (cachedProduct) {
      return buildFavoriteDetail(cachedProduct, {
        images: cachedProduct.product_images || [],
        colors: [],
        sizes: []
      }, fallbackFavorite);
    }
  } catch (_) {}

  try {
    const headers = { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` };
    const encodedId = encodeURIComponent(normalizedProductId);
    const [productResp, imagesResp, colorsResp, sizesResp] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/products?select=*&id=eq.${encodedId}&limit=1`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/product_images?select=*&product_id=eq.${encodedId}&order=sort_order.asc`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/color_variants?select=*&product_id=eq.${encodedId}&order=sort_order.asc`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/product_sizes?select=*&product_id=eq.${encodedId}`, { headers })
    ]);
    const productRows = productResp.ok ? await productResp.json() : [];
    const product = Array.isArray(productRows) ? productRows[0] : null;
    if (!product) return null;
    const images = imagesResp.ok ? await imagesResp.json() : [];
    const colors = colorsResp.ok ? await colorsResp.json() : [];
    const sizes = sizesResp.ok ? await sizesResp.json() : [];
    return buildFavoriteDetail(product, { images, colors, sizes }, fallbackFavorite);
  } catch (_) {
    return null;
  }
}

function buildFavoriteFallbackDetail(productId, favorite) {
  const normalizedProductId = String(productId || favorite?.product_id || '');
  const title = favorite?.product_name || 'Saved Item';
  const regularPrice = favoriteNumericPrice(favorite?.price);
  return {
    id: normalizedProductId,
    title,
    subtitle: '',
    image: favorite?.product_image || '',
    colorName: 'Standard',
    sku: '',
    current_price: regularPrice,
    member_price: 0,
    sizes: [],
    href: favoriteHref(normalizedProductId, title)
  };
}

function favoriteCardHtml(favorite, detail, options) {
  const mode = options?.mode || 'cart';
  const productId = favorite.product_id;
  const name = detail?.title || favorite.product_name || 'Saved Item';
  const href = detail?.href || favoriteHref(productId, name);
  const subtitle = detail?.subtitle ? `<div style="font-size:0.66rem;letter-spacing:0.08em;text-transform:uppercase;color:rgba(245,245,240,0.36);margin-top:0.2rem;">${escapeFavoriteHtml(detail.subtitle)}</div>` : '';
  const imageHtml = detail?.image
    ? `<img src="${favoriteOptimizeImage(detail.image, 180)}" alt="${escapeFavoriteHtml(name)}" style="width:68px;height:86px;object-fit:cover;border:1px solid rgba(245,245,240,0.08);flex-shrink:0;" onerror="if(this.src !== '${detail.image}') this.src='${detail.image}';">`
    : `<div style="width:68px;height:86px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(245,245,240,0.08);color:rgba(245,245,240,0.28);font-size:0.62rem;letter-spacing:0.08em;text-transform:uppercase;flex-shrink:0;">No Image</div>`;
  const displayPrice = favoriteEffectivePrice(detail, favorite.price);
  const priceHtml = displayPrice > 0
    ? `<div style="font-size:0.82rem;color:rgba(245,245,240,0.72);margin-top:0.45rem;">$${displayPrice.toFixed(2)}</div>`
    : '';
  const listTag = mode === 'account' ? 'div' : 'li';
  return `
    <${listTag} style="display:flex;gap:0.85rem;align-items:flex-start;padding:${mode === 'account' ? '0.95rem 0' : '0.75rem 0'};border-bottom:1px solid rgba(245,245,240,0.07);">
      ${imageHtml}
      <div style="flex:1;min-width:0;">
        <div style="font-size:0.88rem;line-height:1.35;">${escapeFavoriteHtml(name)}</div>
        ${subtitle}
        ${priceHtml}
        <div class="zw-saved-item-actions">
          <a href="${href}" class="zw-saved-item-link zw-saved-item-btn zw-saved-item-btn--ghost">View Product</a>
          <button
            type="button"
            data-favorite-add="${escapeFavoriteHtml(productId)}"
            onclick='if(window.addFavoriteToCart){window.addFavoriteToCart(${JSON.stringify(String(productId || ''))});} return false;'
            class="zw-saved-item-btn zw-saved-item-btn--primary"
          >Add to Bag</button>
          <button
            type="button"
            data-favorite-remove="${escapeFavoriteHtml(productId)}"
            onclick='if(window.removeFavorite){window.removeFavorite(${JSON.stringify(String(productId || ''))}, this.closest("li, div"));} return false;'
            class="zw-saved-item-btn zw-saved-item-btn--ghost"
          >Remove</button>
        </div>
      </div>
    </${listTag}>
  `;
}

async function renderFavoriteCollection(listEl, favorites, options) {
  if (!listEl) return;
  const detailPairs = await Promise.all(favorites.map(async (favorite) => {
    const detail = await getFavoriteProductDetail(favorite.product_id, favorite);
    return { favorite, detail };
  }));
  listEl.innerHTML = detailPairs.map(({ favorite, detail }) => favoriteCardHtml(favorite, detail, options)).join('');
}

window.addFavoriteToCart = async function(productId) {
  const normalizedProductId = String(productId || '');
  const favorite = _userFavorites.find((item) => String(item.product_id || '') === normalizedProductId) || { product_id: normalizedProductId };
  try {
    const detail = await getFavoriteProductDetail(normalizedProductId, favorite) || buildFavoriteFallbackDetail(normalizedProductId, favorite);
    if (!detail?.id) {
      window.location.href = `/product.html?id=${encodeURIComponent(normalizedProductId)}`;
      return;
    }

    const size = pickFavoriteSize(detail.sizes) || 'One Size';
    const regularPrice = favoriteNumericPrice(detail.current_price ?? favorite.price);
    const memberPrice = favoriteNumericPrice(detail.member_price);
    const effectivePrice = favoriteEffectivePrice(detail, favorite.price);
    const cart = JSON.parse(localStorage.getItem('cart') || '[]');
    const existing = cart.find((item) =>
      String(item.productId || '') === String(detail.id || '') &&
      String(item.size || '') === String(size || '') &&
      String(item.colorName || '') === String(detail.colorName || '') &&
      String(item.sku || '') === String(detail.sku || '')
    );

    if (existing) {
      existing.quantity += 1;
    } else {
      cart.push({
        productId: detail.id,
        sku: detail.sku,
        title: detail.title,
        size,
        colorName: detail.colorName || 'Standard',
        regularPrice,
        memberPrice,
        price: effectivePrice || regularPrice,
        image: detail.image,
        quantity: 1
      });
    }

    localStorage.setItem('cart', JSON.stringify(cart));
    if (typeof loadCartCount === 'function') loadCartCount();
    if (typeof window.renderProductCartItems === 'function') window.renderProductCartItems();
    if (typeof renderCart === 'function') renderCart();
    if (typeof openCart === 'function') openCart();
    showToast(`Added ${detail.title}${size ? ` (${size})` : ''} to bag.`);
  } catch (error) {
    console.error('addFavoriteToCart failed:', error);
    showToast('Could not add this saved item right now.');
  }
};

async function loadAcctFavs() {
  if (!_sb || !_currentUser) return;
  const loading = $('acct-favs-loading');
  const empty   = $('acct-favs-empty');
  const list    = $('acct-favs-list');
  if (!loading || !list) return;
  loading.style.display = 'block'; empty.style.display = 'none'; list.innerHTML = '';
  // Re-use already-cached _userFavorites — no extra Supabase query needed
  loading.style.display = 'none';
  if (!_userFavorites.length) { empty.style.display = 'block'; return; }
  list.innerHTML = _userFavorites.map(fav => `
    <li style="display:flex;align-items:center;justify-content:space-between;padding:0.8rem 0;border-bottom:1px solid rgba(245,245,240,0.08);">
      <span style="font-size:0.9rem;">${fav.product_name}</span>
      <button onclick="removeFavorite('${fav.product_id}', this.closest('li'))"
        style="background:none;border:none;cursor:pointer;color:rgba(245,245,240,0.4);font-size:1.1rem;padding:0 0.3rem;"
        aria-label="Remove">✕</button>
    </li>
  `).join('');
}

// ── Favorites ──────────────────────────────────────────────────────
async function loadFavorites() {
  if (!_sb || !_currentUser) return;
  const { data } = await _sb
    .from('favorites')
    .select('product_id, product_name, price, product_image')
    .eq('user_id', _currentUser.id);
  _userFavorites = data || [];
  refreshHeartButtons();
  refreshCartFavs();
    // Re-run after short delays to catch dynamically-rendered product IDs (e.g. product.html)
      setTimeout(refreshHeartButtons, 300);
        setTimeout(refreshHeartButtons, 1000);
}

function refreshHeartButtons() {
  const ids = new Set(_userFavorites.map(f => f.product_id));
  document.querySelectorAll('.heart-btn').forEach(btn => {
    btn.classList.toggle('active', ids.has(btn.dataset.productId));
  });
}
window.refreshHeartButtons = refreshHeartButtons; // expose globally for products.js

function refreshCartFavs() {
  const loggedOut = $('fav-logged-out-msg');
  const loggedIn  = $('fav-logged-in-area');
  const empty     = $('cart-favs-empty');
  const list      = $('cart-favs-list');
  if (!_currentUser) {
    if (loggedOut) loggedOut.style.display = 'block';
    if (loggedIn)  loggedIn.style.display  = 'none';
    return;
  }
  if (loggedOut) loggedOut.style.display = 'none';
  if (loggedIn)  loggedIn.style.display  = 'block';
  if (!list) return;
  // Use index.html's rich renderer if available, otherwise use the built-in card renderer
  if (typeof renderHomeFavoriteCollection === 'function') {
    if (!_userFavorites.length) {
      if (empty) empty.style.display = 'block';
      list.innerHTML = '';
    } else {
      if (empty) empty.style.display = 'none';
      void renderHomeFavoriteCollection(list, _userFavorites, 'cart');
    }
    return;
  }
  if (!_userFavorites.length) {
    if (empty) empty.style.display = 'block';
    list.innerHTML = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  // Use the rich card renderer (image, price, View Product, Add to Bag buttons)
  list.innerHTML = '';
  void renderFavoriteCollection(list, _userFavorites, { mode: 'cart' });
}

async function toggleFavorite(btn) {
  if (!_currentUser) { openAuthModal('signin'); return; }
  const pid     = btn.dataset.productId;
  const pname   = btn.dataset.productName;
  const price   = btn.dataset.price;
  const pimage  = btn.dataset.productImage || '';
  const isActive = _userFavorites.some(f => f.product_id === pid);
  if (isActive) {
    await removeFavorite(pid, null);
  } else {
    if (_sb) {
      await _sb.from('favorites').upsert({ user_id: _currentUser.id, product_id: pid, product_name: pname, price, product_image: pimage }, { onConflict: 'user_id,product_id' });
    }
    _userFavorites.push({ product_id: pid, product_name: pname, price, product_image: pimage });
    refreshHeartButtons();
    refreshCartFavs();
    showToast('Saved to favorites!');
  }
}

async function removeFavorite(pid, liEl) {
  if (_sb && _currentUser) {
    await _sb.from('favorites').delete().eq('user_id', _currentUser.id).eq('product_id', pid);
  }
  _userFavorites = _userFavorites.filter(f => f.product_id !== pid);
  if (liEl) liEl.remove();
  refreshHeartButtons();
  refreshCartFavs();
  showToast('Removed from favorites.');
}

document.addEventListener('click', e => {
  const addFavoriteBtn = e.target.closest('[data-favorite-add]');
  if (addFavoriteBtn) {
    e.preventDefault();
    void window.addFavoriteToCart(addFavoriteBtn.dataset.favoriteAdd || '');
    return;
  }

  const removeFavoriteBtn = e.target.closest('[data-favorite-remove]');
  if (removeFavoriteBtn) {
    e.preventDefault();
    void removeFavorite(removeFavoriteBtn.dataset.favoriteRemove || '', removeFavoriteBtn.closest('li, div'));
    return;
  }

  const btn = e.target.closest('.heart-btn');
  if (btn) toggleFavorite(btn);
});
