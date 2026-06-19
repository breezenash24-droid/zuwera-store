/* ============================================================================
   zw-login.js — self-contained, in-place Login/Sign-up modal for the utility
   pages (returns, policies, sizeguide, account, collection) that don't carry
   the full auth.js modal. Pressing "Login" opens this modal on the current
   page instead of bouncing to the landing page.

   Design goals:
   - Zero collisions: everything is namespaced (_zwlg*, .zwlg-*) and it injects
     its OWN CSS + markup, so it never clashes with a page's existing styles or
     with auth.js / supabase-client.js identifiers (e.g. the `_sb` const).
   - Progressive enhancement: the Login link keeps its real href
     (/?auth=signin&next=…). This script only adds a click interceptor; if the
     script fails to load, the link still works (navigates, as before). The
     modal also has an explicit "sign in on the main page" escape hatch so
     login can never become a dead end.
   - Shared session: signs in through window.sb (the same Supabase client +
     storageKey the rest of the site uses), so after login the page just
     reloads and picks up the session.
   ========================================================================== */
(function () {
  if (window.__zwLoginLite) return;
  window.__zwLoginLite = true;

  var MODAL_ID = 'zwlg-modal';

  // ── Styles ────────────────────────────────────────────────────────────────
  var CSS = [
    '#zwlg-modal{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;padding:1rem;',
      'background:rgba(9,9,11,.62);opacity:0;visibility:hidden;pointer-events:none;',
      'transition:opacity .28s ease,visibility 0s linear .28s;-webkit-tap-highlight-color:transparent;}',
    '#zwlg-modal.open{opacity:1;visibility:visible;pointer-events:auto;transition:opacity .28s ease;}',
    '#zwlg-modal .zwlg-box{width:min(420px,94vw);max-height:92dvh;overflow-y:auto;background:#0f0f0f;color:#f4f1eb;',
      'border:1px solid rgba(244,241,235,.1);border-top:2px solid #F891A5;border-radius:2px;',
      'box-shadow:0 28px 90px rgba(0,0,0,.5);padding:2.4rem 2rem 2rem;position:relative;',
      'transform:translateY(14px) scale(.98);opacity:0;transition:transform .28s cubic-bezier(.32,.72,.34,1),opacity .28s ease;',
      'font-family:"IBM Plex Mono",monospace;}',
    '#zwlg-modal.open .zwlg-box{transform:none;opacity:1;}',
    '#zwlg-modal .zwlg-close{position:absolute;top:.85rem;right:.9rem;background:none;border:none;color:inherit;',
      'font-size:1.35rem;line-height:1;cursor:pointer;opacity:.55;transition:opacity .2s;padding:.2rem;}',
    '#zwlg-modal .zwlg-close:hover{opacity:1;}',
    '#zwlg-modal .zwlg-brand{font-family:"Barlow Condensed",sans-serif;font-weight:700;letter-spacing:.22em;',
      'font-size:1.1rem;text-align:center;margin-bottom:1.4rem;text-transform:uppercase;}',
    '#zwlg-modal .zwlg-tabs{display:flex;border-bottom:1px solid rgba(244,241,235,.1);margin-bottom:1.6rem;}',
    '#zwlg-modal .zwlg-tab{flex:1;background:none;border:none;color:rgba(244,241,235,.45);font-family:inherit;',
      'font-size:.62rem;letter-spacing:.14em;text-transform:uppercase;padding:.7rem .4rem;cursor:pointer;',
      'border-bottom:2px solid transparent;margin-bottom:-1px;transition:color .2s,border-color .2s;}',
    '#zwlg-modal .zwlg-tab.active{color:#f4f1eb;border-bottom-color:#F891A5;}',
    '#zwlg-modal .zwlg-panel{display:none;}',
    '#zwlg-modal .zwlg-panel.active{display:block;}',
    '#zwlg-modal .zwlg-title{font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:1.5rem;',
      'letter-spacing:.02em;margin-bottom:.2rem;}',
    '#zwlg-modal .zwlg-sub{font-size:.66rem;color:rgba(244,241,235,.45);margin-bottom:1.4rem;letter-spacing:.04em;}',
    '#zwlg-modal label{display:block;font-size:.56rem;letter-spacing:.12em;text-transform:uppercase;',
      'color:rgba(244,241,235,.5);margin-bottom:.4rem;}',
    '#zwlg-modal .zwlg-field{margin-bottom:1rem;position:relative;}',
    '#zwlg-modal input{width:100%;background:rgba(244,241,235,.04);border:1px solid rgba(244,241,235,.12);',
      'color:#f4f1eb;padding:.7rem .8rem;font-family:inherit;font-size:.9rem;outline:none;border-radius:2px;',
      'transition:border-color .18s;}',
    '#zwlg-modal input:focus{border-color:rgba(244,241,235,.45);}',
    '#zwlg-modal .zwlg-pwtoggle{position:absolute;right:.6rem;top:calc(50% + .5rem);transform:translateY(-50%);',
      'background:none;border:none;color:rgba(244,241,235,.4);cursor:pointer;padding:0;display:flex;}',
    '#zwlg-modal .zwlg-submit{width:100%;background:#f4f1eb;color:#09090b;border:1px solid #f4f1eb;',
      'font-family:inherit;font-size:.62rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;',
      'padding:.85rem;cursor:pointer;border-radius:2px;transition:opacity .2s;margin-top:.3rem;}',
    '#zwlg-modal .zwlg-submit:hover{opacity:.88;}',
    '#zwlg-modal .zwlg-submit:disabled{opacity:.5;cursor:default;}',
    '#zwlg-modal .zwlg-err{color:#ff8095;font-size:.66rem;letter-spacing:.03em;min-height:1em;margin:.2rem 0 .6rem;}',
    '#zwlg-modal .zwlg-ok{color:#7bd88f;font-size:.68rem;letter-spacing:.03em;margin:.2rem 0 .6rem;display:none;}',
    '#zwlg-modal .zwlg-mini{display:block;width:100%;text-align:center;background:none;border:none;color:rgba(244,241,235,.45);',
      'font-family:inherit;font-size:.6rem;letter-spacing:.06em;cursor:pointer;margin-top:1rem;text-decoration:none;}',
    '#zwlg-modal .zwlg-mini:hover{color:#f4f1eb;}',
    // Light / super-light mode
    'body.light-mode #zwlg-modal .zwlg-box,body.super-light-mode #zwlg-modal .zwlg-box{background:#fff;color:#09090b;border-color:rgba(9,9,11,.1);border-top-color:#09090b;}',
    'body.light-mode #zwlg-modal .zwlg-tabs{border-bottom-color:rgba(9,9,11,.1);}',
    'body.light-mode #zwlg-modal .zwlg-tab{color:rgba(9,9,11,.45);}',
    'body.light-mode #zwlg-modal .zwlg-tab.active{color:#09090b;border-bottom-color:#09090b;}',
    'body.light-mode #zwlg-modal label,body.light-mode #zwlg-modal .zwlg-sub{color:rgba(9,9,11,.5);}',
    'body.light-mode #zwlg-modal input{background:rgba(9,9,11,.03);border-color:rgba(9,9,11,.15);color:#09090b;}',
    'body.light-mode #zwlg-modal input:focus{border-color:rgba(9,9,11,.45);}',
    'body.light-mode #zwlg-modal .zwlg-submit{background:#09090b;color:#f4f1eb;border-color:#09090b;}',
    'body.light-mode #zwlg-modal .zwlg-mini{color:rgba(9,9,11,.5);}',
    'body.light-mode #zwlg-modal .zwlg-mini:hover{color:#09090b;}',
    '@media(prefers-reduced-motion:reduce){#zwlg-modal,#zwlg-modal .zwlg-box{transition:none!important;}}'
  ].join('');

  // ── Markup ──────────────────────────────────────────────────────────────
  var eye = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  function nextParam() {
    try { return encodeURIComponent(location.pathname + location.search); } catch (_) { return '/'; }
  }
  var HTML =
    '<div id="' + MODAL_ID + '" role="dialog" aria-modal="true" aria-hidden="true" aria-label="Account">' +
      '<div class="zwlg-box">' +
        '<button class="zwlg-close" type="button" aria-label="Close">&#215;</button>' +
        '<div class="zwlg-brand">Zuwera</div>' +
        '<div class="zwlg-tabs">' +
          '<button class="zwlg-tab active" type="button" data-tab="signin">Login</button>' +
          '<button class="zwlg-tab" type="button" data-tab="signup">Create Account</button>' +
        '</div>' +
        // Sign in
        '<div class="zwlg-panel active" data-panel="signin">' +
          '<div class="zwlg-title">Welcome Back</div>' +
          '<div class="zwlg-sub">Login to your account</div>' +
          '<div class="zwlg-field"><label for="zwlg-si-email">Email</label><input id="zwlg-si-email" type="email" autocomplete="email" placeholder="you@example.com"></div>' +
          '<div class="zwlg-field"><label for="zwlg-si-pw">Password</label><input id="zwlg-si-pw" type="password" autocomplete="current-password" placeholder="Password" style="padding-right:40px"><button class="zwlg-pwtoggle" type="button" aria-label="Show password" data-for="zwlg-si-pw">' + eye + '</button></div>' +
          '<p class="zwlg-err" data-err="signin"></p>' +
          '<button class="zwlg-submit" type="button" data-act="signin">Login</button>' +
          '<button class="zwlg-mini" type="button" data-go="forgot">Forgot password?</button>' +
        '</div>' +
        // Sign up
        '<div class="zwlg-panel" data-panel="signup">' +
          '<div class="zwlg-title">Join Zuwera</div>' +
          '<div class="zwlg-sub">For those who dream</div>' +
          '<div class="zwlg-field"><label for="zwlg-su-name">Full Name</label><input id="zwlg-su-name" type="text" autocomplete="name" placeholder="Your name"></div>' +
          '<div class="zwlg-field"><label for="zwlg-su-email">Email</label><input id="zwlg-su-email" type="email" autocomplete="email" placeholder="you@example.com"></div>' +
          '<div class="zwlg-field"><label for="zwlg-su-pw">Password</label><input id="zwlg-su-pw" type="password" autocomplete="new-password" placeholder="Min 6 characters" style="padding-right:40px"><button class="zwlg-pwtoggle" type="button" aria-label="Show password" data-for="zwlg-su-pw">' + eye + '</button></div>' +
          '<p class="zwlg-err" data-err="signup"></p>' +
          '<p class="zwlg-ok" data-ok="signup">&#10003; Account created — check your email to verify.</p>' +
          '<button class="zwlg-submit" type="button" data-act="signup">Create Account</button>' +
        '</div>' +
        // Forgot
        '<div class="zwlg-panel" data-panel="forgot">' +
          '<div class="zwlg-title">Reset Password</div>' +
          '<div class="zwlg-sub">We\'ll email you a reset link</div>' +
          '<div class="zwlg-field"><label for="zwlg-fp-email">Email</label><input id="zwlg-fp-email" type="email" autocomplete="email" placeholder="you@example.com"></div>' +
          '<p class="zwlg-err" data-err="forgot"></p>' +
          '<p class="zwlg-ok" data-ok="forgot">&#10003; If an account exists, a reset link is on its way.</p>' +
          '<button class="zwlg-submit" type="button" data-act="forgot">Send Reset Link</button>' +
          '<button class="zwlg-mini" type="button" data-go="signin">&larr; Back to login</button>' +
        '</div>' +
        '<a class="zwlg-mini" data-escape href="/?auth=signin&next=' + nextParam() + '">Having trouble? Log in on the main page &rarr;</a>' +
      '</div>' +
    '</div>';

  // ── Helpers ────────────────────────────────────────────────────────────────
  function el(sel, root) { return (root || document).querySelector(sel); }
  function lock()   { if (window.ZWModalScrollLock) { window.ZWModalScrollLock.refresh(); return; } document.body.style.overflow = 'hidden'; }
  function unlock() { if (window.ZWModalScrollLock) { window.ZWModalScrollLock.refresh(); return; } document.body.style.overflow = ''; }

  var _built = false;
  function build() {
    if (_built) return;
    _built = true;
    var style = document.createElement('style');
    style.id = 'zwlg-css';
    style.textContent = CSS;
    document.head.appendChild(style);
    var wrap = document.createElement('div');
    wrap.innerHTML = HTML;
    document.body.appendChild(wrap.firstElementChild);
    wire();
  }

  function switchTab(tab) {
    var m = document.getElementById(MODAL_ID);
    if (!m) return;
    m.querySelectorAll('.zwlg-tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    m.querySelectorAll('.zwlg-panel').forEach(function (p) { p.classList.toggle('active', p.dataset.panel === tab); });
    m.querySelectorAll('.zwlg-err').forEach(function (e) { e.textContent = ''; });
    m.querySelectorAll('.zwlg-ok').forEach(function (e) { e.style.display = 'none'; });
  }

  function openModal(tab) {
    build();
    var m = document.getElementById(MODAL_ID);
    switchTab(tab || 'signin');
    m.classList.add('open');
    m.setAttribute('aria-hidden', 'false');
    lock();
    setTimeout(function () {
      var first = el('.zwlg-panel.active input', m);
      if (first) { try { first.focus(); } catch (_) {} }
    }, 60);
  }
  function closeModal() {
    var m = document.getElementById(MODAL_ID);
    if (!m) return;
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
    unlock();
  }

  function setErr(which, msg) { var e = el('[data-err="' + which + '"]'); if (e) e.textContent = msg || ''; }
  function busy(btn, on, label) { if (!btn) return; btn.disabled = on; btn.textContent = on ? '…' : label; }

  function client() { return window.sb || null; }

  async function doSignin(btn) {
    var sb = client();
    setErr('signin', '');
    var email = (el('#zwlg-si-email') || {}).value || '';
    var pw = (el('#zwlg-si-pw') || {}).value || '';
    if (!email || !pw) { setErr('signin', 'Enter your email and password.'); return; }
    if (!sb) { setErr('signin', 'Connection unavailable — use the link below.'); return; }
    busy(btn, true, 'Login');
    try {
      var res = await sb.auth.signInWithPassword({ email: email.trim(), password: pw });
      if (res.error) { setErr('signin', res.error.message || 'Could not log in.'); busy(btn, false, 'Login'); return; }
      location.reload();
    } catch (e) {
      setErr('signin', (e && e.message) || 'Something went wrong.');
      busy(btn, false, 'Login');
    }
  }

  async function doSignup(btn) {
    var sb = client();
    setErr('signup', '');
    var name = (el('#zwlg-su-name') || {}).value || '';
    var email = (el('#zwlg-su-email') || {}).value || '';
    var pw = (el('#zwlg-su-pw') || {}).value || '';
    if (!email || !pw) { setErr('signup', 'Enter your email and a password.'); return; }
    if (pw.length < 6) { setErr('signup', 'Password must be at least 6 characters.'); return; }
    if (!sb) { setErr('signup', 'Connection unavailable — use the link below.'); return; }
    busy(btn, true, 'Create Account');
    try {
      var res = await sb.auth.signUp({
        email: email.trim(),
        password: pw,
        options: { data: { full_name: name.trim() }, emailRedirectTo: location.origin + '/account.html' }
      });
      if (res.error) { setErr('signup', res.error.message || 'Could not create account.'); busy(btn, false, 'Create Account'); return; }
      var ok = el('[data-ok="signup"]'); if (ok) ok.style.display = 'block';
      busy(btn, false, 'Create Account');
    } catch (e) {
      setErr('signup', (e && e.message) || 'Something went wrong.');
      busy(btn, false, 'Create Account');
    }
  }

  async function doForgot(btn) {
    var sb = client();
    setErr('forgot', '');
    var email = (el('#zwlg-fp-email') || {}).value || '';
    if (!email) { setErr('forgot', 'Enter your email.'); return; }
    if (!sb) { setErr('forgot', 'Connection unavailable — use the link below.'); return; }
    busy(btn, true, 'Send Reset Link');
    try {
      await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: location.origin + '/account.html' });
      var ok = el('[data-ok="forgot"]'); if (ok) ok.style.display = 'block';
      busy(btn, false, 'Send Reset Link');
    } catch (e) {
      setErr('forgot', (e && e.message) || 'Something went wrong.');
      busy(btn, false, 'Send Reset Link');
    }
  }

  function wire() {
    var m = document.getElementById(MODAL_ID);
    if (!m) return;
    el('.zwlg-close', m).addEventListener('click', closeModal);
    m.addEventListener('click', function (e) { if (e.target === m) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && m.classList.contains('open')) closeModal(); });
    m.querySelectorAll('.zwlg-tab').forEach(function (b) { b.addEventListener('click', function () { switchTab(b.dataset.tab); }); });
    m.querySelectorAll('[data-go]').forEach(function (b) { b.addEventListener('click', function () { switchTab(b.dataset.go); }); });
    m.querySelectorAll('.zwlg-pwtoggle').forEach(function (b) {
      b.addEventListener('click', function () {
        var inp = document.getElementById(b.dataset.for);
        if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
      });
    });
    m.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.act === 'signin') doSignin(b);
        else if (b.dataset.act === 'signup') doSignup(b);
        else if (b.dataset.act === 'forgot') doForgot(b);
      });
    });
    // Enter key submits the active panel
    m.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var panel = el('.zwlg-panel.active', m);
      if (panel) { var sub = el('[data-act]', panel); if (sub) { e.preventDefault(); sub.click(); } }
    });
  }

  // ── Intercept the header Login link (progressive enhancement) ──────────────
  function isLoginTrigger(a) {
    if (!a) return false;
    var href = (a.getAttribute('href') || '');
    // Only intercept the actual sign-in link — never the "Account" state, which
    // points at account.html and should navigate normally.
    return href.indexOf('auth=signin') !== -1;
  }
  function bind() {
    if (bind._done) return;
    bind._done = true;
    // Event delegation, so it also catches auth-wall buttons that pages render
    // dynamically (e.g. returns.html / account.html) after this script ran.
    document.addEventListener('click', function (e) {
      var t = e.target;
      var a = (t && t.closest) ? t.closest('a.zw-hdr-action, [data-zw-login]') : null;
      if (!a) return;
      if (a.hasAttribute('data-escape')) return;          // the in-modal escape link must navigate
      if (!isLoginTrigger(a) && !a.hasAttribute('data-zw-login')) return;
      e.preventDefault();
      openModal('signin');
    });
  }

  window.zwOpenLogin = openModal;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind, { once: true });
  } else {
    bind();
  }
})();
