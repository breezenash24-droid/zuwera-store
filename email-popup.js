/* ────────────────────────────────────────────────────────────────────────────
   email-popup.js — email capture popup, in six orientations.

   Everything here is driven by site_settings.email_popup, edited in
   Admin → Marketing → Email Popup. Nothing about the popup is hardcoded: the
   copy, the orientation, the logo, the photo, the trigger, the pages it runs on
   and whether it offers a discount at all are settings.

   Two modes:
     'signup'    — plain email capture, no offer.
     'discount'  — capture, then reveal a working discount code.

   Six orientations (data-layout on the root):
     center  classic centred card
     split   card with a photo beside the form
     corner  small card in the bottom corner, page stays usable
     bar     full-width bar along the bottom, page stays usable
     full    full-bleed takeover
     drawer  full-height panel from the edge (bottom sheet on phones)

   The discount code is minted SERVER-side by /api/popup-claim, which reads the
   same setting to decide the value. The browser never says what discount it
   wants — it only sends an email address — so the offer can't be inflated by
   editing a request.

   Fonts: the popup inherits the store's type through the shared vars, and
   Appearance → Typography carries "Email Popup" (.zwp-title/.zwp-btn) and
   "Email Popup Body" (.zwp-sub/.zwp-fine) sections for per-surface overrides,
   exactly like every other surface.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.ZWEmailPopup) return;

  // Never inside a frame. The size guide is embedded in an iframe on the product
  // page and the page builder previews the storefront the same way — a popup
  // opening in there would appear boxed inside another page's panel, and the
  // builder would be unusable while it sat over the preview.
  try { if (window.top !== window.self) return; } catch (_) { return; }   // cross-origin frame

  var SUPA = 'https://qfgnrsifcwdubkolsgsq.supabase.co';
  // Public, RLS-gated anon key (same one shipped in supabase-client.js).
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';

  var CSS_HREF = '/email-popup.css?v=1';   // hash re-stamped by bump-cache-version.js
  var SEEN_KEY = 'zw_popup_seen';          // epoch ms of the last time it showed
  var DONE_KEY = 'zw_popup_done';          // set once this browser has signed up
  var KNOWN_KEY = 'zw_known_email';        // the site has this visitor's address
  var VIEWS_KEY = 'zw_popup_views';        // page views this session
  var AUTH_KEY = 'zuwera-auth';            // customer session (auth.js storageKey)

  var LAYOUTS = ['center', 'split', 'corner', 'bar', 'full', 'drawer'];
  var BLOCKING = { center: 1, split: 1, full: 1, drawer: 1 };

  var DEFAULTS = {
    enabled: false,
    mode: 'discount',          // discount | signup
    layout: 'center',
    side: 'right',             // corner / drawer edge
    media: 'left',             // split / full photo side
    theme: 'auto',             // auto | dark | light
    radius: 0,

    logo: { on: false, url: '', height: 44 },
    image: { url: '' },

    heading: 'Take 10% off your first order',
    sub: 'Join the list for early access to drops, restocks and members-only offers.',
    placeholder: 'Email address',
    button: 'Get my code',
    fine: 'By signing up you agree to receive marketing emails. Unsubscribe any time.',
    decline: 'No thanks',
    successHeading: 'Welcome in',
    successSub: 'Your code is saved to your bag — it will be applied at checkout.',
    successSignup: 'Thanks for signing up. Keep an eye on your inbox.',

    discount: {
      source: 'shared',        // shared: one code for everyone | unique: one per email
      code: '',                // the shared code
      type: 'percent',         // percent | fixed
      value: 10,
      minSubtotal: 0,
      expiryDays: 30,
      prefix: 'WELCOME',
    },

    trigger: { delay: 8, scroll: 0, exitIntent: true, minViews: 0 },

    rules: {
      frequencyDays: 30,
      // Don't ask for an address the store already has. Signed-in shoppers,
      // anyone who used the footer form, and anyone who has ordered are all
      // people for whom this popup is pure friction.
      skipKnown: true,
      devices: { desktop: true, mobile: true },
      // Keyed like the announcement bar's page map, so both admin screens read
      // the same way. Anything not listed falls back to `other`.
      // Off by default anywhere the shopper is mid-task or already done:
      // interrupting a checkout costs more than the address is worth, and
      // offering "your first order" to someone on the confirmation page is
      // offering it a minute too late.
      pages: {
        home: true, product: true, drop001: true, landing: true, journal: true,
        about: true, sizeguide: true, policies: true,
        bag: false, checkout: false, confirm: false, account: false,
        other: true,
      },
    },
  };

  /* ── config plumbing ─────────────────────────────────────────────────────── */

  function pick(v, fallback) { return (v === undefined || v === null || v === '') ? fallback : v; }
  function bool(v, fallback) { return typeof v === 'boolean' ? v : fallback; }
  function num(v, fallback) { var n = Number(v); return isFinite(n) ? n : fallback; }
  function oneOf(v, list, fallback) { return list.indexOf(String(v)) > -1 ? String(v) : fallback; }

  /**
   * Fill in every missing field from DEFAULTS. A half-written setting (an admin
   * who saved before the discount block existed, say) must never leave the
   * popup rendering blank labels or an undefined discount.
   */
  function normalize(raw) {
    var r = (raw && typeof raw === 'object') ? raw : {};
    var d = DEFAULTS;
    var logo = r.logo || {}, image = r.image || {}, disc = r.discount || {};
    var trig = r.trigger || {}, rules = r.rules || {}, dev = rules.devices || {}, pages = rules.pages || {};

    var out = {
      enabled: bool(r.enabled, d.enabled),
      mode: oneOf(r.mode, ['discount', 'signup'], d.mode),
      layout: oneOf(r.layout, LAYOUTS, d.layout),
      side: oneOf(r.side, ['right', 'left'], d.side),
      media: oneOf(r.media, ['left', 'right'], d.media),
      theme: oneOf(r.theme, ['auto', 'dark', 'light'], d.theme),
      radius: Math.max(0, Math.min(40, num(r.radius, d.radius))),

      logo: { on: bool(logo.on, d.logo.on), url: String(pick(logo.url, d.logo.url)), height: Math.max(12, Math.min(160, num(logo.height, d.logo.height))) },
      image: { url: String(pick(image.url, d.image.url)) },

      heading: String(pick(r.heading, d.heading)),
      sub: String(pick(r.sub, d.sub)),
      placeholder: String(pick(r.placeholder, d.placeholder)),
      button: String(pick(r.button, d.button)),
      fine: r.fine === undefined ? d.fine : String(r.fine),
      decline: r.decline === undefined ? d.decline : String(r.decline),
      successHeading: String(pick(r.successHeading, d.successHeading)),
      successSub: String(pick(r.successSub, d.successSub)),
      successSignup: String(pick(r.successSignup, d.successSignup)),

      discount: {
        source: oneOf(disc.source, ['shared', 'unique'], d.discount.source),
        code: String(pick(disc.code, d.discount.code)).toUpperCase().replace(/[^A-Z0-9_-]/g, ''),
        type: oneOf(disc.type, ['percent', 'fixed'], d.discount.type),
        value: Math.max(0, num(disc.value, d.discount.value)),
        minSubtotal: Math.max(0, num(disc.minSubtotal, d.discount.minSubtotal)),
        expiryDays: Math.max(0, num(disc.expiryDays, d.discount.expiryDays)),
        prefix: String(pick(disc.prefix, d.discount.prefix)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12),
      },

      trigger: {
        delay: Math.max(0, num(trig.delay, d.trigger.delay)),
        scroll: Math.max(0, Math.min(100, num(trig.scroll, d.trigger.scroll))),
        exitIntent: bool(trig.exitIntent, d.trigger.exitIntent),
        minViews: Math.max(0, num(trig.minViews, d.trigger.minViews)),
      },

      rules: {
        frequencyDays: Math.max(0, num(rules.frequencyDays, d.rules.frequencyDays)),
        skipKnown: bool(rules.skipKnown, d.rules.skipKnown),
        devices: { desktop: bool(dev.desktop, true), mobile: bool(dev.mobile, true) },
        pages: {},
      },
    };

    Object.keys(d.rules.pages).forEach(function (k) { out.rules.pages[k] = bool(pages[k], d.rules.pages[k]); });
    // Keep any page key the admin added that isn't in DEFAULTS (a custom landing
    // page slug, say) rather than silently dropping it on the next save.
    Object.keys(pages).forEach(function (k) {
      if (!(k in out.rules.pages)) out.rules.pages[k] = bool(pages[k], true);
    });
    return out;
  }

  var cfg = null;
  var waiting = [];

  function get() { return cfg || normalize(null); }
  function ready(fn) { if (cfg) { try { fn(cfg); } catch (_) {} return; } waiting.push(fn); }

  /* ── environment ─────────────────────────────────────────────────────────── */

  function pageKey() {
    var p = (location.pathname || '').replace(/^\/+/, '').replace(/\.html$/i, '').toLowerCase();
    if (!p || p === 'index') return 'home';
    return p.split('/')[0];
  }
  function isMobile() {
    try { return window.matchMedia('(max-width: 900px)').matches; } catch (_) { return false; }
  }
  function store(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function put(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

  /**
   * Count this page view once per load. Kept OUT of blockedReason so that
   * function stays a pure question — the admin editor calls it to explain why a
   * popup isn't showing, and a check that quietly advanced the counter would
   * change the answer just by being asked.
   */
  function bumpViews() {
    try {
      var n = Number(sessionStorage.getItem(VIEWS_KEY) || 0) + 1;
      sessionStorage.setItem(VIEWS_KEY, String(n));
      return n;
    } catch (_) { return 1; }
  }
  function views() {
    try { return Number(sessionStorage.getItem(VIEWS_KEY) || 0); } catch (_) { return 1; }
  }

  /**
   * Does the store already have this visitor's address? Returns the reason it
   * thinks so, or '' — asking someone to "join the list" when they are signed
   * in to an account, or bought last week, reads as a store that doesn't know
   * who its customers are.
   *
   * Three signals, all local, because a cross-device check needs an address to
   * look up and an anonymous visitor hasn't given one:
   *   • zw_known_email — set wherever the site captures an address (this popup,
   *     the footer form, checkout). markKnown() below is the shared hook.
   *   • a customer session — their address is on the account already.
   *   • zw_popup_done — they used this very popup.
   */
  function knownVisitor() {
    if (store(KNOWN_KEY) === '1') return 'already on the list';
    try {
      var raw = localStorage.getItem(AUTH_KEY);
      if (raw) {
        var s = JSON.parse(raw);
        // supabase-js has kept the session under a couple of shapes; check both
        // rather than pin this to one library version.
        var user = (s && s.user) || (s && s.currentSession && s.currentSession.user);
        if (user && user.email) return 'signed in';
      }
    } catch (_) {}
    return '';
  }

  /** Record that the store now has this visitor's address. */
  function markKnown() { put(KNOWN_KEY, '1'); }

  /** Every reason the popup should stay away, in one place. */
  function blockedReason(c) {
    if (!c.enabled) return 'disabled';
    if (store(DONE_KEY) === '1') return 'already signed up';
    if (c.rules.skipKnown) {
      var known = knownVisitor();
      if (known) return 'we already have their email — ' + known;
    }
    var pages = c.rules.pages, key = pageKey();
    var allowed = (key in pages) ? pages[key] : pages.other;
    if (!allowed) return 'page off';
    if (!(isMobile() ? c.rules.devices.mobile : c.rules.devices.desktop)) return 'device off';
    if (c.rules.frequencyDays > 0) {
      var last = Number(store(SEEN_KEY) || 0);
      if (last && (Date.now() - last) < c.rules.frequencyDays * 86400000) return 'seen recently';
    }
    if (c.trigger.minViews > 0 && views() < c.trigger.minViews) return 'not enough page views';
    return '';
  }

  /* ── DOM ─────────────────────────────────────────────────────────────────── */

  var root = null, card = null, els = {}, lastFocus = null, isPreview = false;

  function loadCss(doc) {
    doc = doc || document;
    if (doc.getElementById('zwp-css')) return;
    var link = doc.createElement('link');
    link.id = 'zwp-css';
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    (doc.head || doc.documentElement).appendChild(link);
  }

  // The document the next build() writes into. The live popup uses the page's
  // own; the admin viewer points this at its preview frame so it renders the
  // SAME markup a shopper gets rather than a second copy that could drift.
  var buildDoc = null;
  function el(tag, cls, parent) {
    var n = (buildDoc || document).createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }

  function build() {
    if (root) return;
    root = el('div', 'zwp-root');
    root.id = 'zw-email-popup';
    el('div', 'zwp-scrim', root);

    card = el('div', 'zwp-card', root);

    els.close = el('button', 'zwp-close', card);
    els.close.type = 'button';
    els.close.setAttribute('aria-label', 'Close');
    els.close.innerHTML = '&times;';

    els.media = el('div', 'zwp-media', card);
    els.mediaImg = el('img', '', els.media);
    els.mediaImg.alt = '';

    var body = el('div', 'zwp-body', card);
    els.body = body;

    els.logo = el('img', 'zwp-logo', body);
    els.logo.alt = '';

    // The ask (heading/sub/form) and the success state are siblings; the card
    // flips between them with a class rather than being rebuilt, so the popup
    // keeps its size and position when the shopper submits.
    els.ask = el('div', 'zwp-ask', body);
    els.title = el('h2', 'zwp-title', els.ask);
    els.title.id = 'zwp-title';
    els.sub = el('p', 'zwp-sub', els.ask);

    els.form = el('form', 'zwp-form', body);
    els.input = el('input', 'zwp-input', els.form);
    els.input.type = 'email';
    els.input.name = 'email';
    els.input.autocomplete = 'email';
    els.input.required = true;
    els.btn = el('button', 'zwp-btn', els.form);
    els.btn.type = 'submit';

    els.err = el('p', 'zwp-err', body);
    els.err.setAttribute('role', 'alert');
    els.fine = el('p', 'zwp-fine', body);
    els.decline = el('button', 'zwp-decline', body);
    els.decline.type = 'button';

    els.done = el('div', 'zwp-done', body);
    els.doneTitle = el('h2', 'zwp-title', els.done);
    els.doneSub = el('p', 'zwp-sub', els.done);
    els.codeWrap = el('div', 'zwp-code', els.done);
    els.code = el('code', '', els.codeWrap);
    els.copy = el('button', 'zwp-copy', els.codeWrap);
    els.copy.type = 'button';
    els.copy.textContent = 'Copy';

    (buildDoc || document).body.appendChild(root);
    // Only the live popup gets behaviour. A preview build must stay inert: its
    // handlers would close over the module's root/card, which are swapped back
    // the moment renderInto returns, so a click on the preview's close button
    // would act on the REAL popup instead — and the keydown listener would pile
    // up another copy on every redraw.
    if (!buildDoc) wire();
  }

  function paint(c) {
    root.setAttribute('data-layout', c.layout);
    root.setAttribute('data-side', c.side);
    root.setAttribute('data-media', c.media);
    root.setAttribute('data-theme', c.theme);
    root.setAttribute('data-has-media', c.image.url ? '1' : '0');
    root.style.setProperty('--zwp-radius', c.radius + 'px');

    // Only the blocking orientations are dialogs. Saying so on the corner card
    // or the bottom bar would be a lie to a screen reader — and modal-lock.js
    // watches [role="dialog"], so it would also scroll-lock a page the shopper
    // is meant to keep using.
    if (BLOCKING[c.layout]) {
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-labelledby', 'zwp-title');
      card.removeAttribute('aria-label');
    } else {
      card.setAttribute('role', 'region');
      card.removeAttribute('aria-modal');
      card.removeAttribute('aria-labelledby');
      card.setAttribute('aria-label', c.heading || 'Newsletter signup');
    }

    if (c.image.url) { els.mediaImg.src = c.image.url; els.media.style.display = ''; }
    else { els.mediaImg.removeAttribute('src'); els.media.style.display = 'none'; }

    if (c.logo.on && c.logo.url) {
      els.logo.src = c.logo.url;
      els.logo.style.height = c.logo.height + 'px';
      els.logo.style.display = '';
    } else {
      els.logo.removeAttribute('src');
      els.logo.style.display = 'none';
    }

    els.title.textContent = c.heading;
    els.sub.textContent = c.sub;
    els.sub.style.display = c.sub ? '' : 'none';
    els.input.placeholder = c.placeholder;
    els.input.setAttribute('aria-label', c.placeholder || 'Email address');
    els.btn.textContent = c.button;
    els.fine.textContent = c.fine;
    els.fine.style.display = c.fine ? '' : 'none';
    els.decline.textContent = c.decline;
    els.decline.style.display = c.decline ? '' : 'none';
    els.err.textContent = '';

    card.classList.remove('zwp-is-done');
    els.btn.disabled = false;
    els.input.value = '';
  }

  /* ── open / close ────────────────────────────────────────────────────────── */

  var openNow = false;

  function open(override, opts) {
    var c = override ? normalize(override) : get();
    isPreview = !!(opts && opts.preview);
    loadCss();
    build();
    paint(c);
    root._cfg = c;

    lastFocus = document.activeElement;
    // Mount, force the layout, THEN reveal — see the .zwp-mount comment in the
    // stylesheet. Without the reflow between the two the popup snaps in with no
    // transition at all.
    root.classList.add('zwp-mount');
    void root.offsetWidth;
    root.classList.add('zwp-open');
    openNow = true;
    if (!isPreview) put(SEEN_KEY, String(Date.now()));

    // modal-lock.js observes the DOM and locks on any visible [role=dialog], but
    // it batches through a MutationObserver — nudge it so the lock lands in the
    // same frame the popup paints and the page can't scroll underneath first.
    if (BLOCKING[c.layout] && window.ZWModalScrollLock) {
      try { window.ZWModalScrollLock.refresh(); } catch (_) {}
    }
    // Focus the field on the blocking orientations only. Stealing focus for a
    // corner card the shopper never asked for would yank them out of whatever
    // they were reading.
    if (BLOCKING[c.layout]) {
      try { els.input.focus({ preventScroll: true }); } catch (_) { els.input.focus(); }
    }
    try {
      document.dispatchEvent(new CustomEvent('zw-popup-open', { detail: { layout: c.layout, mode: c.mode } }));
    } catch (_) {}
  }

  function close() {
    if (!root || !openNow) return;
    openNow = false;
    root.classList.remove('zwp-open');
    // Unmount only after the fade, and only if nothing re-opened it meanwhile.
    setTimeout(function () { if (!openNow && root) root.classList.remove('zwp-mount'); }, 420);
    if (window.ZWModalScrollLock) { try { window.ZWModalScrollLock.refresh(); } catch (_) {} }
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus({ preventScroll: true }); } catch (_) {} }
    lastFocus = null;
  }

  function wire() {
    els.close.addEventListener('click', close);
    els.decline.addEventListener('click', close);
    root.querySelector('.zwp-scrim').addEventListener('click', close);

    document.addEventListener('keydown', function (e) {
      if (!openNow) return;
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'Tab') return;
      // Keep Tab inside the card while a blocking orientation is up, or focus
      // walks off into a page the shopper can't see or click.
      var c = root._cfg;
      if (!c || !BLOCKING[c.layout]) return;
      var focusable = card.querySelectorAll('button, [href], input, select, textarea');
      var list = [];
      for (var i = 0; i < focusable.length; i++) {
        if (focusable[i].offsetParent !== null && !focusable[i].disabled) list.push(focusable[i]);
      }
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    els.copy.addEventListener('click', function () {
      var code = els.code.textContent || '';
      var done = function () { els.copy.textContent = 'Copied'; setTimeout(function () { els.copy.textContent = 'Copy'; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(done, function () {});
      } else {
        try {
          var t = document.createElement('textarea');
          t.value = code; document.body.appendChild(t); t.select();
          document.execCommand('copy'); document.body.removeChild(t); done();
        } catch (_) {}
      }
    });

    els.form.addEventListener('submit', submit);
  }

  function submit(e) {
    e.preventDefault();
    var c = root._cfg || get();
    var email = String(els.input.value || '').trim();
    els.err.textContent = '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      els.err.textContent = 'Please enter a valid email address.';
      els.input.focus();
      return;
    }
    if (isPreview) { showDone(c, c.mode === 'discount' ? (c.discount.code || 'PREVIEW10') : ''); return; }

    els.btn.disabled = true;
    var was = els.btn.textContent;
    els.btn.textContent = 'One moment…';

    fetch('/api/popup-claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, source: 'popup:' + pageKey() }),
    })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.error) || 'Something went wrong. Please try again.');
        put(DONE_KEY, '1');
        markKnown();
        // Hand the code to the bag/checkout promo box. Both pages rehydrate
        // sessionStorage.zw_promo_code through their normal Apply path, so the
        // discount is server-validated like any other code — nothing here can
        // grant a discount by itself.
        if (data.code) { try { sessionStorage.setItem('zw_promo_code', data.code); } catch (_) {} }
        try {
          document.dispatchEvent(new CustomEvent('zw-popup-signup', { detail: { code: data.code || '' } }));
        } catch (_) {}
        showDone(c, data.code || '');
      })
      .catch(function (err) {
        els.btn.disabled = false;
        els.btn.textContent = was;
        els.err.textContent = (err && err.message) || 'Something went wrong. Please try again.';
      });
  }

  function showDone(c, code) {
    els.doneTitle.textContent = c.successHeading;
    els.doneSub.textContent = code ? c.successSub : c.successSignup;
    if (code) {
      els.code.textContent = code;
      els.codeWrap.style.display = '';
    } else {
      els.codeWrap.style.display = 'none';
    }
    card.classList.add('zwp-is-done');
    try { els.close.focus({ preventScroll: true }); } catch (_) {}
  }

  /* ── triggers ────────────────────────────────────────────────────────────── */

  function arm(c) {
    var fired = false;
    var timer = null;

    function fire() {
      if (fired) return;
      // Never open on top of something else. A popup landing over the login
      // modal or the bag panel would trap the shopper between two overlays, and
      // the scroll-lock bookkeeping of both would fight.
      if (document.body && document.body.dataset && document.body.dataset.scrollLocked === 'true') return;
      var banner = document.getElementById('cookie-banner');
      if (banner && banner.offsetParent !== null) return;   // consent comes first
      fired = true;
      cleanup();
      open(null);
    }
    function cleanup() {
      if (timer) { clearTimeout(timer); timer = null; }
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('mouseout', onExit);
    }
    function onScroll() {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      if (h <= 0) return;
      if (((window.scrollY || window.pageYOffset || 0) / h) * 100 >= c.trigger.scroll) fire();
    }
    function onExit(e) {
      // Pointer left through the TOP of the window with nothing to hand off to
      // — the shopper is heading for the tab bar or the address bar.
      if (e.clientY > 0 || e.relatedTarget || e.toElement) return;
      fire();
    }

    if (c.trigger.delay > 0) timer = setTimeout(fire, c.trigger.delay * 1000);
    if (c.trigger.scroll > 0) window.addEventListener('scroll', onScroll, { passive: true });
    // Exit intent needs a mouse. On a phone there's no pointer to leave the
    // window, and the delay/scroll triggers cover that case.
    if (c.trigger.exitIntent && !isMobile()) document.addEventListener('mouseout', onExit);
    // Nothing configured at all would mean a popup that never shows; treat that
    // as "as soon as the page settles" rather than silently doing nothing.
    if (c.trigger.delay <= 0 && c.trigger.scroll <= 0 && !c.trigger.exitIntent) setTimeout(fire, 1200);
  }

  function settle(raw) {
    cfg = normalize(raw);
    var q = waiting; waiting = [];
    for (var i = 0; i < q.length; i++) { try { q[i](cfg); } catch (_) {} }
    if (window.__zwPopupNoAutoOpen) return;    // admin preview host: config only
    bumpViews();                                // exactly once per page load
    if (blockedReason(cfg)) return;
    loadCss();                                  // ready before the trigger fires
    arm(cfg);
  }

  fetch(SUPA + '/rest/v1/site_settings?select=value&key=eq.email_popup', {
    headers: { apikey: ANON, Authorization: 'Bearer ' + ANON },
    cache: 'no-store',
  })
    .then(function (r) { return r.ok ? r.json() : []; })
    .then(function (rows) {
      var v = rows && rows[0] ? rows[0].value : null;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { settle(v); }, { once: true });
      } else settle(v);
    })
    .catch(function () { settle(null); });

  window.ZWEmailPopup = {
    DEFAULTS: DEFAULTS,
    normalize: normalize,
    get: get,
    ready: ready,
    // open/close are exposed so the admin editor can preview the REAL popup
    // rather than a second mock that could drift from what shoppers see.
    open: open,
    close: close,
    LAYOUTS: LAYOUTS,
    blockedReason: blockedReason,
    /**
     * Render the popup into ANOTHER document — the admin's preview frame — and
     * leave it there. No triggers, no fetch, no storage, no scroll lock: this
     * only draws.
     *
     * It exists so the admin viewer shows the real thing. A hand-written mock
     * of the popup in the admin would be a second implementation of the same
     * markup, and the first time someone changed one and not the other the
     * preview would start lying about what shoppers see.
     *
     * @param {Document} targetDoc  a same-origin document to draw into
     * @param {object}   raw        config as the editor currently has it
     * @param {object}   [opts]     { done: true } to show the post-signup state
     */
    renderInto: function (targetDoc, raw, opts) {
      if (!targetDoc || !targetDoc.body) return null;
      var c = normalize(raw);
      loadCss(targetDoc);
      // Draw into the frame, then hand the module back its own document so the
      // live popup on this page is unaffected.
      var keepRoot = root, keepCard = card, keepEls = els, keepOpen = openNow;
      root = null; card = null; els = {}; buildDoc = targetDoc;
      try {
        build();
        paint(c);
        root.classList.add('zwp-mount', 'zwp-open');
        root._cfg = c;
        if (opts && opts.done) {
          showDone(c, c.mode === 'discount'
            ? (c.discount.source === 'shared' ? (c.discount.code || 'YOURCODE') : (c.discount.prefix + '4K7QP'))
            : '');
        }
        return root;
      } finally {
        buildDoc = null;
        root = keepRoot; card = keepCard; els = keepEls; openNow = keepOpen;
      }
    },
    // Shared hook for every other place the site captures an address (footer
    // signup, checkout), so none of them has to know this module's storage keys.
    markKnown: markKnown,
    knownVisitor: knownVisitor,
  };
})();
