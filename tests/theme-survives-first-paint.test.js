/* The store's own theme has to reach the FIRST frame, not the second.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * base.css declares --fg-rgb, --bg-rgb, --ink, --paper and --zw-theme-surface
 * on `body.light-mode` / `body.super-light-mode`. theme-engine.js knows this
 * and says so at the top of apply():
 *
 *   "On body, not :root. The alpha ladder is declared on body so that the
 *    body.light-mode class can move it; setting the triplet on :root would lose
 *    to that class every time, and a custom theme's colours would be silently
 *    replaced by the built-in light ones."
 *
 * The pre-paint block in <head> then set exactly those tokens on <html>. Every
 * one of them was discarded the moment the stylesheet loaded, and the page
 * rendered in the BUILT-IN palette for its base until theme-engine.js had
 * downloaded, parsed and set the same tokens inline on <body>.
 *
 * That file is deferred and cache-busted, so every Cloudflare deploy forces one
 * cold fetch of it — which is why the first load after a deploy showed the
 * wrong site and a refresh fixed it. The refresh was served the engine from
 * disk and the gap closed to nothing.
 *
 * It was never only colour. A custom theme carries typeScale, density, motion
 * and ease; the built-in it fell back to carries none of them. A store whose
 * default is typeScale 1.25 rendered its first frame at 1.0 and then RELAID
 * OUT — every line on the page moved.
 *
 * ── What is asserted ────────────────────────────────────────────────────────
 *
 * Not the implementation — the property. A theme's tokens must be written
 * somewhere that beats base.css's body-class block, and there must be exactly
 * three tiers of authority in the right order: built-in, baked default, live
 * answer. Plus the retraction rule, because a stand-in that cannot be removed
 * is the bug this store already shipped once.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const { themeCss, themeAttrs, BODY_TOKENS, safe } = require(path.join(ROOT, 'scripts', '_theme-css.js'));

console.log('\n  the theme reaches the first frame\n');

/* The store's real default theme, as the live settings row carries it. Used as
   the worked example throughout: it is a CUSTOM theme, which is the case the
   built-in classes cannot answer and the case every licensee will be in. */
const CUSTOM = {
  bg: '255 255 255', fg: '0 0 0', err: '#ef4444', ink: '#ffffff',
  ease: 'cubic-bezier(.32,.72,0,1)', barBg: '#ffffff', barFg: '#55b8a5',
  paper: '#030302', accent: '#d3cec5', motion: 0, radius: 0, density: 1.4,
  surface: '#F5F5F5', accountIn: 'header', typeScale: 1.25,
};

console.log('  the baked stylesheet outranks the built-in block');
{
  const css = themeCss(CUSTOM, 'html[data-zw-theme-stamp]');

  /* The whole point. base.css's `body.super-light-mode` is (0,1,1); the baked
     rule has to be higher or it changes nothing at all. */
  ok('body tokens are scoped through an attribute on <html>',
    /html\[data-zw-theme-stamp\] body\{/.test(css),
    'a plain `body` selector loses to body.super-light-mode');

  ok('the custom palette is present, not the built-in one',
    css.includes('--paper:#030302') && css.includes('--accent:#d3cec5'),
    css);

  /* base.css computes --text-hero in :root as
     calc(clamp(…) * var(--zw-type-scale, 1)), so the scale is substituted
     against :root's value. On body it would do nothing whatsoever. */
  ok('--zw-type-scale is set at root level, where it is read',
    /html\[data-zw-theme-stamp\]\{[^}]*--zw-type-scale:1\.25/.test(css),
    css);

  ok('--zw-motion:0 survives, because 0 is a real value for motion',
    /--zw-motion:0/.test(css), css);

  /* set() removes a property whose value is falsy, so a theme with radius 0
     must not be baked as `--zw-radius:0` — the frames would disagree. */
  ok('radius 0 is left unset, matching what the engine does with it',
    !css.includes('--zw-radius'), css);

  ok('shapes that are not values stay attributes',
    themeAttrs(CUSTOM).body['data-zw-account'] === 'header',
    JSON.stringify(themeAttrs(CUSTOM)));
}

console.log('\n  every token the engine sets, the bake sets');
{
  /* Parity with theme-engine.js, read from it rather than restated. Two lists
     that must agree is the same "many answerers" fault one level up, so the
     test derives one from the other. */
  const engine = read('theme-engine.js');
  const named = new Set();
  const re = /set\('(--[a-z0-9-]+)',\s*t\.([A-Za-z]+)/g;
  let m;
  while ((m = re.exec(engine))) named.add(m[1]);

  const baked = new Set(BODY_TOKENS.map(([p]) => p));
  /* --black and --white are set from bg/fg rather than a same-named token, so
     they are matched by hand; they ARE covered, by the pair pushed in
     themeCss(). */
  baked.add('--black'); baked.add('--white');

  const missing = [...named].filter((p) => !baked.has(p));
  ok('no token the engine applies is missing from the bake',
    missing.length === 0, 'missing: ' + missing.join(', '));
  ok('the engine was actually parsed (guards against a regex that found nothing)',
    named.size > 10, 'found only ' + named.size);
}

console.log('\n  three tiers of authority, in order');
{
  const preboot = read('scripts/theme-preboot.head.js');
  const engine = read('theme-engine.js');

  ok('the pre-paint block writes tokens as a RULE, not as root properties',
    preboot.includes("html[data-zw-preboot] body{"),
    'setting them on <html> is what base.css overrides');

  /* The specific regression: any surviving h.style.setProperty for a token
     base.css declares on the body class is a token that will be thrown away. */
  const lost = BODY_TOKENS
    .map(([p]) => p)
    .filter((p) => preboot.includes("h.style.setProperty('" + p + "'"));
  ok('no theme token is still written to <html>, where it loses',
    lost.length === 0, 'still on <html>: ' + lost.join(', '));

  ok('the engine outranks both, because it writes inline styles on body',
    /var el = document\.body \|\| root/.test(engine),
    'inline styles are what beat the baked selector');
}

console.log('\n  a stand-in never outlives the answer');
{
  const preboot = read('scripts/theme-preboot.head.js');
  const engine = read('theme-engine.js');

  ok('the baked default is switched off by ONE attribute',
    preboot.includes("h.removeAttribute('data-zw-theme-stamp')"),
    'the visitor who chose another theme must not keep the baked one');

  /* Identity, not base — two themes can share a base and share nothing else. */
  ok('the comparison is by theme id, not by base',
    /_id !== _stamp/.test(preboot), preboot.slice(0, 0));

  ok('the engine retracts the baked default when it applies',
    engine.includes("root.removeAttribute('data-zw-theme-stamp')"));
  ok('the engine retracts the pre-paint tokens when it applies',
    engine.includes("root.removeAttribute('data-zw-preboot')")
    && engine.includes("getElementById('zw-preboot-tokens')"));
  ok('the engine still retracts the pre-paint ground',
    engine.includes("getElementById('zw-preboot-ground')"),
    'the original retraction must not have been lost in the edit');
}

console.log('\n  a theme cannot break the page it is written into');
{
  ok('a value that would close the declaration is refused',
    safe('red;} body{display:none') === '', 'got: ' + safe('red;} body{display:none'));
  ok('a value that would close the element is refused',
    safe('</style><script>x()</script>') === '');
  ok('an ordinary value passes through',
    safe('cubic-bezier(.32,.72,0,1)') === 'cubic-bezier(.32,.72,0,1)');
  ok('an empty theme produces no rule at all, not an empty one',
    themeCss({}, 'html[x]').indexOf('body{}') < 0);
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
