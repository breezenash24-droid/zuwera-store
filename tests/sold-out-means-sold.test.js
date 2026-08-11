/* "Out of stock" has to mean somebody paid for the last one.
 *
 * The product page showed a size as out of stock, with Add to Bag disabled, as
 * soon as the shopper put the last one in their OWN bag. Nothing had sold.
 *
 * That came from one number doing two jobs: availableToAdd() returns shelf
 * minus bag, and the page rendered every zero it produced as a sell-out. The
 * two zeros mean opposite things to a shopper — "gone, try the waitlist" versus
 * "it's yours, go and pay" — and a bag is not a claim on stock. Anyone can fill
 * one and never come back.
 *
 * Stock leaves the shelf in exactly one place: decrement_stock, called from the
 * Stripe webhook on payment_intent.succeeded. There is no reservation table, no
 * hold at checkout and no database trigger, so nothing a browser does can
 * reduce it. This file holds the storefront to the same rule.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const w = {};
new Function('window', read('stock-rules.js'))(w);
const S = w.ZWStock;

const ITEM = { productId: 'p1', size: 'M', colorName: 'Yellow' };
const bag = (qty) => (qty ? [{ productId: 'p1', size: 'M', colorName: 'Yellow', quantity: qty }] : []);

console.log('\n  only a completed sale can sell something out');

{
  /* The reported bug, exactly as it happened. */
  const a = S.availability(1, ITEM, bag(1));
  ok('the last one, sitting in the shopper\'s own bag, is NOT sold out', a.soldOut === false);
  ok('…it is reported as held by them instead', a.heldByYou === true);
  ok('…they still cannot add a second', a.canAdd === false);
  ok('…and the figure they are shown is zero, which is what they can add', a.left === 0);
}

{
  const a = S.availability(0, ITEM, []);
  ok('an empty shelf is sold out', a.soldOut === true);
  ok('…and is not blamed on the bag', a.heldByYou === false);
  ok('…and cannot be added', a.canAdd === false);
}

{
  /* The invariant, stated as a property rather than as one example: whatever is
     in the bag, a shelf with stock on it has not sold out. This is the whole
     file in one assertion — every other case here is an illustration of it. */
  let bad = null;
  for (let shelf = 1; shelf <= 6 && !bad; shelf += 1) {
    for (let qty = 0; qty <= 12; qty += 1) {
      if (S.availability(shelf, ITEM, bag(qty)).soldOut) { bad = `shelf ${shelf}, bag ${qty}`; break; }
    }
  }
  ok('no quantity in any bag can make a stocked size sold out', bad === null, bad);
}

{
  /* A bag can outlive the shelf it was filled from — added when there were
     three, opened when there is one. Still not a sell-out: one is there. */
  const a = S.availability(1, ITEM, bag(3));
  ok('a stale bag holding more than exists is still not a sell-out', a.soldOut === false && a.heldByYou === true);
}

{
  /* heldByYou has to match the way the shelf lookup matches, or it lands on the
     wrong variant — the drift that started all of this. */
  ok('another colour in the bag does not make this one unavailable',
    S.availability(1, ITEM, [{ productId: 'p1', size: 'M', colorName: 'Tennesee', quantity: 1 }]).heldByYou === false);
  ok('colour case still does not matter',
    S.availability(1, ITEM, [{ productId: 'p1', size: 'M', colorName: 'yellow', quantity: 1 }]).heldByYou === true);
  ok('XXL in the bag counts against a 2XL shelf figure',
    S.availability(2, { productId: 'p1', size: '2XL', colorName: 'Yellow' },
      [{ productId: 'p1', size: 'XXL', colorName: 'Yellow', quantity: 2 }]).heldByYou === true);
}

{
  /* Unknown must stay unknown in both directions. Turning it into a sell-out
     would empty a shop whose inventory simply is not configured. */
  const a = S.availability(null, ITEM, bag(2));
  ok('unknown stock is not sold out', a.soldOut === false);
  ok('…is not held by anyone', a.heldByYou === false);
  ok('…and still sells', a.canAdd === true && a.left === null);
}

{
  /* The two must not drift: availability() is meant to be availableToAdd() with
     the reason for the zero kept, not a second opinion about the number. */
  let bad = null;
  for (const shelf of [0, 1, 2, 5]) {
    for (const qty of [0, 1, 2, 5, 9]) {
      const a = S.availability(shelf, ITEM, bag(qty));
      if (a.left !== S.availableToAdd(shelf, ITEM, bag(qty))) { bad = `shelf ${shelf}, bag ${qty}`; break; }
    }
  }
  ok('the count still agrees with availableToAdd', bad === null, bad);
}

console.log('\n  the pages say it the way the rule says it');

{
  const src = strip(read('product.html'));
  ok('the product page asks for the distinction', /ZWStock\.availability\(/.test(src),
    'it is back to deriving sold-out from a bare number');

  /* The wording itself now lives in customer-messages.js, so what is checked
     here is the BRANCHING: which message key each case reaches for. That is the
     part this file is about — the sentences moved, the rule did not.

     Proximity, in LINES and after normalising endings — counting characters
     made an earlier guard's verdict depend on git autocrlf, so it passed on
     Windows and failed in CI. */
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const idx = lines.findIndex((l) => /msg\(\s*'soldOut'\s*\)/.test(l));
  const near = idx === -1 ? '' : lines.slice(Math.max(0, idx - 4), idx + 2).join('\n');
  ok('…and reaches for the sold-out message only under the shelf-derived flag',
    idx !== -1 && /soldOut\b/.test(near), idx === -1 ? 'no such line' : near.trim());

  ok('…and tells the shopper when it is their own bag stopping them',
    /'lastInBag'/.test(src) && /'allInBag'/.test(src),
    'the held-by-you case has no message of its own');
}

{
  /* The bag page was already right and this keeps it that way: its out-of-stock
     note, and the back-in-stock prompt it mounts, come from stockFor (the
     shelf). Subtracting the bag there would tell shoppers to wait for an email
     about something they are holding. */
  const src = strip(read('bag.html'));
  ok('the bag page reads the shelf, not the shelf minus itself',
    !/availableToAdd/.test(src), 'bag.html now subtracts its own contents before reporting stock');
}

{
  /* The guard-rail, in the shape of tests/stock-implementations.test.js: fixing
     the one page that conflated these does not stop the next one doing it.
     Sold-out wording must not be derived from the bag-subtracted primitive
     anywhere. */
  const SKIP = ['/dist/', '/node_modules/', '/.wrangler/', '/tests/', '/.git/'];
  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = '/' + path.relative(ROOT, full).split(path.sep).join('/') + '/';
      if (SKIP.some((d) => rel.includes(d))) continue;
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(js|html)$/.test(entry.name)) out.push(full);
    }
    return out;
  };

  const WINDOW = 12;
  const SOLD_OUT_WORDS = /Out of stock|out of stock|Sold Out|sold out|soldOut|sold-out/;
  const offenders = [];
  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (rel === 'stock-rules.js') continue;          // where the distinction is defined
    const lines = strip(fs.readFileSync(file, 'utf8')).replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!/availableToAdd/.test(lines[i])) continue;
      const near = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join('\n');
      if (SOLD_OUT_WORDS.test(near)) { offenders.push(rel + ':' + (i + 1)); break; }
    }
  }
  ok('nothing derives sold-out wording from the bag-subtracted figure', offenders.length === 0,
    offenders.length ? offenders.join(', ') + ' — use ZWStock.availability() and branch on .soldOut' : '');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
