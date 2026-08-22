/* One card, several amounts — and the amount surviving all the way to the bag.
 *
 * ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
 *
 * Migration 0032 said denominations should be separate product rows, and that
 * was true and cheap until a gift card page also had to hold a buyer-chosen
 * amount. Four rows means four SKUs, four photo sets, four review threads for
 * one thing, and a shopper going BACK to the collection to change their mind
 * about $50. 0035 puts the amounts on the card.
 *
 * A denomination is NOT a customer naming a price. It is the store naming
 * several, on the product row, the same place the single price has always come
 * from — so it is honoured whether or not free entry is switched on, and it is
 * not subject to the free-entry bounds.
 *
 * ── AND THE THREE PLACES THE CHOSEN AMOUNT USED TO DIE ───────────────────────
 *
 *   1. The price on the product page. paintGiftCardAmount() wrote to
 *      #productPrice, which this page does not have — so $300 was chosen and
 *      $50 stayed on screen. Covered in price-display.test.js.
 *   2. The bag. checkout.js reprices every line against the catalogue, which is
 *      right for every line but the one whose price IS the buyer's instruction.
 *   3. The merge key. A $25 card and a $300 card are the same product, the same
 *      (empty) size and the same colour, so the second add found the first and
 *      made two of it.
 */
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const ENV = { SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_ROLE_KEY: 'k' };

function net(product) {
  return async (url) => {
    const u = String(url);
    const reply = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    });
    if (u.includes('/rest/v1/products?select=*')) return reply([product]);
    if (u.includes('/rest/v1/product_sizes')) return reply([]);
    if (u.includes('price_lists') || u.includes('/rest/v1/prices')) return reply({}, 404);
    return reply([]);
  };
}

const CARD = {
  id: '00000000-0000-0000-0000-0000000000aa',
  sku: 'ZW-GC-001', title: 'Gift Card', status: 'live',
  msrp: 50, current_price: 50, tax_category: 'exempt',
  shipping_weight_lb: 0, gift_card_cents: 5000,
  gift_card_denominations: [2500, 5000, 7500, 10000],
};

async function resolve(product, raw, policy) {
  const real = globalThis.fetch;
  globalThis.fetch = net(product);
  try {
    const CP = await import(pathToFileURL(path.join(ROOT, 'functions/api/_cart-pricing.js')).href);
    const out = await CP.resolveCatalogItems(
      [{ productId: product.id, quantity: 1, ...raw }],
      ENV, false, false, undefined, false,
      policy || CP.giftCardPolicy({}),
    );
    return out[0];
  } finally { globalThis.fetch = real; }
}

(async () => {
  const CP = await import(pathToFileURL(path.join(ROOT, 'functions/api/_cart-pricing.js')).href);
  /* Free entry OFF, which is the shipped default and the whole point: a chip is
     the STORE's amount and must work without switching on a box that lets
     strangers type figures. */
  const OFF = CP.giftCardPolicy({});

  console.log('\n  the amounts the store itself offers\n');

  {
    const line = await resolve(CARD, { customAmountCents: 10000, price: 100 }, OFF);
    ok('a $100 chip is charged $100 with free entry OFF',
      line.amount === 10000,
      'got ' + line.amount + ' — the store listed this amount itself; it needs no permission to type');
    ok('…and the card is worth $100, not the listed $50',
      line.giftCardCents === 10000,
      'got ' + line.giftCardCents + ' — taking the catalogue figure charges $100 and issues $50');
    ok('the two are one number', line.amount === line.giftCardCents);
  }

  {
    /* $250 is above the shipped $500 ceiling? No — below it, so pick one that
       is above: the bounds cap what a BUYER TYPES, and a store's own list is
       not typing. */
    const big = { ...CARD, gift_card_denominations: [100000] };
    const line = await resolve(big, { customAmountCents: 100000, price: 1000 }, OFF);
    ok('a $1,000 chip is not capped by the free-entry ceiling',
      line.amount === 100000 && line.giftCardCents === 100000,
      'amount ' + line.amount + ' — refusing a store its own card because typing is capped '
      + 'would be the setting arguing with the shopkeeper');
  }

  {
    /* A near miss is a stale or edited cart, not a rounding question. */
    const line = await resolve(CARD, { customAmountCents: 9900, price: 50 }, OFF);
    ok('an amount that is not on the list falls back to the listed price',
      line.amount === 5000 && line.giftCardCents === 5000,
      'amount ' + line.amount + ' — clamping to the nearest chip charges a number nobody chose');
  }

  {
    const plain = { ...CARD, gift_card_denominations: [] };
    const line = await resolve(plain, { customAmountCents: 10000, price: 100 }, OFF);
    ok('no list means the card sells at its listed price',
      line.amount === 5000,
      'got ' + line.amount + ' — an empty list must not become permission to name a price');
  }

  {
    /* The state every store is in before 0035 has been run: the column is not
       in the row at all. It must behave exactly as it did yesterday. */
    const before = { ...CARD };
    delete before.gift_card_denominations;
    const line = await resolve(before, { customAmountCents: 10000, price: 100 }, OFF);
    ok('a store that has not run 0035 is unaffected',
      line.amount === 5000 && line.giftCardCents === 5000);
  }

  {
    /* The rule that matters most, restated for this path: it is for gift cards
       and nothing else. Denominations on a T-shirt are ignored outright. */
    const tee = { ...CARD, sku: 'ZW-TEE', gift_card_cents: null, tax_category: 'clothing' };
    const line = await resolve(tee, { customAmountCents: 2500, price: 50 }, OFF);
    ok('a customer cannot price a T-SHIRT through the chip path',
      line.amount === 5000,
      'got ' + line.amount + ' — a customer-named price on a garment is theft');
  }

  console.log('\n  and the amount survives the trip to the bag');

  {
    const co = read('checkout.js');
    /* The repricer's whole job is to correct a stale bag against the catalogue,
       and it is right about every line but this one. */
    ok('the repricer leaves a buyer-priced line alone',
      /if \(Number\(item\.customAmountCents\) > 0\) continue;/.test(co),
      'without it the listed $50 is written over the $300 the shopper asked for, '
      + 'in localStorage AND in window.cartItems, so every surface agrees on a '
      + 'number nobody chose');

    /* Placement, not just presence: after the product lookup (so a deleted
       product still short-circuits first) and before anything is written. */
    const skip = co.indexOf('if (Number(item.customAmountCents) > 0) continue;');
    const write = co.indexOf('if (parseFloat(item.price) !== next)');
    ok('…and it skips BEFORE the write, not after it',
      skip > -1 && write > -1 && skip < write);
  }

  {
    /* Three files add to the same bag. All three key a merge on what decides
       the price, or the one that forgets makes two of somebody's $25 card. */
    const sites = [
      ['product-main.js', read('product-main.js')],
      ['quick-add-modal.js', read('quick-add-modal.js')],
      ['drop001.html', read('drop001.html')],
    ];
    for (const [name, src] of sites) {
      const i = src.indexOf('cart.findIndex');
      const window_ = i > -1 ? src.slice(i, i + 600) : '';
      ok(name + ' keys the merge on the chosen amount',
        /customAmountCents/.test(window_),
        'a $25 card and a $300 card are the same product, size and colour — '
        + 'without the amount the second add lands on the first');
    }
  }

  console.log('\n  the browser sends the amount, never a face value');

  {
    const pm = read('product-main.js');
    ok('a chip sets the same field free entry sets',
      /_gcCustomCents = cents; paintGiftCardAmount\(\)/.test(pm),
      'a second field for "the chip they tapped" is a second thing to fall out of step');
    ok('…and the cart line still carries no client-side face value',
      !/giftCardCents: _gcCustomCents/.test(pm),
      'a price and a face value sent separately is the whole hole');
    ok('the denominations are read off the product, not off settings',
      /currentProduct && currentProduct\.gift_card_denominations/.test(pm),
      'a second settings read is a window in which the allowed set and the price '
      + 'it governs arrive out of step');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✗ suite crashed: ' + e.stack); process.exit(1); });
