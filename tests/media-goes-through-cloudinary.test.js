/* The page was slow, and most of the weight was media nobody was optimising.
 *
 * Images have gone through Cloudinary on this storefront for a long time. Video
 * never did, customer review photos never did, and brand logos never did — and
 * the hero video is the largest contentful paint on the home page.
 *
 * ── MEASURED ON THE LIVE HERO ───────────────────────────────────────────────
 *
 *     raw from R2                            3,371,102 bytes
 *     video/fetch  f_auto,q_auto,w_1400      1,271,347 bytes    −62%
 *     video/fetch  f_auto,q_auto,w_760         849,191 bytes    −75%  (mobile)
 *     first frame  so_0,f_jpg,q_auto,w_1400       58,439 bytes
 *
 * Every one of those four URLs was requested against the live Cloudinary
 * account before this shipped, because a transform that 404s would replace a
 * working hero with nothing. The poster-frame form took two attempts: chopping
 * the source's .mp4 extension to make a .jpg breaks the SOURCE url, and
 * Cloudinary answers 404. `f_jpg` sets the output format without touching it.
 *
 * ── AND ONE REAL DEFECT FOUND ON THE WAY ────────────────────────────────────
 *
 * The carousel emitted `poster="${sl.video_poster||''}"`. An EMPTY poster
 * attribute is not the same as no poster attribute: the browser resolves "" to
 * the document URL. So every homepage load with a video slide fetched
 * https://zuwera.store/ a second time and tried to decode the HTML as an image.
 * Read straight off the live page: poster="https://zuwera.store/".
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const UTIL = read('image-utils.js');
const STORE = read('storefront.js');
const REVIEWS = read('reviews.js');
const INDEX = read('index.html');
const MW = read('functions/_middleware.js');

console.log('\n  media goes through Cloudinary, and the hero can paint early\n');

console.log('  video is optimised the way images already were');
{
  ok('there is a video optimiser beside the image one',
    /function optimizeVideo\(url, width = 1400\)/.test(UTIL)
    && /\/video\/fetch\/f_auto,q_auto,w_\$\{safeWidth\}\//.test(UTIL));
  ok('…and it is exported both ways image optimisation is',
    /window\.optimizeVideo = optimizeVideo;/.test(UTIL)
    && /    optimizeVideo,/.test(UTIL));
  ok('a poster frame can be derived from any video',
    /function videoPosterUrl/.test(UTIL)
    && /so_0,f_jpg,q_auto,w_\$\{safeWidth\}/.test(UTIL),
    'f_jpg sets the OUTPUT format — renaming the source to .jpg 404s');
  ok('…and it declines rather than guessing when it cannot build one',
    /if \(!\/\^https\?:\\\/\\\/\/i\.test\(absoluteUrl\)\) return '';/.test(UTIL),
    'an empty string is a "no attribute" signal the callers check');
  /* An already-Cloudinary URL must not be wrapped a second time — the same
     guard optimizeImage has carried since it was written. */
  ok('neither double-wraps a URL that is already Cloudinary',
    (UTIL.match(/if \(absoluteUrl\.includes\('cloudinary\.com'\)\)/g) || []).length >= 3);
}

console.log('\n  the hero video: smaller, and with a poster that is never empty');
{
  ok('the carousel video is routed through the optimiser',
    /const vidSrc = typeof window\.optimizeVideo === 'function'/.test(STORE)
    && /<video class="zw-hc-media" src="\$\{vidSrc\}"/.test(STORE));
  ok('the poster is the admin’s, else the video’s own first frame',
    /const posterSrc = sl\.video_poster\s*\n\s*\|\| \(typeof window\.videoPosterUrl === 'function'/.test(STORE));
  ok('…and the attribute is omitted entirely when there is none',
    /const posterAttr = posterSrc \? ` poster="\$\{posterSrc\}"` : '';/.test(STORE),
    'poster="" makes the browser fetch the page itself and decode it as an image');
  ok('no template emits an empty poster any more',
    !/poster="\$\{[a-zA-Z.]*video_poster\|\|''\}"/.test(STORE),
    'this is the exact string that produced poster="https://zuwera.store/" live');
  ok('the marquee video got the same two fixes',
    /const mgSrc = typeof window\.optimizeVideo === 'function'/.test(STORE)
    && /\$\{mgPoster \? ` poster="\$\{mgPoster\}"` : ''\}/.test(STORE));
  ok('and so did the video lightbox',
    /const _mv = typeof window\.optimizeVideo === 'function'/.test(STORE));
}

console.log('\n  the hero can start loading before the 145 KB script that builds it');
{
  /* The head preloads a static hero at high priority. A carousel hero returned
     early from that block having preloaded nothing, so the largest element on
     the page waited for storefront.js to download, parse, run and fetch. */
  ok('storefront.js remembers the first slide’s poster',
    /localStorage\.setItem\('zw-hero-media', posterSrc\)/.test(STORE));
  ok('…only for slide zero, which is the one on screen',
    /if \(i === 0 && posterSrc\)/.test(STORE));
  ok('the head preloads it instead of returning empty-handed',
    /var heroMedia = localStorage\.getItem\('zw-hero-media'\);/.test(INDEX)
    && /pre\.fetchPriority = 'high';/.test(INDEX));
  ok('…and only trusts an https URL from it',
    /if \(heroMedia && \/\^https:\\\/\\\/\/\.test\(heroMedia\)\)/.test(INDEX),
    'it is a preload built from cached text — the shape is checked before it is used');
  ok('the static-hero path still works as it did',
    /localStorage\.getItem\('zw-hero-image'\)/.test(INDEX)
    && /preload\.id = 'hero-preload';/.test(INDEX));
}

console.log('\n  customer photos and brand logos, which nothing was resizing');
{
  /* /api/upload-review-photo stores what the phone sent and resizes nothing, so
     these are full-resolution camera files in a 200px strip. */
  ok('review photos are requested at thumbnail size',
    /function reviewPhoto\(url, width\)/.test(REVIEWS)
    && /reviewPhoto\(u, 400\)/.test(REVIEWS));
  ok('…with a larger one kept for the lightbox, not the original',
    /data-full="\$\{escHtml\(reviewPhoto\(u, 1400\)\)\}"/.test(REVIEWS),
    'the lightbox needs a big image, not a twelve-megapixel one');
  ok('…and the upload strip too', /reviewPhoto\(url, 300\)/.test(REVIEWS));
  ok('a missing optimiser degrades to the raw URL rather than a blank',
    /typeof window\.optimizeImage === 'function'\) \? window\.optimizeImage\(url, width\) : url/.test(REVIEWS));

  ok('brand logos are requested at the size they are drawn',
    /function _logoSrc\(url, heightPx\)/.test(STORE)
    && /_logoSrc\(it\.src, logoH\)/.test(STORE)
    && /_logoSrc\(l\.src, cbLogoH \|\| 40\)/.test(STORE),
    'a 2000px PNG was being sent for a 40px row');
  ok('…with retina headroom and no upscaling',
    /Math\.max\(120, Math\.round\(h \* 6\)\)/.test(STORE));
}

console.log('\n  and the server stops holding the page up for a nicety');
{
  /* Measured on the deployed site, five runs each:
       /about.html  bypasses Functions   0.63–0.69s
       /about       through middleware   0.82–1.32s
       /            through middleware   0.84–1.56s */
  ok('the header-stamp read is cached for longer than fifteen seconds',
    /const TTL = 300;/.test(MW),
    'at 15s almost every visitor to a quiet shop paid for the refill');
  ok('…and is no longer waited for indefinitely',
    /const STAMP_BUDGET_MS = 60;/.test(MW)
    && /await Promise\.race\(\[\s*\n\s*pending,/.test(MW),
    'a first-frame nicety was holding up the first frame');
  ok('…while still letting the read finish and warm the cache',
    /Giving up on the wait is not the same as giving up on the\s*\n\s*request/.test(MW));
  /* A timeout resolves the race to null, so this ONE line is what guarantees
     the page goes out exactly as it came in. It used to also enumerate the two
     things being stamped; the middleware now stamps four (attributes, classes,
     the theme bake correction, and the first-paint settings), so the guard is
     asserted on the property that matters rather than on a list that has to be
     rewritten every time something is added to it. */
  ok('and the page is unchanged when it times out',
    /if \(!attrs\) return res;/.test(MW),
    'the baked answer, the visitor cache and the runtime fetch all still apply');
  ok('…and nothing is stamped when the read came back with nothing in it',
    /if \(!attrs\.html && !attrs\.body && !hasSettings && !readLayout && !attrs\.theme && !attrs\.nav && !attrs\.search\) return res;/.test(MW),
    'an empty stamp would still cost an HTMLRewriter pass over every page');
}

console.log('\n  and the two product grids fail the same way');
{
  /* ── AN INLINE onerror RACES THE CHAIN AND WINS ──────────────────────────
     The chain in image-utils.js is a DELEGATED listener in the CAPTURE phase,
     so it acts before any handler on the element itself — and is then
     overwritten by it. The collection card carried

         onerror="if(this.src !== RAW) this.src = RAW;"

     so on this grid the middle step never ran: Cloudinary failed, the chain set
     the wsrv.nl retry, and this put the raw original back over the top of it.
     wsrv is the step that covers an over-quota Cloudinary; going straight to
     the raw original covers nothing, because the raw original is what the
     Cloudinary URL was built from.

     It also could not terminate for a product whose stored image_url is
     RELATIVE: `img.src` reads back absolute, so the comparison stayed true and
     the same failing request was re-issued on every error.

     The homepage card (storefront.js) never had one, and is the reference. */
  const COLL = read('drop001.html');
  /* The footer wordmark keeps its handler and should: it does not RETRY, it
     swaps a failed logo for the word ZUWERA, which the chain cannot do. */
  const handlers = (COLL.match(/onerror="[^"]*"/g) || []).filter((h) => /this\.src\s*=/.test(h));
  ok('the collection card leaves failure to the chain', handlers.length === 0,
    handlers.join(' | ') || 'an element handler runs after the capture listener and overwrites it');
  ok('…the same as the homepage card, which never had one',
    !/alt="\$\{escapeHomeFavoriteHtml\(productName\)\}"[^>]*onerror=/.test(STORE),
    'two grid implementations, one behaviour');
  /* Both still hand the chain what it needs: a Cloudinary URL it can walk back
     to an original, and a width to size the wsrv retry with. */
  ok('…and both still ask the optimiser, which is what the chain walks back',
    /optimizeImage\(firstImg, 600\)/.test(COLL));
  ok('…with the width attribute step 0 reads to size its retry',
    /wsrvUrl\(absoluteImageUrl\(orig\), img\.getAttribute\('width'\) \|\| 800\)/.test(UTIL));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
