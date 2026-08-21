/* The hero's words waited for 308 KB of JavaScript. Its picture did not.
   ═══════════════════════════════════════════════════════════════════════════

   The hero image was rescued a while ago: index.html's <head> reads the last
   one out of localStorage and preloads it at high priority, so the photograph
   is on its way before a single module has parsed.

   The WORDS were still rendered by a `case 'hero':` inside storefront.js — the
   largest script on the page, and one that runs a long way down the deferred
   chain. So the headline, kicker, subtext, both buttons and the image overlay
   only reached their real values after everything before it had been fetched,
   parsed and executed. A visitor read the SHIPPED DEFAULT copy first and
   watched it change.

   ── MEASURED, MINIFIED, AS ACTUALLY SERVED ──────────────────────────────────

       hero-render.js is 3rd of 44 script tags; storefront.js is 24th.

       the 20 modules between them        164,148 bytes
       storefront.js itself               144,474 bytes
       ─────────────────────────────────────────────
       parsed before the hero USED to     308,622 bytes
       parsed before the hero paints now    3,760 bytes   (hero-render.js)

   ── WHY IT PAINTS TWICE ─────────────────────────────────────────────────────

   storefront.js still calls paint() on its own pass, and the builder preview
   calls it on every edit. paint() is a pure write of `s` onto `el`, so the
   second pass writes what is already there. Suppressing it would stop the
   builder's live preview updating, which is a far worse trade than one
   redundant assignment.

   ── AND ONE CHANGE THAT IS NOT A PURE MOVE ──────────────────────────────────

   The image overlay's href used to be assigned unfiltered. It is now filtered,
   but by a DIFFERENT rule from the one the two buttons use: safeUrl is an
   allowlist, correct for location.href, and it rejects a bare relative path.
   'drop001.html' with no leading slash is an ordinary thing to have typed into
   that field, and a store with one would have found its overlay silently
   pointing at '#'. safeHref refuses only the schemes that can execute. */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const HR = read('hero-render.js');
const SF = read('storefront.js');
const IDX = read('index.html');

console.log('\n  the hero left storefront.js\n');

console.log('  it is a module now, not a case');
{
  ok('hero-render.js exists and exports a painter', /window\.zwHero = \{ paint: paint, early: early \};/.test(HR));
  ok('storefront.js delegates rather than rendering',
    /case 'hero': \{[\s\S]{0,600}window\.zwHero\.paint\(el, s\);/.test(SF));
  /* The move has to be a MOVE. A copy left behind is two renderers that drift,
     and the builder would keep agreeing with only one of them. */
  ok('…and keeps no copy of the renderer',
    !/el\.querySelector\('\.hero-h1'\)/.test(SF)
    && !/el\.querySelector\('\.hero-cta-row \.btn-outline'\)/.test(SF)
    && !/hero-img-cta/.test(SF),
    'storefront.js still knows how to paint a hero');
  ok('the module does', /el\.querySelector\('\.hero-h1'\)/.test(HR) && /hero-img-cta/.test(HR));
}

console.log('\n  and it loads early enough for that to matter');
{
  const tags = [];
  const re = /<script[^>]*src="([^"]+)"/g;
  let m;
  while ((m = re.exec(IDX))) tags.push(m[1].split('?')[0].replace(/^\//, ''));
  const iData = tags.indexOf('zw-data.js');
  const iHero = tags.indexOf('hero-render.js');
  const iStore = tags.indexOf('storefront.js');

  ok('index.html loads it', iHero > -1);
  /* Directly behind the settings broker: it can do nothing before zw-data.js
     has defined window.zwSettings, and every position after that is one more
     module the hero waits for. */
  ok('…directly after the settings broker it reads', iHero === iData + 1,
    'zw-data.js at ' + iData + ', hero-render.js at ' + iHero);
  ok('…and a long way ahead of storefront.js', iStore - iHero >= 15,
    (iStore - iHero) + ' modules between them');
  /* preview-mode.js has to stay first — that invariant predates this file and
     was broken once by inserting a script above it. */
  ok('…without displacing preview-mode.js from the front', tags[0] === 'preview-mode.js');
  ok('it is deferred like the rest of the chain',
    /<script src="\/hero-render\.js[^"]*" defer><\/script>/.test(IDX));
}

console.log('\n  the optimiser it needs that early');
{
  /* image-utils.js is 20 modules further down, so on the early pass the real
     optimiser does not exist yet. Without the head's copy the hero would get
     the RAW image_url — a full-size photograph on the largest element of the
     page, which is the opposite of the point. */
  ok('the <head> exposes its own optimiser', /window\.zwOptHead = zwOptHead;/.test(IDX));
  ok('…and the module prefers the real one when it is there',
    /if \(typeof window\.optimizeImage === 'function'\) return window\.optimizeImage\(url, width\);\n    if \(typeof window\.zwOptHead === 'function'\) return window\.zwOptHead\(url, width\);/.test(HR),
    'order matters: image-utils.js is the authority once it has loaded');
  ok('…falling back to the raw url only as a last resort', /return url;\n  \}/.test(HR));
}

console.log('\n  the early pass knows when to stay out of the way');
{
  ok('it skips the builder preview', /if \(window\.__ZW_BUILDER_PREVIEW__\) return true;/.test(HR));
  ok('…and both preview query params',
    /q\.get\('builder'\) === '1' \|\| !!q\.get\('zwpreview'\)/.test(HR),
    'those render the DRAFT — painting the published hero first is a flash aimed at the one person who would notice');
  ok('…and paints only a visible hero section',
    /s\.type === 'hero' && s\.visible !== false/.test(HR));
  ok('…in the same order storefront.js applies them',
    /sort\(function \(a, b\) \{ return \(a\.order \|\| 0\) - \(b\.order \|\| 0\); \}\)/.test(HR),
    'a different pick would paint one hero then replace it with another');
  ok('…and a failed settings read just waits for storefront.js',
    /\.catch\(function \(\) \{ \/\* storefront\.js will try again on its own pass \*\/ \}\)/.test(HR));
  /* Deferred scripts run after parsing, but the builder harness can inject this
     at any point — the same readyState trap that has bitten async modules here. */
  ok('it runs whether or not the document is still parsing',
    /if \(document\.readyState === 'loading'\)[\s\S]{0,140}else \{\n    early\(\);/.test(HR));
}

console.log('\n  the hero image cache still behaves');
{
  ok('a published hero is cached for the next first paint',
    /localStorage\.setItem\('zw-hero-image', s\.image\);/.test(HR));
  ok('…and never from the builder preview',
    /if \(!window\.__ZW_BUILDER_PREVIEW__\) \{\n        window\.__ZW_HERO_IMAGE = optDesk;/.test(HR),
    'an unpublished hero must not become what the real homepage shows first');
  ok('…and the preload link is repointed with it', /if \(preload\) preload\.href = optDesk;/.test(HR));
  ok('a focal point clears rather than sticking',
    /if \(pt\) img\.style\.setProperty\('--zwh-pos-tab', pt\); else img\.style\.removeProperty\('--zwh-pos-tab'\);/.test(HR),
    'leaving a stale value would frame the next hero by the last one');
}

console.log('\n  the href rule is looser than the location.href rule, on purpose');
{
  const m = HR.match(/function safeHref\(value\) \{[\s\S]*?\n  \}/);
  ok('safeHref exists', !!m);
  const safeHref = m ? new Function('return ' + m[0].replace('function safeHref', 'function'))() : null;
  if (safeHref) {
    ok('a bare relative path survives', safeHref('drop001.html') === 'drop001.html',
      'the allowlist would have turned this into # — a silent regression for any store that typed it');
    ok('a rooted path survives', safeHref('/drop001.html') === '/drop001.html');
    ok('an absolute url survives', safeHref('https://x.com/a') === 'https://x.com/a');
    ok('a fragment survives', safeHref('#top') === '#top');
    ok('javascript: is refused', safeHref('javascript:alert(1)') === '#');
    ok('…whatever the case', safeHref('JaVaScRiPt:alert(1)') === '#');
    ok('…and through a control character', safeHref('java	script:alert(1)') === '#',
      'the browser parses that as a scheme; a naive prefix test does not');
    ok('data: is refused', safeHref('data:text/html,x') === '#');
    ok('empty becomes a fragment', safeHref('') === '#');
  }
  ok('and the image overlay uses it', /imgCta\.href = safeHref\(/.test(HR));
  ok('while the two buttons still use the allowlist',
    (HR.match(/location\.href = safeUrl\(/g) || []).length === 2,
    'assigning to location.href is where an allowlist belongs');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
