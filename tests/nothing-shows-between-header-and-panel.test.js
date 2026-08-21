/* Where the header stops, the panel starts — with nothing in between.
 *
 * Three panels drop from the header and each one meets it at the same place:
 * the search overlay, the bag panel, and the category mega panel. Reported as
 * "a slight gap between the header and sometimes whatever modal is underneath
 * it", which is the right way to describe it — sometimes, because it depends on
 * the theme, the display and which panel.
 *
 * There are only three ways anything can appear in that join, and this file
 * holds all three shut.
 *
 * ── 0 · WHY THIS TOOK FOUR ATTEMPTS ─────────────────────────────────────────
 *
 * Because it is clean at 100% and at 200% display scaling, and I kept checking
 * at 100%. A 60-configuration sweep — 5 themes x 3 panels x 4 device scales,
 * screenshotting the join and classifying every device row across the width as
 * bar, panel, scrim or page — says it plainly:
 *
 *     as deployed   24 of 60 with something in the join
 *                   every single one of them at scale 1.25 or 1.5
 *     after         0 of 60
 *
 * Windows at 125% is the ordinary case, not the exotic one.
 *
 * At those scales the bar's bottom is not on a device row at all: 67.0 CSS px
 * is device row 83.75. No value of `top` fixes that, because the bar and the
 * panel are composited separately and each snaps its own paint:
 *
 *     panel top 66.4 (floor)   row 83 entirely panel — the bar loses a row
 *     panel top 67   (raw)     row 83 entirely panel — snapped down anyway
 *     panel top 67.2 (round)   row 83 entirely panel — snapped down anyway
 *
 * So the answer is not a better number. It is ceil(), which puts the panel
 * firmly BELOW the bar and never on it, plus one pixel of the bar painted under
 * its own box to fill whatever fraction of a row that leaves. Either half alone
 * still fails the sweep; together they close it.
 *
 * ── 1 · THE TWO SURFACES MEETING ON A FRACTION OF A PIXEL ────────────────────
 *
 * A CSS pixel is not a device pixel. The search and bag panels were already
 * pulled up to a whole device row and two more; the mega panel was not — it
 * used floor() on the CSS value, which at scale 1 is exactly flush:
 *
 *     nav bottom 67.0 CSS  ->  panel top 67.0 CSS   0 overlap
 *     at scale 1.25 that is device row 83.75, three quarters through a pixel
 *
 * Two separately composited layers meeting mid-pixel is where a hairline of the
 * page behind shows up. Measured after, at scales 1, 1.25 and 1.5: every panel
 * overlaps by 2 device pixels and lands on a whole device row (65, 81, 98).
 *
 * ── 2 · THE HEADER'S OWN BOTTOM EDGE, DRAWN ONTO THE PANEL ───────────────────
 *
 * The bar carries a 1px bottom border and, on the light themes, a
 * `0 1px 12px` shadow — which paints downward, onto whatever is beneath. With a
 * panel open, that is the panel. The mega panel already dropped the border for
 * exactly this reason; nothing else did, and nothing dropped the shadow.
 *
 * ── 3 · A SETTING THAT SAID IT HAD REMOVED THE LINE ──────────────────────────
 *
 * "Divider lines: off" lost to two theme rules that were more specific by
 * accident: `body.light-mode nav#nav` scores (1,1,2) against its (1,1,1), and
 * the mobile one carries !important. So on every light theme — including a
 * custom theme painting a dark bar on a light page, which is what this shop
 * runs — the switch did nothing at all. Measured: computed border-bottom-color
 * was rgba(18,18,18,0.07) with the attribute set to "off"; after, rgba(0,0,0,0).
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const CSS = read('storefront-cohesion.css');
const NAV = read('nav-menu.js');
const FEAT = read('storefront-features.js');

console.log('\n  nothing shows between the header and the panel under it\n');

console.log('  the two surfaces meet on a whole device row, and no further');
{
  /* THE PANEL IS ON TOP. Every one of them paints above the bar — the search
     and bag overlays at z-index 990 against the nav's 220, and the mega panel
     inside the nav, which puts it over the nav's own background. So a
     deliberate overlap is not hidden under anything: it is a stripe of the
     panel's colour across the bottom of the header.

     This subtracted two device pixels, on reasoning borrowed from a panel that
     paints UNDER the header. Read out of a screenshot at scale 1, cream header
     and white panel, header bottom 67:

         before   y=64 240,238,233   header
                  y=65 255,255,255   panel, over the header
                  y=66 255,255,255   panel, over the header
         after    y=66 240,238,233   header, its full height
                  y=67 255,255,255   panel

     Two rows of the wrong colour along the join is what a thin gap looks like,
     and it showed on the search and the bag because those are the two panels
     whose colour differs from the bar's.

     What still has to be prevented is the panel starting BELOW the header,
     which would show a sliver of the page. Flooring to a whole device row does
     that and nothing more.

     Deliberately the same expression in both files. They cannot share a module
     — one is the nav, one is the feature bundle, and neither imports — so what
     keeps them together is this check and a comment in each pointing at the
     other. */
  const EXPR = /Math\.max\(0, Math\.ceil\(bottom \* dpr\) \/ dpr\)/;
  ok('storefront-features measures the join that way', EXPR.test(FEAT));
  ok('...and nav-menu measures it identically', EXPR.test(NAV),
    'floor() on the CSS value left the mega panel meeting the bar mid-device-pixel');
  ok('...and neither reaches up into the bar',
    !/dpr - \d/.test(FEAT) && !/dpr - \d/.test(NAV)
    && !/Math\.floor\(bottom \* dpr\)/.test(FEAT) && !/Math\.floor\(bottom \* dpr\)/.test(NAV),
    'the panel is painted ON TOP, so anything above the bar’s bottom is a stripe');
  /* THE COMPENSATING PIXEL BELONGS TO THE PANEL, IN THE PANEL'S OWN COLOUR.
     ceil() keeps the panel off the bar; that leaves up to one device row
     neither surface covers, so each panel paints one pixel of ITSELF above
     its own top edge. Rounds down: the row is under the bar and nothing
     shows. Rounds up: the row shows and it is the panel's colour, which is
     what belongs directly below the bar. Neither half is enough alone.

     It was briefly the BAR that bled, in var(--zw-nav-bg, var(--ink)) — and
     on a light theme --ink is the dark ink token, not the bar. Measured on
     the live shop: nav background rgb(240,238,233), computed shadow
     rgb(18,18,18) 0 1px 0. A near-black hairline across the full width under
     a cream bar, on every light theme at every scale. That was the line. */
  ok('the search and bag panels bleed a pixel of themselves upward',
    (FEAT.match(/box-shadow:0 -1px 0 rgb\(var\(--bg-rgb, 9 9 11\)\)/g) || []).length === 2,
    'the same token each panel paints its background from');
  ok('...and the mega panel does too, from its own',
    /box-shadow:0 -1px 0 var\(--ink, #09090b\), 0 30px 44px -22px/.test(CSS));
  ok('...and the bar never bleeds, because its colour is not the panel’s',
    !/box-shadow: 0 1px 0 var\(--zw-nav-bg/.test(CSS),
    'var(--ink) is the dark ink on a light theme, not the bar');
  ok('...both reading devicePixelRatio rather than assuming 1',
    /var dpr = window\.devicePixelRatio \|\| 1;/.test(FEAT)
    && /var dpr = window\.devicePixelRatio \|\| 1;/.test(NAV));

  ok('the search and bag panels are placed from it',
    /function headerBottom\(\)/.test(FEAT)
    && /_overlay\.style\.top = headerBottom\(\) \+ 'px';/.test(FEAT));
  ok('the mega panel is placed from it',
    /setProperty\('--zw-megatop', v\)/.test(NAV)
    && /top: *var\(--zw-megatop/.test(CSS));
}

console.log('\n  the header draws no bottom edge where a panel covers it');
{
  const rule = CSS.match(/body\.zwf-searching :is\(nav#nav, \.nav, header\.nav, \.zw-nav\),[\s\S]{0,2600}?\n\}/);
  ok('one rule covers every panel', !!rule);
  ok('...the search overlay and the bag panel, which share a body class',
    !!rule && /body\.zwf-searching/.test(rule[0])
    && /classList\.add\('zwf-searching'\)/.test(FEAT)
    && (FEAT.match(/classList\.add\('zwf-searching'\)/g) || []).length >= 2,
    'storefront-features sets it for both, and the join rule is what reads it');
  ok('...and the mega panel, matched on the nav because it has no body class',
    !!rule && /:has\(\.zw-navitem\.zw-has-mega:hover\)/.test(rule[0])
    && /:has\(\.zw-navitem\.zw-has-mega:focus-within\)/.test(rule[0]),
    'focus-within too: the panel opens on keyboard focus as well as hover');
  /* The border only. The bar's soft 0 1px 12px shadow paints BELOW its box,
     which is where the opaque panel is and the panel is painted above it, so
     it is already covered. Removing it bought nothing and cost something:
     box-shadow is in this bar's transition list, so `none` fades over 350ms
     and draws a blurred band across the join for exactly that long. */
  ok('...and it touches the border only, leaving the shadow alone',
    !!rule && /border-bottom-color: transparent !important;/.test(rule[0])
    && !/box-shadow:/.test(rule[0]),
    'the shadow is under the panel already; removing it only adds a 350ms fade');
  /* Both nav dialects, because a rule written against one of them silently does
     nothing on the eight pages that use the other. */
  for (const d of ['nav#nav', '.nav', 'header.nav', '.zw-nav']) {
    ok('  ' + d + ' is named', !!rule && rule[0].includes(d));
  }
}

console.log('\n  and the header keeps its shape while the panel is open');
{
  /* The class used to resize the logo: transform:scale(.86) on the logo image,
     which took the home page mark from 50x50 to 43x43 and snapped it back on
     close — the transition lived inside the same rule, so it only existed on
     the way in. Measured with the search panel open and transitions cancelled,
     so the settled value is the one read. The bar itself never moved: 67px
     either way, floored by min-height:var(--zw-hdr-minh, 67px).

     A brand mark that changes size when a panel opens reads as a rendering
     fault, which is how it was reported. */
  ok('the logo is not resized when a panel opens',
    !/zwf-searching[^']*(\.nav-logo|\.zw-nav-logo)[^']*transform:\s*scale/.test(FEAT),
    'a mark that shrinks when the bag opens looks like a bug, not a gesture');
  ok('...and nothing else in the bundle scales it either',
    !/(\.nav-logo|\.zw-nav-logo|\.nav-logo-link)[^']*\{[^']*transform:\s*scale/.test(FEAT));
  /* The class still has a job — the join rule above keys off it — so it is
     still set for both panels and still removed on close. */
  ok('the class is still cleared on the way out',
    (FEAT.match(/classList\.remove\('zwf-searching'\)/g) || []).length >= 2,
    'left behind, it would hold the bar’s bottom edge transparent for good');
}

console.log('\n  and the divider setting can actually turn the line off');
{
  ok('lines="off" outranks the theme rules that were beating it',
    /html\[data-zw-hdr-lines="off"\] :is\(#nav, \.nav, \.zw-nav, header\.nav\),\s*html\[data-zw-hdr-lines="off"\] #bar \{\s*border-bottom-color: transparent !important;/.test(CSS),
    'body.light-mode nav#nav is (1,1,2) and the mobile one carries !important');
  ok('...and the bar keeps it too, since it draws the second line',
    /html\[data-zw-hdr-lines="off"\] #bar/.test(CSS));
  /* A store that keeps its lines still keeps them. The rule above is scoped to
     the attribute, and the join rule to a panel being open. */
  ok('...without turning the line off for stores that want one',
    !/:is\(nav#nav, \.nav, header\.nav, \.zw-nav\) \{\s*border-bottom-color: transparent !important;\s*\}/.test(CSS));
}

console.log('\n  and the header holds still while the panel is measured against it');
{
  /* The panel's overlay is positioned at the header's MEASURED bottom edge.
     Opening it also shrinks the header's padding to .3rem — and the header
     transitions padding over 350ms, so that measurement was of a header still
     moving. The panel opened low and crept up as trackHeader() re-measured for
     520ms.

     Live, at 1280px — overlay top, first frame -> settled:

         classic      header 67.0px    92    -> 92       0px
         links-left   header 67.0px    92    -> 92       0px
         minimal      header 67.0px    92    -> 92       0px
         stacked      header 89.4px    114.5 -> 110.5    4px
         links-row    header 87.8px    113   -> 109      4px

     67px is the min-height floor, so a one-row header has no padding it can
     give up and never moves — which is why this was reported as happening on
     "some" arrangements. Only the two-row layouts are above the floor.

     With the fix, measured the same way: 110.5 -> 110.5 and 109 -> 109. */
  ok('the padding shrink is named in the transition list at all',
    /transition:[^;]*padding \.35s !important/.test(CSS),
    'this is the declaration the fix has to opt out of');
  ok('…and a panel being open takes padding OUT of it',
    /body\.zwf-searching :is\(nav#nav, header\.nav, nav\.nav, nav\.zw-nav\)\{[\s\S]{0,320}?transition:[^;]*!important/.test(CSS));
  const searching = (CSS.match(/body\.zwf-searching :is\(nav#nav, header\.nav, nav\.nav, nav\.zw-nav\)\{([\s\S]*?)\}/) || [])[1] || '';
  ok('…so the header lands on its shrunk size in one step',
    searching.length > 0 && !/padding/.test(searching),
    searching.slice(0, 90));
  /* Snapping `top` or `transform` would trade a 4px panel jump for a header
     that stops sliding — a worse deal. */
  ok('…while everything the auto-hide header rides on still transitions',
    /top \.3s/.test(searching) && /transform \.35s/.test(searching));
  ok('it is fixed in CSS, not with an inline style that cannot win',
    !/style\.transition\s*=\s*'none'/.test(FEAT),
    'the declaration it would have to beat is !important, so an inline value loses');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
