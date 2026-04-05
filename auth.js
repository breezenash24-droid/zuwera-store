// ===================== SUPABASE AUTH =====================
const SUPABASE_URL  = 'https://qfgnrsifcwdubkolsgsq.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
const _sb = (typeof supabase !== 'undefined')
  ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON)
  : null;

let _currentUser   = null;
let _userFavorites = []; // full objects: { product_id, product_name, price }

// ── Shorthand helpers ──────────────────────────────────────────────
const $  = id => document.getElementById(id);

// Disable/re-enable a button with a loading label
function setBtn(id, loading, defaultLabel) {
  const btn = $(id);
  btn.disabled    = loading;
  btn.textContent = loading ? defaultLabel.replace(/.$/, '…') : defaultLabel;
  return btn;
}

// ── Cache header auth elements (updated on every auth state change) ──
const _authEls = {
  loginBtn:   $('login-btn'),
  accountBtn: $('account-btn'),
  logoutBtn:  $('logout-btn'),
};

// ── Auth state listener ────────────────────────────────────────────
if (_sb) {
  _sb.auth.onAuthStateChange(async (event, session) => {
    _currentUser = session?.user ?? null;

    // Check if the user was deleted on the server
    if (_currentUser) {
      const { data, error } = await _sb.auth.getUser();
      if (error || !data?.user) {
        await _sb.auth.signOut().catch(()=>{});
        localStorage.removeItem('zuwera-auth');
        _currentUser = null;
      }
    }

    updateHeaderForAuth();
    if (event === 'PASSWORD_RECOVERY') {
      openAuthModal('update-password');
    }
    if (_currentUser) {
      await loadFavorites();
    } else {
      _userFavorites = [];
      refreshHeartButtons();
      refreshCartFavs();
    }
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
  _openModal('auth-modal');
  switchAuthTab(tab || 'signin');
}
function closeAuthModal() {
  _closeModal('auth-modal');
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

// ── Sign In ────────────────────────────────────────────────────────
$('signin-submit').addEventListener('click', async () => {
  const email = $('signin-email').value.trim();
  const pass  = $('signin-password').value;
  const err   = $('signin-error');
  err.textContent = '';
  if (!email || !pass) { err.textContent = 'Please fill in all fields.'; return; }
  setBtn('signin-submit', true, 'Login');
  if (_sb) {
    const { error } = await _sb.auth.signInWithPassword({ email, password: pass });
    if (error) { 
      err.textContent = error.message === 'Email not confirmed' ? 'Please check your email and verify your account.' : error.message; 
      setBtn('signin-submit', false, 'Login'); 
      return; 
    }
  }
  setBtn('signin-submit', false, 'Login');
  closeAuthModal();
  showToast('Welcome back!');
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
  if (_sb) {
    const { data, error } = await _sb.auth.signUp({ email, password: pass, options: { data: { full_name: name } } });
    if (error) { err.textContent = error.message; setBtn('signup-submit', false, 'Create Account'); return; }
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

// ── Forgot Password ────────────────────────────────────────────────
$('forgot-submit').addEventListener('click', async () => {
  const email = $('forgot-email').value.trim();
  const err   = $('forgot-error');
  const suc   = $('forgot-success');
  err.textContent = '';
  suc.style.display = 'none';
  if (!email) { err.textContent = 'Please enter your email.'; return; }
  setBtn('forgot-submit', true, 'Send Reset Link');
  if (_sb) {
    const { error } = await _sb.auth.resetPasswordForEmail(email, { redirectTo: 'https://zuwera.store' });
    if (error) { err.textContent = error.message; setBtn('forgot-submit', false, 'Send Reset Link'); return; }
  }
  setBtn('forgot-submit', false, 'Send Reset Link');
  suc.style.display = 'block';
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
    await _sb.auth.signOut().catch(()=>{});
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
});
$('account-modal-close').addEventListener('click', () => _closeModal('account-modal'));
$('account-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) _closeModal('account-modal');
});

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
    .select('product_id, product_name, price')
    .eq('user_id', _currentUser.id);
  _userFavorites = data || [];
  refreshHeartButtons();
  refreshCartFavs();
}

function refreshHeartButtons() {
  const ids = new Set(_userFavorites.map(f => f.product_id));
  document.querySelectorAll('.heart-btn').forEach(btn => {
    btn.classList.toggle('active', ids.has(btn.dataset.productId));
  });
}

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
  if (!_userFavorites.length) {
    if (empty) empty.style.display = 'block';
    list.innerHTML = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  list.innerHTML = _userFavorites.map(fav => `
    <li style="display:flex;align-items:center;justify-content:space-between;padding:0.6rem 0;border-bottom:1px solid rgba(245,245,240,0.06);font-size:0.85rem;">
      <span>${fav.product_name}</span>
      <button onclick="removeFavorite('${fav.product_id}', null)"
        style="background:none;border:none;cursor:pointer;color:rgba(245,245,240,0.4);font-size:1rem;"
        aria-label="Remove">✕</button>
    </li>
  `).join('');
}

async function toggleFavorite(btn) {
  if (!_currentUser) { openAuthModal('signin'); return; }
  const pid     = btn.dataset.productId;
  const pname   = btn.dataset.productName;
  const price   = btn.dataset.price;
  const isActive = _userFavorites.some(f => f.product_id === pid);
  if (isActive) {
    await removeFavorite(pid, null);
  } else {
    if (_sb) {
      await _sb.from('favorites').upsert({ user_id: _currentUser.id, product_id: pid, product_name: pname, price });
    }
    _userFavorites.push({ product_id: pid, product_name: pname, price });
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

document.querySelectorAll('.heart-btn').forEach(btn => {
  btn.addEventListener('click', () => toggleFavorite(btn));
});
