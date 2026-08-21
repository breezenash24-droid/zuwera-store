/* The collection page's filter row runs past the edge of a phone, and gave no
   sign of it.

   ── MEASURED ON THE LIVE PAGE ───────────────────────────────────────────────

       viewport   content    box      overflow
        390 px     635 px   390 px    245 px      three facets past the edge
        456 px     635 px   456 px    179 px
        700 px     700 px   700 px    fits
       1024 px     957 px   957 px    fits
       1280 px     the pill row is display:none — desktop uses the sidebar

   Eight pills: Filter, Category, Gender, Color, Sport, Best for, Material,
   Price. `overflow-x:auto` is deliberate, and so is hiding the scrollbar —
   `scrollbar-width:none` plus a `::-webkit-scrollbar{display:none}` — because
   a bar drawn across the pills looks worse than the overflow does. But between
   them that left NO signal of any kind, so a row that scrolls looked like a row
   that was cut off. It was reported as "scrunched up", which is exactly right.

   ── WHY THE FIX IS NOT "SHOW FEWER PILLS" ───────────────────────────────────

   The facet list is data-driven: Sport, Material and Best-for only render when
   products actually carry that data (`plpSportFacetList().length`, and so on),
   and every pill grows a "(2)" when it is filtered. So the width changes with
   the catalogue and with what the shopper has picked. Any fixed "keep these
   four inline" would be right for this shop and wrong for the next one — and
   wrong for a licensee, whose catalogue nobody here has seen.

   So: make overflow readable at any count.

   ── AND WHY IT IS A MASK, NOT AN OVERLAY ────────────────────────────────────

   The bar has dark, light and super-light variants. A gradient overlay would
   have to know the background colour in each; a mask fades to whatever is
   behind it and needs to know nothing. */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const COLL = fs.readFileSync(path.join(ROOT, 'drop001.html'), 'utf8').replace(/\r\n/g, '\n');
const code = COLL.replace(/\/\*[\s\S]*?\*\//g, '');

console.log('\n  the filter row says it scrolls\n');

console.log('  the state is measured, not assumed');
{
  ok('there is one function that decides which way there is more',
    /function plpPillOverflow\(\)\{/.test(code));
  ok('…and it measures the element rather than counting pills',
    /var max = el\.scrollWidth - el\.clientWidth;/.test(code),
    'the pill count changes with the catalogue and with what is filtered');
  ok('a row that fits gets NO fade',
    /if \(max <= 2\) \{ el\.removeAttribute\('data-more'\); return; \}/.test(code),
    'an edge that fades with nothing past it is the same lie pointing the other way');
  ok('…with a couple of pixels of slack for sub-pixel layout',
    /max <= 2/.test(code) && /el\.scrollLeft > 2/.test(code) && /el\.scrollLeft < max - 2/.test(code));
  ok('all three positions are distinguished',
    /more\.left && more\.right \? 'both' : more\.right \? 'right' : 'left'/.test(code));
}

console.log('\n  and it is kept up to date');
{
  ok('re-measured on every render of the bar',
    /host\.innerHTML = html;[\s\S]{0,400}plpPillOverflow\(\);/.test(code),
    'a facet appearing, or a pill growing a "(2)", changes whether it overflows');
  ok('…and on scroll', /host\.addEventListener\('scroll', plpPillOverflow, \{ passive: true \}\)/.test(code));
  ok('…and on resize', /window\.addEventListener\('resize', plpPillOverflow, \{ passive: true \}\)/.test(code));
  ok('the listeners are wired once, not per render',
    /if \(!host\.__zwOverflowWired\) \{/.test(code),
    'renderPlpPillBar runs on every filter change');
  ok('scroll and resize are passive, so the fade never blocks the scroll',
    (code.match(/plpPillOverflow, \{ passive: true \}/g) || []).length === 2);
}

console.log('\n  the fade itself');
{
  for (const side of ['right', 'left', 'both'])
    ok('there is a rule for data-more="' + side + '"',
      new RegExp('\\.plp-pillbar\\[data-more="' + side + '"\\]').test(COLL));
  ok('it is a mask, so it works on every theme without knowing the background',
    /\.plp-pillbar\[data-more="right"\]\{[\s\S]{0,220}mask-image:linear-gradient/.test(COLL),
    'the bar has dark, light and super-light variants');
  ok('…with the -webkit- prefix beside it',
    (COLL.match(/-webkit-mask-image:linear-gradient/g) || []).length >= 3);
  ok('the right-hand fade is on the right, and the left on the left',
    /data-more="right"\]\{\s*\n?\s*-webkit-mask-image:linear-gradient\(to right/.test(COLL)
    && /data-more="left"\]\{\s*\n?\s*-webkit-mask-image:linear-gradient\(to left/.test(COLL));
  ok('…and "both" fades at each end',
    /data-more="both"\][\s\S]{0,200}linear-gradient\(to right,transparent,#000 [^,]+,#000 calc\(100% - [^)]+\),transparent\)/.test(COLL));
}

console.log('\n  none of which replaced the scrolling');
{
  /* The row must still scroll. A fade over a row that can no longer move is a
     decoration hiding the same problem. */
  ok('the bar still scrolls horizontally', /overflow-x:auto/.test(COLL));
  ok('…and still hides the scrollbar it would otherwise draw over the pills',
    /scrollbar-width:none/.test(COLL) && /\.plp-pillbar::-webkit-scrollbar \{ display:none; \}/.test(COLL));
  ok('…and no pill was removed to make it fit',
    ['category', 'gender', 'color', 'sport', 'bestfor', 'material', 'price']
      .every((k) => new RegExp("key:'" + k + "'").test(code)),
    'the facet list is data-driven; trimming it would be right for one catalogue only');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
