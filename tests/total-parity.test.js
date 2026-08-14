/* The number on the screen and the number on the card, for the same cart.
 *
 * Three separate times a shopper has been shown one total and charged another,
 * and each time the fix was to one side of the comparison:
 *
 *   $35 in the bag, $40 at checkout   the two sides asked different questions
 *                                     about membership (member-price-agrees)
 *   a total before shipping resolved  the client printed a sum missing a part
 *                                     (total-waits)
 *   7.0% vs 7.8% tax                  the client had its own rate table
 *                                     (checkout-tax)
 *
 * Every one of those has a test now, and every one of those tests checks ONE
 * side. That is why all three reached a customer: nothing in the suite ever put
 * the rendered figure next to the charged figure and demanded they match. This
 * file is the missing half — step 4 of the checkout-price-display plan, and the
 * only one of the four that catches the NEXT divergence rather than the three
 * already found.
 *
 * ── WHAT IS ACTUALLY UNDER TEST ─────────────────────────────────────────────
 *
 * Both sides are given the same inputs, and both are the REAL code:
 *
 *   server   quoteCart() from _cart-pricing.js — the function that decides the
 *            charge — against a faked catalogue.
 *   client   renderSummaryTotals() lifted out of checkout.js and run against a
 *            DOM small enough to read back.
 *
 * So the subject is the ASSEMBLY, and the reason that is worth a file of its
 * own is arithmetic: the server works in integer cents, and the client adds
 * floats read out of the DOM as text and calls toFixed(2). Those two agree
 * almost always, which is precisely what makes the disagreements expensive —
 * they turn up on one cart in a few hundred, as a penny, in production.
 *
 * The carts below are chosen for that: prices ending in .99, quantities that
 * make thirds, a tax rate with no exact binary representation, a free-shipping
 * threshold landing exactly on the boundary.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const JS = fs.readFileSync(path.join(ROOT, 'checkout.js'), 'utf8');

/* ── the client half ───────────────────────────────────────────────────────
   Anchored on the function names rather than on surrounding lines, so a change
   near them fails an assertion rather than crashing the suite. */
function clientTotal({ subtotalDollars, taxDollars, shipDollars, taxKnown = true, promo = null }) {
  const els = {};
  const mk = (id) => {
    const classes = new Set();
    return {
      id, textContent: '—',
      classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } },
      _classes: classes,
    };
  };
  for (const id of ['pm-subtotal', 'pm-tax', 'pm-shipping', 'pm-total', 'pm-toggle-total', 'pm-tax-label']) els[id] = mk(id);
  els['pm-subtotal'].textContent = '$' + subtotalDollars.toFixed(2);

  const _pay = { taxEl: mk('tax'), shippingEl: mk('ship'), totalEl: mk('total'),
                 stateInput: { value: 'OH' }, zipInput: { value: '45202' } };
  const window_ = {
    ZWCheckoutTax: {
      isKnown: () => taxKnown,
      /* The server's own figure, handed back. checkout-tax.js gets this from
         /api/tax-quote, which calls the same resolveTax() the charge does — so
         feeding it here keeps the SUBJECT of this test the assembly, not a
         second copy of the tax logic. */
      taxDollars: () => taxDollars,
      stateFor: () => 'OH',
      ensure: () => {},
    },
  };
  const document_ = { getElementById: (id) => els[id] || null };

  const rStart = JS.indexOf('function renderSummaryTotals()');
  const uStart = JS.indexOf('function updateCartSummaryShipping(amount)');
  const src = 'let _shipDollars = null;\n'
    + JS.slice(rStart, uStart)
    + JS.slice(uStart, JS.indexOf('\n}', uStart) + 2);
  const api = new Function('document', 'window', '_pay', src +
    ';return { render: renderSummaryTotals, ship: updateCartSummaryShipping };')(document_, window_, _pay);

  api.ship(shipDollars);            // shipping resolves, then the total is drawn

  /* THE THIRD WRITER. checkout.js draws the total and then calls this, which
     reassembles it from scratch — subtotal from the cart, tax and shipping read
     back out of the DOM as rendered text. It is where the "up, down, up again"
     bug lived, and leaving it out of a parity test would mean testing an
     assembler no shopper actually sees the output of. */
  if (promo) {
    const HTML = fs.readFileSync(path.join(ROOT, 'checkout.html'), 'utf8');
    const s = HTML.indexOf('window.zwPromoUpdateSummaryTotals = function()');
    const e = HTML.indexOf('\n};', s) + 3;
    const w = { cartItems: promo.cartItems, _zwActivePromo: { discount: promo.discountDollars } };
    /* The real one reads .dash to know whether a part is still pending, so the
       harness elements have to answer contains() as well as toggle(). */
    const doc = {
      getElementById: (id) => {
        const el = els[id];
        if (!el) return null;
        if (!el.classList.contains) el.classList.contains = (c) => el._classes.has(c);
        return el;
      },
    };
    new Function('window', 'document', HTML.slice(s, e) + '\nwindow.zwPromoUpdateSummaryTotals();')(w, doc);
  }

  return els['pm-total'].textContent;
}

/* ── the server half ───────────────────────────────────────────────────────
   Only the reads quoteCart makes.
   IT HONOURS THE FILTER, and that is not a detail. The first version of this
   returned the whole catalogue for every `id=eq.…` query, so resolveCatalogItems
   took row [0] and EVERY cart priced as the same product. All six cases passed:
   a $19.99 cart and a $149.50 cart both totalled $29.39, and the assertion —
   client equals server — was true, because both sides were reading one wrong
   quote. A fake that ignores the query does not fake the database, it fakes
   agreement. */
function net(products, sizes) {
  const filterOf = (u, field) => {
    const m = new RegExp('[?&]' + field + '=eq\\.([^&]+)').exec(u);
    return m ? decodeURIComponent(m[1]) : null;
  };
  return async (url) => {
    const u = String(url);
    let payload;

    if (u.includes('/rest/v1/products')) {
      const id = filterOf(u, 'id'), sku = filterOf(u, 'sku');
      payload = products.filter((p) => (id ? p.id === id : true) && (sku ? p.sku === sku : true));
    } else if (u.includes('/rest/v1/product_sizes')) {
      const pid = filterOf(u, 'product_id');
      payload = sizes.filter((s) => (pid ? s.product_id === pid : true));
    } else if (u.includes('/rest/v1/site_settings')) {
      /* Promotions live in commerce_config, not in a table — see the promo
         carts below. Everything else this asks site_settings for legitimately
         has no rows here. */
      payload = u.includes('key=eq.commerce_config')
        ? [{ value: { promotions: PROMOTIONS } }]
        : [];
    } else if (u.includes('/rest/v1/color_variants') || u.includes('/rest/v1/product_images')
               || u.includes('/rest/v1/tax_exemptions')) {
      payload = [];
    } else {
      /* Unrouted comes back 404 rather than as an empty array, so a read this
         harness does not know about surfaces as a wrong number instead of
         silently as a zero. */
      payload = { error: 'unrouted: ' + u };
    }

    const routed = !payload || !payload.error;
    const text = JSON.stringify(payload);
    return { ok: routed, status: routed ? 200 : 404, json: async () => JSON.parse(text), text: async () => text,
             headers: { get: () => null } };
  };
}

const ADDRESS = {
  name: 'Jane Smith', email: 'jane@example.com',
  line1: '123 Main St', line2: '', city: 'Cincinnati',
  state: 'OH', zip: '45202', country: 'US',
};

/* Prices picked to be awkward in binary: .99 and .95 endings, and quantities
   that produce subtotals whose tax has a long decimal tail. */
const CATALOG = [
  { id: 'p-99',  sku: 'ZW-99',  title: 'Nine Nine',  price: 19.99, active: true, tax_category: 'clothing' },
  { id: 'p-95',  sku: 'ZW-95',  title: 'Ninety Five', price: 34.95, active: true, tax_category: 'clothing' },
  { id: 'p-33',  sku: 'ZW-33',  title: 'Thirds',      price: 33.33, active: true, tax_category: 'clothing' },
  { id: 'p-big', sku: 'ZW-BIG', title: 'Over Free Shipping', price: 149.50, active: true, tax_category: 'clothing' },
];
const SIZES = CATALOG.map((p, i) => ({
  id: 'ps-' + i, product_id: p.id, size: 'M', stock_quantity: 99, color_name: 'Black',
}));

/* A percentage and a fixed amount, because they round differently: 15% of an
   odd subtotal has a decimal tail, and a flat $10 does not. */
/* maxUsage null, not 0. Zero means "already at its limit" — getPromotionForCode
   tests `used >= max`, so 0 >= 0 rejects the code. Written as 0 first, and the
   result was three promo carts totalling exactly the same as their non-promo
   twins with the parity assertion still green, because no discount was applied
   on EITHER side. */
const PROMOTIONS = [
  { code: 'FIFTEEN', type: 'percent', value: 15, active: true, usageCount: 0, maxUsage: null },
  { code: 'TENOFF',  type: 'fixed',   value: 10, active: true, usageCount: 0, maxUsage: null },
];

const CARTS = [
  ['one item, .99 price',        [{ productId: 'p-99',  quantity: 1, price: 19.99 }], ''],
  ['three of a .99 price',       [{ productId: 'p-99',  quantity: 3, price: 19.99 }], ''],
  ['thirds, seven of them',      [{ productId: 'p-33',  quantity: 7, price: 33.33 }], ''],
  ['two products, mixed cents',  [{ productId: 'p-99',  quantity: 2, price: 19.99 },
                                  { productId: 'p-95',  quantity: 1, price: 34.95 }], ''],
  ['over the free-ship line',    [{ productId: 'p-big', quantity: 1, price: 149.50 }], ''],
  ['a long cart',                [{ productId: 'p-99',  quantity: 4, price: 19.99 },
                                  { productId: 'p-95',  quantity: 3, price: 34.95 },
                                  { productId: 'p-33',  quantity: 2, price: 33.33 }], ''],
  /* With a discount the client runs a THIRD assembler over the top of the
     other two, and it recomputes the subtotal itself. */
  ['15% off an odd subtotal',    [{ productId: 'p-33',  quantity: 7, price: 33.33 }], 'FIFTEEN'],
  ['15% off a .99 cart',         [{ productId: 'p-99',  quantity: 3, price: 19.99 }], 'FIFTEEN'],
  ['$10 off a mixed cart',       [{ productId: 'p-99',  quantity: 2, price: 19.99 },
                                  { productId: 'p-95',  quantity: 1, price: 34.95 }], 'TENOFF'],
];

(async () => {
  const CP = await import(pathToFileURL(path.join(ROOT, 'functions/api/_cart-pricing.js')).href);
  const realFetch = globalThis.fetch;

  console.log('\n  the screen and the card agree\n');

  console.log('  every cart, priced by both sides');
  let worst = 0, worstName = '';
  for (const [name, items, promoCode] of CARTS) {
    globalThis.fetch = net(CATALOG, SIZES);
    let quote;
    try {
      quote = await CP.quoteCart({
        items: items.map((i) => ({ ...i, size: 'M', colorName: 'Black' })),
        address: ADDRESS, shippingRate: null, promoCode,
        deliveryMethod: 'hand_delivery',   // a fixed, known shipping figure
        env: { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SITE_URL: 'https://zuwera.store' },
        request: new Request('https://zuwera.store/api/create-payment-intent', { method: 'POST' }),
      });
    } finally { globalThis.fetch = realFetch; }

    const shown = clientTotal({
      subtotalDollars: quote.subtotalCents / 100,
      taxDollars:      quote.taxCents / 100,
      shipDollars:     quote.shipping.shippingCents / 100,
      promo: promoCode ? {
        /* The cart as the BROWSER holds it — the promo assembler recomputes the
           subtotal from these rather than reading the rendered one. */
        cartItems: items.map((i) => ({ price: i.price, quantity: i.quantity })),
        discountDollars: quote.discountCents / 100,
      } : null,
    });
    const charged = '$' + (quote.totalCents / 100).toFixed(2);

    const shownCents = Math.round(parseFloat(shown.replace(/[^0-9.]/g, '')) * 100);
    const drift = Math.abs(shownCents - quote.totalCents);
    if (drift > worst) { worst = drift; worstName = name; }

    ok(name + ' — shown ' + shown + ', charged ' + charged, shown === charged,
      'the shopper reads the first and pays the second');
  }
  ok('no cart drifts by even one cent', worst === 0,
    'worst was ' + worst + 'c on "' + worstName + '" — a penny is how this class of bug always presents');

  console.log('\n  the parts add up to the whole, on the server');
  {
    globalThis.fetch = net(CATALOG, SIZES);
    let q;
    try {
      q = await CP.quoteCart({
        /* A DISCOUNTED cart deliberately: with promoCode '' the discount term
           is zero and the identity below holds no matter what the code does
           with it. */
        items: [{ productId: 'p-99', size: 'M', colorName: 'Black', quantity: 3, price: 19.99 }],
        address: ADDRESS, shippingRate: null, promoCode: 'FIFTEEN', deliveryMethod: 'hand_delivery',
        env: { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SITE_URL: 'https://zuwera.store' },
        request: new Request('https://zuwera.store/api/create-payment-intent', { method: 'POST' }),
      });
    } finally { globalThis.fetch = realFetch; }

    /* Not a tautology: it asserts the total is the SUM of the four figures the
       shopper is shown, rather than a fifth number computed separately. A total
       that is right but not equal to its own displayed parts is the bug this
       whole plan started with. */
    ok('total = subtotal − discount + shipping + tax',
      q.totalCents === q.subtotalCents - q.discountCents + q.shipping.shippingCents + q.taxCents,
      [q.totalCents, q.subtotalCents, q.discountCents, q.shipping.shippingCents, q.taxCents].join(' / '));
    ok('…and the discount is actually non-zero, so that identity means something',
      q.discountCents > 0,
      'a zero discount makes the assertion above true whatever the discount code does');
    ok('every component is an integer number of cents',
      [q.subtotalCents, q.discountCents, q.shipping.shippingCents, q.taxCents, q.totalCents]
        .every((n) => Number.isInteger(n)),
      'a fractional cent means someone multiplied dollars by a rate and did not round');
  }

  console.log('\n  an incomplete quote is never rendered as a total');
  {
    /* The guard from total-waits, re-asserted HERE because this file is the one
       that would otherwise be satisfied by a client that always prints a
       number. Parity between a shown figure and a charged figure is worth
       nothing if the shown figure appears before it is known. */
    const pending = clientTotal({ subtotalDollars: 59.97, taxDollars: 4.68, shipDollars: 0, taxKnown: false });
    ok('tax not yet known keeps the total a dash', pending === '—',
      'a total missing a part must not look like the final one');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
