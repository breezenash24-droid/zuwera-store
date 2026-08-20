/* The categories in the header have to be clickable in every arrangement.
 *
 * They were not, and nothing about the links was wrong — an invisible piece of
 * the mega panel was lying on top of them.
 *
 * .zw-mega opens under the header. The category it belongs to ends well ABOVE
 * the header's bottom edge, so moving the cursor from the word down to the
 * panel crosses dead space and the panel would close on the way. .zw-mega
 * ::before is the cover for that space, and it was a fixed 1.6rem — a guess
 * about a distance that changes with the arrangement.
 *
 * Measured in Chrome at 1222px, one category's panel open, transitions
 * disabled so the geometry is the settled one:
 *
 *   one row      nav bottom 92.0    words 41.2 -> 77.2    real gap 14.8px
 *                bridge 66.4 -> 92.0, so 11px of it lay over the words
 *   two rows     nav bottom 114.4   words 81.4 -> 117.4   real gap -3.0px
 *                bridge 88.8 -> 114.4, across the whole row
 *
 * elementFromPoint at the centre of every category, per shipped layout:
 *
 *   classic, links-left, logo-center, logo-right, actions-left, all-left  a.nav-link
 *   stacked, links-row                                                    div.zw-mega
 *
 * Six arrangements fine, two dead — "in that format and some others". The two
 * that failed are exactly the two that give the categories a row of their own,
 * because that puts them at the bottom of the bar where the bridge is.
 *
 * Source-level checks, because the geometry is what the browser measurement
 * above already settled; what this holds is that the ANSWER stays measured.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  - ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const CSS = read('storefront-cohesion.css');
const NAV = read('nav-menu.js');

console.log('\nNothing invisible sits on the categories\n');

console.log('The hover bridge is measured, not guessed');
{
  ok('the bridge takes its height from a measurement',
    /\.zw-navitem > \.zw-mega::before\{[\s\S]{0,200}height:var\(--zw-megabridge, 0px\)/.test(CSS),
    'a fixed height is a guess about a gap that changes with the arrangement');
  ok('...and hangs off the panel by exactly that much, not more',
    /top:calc\(-1 \* var\(--zw-megabridge, 0px\)\)/.test(CSS));
  /* 0, not 1.6rem. Before it is measured there is no way to know how far to
     reach, and the two failure modes are not equal: a bridge that is too short
     closes the panel on a slow diagonal, a bridge that is too long eats the
     click on the word above it. */
  ok('...and reaches nowhere at all until it has been measured',
    !/--zw-megabridge, 1\.6rem\)/.test(CSS) && !/top:-1\.6rem; height:1\.6rem/.test(CSS),
    'the old fixed 1.6rem is what lay across the categories');

  ok('nav-menu.js publishes the measurement',
    /document\.documentElement\.style\.setProperty\('--zw-megabridge', g\)/.test(NAV));
  ok('...from the LOWEST edge anything hoverable reaches, not the item box',
    /querySelectorAll\('\.nav-center \.zw-navitem, \.nav-center \.zw-navitem > \.nav-link'\)/.test(NAV)
    && /low = Math\.max\(low, el\.getBoundingClientRect\(\)\.bottom\)/.test(NAV),
    '.nav-link padding overflows .zw-navitem — 36px of link inside 25px of item');
  ok('...and never reaches upward when there is nothing to bridge',
    /var gap = low \? Math\.max\(0, Math\.floor\(bottom - low\)\) : 0;/.test(NAV),
    'a two-row header ends BELOW the bar, so the gap is negative');
  ok('...measured in the same place the panel top is',
    /function setMegaTop\(\)[\s\S]{0,3600}--zw-megabridge/.test(NAV),
    'two measurements of one header in two functions is how they disagree');
}

console.log('\nThe panel never rises into the header');
{
  /* The entrance was transform:translateY(-12px) on the PANEL, so for the 200ms
     of every open the panel and its bridge sat 12px higher than they belong —
     inside the bar, over the words the panel drops from. Invisible, because the
     panel is painted in the header's own colour. */
  ok('the slide is on the columns, not on the panel',
    /\.zw-navitem > \.zw-mega > \.zw-mega-col\{\s*transform:translateY\(-12px\)/.test(CSS)
    && /\.zw-navitem:focus-within > \.zw-mega > \.zw-mega-col\{ transform:translateY\(0\); \}/.test(CSS));
  ok('...and the panel itself declares no transform',
    !/\.zw-navitem > \.zw-mega\{[^}]*transform:/.test(CSS)
    && !/\.zw-navitem:hover > \.zw-mega, \.zw-navitem:focus-within > \.zw-mega\{[^}]*transform:/.test(CSS),
    'its box has to stay in its lane, or the bridge goes up with it');
  ok('...while opacity and visibility still carry the fade',
    /\.zw-navitem:hover > \.zw-mega, \.zw-navitem:focus-within > \.zw-mega\{\s*opacity:1; visibility:visible; pointer-events:auto;/.test(CSS));
}

console.log('\nWhere the panel drops from is re-measured when the header moves');
{
  /* --zw-megatop was sampled at load, at 450ms and at 1300ms, then only on
     resize, scroll and hover. Two things move this header and are neither a
     resize nor a scroll: the announcement bar arriving (~25px, and in a builder
     preview it is held until the draft answers, which is after 1300ms), and the
     arrangement changing from one row to two (67px -> 89px), which lands
     whenever the settings row does. Measured in the builder preview:
     --zw-megatop 67px against a nav bottom of 116.8px. */
  ok('opening measures first and starts the loop second',
    /function _glueStart\(e\) \{\s*if \(!\(e\.target\.closest && e\.target\.closest\('\.zw-navitem'\)\)\) return;\s*setMegaTop\(\);/.test(NAV),
    'the CSS opens the panel on the same frame — a measurement one frame later is too late');
  ok('the bar and the bar-shaped hole are watched, not sampled',
    /new ResizeObserver\(_onMt\)/.test(NAV) && /_watch\(document\.getElementById\('bar'\)\)/.test(NAV));
  /* This one measures straight away rather than on the next frame, because the
     rules that read the measurements apply on the SAME frame the attribute is
     written — including the one that places the logo beside the categories. */
  ok('...and so is the arrangement changing under it',
    /new MutationObserver\(setMegaTop\)\.observe\(document\.documentElement/.test(NAV)
    && /'data-zw-hdr-linksrow'/.test(NAV),
    'one row to two is 22px, and it is neither a resize nor a scroll');
  ok('the sampled measurements are still there as the floor',
    /setTimeout\(setMegaTop, 450\); setTimeout\(setMegaTop, 1300\);/.test(NAV));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
