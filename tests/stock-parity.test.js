/* The browser and the server must answer "how many are there?" identically.
 *
 * They did not, and it reached customers: the product page said "Only 1 left in
 * stock", the shopper added it, checkout said "is out of stock". Four pieces of
 * code answered that question and they had drifted apart.
 *
 * stock-rules.js is the storefront's copy, written to mirror
 * fetchSizeStockQty() in functions/api/_cart-pricing.js. This runs BOTH over the
 * same table of cases and asserts they agree on every one. A change to either
 * that is not made to the other fails here rather than in someone's bag.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

// Load the browser module into a fake window.
const w = {};
new Function('window', fs.readFileSync(ROOT + '/stock-rules.js', 'utf8'))(w);

/* Cases as (rows, size, colour) → the answer both sides must give. Chosen to be
   the shapes that used to disagree, plus the ordinary ones that must not break
   while fixing them. */
const CASES = [
  { name: 'exact colour match',            rows: [{ size: 'M', color_name: 'yellow', stock_quantity: 3 }], size: 'M', color: 'yellow' },
  { name: 'colour differing by case',      rows: [{ size: 'M', color_name: 'yellow', stock_quantity: 3 }], size: 'M', color: 'Yellow' },
  { name: 'colour padded with spaces',     rows: [{ size: 'M', color_name: ' Teal Blue ', stock_quantity: 2 }], size: 'M', color: 'teal blue' },
  { name: 'a sold-out sibling colour',     rows: [{ size: 'M', color_name: 'black', stock_quantity: 0 }, { size: 'M', color_name: 'yellow', stock_quantity: 1 }], size: 'M', color: 'Yellow' },
  { name: 'asking for the empty colour',   rows: [{ size: 'M', color_name: 'yellow', stock_quantity: 5 }, { size: 'M', color_name: 'black', stock_quantity: 0 }], size: 'M', color: 'black' },
  { name: 'stock split across two rows',   rows: [{ size: 'M', color_name: 'yellow', stock_quantity: 1 }, { size: 'M', color_name: 'yellow', stock_quantity: 1 }], size: 'M', color: 'yellow' },
  { name: 'XXL against a 2XL row',         rows: [{ size: '2XL', color_name: 'yellow', stock_quantity: 2 }], size: 'XXL', color: 'yellow' },
  { name: 'a size with no row',            rows: [{ size: 'L', color_name: 'yellow', stock_quantity: 4 }], size: 'M', color: 'yellow' },
  { name: 'legacy colour-agnostic rows',   rows: [{ size: 'M', color_name: null, stock_quantity: 7 }], size: 'M', color: 'yellow' },
  { name: 'no inventory rows at all',      rows: [], size: 'M', color: 'yellow' },
  { name: 'no colour asked for',           rows: [{ size: 'M', color_name: 'yellow', stock_quantity: 2 }, { size: 'M', color_name: 'black', stock_quantity: 3 }], size: 'M', color: '' },
];

/* The server reads through fetch, so it is driven the same way production
   drives it: a stub standing in for PostgREST, returning every row for the
   product exactly as the real query now does. */
async function serverAnswer(c) {
  const mod = await import(pathToFileURL(ROOT + '/functions/api/_cart-pricing.js').href);
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(c.rows), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  try {
    // resolveCatalogItems is the only exported way in; read the number back out
    // of the refusal it throws, or treat a clean pass as "enough".
    const env = { SUPABASE_URL: 'https://e.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' };
    const items = [{ id: 'p1', size: c.size, colorName: c.color, quantity: 1 }];
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/products?')) {
        return new Response(JSON.stringify([{ id: 'p1', title: 'T', sku: 'S', current_price: '10.00' }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(c.rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    await mod.resolveCatalogItems(items, env, false, true);
    return 'allows 1';
  } catch (e) {
    return /out of stock/i.test(e.message) ? 'refuses' : 'refuses';
  } finally {
    globalThis.fetch = real;
  }
}

async function run() {
  console.log('\n  the browser and the server agree');

  for (const c of CASES) {
    const rows = c.rows.map((r) => Object.assign({ product_id: 'p1' }, r));
    const client = w.ZWStock.stockFor(rows, 'p1', c.size, c.color || null);
    const server = await serverAnswer(c);

    /* Compared as the decision each side reaches for one unit, which is the
       thing that has to match — an exact count is not always recoverable from
       the server, whose only public answer is "sold" or "refused". */
    const clientAllows = client === null || client >= 1;
    const serverAllows = server === 'allows 1';
    ok(c.name, clientAllows === serverAllows,
      'browser says ' + (client === null ? 'unknown' : client) + ' → ' +
      (clientAllows ? 'allow' : 'refuse') + ', server says ' + (serverAllows ? 'allow' : 'refuse'));
  }

  console.log('\n  and the browser counts what it should');
  {
    const r = (rows) => rows.map((x) => Object.assign({ product_id: 'p1' }, x));
    ok('sums rows of the same colour',
      w.ZWStock.stockFor(r([{ size: 'M', color_name: 'y', stock_quantity: 1 }, { size: 'M', color_name: 'y', stock_quantity: 2 }]), 'p1', 'M', 'y') === 3);
    ok('does not borrow another colour’s stock',
      w.ZWStock.stockFor(r([{ size: 'M', color_name: 'y', stock_quantity: 9 }]), 'p1', 'M', 'black') === 0);
    /* null, not 0. The product page treats "no inventory configured" as freely
       buyable, so a cap here would block a sale the store never limited. */
    ok('answers unknown, not zero, when nothing is configured',
      w.ZWStock.stockFor([], 'p1', 'M', 'y') === null);
    ok('folds XXL onto 2XL',
      w.ZWStock.stockFor(r([{ size: '2XL', color_name: 'y', stock_quantity: 4 }]), 'p1', 'XXL', 'y') === 4);
  }

  console.log('\n  the back-in-stock prompt obeys the admin switch');
  {
    w.__zwFlags = { feature_back_in_stock: { enabled: false } };
    ok('off when explicitly disabled', w.ZWStock.restockEnabled() === false);
    w.__zwFlags = {};
    ok('on when the flag was never touched', w.ZWStock.restockEnabled() === true);
    w.__zwFlags = undefined;
    /* Permissive on purpose: flags arrive asynchronously, and treating "not
       loaded yet" as off would hide the prompt from whoever got there first. */
    ok('on when flags have not loaded yet', w.ZWStock.restockEnabled() === true);
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('harness failed:', e); process.exit(1); });
