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
  const h = { style: styleObj, setAttribute: (k, v) => { attrs[k] = v; }, classList: { toggle: () => {} } };

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

  /* Just the theme block, lifted out of the page's first inline script. */
  const start = html.indexOf("var _tc=JSON.parse");
  const end = html.indexOf('}catch(_){}', start);
  const src = html.slice(start, end);
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
  ok('--surface and --accent are set', props['--surface'] === LIGHT.surface && props['--accent'] === LIGHT.accent);
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
  ok('colour-scheme is left alone', !props['color-scheme']);
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

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
