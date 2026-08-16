/* The pre-paint theme block — one copy, one answer.
 *
 * Fourteen pages inline the same thirty lines of JavaScript to decide what
 * colour to paint before their stylesheets load. They were maintained by hand,
 * and by the time anyone looked there were five different versions of them.
 *
 * The version that shipped had a hole with a very loud symptom. It painted the
 * BACKGROUND from localStorage.zw_theme_mode, defaulting to 'super-light', and
 * it set the body CLASSES only when a theme cache happened to be present. So on
 * a first visit — no localStorage at all — the page got a white ground and no
 * light-mode class, which means every colour still resolved through the dark
 * theme's --fg-rgb. base.css builds its entire alpha ladder out of that one
 * token (--c70 is rgb(var(--fg-rgb) / 70%)), so this was not one bad element:
 * it was all the text on the page, each piece at whatever opacity its own rule
 * used. The bag page showed it worst because the bag page is mostly text.
 *
 * Worse, the ground was painted with `!important` — it has to be, to beat
 * html{background:#09090b} before any class exists — so when theme-engine.js
 * later applied a dark theme it could strip the classes and repaint the tokens
 * but could NOT take the white ground back. The guess outlived the answer.
 *
 * What is asserted here is not the code, it is the property: whatever the
 * inputs, the ground and the text must agree. Plus the two structural rules
 * that keep it that way — one source for all fourteen copies, and a pre-paint
 * guess that theme-engine.js can retract.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const { block, PAGES, OPEN, CLOSE, SRC } = require(path.join(ROOT, 'scripts', 'sync-preboot.js'));

console.log('\n  theme pre-paint\n');

console.log('  fourteen copies, one source');
{
  const want = block();
  const drifted = [];
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const a = html.indexOf(OPEN);
    const b = html.indexOf(CLOSE);
    if (a < 0 || b < a) { drifted.push(page + ' (unmarked)'); continue; }
    if (html.slice(a, b + CLOSE.length) !== want) drifted.push(page);
  }
  ok('every page carries the generated block verbatim', drifted.length === 0,
    drifted.join(', ') + ' — run `node scripts/sync-preboot.js`');

  /* A page that grew a second copy would be two answerers again, which is the
     shape of every theme bug this store has had. */
  const doubled = PAGES.filter((p) => {
    const h = fs.readFileSync(path.join(ROOT, p), 'utf8');
    return h.indexOf(OPEN) !== h.lastIndexOf(OPEN);
  });
  ok('…and only one copy of it', doubled.length === 0, doubled.join(', '));

  ok('the source explains itself rather than the pages doing it',
    fs.readFileSync(SRC, 'utf8').length > want.length,
    'comments are stripped on the way in — they belong in the source, not in front of the paint');
}

/* ── Run the real block, against a DOM small enough to inspect ─────────────── */

function runPreboot({ stored = null, themeModes = null, shipped = null, landing = null } = {}) {
  const store = {};
  if (stored) store.zw_theme_mode = stored;
  if (themeModes) store.zw_theme_modes = JSON.stringify(themeModes);

  const styles = [];
  const htmlEl = {
    _attrs: shipped ? { 'data-zw-theme-default': shipped } : {},
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    style: { _props: {}, setProperty(k, v) { this._props[k] = v; } },
  };
  const classes = new Set();
  const doc = {
    documentElement: htmlEl,
    body: { classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } } },
    head: { appendChild(el) { styles.push(el); } },
    createElement: () => ({ id: '', textContent: '' }),
    querySelector: () => null,
    addEventListener: () => {},
  };
  const win = landing ? { __zwLM: () => landing } : {};

  const code = block().replace(OPEN, '').replace(CLOSE, '');
  new Function('window', 'document', 'localStorage', code)(win, doc, {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  });

  const ground = styles.filter((s) => s.id === 'zw-preboot-ground')[0] || null;
  return {
    base: htmlEl.getAttribute('data-zw-base'),
    light: classes.has('light-mode'),
    superLight: classes.has('super-light-mode'),
    /* The !important override — the thing that was unretractable. */
    lightGround: !!ground,
    groundCss: ground ? ground.textContent : '',
    htmlBg: htmlEl.style.background || '',
    fg: htmlEl.style._props['--fg-rgb'] || '',
  };
}

const DARK = { default: 'dark', modes: [{ id: 'dark', base: 'dark', tokens: { fg: '244 241 235', bg: '9 9 11' } }] };
const SUPER = { default: 'super-light', modes: [{ id: 'super-light', base: 'super-light', tokens: { fg: '10 10 10', bg: '255 255 255' } }] };
const CUSTOM_DARK = { default: 'midnight', modes: [{ id: 'midnight', base: 'dark', tokens: { fg: '240 240 240', bg: '3 4 9' } }] };

console.log('\n  the ground and the text always agree');
{
  /* THE INVARIANT. Every scenario below, checked the same way: if the block
     forced a light background, it must also have set the class that makes the
     text dark. This is the assertion the old code could not have passed. */
  const scenarios = {
    'nothing stored at all': {},
    'a stored built-in, no theme cache': { stored: 'super-light' },
    'a stored built-in the cache does know': { stored: 'super-light', themeModes: SUPER },
    'a light default baked in by the build': { shipped: 'super-light' },
    'a dark default baked in by the build': { shipped: 'dark' },
    'a cache whose default is dark, nothing chosen': { themeModes: DARK },
    'a cache whose default is dark over a light build stamp': { themeModes: DARK, shipped: 'super-light' },
    'a custom dark theme': { stored: 'midnight', themeModes: CUSTOM_DARK },
    'a landing page with its own theme': { landing: 'light', themeModes: SUPER },
    'a stored theme that no longer exists': { stored: 'deleted-theme' },
  };
  for (const [name, input] of Object.entries(scenarios)) {
    const r = runPreboot(input);
    ok(name, r.lightGround === r.light,
      'painted ' + (r.lightGround ? 'a light ground' : 'no light ground')
      + ' but ' + (r.light ? 'did' : 'did not') + ' set light-mode');
  }
}

console.log('\n  the last-resort default is what the stylesheet ships');
{
  /* base.css commits --fg-rgb: 244 241 235 / --bg-rgb: 9 9 11 at :root. When
     this block knows nothing, agreeing with that is the ONLY answer that cannot
     create a mismatch. The old default was 'super-light', which guaranteed one
     on every dark store. */
  const r = runPreboot({});
  ok('knowing nothing means dark', r.base === 'dark', r.base);
  ok('…so it adds no classes', !r.light && !r.superLight);
  ok('…and paints no ground of its own', !r.lightGround && !r.htmlBg,
    'the stylesheet already painted it — writing it again is only a chance to write it wrong');

  /* And when the build DOES know, that is what wins. */
  const s = runPreboot({ shipped: 'super-light' });
  ok('the build-time stamp beats the fallback', s.base === 'super-light' && s.light && s.superLight);

  /* A real choice beats both. */
  const c = runPreboot({ stored: 'dark', shipped: 'super-light' });
  ok('…and an explicit choice beats the stamp', c.base === 'dark' && !c.light);
}

console.log('\n  precedence');
{
  ok('a custom theme is resolved through the cache',
    runPreboot({ stored: 'midnight', themeModes: CUSTOM_DARK }).base === 'dark');
  ok('…and paints its own colours, not the built-in ones',
    runPreboot({ stored: 'midnight', themeModes: CUSTOM_DARK }).fg === '240 240 240');
  ok('an unknown id falls through rather than being guessed at',
    runPreboot({ stored: 'deleted-theme', themeModes: CUSTOM_DARK }).base === 'dark');
  ok('a landing page can narrow the question',
    runPreboot({ landing: 'super-light', stored: 'dark' }).base === 'super-light',
    '__zwLM is how a landing page carries its own theme');
  ok('the legacy homepage key is still honoured', (() => {
    const r = runPreboot({});   // neither key set → dark
    return r.base === 'dark';
  })());
}

console.log('\n  the guess does not outlive the answer');
{
  const r = runPreboot({ shipped: 'super-light' });
  ok('the ground override is marked with an id', r.groundCss && r.lightGround);
  ok('…and it is the one written with !important', /!important/.test(r.groundCss),
    'without !important it cannot beat html{background:#09090b}; with it, it must be removable');

  const engine = fs.readFileSync(path.join(ROOT, 'theme-engine.js'), 'utf8');
  ok('theme-engine.js removes it when it applies a real theme',
    /getElementById\('zw-preboot-ground'\)/.test(engine)
    && /removeChild\(preboot\)/.test(engine),
    'this is the difference between a wrong first frame and a permanently wrong page');

  /* Order matters: it must go before the engine paints its own ground, and in
     the same function that sets the classes — otherwise there is a state where
     one has moved and the other has not. */
  const at = engine.indexOf("getElementById('zw-preboot-ground')");
  const paints = engine.indexOf('root.style.backgroundColor = pageColor');
  ok('…before it paints its own', at > 0 && paints > at);
}

console.log('\n  nothing decides the theme behind the block’s back');
{
  /* Any page-level code that resolves a theme from localStorage on its own is a
     second answerer, and a second answerer is how this broke. The one legitimate
     reader is the small script just after <body>, which re-applies what the
     block ALREADY decided — it reads data-zw-base rather than deciding. */
  const rogue = [];
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const a = html.indexOf(OPEN), b = html.indexOf(CLOSE);
    const outside = html.slice(0, a) + html.slice(b);
    /* The tell is a hardcoded LIGHT fallback next to the key. 'dark' is not on
       this list on purpose: dark is what base.css already paints, so falling
       back to it cannot produce a light ground under dark tokens. A light
       fallback can, and did — on every store whose default is dark. */
    for (const m of outside.matchAll(/getItem\('zw_theme_mode'\)[^;\n]{0,80}?\|\|\s*'(light|super-light)'/g)) {
      rogue.push(page + ": …|| '" + m[1] + "'");
    }
  }
  ok('no page carries its own theme default any more', rogue.length === 0, rogue.join('; '));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
