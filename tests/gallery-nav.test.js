/* Reproduce the reported bug against the REAL pdp-gallery.js.

   Sequence, exactly as drop001.html drives it:
     1. colQuickAdd() opens the modal immediately with the product card's ONE
        image, before the fetches resolve  -> collectionRenderGallery -> renderStrip
     2. the fetches resolve -> openCollectionReviewModal again, now with 7 images
        -> renderStrip again
     3. user clicks the next arrow -> strip.page(1) -> the host scrolls
   Assert the arrow row still exists after step 3.
*/
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
const path = process.argv[2] || ROOT + '/pdp-gallery.js';

/* ── the smallest DOM that pdp-gallery.js actually touches ────────────────── */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.className = '';
    this.id = '';
    /* A real CSSStyleDeclaration, near enough: the strip pins its geometry with
       setProperty(..., 'important') because an inline !important is the only
       thing a stylesheet cannot reach past. Mirrored to camelCase so the plain
       `style.foo = x` writes elsewhere in this file still read back. */
    this.style = {
      _p: {},
      setProperty(prop, val) {
        this._p[prop] = val;
        this[prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val;
      },
      getPropertyValue(prop) { return this._p[prop] || ''; },
    };
    this.textContent = '';
    this._attrs = {};
    this._listeners = {};
    this.scrollLeft = 0; this.scrollWidth = 700; this.clientWidth = 100;
    this.classList = {
      add: (c) => { if (!this.className.split(/\s+/).includes(c)) this.className = (this.className + ' ' + c).trim(); },
      remove: (c) => { this.className = this.className.split(/\s+/).filter(x => x && x !== c).join(' '); },
      contains: (c) => this.className.split(/\s+/).includes(c),
    };
  }
  set innerHTML(v) { if (v === '') { this.children.forEach(c => c.parentElement = null); this.children = []; } }
  get innerHTML() { return ''; }
  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] || null;
  }
  appendChild(n) { if (n.parentElement) n.parentElement.removeChild(n); n.parentElement = this; this.children.push(n); return n; }
  removeChild(n) { const i = this.children.indexOf(n); if (i > -1) { this.children.splice(i, 1); n.parentElement = null; } return n; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  fire(t) { (this._listeners[t] || []).forEach(fn => fn({ type: t })); }
  getBoundingClientRect() { return { width: this.clientWidth, height: 100, top: 0, left: 0 }; }
  /* A horizontal strip: each child starts one slot further along, and the slot
     is the child's width plus the container's 6px gap. Modelled because the
     strip now pages to a child's own offsetLeft instead of scrolling by a
     measured number of pixels — which is what stopped it coming to rest between
     two photos, and is therefore what has to be exercised here. */
  get offsetLeft() {
    if (!this.parentElement) return 0;
    const i = this.parentElement.children.indexOf(this);
    return i <= 0 ? 0 : i * (this.clientWidth + 6);
  }
  scrollTo(o) { if (o && typeof o.left === 'number') this.scrollLeft = o.left; }
  _walk(out) { this.children.forEach(c => { out.push(c); c._walk(out); }); return out; }
  matches(sel) {
    if (sel.startsWith('.')) return sel.slice(1).split('.').every(c => this.classList.contains(c));
    return this.tagName === sel.toUpperCase();
  }
  querySelectorAll(sel) {
    const parts = sel.split(',').map(s => s.trim());
    return this._walk([]).filter(n => parts.some(p => { try { return n.matches(p); } catch (_) { return false; } }));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  contains(n) { return n === this || this._walk([]).includes(n); }
  closest() { return null; }
}

const doc = new El('body');
doc.readyState = 'complete';
doc.createElement = (t) => new El(t);
doc.addEventListener = () => {};
doc.documentElement = new El('html');

global.window = {
  matchMedia: () => ({ matches: true, addEventListener() {}, addListener() {} }),
  addEventListener() {},
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
};
global.document = doc;
global.localStorage = { getItem: () => null, setItem: () => {} };
global.getComputedStyle = () => ({ gap: '6px' });
global.fetch = () => Promise.reject(new Error('offline in harness'));

const src = fs.readFileSync(path, 'utf8');
new Function('window', 'document', 'localStorage', 'getComputedStyle', 'fetch', src)(
  global.window, global.document, global.localStorage, global.getComputedStyle, global.fetch
);
const G = global.window.ZWPdpGallery;
if (!G) { console.log('FAILED: ZWPdpGallery never published'); process.exit(1); }

/* ── the surface: .collection-product-gallery > .collection-review-media ──── */
const gal = new El('div'); gal.className = 'collection-product-gallery';
const media = new El('div'); media.className = 'collection-review-media';
gal.appendChild(media);
doc.appendChild(gal);

/* drop001.html's render, reduced to the parts that matter. */
function render(images) {
  const strip = G.renderStrip(media, images, {
    alt: 'Zuwera Tech',
    isVideo: () => false,
    onIndex: (i) => G.setNavCount(gal, i, images.length),   // <- the scroll path
  });
  gal.setAttribute('data-layout', 'dual');
  let row = gal.querySelector('.gallery-nav-below');
  if (!row) { row = doc.createElement('div'); row.className = 'gallery-nav-below'; gal.appendChild(row); }
  row.innerHTML = '';
  if (images.length > 1) {
    [['prev', -1], ['next', 1]].forEach(([cls, dir]) => {
      const b = doc.createElement('button');
      b.className = 'collection-gallery-arrow ' + cls;
      b.addEventListener('click', () => { media.scrollLeft += dir * 106; media.fire('scroll'); });
      row.appendChild(b);
    });
  }
  G.setNavCount(gal, 0, images.length, { prune: true });
  return strip;
}

function state(label) {
  const row = gal.querySelector('.gallery-nav-below');
  const arrows = gal.querySelectorAll('.collection-gallery-arrow').length;
  const count = gal.querySelector('.gallery-dual-count');
  console.log(
    '  ' + label.padEnd(34) +
    'row: ' + (row ? 'yes' : 'GONE ').padEnd(6) +
    'arrows: ' + String(arrows).padEnd(3) +
    'counter: ' + (count ? count.textContent : '—')
  );
  return { row: !!row, arrows, count: count ? count.textContent : null };
}

console.log('\n  ' + path.split('/').pop() + '\n');
render(['card.jpg']);                                    // 1. instant open, 1 image
state('after instant open (1 image)');
render(['a.jpg','b.jpg','c.jpg','d.jpg','e.jpg','f.jpg','g.jpg']);   // 2. data arrives
const before = state('after data loads (7 images)');
gal.querySelector('.collection-gallery-arrow.next').fire('click');   // 3. one click
const after = state('after ONE click on the arrow');

const ok = after.row && after.arrows === 2 && after.count === '2/7';
console.log('  ' + (ok
  ? 'PASS  nav survives the click, counter advances to 2/7'
  : 'FAIL  nav destroyed by the first scroll  (was ' + before.arrows + ' arrows / ' + before.count + ')'));

/* ── AND IT ONLY EVER RESTS ON A PHOTO ────────────────────────────────────
   The strip pages by scrolling to a child's own offsetLeft. The point is not
   that it moves — the old scrollBy(step) moved too — it is that where it STOPS
   is a position an element actually occupies, so half of one photo can never
   sit beside half of the next. Slot here is 100px wide + a 6px gap. */
console.log('');
const SLOT = 106;
const shots = ['a.jpg','b.jpg','c.jpg','d.jpg','e.jpg','f.jpg','g.jpg'];
let boundaries = true;
const check = (label, expected) => {
  const at = media.scrollLeft;
  const onPhoto = at % SLOT === 0;
  if (at !== expected || !onPhoto) boundaries = false;
  console.log('  ' + label.padEnd(38) + 'scrollLeft: ' + String(at).padEnd(6)
    + (onPhoto ? 'on photo ' + (at / SLOT + 1) : 'BETWEEN PHOTOS'));
};

let strip = render(shots);
check('opens on the first photo', 0);
strip.page(1); check('one press forward', SLOT);
strip.page(1); check('two', SLOT * 2);
strip.page(-1); check('and back', SLOT);

/* Past the end, repeatedly. scrollBy had nothing to stop it walking off into
   empty space and leaving a blank pane; goTo clamps to a real child. */
for (let i = 0; i < 12; i++) strip.page(1);
check('cannot page past the last photo', SLOT * (shots.length - 1));
for (let i = 0; i < 12; i++) strip.page(-1);
check('…nor before the first', 0);

/* The modal opens on the colourway the shopper picked, not on photo one — and
   THIS is the path that left half a photo showing, because collectionRender
   Gallery runs again when the colour fetch lands. */
strip = G.renderStrip(media, shots, { alt: 'x', isVideo: () => false, startIndex: 3 });
check('re-renders onto the chosen photo', SLOT * 3);
/* A smooth scroll still travelling when the re-render happens must not leave
   the new strip parked between two of its children. */
media.scrollLeft = 47;
strip = G.renderStrip(media, shots, { alt: 'x', isVideo: () => false, startIndex: 2 });
check('…even mid-scroll from the previous set', SLOT * 2);

console.log('\n  ' + (boundaries
  ? 'PASS  the strip only ever rests on a photo boundary'
  : 'FAIL  the strip came to rest between two photos'));

/* ── ONE PHOTO PER VIEW, SAID ON THE ELEMENT ──────────────────────────────
   The stylesheet says this too, in the right place, and on the deployed page
   it was not reaching the photos: two shots at half width each, which reads as
   one photo sliced down the middle. A rule scoped four classes deep through an
   attribute the caller writes has a lot of ways not to match; a property on the
   element has none. */
console.log('');
{
  const s = G.renderStrip(media, shots, { alt: 'x', isVideo: () => false, perView: 1 });
  const kids = media.children;
  const geom = kids.every((k) => k.style.flex === '0 0 100%' && k.style.width === '100%'
    && k.style.objectFit === 'contain' && k.style.minWidth === '0');
  const snap = kids.every((k) => k.style.scrollSnapAlign === 'start' && k.style.scrollSnapStop === 'always');
  /* Without these the host is not a scroll container at all and the photos just
     shrink to share the width — which IS the two-up that was showing. */
  const cont = media.style.display === 'flex' && media.style.overflowX === 'auto'
    && media.style.scrollSnapType === 'x mandatory'
    /* justify-content:center on an overflowing flex row pushes the overflow out
       BOTH ends, and there is no negative scrollLeft — the first photo becomes
       unreachable. .collection-review-media centres, so this has to be undone. */
    && media.style.justifyContent === 'flex-start';
  /* Written through setProperty, which is how they carry !important — the only
     position in the cascade a stylesheet cannot reach past, and the reason this
     round is different from the last two. */
  const pinned = ['flex', 'width', 'object-fit'].every((p) => kids[0].style.getPropertyValue(p))
    && ['display', 'overflow-x', 'justify-content'].every((p) => media.style.getPropertyValue(p));
  console.log('  every photo is the full pane          ' + (geom ? 'yes' : 'NO'));
  console.log('  …and stops at the next one, not the nearest  ' + (snap ? 'yes' : 'NO'));
  console.log('  …in a container that actually scrolls       ' + (cont ? 'yes' : 'NO'));
  console.log('  …pinned where no stylesheet can reach it    ' + (pinned ? 'yes' : 'NO'));

  /* Two-up is still expressible — the product page's arrangement, and the
     reason this is a number rather than a boolean. */
  G.renderStrip(media, shots, { alt: 'x', isVideo: () => false, perView: 2 });
  const two = media.children.every((k) => k.style.flex === '0 0 50%' && k.style.width === '50%');

  /* And a FRACTION is what makes a peek possible: 1.25 slides in view is one
     photo across four fifths with the next showing in the last fifth, which is
     how a strip says it scrolls without anybody reading the counter. */
  G.renderStrip(media, shots, { alt: 'x', isVideo: () => false, perView: 1.25 });
  const peek = media.children.every((k) => k.style.flex === '0 0 80%' && k.style.width === '80%');
  console.log('  a peek is expressible too                   ' + (peek ? '1.25 → 80% slides' : 'NO'));

  /* And a caller that says nothing keeps the stylesheet in charge, so the
     product page is untouched by this. */
  G.renderStrip(media, shots, { alt: 'x', isVideo: () => false });
  const none = media.children.every((k) => !k.style.flex && !k.style.width);
  console.log('  two-up is still expressible                 ' + (two ? 'yes' : 'NO'));
  console.log('  …and saying nothing leaves it to the css    ' + (none ? 'yes' : 'NO'));

  var perView = geom && snap && cont && pinned && two && peek && none;
  console.log('\n  ' + (perView
    ? 'PASS  the strip carries its own geometry'
    : 'FAIL  the strip is still asking a stylesheet'));
  boundaries = boundaries && perView;
}

/* ── THE PANE TAKES THE SHAPE OF THE PHOTOS IN IT ─────────────────────────
   contain never crops; it has to put the leftover space somewhere, and a fixed
   pane holding a differently-shaped photo puts it in bands. Measured, not
   assumed: this store ships 1:1, 4:5 and 1836x1950, four of eleven products mix
   ratios inside themselves, and a licensee's catalogue is whatever their
   photographer handed them. A `4/5` written into the file would be a guess
   about somebody else's shoot that nothing would ever correct. */
console.log('');
{
  const fit = (w, h, cached, pv) => {
    G.renderStrip(media, shots, { alt: 'x', isVideo: () => false, perView: pv || 1 });
    const first = media.children[0];
    first.naturalWidth = w; first.naturalHeight = h;
    if (cached) { first.complete = true; G.renderStrip(media, shots, { alt: 'x', isVideo: () => false, perView: 1 }); }
    else first.fire('load');
    return media.style.getPropertyValue('aspect-ratio');
  };

  /* The two shapes this catalogue actually ships, and one it does not — the
     point being that none of them is written down anywhere. */
  /* At perView 1 the pane IS the slide, so the pane takes the photo's own ratio. */
  const square = fit(2000, 2000);
  const tall = fit(1070, 1338);
  const odd = fit(1836, 1950);
  /* ── THE PANE IS NOT THE SLIDE ────────────────────────────────────────
     Each slide is 1/perView of the pane's width, so for the photo to fill its
     slide the PANE has to be perView times as wide relative to its height. At
     perView 1 those are the same number, which is why this read as "the photo's
     ratio" until a peek was asked for — a 4:5 photo at 1.25 wants a SQUARE pane,
     and getting it wrong puts the top-and-bottom margin straight back. */
  const peeked = fit(1070, 1338, false, 1.25);
  console.log('  the same photo at a 1.25 peek -> ' + (peeked || 'not set')
    + '   (1070 x 1.25 = 1337.5, so the pane is square)');
  console.log('  a 2000x2000 product   pane -> ' + (square || 'not set'));
  console.log('  a 1070x1338 product   pane -> ' + (tall || 'not set'));
  console.log('  an 1836x1950 product  pane -> ' + (odd || 'not set'));
  const measured = square === '2000 / 2000' && tall === '1070 / 1338' && odd === '1836 / 1950'
    && peeked === '1337.50 / 1338';

  /* And the pane has to be free to take that shape: a height from the
     stylesheet would fight the ratio it was just given. */
  const freed = media.style.getPropertyValue('height') === 'auto'
    && media.style.getPropertyValue('min-height') === '0'
    && media.children.every((k) => k.style.getPropertyValue('height') === '100%');
  /* Capped through a custom property, so a licensee's theme can move the cap
     without editing this file — the literal is only the fallback. */
  const capped = /^var\(--zw-strip-max-h,/.test(media.style.getPropertyValue('max-height'));
  /* ── AND THE PANE MUST *NOT* NARROW TO MATCH ──────────────────────────
     It used to: when the height cap binds the pane is wider than the ratio
     wants, so the width was capped to what the cap could carry and the leftover
     moved outside the pane to read as margin. That was right until paintMargin
     existed, and then the two cancelled EXACTLY — a pane narrowed to the photo
     has no margin inside it, so paintMargin correctly painted nothing, while the
     leftover moved onto an element the <img>'s background cannot reach. Both
     fixes live, both behaving as designed, dark edges back on the deployed site.
     The space has to stay where the element that owns it can colour it. */
  fit(1070, 1338);                       // the 4:5 shape, whose numbers are known
  const mw = media.style.getPropertyValue('max-width');
  const keeps = !mw && !media.style.getPropertyValue('margin-inline');
  console.log('  …and the pane is free to take it            ' + (freed ? 'yes' : 'NO'));
  console.log('  …but still capped, themeably                ' + (capped ? 'yes' : 'NO'));
  console.log('  …and keeps its margin where it can paint it ' + (keeps ? 'yes' : 'NO — ' + (mw || 'margin-inline set')));

  /* Nothing a product photo plausibly is. More likely a tracking pixel or a
     broken decode, and the stylesheet's answer is a better wrong answer than a
     squashed pane. */
  media.style._p = {};
  const silly = fit(4000, 40) || fit(40, 4000) || fit(0, 0);
  console.log('  a 100:1 sliver leaves the pane alone       ' + (!silly ? 'yes' : 'NO — ' + silly));

  const fitOk = measured && freed && capped && keeps && !silly;
  console.log('\n  ' + (fitOk
    ? 'PASS  the pane is measured, never assumed'
    : 'FAIL  the pane is guessing at a shape'));
  boundaries = boundaries && fitOk;
}

/* ── AND WHAT MARGIN IS LEFT TAKES THE COLOUR OF THE EDGE BESIDE IT ───────
   The backdrops are not flat: seven of eighteen sampled run from one tone to
   another down the edge — one from #ffffff to #3c382e — and six have different
   left and right sides. So the margin is painted as a GRADIENT reproducing the
   edge, and on the axis that actually carries it, which a contained photo makes
   answerable: it always touches one pair of edges, so exactly two are ever
   against margin. */
console.log('');
{
  /* Resolved synchronously so the assertions below stay flat and deterministic —
     a real promise would need the whole file to become async for no extra
     coverage. The shape is the same one image-utils.js returns. */
  const band = (from, to) => {
    const out = [];
    for (let i = 0; i < 16; i++) {
      const t = i / 15;
      out.push([Math.round(from[0] + (to[0] - from[0]) * t),
        Math.round(from[1] + (to[1] - from[1]) * t),
        Math.round(from[2] + (to[2] - from[2]) * t)]);
    }
    return out;
  };
  const STRIPS = {                       // Zuwera Fleece's real numbers
    left: band([255, 255, 255], [60, 56, 46]),
    right: band([240, 240, 240], [70, 66, 56]),
    top: band([255, 255, 255], [240, 240, 240]),
    bottom: band([60, 56, 46], [70, 66, 56]),
  };
  global.window.zwEdgeStrips = () => ({ then(fn) { fn(STRIPS); return { catch() {} }; } });

  const paint = (w, h) => {
    G.renderStrip(media, ['a.jpg'], { alt: 'x', isVideo: () => false, perView: 1 });
    const n = media.children[0];
    n.naturalWidth = w; n.naturalHeight = h;
    n.fire('load');                       // the slot is 100 wide x 100 tall here
    return n.style;
  };

  /* 1070x1338 in a square slot: relatively taller, so the margin is down the
     SIDES and each side gets its own edge, top to bottom. */
  let s = paint(1070, 1338);
  const sides = /^linear-gradient\(to bottom,rgb\(255 255 255\) 0\.00%,/.test(s.getPropertyValue('background-image'))
    && (s.getPropertyValue('background-image').match(/linear-gradient\(to bottom,/g) || []).length === 2
    && s.getPropertyValue('background-size') === '50% 100%,50% 100%'
    && s.getPropertyValue('background-position') === 'left top,right top';
  console.log('  a tall photo in a square slot  -> ' + (sides ? 'left and right edges, top to bottom' : 'NO'));

  /* The other way round: margin above and below, painted from the top and
     bottom edges, left to right. */
  s = paint(1338, 1070);
  const stacked = (s.getPropertyValue('background-image').match(/linear-gradient\(to right,/g) || []).length === 2
    && s.getPropertyValue('background-size') === '100% 50%,100% 50%'
    && s.getPropertyValue('background-position') === 'left top,left bottom';
  console.log('  a wide photo in a square slot  -> ' + (stacked ? 'top and bottom edges, left to right' : 'NO'));

  /* And when the photo fills the slot there is nothing to paint. Painting
     anyway would put a seam along an edge with no margin beside it. */
  s = paint(1000, 1000);
  const clean = s.getPropertyValue('background-image') === 'none';
  console.log('  a photo that fills its slot    -> ' + (clean ? 'nothing painted' : 'NO — ' + s.getPropertyValue('background-image').slice(0, 40)));

  /* Sixteen stops, evenly spaced, first and last pinned to the ends — a
     gradient that starts late leaves a hard line at the join. */
  s = paint(1070, 1338);
  const bg = s.getPropertyValue('background-image');
  /* Regex rather than indexOf: this is a string BUILT at runtime, not source
     text, so ordering-assertions-are-not-vacuous.test.js cannot check the needle
     against a file and correctly reports it as a landmark that does not exist. */
  const dense = (bg.match(/rgb\(/g) || []).length === 32
    && /rgb\([^)]*\) 0\.00%/.test(bg) && /rgb\([^)]*\) 100\.00%/.test(bg);
  console.log('  …reproduced with 16 stops each -> ' + (dense ? 'yes' : 'NO'));

  /* ── AND SOME PHOTOS MUST NOT BE CONTINUED AT ALL ───────────────────────
     Extending an edge assumes a backdrop is AT that edge. On a close-up crop the
     garment runs off the frame and continuing it smears fabric sideways; on a
     dark backdrop it puts a slab of colour against the popup. Both were
     reported. zwEdgeStrips measures it — corner agreement separated this
     catalogue with nothing near the line (0–33 for studio shots, 200 and 214 for
     the two detail crops) — and says so with `safe`. */
  const withSafety = (v) => { STRIPS.safe = v; };
  withSafety(false);
  const refused = paint(1070, 1338).getPropertyValue('background-image') === 'none';
  console.log('  a close-up crop, or a dark wall-> ' + (refused ? 'left alone' : 'NO — continued anyway'));

  /* A measurement that cannot be overruled is a guess with no appeal, so the
     builder can force it either way. */
  const forced = (fill) => {
    G.renderStrip(media, ['a.jpg'], { alt: 'x', isVideo: () => false, perView: 1, fill: fill });
    const n = media.children[0];
    n.naturalWidth = 1070; n.naturalHeight = 1338;
    n.fire('load');
    return n.style.getPropertyValue('background-image');
  };
  const override = forced('edge') !== 'none';        // safe:false, but forced on
  withSafety(true);
  const suppress = forced('matte') === 'none';       // safe:true, but forced off
  console.log('  …"always continue" overrules it-> ' + (override ? 'yes' : 'NO'));
  console.log('  …"always plain" does too       -> ' + (suppress ? 'yes' : 'NO'));
  /* An unknown value must read as the default rather than as "off": a store on a
     newer builder than its storefront must not lose the feature silently. */
  const unknown = forced('sepia') !== 'none';
  console.log('  …and a value it does not know  -> ' + (unknown ? 'falls back to auto' : 'NO'));

  /* A store with no image-utils.js loaded must not throw — it simply keeps the
     pane's own background, which is where this started. */
  delete global.window.zwEdgeStrips;
  let survived = true;
  try { paint(1070, 1338); } catch (_) { survived = false; }
  console.log('  …and nothing breaks without it -> ' + (survived ? 'yes' : 'NO'));

  /* ── A CLIP IS SHOT ON THE SAME SET AS THE PHOTOGRAPHS BESIDE IT ────────
     fitPane asked for an `img`, and paintMargin skipped anything that was not
     one, so a video was exempt from all of this rather than deliberately
     excluded: a product whose FIRST slide is a clip never got a fitted pane at
     all. A video says its size as videoWidth/videoHeight and announces it with
     loadedmetadata — one question, two spellings — and its edges come from the
     poster, which is a still of frame 0 on an image URL. */
  global.window.zwEdgeStrips = () => ({ then(fn) { fn(STRIPS); return { catch() {} }; } });
  let vidOk = false, vidFit = '';
  {
    G.renderStrip(media, ['clip.mp4'], { alt: 'x', isVideo: () => true, perView: 1 });
    const v = media.children[0];
    v.tagName = 'VIDEO';
    v.videoWidth = 1070; v.videoHeight = 1338;
    v.poster = 'https://res.cloudinary.com/x/image/fetch/so_0,f_jpg/clip.mp4';
    v.fire('loadedmetadata');
    vidFit = media.style.getPropertyValue('aspect-ratio');
    vidOk = vidFit === '1070 / 1338'
      && (v.style.getPropertyValue('background-image').match(/linear-gradient\(to bottom,/g) || []).length === 2;
  }
  console.log('  a video-first product          -> ' + (vidOk ? 'pane fitted ' + vidFit + ', edges from its poster' : 'NO — ' + (vidFit || 'not fitted')));

  /* ── AND THE NEXT SLIDE IS ALREADY ON ITS WAY ──────────────────────────
     Everything past the second ships loading="lazy", so pressing the arrow used
     to show an empty pane while the photo arrived. Promoting the NEIGHBOURS to
     eager starts their fetch before they are needed; promoting all seventeen
     would trade one visible wait for a burst of requests on a modal the shopper
     may close in two seconds. */
  let warmed = false;
  {
    const s = G.renderStrip(media, shots, { alt: 'x', isVideo: () => false, perView: 1 });
    const load = () => media.children.map((c) => c.loading);
    const atOpen = load();
    s.page(1); s.page(1);                    // now sitting on slide 3
    const atThree = load();
    warmed = atOpen[0] === 'eager' && atOpen[1] === 'eager' && atOpen[3] === 'lazy'
      && atThree[3] === 'eager'              // the one after where we are
      && atThree[5] === 'lazy';              // and no further than that
    console.log('  on open                        -> ' + atOpen.join(' '));
    console.log('  after paging to slide 3        -> ' + atThree.join(' '));
  }
  console.log('  …neighbours warmed, not all 7  -> ' + (warmed ? 'yes' : 'NO'));

  const edgeOk = sides && stacked && clean && dense && refused && override && suppress && unknown
    && survived && vidOk && warmed;
  console.log('\n  ' + (edgeOk
    ? 'PASS  the margin matches the edge it sits against'
    : 'FAIL  the margin is a colour of its own'));
  boundaries = boundaries && edgeOk;
}

/* Regression guard for the fix this one sits on top of: opening a ONE-photo
   product straight after a seven-photo one must still clear the old arrows,
   which by then are wired to the previous product's strip. */
console.log('');
render(['only-one.jpg']);
const single = state('then a 1-image product');
const pruned = !single.row && single.arrows === 0;
console.log('\n  ' + (pruned
  ? 'PASS  stale arrows still pruned at render time'
  : 'FAIL  ' + single.arrows + ' dead arrows left behind') + '\n');
process.exit(ok && pruned && boundaries ? 0 : 1);
