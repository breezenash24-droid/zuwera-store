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

  /* The check that used to sit here asked whether the string '--zw-nav-bg'
     appeared ANYWHERE in index.html and bag.html. It did — in the light-mode
     override — so the test passed for months while index's base rule read
     `background:var(--ink)` and bag's read `#09090b`, and neither obeyed the
     theme. Setting a nav colour recoloured four pages out of ten and the user
     saw a header that changed colour as they browsed.

     A substring test cannot catch that. This one finds every rule that paints
     a nav background, on every storefront page, and requires each one to read
     the token. It fails by naming the file and the selector. */
  /* .co-header is the checkout's sticky header — a SIXTH dialect that three
     separate nav-colour passes missed, because each enumerated the dialects it
     knew and this page names its header after the checkout rather than after
     the nav. It read var(--bg) and a themed header never reached it: white bar
     on a green site. Listed here so the guard covers it, and so the next header
     named after its page fails this test instead of shipping. */
  const navSel = /\.nav(?![\w-])|\.zw-nav(?![\w-])|#nav(?![\w-])|\.co-header(?![\w-])/;
  /* The nav must be the SUBJECT of the rule, not merely an ancestor in it.
     `.nav #cart-btn .cc { background: … }` paints the bag's count badge, which
     is supposed to contrast WITH the header rather than match it — demanding
     the nav token there would be wrong. So reduce each selector in the list to
     its final compound and test that. */
  const paintsNav = (sel) => {
    // Collapse spaces inside (...) first, or `:is(#nav, .nav)` splits on its
    // own comma and space and stops looking like one compound.
    const masked = sel.replace(/\([^()]*\)/g, (g) => g.replace(/\s+/g, ''));
    return masked.split(',').some((one) => {
      const last = one.trim().split(/[\s>~+]+/).filter(Boolean).pop() || '';
      // ::before on the nav IS the nav's paint (the safe-area strip), so drop a
      // trailing pseudo before testing rather than excluding it.
      const bare = last.replace(/::?[\w-]+(\([^)]*\))?$/, '');
      return navSel.test(bare || last);
    });
  };
  const pages = fs.readdirSync(R)
    .filter(f => f.endsWith('.html') && !/^(admin|builder)/.test(f));
  const offenders = [];
  for (const file of ['nav.css', 'storefront-cohesion.css', ...pages]) {
    const src = fs.readFileSync(R + file, 'utf8');
    // .html carries its CSS in <style>; .css is CSS throughout.
    const cssRaw = file.endsWith('.css')
      ? src
      : (src.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || []).join('\n');
    /* Comments stripped BEFORE parsing. Declarations are found by splitting the
       block on ';' and requiring `background:` at the start of a piece — and a
       comment sitting above the declaration lands inside that piece and pushes
       `background` off the front, so the rule is skipped. That is not
       hypothetical: it silently exempted the very rule in index.html this
       check was written to guard, and only showed up when the bug was
       deliberately reintroduced to confirm the test could see it. */
    const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, ' ');
    let m;
    const rule = /([^{}]*)\{([^{}]*)\}/g;
    while ((m = rule.exec(css))) {
      const sel = m[1], decls = m[2];
      if (!paintsNav(sel)) continue;
      for (const d of decls.split(';')) {
        if (!/^\s*background(-color)?\s*:/.test(d)) continue;
        // Only colour values are in scope — `none`, `transparent` and
        // gradients are not the header's paint and need no token.
        if (!/#[0-9A-Fa-f]{3,8}|\brgba?\(|\bhsla?\(|var\(--/.test(d)) continue;
        // The nav's ::after is the mega-menu scrim — a full-viewport dim that
        // belongs to the modal-backdrop system and reads its tokens. It is
        // painted ON the nav element but is not the header's colour.
        if (d.includes('--zw-mbd-')) continue;
        if (d.includes('--zw-nav-bg')) continue;
        offenders.push(file + ' → ' + sel.trim().split('\n').pop().trim());
      }
    }
  }
  ok('every rule that paints a nav background reads --zw-nav-bg',
    offenders.length === 0,
    offenders.length + ' ignore the theme: ' + offenders.join(' | '));
  ok('sets its tokens on body, where the ladder computes and the class lives',
    /document\.body \|\| root/.test(eng) && /el\.style\.setProperty/.test(eng),
    'setting them on :root loses to body.light-mode and a custom theme gets the built-in colours');

  const st = fs.readFileSync(R + 'storefront-theme.js', 'utf8');
  ok('the old applier delegates instead of duplicating',
    /window\.ZWTheme && window\.ZWTheme\.get\(mode\)/.test(st));

  const sf = fs.readFileSync(R + 'storefront.js', 'utf8');
  ok('section backgrounds can name a theme token', /token:/.test(sf) && /resolveSectionBackground/.test(sf));
  /* A section saved before tokens existed holds an absolute colour, so it kept
     its old palette while everything around it moved — the black band on a
     light imported theme, and the "one section did not get the theme" report.

     A literal that is EXACTLY a built-in palette colour was never a decision
     about that colour; it is what the picker returned when someone chose "a
     dark band" and naming the intention was not yet possible. Those read as the
     token they stood for. A colour matching none of them was genuinely chosen
     and is left alone. */
  ok('a legacy literal that names a built-in palette colour follows the theme',
    /LEGACY_BG_TOKENS/.test(sf) && /'#09090b': 'ink'/.test(sf));
  ok('…and a colour that is nobody’s palette entry is still honoured exactly',
    /const legacy = LEGACY_BG_TOKENS\[raw\.toLowerCase\(\)\];/.test(sf) &&
    /return legacy \? SECTION_BG_TOKENS\[legacy\] : raw;/.test(sf));
  /* Resolved at READ time. Rewriting what is stored would destroy the literal
     the builder's "Custom colour" option needs to put it back. */
  ok('…without rewriting what is stored', !/sec_bg\s*=\s*['"]token:/.test(sf));

  /* ink and paper are a PAIR. A band whose background follows the theme with
     text that does not is the disappearing-words bug: token:ink is dark on a
     dark theme and light on a light one, so a cream literal beside it reads
     fine until the theme changes and then vanishes. */
  ok('section text runs through the same resolver as its background',
    /const _tc = resolveSectionBackground\(s\.text_color\);/.test(sf));
  const ls = fs.readFileSync(R + 'landing-sections.js', 'utf8');
  ok('…and landing pages share the resolver rather than copying it',
    /window\.zwResolveSectionBg/.test(sf) &&
    /window\.zwResolveSectionBg \|\| String/.test(ls),
    'a second copy is a second thing to forget to update');
  const bl = fs.readFileSync(R + 'builder.html', 'utf8');
  ok('a new section is born following the theme, not holding a literal',
    /sec_bg:'token:ink',text_color:'token:paper'/.test(bl) &&
    !/sec_bg:'#[0-9a-fA-F]{6}'/.test(bl));

  /* One button per builder page, because the read-time rescue only catches
     literals that exactly match a built-in — a page built with any other colour
     stayed pinned, and fixing it meant opening every section. This converts by
     INTENT: a dark band becomes the inverted pair, a light one becomes the
     page, so the look survives and now moves with the theme. */
  ok('every builder page can be made to follow the theme in one action',
    /zwFollowTheme/.test(bl) && /Make this page follow the theme/.test(bl));
  /* The pairing is the point. token:ink is dark on a dark theme and LIGHT on a
     light one, so converting a band while its text stayed a literal reads fine
     today and loses its words the first time the theme changes. */
  ok('…converting a band always converts its text with it',
    /if\(dark\)g\.text_color='token:paper';/.test(bl),
    'a converted band beside a literal is the disappearing-words bug');
  ok('…and it is undoable, since it rewrites a whole page at once',
    /curPushUndo\(\);\s*\n\s*let n=0;/.test(bl));
  /* A gradient or an image has no luminance to read, and a colour_block exists
     to hold a colour someone picked. Neither should be quietly overwritten. */
  ok('…while anything without a readable colour is left alone',
    /if\(lum===null\)return;/.test(bl) && /bg_color:'#1f2937'/.test(bl));
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
  /* This used to assert the opposite — that the scale was applied to <html>, so
     every rem moved together. It did, and that was the bug: the stylesheet
     mixes rem and px, worst of all in the header, where nav padding is
     0.5rem 2.5rem and the logo is height:50px. At scale 1.25 the padding grew,
     the logo did not, and the header came apart. An imported theme arriving
     with 1.25 shipped that to a live page.

     So the invariant is now the reverse, and it is asserted as a prohibition
     because that is the part that must not regress: the scale drives the
     display type tokens and must never reach the root. */
  ok('the type scale drives the display type tokens',
    /--text-hero:\s*calc\(.*var\(--zw-type-scale, 1\)\)/.test(base2) &&
    /--text-display:\s*calc\(.*var\(--zw-type-scale, 1\)\)/.test(base2) &&
    /--text-title:\s*calc\(.*var\(--zw-type-scale, 1\)\)/.test(base2));
  /* Comments stripped first: the note explaining WHY the root is not scaled
     quotes the removed rule verbatim, and a prohibition that reads comments
     fails on its own explanation. */
  const base2Code = base2.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('…and it must NOT scale the root, which breaks the px/rem header',
    !/html\s*\{[^}]*font-size:\s*calc\([^}]*--zw-type-scale/.test(base2Code),
    'scaling <html> grows rem padding while px logos stay put');
  ok('small type is left alone, so labels and micro-copy still fit',
    /--text-body:\s*[\d.]+rem;/.test(base2) && !/--text-body:\s*calc/.test(base2));
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

console.log('\n  the import actually runs');
{
  /* Every check in this file was a regex over source, and a regex cannot see
     that `col` stopped existing. The import shipped throwing "col is not
     defined" on the first click with all of them green — so this block calls
     build() for real, which is the only kind of check that would have caught
     it. */
  const src = fs.readFileSync(R + 'admin-theme-import.js', 'utf8');
  const body = src.slice(src.indexOf("'use strict';") + 13, src.lastIndexOf('})();'));
  global.window = {};
  global.document = { getElementById() { return null; }, readyState: 'complete', addEventListener() {} };

  let mod = null, threw = '';
  try {
    mod = new Function('TextDecoder', 'TextEncoder', body + '; return {build:build, baseFor:baseFor};')(TextDecoder, TextEncoder);
  } catch (e) { threw = e.message; }
  ok('the module body evaluates', !!mod, threw);

  if (mod) {
    const schema = [
      { name: 'theme_info', theme_name: 'Dawn' },
      { name: 'Colors', settings: [
        { id: 'colors_accent_1', default: '#E4572E' }, { id: 'colors_text', default: '#121212' },
        { id: 'colors_background_1', default: '#FFFFFF' }, { id: 'colors_solid_button_labels', default: '#FFFFFF' }] },
      { name: 'Type', settings: [{ id: 'type_header_font', default: 'archivo_n7' }, { id: 'type_body_font', default: 'assistant_n4' }] },
      { name: 'Layout', settings: [{ id: 'buttons_radius', default: 8 }, { id: 'heading_scale', default: 115 }] },
    ];
    let built = null, err = '';
    try {
      built = mod.build(schema, { current: { colors_background_1: '#0B0B0B' } },
        { order: ['a'], sections: { a: { type: 'image-banner' } } }, 'Dawn', { bag: '<svg/>' });
    } catch (e) { err = e.message; }
    ok('build() completes on a realistic export', !!built, err);

    /* The header was the one part an import never carried: it was read from
       nothing, so every Shopify theme landed on our arrangement no matter what
       it actually looked like — the fastest thing to recognise about a
       storefront and the last thing to come across. Dawn states it in
       header_layout; the three values below are its whole vocabulary. */
    const hdrOf = (layout) => {
      const s = schema.concat([{ name: 'Header', settings: [{ id: 'header_layout', default: layout }] }]);
      const b = mod.build(s, {}, null, 'Dawn', {});
      return b && b.preset.keys.theme_modes.modes[0].tokens.header;
    };
    for (const [layout, want] of [['middle-left', 'tight'], ['middle-center', 'split'], ['top-center', 'stacked']]) {
      ok('Dawn’s ' + layout + ' header imports as ' + want, hdrOf(layout) === want,
        'got ' + JSON.stringify(hdrOf(layout)));
    }
    /* A layout name nobody mapped must leave the header alone rather than
       guess. Shipping a shape the merchant never chose is worse than shipping
       the one they already had. */
    ok('an unknown arrangement leaves the header alone', hdrOf('sideways-vertical') === undefined,
      'got ' + JSON.stringify(hdrOf('sideways-vertical')));
    ok('…and a theme that says nothing about it keeps ours',
      built.preset.keys.theme_modes.modes[0].tokens.header === undefined);

    if (built) {
      const tm = built.preset.keys.theme_modes;
      ok('the default names a theme that exists', tm.default === tm.modes[0].id);
      ok('a dark background chooses the dark structural CSS', tm.modes[0].base === 'dark');
      ok('fonts land in the preset', !!built.preset.keys.fonts);
      ok('icons land in the preset', !!(built.preset.keys.icons || {}).custom);
    }

    /* Luminance, not an average: 128 128 128 and 0 255 0 have the same mean and
       nothing else in common — green reads far lighter than grey. */
    ok('the base is judged by luminance', mod.baseFor('0 255 0') === 'light' && mod.baseFor('9 9 11') === 'dark');
    ok('a missing background does not throw', mod.baseFor('') === 'light' && mod.baseFor(undefined) === 'light');

    /* Two shapes a real export uses that the first reader could not see. Both
       were found by importing an actual theme and watching nine of eleven rows
       come back "Not mapped" — neither is exotic, and both are what the
       download button produces rather than what an edited store does. */
    const OS2 = [
      { name: 'theme_info', theme_name: 'Modern' },
      { name: 'Colors', settings: [{ type: 'color_scheme_group', id: 'color_schemes', definition: [
        { type: 'color', id: 'background', default: '#FFFFFF' }, { type: 'color', id: 'text', default: '#121212' },
        { type: 'color', id: 'button', default: '#121212' }, { type: 'color', id: 'button_label', default: '#FFFFFF' }] }] },
      { name: 'Type', settings: [
        { type: 'font_picker', id: 'type_heading_font', default: 'geist_n7' },
        { type: 'font_picker', id: 'type_body_font', default: 'geist_n4' }] },
      { name: 'Layout', settings: [{ type: 'range', id: 'card_corner_radius', default: 2 }] },
    ];

    /* settings_data straight from the download names its live preset and puts
       the values in presets[name]. Treating a string `current` as "no values"
       threw away the entire file — which is exactly what a real import did. */
    const named = { current: 'Default', presets: { Default: {
      color_schemes: { 'scheme-1': { settings: { background: '#0F0F0F', text: '#F5F5F5', button: '#E4572E', button_label: '#FFFFFF' } } },
      type_heading_font: 'geist_n7', type_body_font: 'geist_n4', card_corner_radius: 2 } } };
    const fromPreset = mod.build(OS2, named, null, 'Modern', {});
    const pt = fromPreset.preset.keys.theme_modes.modes[0].tokens;
    ok('a preset-named settings_data is read, not discarded',
      pt.bg === '15 15 15' && pt.fg === '245 245 245', JSON.stringify(pt));
    ok('…and the theme it produces takes its base from those values',
      fromPreset.preset.keys.theme_modes.modes[0].base === 'dark');
    ok('a real export maps most of its rows, not two of them',
      fromPreset.report.got.length >= 8, fromPreset.report.got.length + ' of 11');

    /* Online Store 2.0 declares colours as a group with a `definition` array
       and no `default` on the setting itself. A reader looking only for
       `default` sees no colours at all in a modern theme. */
    const unconfigured = mod.build(OS2, { current: 'Default', presets: { Default: {} } }, null, 'Modern', {});
    const ut = unconfigured.preset.keys.theme_modes.modes[0].tokens;
    ok('a colour_scheme_group in the schema is flattened and read',
      ut.bg === '255 255 255' && ut.fg === '18 18 18', JSON.stringify(ut));

    ok('the heading font is found under whichever id the theme uses',
      fromPreset.report.fonts.head === 'Geist' && unconfigured.report.fonts.head === 'Geist');

    /* A third naming generation, taken from a real Fabric v4.1.3 export. This
       is its SHAPE, not its content — enough to hold the behaviour without
       vendoring someone else's licensed theme into the repo.

       Fabric declares one color_palette and then makes thirty colour settings
       point at it with Liquid: "{{ settings.color_palette.background }}". A
       reader looking for hex finds none of them, which is how a real theme
       imported with every colour row blank. */
    const FABRIC_SCHEMA = [
      { name: 'theme_info', theme_name: 'Fabric', theme_version: '4.1.3' },
      { name: 'Colors', settings: [
        { type: 'color_palette', id: 'color_palette', default: { background: '#ffffff', foreground: '#000000' } },
        { type: 'color', id: 'page_background_color' },
        { type: 'color', id: 'page_text_color' }] },
      { name: 'Type', settings: [
        { type: 'font_picker', id: 'type_heading_font' },
        { type: 'font_picker', id: 'type_body_font' }] },
    ];
    const FABRIC_DATA = { current: {
      color_palette: { background: '#ffffff', foreground: '#030302', color1: '#d3cec5', color2: '#F5F5F5' },
      page_background_color: '{{ settings.color_palette.background }}',
      page_text_color: '{{ settings.color_palette.foreground }}',
      type_heading_font: 'geist_n6', type_body_font: 'geist_n4',
      card_corner_radius: 2, type_size_h1: '72',
    } };

    const fab = mod.build(FABRIC_SCHEMA, FABRIC_DATA, null, 'Fabric', {});
    const ft = fab.preset.keys.theme_modes.modes[0].tokens;
    ok('a color_palette theme maps its colours', ft.bg === '255 255 255' && ft.fg === '3 3 2', JSON.stringify(ft));
    ok('…including the palette roles beyond background and text',
      ft.accent === '#d3cec5' && ft.surface === '#F5F5F5');
    ok('a Liquid reference resolves to the colour it points at',
      fab.report.pool.colours.some((c) => c.id === 'page_background_color' && c.value === '#ffffff'),
      'settings pointing at the palette must be selectable in the table too');
    /* Dawn gives a percentage, Fabric gives h1 in pixels. Told apart by
       magnitude, because the admin has no way to know which unit their theme
       used and should not be asked. */
    ok('an h1 size in pixels becomes a type scale', ft.typeScale > 1 && ft.typeScale <= 1.25, String(ft.typeScale));
    ok('a real export maps almost every row', fab.report.got.length >= 9, fab.report.got.length + ' of 11');

    /* The bug that made the bag icon disappear. --ink is a surface and --paper
       is the text on it, and BOTH track the page — the nav draws its links and
       the bag with color: var(--paper). Mapping paper from Shopify's button
       label put Dawn's white #FFFFFF there, so the header rendered white text
       on a white page. An imported theme has to leave the header readable. */
    const lum = (v) => {
      const p = String(v).startsWith('#')
        ? [1, 3, 5].map((i) => parseInt(String(v).substr(i, 2), 16))
        : String(v).split(/\s+/).map(Number);
      return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
    };
    for (const [name, built] of [['palette theme', fab], ['scheme theme', fromPreset]]) {
      const tk = built.preset.keys.theme_modes.modes[0].tokens;
      ok('the nav text contrasts with the page — ' + name,
        Math.abs(lum(tk.bg) - lum(tk.paper)) > 60,
        'bg ' + tk.bg + ' vs paper ' + tk.paper);
    }

    /* The same mismatch one level in. A panel painted var(--ink) whose text
       reads the page ladder is drawing PAGE-foreground colours on a PANEL
       background. Identical in the built-in themes, where --paper and
       rgb(--fg-rgb) are the same colour; pale-grey-on-white as soon as an
       imported theme sets them apart, which is what happened to the quick-add
       modal's size buttons and its LEAVE / FULL PRODUCT PAGE row.

       So inside that panel the page ladder is off limits, and the rungs it
       does use must be re-keyed on the panel itself — declaring them anywhere
       higher resolves against the page and inherits the finished colour. */
    const qa = fs.readFileSync(R + 'quick-add-modal.css', 'utf8');
    ok('the panel does not colour its text from the page foreground',
      !/rgb\(var\(--fg-rgb\)/.test(qa),
      'page-keyed text on a panel-keyed background is invisible whenever a theme separates them');
    const rekeyed = qa.slice(qa.indexOf('.quick-add-review-modal>.mbox'));
    for (const rung of (qa.match(/var\(--c\d\d\)/g) || []))
      ok('…and ' + rung + ' is re-keyed on the panel before it is used',
        rekeyed.includes('--' + rung.slice(6, 9) + ':'),
        'a rung declared on body resolves against the page and inherits the result');
  }

  /* The old heuristics encoded a second, contradictory answer to "which setting
     becomes the accent". Unreachable, but waiting for someone to trust it. */
  ok('the mapping the table replaced is gone, not left as a rival', !/pickColours/.test(src));
}

console.log('\n  the mapping is shown, and correctable');
{
  const im = fs.readFileSync(R + 'admin-theme-import.js', 'utf8');

  /* Every mapping is a guess: themes disagree about which setting means what.
     Hiding the guesses is what makes a half-right import feel like a bug. */
  ok('the mapping is data, not control flow', /var TARGETS = \[/.test(im) && /function autoAssign/.test(im));
  ok('one place produces tokens, so an edited row cannot be ignored',
    /function compose\(pool, assign\)/.test(im) && /The ONLY place tokens are produced/.test(im));
  ok('every row is shown with what it read', /function renderMapping/.test(im));
  ok('…and every alternative the theme actually contained', /pool\.colours : t\.kind === 'number'/.test(im));
  ok('changing a row rebuilds the preset', /window\.shopifyRemap/.test(im));
  ok('“not mapped” clears the token rather than leaving the old guess behind',
    /delete modes\[0\]\.tokens\[t\.key\]/.test(im));
  ok('the parsed zip is kept so a change does not need the file again',
    /lastBuild = built/.test(im));

  /* Shopify font handles are family_weightstyle — archivo_n7, not archivo_n700.
     Demanding the three-digit form matched nothing, so fonts found no source
     at all and the table showed two empty rows with no explanation. */
  ok('font handles are matched in the shape Shopify actually writes',
    /_\[ni\]\[1-9\]/.test(im) && /weight digit is single/.test(im));
}

console.log('\n  the announcement bar is themeable too');
{
  const bar = fs.readFileSync(R + 'announcement-bar.js', 'utf8');
  const eng = fs.readFileSync(R + 'theme-engine.js', 'utf8');
  const at = fs.readFileSync(R + 'admin-themes.js', 'utf8');

  /* It was #09090b on every page, with only the homepage overriding it from
     builder_theme — the one strip above everything else was the least
     themeable thing on the site. */
  ok('the bar reads theme tokens', /var\(--zw-bar-bg,#09090b\)/.test(bar) && /var\(--zw-bar-fg,#F0EEE9\)/.test(bar));
  ok('…falling back to exactly what it hardcoded', /#09090b/.test(bar) && /#F0EEE9/.test(bar));
  ok('the theme can set them', /set\('--zw-bar-bg', t\.barBg\)/.test(eng));
  ok('and the editor offers them like the header’s', /barBg/.test(at) && /barFg/.test(at));
  ok('both are optional, so an unset theme leaves the bar alone',
    /key: 'barBg'[^}]*optional: true/.test(at));
}

console.log('\n  header composition');
{
  const nav = fs.readFileSync(R + 'nav.css', 'utf8');
  const eng = fs.readFileSync(R + 'theme-engine.js', 'utf8');
  const at = fs.readFileSync(R + 'admin-themes.js', 'utf8');

  /* Attributes, not custom properties: what changes is a set of grid/flex
     placements — a shape, and CSS cannot switch shapes on a variable.

     Five presets were five hardcoded answers to a question with three
     independent variables, so they could not express "categories left with a
     centred logo" or "bag in the middle" — ordinary Shopify arrangements, and
     the reason an imported header never quite matched. Each part is placed on
     its own now, and a preset is only a NAME for a combination. */
  ok('each part of the header is placed on its own',
    /data-zw-hdr-logo/.test(eng) && /data-zw-hdr-links/.test(eng) && /data-zw-hdr-actions/.test(eng));
  ok('…and the links can take a row of their own', /data-zw-hdr-linksrow/.test(eng));
  /* The attributes ARE the state. Overwriting only the ones the incoming theme
     mentions leaves the previous theme's placement behind — which is exactly
     how a header keeps serving the old layout after a switch. */
  ok('switching to an unplaced theme clears every attribute, not some',
    /attrs\.forEach\(function \(a\) \{ root\.removeAttribute\(a\); \}\)/.test(eng));

  /* The engine expands a preset name and the editor expands it again for the
     preview. If the two tables disagree the preview shows one header and the
     storefront renders another, so they are compared rather than trusted. */
  const tableOf = (src) => {
    const m = src.match(/HDR_PRESETS = \{([\s\S]*?)\n  \};/);
    if (!m) return null;
    return m[1].replace(/\s+/g, ' ').trim();
  };
  const engTable = tableOf(eng), atTable = tableOf(at);
  ok('the engine and the editor expand presets identically',
    !!engTable && engTable === atTable,
    'engine: ' + engTable + '  editor: ' + atTable);

  // Every placement the admin offers must exist in CSS, or it silently does nothing.
  for (const part of ['logo', 'links', 'actions']) {
    for (const spot of ['left', 'center', 'right']) {
      ok('CSS implements ' + part + ' → ' + spot,
        nav.includes('data-zw-hdr-' + part + '="' + spot + '"'));
    }
  }
  ok('…and categories can be hidden into the menu', nav.includes('data-zw-hdr-links="none"'));

  /* .nav-center is absolutely positioned by default so the mega-menu can span
     the viewport. `order` does nothing to an out-of-flow box, so any placement
     that puts the links in the row has to return them to the flow first. */
  for (const spot of ['left', 'right']) {
    ok('links placed ' + spot + ' rejoin the flow, or order does nothing',
      new RegExp('data-zw-hdr-links="' + spot + '"[^{]*\{[^}]*position: static').test(nav));
  }
  ok('…and a row of their own is a wrap, not a second grid',
    /data-zw-hdr-linksrow="2"[^{]*\{ flex-wrap: wrap; \}/.test(nav) &&
    /data-zw-hdr-linksrow="2"[^{]*\.nav-center \{[\s\S]{0,160}flex: 0 0 100%/.test(nav));

  /* Every part of the header must be addressed by every spelling it has. The
     presets originally named `.nav` and `.nav-logo` only, so on the product
     page (nav.nav / .nav-logo-link) the grid applied while the logo rule
     matched nothing — the logo fell into the empty spacer cell and the header
     came apart. Each dialect is asserted by name so a page cannot be left out
     again, and `:first-child` catches a sixth dialect nobody has written yet. */
  for (const dialect of ['#nav', '.zw-nav', '.nav-logo-link', '.zw-nav-logo', '.nav-actions', '.zw-nav-right', ':first-child']) {
    ok('the placements address ' + dialect + ', which real pages use',
      nav.includes(dialect),
      'a rule that names markup no page has silently scatters that page');
  }

  /* A centred two-row header on a phone spends a third of the viewport on
     chrome, and the mobile menu already owns the links there. Undoing this
     means undoing `order`, the auto margins AND the wrap — not just display. */
  ok('every placement collapses on phones',
    /@media \(max-width: 900px\)[\s\S]{0,600}html\[data-zw-hdr\][^{]*\{[\s\S]{0,120}flex-wrap: nowrap/.test(nav));
  ok('…including the order and margins, or the parts stay rearranged',
    /@media \(max-width: 900px\)[\s\S]{0,900}order: 0;[^}]*margin-left: 0/.test(nav));
  ok('…and the desktop placements are behind a min-width, not applied everywhere',
    /@media \(min-width: 901px\)[\s\S]{0,900}data-zw-hdr-logo="left"/.test(nav));

  /* Hiding the links must not strand them, or those pages become unreachable
     on desktop. This used to require `.zw-mobile-menu-btn`, a class that exists
     nowhere in this repo — so it passed while the links were hidden and nothing
     was revealed. `.hamburger-btn` is the real one, checked against the markup
     rather than trusting the stylesheet to name something real. */
  ok('hiding the categories moves them to the menu rather than deleting them',
    /data-zw-hdr-links="none"[^{]*\.nav-center \{ display: none/.test(nav) &&
    /data-zw-hdr-links="none"[^{]*\.hamburger-btn/.test(nav));
  ok('…and the button it reveals is one the pages actually have',
    fs.readdirSync(R).filter((f) => f.endsWith('.html'))
      .some((f) => fs.readFileSync(R + f, 'utf8').includes('class="hamburger-btn"')));

  /* Per-control ordering and visibility.

     `order` is a custom property, which `display` could not be, and that is
     what keeps this to one rule per control instead of one per position — and
     what makes it survive controls that appear LATE. The search button is
     injected by a feature flag and the account button by auth, both after the
     theme applies; a JS pass setting order directly would have to re-run on
     each, while an inherited property is already correct. */
  ok('order is a property, so late-injected controls are already correct',
    /order: var\(--zw-ord-search, 0\)/.test(nav) && /order: var\(--zw-ord-bag, 0\)/.test(nav));
  /* The two button systems are NOT the same set by name, and only spellings
     confirmed present in the markup may be named — the `.nav-logo` mistake. */
  for (const [role, sel] of [['bag', '.zw-hdr-bag'], ['login', '#hdr-login'], ['bag', '#cart-btn'],
                             ['account', '#account-btn'], ['search', '.zwf-search-btn']])
    ok('the ' + role + ' control is addressed as ' + sel, nav.includes(sel));
  const navHtml = fs.readdirSync(R).filter((f) => f.endsWith('.html'))
    .map((f) => fs.readFileSync(R + f, 'utf8')).join('\n');
  for (const sel of ['zw-hdr-bag', 'hdr-login', 'cart-btn', 'account-btn'])
    ok('…and ' + sel + ' is markup that actually exists', navHtml.includes(sel),
      'naming a control no page has is how the header came apart before');
  ok('hiding is one attribute with ~=, not a rule per combination',
    /html\[data-zw-hide~="bag"\]/.test(nav) && /html\[data-zw-hide~="search"\]/.test(nav));
  /* On a phone the hamburger is the only route to the categories. A theme that
     hid it would strand every collection page behind a control that is gone. */
  ok('the menu button cannot be hidden, or the drawer becomes unreachable',
    !/data-zw-hide~="menu"/.test(nav) && /k !== 'menu'/.test(eng));
  ok('an unset order restores DOM order rather than pinning everything to 0',
    /root\.style\.removeProperty\('--zw-ord-' \+ k\)/.test(eng));
  ok('the editor offers every control the engine knows',
    /themeSetIcon/.test(at) &&
    ['search', 'account', 'login', 'logout', 'shop', 'bag', 'menu']
      .every((k) => new RegExp("\\['" + k + "', '").test(at)));
  ok('…and menu is offered without a hide box',
    /k === 'menu' \? '<span/.test(at),
    'a hideable menu button strands the categories on a phone');
  /* An icons object left behind empty would ride along in every export and
     read as a setting nobody chose. */
  ok('…and the setting prunes itself back to absent when nothing is set',
    /if \(Object\.keys\(next\)\.length\) m\.tokens\.icons = next; else delete m\.tokens\.icons;/.test(at));

  /* "Account in the bag" was not a metaphor — the bag-panel feature moves the
     account link into the panel and hides the header's button outright. That
     hiding is now opt-out rather than automatic. */
  const feat = fs.readFileSync(R + 'storefront-features.js', 'utf8');
  ok('the bag panel only quiets the header account button when allowed to',
    /body\.zwf-bagpanel-on:not\(\[data-zw-account="header"\]\)/.test(feat));
  /* :not() on the same element, so ABSENT is the behaviour this always had —
     no existing store changes when this ships. */
  ok('…and the default is exactly what it did before',
    /accountIn === 'header'/.test(eng) && /removeAttribute\('data-zw-account'\)/.test(eng));
  /* The rule is written against body.zwf-bagpanel-on, so the attribute has to
     be on body too — the flag class lives there, not on <html>. */
  ok('…with the attribute on body, where the rule it answers is anchored',
    /el\.setAttribute\('data-zw-account', 'header'\)/.test(eng));
  ok('the editor offers it, defaulting to a value that deletes the key',
    /accountIn/.test(at) && /\['', 'In the bag panel/.test(at));

  /* Icons as words. Driven off aria-label — which every one of these controls
     already carries — so it needs no markup change and cannot miss a nav
     dialect, which is the failure this file exists to prevent. */
  ok('the label is the accessible name, not a second copy of it',
    /content: attr\(aria-label\)/.test(nav),
    'a hand-written label would drift from what a screen reader announces');
  ok('…and it replaces the glyph rather than joining it',
    /data-zw-iconlabels[^{]*> svg \{ display: none; \}/.test(nav),
    'showing both makes the control announce itself twice');
  for (const control of ['#cart-btn', '.zwf-search-btn', '.hamburger-btn']) {
    ok('words reach ' + control, nav.includes(control));
  }
  ok('phone-and-tablet scope is behind a max-width, so desktop keeps its icons',
    /@media \(max-width: 1024px\)[\s\S]{0,400}data-zw-iconlabels="mobile"/.test(nav));
  /* Absent must REMOVE the attribute: `[data-zw-iconlabels]` on its own matches
     the shared styling rule, so a value CSS has no scope for would still style
     a label that never appears. */
  ok('the engine removes the attribute rather than writing an unknown scope',
    /removeAttribute\('data-zw-iconlabels'\)/.test(eng) &&
    /t\.iconLabels === 'mobile' \|\| t\.iconLabels === 'always'/.test(eng));
  ok('the label font matches the body font until one is named',
    /var\(--zw-label-font, var\(--fb, inherit\)\)/.test(nav) &&
    /set\('--zw-label-font', t\.labelFont\)/.test(eng));
  ok('…and clearing it deletes the key instead of storing an empty value',
    /if \(v && v !== 'off'\) m\.tokens\[key\] = v; else delete m\.tokens\[key\];/.test(at),
    "'' would beat the CSS fallback and land on the browser default");

  ok('the editor can move a single part without losing the others',
    /themeSetHeaderPart/.test(at) && /headerSpec\(m\.tokens\.header\)/.test(at));
  ok('…and stores it back as a preset name when it still matches one',
    /matchPreset\(spec\)/.test(at),
    'otherwise a theme saved as "stacked" silently becomes four coordinates');

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

  /* colors_solid_button_labels is deliberately NOT here any more. It used to
     feed --paper, which is not a button label in this codebase but the text the
     nav draws its links and the bag with — so Dawn's white #FFFFFF landed there
     and the header rendered white on white. A theme wanting its own button
     colours sets accent; that is what accent is for. */
  const IDS = ['buttons_radius', 'card_corner_radius', 'inputs_radius', 'media_radius',
    'heading_scale', 'spacing_sections', 'type_header_font', 'type_body_font',
    'colors_accent_1', 'colors_text', 'color_palette', 'page_background_color'];
  const unhandled = IDS.filter((k) => !im.includes(k));
  ok('maps the settings a real export actually contains', unhandled.length === 0, unhandled.join(', '));
  ok('…and no longer feeds a button label into the page text',
    !/colors_solid_button_labels/.test(im));

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

console.log('\n  applying a theme does not delete the others');
{
  const pr = fs.readFileSync(R + 'admin-theme-presets.js', 'utf8');

  /* theme_modes is a LIST. A preset carrying one theme was overwriting the whole
     row, so applying an imported theme deleted Dark, Light, Super Light and every
     custom theme — irreversibly, since the presets screen has no undo. */
  ok('the theme list merges rather than replacing', /function mergeThemeModes/.test(pr));
  /* A table rather than a branch, because there turned out to be two composite
     keys and finding the second one the hard way suggests there may be a third. */
  ok('composite keys are declared, not special-cased inline',
    /var MERGERS = \{/.test(pr) && /if \(MERGERS\[k\]\) value = MERGERS\[k\]/.test(pr));
  ok('…and anything not listed still replaces, which is what those mean',
    /Anything\s*\n?\s*(?:\*\s*)?not listed replaces wholesale/.test(pr));

  const body = pr.slice(pr.indexOf('function mergeThemeModes'), pr.indexOf('async function writeKeys'));
  const merge = new Function(body + '; return mergeThemeModes;')();

  const existing = { modes: [{ id: 'dark' }, { id: 'light' }, { id: 'two-tone' }], default: 'dark' };
  const incoming = { modes: [{ id: 'imported-x', label: 'Dawn' }], default: 'imported-x' };
  const out = merge(existing, incoming);
  ok('the themes that were there survive', out.modes.length === 4,
    out.modes.map((m) => m.id).join(','));
  ok('the imported one is added and becomes the default', out.default === 'imported-x');

  const same = merge(existing, { modes: [{ id: 'light', label: 'Edited' }], default: 'light' });
  ok('re-applying replaces by id rather than duplicating',
    same.modes.length === 3 && same.modes.filter((m) => m.id === 'light')[0].label === 'Edited');

  const junkDefault = merge(existing, { modes: [{ id: 'a' }], default: 'does-not-exist' });
  ok('a default naming nothing falls back rather than blanking the site',
    junkDefault.default === 'dark');

  ok('an empty existing row still works', merge(null, incoming).modes.length === 1);

  /* fonts is three roles plus per-section overrides. An import knows two roles
     and nothing else, so writing it wholesale deleted roles.mono — which ~29
     rules read through --zw-font-mono — along with every section override. Same
     shape of bug as theme_modes: a partial value overwriting a composite one. */
  ok('fonts is treated as composite too', /function mergeFonts/.test(pr));
  const fbody = pr.slice(pr.indexOf('function mergeFonts'), pr.indexOf('/* Which keys are composite'));
  const mergeF = new Function(fbody + '; return mergeFonts;')();

  const before = {
    roles: { head: { stack: 'A' }, body: { stack: 'B' }, mono: { stack: 'IBM Plex Mono' } },
    sections: { hero: { stack: 'Custom' } },
  };
  const after = mergeF(before, { roles: { head: { stack: 'Geist' }, body: { stack: 'Geist' } } });
  ok('an import replaces the roles it knows', after.roles.head.stack === 'Geist');
  ok('…and leaves mono alone', after.roles.mono.stack === 'IBM Plex Mono');
  ok('…and keeps the per-section overrides', after.sections.hero.stack === 'Custom');
  ok('a first-ever import into an empty row still works',
    mergeF(null, { roles: { head: { stack: 'X' } } }).roles.head.stack === 'X');

  /* Merging protects future applies; it cannot resurrect what an earlier one
     deleted. The engine only falls back to the built-ins when the row is EMPTY,
     and a list holding one imported theme is not empty — so a store whose list
     was overwritten has no way back without this. */
  const at2 = fs.readFileSync(R + 'admin-themes.js', 'utf8');
  ok('there is a way to put the built-in themes back', /themeRestoreBuiltins/.test(at2));
  ok('…which adds only what is missing', /!state\.modes\.some/.test(at2));
  ok('…and does not touch a built-in that was recoloured on purpose',
    /including a built-in you have recoloured/.test(at2));
  ok('the button exists', /themeRestoreBuiltins\(\)/.test(fs.readFileSync(R + 'admin.html', 'utf8')));
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

console.log('\n  pasted icons are sanitised');
{
  /* A custom icon is inserted with innerHTML into every page of the storefront,
     so a bad one is stored XSS across the whole site. What guarded it was

       String(custom).replace(/<script[\s\S]*?<\/script>/gi, '')

     which failed three ways: it needs a CLOSING tag, so `<svg><script>alert(1)`
     walked through untouched; it said nothing about event handlers; and it said
     nothing about javascript: hrefs, <foreignObject> (arbitrary HTML) or
     <image href="http://…"> (which phones home with the visitor's IP on every
     page that draws the icon). */
  const ic = fs.readFileSync(R + 'icon-sets.js', 'utf8');
  ok('the strip-the-script-tag guard is gone, not merely supplemented',
    !ic.includes('<script[\\s\\S]*?<\\/script>'),
    'a regex needing a closing tag is bypassed by omitting one');
  ok('sanitising is an allowlist, because the dangerous list keeps growing',
    /SVG_OK_EL/.test(ic) && /SVG_OK_ATTR/.test(ic));
  /* Blocklists were the bug. These are the specific payloads that got through
     the old guard, and each must be absent from the allowlist by NAME. */
  for (const bad of ['script', 'foreignobject', 'image', 'animate', 'set', 'style'])
    ok('<' + bad + '> is not an element an icon may contain',
      !new RegExp('\b' + bad + ':\s*1').test(ic.slice(ic.indexOf('SVG_OK_EL'), ic.indexOf('SVG_OK_ATTR'))));
  ok('no attribute starting with "on" can survive an allowlist of names',
    !/\bon\w+:\s*1/.test(ic.slice(ic.indexOf('SVG_OK_ATTR'), ic.indexOf('function sanitizeSvg'))));
  /* <use href="#id"> is legitimate; every other href is a fetch or an exec. */
  ok('href is allowed only as a same-document fragment',
    /if \(av\.charAt\(0\) !== '#'\) n\.removeAttribute\(a\.name\);/.test(ic));
  ok('…and javascript:/data:/url() values are dropped wherever they appear',
    /javascript\|data\|vbscript/.test(ic) && ic.includes('url\\s*\\('));
  /* Parsing failure must yield nothing, not the original string — a fallback
     that returns the input on error is a bypass triggered by malformed markup. */
  ok('a parse failure yields nothing rather than the raw markup',
    /getElementsByTagName\('parsererror'\)\.length\) return '';/.test(ic) &&
    /typeof DOMParser === 'undefined'\) return '';/.test(ic));
  ok('the root element must actually be an <svg>',
    /nodeName \|\| ''\)\.toLowerCase\(\) !== 'svg'\) return '';/.test(ic));
  /* Recolouring is what makes a pasted icon follow the theme instead of
     staying whatever colour it was drawn in. */
  ok('fill and stroke are rewritten to currentColor so icons follow the theme',
    /av !== 'none' && av !== 'currentColor'\)\s*\{[\s\S]{0,80}'currentColor'\)/.test(ic));
  ok('the admin can sanitise on paste, not only on render',
    /sanitize: sanitizeSvg/.test(ic),
    'sanitising only at render lets someone save markup that silently draws nothing');
}
