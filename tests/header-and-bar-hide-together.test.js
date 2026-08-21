/* The header and the announcement bar are ONE strip of chrome.
 *
 * They are driven by two files — header-scroll.js owns the nav, announcement-
 * bar.js owns the bar — and the coordination between them had a hole in it.
 * header-scroll refused to hide the header while the bar was on screen, which
 * is right when the bar is about to leave on its own and a deadlock when it
 * isn't. "Always visible" is the bar's default and the live setting, so
 * Settings → Header Scroll Behavior → Auto-hide did NOTHING on the home and
 * product pages: two options where only one behaviour existed.
 *
 * THE RULES THIS FILE HOLDS:
 *
 *   1. The bar announces which of the two moves first, on the element, because
 *      header-scroll.js runs BEFORE announcement-bar.js and reads it at scroll
 *      time. A load-time flag would be read before it was written.
 *        'self'   — the bar has its own scroll rule; the header waits for it.
 *        'chrome' — the bar is static; the header carries it away.
 *   2. Auto-hide hides the header whatever the bar is doing.
 *   3. Pinned hides neither.
 *   4. A bar carried off by the header keeps its reserved height, so nothing in
 *      flow moves. Only the bar's OWN scroll-hide collapses the spacer, because
 *      only then did anyone ask for the strip to leave.
 *   5. Policy is read separately from visibility. Once the header has carried a
 *      static bar away the bar is not visible, and a visibility test would then
 *      strand it there on the way back up.
 *
 * Both files are executed for real against a stub DOM — the fault was in what
 * they did at runtime, not in what they contained, and a source grep would have
 * been just as satisfied by the broken version.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  - ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const HDR_SRC = read('header-scroll.js');
const BAR_SRC = read('announcement-bar.js');

/* ── A DOM just big enough for these two files ─────────────────────────────── */
function makeWorld(opts) {
  const mobile = !!opts.mobile;
  const listeners = { window: [], document: [] };

  function style() {
    const s = { _p: {} };
    s.setProperty = (k, v) => { s._p[k] = v; };
    s.removeProperty = (k) => { delete s._p[k]; };
    return s;
  }
  function el(id, tag, cls) {
    const e = {
      id: id || '', tagName: (tag || 'div').toUpperCase(), className: cls || '',
      dataset: {}, style: style(), innerHTML: '', textContent: '',
      offsetHeight: id === 'bar' ? 26 : 0, offsetWidth: 0,
      _attrs: {},
      classList: {
        _s: new Set((cls || '').split(' ').filter(Boolean)),
        add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
        toggle(c, on) { if (on === undefined) on = !this._s.has(c); if (on) this._s.add(c); else this._s.delete(c); },
      },
      setAttribute(k, v) { e._attrs[k] = String(v); },
      removeAttribute(k) { delete e._attrs[k]; },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(e._attrs, k) ? e._attrs[k] : null; },
      appendChild() {}, insertBefore() {},
      addEventListener() {}, removeEventListener() {},
      getBoundingClientRect: () => ({ height: id === 'bar' ? 26 : 64, top: 0, bottom: 64 }),
      querySelector: () => null,
    };
    return e;
  }

  const nav = el('nav', 'nav');
  const bar = el('bar');
  const spacer = el('bar-spacer');
  const text = el('announcementText', 'span');
  bar.style.display = 'none';   // what index.html ships in markup
  const byId = { nav, bar, 'bar-spacer': spacer, announcementText: text };

  const document = {
    readyState: 'interactive',            // deferred scripts run here: init() fires now
    documentElement: el('', 'html'),
    head: el('', 'head'),
    body: Object.assign(el('', 'body'), { dataset: {}, firstChild: null }),
    getElementById: (id) => byId[id] || null,
    querySelector: (sel) => (/nav#nav|nav\.nav|zw-nav|header\.nav|co-header/.test(sel) ? nav : null),
    createElement: (t) => el('', t),
    addEventListener: (t, f) => listeners.document.push([t, f]),
    removeEventListener: () => {},
  };

  const window = {
    document,
    scrollY: 0, pageYOffset: 0,
    location: { pathname: '/index.html' },
    matchMedia: (q) => ({ matches: /max-width:900px/.test(q.replace(/\s/g, '')) ? mobile : false }),
    getComputedStyle: (e) => ({
      display: e.style.display || 'flex',
      opacity: e.style.opacity === '' || e.style.opacity == null ? '1' : e.style.opacity,
      top: e.style.top || '0px',
    }),
    addEventListener: (t, f) => listeners.window.push([t, f]),
    removeEventListener: (t, f) => {
      const i = listeners.window.findIndex((p) => p[0] === t && p[1] === f);
      if (i >= 0) listeners.window.splice(i, 1);
    },
    requestAnimationFrame: (f) => { f(0); return 0; },
    setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
    localStorage: { _m: {}, getItem(k) { return this._m[k] == null ? null : this._m[k]; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } },
    Date, JSON, Promise, Math, String, Number, Object, Array, Error, console,
  };
  window.window = window;

  window.fetch = (url) => {
    const s = String(url);
    let row = null;
    if (s.indexOf('key=eq.announcement_bar') >= 0) row = [{ value: opts.bar }];
    else if (s.indexOf('key=eq.header_behavior') >= 0) row = [{ value: { mode: opts.hdr, pages: {} } }];
    return Promise.resolve({ ok: true, json: () => Promise.resolve(row || []) });
  };

  return { window, document, nav, bar, spacer, listeners };
}

async function drive(opts) {
  const w = makeWorld(opts);
  const ctx = vm.createContext(w.window);
  vm.runInContext(HDR_SRC, ctx);     // load order on every page: header first…
  vm.runInContext(BAR_SRC, ctx);     // …then the bar
  await new Promise((r) => setImmediate(r));   // let both settings fetches land
  await new Promise((r) => setImmediate(r));

  const scroll = (y) => {
    w.window.scrollY = y; w.window.pageYOffset = y;
    w.listeners.window.filter((p) => p[0] === 'scroll').forEach((p) => p[1]());
  };
  const state = () => ({
    header: w.nav.classList.contains('zw-nav-hidden') ? 'hidden' : 'shown',
    bar: w.bar.style.display === 'none' ? 'removed'
      : /translateY\(-100%\)/.test(w.bar.style.transform || '') ? 'slid-away'
        : parseFloat(w.bar.style.opacity || '1') === 0 ? 'faded' : 'shown',
    policy: w.bar.dataset.zwBarHide || '',
    spacer: w.spacer.style.height,
    navTop: w.nav.style.top,
    lift: w.nav.style._p['--zw-nav-lift'],
  });
  return { scroll, state, w };
}

const MSG = { message: 'FREE SHIPPING OVER $75' };
const settle = () => new Promise((r) => setTimeout(r, 400));   // the 340ms display:none

(async function () {
  console.log('\nheader + bar hide as one strip\n');

  /* ── 1 · the deadlock ───────────────────────────────────────────────────── */
  {
    const d = await drive({ bar: Object.assign({ mode: 'on' }, MSG), hdr: 'auto-hide' });
    ok('a static bar announces itself as chrome', d.state().policy === 'chrome', 'got "' + d.state().policy + '"');
    ok('bar shows at rest', d.state().bar === 'shown');

    d.scroll(400); d.scroll(900);
    ok('AUTO-HIDE HIDES THE HEADER even though the bar never hides itself',
      d.state().header === 'hidden', 'header stayed ' + d.state().header);
    // The header and the bar must start moving on the SAME tick. Reading this
    // before any timer runs is the point: the fault it replaces was a bar that
    // only left 340ms later, after the header had already gone.
    ok('the bar starts moving on the same tick, not on a timer',
      d.state().bar === 'slid-away', 'bar was ' + d.state().bar);
    ok('it SLIDES rather than blinking out — display:none while the header is '
      + 'still in flight is what read as the header leaving first',
      d.w.bar.style.display !== 'none' && /transform/.test(d.w.bar.style.transition || ''),
      'display=' + d.w.bar.style.display + ' transition=' + d.w.bar.style.transition);
    // How the header clears a viewport it starts a bar's height down: the
    // offset is added to the hidden transform, NOT animated as `top`. Animating
    // top ran the layout for every frame of the slide, against a composited
    // transform on a different duration and curve — two motions of different
    // lengths pulling one element, which is what read as slow and choppy.
    ok('the header leaves on ONE property: `top` is not touched',
      d.state().navTop === '25px', 'navTop=' + d.state().navTop);
    ok('the travel it needs is published as --zw-nav-lift for the transform',
      d.state().lift === '25px', 'lift=' + d.state().lift);
    await settle();
    ok('and it is still not removed once the timers have run',
      d.state().bar === 'slid-away', 'bar became ' + d.state().bar);
    ok('the reserved height stays, so nothing in flow jumps',
      d.w.spacer.style.height === '25px', 'spacer=' + d.w.spacer.style.height);

    d.scroll(600);
    ok('scrolling up brings the header back', d.state().header === 'shown');
    ok('…and the bar with it', d.state().bar === 'shown', 'bar was ' + d.state().bar);
    ok('the nav never left its resting top through either direction',
      d.state().navTop === '25px', 'navTop=' + d.state().navTop);
  }

  /* ── 2 · a bar with its own rule still goes first ───────────────────────── */
  {
    const d = await drive({ bar: Object.assign({ mode: 'scroll' }, MSG), hdr: 'auto-hide' });
    ok('a scroll-mode bar announces itself as self', d.state().policy === 'self', 'got "' + d.state().policy + '"');

    // The bar ignores scrolls for its first 150ms — a page that loads already
    // scrolled must not have the strip snap away under the reader.
    await settle();

    d.scroll(400);
    ok('the bar starts leaving', d.w.spacer.style.height === '0', 'spacer=' + d.w.spacer.style.height);
    ok('the header does NOT go before it', d.state().header === 'shown', 'header went first');
    await settle();   // the bar is only gone once its 340ms cover-and-remove lands

    d.scroll(900);
    ok('the header follows once the bar has gone', d.state().header === 'hidden');
    ok('its own hide DOES collapse the spacer', d.w.spacer.style.height === '0', 'spacer=' + d.w.spacer.style.height);
  }

  /* ── 3 · pinned hides neither ───────────────────────────────────────────── */
  {
    const d = await drive({ bar: Object.assign({ mode: 'on' }, MSG), hdr: 'pinned' });
    d.scroll(400); d.scroll(900);
    await settle();
    ok('pinned leaves the header alone', d.state().header === 'shown');
    ok('pinned leaves the bar alone too', d.state().bar === 'shown', 'bar was ' + d.state().bar);
  }

  /* ── 4 · no bar on the page ─────────────────────────────────────────────── */
  {
    const d = await drive({ bar: Object.assign({ mode: 'off' }, MSG), hdr: 'auto-hide' });
    ok('a bar that is off announces nothing', d.state().policy === '', 'got "' + d.state().policy + '"');
    d.scroll(400); d.scroll(900);
    ok('the header still auto-hides on its own', d.state().header === 'hidden');
  }

  /* ── 5 · mobile fades rather than sliding ───────────────────────────────── */
  {
    const d = await drive({ bar: Object.assign({ mode: 'on' }, MSG), hdr: 'auto-hide', mobile: true });
    d.scroll(400); d.scroll(900);
    ok('mobile: the header hides', d.state().header === 'hidden');
    ok('mobile: the static bar fades with it', d.state().bar === 'faded', 'bar was ' + d.state().bar);
    d.scroll(600);
    ok('mobile: both come back together', d.state().header === 'shown' && d.state().bar === 'shown');
  }

  /* ── 6 · the shape of the handshake ─────────────────────────────────────── */
  {
    const H = HDR_SRC.replace(/\r\n/g, '\n');
    ok('the header reads the bar from the DOM, not from a load-time flag',
      /bar\.dataset\.zwBarHide/.test(H) && !/window\.__zwBarPolicy/.test(H));
    ok('the wait applies only to a bar that hides itself',
      /barPolicy\(\) === 'self' && barIsShowing\(\)/.test(H));
    ok('reduced motion opts out of hiding rather than toggling a class nothing moves',
      /mode !== 'auto-hide' \|\| reduce/.test(H));

    /* One name, two files. A variable the stylesheet reads under one spelling
       and the script writes under another is a control that silently does
       nothing, and this codebase has already lost a day to exactly that. */
    const CSS = read('storefront-cohesion.css').replace(/\r\n/g, '\n');
    const B = BAR_SRC.replace(/\r\n/g, '\n');
    ok('the hidden-header transform reads the lift the bar writes',
      /translateY\(calc\(-110% - var\(--zw-nav-lift\)\)\)/.test(CSS)
      && /setProperty\('--zw-nav-lift'/.test(B));
    /* This used to require the fallback `var(--zw-nav-lift, 0px)`, and that
       fallback was the bug: clean-css turns a zero inside calc() into a bare
       `0` — every unit, and not as an option — which makes the subtraction
       invalid, drops the declaration, and leaves transform at its initial value
       of `none`. The header then did not move AT ALL on a phone, where there is
       no announcement bar to write the variable and the fallback was the only
       thing being read. Desktop was fine, which is why it went unnoticed.

       So the variable is DECLARED with a length instead, and the calc reads it
       with no fallback. tests/the-header-hides-on-a-phone-too.test.js checks the
       minified output, which is where this only ever existed. */
    /* Comments explain WHY the fallback is gone, so they necessarily quote it.
       Read the code, not the prose — the same rule the rest of this suite
       follows for absence assertions. */
    ok('...with no zero fallback for the minifier to strip the unit off',
      !/var\(--zw-nav-lift\s*,/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, '')),
      'a fallback of 0px, 0em, 0%, 0rem or 0vh all minify to a unitless 0');
    ok('...because the variable is declared with a length instead',
      /--zw-nav-lift:\s*0px;/.test(CSS));
    ok('and clears it where the bar sits BELOW the nav and there is nothing to clear',
      /removeProperty\('--zw-nav-lift'\)/.test(B));

    /* `top` still animates where it is a real layout change and not a way of
       moving something off screen: the bar's own scroll-hide, where the header
       rises into the space the bar vacates and stays there. */
    ok('the bar\'s own hide still raises the header into the space it leaves',
      /layout\(barEl, navEl, false\)/.test(B));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  if (fail) process.exit(1);
})();
