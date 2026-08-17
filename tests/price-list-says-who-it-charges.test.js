/* Which shoppers a proposed price will actually reach.
 *
 * The Pricing screen offered a "Price list" dropdown reading `Wholesale` and
 * `Default`, and said nothing about the difference — which is the entire
 * difference. One changes the price for everybody who visits the shop; the
 * other for a handful of approved trade accounts. Both confirm with "Proposed."
 *
 * Getting it wrong is silent in both directions, and expensive in one:
 *
 *   Meant for everyone, proposed on Wholesale → a markdown no shopper ever
 *   sees, and a merchant who believes the sale is running.
 *
 *   Meant for trade, proposed on Default → the trade price handed to every
 *   shopper on the site.
 *
 * ── The preselection ────────────────────────────────────────────────────────
 *
 * Worse than the labelling. _lists arrives ordered by priority DESCENDING, and
 * the first <option> is what a browser selects — so the default choice was
 * whichever list is MOST specialised. With a wholesale list at priority 100
 * that is Wholesale, and anyone proposing an ordinary markdown who never opened
 * the dropdown was pricing for trade buyers alone.
 *
 * The safe default is the broadest list, because that is the one whose effect
 * matches what "change this product's price" means to the person typing it.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SRC = fs.readFileSync(path.join(ROOT, 'admin-pricing.js'), 'utf8');

/* pricingAudience is lifted and run, rather than pattern-matched, so the
   wording is checked by what it produces. */
const audience = (() => {
  const at = SRC.indexOf('window.pricingAudience = function (l) {');
  if (at < 0) throw new Error('pricingAudience not found — the helper has been renamed or removed');
  const body = SRC.slice(at + 'window.pricingAudience = '.length);
  const end = body.indexOf('\n  };');
  if (end < 0) throw new Error('could not bound pricingAudience');
  // eslint-disable-next-line no-new-func
  return new Function('return ' + body.slice(0, end + 4))();
})();

console.log('\n  a price list says who it charges\n');

console.log('  the wording names the audience, not the row');
{
  ok('a list with no group is everyone', audience({ name: 'Default' }) === 'everyone',
    audience({ name: 'Default' }));
  ok('wholesale says trade buyers, and says approved',
    audience({ customer_group: 'wholesale' }) === 'approved trade buyers only',
    audience({ customer_group: 'wholesale' }));
  ok('members are named too', audience({ customer_group: 'member' }) === 'members only');
  ok('a region narrows it further',
    audience({ customer_group: 'wholesale', region: 'US' }) === 'approved trade buyers only in US');
  ok('so does a channel', audience({ channel: 'pos' }) === 'everyone on pos');
  ok('an unknown group is still described rather than hidden',
    audience({ customer_group: 'stockist' }) === 'stockists only');
}

console.log('\n  the dropdown carries it');
{
  ok('every option is labelled with its audience',
    /\$\{escapeHtml\(l\.name \|\| l\.code\)\} — \$\{escapeHtml\(window\.pricingAudience\(l\)\)\}/.test(SRC),
    'the option text is the bare list name again');
  ok('the field is labelled by what it decides',
    /Price list — who this price is for/.test(SRC));
  ok('changing it repaints the explanation',
    /onchange="pricingRefreshList\(\)"/.test(SRC));
  ok('…and so does a fresh render',
    /if \(_pick\) window\.pricingRefreshList\(\);/.test(SRC),
    'the note starts empty in the markup, so first paint would say nothing');
}

console.log('\n  the broadest list is the one preselected');
{
  ok('the preselection prefers a list with no customer group',
    /const preferred = active\.find\(\(l\) => !l\.customer_group\) \|\| active\[0\]/.test(SRC),
    'first-in-the-array means highest priority, which is the most specialised list');
  ok('…and it is actually marked selected in the option',
    /String\(l\.id\) === String\(preferred\.id\) \? ' selected' : ''/.test(SRC),
    'without the attribute the browser still picks the first option');
}

console.log('\n  the everyone-list is visibly the dangerous one');
{
  /* Bounded by the DEFINITION, not by the first mention. `window.pricingRefreshList`
     is CALLED inside render() further up the file than it is defined, so slicing
     to the first occurrence ran backwards and returned an empty string — and
     every assertion below it would then have been checking nothing. The
     length guard on the next line is what turned that into a failure instead of
     five silent passes; it is the whole reason it is there. */
  const a = SRC.indexOf('function listNote()');
  const b = SRC.indexOf('window.pricingRefreshList = function');
  const note = a >= 0 && b > a ? SRC.slice(a, b) : '';
  ok('the note block was found', note.length > 100,
    'a=' + a + ' b=' + b + ' len=' + note.length);
  ok('a broad list is coloured as a warning', /broad \?/.test(note) && /251,191,36/.test(note),
    'the same amber the rest of the panel uses for "read this"');
  ok('it states plainly that everyone sees it',
    /Everyone who visits the shop sees it/.test(note));
  ok('…and that a narrow list affects nobody else',
    /No other shopper is affected/.test(note));
  /* A row overriding the list's percentage rule for one product is the
     intended escape hatch, and a surprise if nobody says so. */
  ok('it warns when a row will replace the list rule',
    /replaces<\/strong> '\s*\+\s*'that rule for this product only/.test(note)
    || /replaces/.test(note),
    'a list with a % rule silently loses it for this product');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
