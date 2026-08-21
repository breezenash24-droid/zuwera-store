/* Colour swatches are painted with a CSS background, and that is a known gap.
   ═══════════════════════════════════════════════════════════════════════════

   ── WHAT THIS FILE USED TO ASSERT, AND WHY IT NO LONGER DOES ────────────────

   Every other image on the site gets three chances — Cloudinary, then wsrv.nl,
   then the raw original — from the delegated error listener in image-utils.js.
   The swatches get none, because they are painted with CSS:

       style="background-image:url('<cloudinary url>')"

   A CSS background that 404s fires NO error event. Not on the element, not on
   the document, not anywhere. So an over-quota Cloudinary blanks every colour
   on every card while the tiles keep their exact size — a failure that does not
   look like one.

   The fix was to emit a real <img class="zw-swatch-thumb"> from one shared
   helper, window.zwSwatchImg(), and size it from one shared rule in
   storefront-cohesion.css. It was measured in headless Chrome against the real
   stylesheets and reported the img filling the content box in all five
   renderers.

   ON THE DEPLOYED SITE IT DID NOT. Every swatch drew at the <img>'s INTRINSIC
   size instead — the colourway picker at 240px inside a 68x54 tile, the card
   swatches at 600px inside 20px — so the images spilled sideways across the
   card, overlapped each other, and covered the Add to Bag button. Reported four
   times from three different pages before it was withdrawn.

   Everything that could be checked from here checked out. The rule is in the
   served CSS, top-level, brace-balanced, not inside a media query, in a
   stylesheet every affected page links, with no competing img rule in any of
   the nine stylesheets those pages load, and the served JS really does write
   the class. The cause was not found, and it is live on the three busiest
   pages, so the background is back until it can be shown working in a browser.

   ── WHAT THIS FILE ASSERTS NOW ──────────────────────────────────────────────

   That the withdrawal is complete and consistent across all five renderers —
   because a half-withdrawn version is the worst of both: some swatches sized by
   a rule and some by an attribute. And that the reason is written down, so the
   next person does not re-derive it or re-ship it by accident.

   ── BEFORE PUTTING THE <img> BACK ───────────────────────────────────────────

   Measure it ON THE DEPLOYED SITE, not in a local harness. The harness that
   passed lifted the per-page rules out of index.html and drop001.html by hand,
   which is not the same set of rules the browser resolves against. */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const IU = read('image-utils.js');
const CSS = read('storefront-cohesion.css');
const SF = read('storefront.js');
const D1 = read('drop001.html');
const QA = read('quick-add-modal.js');
const PM = read('product-main.js');

console.log('\n  the swatches paint from a background again\n');

console.log('  all five renderers, or none');
{
  /* The five, found by census rather than by report:
       storefront.js       product-card swatches, homepage grid      (x2 branches)
       drop001.html        product-card swatches, collection grid    (x2 branches)
       quick-add-modal.js  colour picker, homepage quick-add modal
       drop001.html        colour picker, collection quick-add modal
       product-main.js     colourway picker, product page            */
  ok('storefront.js emits no swatch <img>', !/zwSwatchImg/.test(SF));
  ok('drop001.html emits no swatch <img>', !/zwSwatchImg/.test(D1));
  ok('quick-add-modal.js emits no swatch <img>', !/zwSwatchImg/.test(QA));
  ok('product-main.js builds no swatch <img>', !/zwSwatchImg|zw-swatch-thumb'\);\s*\n\s*img\.alt/.test(PM));
  /* THE ONE THAT MATTERS. A renderer left on the <img> path while the rest are
     on backgrounds is worse than either, because only one of them is wrong and
     it looks like a data problem. */
  ok('…and none of them is left half-way',
    (SF.match(/zwSwatchImg/g) || []).length === 0
    && (D1.match(/zwSwatchImg/g) || []).length === 0
    && (QA.match(/zwSwatchImg/g) || []).length === 0,
    'some swatches sized by a rule and some by an attribute is the worst version of this');
}

console.log('\n  every swatch has a background to paint');
{
  ok('storefront.js, single-image card', /const _st = ` style="background-image:url\('\$\{esc\(src\)\}'\)"`;/.test(SF));
  ok('storefront.js, one per colour',
    /const thumbStyle = src \? `background-image:url\('\$\{esc\(src\)\}'\)` : `background:\$\{esc\(c\.hex_color \|\| '#888'\)\}`;/.test(SF));
  ok('drop001.html, single-image card', /const _st = ` style="background-image:url\('\$\{esc\(src\)\}'\)"`;/.test(D1));
  ok('drop001.html, one per colour',
    /const thumbStyle = src \? `background-image:url\('\$\{esc\(src\)\}'\)` : `background:\$\{esc\(c\.hex_color \|\| '#888'\)\}`;/.test(D1));
  ok('drop001.html, colour picker',
    /var styleAttr = thumbSrc \? "background-image:url\('" \+ collectionEscapeAttr\(thumbSrc\)/.test(D1));
  ok('quick-add-modal.js, colour picker',
    /var styleAttr = thumbSrc \? "background-image:url\('" \+ quickAddEscapeAttr\(thumbSrc\)/.test(QA));
  ok('product-main.js, colourway picker',
    /swatch\.style\.backgroundImage = `url\('\$\{src\}'\)`;/.test(PM));
  /* A colour is not an image and cannot fail to load, so the hex chip was never
     part of this and stays a background either way. */
  ok('…and a colour with no photo still gets its hex chip',
    /swatch\.style\.backgroundColor = color\.hex_color \|\| '#888';/.test(PM)
    && /background:\$\{esc\(c\.hex_color \|\| '#888'\)\}/.test(SF));
}

console.log('\n  the size saving is kept, because it was never the problem');
{
  /* Two of the pickers handed the RAW image_url to a 68x54 tile, so every
     colour of every product opened in a quick-add modal downloaded a full-size
     photograph. That fix shipped in the same change and is unrelated to how the
     tile is painted, so it stays. */
  ok('the homepage picker still asks the optimiser for 240',
    /window\.optimizeImage\(thumbSrc, 240\)/.test(QA));
  ok('…as does the collection picker', /window\.optimizeImage\(thumbSrc, 240\)/.test(D1));
  ok('…and the product page, which always did', /optimizeImage\(firstImg\.image_url, 240\)/.test(PM));
}

console.log('\n  nothing is left behind to half-work');
{
  /* The colourway picker is called twice — once when the colours arrive and
     again once the images resolve — so it has to clear an <img> a previously
     cached copy of this script may have left in the button, or the two would
     paint on top of each other. */
  ok('the runtime picker removes any img a cached script left',
    /const stale = swatch\.querySelector\('img\.zw-swatch-thumb'\);\n  if \(stale\) stale\.remove\(\);/.test(PM),
    'a visitor mid-deploy has the old script and the new stylesheet');
  /* zwSwatchImg stays exported and the sizing rule stays in the stylesheet:
     both are harmless, both are what a returning attempt needs, and removing
     them would delete the only record of what was tried. */
  ok('the helper is still there for a second attempt', /function zwSwatchImg\(src, width\)/.test(IU));
  ok('…as is the sizing rule it needs', /\.zw-swatch-thumb\{\n  display:block; width:100%; height:100%;/.test(CSS));
}

console.log('\n  and the gap this reopens is written down, not forgotten');
{
  ok('image-utils.js still says a background cannot fail safely',
    /A CSS background that 404s fires no error event/i.test(IU)
    || /fires NO error event/i.test(IU) || /404s fires no/i.test(IU));
  ok('product-main.js records why the img was withdrawn',
    /WITHDRAWN/.test(PM) && /intrinsic size/.test(PM),
    'the next person must not re-ship it without measuring the deployment');
  ok('…and what has to be true before it comes back',
    /until it can be shown working/.test(PM));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
