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
  /* The bar cannot be left to end on a fraction of a device row with nothing
     under it, so it paints one pixel of itself below its own box while a panel
     is there. ceil() keeps the panel off the bar; the bleed fills whatever
     fraction of a row that leaves. Neither half is enough alone. */
  ok('...and the bar bleeds a pixel of itself under whatever covers it',
    /box-shadow: 0 1px 0 var\(--zw-nav-bg, var\(--ink, #09090b\)\) !important;/.test(CSS),
    'a hard 1px shadow, no blur, in the bar’s own colour');
  ok('...only while something is covering it',
    /body\.zwf-searching :is\(nav#nav, \.nav, header\.nav, \.zw-nav\),[\s\S]{0,2400}box-shadow: 0 1px 0 /.test(CSS));
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
    'storefront-features sets it for both — it is what shrinks the header');
  ok('...and the mega panel, matched on the nav because it has no body class',
    !!rule && /:has\(\.zw-navitem\.zw-has-mega:hover\)/.test(rule[0])
    && /:has\(\.zw-navitem\.zw-has-mega:focus-within\)/.test(rule[0]),
    'focus-within too: the panel opens on keyboard focus as well as hover');
  ok('...and it deals with BOTH decorations, not just the border',
    !!rule && /border-bottom-color: transparent !important;/.test(rule[0])
    && /box-shadow: 0 1px 0 /.test(rule[0])
    && !/box-shadow: none/.test(rule[0]),
    'the soft 0 1px 12px shadow had to go; a hard 1px of the bar takes its place');
  /* Both nav dialects, because a rule written against one of them silently does
     nothing on the eight pages that use the other. */
  for (const d of ['nav#nav', '.nav', 'header.nav', '.zw-nav']) {
    ok('  ' + d + ' is named', !!rule && rule[0].includes(d));
  }
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

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
