/* The theme system, and the invariants that keep it working.

   Light mode was broken for one reason: ~900 places wrote the foreground colour
   as a literal instead of asking the theme for it, so they stayed cream when the
   page turned cream. Converting them is only half a fix — the other half is
   noticing when one comes back. Most of this file is that second half. */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
const R = ROOT + '/';
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const base = fs.readFileSync(R + 'base.css', 'utf8');

console.log('\n  the ladder derives\n');
{
  ok('every rung is computed from the foreground triplet',
    (base.match(/--c\d\d:\s*rgb\(var\(--fg-rgb\)/g) || []).length === 17,
    (base.match(/--c\d\d:\s*rgb\(var\(--fg-rgb\)/g) || []).length + ' of 17');
  ok('no rung is a hardcoded colour any more',
    !/--c\d\d:\s*rgba\(/.test(base));
  ok('light mode moves the triplet, not seventeen rungs',
    /body\.light-mode[\s\S]*?--fg-rgb:/.test(base) &&
    !/body\.light-mode[\s\S]*?--c30:\s*rgba/.test(base));

  /* The bug this cost, written down so it cannot come back.

     Custom properties substitute at computed-value time on the element that
     DECLARES them. A rung declared on :root resolves against :root's --fg-rgb
     and inherits the result — so `body.light-mode { --fg-rgb: … }`, being a
     different element, could never change it. Light mode kept the dark ladder,
     which is cream, which on a light page is invisible. The nav's bag button
     lost its border and nothing else looked wrong enough to notice.

     The fix is that the ladder and the mode class must sit on the SAME element,
     so the class wins by specificity and the rungs recompute. */
  const ladderBlock = base.slice(base.lastIndexOf('body {', base.indexOf('--c06:')), base.indexOf('--c06:'));
  ok('the ladder is declared on body, the element the mode class is on',
    /body\s*\{/.test(ladderBlock),
    'declaring it on :root makes light mode silently keep the dark ladder');
  ok('…and the semantic aliases sit with it, not a level up',
    /body\s*\{[\s\S]*?--border:\s*var\(--c10\)/.test(base));

  ok('rgb() with a slash, never rgba() with a spliced var',
    !/rgba\(\s*var\(--fg-rgb\)/.test(base),
    'a bare triplet cannot go in rgba()’s comma list — it fails silently to transparent');
}

console.log('\n  the literals are gone');
{
  // Files converted away from hardcoded foreground colours.
  const FILES = [
    'base.css', 'storefront-cohesion.css', 'cart.css', 'product.css', 'reviews.css',
    'reviews-vibe.css', 'quick-add-modal.css', 'email-popup.css',
    'storefront-mobile-rebuild.css', 'index.html', 'product.html', 'drop001.html',
    'bag.html', 'checkout.html', 'account.html', 'about.html', 'journal.html',
    'returns.html', 'landing.html', 'sizeguide.html', 'policies.html', '404.html',
    'confirm.html', 'announcement-bar.js',
  ];
  const FG = /rgba\(\s*244\s*,\s*241\s*,\s*235\s*,\s*[0-9.]+\s*\)/g;

  /* Inside a light-mode block a literal is correct — that is the block whose
     whole job is to hardcode the other side, and those go away only when the
     paired base rule is confirmed redundant, one selector at a time. */
  function outsideLightMode(src) {
    const ranges = [];
    const sel = /body\.(?:super-)?light-mode[^{]*\{/g;
    let m;
    while ((m = sel.exec(src))) {
      let depth = 1, i = m.index + m[0].length;
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++; else if (src[i] === '}') depth--;
        i++;
      }
      ranges.push([m.index, i]);
    }
    let n = 0, hit;
    FG.lastIndex = 0;
    while ((hit = FG.exec(src))) {
      if (!ranges.some(([a, b]) => hit.index >= a && hit.index < b)) n++;
    }
    return n;
  }

  let total = 0;
  const offenders = [];
  for (const f of FILES) {
    if (!fs.existsSync(R + f)) continue;
    const n = outsideLightMode(fs.readFileSync(R + f, 'utf8'));
    total += n;
    if (n) offenders.push(f + ' (' + n + ')');
  }
  ok('no hardcoded foreground colour outside a light-mode block', total === 0, offenders.join(', '));
}

console.log('\n  the one that must stay hardcoded');
{
  const sf = fs.readFileSync(R + 'storefront.js', 'utf8');
  /* Stripe renders the card field in a cross-origin iframe, where a custom
     property defined on this page does not exist. Tokenising this would make
     the placeholder invisible — a bug nobody would attribute to a theme change
     three months later. */
  ok('the Stripe card placeholder is still a literal',
    /'::placeholder':\{\s*color:\s*isLight\s*\?\s*'rgba\(9,9,11,\.58\)'\s*:\s*'rgba\(244,241,235,\.38\)'/.test(sf));
  ok('…and says why', /cross-origin iframe/.test(sf));
}

console.log('\n  themes are data');
{
  const eng = fs.readFileSync(R + 'theme-engine.js', 'utf8');
  ok('reads the theme list from settings', /key=eq\.theme_modes/.test(eng));
  ok('ships the three originals as defaults so the row is optional',
    /id: 'dark'/.test(eng) && /id: 'light'/.test(eng) && /id: 'super-light'/.test(eng));
  ok('a theme declares which structural CSS it sits on', /base:/.test(eng));
  ok('still sets the legacy body classes, so existing rules keep working',
    /classList\.toggle\('light-mode'/.test(eng) && /classList\.toggle\('super-light-mode'/.test(eng));
  ok('exposes a list so switchers stop hardcoding three buttons',
    /list: function/.test(eng) && /apply: function/.test(eng));

  /* Two-tone: a light page under a black header. The look existed by accident
     — .nav is hardcoded dark and only some pages overrode it in light mode, so
     which one you got depended on the page. Now it is a theme, and navBg is
     what makes it expressible. */
  ok('ships the two-tone theme', /id: 'two-tone'/.test(eng));
  ok('…and it colours the header apart from the page', /navBg:/.test(eng));
  ok('the nav tokens are optional, so other themes are unaffected',
    /set\('--zw-nav-bg', t\.navBg\)/.test(eng));

  const nav = fs.readFileSync(R + 'nav.css', 'utf8');
  ok('every nav rule falls back to the colour it used to hardcode',
    (nav.match(/var\(--zw-nav-bg, #[0-9A-Fa-f]{6}\)/g) || []).length === 3,
    (nav.match(/var\(--zw-nav-bg, #[0-9A-Fa-f]{6}\)/g) || []).length + ' of 3');
  ok('the higher-specificity page overrides read it too',
    /var\(--zw-nav-bg/.test(fs.readFileSync(R + 'index.html', 'utf8')) &&
    /var\(--zw-nav-bg/.test(fs.readFileSync(R + 'bag.html', 'utf8')));
  ok('sets its tokens on body, where the ladder computes and the class lives',
    /document\.body \|\| root/.test(eng) && /el\.style\.setProperty/.test(eng),
    'setting them on :root loses to body.light-mode and a custom theme gets the built-in colours');

  const st = fs.readFileSync(R + 'storefront-theme.js', 'utf8');
  ok('the old applier delegates instead of duplicating',
    /window\.ZWTheme && window\.ZWTheme\.get\(mode\)/.test(st));

  const sf = fs.readFileSync(R + 'storefront.js', 'utf8');
  ok('section backgrounds can name a theme token', /token:/.test(sf) && /resolveSectionBackground/.test(sf));
  ok('…and a plain colour still behaves exactly as before',
    /raw\.slice\(0, 6\) !== 'token:'/.test(sf));
}

console.log('\n  one theme system, two screens');
{
  const b = fs.readFileSync(R + 'builder.html', 'utf8');
  ok('the builder Design tab shows a theme gallery',
    /themeGallery/.test(b) && /renderThemeGallery/.test(b));
  ok('it edits the same key the admin does', /key:\s*'theme_modes'/.test(b));

  /* The duplicate colour system this replaced: four pickers writing
     builder_theme while theme_modes held the real palette, so the same colour
     had two homes and could disagree with itself. */
  ok('the second colour system is gone from the builder',
    !/primary_color|page_bg|surface_color/.test(b));
  ok('the preview runs the real engine, not a second renderer',
    /contentWindow\.ZWTheme/.test(b));
  ok('…through the iframe, not the wrapper div that has no contentWindow',
    /getElementById\('pvIframe'\)/.test(b));

  const api = fs.readFileSync(R + 'functions/api/save-page-builder.js', 'utf8');
  ok('the save endpoint permits that key', /'theme_modes'/.test(api));
}

console.log('\n  per-page themes');
{
  const eng = fs.readFileSync(R + 'theme-engine.js', 'utf8');
  ok('a path can be pinned to a theme', /themeForPath/.test(eng) && /config\.pages/.test(eng));
  ok('longest match wins, so /product.html beats /', /key\.length > best\.length/.test(eng));
  ok('a pin to a deleted theme is ignored, not rendered blank',
    /modes\.some\(function \(m\) \{ return m\.id === id; \}\)/.test(eng));
  /* Someone who chose Dark asked for Dark. A checkout that overrules them reads
     as a bug rather than a design, so their pick is consulted first. */
  ok("a visitor's own choice still wins over the page pin",
    /byId\(chosenId\(\)\)[\s\S]{0,40}\|\| byId\(themeForPath/.test(eng));

  const at = fs.readFileSync(R + 'admin-themes.js', 'utf8');
  ok('the admin can assign one', /themeSetPage/.test(at) && /PAGE_TARGETS/.test(at));
}

console.log('\n  the visualiser and colour entry');
{
  const at = fs.readFileSync(R + 'admin-themes.js', 'utf8');
  ok('previews through the real engine, not a mock-up', /w\.ZWTheme\.preview/.test(at));
  ok('repaints on every edit', (at.match(/visPaint\(\)/g) || []).length >= 5);
  ok('a hex can be typed, not only picked', /themeSetHex/.test(at));
  ok('…and a partial hex is ignored until it is a whole colour',
    /\{3\}\|\[0-9a-fA-F\]\{6\}/.test(at));
  ok('typing a hex does not re-render and steal focus', /blurs the field/.test(at));

  const ic = fs.readFileSync(R + 'icon-sets.js', 'utf8');
  ok('the icon library is more than stroke weights of one drawing',
    /GEOMETRIC/.test(ic) && /SKETCH/.test(ic));
  ok('six sets', (ic.match(/build: function/g) || []).length === 6,
    (ic.match(/build: function/g) || []).length + '');

}

/* The failure mode that has now happened twice: a storefront module fetches a
   settings key with the anon key, the key is not on the RLS allow-list, the read
   returns empty, and the module falls back to its defaults. Nothing errors — an
   empty result and "nothing configured" are the same shape from the client — so
   the feature simply does not exist on the live site while working perfectly in
   the admin, which reads with a session. This check is the tripwire. */
console.log('\n  what the storefront reads, it is allowed to read');
{
  const MODULES = ['theme-engine.js', 'icon-sets.js', 'integrations.js', 'preview-mode.js'];
  // The newest ALTER POLICY wins — it replaces the list rather than appending.
  const latest = fs.readdirSync(R + 'migrations')
    .filter((f) => f.endsWith('.sql')).sort()
    .map((f) => fs.readFileSync(R + 'migrations/' + f, 'utf8'))
    .filter((t) => /alter policy "Public read content keys"/i.test(t))
    .pop() || '';

  const missing = [];
  for (const m of MODULES) {
    if (!fs.existsSync(R + m)) continue;
    const src = fs.readFileSync(R + m, 'utf8');
    for (const hit of src.matchAll(/key=eq\.([a-z_]+)/g)) {
      if (!new RegExp("'" + hit[1] + "'").test(latest)) missing.push(m + ' → ' + hit[1]);
    }
  }
  ok('every anon-read settings key is on the public allow-list',
    missing.length === 0, missing.join(', '));
}

console.log('\n  a theme is more than paint');
{
  /* Two storefronts with identical palettes still look nothing alike if one
     has huge type, round corners and airy sections. Those are the dimensions
     that carry a theme's identity, so they belong to the theme. */
  const eng = fs.readFileSync(R + 'theme-engine.js', 'utf8');
  ok('type scale, radius and density are theme tokens',
    /--zw-type-scale/.test(eng) && /--zw-radius/.test(eng) && /--zw-density/.test(eng));
  ok('a missing or nonsense type scale falls back to 1, not to nothing',
    /isFinite\(scale\) && scale > 0 \? String\(scale\) : '1'/.test(eng));

  const base2 = fs.readFileSync(R + 'base.css', 'utf8');
  ok('the scale moves every rem at once, from the root',
    /html \{ font-size: calc\(100% \* var\(--zw-type-scale, 1\)\); \}/.test(base2));
  ok('shape tokens have defaults, so an unset theme changes nothing',
    /--zw-radius: 0px;/.test(base2) && /--zw-density: 1;/.test(base2));

  const sf = fs.readFileSync(R + 'storefront.js', 'utf8');
  /* calc() rather than doing the arithmetic in JS: --zw-density can change
     after the section renders, when a theme is applied or previewed, and a
     computed number would be frozen at render time. */
  ok('section padding re-evaluates when the theme changes',
    /calc\('.*var\(--zw-density, 1\)/.test(sf) || /var\(--zw-density, 1\)\)/.test(sf));

  const at = fs.readFileSync(R + 'admin-themes.js', 'utf8');
  ok('the editor exposes them as sliders', /SHAPE/.test(at) && /themeSetShape/.test(at));
  ok('dragging a slider does not rebuild it mid-drag', /drop the pointer/.test(at));
}

console.log('\n  header composition');
{
  const nav = fs.readFileSync(R + 'nav.css', 'utf8');
  const eng = fs.readFileSync(R + 'theme-engine.js', 'utf8');
  const at = fs.readFileSync(R + 'admin-themes.js', 'utf8');

  /* An attribute, not a custom property: what changes is a grid template and a
     set of areas — a shape, and CSS cannot switch shapes on a variable. */
  ok('the theme sets an attribute, because a shape is not a value',
    /setAttribute\('data-zw-header', t\.header\)/.test(eng));
  ok('absent means the arrangement the site shipped with',
    /removeAttribute\('data-zw-header'\)/.test(eng));

  // Every preset the admin offers must exist in CSS, or it silently does nothing.
  const inCss = [...nav.matchAll(/data-zw-header="([a-z]+)"/g)].map((m) => m[1]);
  const offered = [...at.matchAll(/\['([a-z]+)', '(?:Editorial|Centred|Split|Minimal)/g)].map((m) => m[1]);
  const orphaned = offered.filter((k) => inCss.indexOf(k) === -1);
  ok('every arrangement the admin offers is one CSS implements', orphaned.length === 0, orphaned.join(', '));

  /* .nav-center is absolutely positioned by default so the mega-menu can span
     the viewport. Left absolute inside a grid it leaves the flow, and the
     second row of a stacked header collapses to nothing. */
  ok('the links are returned to the flow where a preset needs a real row',
    /html\[data-zw-header="stacked"\] \.nav-center \{[\s\S]{0,160}position: static/.test(nav));

  /* A centred two-row header on a phone spends a third of the viewport on
     chrome, and the mobile menu already owns the links there. */
  ok('every preset collapses on phones', /@media \(max-width: 900px\)[\s\S]{0,200}html\[data-zw-header\] \.nav \{[\s\S]{0,80}display: flex/.test(nav));
  ok('…and the desktop arrangements are behind a min-width, not applied everywhere',
    /@media \(min-width: 901px\)[\s\S]{0,400}data-zw-header="stacked"/.test(nav));

  /* Minimal hides the links; it must not strand them, or those pages become
     unreachable on desktop. */
  ok('minimal moves the links to the menu rather than deleting them',
    /minimal"\] \.nav-center \{ display: none/.test(nav) &&
    /minimal"\] \.zw-mobile-menu-btn/.test(nav));

  ok('the editor offers it as a named look, not a mechanism',
    /HEADERS/.test(at) && /themeSetHeader/.test(at) && /logo left, links centred/.test(at));
}

console.log('\n  motion is part of the theme');
{
  const css = fs.readFileSync(R + 'motion.css', 'utf8');
  const js = fs.readFileSync(R + 'motion.js', 'utf8');
  const eng = fs.readFileSync(R + 'theme-engine.js', 'utf8');

  ok('durations derive from one multiplier, like the alpha ladder',
    /--zw-t-base:\s*calc\(\d+ms \* var\(--zw-motion\)\)/.test(css));
  ok('a theme can set the multiplier and the curve',
    /--zw-motion/.test(eng) && /set\('--zw-ease', t\.ease\)/.test(eng));

  /* The classic way scroll animation takes a site down: CSS hides everything,
     the JS that was meant to show it again does not run, and the page is blank
     with no error. Nothing is hidden until the script says it can reveal. */
  ok('nothing is hidden until the script confirms it can reveal it',
    /html\.zw-motion-ready \[data-zw-reveal\]:not\(\.is-in\)/.test(css));
  ok('…and the class is only added once the observer exists',
    /classList\.add\('zw-motion-ready'\)[\s\S]{0,400}new IntersectionObserver/.test(js));

  /* On a touchscreen :hover sticks after a tap, so a lift becomes a card that
     stays raised until you tap somewhere else. */
  ok('hover effects only run where hovering is real', /@media \(hover: hover\)/.test(css));

  /* A theme is a preference about taste. Reduced motion is not. */
  ok('reduced motion overrides the theme, not the other way round',
    /prefers-reduced-motion: reduce/.test(css) && /--zw-motion: 0/.test(css));
  ok('…and the override is last, where nothing can outrank it',
    css.lastIndexOf('prefers-reduced-motion') > css.lastIndexOf('--zw-t-drift'));
  ok('the script opts out entirely for those visitors',
    /prefers-reduced-motion: reduce/.test(js) && /if \(quiet/.test(js));

  ok('content built after load is rescanned', /ZWMotion\.scan/.test(fs.readFileSync(R + 'storefront.js', 'utf8')));

  const PAGES = ['index.html', 'product.html', 'bag.html', 'drop001.html', 'checkout.html'];
  const missing = PAGES.filter((p) => !/motion\.css/.test(fs.readFileSync(R + p, 'utf8')));
  ok('every storefront page loads it', missing.length === 0, missing.join(', '));
}

console.log('\n  reading a Shopify theme export');
{
  const im = fs.readFileSync(R + 'admin-theme-import.js', 'utf8');

  /* The two JSON files in a theme zip that are not Liquid, and therefore the
     only parts that can port without a rewrite. */
  ok('reads the theme’s settings schema and the merchant’s values',
    /settings_schema\.json/.test(im) && /settings_data\.json/.test(im));
  ok('falls back to schema defaults, so an unconfigured theme still ports',
    /s\.default !== undefined/.test(im));
  ok('handles both colour shapes: OS 2.0 schemes and the older flat ids',
    /color_schemes/.test(im) && /colors_background_1/.test(im));

  const IDS = ['buttons_radius', 'card_corner_radius', 'inputs_radius', 'media_radius',
    'heading_scale', 'spacing_sections', 'type_header_font', 'type_body_font',
    'colors_accent_1', 'colors_solid_button_labels', 'colors_text'];
  const unhandled = IDS.filter((k) => !im.includes(k));
  ok('maps the settings a real export actually contains', unhandled.length === 0, unhandled.join(', '));

  /* No library: the CSP forbids a CDN and a build step for one screen is a poor
     trade, so the zip is walked directly. */
  ok('unzips without a dependency', /0x02014b50/.test(im) && /deflate-raw/.test(im));
  ok('only inflates the files it needs, not the whole archive', /wanted\(name\)/.test(im));

  /* The honest half. A silent 40% import leaves you wondering why it looks
     wrong; a report that names what did not come across does not. */
  ok('reports what did not come across', /missed/.test(im) && /Header layout/.test(im));
  ok('lists the theme’s sections rather than pretending to import them',
    /listed rather than imported|are listed, not converted|listed rather than/.test(im));
  ok('takes settings values only — never the theme’s code, CSS or images',
    /never the theme|deliberately does not copy/.test(im));
  ok('an import is saved, not applied', /not applied yet/.test(im));

  /* Fonts were reported and then thrown away — named in the summary, absent
     from the preset. The gap only showed up when asked directly whether they
     came across, which is the argument for the report naming things precisely
     enough that someone can check them. */
  ok('fonts are applied, not merely reported', /keys\.fonts = \{ roles: roles \}/.test(im));
  ok('…as a real family with a loadable stylesheet', /fonts\.googleapis\.com\/css2\?family=/.test(im));
  ok('…and the licence that does not travel is stated, not hidden',
    /licensed foundry faces|licence that does not travel/.test(im));

  /* Icons DO port: Shopify keeps them as snippets/icon-*.liquid, which are
     inline SVG once the Liquid tags are stripped. The one part of a theme's
     actual drawing that moves, because an icon is self-contained. */
  ok('icons are pulled out of the theme’s snippets', /ICON_MAP/.test(im) && /icon-cart/.test(im));
  ok('…with Liquid stripped out of the markup', /\{%\[\\s\\S\]\*\?%\}/.test(im) || /liquid tags/.test(im));
  ok('…and recoloured to currentColor so they survive a palette change',
    /fill="currentColor"/.test(im) && /invisible on half the palettes/.test(im));
  ok('an icon with no equivalent here is skipped, not half-matched',
    /if \(!target \|\| out\[target\]\) return;/.test(im));

  /* Two Date.now() calls milliseconds apart can differ, and then `default`
     names a theme that does not exist and the storefront falls back silently. */
  ok('the theme id and the default pointing at it are computed once',
    /var themeId = 'imported-'/.test(im) && /default: themeId/.test(im));
}

console.log('\n  a theme is a snapshot, not a rewrite');
{
  const pr = fs.readFileSync(R + 'admin-theme-presets.js', 'utf8');
  ok('captures the settings that make up the look', /LOOK_KEYS/.test(pr) && /'theme_modes'/.test(pr) && /'fonts'/.test(pr) && /'icons'/.test(pr));

  /* Layout carries words and pictures; the look does not. Applying a look to a
     store with its own copy must not be able to overwrite that copy, which is
     why the two are separate lists and layout is opt-in. */
  ok('layout and content are a separate, opt-in scope', /LAYOUT_KEYS/.test(pr));
  ok('…and applying it warns that content is replaced', /REPLACED/.test(pr));

  /* A preset must never carry business data. If one of these ever appears in a
     bundle, an export becomes a data leak rather than a design file. */
  const NEVER = ['orders', 'profiles', 'products', 'customers', 'STRIPE', 'API_KEY',
    'RESEND', 'SHIPPO', 'integrations', 'tax_rate_overrides', 'feature_flags'];
  const listBlock = pr.slice(pr.indexOf('LOOK_KEYS'), pr.indexOf('var STORE_KEY'));
  const leaked = NEVER.filter((k) => new RegExp("'" + k + "'").test(listBlock));
  ok('carries no business data, keys or configuration', leaked.length === 0, leaked.join(', '));

  ok('exports as a plain file, with no templates to convert', /Blob\(/.test(pr) && /\.theme\.json/.test(pr));
  ok('an import is saved but not applied until asked', /saved but not applied/.test(pr));
  ok('re-importing the same file does not silently replace the first',
    /p\.id = 'preset-'/.test(pr));
  /* Storing an explicit null for a key that was never set would, on apply,
     write that null over a value the target store legitimately has. */
  ok('only captures keys that actually exist', /Only the keys that actually had a row/.test(pr));
}

console.log('\n  the engine reaches every themed page');
{
  const PAGES = ['index.html', 'product.html', 'bag.html', 'checkout.html', 'drop001.html',
    'account.html', 'about.html', 'journal.html', 'returns.html', 'landing.html',
    'sizeguide.html', 'policies.html', '404.html', 'confirm.html'];
  const missing = PAGES.filter((p) => fs.existsSync(R + p) && !/theme-engine\.js/.test(fs.readFileSync(R + p, 'utf8')));
  ok('every page that themes itself loads theme-engine.js', missing.length === 0, missing.join(', '));

  /* Order matters: the engine must own the palette before the older applier
     runs. Match the <script> tag specifically — product.html mentions
     storefront-theme.js in a comment 4000 lines earlier, and a naive indexOf
     reads that as "loaded first" and reports a bug that is not there. */
  const tag = (s, f) => s.search(new RegExp('<script[^>]*src="[^"]*' + f.replace('.', '\\.') + '[^"]*"'));
  const bad = PAGES.filter((p) => {
    if (!fs.existsSync(R + p)) return false;
    const s = fs.readFileSync(R + p, 'utf8');
    const a = tag(s, 'theme-engine.js'), b = tag(s, 'storefront-theme.js');
    return a !== -1 && b !== -1 && a > b;
  });
  ok('…before storefront-theme.js on every one of them', bad.length === 0, bad.join(', '));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
