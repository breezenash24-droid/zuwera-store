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
