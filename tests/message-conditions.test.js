/* Is each message wired to the RIGHT condition?
 *
 * The other suites check that a message exists, is delivered, and is used on the
 * screen the map claims. None of them checks that it fires at the right moment —
 * a message on the wrong branch passes all of them, and the shopper reads
 * "Out of stock" about something that is in stock. That was the original bug in
 * this whole area, and it was invisible to every static check written for it.
 *
 * So this runs the real branching. updateStockInfo() is lifted out of
 * product.html and executed against a stubbed page and the real ZWStock, then
 * asked what it decided for a matrix of shelf-and-bag states.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..') + '/';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

const win = {};
new Function('window', fs.readFileSync(ROOT + 'customer-messages.js', 'utf8'))(win);
new Function('window', fs.readFileSync(ROOT + 'stock-rules.js', 'utf8'))(win);
const M = win.ZWMessages;

/* The real function, taken from the real file. If somebody rewrites it, this
   picks up the rewrite rather than a copy of what it used to do. */
const SRC = require('./_product-source').all()  /* product.html + its extracted scripts — see _product-source.js */;
const start = SRC.indexOf('function updateStockInfo() {');
const end = SRC.indexOf('\nfunction checkLowStock()');
if (start === -1 || end === -1) {
  console.log('  ✗ cannot find updateStockInfo in product.html');
  process.exit(1);
}
const fnSrc = SRC.slice(start, end);

/**
 * Run updateStockInfo for one situation.
 * @returns { text, disabled }  what the shopper is shown, and whether they can add
 */
function ask({ onShelf, inBag, threshold = 10, noInventory = false, panelOpen = false }) {
  const info = { textContent: '' };
  const btn = { disabled: false, classList: { toggle() {}, add() {}, remove() {} } };
  /* The back-in-stock panel, because the sold-out line now defers to it rather
     than repeating what it says. */
  const panel = { style: { display: panelOpen ? 'block' : 'none' } };
  const els = { stockInfo: info, addToCartBtn: btn, 'restock-panel': panel };

  const cart = inBag
    ? [{ productId: 'p1', size: 'M', colorName: 'Yellow', quantity: inBag }]
    : [];

  const scope = {
    selectedSize: 'M',
    selectedColor: { color_name: 'Yellow' },
    currentProduct: {
      id: 'p1',
      low_stock_threshold: threshold,
      inventory: noInventory ? [] : [{ size: 'M', color_name: 'Yellow', stock_quantity: onShelf }],
    },
    sizeStockForColor: () => onShelf,
    document: { getElementById: (id) => els[id] || null },
    localStorage: { getItem: () => JSON.stringify(cart) },
    ZWStock: win.ZWStock,
    window: win,
  };

  new Function(...Object.keys(scope), fnSrc + '\nupdateStockInfo();')(...Object.values(scope));
  return { text: info.textContent, disabled: btn.disabled };
}

/** Which message key produced this text, if any. */
function keyOf(text) {
  if (!text) return '(nothing)';
  const hit = M.keys().find((k) => M.get(k, { count: 1, size: 'M', title: 'x' }) === text
    || M.get(k, { count: 2, size: 'M', title: 'x' }) === text
    || M.get(k, { count: 3, size: 'M', title: 'x' }) === text
    || M.get(k, { count: 5, size: 'M', title: 'x' }) === text);
  return hit || 'UNKNOWN: ' + text;
}

console.log('\n  the product page picks the message the situation calls for');

{
  const r = ask({ onShelf: 0, inBag: 0 });
  ok('an empty shelf says sold out', keyOf(r.text) === 'soldOut', keyOf(r.text));
  ok('…and cannot be added', r.disabled === true);

  /* Said ONCE. The back-in-stock panel opens with "Size M is sold out — get
     notified when it's back", so a line underneath reading "Out of stock" is
     the same fact twice, printed below the thing offering the remedy. */
  const withPanel = ask({ onShelf: 0, inBag: 0, panelOpen: true });
  ok('…but not repeated while the panel is already saying it',
    withPanel.text === '', withPanel.text);
  ok('…and Add to Bag is still off either way', withPanel.disabled === true);
}

{
  /* THE bug this area exists for: the shopper holds the last one, and the page
     announced the store had sold out. */
  const r = ask({ onShelf: 1, inBag: 1 });
  ok('the last one, in their own bag, is NOT sold out', keyOf(r.text) !== 'soldOut', keyOf(r.text));
  ok('…it says they are holding it', keyOf(r.text) === 'lastInBag', keyOf(r.text));
  ok('…and they still cannot add a second', r.disabled === true);
}

{
  const r = ask({ onShelf: 3, inBag: 3 });
  ok('holding all three says so, in the plural', keyOf(r.text) === 'allInBag', keyOf(r.text));
  ok('…and the count is what they hold', r.text.includes('3'), r.text);
}

{
  const r = ask({ onShelf: 3, inBag: 0 });
  ok('three on the shelf and none held is a low-stock line', keyOf(r.text) === 'lowStock', keyOf(r.text));
  ok('…and can be added', r.disabled === false);
}

{
  /* The count has to be what they can still ADD, not what exists — the original
     complaint. */
  const r = ask({ onShelf: 3, inBag: 1 });
  ok('one already in the bag leaves two to add', r.text.includes('2'), r.text);
  ok('…and it is still the low-stock message', keyOf(r.text) === 'lowStock', keyOf(r.text));
}

{
  const r = ask({ onShelf: 50, inBag: 0, threshold: 10 });
  ok('plenty in stock says nothing at all', r.text === '', r.text);
  ok('…and can be added', r.disabled === false);
}

{
  /* Unknown must stay permissive: a shop with no inventory configured sells. */
  const r = ask({ onShelf: null, inBag: 0, noInventory: true });
  ok('a product with no inventory configured is silent', r.text === '', r.text);
  ok('…and sells', r.disabled === false);
}

{
  /* A bag that outlived its shelf. Still not a sell-out — one is there. */
  const r = ask({ onShelf: 1, inBag: 4 });
  ok('a stale bag holding more than exists is not a sell-out',
    keyOf(r.text) !== 'soldOut', keyOf(r.text));
}

console.log('\n  no quantity in any bag can produce the sold-out message');
{
  /* Stated as a property rather than as examples: this is the invariant, and
     everything above is an illustration of it. */
  let bad = null;
  for (let shelf = 1; shelf <= 5 && !bad; shelf += 1) {
    for (let bag = 0; bag <= 8; bag += 1) {
      const r = ask({ onShelf: shelf, inBag: bag });
      if (keyOf(r.text) === 'soldOut') { bad = `shelf ${shelf}, bag ${bag}`; break; }
    }
  }
  ok('checked across every shelf and bag combination', bad === null, bad);
}

console.log('\n  and the situation can actually be reached');
{
  /* Knowing updateStockInfo() SAYS sold-out for an empty shelf is only half of
     it. The other half is whether a shopper can ever get the page into that
     state — and for a long time they could not: clicking a sold-out size opened
     the back-in-stock panel and returned before selecting anything, so
     updateStockInfo never ran for that size and the message was dead copy.

     The two halves together are the proof. The matrix above is the first;
     this is the second. */
  const click = SRC.slice(SRC.indexOf("btn.addEventListener('click'"), SRC.indexOf('sizeGrid.appendChild(btn)'));
  const soldOutBranch = click.slice(0, click.indexOf('hideRestockPanel()'));

  ok('clicking a sold-out size selects it', /selectedSize = size/.test(soldOutBranch),
    'the branch returns before selecting, so the sold-out line can never show');
  ok('…and asks the page to say so', /updateStockInfo\(\)/.test(soldOutBranch));
  ok('…while still offering the waitlist', /openRestockPanel\(size\)/.test(soldOutBranch));
  /* And the line has somewhere left to speak: switching colour re-renders,
     which closes the panel first, so a size that goes sold-out in the new
     colourway shows the message rather than nothing. */
  const render = SRC.slice(SRC.indexOf('function renderSizes()'), SRC.indexOf('sizes.forEach'));
  ok('…and a colour change closes the panel, leaving the line to say it',
    /hideRestockPanel\(\)/.test(render));
}

console.log('\n  an admin edit moves the branch it belongs to, and no other');
{
  /* If editing one message changed what another situation showed, the branching
     would be reading the wrong key — which a source check cannot see. */
  M.setOverrides({ lastInBag: 'YOURS ALREADY' });
  const held = ask({ onShelf: 1, inBag: 1 });
  const gone = ask({ onShelf: 0, inBag: 0 });
  ok('the edited message appears in its own situation', held.text === 'YOURS ALREADY', held.text);
  ok('…and nowhere else', gone.text === 'Out of stock', gone.text);
  M.setOverrides({});
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
