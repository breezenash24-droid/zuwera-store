/* Opening a page in the builder must not choose the visitor's theme for them.
 *
 * ── The bug, as reported ────────────────────────────────────────────────────
 *
 * "Every other page is showing dark mode in the page builder except the index
 * page." That is a near-perfect bisection: same builder, same iframe origin,
 * same localStorage — only the page differs.
 *
 * index.html is the one page that sets `window.__zwSkipThemeFetch = true`, so it
 * never reads site_settings at all. Every other page does, and picks up the
 * LEGACY `theme` row — `{"mode":"dark"}` — a value written years ago by the
 * admin panel's own light/dark toggle, back when that toggle re-themed the shop.
 *
 * ── Why it was sticky ───────────────────────────────────────────────────────
 *
 * `__ZW_BUILDER_PREVIEW__` was set in storefront.js, and only index.html and
 * drop001.html load storefront.js. On the product and landing previews it was
 * undefined, so
 *
 *     ZWTheme.apply(mode, !window.__ZW_BUILDER_PREVIEW__)
 *
 * evaluated to `apply(mode, true)` — and the second argument means REMEMBER.
 * Opening a product page in the builder wrote zw_theme_mode='dark' into the real
 * localStorage. The pre-paint block then honoured that on every page forever,
 * which is how a store whose configured default is WHITE came to render dark
 * everywhere except the one page that skips the fetch.
 *
 * ── The two properties asserted ─────────────────────────────────────────────
 *
 *   The preview flag comes from the URL, so all four preview surfaces get it —
 *   not from a script two of them do not load.
 *
 *   The legacy row is applied without remembering, builder or not. A stale
 *   settings value is nobody's choice and must never become one.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const PREBOOT = read('scripts/theme-preboot.head.js');
const THEME = read('storefront-theme.js');
const BUILDER = read('builder.html');

console.log('\n  a builder preview is not a visitor choice\n');

console.log('  the flag comes from the URL, not from one script');
{
  ok('the pre-paint block sets it from ?builder=1',
    /builder=1/.test(PREBOOT) && /__ZW_BUILDER_PREVIEW__\s*=\s*true/.test(PREBOOT),
    'set only in storefront.js, it is undefined on product and landing');

  /* It has to be in the SHARED block, because that is the only code that runs
     on all fourteen pages. */
  const { PAGES, block } = require(path.join(ROOT, 'scripts', 'sync-preboot.js'));
  const want = block().replace(/\r\n/g, '\n');
  ok('…and that block is the one inlined into every page',
    /builder=1/.test(want), 'the generated block does not carry it');
  const missing = PAGES.filter((p) => !read(p).includes('builder=1'));
  ok('every page carries it', missing.length === 0, 'missing: ' + missing.join(', '));
}

console.log('\n  every preview surface is covered');
{
  /* The four iframes the builder can point at. If any preview URL stops
     carrying the parameter, the flag silently stops being set for it — which is
     exactly the shape of the original bug. */
  for (const [what, needle] of [
    ['the homepage', "'/index.html?builder=1'"],
    ['the collection', "'/drop001.html?builder=1'"],
    ['a product', "&builder=1'"],
  ]) {
    ok(what + ' preview carries ?builder=1', BUILDER.includes(needle), needle);
  }
  ok('the landing preview does too',
    /landingPreviewUrl/.test(BUILDER) && /builder=1/.test(BUILDER));
}

console.log('\n  the legacy row is applied but never written down');
{
  ok('applyThemeMode takes an explicit remember flag',
    /function applyThemeMode\(mode, remember\)/.test(THEME),
    'without it the legacy row cannot opt out of persisting');

  ok('the default is still "yes" for a real choice',
    /remember === undefined\) \? !window\.__ZW_BUILDER_PREVIEW__/.test(THEME),
    'the theme switcher and the size guide ARE choices and must keep persisting');

  ok('the legacy settings row passes false',
    /if \(mode\) applyThemeMode\(mode, false\)/.test(THEME),
    'a stale row from an old admin toggle is nobody\'s choice');

  /* The specific regression: the old expression, if it comes back, re-enables
     persisting from a preview on any page that does not load storefront.js. */
  ok('the un-guarded expression is gone',
    !/apply\(mode, !window\.__ZW_BUILDER_PREVIEW__\)/.test(THEME),
    'that reads as apply(mode, true) wherever the flag is undefined');
}

console.log('\n  index is still the page that skips the fetch');
{
  /* Not a bug — it handles its own settings. Asserted so the asymmetry that
     produced the report stays deliberate and visible rather than surprising. */
  ok('index.html skips the settings fetch', read('index.html').includes('__zwSkipThemeFetch'));
  ok('…and the fetch honours that', /if \(window\.__zwSkipThemeFetch\) return;/.test(THEME));
  const others = ['product.html', 'landing.html'].filter((p) => read(p).includes('__zwSkipThemeFetch'));
  ok('other pages do NOT skip it, which is why they saw the legacy row',
    others.length === 0, 'now skipping too: ' + others.join(', '));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
