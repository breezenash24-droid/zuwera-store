/* The first paint is the right colour, on a COLD load.
 *
 * "Every time it loads it does this; if you refresh it fixes it."
 *
 * The pre-paint snippet in <head> read the cached theme and painted the page
 * BACKGROUND from it — but not the colour TOKENS, and not the body class. So a
 * light theme produced a light ground while every rule reading var(--fg-rgb)
 * still held the dark theme's near-white text, and every one of the hundreds of
 * `body.light-mode .thing` rules was inactive. Light text on a light page.
 *
 * theme-engine.js sets all of that correctly — it just runs too late. It is
 * `defer`, so on a SECOND load it is in HTTP cache and executes before first
 * contentful paint; on a cold load the paint wins. That is the entire
 * difference between "broken" and "a refresh fixes it", and it is why this
 * cannot be caught by looking at a warm browser.
 *
 * So: run the snippet the way the browser runs it — against a document with no
 * body yet — and check what the page would paint with.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const PAGES = ['404.html', 'about.html', 'account.html', 'bag.html', 'checkout.html',
  'confirm.html', 'drop001.html', 'index.html', 'journal.html', 'landing.html',
  'policies.html', 'product.html', 'returns.html', 'sizeguide.html'];

/* The light theme as theme-engine.js defines it. If these drift the snippet is
   painting colours the engine will immediately correct, which is the flash all
   over again. */
const LIGHT = { fg: '10 10 10', bg: '240 238 233', ink: '#F0EEE9', paper: '#09090b', surface: '#FFFFFF', accent: '#F891A5' };

/* A <head> with no <body>, which is exactly the state the snippet runs in. */
function coldPaint(html, cache, choice) {
  const props = {};
  const styleObj = {
    setProperty: (k, v) => { props[k] = v; },
    removeProperty: (k) => { delete props[k]; },
    set background(v) { props['background'] = v; },
    get background() { return props['background']; },
    set colorScheme(v) { props['color-scheme'] = v; },
    get colorScheme() { return props['color-scheme']; },
  };
  const attrs = {};
  const h = {
    style: styleObj,
    setAttribute: (k, v) => { attrs[k] = v; },
    /* The block asks what default the BUILD stamped before falling back. A stub
       without this throws inside the block's own try/catch, which swallows it
       and silently paints nothing — a test that would pass by doing nothing. */
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    classList: { toggle: () => {} },
  };

  const store = {};
  if (cache) store.zw_theme_modes = JSON.stringify(cache);
  if (choice) store.zw_theme_mode = choice;

  const listeners = [];
  const win = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: () => {} },
    document: {
      documentElement: h,
      body: null,                       // THE point: no body during <head>
      head: { appendChild: () => {} },
      createElement: () => ({ style: {}, setAttribute: () => {} }),
      addEventListener: (n, f) => listeners.push(f),
      querySelector: () => null,
    },
    JSON, Object, Array, String, Number, parseInt, parseFloat,
  };

  /* The theme block, lifted whole out of the page between its markers.
     This used to slice from a literal `var _tc=JSON.parse` to the next
     `}catch(_){}` — a lift keyed to the exact spelling of one line in a block
     that is now generated, so reformatting the source silently produced an
     empty slice and a suite that tested nothing. Markers are the boundary
     precisely because they do not move when the code inside does. */
  const OPEN = '/* zw:preboot */', CLOSE = '/* /zw:preboot */';
  const a = html.indexOf(OPEN), b = html.indexOf(CLOSE);
  if (a < 0 || b < a) throw new Error('no zw:preboot markers in the page under test');
  const src = html.slice(a + OPEN.length, b);
  new Function('h', 'localStorage', 'document', 'window', 'try{' + src + '}catch(e){throw e}')
    (h, win.localStorage, win.document, win);

  return { props, attrs, listeners, doc: win.document };
}

const themeCache = {
  default: 'light',
  modes: [
    { id: 'dark', base: 'dark', tokens: { fg: '244 241 235', bg: '9 9 11', ink: '#09090b', paper: '#f4f1eb', surface: '#111113', accent: '#F891A5' } },
    { id: 'light', base: 'light', tokens: LIGHT },
    { id: 'super-light', base: 'super-light', tokens: { ...LIGHT, bg: '255 255 255' } },
  ],
};

console.log('\n  the first paint is the right colour\n');

console.log('  a light theme, cold, no body yet');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const { props, attrs } = coldPaint(html, themeCache, 'light');

  ok('the ground is painted light', props['background'] === 'rgb(240 238 233)');
  /* THE BUG. Without these the text stayed the dark theme's near-white. */
  ok('the TEXT colour is painted too', props['--fg-rgb'] === LIGHT.fg,
    'got ' + JSON.stringify(props['--fg-rgb']) + ' — a light ground with dark-theme text is the reported symptom');
  ok('…and its older alias', props['--white'] === 'rgb(10 10 10)',
    '88 rules still read --white/--black rather than the ladder');
  ok('--ink and --paper are set', props['--ink'] === LIGHT.ink && props['--paper'] === LIGHT.paper);
  /* --zw-theme-surface, which is the name base.css declares and cart.css reads.
     This asserted `--surface`, and so it PASSED while the block wrote a token
     nothing on the storefront has ever looked at — the assertion and the code
     agreed with each other and both were wrong about the stylesheet. Checking a
     writer against another writer is not a check. */
  ok('--zw-theme-surface and --accent are set',
    props['--zw-theme-surface'] === LIGHT.surface && props['--accent'] === LIGHT.accent,
    'got ' + JSON.stringify(props['--zw-theme-surface']));
  ok('the colour scheme flips for native controls', props['color-scheme'] === 'light');
  ok('the base is recorded for anything that needs it', attrs['data-zw-base'] === 'light');
}

console.log('\n  the body class is applied at the first opportunity');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const { listeners, doc } = coldPaint(html, themeCache, 'light');
  ok('it waits rather than giving up when body is null', listeners.length > 0,
    'hundreds of rules are body.light-mode .thing and none fire without the class');

  const classes = new Set();
  doc.body = { classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } } };
  listeners.forEach((f) => f());
  ok('…and applies it the moment body exists', classes.has('light-mode'));
  ok('…without adding super-light to a plain light theme', !classes.has('super-light-mode'));
}

console.log('\n  super-light carries BOTH classes');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const { listeners, doc } = coldPaint(html, themeCache, 'super-light');
  const classes = new Set();
  doc.body = { classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } } };
  listeners.forEach((f) => f());
  ok('light-mode and super-light-mode together',
    classes.has('light-mode') && classes.has('super-light-mode'),
    'super-light is a narrowing of light, not a separate branch — this has caught this codebase before');
}

console.log('\n  a dark theme paints dark, and adds no light classes');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const { props, listeners, doc } = coldPaint(html, themeCache, 'dark');
  ok('the ground is dark', props['background'] === 'rgb(9 9 11)');
  ok('the text is the dark theme\'s', props['--fg-rgb'] === '244 241 235');
  /* It used to be left unset for dark, which means the UA default — light — so
     native controls, scrollbars and form widgets rendered light on a dark page
     until the engine loaded. Saying 'dark' out loud is the honest answer and
     costs nothing. */
  ok('colour-scheme says dark rather than leaving it to the UA', props['color-scheme'] === 'dark');
  const classes = new Set();
  doc.body = { classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } } };
  listeners.forEach((f) => f());
  ok('no light classes', !classes.has('light-mode') && !classes.has('super-light-mode'));
}

console.log('\n  nothing painted when there is nothing cached');
{
  /* A visitor's very first load has no cache. Painting a guess would be a
     flash in the other direction; the engine's fetch settles it. */
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const { props } = coldPaint(html, null, '');
  ok('no tokens are invented', !props['--fg-rgb'] && !props['background'],
    'guessing on a first-ever visit trades one flash for another');
}

console.log('\n  every storefront page got it');
{
  const missing = PAGES.filter((p) => !fs.readFileSync(path.join(ROOT, p), 'utf8').includes("h.style.setProperty('--fg-rgb'"));
  ok('all ' + PAGES.length + ' pages paint the tokens', missing.length === 0, 'missing: ' + missing.join(', '));

  const noClass = PAGES.filter((p) => !fs.readFileSync(path.join(ROOT, p), 'utf8').includes("classList.toggle('light-mode'"));
  ok('…and all of them set the body class', noClass.length === 0, 'missing: ' + noClass.join(', '));
}

console.log('\n  the snippet and the engine agree');
{
  /* If the snippet paints one thing and apply() another, the correction IS the
     flash — the bug moves rather than going away. */
  const engine = fs.readFileSync(path.join(ROOT, 'theme-engine.js'), 'utf8');
  for (const token of ['--fg-rgb', '--bg-rgb', '--ink', '--paper', '--black', '--white']) {
    ok('the engine sets ' + token + ' too', engine.includes(token));
  }
  ok('and toggles the same two classes',
    /classList\.toggle\('light-mode', theme\.base !== 'dark'\)/.test(engine)
    && /classList\.toggle\('super-light-mode', theme\.base === 'super-light'\)/.test(engine));
}

console.log('\n  the engine does not undo what the build stamped');
{
  /* THE BUG THIS CATCHES, and it is the reason "it still glitches on refresh".
     stamp-theme-default.js bakes light-mode onto <body> so the first frame is
     right for a visitor with no localStorage. theme-engine.js then ran with
     config.default = 'dark' — a guess, made before it has spoken to the
     database — and apply() called classList.toggle('light-mode', false), which
     STRIPPED the stamped class. The sequence on every cache-less load was:
     correct first paint, engine repaints it wrong, fetch puts it back. The
     stamp fixed the flash and the engine reintroduced it one step later.

     This RUNS the engine. The class list at the end is what a visitor sees. */
  const engineSrc = fs.readFileSync(path.join(ROOT, 'theme-engine.js'), 'utf8');

  const run = (bodyClasses, store) => {
    const classes = new Set(String(bodyClasses || '').split(/\s+/).filter(Boolean));
    const mkStyle = () => {
      const p = {};
      return { setProperty: (k, v) => { p[k] = v; }, removeProperty: (k) => { delete p[k]; },
               _p: p, backgroundColor: '', background: '' };
    };
    const classList = {
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
    };
    const body = { classList, style: mkStyle(), setAttribute: () => {}, removeAttribute: () => {} };
    const root = { style: mkStyle(), setAttribute: () => {}, removeAttribute: () => {},
                   classList: { toggle: () => {}, contains: () => false, add: () => {}, remove: () => {} } };
    const doc = {
      body, documentElement: root,
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener: (ev, fn) => { if (ev === 'DOMContentLoaded') fn(); },
      createElement: () => ({ style: {}, setAttribute: () => {} }),
      head: { appendChild: () => {} },
      /* apply() retracts the pre-paint ground override through this. */
      getElementById: () => null,
    };
    const win = { addEventListener: () => {}, dispatchEvent: () => {}, CustomEvent: function () {} };
    /* The fetch never resolves. That is the window being tested: what the page
       looks like between the engine running and the network answering. */
    const fetchStub = () => new Promise(() => {});
    new Function('window', 'document', 'localStorage', 'fetch', 'CustomEvent', 'location', engineSrc)(
      win, doc, {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
        setItem: (k, v) => { store[k] = v; },
      }, fetchStub, win.CustomEvent, { pathname: '/product' });
    return classes;
  };

  const stamped = 'zw-theme-stamp light-mode super-light-mode';

  const cold = run(stamped, {});
  ok('a stamped super-light page stays light with no cache', cold.has('light-mode'),
    'apply() toggled it off against config.default = "dark", which is a guess made before the fetch');
  ok('…and stays super-light too', cold.has('super-light-mode'));

  const coldLight = run('zw-theme-stamp light-mode', {});
  ok('a stamped light page stays light', coldLight.has('light-mode'));
  ok('…and is not promoted to super-light', !coldLight.has('super-light-mode'));

  /* The parts that must NOT change. */
  const darkShipped = run('', {});
  ok('an unstamped page is still dark', !darkShipped.has('light-mode'),
    'a dark store stamps no class at all, and must not be turned light by this');

  const chose = run(stamped, { zw_theme_mode: 'dark' });
  ok('a visitor who PICKED dark still gets dark', !chose.has('light-mode'),
    'the stamp is what shipped, not an override of somebody\'s choice');

  const warm = run(stamped, {
    zw_theme_modes: JSON.stringify({ default: 'dark', modes: [{ id: 'dark', base: 'dark', tokens: {} }] }),
  });
  ok('a real cached config still wins over the stamp', !warm.has('light-mode'),
    'the stamp is a fallback for knowing nothing, not a veto on knowing something');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
