/* A gift card cannot be worth more than what was paid for it.
 *
 * ── THE DOOR THIS CLOSES ────────────────────────────────────────────────────
 *
 * Issuing a gift card from the Coupons page is guarded five ways: REFUND_SECRET
 * (an environment variable, deliberately with no reset button in the panel), a
 * five-strike lockout, a per-admin daily cap, a refusal to issue to yourself,
 * and an audit row for the attempt whether it succeeds or not.
 *
 * Creating a gift card PRODUCT is guarded by none of those, and it does not need
 * to be — except that face value and price are two different numbers. Put $500
 * of face value on a $5 product, buy it, and you are $495 ahead. That is the
 * same theft the issue endpoint refuses, arriving through a door with no guard
 * on it, and it needs no admin privileges beyond editing the catalogue.
 *
 * ── WHY A CLAMP AT THE TILL AND NOT A CHECK CONSTRAINT ──────────────────────
 *
 * `check (gift_card_cents <= current_price * 100)` looks like the tidier answer
 * and is the wrong one: it is comparing against a column that is not what gets
 * charged. Price lists (0022), effective dates, per-colourway prices (0021) and
 * member pricing all mean the charged amount is decided at the till. A
 * constraint that passes in the row and fails in the cart is a guard that
 * reports success while the money leaves.
 *
 * So it is enforced where the real number is known, and it CLAMPS rather than
 * refusing: a card that issues $5 for $5 is an admin mistake somebody notices,
 * while a checkout that fails is a customer punished for it. Prevention lives
 * in the form, which warns at the moment the number is typed.
 */
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { readAdmin } = require('./_admin-markup.js');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const ENV = {
  SUPABASE_URL: 'https://db.example',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
};

/** Answer just enough of PostgREST for resolveCatalogItems. */
function net(product) {
  return async (url) => {
    const u = String(url);
    const reply = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    });
    if (u.includes('/rest/v1/products?select=*')) return reply([product]);
    if (u.includes('/rest/v1/product_sizes')) {
      return reply([{ product_id: product.id, size: 'ONE', stock_quantity: 99, color_name: null }]);
    }
    /* The pricing tables are absent on a store that has not run 0022, and the
       catalogue price is the documented fallback. Same 404 the CI log shows. */
    if (u.includes('price_lists') || u.includes('/rest/v1/prices')) return reply({}, 404);
    return reply([]);
  };
}

const CARD = (giftCardCents, priceDollars) => ({
  id: '00000000-0000-0000-0000-0000000000aa',
  sku: 'ZW-GIFT', title: 'Gift Card', status: 'live',
  msrp: priceDollars, current_price: priceDollars,
  tax_category: 'exempt',
  shipping_weight_lb: 0.5,           // deliberately wrong, to prove it is ignored
  gift_card_cents: giftCardCents,
});

async function resolveOne(product) {
  const real = globalThis.fetch;
  globalThis.fetch = net(product);
  try {
    const CP = await import(pathToFileURL(path.join(ROOT, 'functions/api/_cart-pricing.js')).href);
    const out = await CP.resolveCatalogItems(
      [{ productId: product.id, size: 'ONE', quantity: 1 }], ENV, false, false,
    );
    return out[0];
  } finally { globalThis.fetch = real; }
}

(async () => {
  console.log('\n  what the till issues, against what the form was told\n');

  {
    const line = await resolveOne(CARD(5000, 50));
    ok('a $50 card sold for $50 is worth $50',
      line.giftCardCents === 5000, 'got ' + line.giftCardCents);
    ok('…and it is priced at $50', line.amount === 5000, 'got ' + line.amount);
  }

  {
    /* The attack, exactly: $500 of face value typed onto a $5 product. */
    const line = await resolveOne(CARD(50000, 5));
    ok('a $500 card sold for $5 is worth $5, not $500',
      line.giftCardCents === 500,
      'got ' + line.giftCardCents + ' — this is the whole mint, in one number');
    ok('…and it is still a gift card, so the exclusions still apply',
      line.giftCardCents > 0,
      'clamping must not quietly turn it into a taxable, shippable product');
  }

  {
    const line = await resolveOne(CARD(2500, 40));
    ok('a card worth less than its price is left alone',
      line.giftCardCents === 2500,
      'the clamp is a ceiling, not a rewrite — selling $25 of credit for $40 is a store’s own business');
  }

  {
    const line = await resolveOne({ ...CARD(null, 35), sku: 'ZW-TEE', title: 'Tee' });
    ok('an ordinary product is not a gift card',
      !line.giftCardCents, 'got ' + line.giftCardCents);
  }

  console.log('\n  and a card is not a parcel');

  {
    const line = await resolveOne(CARD(5000, 50));
    ok('the shipping weight on a gift card is discarded',
      Number(line.shippingWeightLb) === 0,
      'a cart of ten cards must not be quoted for a 5lb box that does not exist');
  }

  console.log('\n  the form that creates one');

  {
    const doc = readAdmin();
    const admin = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8').replace(/\r\n/g, '\n');

    ok('there is a control for it at all',
      !!doc.ids.isGiftCard && !!doc.ids.giftCardValue,
      'gift_card_cents shipped with no way to set it — the column existed for days with no UI');

    ok('…on the Pricing tab, where it changes what every field below it means',
      doc.isInside('isGiftCard', 'tab-pricing') && doc.isInside('giftCardValue', 'tab-pricing'),
      doc.whereIs('isGiftCard'));

    ok('tax is forced to exempt, because the database refuses anything else',
      /if \(_isGiftCardChecked\(\)\) return 'exempt';/.test(admin),
      'migration 0032 has a check constraint; an admin should meet it as a sentence, not a violation');

    ok('…and the control is locked rather than merely set',
      /tax\.value = 'exempt'; tax\.disabled = true;/.test(admin));

    ok('the form warns when the card is worth more than it costs',
      /This card is worth more than it costs/.test(admin),
      'the till will refuse to mint it, but the customer would get less than the page promised');

    ok('a gift card is not asked for a shipping weight',
      /\.concat\(isGiftCard \? \['giftCardValue'\] : \['shippingWeightLb'\]\)/.test(admin),
      'a code in an email has no weight, and a made-up one drags a parcel estimate into a cart with no parcel');

    /* The column is new. PostgREST rejects an entire row for one unknown field,
       so writing it unconditionally would break saving EVERY product on a store
       that has not run 0032 — the exact failure that once took out fulfilment. */
    ok('the new column is only written when the save is about a gift card',
      /\.\.\.\(_giftCardTouched\(\) \? \{ gift_card_cents: _giftCardCentsFromForm\(\) \} : \{\}\)/.test(admin),
      'otherwise a store that has not run 0032 cannot save any product at all');

    ok('…and unticking the box can still write the NULL back',
      /currentProduct\.gift_card_cents != null/.test(admin),
      'a row that already carries a value has to be able to stop being a gift card');

    ok('opening a new product resets the panel',
      /document\.getElementById\('productForm'\)\.reset\(\);\n\s*\/\*[\s\S]{0,400}?\*\/\n\s*syncGiftCardFields\(\);/.test(admin),
      'form.reset() unticks the box but leaves the fields shown and the tax control locked');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
