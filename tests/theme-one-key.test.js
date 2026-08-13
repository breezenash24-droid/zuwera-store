/* One store, one theme.
 *
 * The homepage, bag and checkout read `zw_homepage_theme_mode`. Every other
 * page read `zw_theme_mode`. The first was written from the page-builder's
 * published theme; the second by the theme toggle. So the two could disagree —
 * and did: a white landing page in front of a dark store, with no switch
 * anywhere that moved both.
 *
 * It was worse than one wrong page. The toggle wrote whichever key matched the
 * page you happened to be standing on, so switching on a product page never
 * reached the homepage and switching on the homepage never reached anything
 * else. And the fallbacks disagreed three ways: 'super-light' in nineteen
 * places, 'dark' in the pageshow handler, 'light' for an unrecognised mode.
 * Nobody made a careless choice there — three people made three reasonable
 * guesses, which is the tell that the two-key model cost more than it returned.
 *
 * The capability it was supposed to provide already exists and is better: every
 * builder section carries its own sec_bg and text_color. A section that should
 * look different says so; a whole second page-level theme was never the right
 * tool for it.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

/* Every page that paints a theme before the settings load. If one is missing
   from here it can drift again without anything noticing. */
const PAGES = ['index.html', 'bag.html', 'checkout.html', 'product.html', 'drop001.html',
               'journal.html', 'policies.html', 'returns.html', 'sizeguide.html', 'confirm.html'];

console.log('\n  one theme key\n');

console.log('  every page asks the same question first');
{
  const wrong = [];
  for (const f of PAGES) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const s = fs.readFileSync(p, 'utf8');
    /* Anywhere the legacy key is consulted BEFORE the site key is a page that
       can disagree with the rest of the store. */
    if (/getItem\('zw_homepage_theme_mode'\)\s*\|\|\s*localStorage\.getItem\('zw_theme_mode'\)/.test(s)) {
      wrong.push(f);
    }
  }
  ok('no page prefers the homepage-only key', wrong.length === 0, wrong.join(', '));

  const js = ['storefront.js', 'storefront-theme.js'];
  const wrongJs = js.filter((f) => /getItem\('zw_homepage_theme_mode'\)\s*\|\|\s*localStorage\.getItem\('zw_theme_mode'\)/
    .test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  ok('…nor do the shared scripts', wrongJs.length === 0, wrongJs.join(', '));
}

console.log('\n  the legacy key is read, never written');
{
  /* Read, so a value stored before this change does not strand somebody with
     the wrong theme on their next visit. Never written, so the divergence
     cannot come back. */
  const writers = [];
  for (const f of PAGES.concat(['storefront.js', 'storefront-theme.js'])) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const s = fs.readFileSync(p, 'utf8');
    if (/setItem\(\s*'zw_homepage_theme_mode'/.test(s)) writers.push(f);
  }
  ok('nothing writes the homepage-only key any more', writers.length === 0, writers.join(', '));

  const store = fs.readFileSync(path.join(ROOT, 'storefront.js'), 'utf8');
  ok('the builder theme now sets the SITE theme', /setItem\('zw_theme_mode', themeMode\)/.test(store));
  ok('…and still reads the old one as a fallback',
    /getItem\('zw_theme_mode'\) \|\| localStorage\.getItem\('zw_homepage_theme_mode'\)/.test(store));
}

console.log('\n  one default, not three');
{
  const defaults = new Set();
  for (const f of PAGES) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const s = fs.readFileSync(p, 'utf8');
    for (const m of s.matchAll(/getItem\('zw_homepage_theme_mode'\)\s*\|\|\s*'([a-z-]+)'/g)) defaults.add(m[1]);
  }
  ok('every page falls back to the same mode', defaults.size <= 1, [...defaults].join(', '));
  ok('…and it is the one the storefront ships with', !defaults.size || defaults.has('super-light'), [...defaults].join(', '));

  const themeJs = fs.readFileSync(path.join(ROOT, 'storefront-theme.js'), 'utf8');
  /* This handler defaulted to 'dark' while all nineteen page reads defaulted to
     'super-light' — a back-forward navigation could repaint the store into a
     different theme than the one it loaded in. */
  ok('the pageshow handler agrees with them', !/mode = localStorage\.getItem\(key\) \|\| localStorage\.getItem\('zw_theme_mode'\) \|\| 'dark'/.test(themeJs));
  ok('…using the same chain as everything else',
    /getItem\('zw_theme_mode'\)[\s\S]{0,80}?getItem\('zw_homepage_theme_mode'\)[\s\S]{0,40}?'super-light'/.test(themeJs));
}

console.log('\n  the toggle no longer depends on where you are standing');
{
  const themeJs = fs.readFileSync(path.join(ROOT, 'storefront-theme.js'), 'utf8');
  ok('it does not pick a key from the pathname', !/isHomepage \? 'zw_homepage_theme_mode'/.test(themeJs));
  ok('…nor from whether the builder is active', !/__zwPageBuilderActive \? 'zw_homepage_theme_mode'/.test(themeJs));
  ok('there is one key, named once', /var key = 'zw_theme_mode';/.test(themeJs));
}

console.log('\n  what replaced the capability');
{
  /* The per-page theme was solving "this part should look different". The
     builder already solves that per SECTION, which is the right granularity —
     a light hero on a dark store, without the product page disagreeing. */
  const builder = fs.readFileSync(path.join(ROOT, 'builder.html'), 'utf8');
  ok('sections carry their own background', /sec_bg:/.test(builder));
  ok('…and their own text colour', /text_color:/.test(builder));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
