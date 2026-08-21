/* Colour swatches were the only images on the site that could not fail safely.
   ═══════════════════════════════════════════════════════════════════════════

   Every other image gets three chances — Cloudinary, then wsrv.nl, then the raw
   original — from the delegated error listener in image-utils.js. The swatches
   got none, because they were painted with CSS:

       style="background-image:url('<cloudinary url>')"

   A CSS background that 404s fires NO error event. Not on the element, not on
   the document, not anywhere. There is nothing to listen for, so the chain
   could never see them. An over-quota Cloudinary — a monthly credit limit on a
   free plan, not a hypothetical — blanked every colour on every card while the
   tiles kept their exact size, so the page did not look broken enough to
   notice.

   ── FIVE RENDERERS, NOT THE TWO THAT WERE REPORTED ──────────────────────────

       storefront.js       product-card swatches, homepage grid
       drop001.html        product-card swatches, collection grid
       quick-add-modal.js  colour picker in the homepage quick-add modal
       drop001.html        colour picker in the collection quick-add modal
       product-main.js     colourway picker on the product page

   The last three were found by census rather than by report, and two of them
   had a second problem: they handed the RAW image_url to a 68x54 tile, so every
   colour of every product opened in a quick-add modal downloaded a full-size
   photograph. They now ask the optimiser for 240, which is what the product
   page has always done.

   ── MEASURED IN CHROME, NOT ASSUMED ─────────────────────────────────────────

   Real stylesheets, real image-utils.js, the per-page rules lifted out of
   index.html and drop001.html, 1280x900:

       .pcard .zw-card-swatch   btn 52x52   content 50x50   img 50x50   cover
       .color-swatch            btn 68x54   content 68x54   img 68x54   cover
       .quick-add-color         btn 68x54   content 68x54   img 68x54   cover
       .collection-color        btn 68x54   content 68x54   img 68x54   cover
       .zw-card-swatch (base)   btn 20x20   content 18x18   img 18x18   cover

   The img fills the content box exactly in all five. object-position is
   `50% 0%` on the three landscape tiles that framed from the top and `50% 50%`
   on the square ones. Every button keeps overflow:visible, and every img is
   pointer-events:none.

   And the chain fires: pointed at a Cloudinary URL that cannot resolve, the
   probe swatch reached dataset.zwFb === '2' — Cloudinary, then wsrv, then the
   raw original — where before it reached nothing at all. */

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

console.log('\n  the swatches had no fallback\n');

console.log('  one <img> builder, not one per renderer');
{
  ok('image-utils.js owns zwSwatchImg', /function zwSwatchImg\(src, width\) \{/.test(IU));
  ok('…and exposes it', /window\.zwSwatchImg = zwSwatchImg;/.test(IU));
  ok('…tagged with a class the stylesheet can reach',
    /'<img class="zw-swatch-thumb" src="' \+ safe \+ '" alt="" '/.test(IU));
  ok('…alt is empty, because the button already has aria-label',
    /alt=""/.test(IU),
    'a described image inside a labelled control is announced twice');
  ok('…and it escapes the url it is handed',
    /\.replace\(\/&\/g, '&amp;'\)\.replace\(\/"\/g, '&quot;'\)/.test(IU));
  /* Step 0 of the chain sizes its wsrv retry from getAttribute('width'), so the
     attribute has to carry the width the optimiser was actually given. */
  ok('…carrying the optimiser width so the retry matches',
    /const w = Number\(width\) > 0 \? Math\.round\(Number\(width\)\) : 600;/.test(IU)
    && /width="' \+ w \+ '"/.test(IU));
}

console.log('\n  all five renderers use it');
{
  const SITES = [
    ['storefront.js (card, single image)', SF, /const _im = \(typeof window\.zwSwatchImg === 'function'\) \? window\.zwSwatchImg\(src\) : '';/],
    ['storefront.js (card, per colour)', SF, /const _im = \(src && typeof window\.zwSwatchImg === 'function'\) \? window\.zwSwatchImg\(src\) : '';/],
    ['drop001.html (card, single image)', D1, /const _im = \(typeof window\.zwSwatchImg === 'function'\) \? window\.zwSwatchImg\(src\) : '';/],
    ['drop001.html (card, per colour)', D1, /const _im = \(src && typeof window\.zwSwatchImg === 'function'\) \? window\.zwSwatchImg\(src\) : '';/],
    ['quick-add-modal.js (colour picker)', QA, /var _im = \(thumbSrc && typeof window\.zwSwatchImg === 'function'\) \? window\.zwSwatchImg\(thumbSrc, 240\) : '';/],
    ['drop001.html (colour picker)', D1, /var _im = \(thumbSrc && typeof window\.zwSwatchImg === 'function'\) \? window\.zwSwatchImg\(thumbSrc, 240\) : '';/],
  ];
  for (const [name, src, re] of SITES) ok(name + ' builds an <img>', re.test(src));

  ok('product-main.js builds one at runtime',
    /img = document\.createElement\('img'\);\n      img\.className = 'zw-swatch-thumb';/.test(PM),
    'this one is called twice — the colours and the images race');

  /* The degrade path matters: image-utils.js is deferred, and if a renderer ran
     before it the swatch must still show something. Falling back to the old
     background-image makes the worst case identical to the previous behaviour
     rather than an empty tile. */
  ok('every markup site degrades to the old background when it must',
    (SF.match(/_im \? '' : /g) || []).length === 2
    && (D1.match(/_im \? '' : /g) || []).length === 3
    && (QA.match(/_im \? '' : /g) || []).length === 1,
    'image-utils.js is deferred — a renderer that beats it must still paint');
}

console.log('\n  and nothing paints a thumbnail as a bare background any more');
{
  /* The census that found the three unreported ones. A background-image built
     from a URL, with no _im guard beside it, is the bug coming back. */
  const FILES = ['storefront.js', 'drop001.html', 'quick-add-modal.js', 'product-main.js', 'landing.js'];
  const strays = [];
  for (const f of FILES) {
    let src;
    try { src = read(f); } catch (_) { continue; }
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!/background-?[iI]mage/.test(line)) return;
      if (/none|data:|gradient|= ''|= ""/.test(line)) return;
      if (!/url\(|url\('/.test(line)) return;
      /* Guarded lines carry the ternary that prefers the <img>. */
      if (/_im \? '' : /.test(line)) return;
      strays.push(f + ':' + (i + 1) + ' ' + line.trim().slice(0, 70));
    });
  }
  ok('no unguarded background-image thumbnail remains', strays.length === 0, strays.join(' | '));
}

console.log('\n  the runtime one is idempotent, because it is called twice');
{
  ok('it reuses the existing img rather than stacking them',
    /let img = swatch\.querySelector\('img\.zw-swatch-thumb'\);/.test(PM),
    'updateColorwayThumbnails() re-runs this after the images resolve');
  ok('…and removes it when a colour has no photo',
    /if \(img\) img\.remove\(\);/.test(PM));
  /* Without this a swatch that had exhausted its retries keeps zwFb === '2'
     and never retries for the next colour it is asked to show. */
  ok('…and clears the chain bookkeeping when the url changes',
    /if \(img\.getAttribute\('src'\) !== src\) \{[\s\S]{0,320}delete img\.dataset\.zwFb;\n      delete img\.dataset\.zwOrig;/.test(PM),
    'a swatch stuck at step 2 would never retry for a different colour');
}

console.log('\n  one CSS rule, on every page that draws one');
{
  ok('the shared rule exists', /\.zw-swatch-thumb\{\n  display:block; width:100%; height:100%;/.test(CSS));
  ok('…covering the box exactly', /object-fit:cover; object-position:center;/.test(CSS));
  ok('…and handing clicks to the button',
    /pointer-events:none;   \/\* clicks belong to the button/.test(CSS),
    'handlers read e.target — an img target would change what closest() starts from');
  /* The three landscape tiles framed from the top. Getting this wrong recrops
     every colourway on the product page, which is a silent visual regression. */
  ok('the three landscape tiles keep their top framing',
    /\.color-swatch > \.zw-swatch-thumb,\n\.quick-add-color > \.zw-swatch-thumb,\n\.collection-color > \.zw-swatch-thumb\{ object-position:center top; \}/.test(CSS),
    'they were background-position:center top');
  /* The selected-colour bar is an ::after at bottom:-6/-7/-8px, OUTSIDE the
     button. Clipping the button to round the image would erase it. */
  ok('nothing clips the buttons',
    !/\.zw-card-swatch\{[^}]*overflow:\s*hidden/.test(CSS)
    && !/\.color-swatch\s*\{[^}]*overflow:\s*hidden/.test(read('product.css')),
    'the selected-colour bar sits outside the element');
  ok('…so the image is rounded by inheritance instead', /border-radius:inherit;/.test(CSS));

  for (const p of ['index.html', 'drop001.html', 'product.html', 'landing.html']) {
    ok(p + ' loads the stylesheet that carries it', read(p).includes('storefront-cohesion.css'));
  }
}

console.log('\n  and the quick-add pickers stopped downloading full-size photos');
{
  ok('quick-add-modal.js optimises to 240',
    /if \(thumbSrc && typeof window\.optimizeImage === 'function'\) thumbSrc = window\.optimizeImage\(thumbSrc, 240\);/.test(QA),
    'it was handing the raw image_url to a 68x54 tile');
  ok('drop001.html does the same', D1.includes("thumbSrc = window.optimizeImage(thumbSrc, 240)"));
  ok('…matching the product page, which always did',
    /optimizeImage\(firstImg\.image_url, 240\)/.test(PM));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
