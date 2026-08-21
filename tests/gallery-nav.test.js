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
    this.style = {};
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
    && media.style.scrollSnapType === 'x mandatory';
  console.log('  every photo is the full pane          ' + (geom ? 'yes' : 'NO'));
  console.log('  …and stops at the next one, not the nearest  ' + (snap ? 'yes' : 'NO'));
  console.log('  …in a container that actually scrolls       ' + (cont ? 'yes' : 'NO'));

  /* Two-up is still expressible — the product page's arrangement, and the
     reason this is a number rather than a boolean. */
  G.renderStrip(media, shots, { alt: 'x', isVideo: () => false, perView: 2 });
  const two = media.children.every((k) => k.style.flex === '0 0 50%' && k.style.width === '50%');

  /* And a caller that says nothing keeps the stylesheet in charge, so the
     product page is untouched by this. */
  G.renderStrip(media, shots, { alt: 'x', isVideo: () => false });
  const none = media.children.every((k) => !k.style.flex && !k.style.width);
  console.log('  two-up is still expressible                 ' + (two ? 'yes' : 'NO'));
  console.log('  …and saying nothing leaves it to the css    ' + (none ? 'yes' : 'NO'));

  var perView = geom && snap && cont && two && none;
  console.log('\n  ' + (perView
    ? 'PASS  the strip carries its own geometry'
    : 'FAIL  the strip is still asking a stylesheet'));
  boundaries = boundaries && perView;
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
