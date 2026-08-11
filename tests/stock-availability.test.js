/* What the product page promises, checkout has to honour.
 *
 * The page offered "Only 1 left in stock", the shopper added it, and checkout
 * refused with "is out of stock." Two implementations of one question —
 * sizeStockForColor() in product.html and fetchSizeStockQty() in
 * _cart-pricing.js — had drifted, and the drift was invisible until it cost a
 * sale. Every case below is a shape where they used to disagree.
 *
 * These run the real quoteCart() against a stubbed catalog, so what is asserted
 * is what checkout would actually do with those rows.
 */
const { pathToFileURL } = require('url');
const path = require('path');
const PRICING = pathToFileURL(path.resolve(__dirname, '../functions/api/_cart-pricing.js')).href;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

const PRODUCT = {
  id: 'p1', title: 'Zuwera Aero Pro', sku: 'ZW-MTP-002',
  current_price: '40.00', shipping_weight_lb: '1',
};

/* Runs a checkout attempt against a catalog holding exactly `sizeRows`.
   Resolves to null on success, or the refusal message. */
async function attempt({ sizeRows, size = 'M', colorName = '', quantity = 1, shownPrice }) {
  const { quoteCart } = await import(PRICING);
  const realFetch = globalThis.fetch;
  const reply = (p) => new Response(JSON.stringify(p), { status: 200, headers: { 'Content-Type': 'application/json' } });
  /* The stub honours the query string, because the bug lived in it.
     PostgREST's eq is a case-sensitive exact match and limit truncates — a stub
     that returned every row regardless would make the old implementation look
     correct here while it failed in production, which is the exact trap these
     tests exist to close. */
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/products?')) return reply([PRODUCT]);
    if (u.includes('product_sizes')) {
      const qs = new URLSearchParams(u.split('?')[1] || '');
      let rows = sizeRows.slice();
      for (const [field, raw] of qs.entries()) {
        if (!raw.startsWith('eq.') || field === 'product_id') continue;
        const want = raw.slice(3);
        rows = rows.filter((r) => String(r[field] ?? '') === want);
      }
      const limit = Number(qs.get('limit'));
      if (Number.isInteger(limit) && limit > 0) rows = rows.slice(0, limit);
      return reply(rows);
    }
    return reply([]);
  };
  try {
    await quoteCart({
      items: [{ id: 'p1', size, colorName, quantity, ...(shownPrice === undefined ? {} : { price: shownPrice }) }],
      address: { email: 'a@b.co', name: 'A', line1: '1 A St', city: 'Albany', state: 'NY', zip: '12207', country: 'US' },
      env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' },
      request: new Request('https://zuwera.store/api/x', { method: 'POST' }),
    });
    return null;
  } catch (e) {
    return (e && e.message) || String(e);
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function run() {
  console.log('\n  the last one in stock is still for sale');
  {
    /* The reported bug, at its simplest. `available < itemQty` is the right
       comparison — 1 < 1 is false — so this passing proves the refusal came
       from the lookup returning the wrong number, not from the arithmetic. */
    const err = await attempt({ sizeRows: [{ size: 'M', color_name: 'yellow', stock_quantity: 1 }], colorName: 'yellow' });
    ok('one in stock, one in the bag, sale allowed', err === null, err);

    const two = await attempt({ sizeRows: [{ size: 'M', color_name: 'yellow', stock_quantity: 1 }], colorName: 'yellow', quantity: 2 });
    ok('…but two in the bag is still refused', /Only 1 left/i.test(two || ''), two);
  }

  console.log('\n  colour is matched the way the page matches it');
  {
    /* PostgREST eq is case-sensitive; the page lowercases both sides. A cart
       carrying "Yellow" against a row saying "yellow" used to miss. */
    const err = await attempt({ sizeRows: [{ size: 'M', color_name: 'yellow', stock_quantity: 3 }], colorName: 'Yellow' });
    ok('colour case does not decide whether you can buy', err === null, err);

    const spaced = await attempt({ sizeRows: [{ size: 'M', color_name: ' Teal Blue ', stock_quantity: 2 }], colorName: 'teal blue' });
    ok('nor does stray whitespace around it', spaced === null, spaced);

    /* THE REPORTED BUG, exactly as it happened. Neither half is fatal alone —
       a case mismatch on its own falls back to the only row and reads correctly,
       and a sold-out sibling colour on its own is matched past. Together they
       are the failure: the colour misses on case, the fallback grabs the OLDEST
       row for that size in any colour, and a sold-out colourway answers for the
       one the shopper is holding.
       This is the case a single-fault test would have missed. */
    const reported = await attempt({
      sizeRows: [
        { size: 'M', color_name: 'black', stock_quantity: 0 },
        { size: 'M', color_name: 'yellow', stock_quantity: 1 },
      ],
      colorName: 'Yellow',
    });
    ok('the last one left, in a cart whose colour differs only by case', reported === null, reported);
  }

  console.log('\n  one colourway selling out does not close the others');
  {
    /* The old fallback took the OLDEST row for the size in ANY colour when the
       colour missed, so a sold-out colourway could speak for a stocked one. */
    const err = await attempt({
      sizeRows: [
        { size: 'M', color_name: 'black', stock_quantity: 0 },
        { size: 'M', color_name: 'yellow', stock_quantity: 5 },
      ],
      colorName: 'yellow',
    });
    ok('a sold-out colour does not block a stocked one', err === null, err);

    /* And the same wrongness in the direction that costs money rather than a
       sale: a stocked colour must not vouch for an empty one. */
    const over = await attempt({
      sizeRows: [
        { size: 'M', color_name: 'yellow', stock_quantity: 5 },
        { size: 'M', color_name: 'black', stock_quantity: 0 },
      ],
      colorName: 'black',
    });
    ok('a stocked colour does not let an empty one oversell', /out of stock/i.test(over || ''), over);
  }

  console.log('\n  rows are summed, not sampled');
  {
    // limit=1 read one row where the page sums them.
    const err = await attempt({
      sizeRows: [
        { size: 'M', color_name: 'yellow', stock_quantity: 1 },
        { size: 'M', color_name: 'yellow', stock_quantity: 1 },
      ],
      colorName: 'yellow', quantity: 2,
    });
    ok('stock split across rows adds up', err === null, err);
  }

  console.log('\n  size labels fold the way the page folds them');
  {
    // The button renders XXL; the inventory row says 2XL.
    const err = await attempt({ sizeRows: [{ size: '2XL', color_name: 'yellow', stock_quantity: 2 }], size: 'XXL', colorName: 'yellow' });
    ok('XXL finds the 2XL row', err === null, err);
  }

  console.log('\n  absent inventory is not the same as empty inventory');
  {
    /* No rows configured at all — the page enables Add to Bag here, so refusing
       would block a sale the store never said was limited. */
    const none = await attempt({ sizeRows: [], colorName: 'yellow' });
    ok('a product with no inventory rows can still be bought', none === null, none);

    /* Rows exist and none match: the colourway genuinely is not stocked. This
       must block, or "unknown" becomes a way to oversell. */
    const missing = await attempt({ sizeRows: [{ size: 'L', color_name: 'yellow', stock_quantity: 4 }], size: 'M', colorName: 'yellow' });
    ok('a size with no row of its own is refused', /out of stock/i.test(missing || ''), missing);
  }

  /* ── never charge more than was shown ────────────────────────────────────
     The bag showed $35 and this path charged $40: the bag had applied member
     pricing, the server had not because the token did not verify, and nothing
     compared the two. The shopper was billed a figure they were never quoted.

     PRODUCT is priced at $40.00 in these fixtures, so "shown 35" is exactly
     that bug and "shown 40" is the ordinary case. */
  console.log('\n  the shopper is never billed above the price they were shown');
  {
    const rows = [{ size: 'M', color_name: 'yellow', stock_quantity: 5 }];

    const agreed = await attempt({ sizeRows: rows, colorName: 'yellow', shownPrice: '40.00' });
    ok('a cart quoting the real price goes through', agreed === null, agreed);

    const under = await attempt({ sizeRows: rows, colorName: 'yellow', shownPrice: '35.00' });
    ok('a cart quoting less than we would charge is refused',
      /price .* has changed/i.test(under || ''), under);

    /* The other direction is not an error. Charging BELOW what was displayed
       harms nobody, and refusing would turn every price cut into an outage. */
    const over = await attempt({ sizeRows: rows, colorName: 'yellow', shownPrice: '50.00' });
    ok('a cart quoting more than we charge still goes through, at our price', over === null, over);

    /* Not exploitable: the charge is always the server's figure, so understating
       the display buys a refusal rather than a discount. */
    const tiny = await attempt({ sizeRows: rows, colorName: 'yellow', shownPrice: '0.01' });
    ok('a forged low price earns a refusal, not a cheap order',
      /price .* has changed/i.test(tiny || ''), tiny);

    /* A cart line with no price at all predates this field. It must still be
       sellable, or every bag saved before the change breaks. */
    const legacy = await attempt({ sizeRows: rows, colorName: 'yellow' });
    ok('a cart line carrying no price is not blocked by the check', legacy === null, legacy);
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('harness failed:', e); process.exit(1); });
