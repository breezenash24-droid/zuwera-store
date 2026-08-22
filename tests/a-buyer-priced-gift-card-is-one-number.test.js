/* The buyer names the amount, and it becomes BOTH numbers.
 *
 * ── WHY THIS NEEDED ITS OWN FILE ────────────────────────────────────────────
 *
 * A custom gift card amount cuts straight against the rule the rest of the
 * pricing code is built on. Face value is read from the catalogue, never from
 * the cart, with the comment: "a browser that could name the face value could
 * name a larger one." A "choose your own amount" box is, literally, the browser
 * naming the face value.
 *
 * It is safe for exactly one reason, and if that reason ever stops being true
 * the feature becomes a mint:
 *
 *     THE CHOSEN AMOUNT IS THE PRICE *AND* THE FACE VALUE, COMPUTED FROM ONE
 *     INPUT, ON THE SERVER.
 *
 * Pick $73, pay $73, receive $73. There is no pair to put out of step, so there
 * is no arbitrage — the clamp that stops an admin minting money (face ≤ price)
 * holds trivially because the two are the same number.
 *
 * What the server must NEVER do is accept a price and a face value separately.
 * That is the $500-card-for-$5 hole wearing a customer's clothes instead of an
 * admin's, and it would be reachable by anyone with a browser rather than
 * needing catalogue access.
 *
 * ── AND WHY IT IS BOUNDED ───────────────────────────────────────────────────
 *
 * An unbounded amount is one typo away from a $50,000 card. It is also the
 * ideal instrument for laundering a stolen card, because a gift card turns into
 * money immediately and does not need an address to receive.
 */
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

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
};

async function resolve(product, raw, policy) {
  const real = globalThis.fetch;
  globalThis.fetch = net(product);
  try {
    const CP = await import(pathToFileURL(path.join(ROOT, 'functions/api/_cart-pricing.js')).href);
    const out = await CP.resolveCatalogItems(
      [{ productId: product.id, quantity: 1, ...raw }],
      ENV, false, false, undefined, false,
      policy || CP.giftCardPolicy({ giftCards: { customAmounts: true, minCents: 1000, maxCents: 50000 } }),
    );
    return out[0];
  } finally { globalThis.fetch = real; }
}

(async () => {
  const CP = await import(pathToFileURL(path.join(ROOT, 'functions/api/_cart-pricing.js')).href);

  console.log('\n  the amount the buyer chose is the amount they get\n');

  {
    const line = await resolve(CARD, { customAmountCents: 7300, price: 73 });
    ok('a $73 choice is charged $73', line.amount === 7300, 'got ' + line.amount);
    ok('…and the card is worth $73, not the listed $50',
      line.giftCardCents === 7300,
      'got ' + line.giftCardCents + ' — taking the catalogue figure here charges $73 and issues $50');
    ok('the two are the same number', line.amount === line.giftCardCents);
  }

  {
    /* Below the listed price is just as important: a $20 choice on a $50 card
       must not charge $20 and issue $50. */
    const line = await resolve(CARD, { customAmountCents: 2000, price: 20 });
    ok('a $20 choice issues $20, not the listed $50',
      line.amount === 2000 && line.giftCardCents === 2000,
      'amount ' + line.amount + ', face ' + line.giftCardCents);
  }

  console.log('\n  and it is bounded');

  {
    const line = await resolve(CARD, { customAmountCents: 5000000, price: 50000 });
    ok('an absurd amount is clamped to the ceiling',
      line.amount === 50000 && line.giftCardCents === 50000,
      'amount ' + line.amount + ', face ' + line.giftCardCents);
  }

  {
    /* The ceiling clamps, the floor REFUSES — and the asymmetry is the point.
       Clamping down charges less than the page displayed, which is always
       allowed. Clamping UP charges more, which the price guard then rejects as
       a price change — telling a shopper their price had changed when what had
       happened was that we quietly rewrote their instruction. */
    let refused = '';
    try {
      await resolve(CARD, { customAmountCents: 1, price: 0.01 });
    } catch (e) { refused = (e && e.message) || ''; }
    ok('…and a trivial one is refused, not silently raised',
      /smallest gift card/i.test(refused),
      refused ? 'got: ' + refused : 'it was accepted, which means somebody was charged above what they were shown');
  }

  console.log('\n  it does nothing at all unless the store switched it on');

  {
    const off = CP.giftCardPolicy({});
    ok('the shipped default is OFF',
      off.customAmounts === false,
      'an unread setting must never become permission for a customer to name a price');

    const line = await resolve(CARD, { customAmountCents: 500000, price: 5000 }, off);
    ok('…and with it off, the catalogue price stands',
      line.amount === 5000 && line.giftCardCents === 5000,
      'amount ' + line.amount + ', face ' + line.giftCardCents);
  }

  {
    /* The rule that matters most: this is for gift cards and nothing else. On
       an ordinary product a customer-supplied price is simply theft. */
    const tee = { ...CARD, sku: 'ZW-TEE', gift_card_cents: null, tax_category: 'clothing' };
    /* The displayed price is honest here, so the price guard has nothing to say
       and the only question is whether customAmountCents did anything. It must
       not: it is ignored entirely, and the shirt costs what the shirt costs. */
    const line = await resolve(tee, { customAmountCents: 100, price: 50 });
    ok('a customer cannot price a T-SHIRT',
      line.amount === 5000,
      'got ' + line.amount + ' — a customer-named price on a garment is theft');
    ok('…and it is not a gift card either', !line.giftCardCents);
  }

  console.log('\n  bounds that are typed backwards still mean something');

  {
    const p = CP.giftCardPolicy({ giftCards: { customAmounts: true, minCents: 50000, maxCents: 1000 } });
    ok('a reversed min and max are swapped, not obeyed',
      p.minCents === 1000 && p.maxCents === 50000,
      'a backwards bound clamps everything to nothing, and a checkout issuing $0 cards is worse than reading the intent');
  }

  console.log('\n  the browser sends the amount, never a face value');

  {
    const pm = fs.readFileSync(path.join(ROOT, 'product-main.js'), 'utf8').replace(/\r\n/g, '\n');
    ok('the cart line carries customAmountCents',
      /customAmountCents: _gcCustomCents/.test(pm));
    ok('…and never a client-side face value',
      !/giftCardCents: _gcCustomCents/.test(pm),
      'a price and a face value sent separately is the whole hole');

    /* The till refuses to charge more than the cart says it displayed, so a
       line still claiming $50 against a $73 card is rejected as a price change
       — the guard doing its job against the one case where the higher figure
       is the shopper's own instruction. */
    ok('the displayed price follows the chosen amount',
      /price: _gcCustomCents > 0 \? \(_gcCustomCents \/ 100\) : effectivePrice/.test(pm),
      'otherwise checkoutPriceChanged refuses the order');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✗ suite crashed: ' + e.stack); process.exit(1); });
