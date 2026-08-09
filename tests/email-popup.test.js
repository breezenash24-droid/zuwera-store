/* Exercises the real email-popup.js against a minimal DOM.
   Covers: config normalising, all six orientations, every gating rule, and the
   submit path end to end (validation → /api/popup-claim → code handed to the
   bag). */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
const SRC = ROOT + '/email-popup.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  \u2014 ' + extra : '')); }
}

/* ── minimal DOM ──────────────────────────────────────────────────────────── */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.parentElement = null;
    this.className = ''; this.id = ''; this.textContent = ''; this.value = '';
    this._attrs = {}; this._on = {};
    this.offsetParent = {};                 // "visible" unless a test says otherwise
    this.offsetWidth = 100; this.disabled = false;
    const self = this;
    this.style = { setProperty(k, v) { self.style[k] = v; }, removeProperty(k) { delete self.style[k]; } };
    // DOMTokenList.add/remove are variadic — the module calls
    // classList.add('zwp-mount', 'zwp-open') in one go.
    this.classList = {
      add: (...cs) => cs.forEach(c => { if (!self.className.split(/\s+/).includes(c)) self.className = (self.className + ' ' + c).trim(); }),
      remove: (...cs) => cs.forEach(c => { self.className = self.className.split(/\s+/).filter(x => x && x !== c).join(' '); }),
      contains: (c) => self.className.split(/\s+/).includes(c),
    };
  }
  set innerHTML(v) { if (v === '') { this.children.forEach(c => (c.parentElement = null)); this.children = []; } this._html = v; }
  get innerHTML() { return this._html || ''; }
  get firstChild() { return this.children[0] || null; }
  appendChild(n) { if (n.parentElement) n.parentElement.removeChild(n); n.parentElement = this; this.children.push(n); return n; }
  removeChild(n) { const i = this.children.indexOf(n); if (i > -1) { this.children.splice(i, 1); n.parentElement = null; } return n; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  removeAttribute(k) { delete this._attrs[k]; }
  addEventListener(t, fn) { (this._on[t] = this._on[t] || []).push(fn); }
  removeEventListener(t, fn) { this._on[t] = (this._on[t] || []).filter(f => f !== fn); }
  dispatch(t, ev) { (this._on[t] || []).forEach(fn => fn(Object.assign({ type: t, preventDefault() {}, stopPropagation() {} }, ev))); }
  focus() { doc.activeElement = this; }
  _walk(out) { this.children.forEach(c => { out.push(c); c._walk(out); }); return out; }
  _matchCompound(sel) {
    if (sel.startsWith('.')) return sel.slice(1).split('.').every(c => this.classList.contains(c));
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    return this.tagName === sel.toUpperCase();
  }
  // Enough of a selector engine for the module's own queries: comma lists and
  // descendant combinators ('.zwp-code code').
  matches(sel) {
    return sel.split(',').some(part => {
      const steps = part.trim().split(/\s+/);
      if (!this._matchCompound(steps.pop())) return false;
      let node = this.parentElement;
      while (steps.length) {
        const want = steps.pop();
        while (node && !node._matchCompound(want)) node = node.parentElement;
        if (!node) return false;
        node = node.parentElement;
      }
      return true;
    });
  }
  querySelectorAll(sel) {
    return this._walk([]).filter(n => { try { return n.matches(sel); } catch (_) { return false; } });
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  contains(n) { return n === this || this._walk([]).includes(n); }
}

function makeDoc() {
  const d = new El('body');
  d.readyState = 'complete';
  d.body = d;
  d.head = new El('head');
  d.documentElement = new El('html');
  d.createElement = (t) => new El(t);
  d.activeElement = null;
  d.dataset = {};
  d.body.dataset = {};
  d._docOn = {};
  d.addEventListener = function (t, fn) { (d._docOn[t] = d._docOn[t] || []).push(fn); };
  d.dispatchEvent = function (ev) { (d._docOn[ev.type] || []).forEach(fn => fn(ev)); return true; };
  d.getElementById = function (id) {
    return d._walk([]).find(n => n.id === id) || d.head._walk([]).find(n => n.id === id) || null;
  };
  d.querySelectorAll = function (sel) {
    return El.prototype.querySelectorAll.call(d, sel);
  };
  return d;
}
const doc = makeDoc();

function mem() {
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
    _all: m,
  };
}

let fetchCalls = [];
let claimResponse = { ok: true, code: 'WELCOME4K7QP' };

function boot(settingsValue, opts) {
  opts = opts || {};
  fetchCalls = [];
  doc.children = [];
  doc.head.children = [];
  const win = {
    matchMedia: (q) => ({ matches: opts.mobile ? /max-width/.test(q) : false, addEventListener() {}, addListener() {} }),
    addEventListener() {}, removeEventListener() {},
    scrollY: 0, innerHeight: 800,
    __zwPopupNoAutoOpen: opts.autoOpen !== true,
  };
  const ls = mem(), ss = mem();
  if (opts.seed) Object.keys(opts.seed).forEach(k => ls.setItem(k, opts.seed[k]));

  const fetchStub = (url, init) => {
    fetchCalls.push({ url, init });
    if (String(url).indexOf('/api/popup-claim') > -1) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(claimResponse) });
    }
    // /api/popup-config — the config comes through the API now, not a direct
    // Supabase read: 'email_popup' was never added to the anon-read allow-list,
    // so the old path returned nothing on the live site and the popup silently
    // stayed on its defaults.
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, config: settingsValue === undefined ? null : settingsValue }) });
  };

  const src = fs.readFileSync(SRC, 'utf8');
  new Function('window', 'document', 'localStorage', 'sessionStorage', 'fetch', 'location', 'navigator', 'CustomEvent', 'setTimeout', 'clearTimeout', src)(
    win, doc, ls, ss, fetchStub, { pathname: opts.path || '/' }, { clipboard: null },
    function CustomEventStub(type, init) { return { type, detail: (init || {}).detail }; },
    (fn, ms) => setTimeout(fn, opts.realTimers ? ms : 0),
    clearTimeout
  );
  return { P: win.ZWEmailPopup, ls, ss, win };
}

const wait = (ms) => new Promise(r => setTimeout(r, ms || 5));

(async function run() {
  console.log('\n  email-popup.js\n');

  /* ── 1. normalising ─────────────────────────────────────────────────────── */
  console.log('  config');
  {
    const { P } = boot(null);
    const c = P.normalize({});
    ok('empty config fills every default', Object.keys(P.DEFAULTS).every(k => c[k] !== undefined));
    ok('defaults to switched off', c.enabled === false);
    const half = P.normalize({ enabled: true, heading: 'Hi', discount: { value: 25 } });
    ok('a half-written config keeps its own values', half.heading === 'Hi' && half.discount.value === 25);
    ok('…and fills the rest', half.discount.type === 'percent' && half.discount.prefix === 'WELCOME');
    ok('junk layout falls back to centre', P.normalize({ layout: 'sideways' }).layout === 'center');
    ok('discount value cannot go negative', P.normalize({ discount: { value: -50 } }).discount.value === 0);
    ok('code is normalised to promo format', P.normalize({ discount: { code: ' we!lcome-10 ' } }).discount.code === 'WELCOME-10');
    const custom = P.normalize({ rules: { pages: { mycustompage: false } } });
    ok('a custom page key survives normalising', custom.rules.pages.mycustompage === false);
  }

  /* ── 2. the six orientations ────────────────────────────────────────────── */
  console.log('\n  orientations');
  {
    const { P } = boot(null);
    ok('exposes exactly six', P.LAYOUTS.length === 6, P.LAYOUTS.join(','));
    const blocking = { center: 1, split: 1, full: 1, drawer: 1 };
    P.LAYOUTS.forEach(function (layout) {
      P.open({ enabled: true, layout: layout, image: { url: 'x.jpg' } }, { preview: true });
      const root = doc.getElementById('zw-email-popup');
      const card = root.querySelector('.zwp-card');
      const isDialog = card.getAttribute('role') === 'dialog';
      ok(layout + ': renders, mounted + open, ' + (blocking[layout] ? 'is a dialog' : 'is not a dialog'),
        root.getAttribute('data-layout') === layout &&
        root.classList.contains('zwp-mount') && root.classList.contains('zwp-open') &&
        isDialog === !!blocking[layout],
        'role=' + card.getAttribute('role'));
      P.close();
    });
    P.open({ enabled: true, layout: 'split', image: { url: 'photo.jpg' } }, { preview: true });
    ok('a photo sets data-has-media', doc.getElementById('zw-email-popup').getAttribute('data-has-media') === '1');
    P.open({ enabled: true, layout: 'split', image: { url: '' } }, { preview: true });
    ok('no photo clears it (CSS drops the empty column)', doc.getElementById('zw-email-popup').getAttribute('data-has-media') === '0');
    P.close();
  }

  /* ── 3. copy, logo, theme ───────────────────────────────────────────────── */
  console.log('\n  content');
  {
    const { P } = boot(null);
    P.open({
      enabled: true, heading: 'Take 15% off', sub: 'Sub line', button: 'Claim it',
      theme: 'light', logo: { on: true, url: '/logo.png', height: 52 },
    }, { preview: true });
    const root = doc.getElementById('zw-email-popup');
    ok('headline is painted', root.querySelector('.zwp-title').textContent === 'Take 15% off');
    ok('button label is painted', root.querySelector('.zwp-btn').textContent === 'Claim it');
    ok('theme choice reaches the root', root.getAttribute('data-theme') === 'light');
    const logo = root.querySelector('.zwp-logo');
    ok('logo shows at the set height', logo.src === '/logo.png' && logo.style.height === '52px');
    P.open({ enabled: true, logo: { on: false, url: '/logo.png' } }, { preview: true });
    ok('logo off hides it', root.querySelector('.zwp-logo').style.display === 'none');
    P.close();
  }

  /* ── 4. who sees it ─────────────────────────────────────────────────────── */
  console.log('\n  gating');
  {
    let r = boot(null);
    ok('off by default → blocked as "disabled"', r.P.blockedReason(r.P.normalize({})) === 'disabled');
    ok('switched on → nothing blocks it', r.P.blockedReason(r.P.normalize({ enabled: true })) === '');

    r = boot(null, { seed: { zw_popup_done: '1' } });
    ok('someone who already signed up never sees it again',
      r.P.blockedReason(r.P.normalize({ enabled: true })) === 'already signed up');

    r = boot(null, { seed: { zw_popup_seen: String(Date.now() - 2 * 86400000) } });
    ok('seen 2 days ago, 30-day gap → blocked',
      r.P.blockedReason(r.P.normalize({ enabled: true, rules: { frequencyDays: 30 } })) === 'seen recently');
    ok('seen 2 days ago, 1-day gap → allowed',
      r.P.blockedReason(r.P.normalize({ enabled: true, rules: { frequencyDays: 1 } })) === '');

    r = boot(null, { mobile: true });
    ok('phone excluded → blocked on a phone',
      r.P.blockedReason(r.P.normalize({ enabled: true, rules: { devices: { mobile: false, desktop: true } } })) === 'device off');
    ok('desktop excluded → still fine on a phone',
      r.P.blockedReason(r.P.normalize({ enabled: true, rules: { devices: { mobile: true, desktop: false } } })) === '');

    r = boot(null, { path: '/checkout.html' });
    ok('checkout is off by default', r.P.blockedReason(r.P.normalize({ enabled: true })) === 'page off');
    r = boot(null, { path: '/confirm.html' });
    ok('the confirmation page is off by default', r.P.blockedReason(r.P.normalize({ enabled: true })) === 'page off');
    r = boot(null, { path: '/product.html' });
    ok('product pages are on by default', r.P.blockedReason(r.P.normalize({ enabled: true })) === '');
    r = boot(null, { path: '/some-new-page.html' });
    ok('an unlisted page follows the "any other page" rule',
      r.P.blockedReason(r.P.normalize({ enabled: true })) === '' &&
      r.P.blockedReason(r.P.normalize({ enabled: true, rules: { pages: { other: false } } })) === 'page off');

    r = boot(null);
    ok('asking the question does not advance the page counter',
      r.P.blockedReason(r.P.normalize({ enabled: true, trigger: { minViews: 2 } })) === 'not enough page views' &&
      r.P.blockedReason(r.P.normalize({ enabled: true, trigger: { minViews: 2 } })) === 'not enough page views');
  }

  /* ── 5. submitting ──────────────────────────────────────────────────────── */
  console.log('\n  submit');
  {
    const { P, ls, ss } = boot(null);
    P.open({ enabled: true, mode: 'discount' }, {});
    const root = doc.getElementById('zw-email-popup');
    const form = root.querySelector('.zwp-form');
    const input = root.querySelector('.zwp-input');
    const before = fetchCalls.length;

    // The rejection has to say what is wrong and what to do — and it has to be
    // the popup's own message, not the browser's "Please fill out this field",
    // which the form's novalidate now gets out of the way.
    input.value = '';
    form.dispatch('submit');
    await wait();
    const emptyMsg = root.querySelector('.zwp-err').textContent;
    ok('an empty box gets a useful prompt, not a scold',
      /email/i.test(emptyMsg) && !/fill out this field/i.test(emptyMsg) && fetchCalls.length === before, emptyMsg);

    input.value = 'not-an-email';
    form.dispatch('submit');
    await wait();
    const noAt = root.querySelector('.zwp-err').textContent;
    ok('a missing @ says so, and shows the shape', /@/.test(noAt) && /example\.com/.test(noAt), noAt);

    input.value = 'someone@nowhere';
    form.dispatch('submit');
    await wait();
    ok('an incomplete domain says where to look', /typo/i.test(root.querySelector('.zwp-err').textContent));

    ok('none of those called the server', fetchCalls.length === before);
    ok('the form is novalidate so the browser bubble cannot pre-empt us',
      root.querySelector('.zwp-form').getAttribute('novalidate') === 'novalidate');

    input.value = 'Shopper@Example.com';
    form.dispatch('submit');
    await wait(20);
    const claim = fetchCalls.filter(c => String(c.url).indexOf('/api/popup-claim') > -1)[0];
    ok('a good address posts to /api/popup-claim', !!claim);
    ok('…sending only the email and a source',
      claim && Object.keys(JSON.parse(claim.init.body)).sort().join(',') === 'email,source',
      claim && claim.init.body);
    ok('the code is shown', root.querySelector('.zwp-code code').textContent === 'WELCOME4K7QP');
    ok('the card flips to its success state', root.querySelector('.zwp-card').classList.contains('zwp-is-done'));
    ok('the code is handed to the bag/checkout promo box', ss.getItem('zw_promo_code') === 'WELCOME4K7QP');
    ok('this browser is marked done, so it never asks again', ls.getItem('zw_popup_done') === '1');
  }

  /* ── 6. signup-only mode + preview ──────────────────────────────────────── */
  console.log('\n  signup-only + preview');
  {
    claimResponse = { ok: true };                     // server returns no code
    const { P, ss } = boot(null);
    P.open({ enabled: true, mode: 'signup', successSignup: 'Thanks!' }, {});
    const root = doc.getElementById('zw-email-popup');
    root.querySelector('.zwp-input').value = 'a@b.com';
    root.querySelector('.zwp-form').dispatch('submit');
    await wait(20);
    ok('no code → no code box', root.querySelector('.zwp-code').style.display === 'none');
    ok('no code → the no-discount thank-you is used', root.querySelector('.zwp-done .zwp-sub').textContent === 'Thanks!');
    ok('nothing is pushed at the promo box', ss.getItem('zw_promo_code') === null);
    claimResponse = { ok: true, code: 'WELCOME4K7QP' };
  }
  {
    const { P, ls } = boot(null);
    const calls = fetchCalls.length;
    P.open({ enabled: true }, { preview: true });
    const root = doc.getElementById('zw-email-popup');
    root.querySelector('.zwp-input').value = 'admin@store.com';
    root.querySelector('.zwp-form').dispatch('submit');
    await wait(20);
    ok('previewing never records a "seen" timestamp', ls.getItem('zw_popup_seen') === null);
    ok('previewing never subscribes anyone',
      fetchCalls.slice(calls).every(c => String(c.url).indexOf('/api/popup-claim') === -1));
  }

  /* ── 7. reads its config from site_settings ─────────────────────────────── */
  console.log('\n  settings');
  {
    const { P } = boot({ enabled: true, heading: 'From the database', layout: 'drawer' });
    await wait(20);
    ok('config comes from the stored settings', P.get().heading === 'From the database' && P.get().layout === 'drawer');
    ok('…read through /api/popup-config, not straight from Supabase',
      fetchCalls.some(c => String(c.url).indexOf('/api/popup-config') > -1) &&
      !fetchCalls.some(c => /supabase\.co/.test(String(c.url))),
      fetchCalls.map(c => c.url).join(' | '));
    const { P: P2 } = boot(undefined);       // no row at all
    await wait(20);
    ok('no row → defaults, and stays off', P2.get().enabled === false);
  }

  /* ── 8. people whose email the store already has ────────────────────────── */
  console.log('\n  context awareness');
  {
    const session = JSON.stringify({ user: { email: 'customer@example.com' } });
    const legacy = JSON.stringify({ currentSession: { user: { email: 'customer@example.com' } } });

    let r = boot(null, { seed: { 'zuwera-auth': session } });
    ok('a signed-in customer is not asked for an email we have',
      r.P.blockedReason(r.P.normalize({ enabled: true })) === 'we already have their email — signed in');
    ok('…and the older session shape is recognised too',
      boot(null, { seed: { 'zuwera-auth': legacy } }).P.knownVisitor() === 'signed in');

    r = boot(null, { seed: { zw_known_email: '1' } });
    ok('someone who used a newsletter form is skipped',
      r.P.blockedReason(r.P.normalize({ enabled: true })) === 'we already have their email — already on the list');

    r = boot(null, { seed: { 'zuwera-auth': session } });
    ok('turning the rule off shows it to them anyway',
      r.P.blockedReason(r.P.normalize({ enabled: true, rules: { skipKnown: false } })) === '');
    ok('the rule is on by default', r.P.DEFAULTS.rules.skipKnown === true);

    r = boot(null, { seed: { 'zuwera-auth': 'not json at all' } });
    ok('a corrupt session is not treated as a known customer', r.P.knownVisitor() === '');
    r = boot(null, { seed: { 'zuwera-auth': JSON.stringify({ user: {} }) } });
    ok('a session with no email is not treated as known', r.P.knownVisitor() === '');

    r = boot(null);
    ok('an anonymous visitor is not skipped', r.P.knownVisitor() === '');
    r.P.markKnown();
    ok('markKnown() is the shared hook the other capture points use',
      r.P.knownVisitor() === 'already on the list' && r.ls.getItem('zw_known_email') === '1');

    // Signing up through the popup itself must set it too.
    const r2 = boot(null);
    r2.P.open({ enabled: true, mode: 'discount' }, {});
    const root2 = doc.getElementById('zw-email-popup');
    root2.querySelector('.zwp-input').value = 'buyer@example.com';
    root2.querySelector('.zwp-form').dispatch('submit');
    await wait(20);
    ok('signing up through the popup marks the visitor known', r2.ls.getItem('zw_known_email') === '1');
  }

  /* ── 9. the admin viewer draws the real thing ───────────────────────────── */
  console.log('\n  viewer');
  {
    const { P } = boot(null);
    const frame = makeDoc();
    const out = P.renderInto(frame, { enabled: true, heading: 'Viewer test', layout: 'drawer' });
    ok('renders into a foreign document', !!out && frame._walk([]).indexOf(out) > -1);
    ok('…with the real markup and config',
      out.getAttribute('data-layout') === 'drawer' &&
      out.querySelector('.zwp-title').textContent === 'Viewer test');
    ok('…already open, so the frame shows it without a trigger',
      out.classList.contains('zwp-mount') && out.classList.contains('zwp-open'));
    ok('…and pulls in the stylesheet', !!frame.getElementById('zwp-css'));

    const done = P.renderInto(makeDoc(), { enabled: true, mode: 'discount', discount: { source: 'shared', code: 'WELCOME10' } }, { done: true });
    ok('can show the post-signup state', done.querySelector('.zwp-card').classList.contains('zwp-is-done'));
    ok('…with the code that would be handed out', done.querySelector('.zwp-code code').textContent === 'WELCOME10');
    const uniq = P.renderInto(makeDoc(), { enabled: true, mode: 'discount', discount: { source: 'unique', prefix: 'HELLO' } }, { done: true });
    ok('…and a representative code for per-person mode', /^HELLO/.test(uniq.querySelector('.zwp-code code').textContent));

    // The live popup must be untouched by any of that.
    P.open({ enabled: true, heading: 'Live one' }, { preview: true });
    const live = doc.getElementById('zw-email-popup');
    ok('the live popup is unaffected by rendering previews',
      live && live.querySelector('.zwp-title').textContent === 'Live one');
    const before = frame._docOn && Object.keys(frame._docOn).length;
    P.renderInto(frame, { enabled: true });
    ok('previews stay inert — no handlers bound into the frame',
      (Object.keys(frame._docOn || {}).length) === (before || 0));
    ok('a redraw does not stack a second preview',
      frame.querySelectorAll('.zwp-root').length >= 1);
  }

  /* ── 10. the extra triggers ─────────────────────────────────────────────── */
  console.log('\n  triggers');
  {
    const { P } = boot(null);
    const t = P.normalize({}).trigger;
    ok('defaults keep the original three', t.delay === 8 && t.scroll === 0 && t.exitIntent === true);
    ok('idle / return / back exist and are off by default',
      t.idle === 0 && t.onReturn === false && t.onBack === false);
    const set = P.normalize({ trigger: { idle: '45', onReturn: true, onBack: true } }).trigger;
    ok('idle seconds are coerced from the form string', set.idle === 45);
    ok('the moment toggles round-trip', set.onReturn === true && set.onBack === true);
    ok('a negative idle is floored, not accepted', P.normalize({ trigger: { idle: -5 } }).trigger.idle === 0);

    // With every trigger off the popup must still be reachable, or an admin who
    // clears the fields gets a popup that can never open.
    const none = P.normalize({ enabled: true, trigger: { delay: 0, scroll: 0, exitIntent: false, idle: 0, onReturn: false, onBack: false } });
    ok('all triggers off still leaves a fallback', none.trigger.delay === 0 && P.blockedReason(none) === '');
  }

  /* ── 11. previews must not freeze the page they are shown on ────────────── */
  console.log('\n  preview scroll lock');
  {
    const { P } = boot(null);
    P.open({ enabled: true, layout: 'center' }, { preview: true });
    const card = doc.getElementById('zw-email-popup').querySelector('.zwp-card');
    ok('a preview is still a real dialog for the reader', card.getAttribute('role') === 'dialog');
    ok('…but opts out of the scroll lock so the admin page still scrolls',
      card.getAttribute('data-zw-nolock') === '1');

    P.close();
    P.open({ enabled: true, layout: 'center' }, {});
    const live = doc.getElementById('zw-email-popup').querySelector('.zwp-card');
    ok('the real popup on the storefront still locks scroll', live.getAttribute('data-zw-nolock') === null);

    const lock = fs.readFileSync(ROOT + '/modal-lock.js', 'utf8');
    ok('modal-lock honours the opt-out', /\[role="dialog"\][^']*:not\(\[data-zw-nolock\]\)/.test(lock));
  }

  /* ── 12. the admin viewer can be clicked through ────────────────────────── */
  console.log('\n  interactive preview');
  {
    const { P, ls, ss } = boot(null);
    const events = [];
    const frame = makeDoc();
    const cfg = { enabled: true, mode: 'discount', discount: { source: 'shared', code: 'WELCOME10' } };
    let out = P.renderInto(frame, cfg, { interactive: true, onEvent: (w) => events.push(w) });

    // Sign-up: shows the success state and reports it, without any network call
    // or anything written to storage.
    const before = fetchCalls.length;
    out.querySelector('.zwp-input').value = 'shopper@example.com';
    out.querySelector('.zwp-form').dispatch('submit');
    await wait();
    ok('signing up in the preview shows the success state',
      out.querySelector('.zwp-card').classList.contains('zwp-is-done'));
    ok('…with the code that would really be handed out',
      out.querySelector('.zwp-code code').textContent === 'WELCOME10');
    ok('…and reports it back to the admin', events.join() === 'signed-up');
    ok('…without calling the server', fetchCalls.length === before);
    ok('…without subscribing anyone or marking the browser done',
      ls.getItem('zw_popup_done') === null && ss.getItem('zw_promo_code') === null);

    // Bad input still gets the real message, so the preview shows real rejections.
    const f2 = makeDoc();
    const o2 = P.renderInto(f2, cfg, { interactive: true, onEvent: () => {} });
    o2.querySelector('.zwp-input').value = 'nope';
    o2.querySelector('.zwp-form').dispatch('submit');
    await wait();
    ok('a bad address in the preview gets the real rejection copy',
      /@/.test(o2.querySelector('.zwp-err').textContent));

    // Dismissals.
    const f3 = makeDoc();
    const ev3 = [];
    const o3 = P.renderInto(f3, cfg, { interactive: true, onEvent: (w) => ev3.push(w) });
    o3.querySelector('.zwp-decline').dispatch('click');
    ok('"No thanks" closes it and reports declined',
      ev3.join() === 'declined' && !o3.classList.contains('zwp-open'));

    const f4 = makeDoc();
    const ev4 = [];
    const o4 = P.renderInto(f4, cfg, { interactive: true, onEvent: (w) => ev4.push(w) });
    o4.querySelector('.zwp-close').dispatch('click');
    ok('the X closes it and reports closed', ev4.join() === 'closed');

    // And a NON-interactive preview stays inert, so the default viewer cannot
    // be clicked by accident.
    const f5 = makeDoc();
    const o5 = P.renderInto(f5, cfg, {});
    o5.querySelector('.zwp-decline').dispatch('click');
    ok('a non-interactive preview ignores clicks', o5.classList.contains('zwp-open'));

    // The live popup is untouched by any of it.
    P.open({ enabled: true, heading: 'Live' }, { preview: true });
    ok('the live popup is unaffected by interactive previews',
      doc.getElementById('zw-email-popup').querySelector('.zwp-title').textContent === 'Live');
  }

  /* ── 13. the viewer cannot go stale ─────────────────────────────────────── */
  console.log('\n  the viewer mirrors the form');
  {
    const admin = fs.readFileSync(ROOT + '/admin-main.js', 'utf8');
    ok('a watcher redraws on ANY change, not just typed ones',
      /_popLastSerialised/.test(admin) && /JSON\.stringify\(popupReadForm\(\)\)/.test(admin));
    ok('…which is what catches an image upload writing the field directly',
      /urlInput\.value = upload\.url/.test(admin));
    ok('the frame is only clickable when asked', /pointerEvents = interactive \? 'auto' : 'none'/.test(admin));

    const html = fs.readFileSync(ROOT + '/admin.html', 'utf8');
    ok('all four outcomes are shown', ['ask', 'done', 'declined', 'closed']
      .every(s => new RegExp('data-popstate="' + s + '"').test(html)));
    ok('there is an interactive toggle', /id="popViewInteractive"/.test(html));
    ok('saving reports in colour', /id="popSaveMsg"/.test(html) && /#4ade80/.test(admin) && /#ef4444/.test(admin));
  }

  console.log('\n  the logo sits where it is told');
  {
    /* .zwp-body is a flex COLUMN, so its cross axis is horizontal and the
       default align-items:stretch applied to WIDTH. The input and button want
       that; an <img> did not. Stretch beat `width:auto`, the logo box grew to
       its full 60% allowance, and object-fit:contain centred the artwork inside
       that left-pinned box — so a logo centred in its box read as off-centre in
       the popup, and nothing could move it because nothing was misaligned. */
    const css = fs.readFileSync(ROOT + '/email-popup.css', 'utf8');
    ok('the logo box hugs its artwork instead of stretching',
      /\.zwp-logo \{[^}]*align-self: flex-start/.test(css),
      'without this the box is 60% wide and the logo only looks centred');
    ok('…and the centred layout still centres it',
      /data-layout="full"\]:not\(\[data-has-media="1"\]\) \.zwp-logo \{ align-self: center/.test(css));

    const src = fs.readFileSync(SRC, 'utf8');
    ok('alignment is a setting with a default that changes nothing',
      /align: 'auto'/.test(src) && /\['auto', 'left', 'center', 'right'\]/.test(src));
    ok('…mapped to flex values, because the logo is a flex item not text',
      /LOGO_ALIGN = \{ left: 'flex-start', center: 'center', right: 'flex-end' \}/.test(src));
    ok('…and auto writes nothing, so the stylesheet decides',
      /LOGO_ALIGN\[c\.logo\.align\] \|\| ''/.test(src),
      'writing any value here would beat the per-layout rule');

    const admin = fs.readFileSync(ROOT + '/admin-main.js', 'utf8');
    ok('the admin round-trips it', /set\('popLogoAlign', c\.logo\.align\)/.test(admin) &&
      /align: val\('popLogoAlign'\)/.test(admin));
    ok('…with a control to set it', /id="popLogoAlign"/.test(fs.readFileSync(ROOT + '/admin.html', 'utf8')));
  }

  console.log('\n  the same control for the emails');
  {
    /* Verified by rendering the real shell rather than reading the source: an
       email's alignment has to survive three different rendering engines, and a
       regex proving the string is present proves none of them. */
    const { execFileSync } = require('child_process');
    const script = `
      const { pathToFileURL } = require('node:url');
      import(pathToFileURL(${JSON.stringify(ROOT + '/functions/api/_email-theme.js')}).href).then((m) => {
        const out = ['center', 'left', 'right', undefined, 'bogus'].map((v) => {
          const a = m.getEmailAppearance({ email_settings: { logoAlign: v }, BRAND_LOGO_URL: 'https://x/l.png' });
          const html = m.renderEmailShell(a, { heading: 'Hi' });
          const td = html.match(/<td align="([^"]*)" style="padding:28px[^"]*text-align:([^;]*);/) || [];
          const mg = (html.match(/border:0;display:block;margin:([^;]*);/) || [])[1];
          return [String(v), a.logoAlign, mg, td[1], td[2]].join('|');
        });
        console.log(JSON.stringify(out));
      });`;
    let rows = [];
    try {
      rows = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    } catch (_) { /* leaves rows empty → the assertions below fail loudly */ }
    const byInput = Object.fromEntries(rows.map((r) => [r.split('|')[0], r.split('|')]));
    const expect = {
      center: ['center', '0 auto'],
      left:   ['left',   '0'],
      right:  ['right',  '0 0 0 auto'],
      undefined: ['center', '0 auto'],   // nothing saved yet
      bogus:     ['center', '0 auto'],   // anything unrecognised
    };
    for (const [input, [align, margin]] of Object.entries(expect)) {
      const r = byInput[input];
      ok('a logoAlign of ' + input + ' renders ' + align,
        !!r && r[1] === align && r[2] === margin,
        r ? 'got align=' + r[1] + ' margin=' + r[2] : 'the shell did not render');
      /* Outlook's Word engine honours neither margin:auto nor text-align on the
         cell, so the legacy align attribute has to agree too or the logo moves
         for a slice of recipients and nobody can reproduce it. */
      ok('…and all three signals agree for ' + input,
        !!r && r[3] === align && r[4] === align,
        r ? 'cell align=' + r[3] + ' text-align=' + r[4] : 'the shell did not render');
    }

    const admin = fs.readFileSync(ROOT + '/admin-main.js', 'utf8');
    ok('the email admin round-trips it',
      /_emailCfg\.logoAlign = /.test(admin) && /getElementById\('em-logo-align'\)/.test(admin));
    ok('…and the live preview shows it before saving',
      /payload\.logoAlign = laSel\.value/.test(admin) &&
      /es\.logoAlign = la;/.test(fs.readFileSync(ROOT + '/functions/api/email-preview.js', 'utf8')),
      'the endpoint has to accept the override or the preview silently ignores it');
    ok('…with a control to set it', /id="em-logo-align"/.test(fs.readFileSync(ROOT + '/admin.html', 'utf8')));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
