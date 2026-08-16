/* Member pricing is a switch, and the switch reaches the till.
 *
 * "Can you make member pricing an option — a switch to just not have a
 *  different price for members?"
 *
 * ── THE ONLY WAY THIS FEATURE CAN BE WORSE THAN NOT HAVING IT ───────────────
 *
 * A switch that reaches one half of the store. Both halves answer "what does
 * this shopper pay", and they answer it in different files:
 *
 *   the page  /api/prices        → what the product page prints
 *   the till  quoteCart()        → what the card is charged
 *
 * Gate only the page and the member price disappears from view while checkout
 * goes on applying it. Gate only the till and the page advertises $25, checkout
 * charges $40, and the never-bill-above-the-quote guard turns that into a
 * refused sale — the store looking broken rather than the setting looking off.
 *
 * So the tests that matter are not "does the flag parse". They are: with the
 * switch in each position, do those two files produce the SAME number. Both are
 * run here, against one set of fake settings.
 *
 * ── AND THE DIRECTION OF THE DEFAULT ────────────────────────────────────────
 *
 * Absent means ON. Every store predates this setting and several have member
 * prices saved right now; reading a missing key as "off" would silently
 * withdraw a discount shoppers are being shown and being charged. An unreadable
 * settings row means the same thing.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const UI    = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(ROOT, 'admin-pricing.js'), 'utf8');
const PAGE  = require('./_product-source').all()  /* product.html + its extracted scripts — see _product-source.js */;
const HTML  = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');

const ENV = {
  SUPABASE_URL: 'https://db.test',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  SITE_URL: 'https://zuwera.store',
};

/* $40 normally, $25 to a member. The gap is the whole subject. */
const PID = '00000000-0000-4000-8000-000000000001';
const PRODUCT = {
  id: PID, sku: 'ZW-MTP-002', title: 'Aero Pro',
  price: 40, current_price: 40, member_price: 25, msrp: 40,
  active: true, tax_category: 'clothing',
};
const SIZES = [{ product_id: PID, size: 'M', stock_quantity: 10, color_name: '' }];

/* One fake database, shared by both halves — which is the point. `settings` is
   the commerce_config blob under test. */
function net(settings) {
  return async (url, opts) => {
    const u = String(url);
    let payload;

    if (u.includes('/auth/v1/user')) {
      const auth = (opts && opts.headers && opts.headers.Authorization) || '';
      if (!/Bearer\s+TOKEN/.test(auth)) return { ok: false, status: 401, json: async () => null };
      payload = { id: 'user-1', email: 'jane@example.com' };
    } else if (u.includes('/rest/v1/site_settings')) {
      payload = u.includes('key=eq.commerce_config') ? [{ value: settings }] : [];
    } else if (u.includes('/rest/v1/products')) {
      payload = [PRODUCT];
    } else if (u.includes('/rest/v1/product_sizes')) {
      payload = SIZES;
    } else if (u.includes('/rest/v1/prices') || u.includes('/rest/v1/price_lists')) {
      /* No price lists here on purpose: the member price under test is the one
         on the PRODUCT, which is where every store's member prices actually
         live today. The price-list member price has its own coverage. */
      payload = [];
    } else if (u.includes('/rest/v1/color_variants') || u.includes('/rest/v1/product_images')
               || u.includes('/rest/v1/tax_exemptions')) {
      payload = [];
    } else {
      /* Unrouted comes back 404 rather than as an empty array, so a read this
         harness does not know about surfaces as a wrong number rather than
         silently as a zero. */
      payload = { error: 'unrouted: ' + u };
    }

    const routed = !payload || !payload.error;
    const text = JSON.stringify(payload);
    return {
      ok: routed, status: routed ? 200 : 404,
      json: async () => JSON.parse(text), text: async () => text,
      headers: { get: () => null },
    };
  };
}

const ADDRESS = {
  name: 'Jane Smith', email: 'jane@example.com',
  line1: '123 Main St', line2: '', city: 'Cincinnati',
  state: 'OH', zip: '45202', country: 'US',
};

/* What the TILL would charge a signed-in shopper, in cents, for one unit. */
async function tillCents(settings) {
  const real = globalThis.fetch;
  globalThis.fetch = net(settings);
  try {
    const CP = await load('functions/api/_cart-pricing.js');
    const q = await CP.quoteCart({
      items: [{ productId: PID, size: 'M', quantity: 1 }],
      address: ADDRESS, shippingRate: null, promoCode: '',
      accessToken: 'TOKEN', env: ENV,
    });
    return { cents: q.catalogItems[0].amount, chargeAsMember: q.chargeAsMember, isMember: q.isMember };
  } finally { globalThis.fetch = real; }
}

/* What the PAGE would print to that same shopper. */
async function pageQuote(settings, signedIn) {
  const real = globalThis.fetch;
  globalThis.fetch = net(settings);
  try {
    const API = await load('functions/api/prices.js');
    const res = await API.onRequestGet({
      request: new Request('https://zuwera.store/api/prices?productId=' + PID, {
        headers: signedIn ? { Authorization: 'Bearer TOKEN' } : {},
      }),
      env: ENV,
    });
    return await res.json();
  } finally { globalThis.fetch = real; }
}

(async () => {
  const C = await load('functions/api/_commerce.js');

  console.log('\n  member pricing is a switch\n');

  console.log('  absent means ON, in every direction');
  {
    ok('nothing stored at all', C.sanitizeMemberPricing().enabled === true,
      'reading a missing key as "off" withdraws a discount shoppers are already being charged');
    ok('an empty object', C.sanitizeMemberPricing({}).enabled === true);
    ok('something that is not an object', C.sanitizeMemberPricing('yes').enabled === true);
    ok('and only an explicit false turns it off', C.sanitizeMemberPricing({ enabled: false }).enabled === false);
    ok('…while an explicit true is still true', C.sanitizeMemberPricing({ enabled: true }).enabled === true);
  }

  console.log('\n  the setting survives being saved');
  {
    /* sanitizeCommerceConfig is the only thing between the stored blob and
       everything that reads it, so a key it does not list is a setting that
       saves, reloads as absent, and quietly reverts to on. */
    /* Read defensively. If the key is dropped entirely, `.memberPricing` is
       undefined and reaching through it throws — which fails the suite, but as
       a stack trace rather than as the sentence describing what broke. */
    const round = C.sanitizeCommerceConfig({ memberPricing: { enabled: false } });
    ok('sanitizing keeps it', (round.memberPricing || {}).enabled === false,
      'a key sanitizeCommerceConfig drops is a switch that saves, reloads as absent, and flips itself back on');
    const empty = C.sanitizeCommerceConfig({});
    ok('…and supplies the default when it is missing', (empty.memberPricing || {}).enabled === true);
  }

  console.log('\n  ON: the page and the till both say $25');
  {
    const settings = { memberPricing: { enabled: true } };
    const till = await tillCents(settings);
    const page = await pageQuote(settings, true);

    ok('the till charges the member price', till.cents === 2500, 'got ' + till.cents);
    ok('the page prints the member price', page.base.priceCents === 2500, JSON.stringify(page.base));
    ok('THEY AGREE', till.cents === page.base.priceCents);
    ok('…and the page says so plainly', page.base.usingMember === true && page.memberPricing === true);
  }

  console.log('\n  OFF: the page and the till both say $40');
  {
    const settings = { memberPricing: { enabled: false } };
    const till = await tillCents(settings);
    const page = await pageQuote(settings, true);

    ok('the till charges everyone the same', till.cents === 4000, 'got ' + till.cents);
    ok('the page prints the same', page.base.priceCents === 4000, JSON.stringify(page.base));
    ok('THEY AGREE', till.cents === page.base.priceCents,
      'gate one and not the other and the page shows $25 while the card takes $40');
    ok('no member discount is claimed', page.base.usingMember === false && page.base.memberPriceCents === 0);
    ok('…and the page is told the feature is off', page.memberPricing === false);
  }

  console.log('\n  OFF: a guest is not offered a tier that charges nothing');
  {
    const page = await pageQuote({ memberPricing: { enabled: false } }, false);
    ok('no "Members pay" figure is sent', page.base.memberPriceCents === 0,
      '"Members pay $25" beside a store that charges everyone $40 is an offer nobody can take');
    const on = await pageQuote({ memberPricing: { enabled: true } }, false);
    ok('…but it is when the switch is on', on.base.memberPriceCents === 2500);
  }

  console.log('\n  OFF: the member price is kept, not deleted');
  {
    /* The whole promise of a switch rather than a purge: turning it back on
       restores what was there. */
    const off = await pageQuote({ memberPricing: { enabled: false } }, true);
    const on  = await pageQuote({ memberPricing: { enabled: true } }, true);
    ok('turning it back on restores the figure exactly', on.base.priceCents === 2500 && off.base.priceCents === 4000,
      'nothing is written to the product, so the price comes back untouched');
  }

  console.log('\n  a store that has never opened the switch is unchanged');
  {
    const till = await tillCents({});
    const page = await pageQuote({}, true);
    ok('the till still charges the member price', till.cents === 2500);
    ok('the page still prints it', page.base.priceCents === 2500);
    ok('…and reports the feature as on', page.memberPricing === true);
  }

  console.log('\n  membership itself is what is gated');
  {
    const off = await tillCents({ memberPricing: { enabled: false } });
    ok('signed in is still signed in', off.isMember === true,
      'isMember means "a signed-in customer" — anything reading it later expects that word to mean that');
    ok('…but they were not PRICED as one', off.chargeAsMember === false,
      'reported separately so an order can say why it charged what it charged');
  }

  console.log('\n  the browser\'s own fallback respects it too');
  {
    /* When /api/prices cannot be reached the page applies the catalogue rule
       itself. Without the flag reaching that branch, a failed request is all it
       takes for a switched-off member price to reappear. */
    const BROWSER = fs.readFileSync(path.join(ROOT, 'variant-price.js'), 'utf8');
    ok('the module keeps what the server last said',
      /function memberPricingOn\(\)/.test(BROWSER)
      && /if \(typeof j\.memberPricing === 'boolean'\) _memberPricing = j\.memberPricing;/.test(BROWSER));
    ok('…defaulting to on', /var _memberPricing = true;/.test(BROWSER),
      'guessing "off" would withdraw a discount that is being honoured at the till');
    ok('the fallback branch consults it',
      /memberPricingOn\(\)/.test(PAGE) && /memberCents: 0, usingMember: false/.test(PAGE));
    ok('…clearing the member FIGURE as well as the flag',
      /Object\.assign\(\{\}, cat, \{ memberCents: 0, usingMember: false \}\)/.test(PAGE),
      'memberCents is what draws "Members pay $X" for a shopper who is not signed in');
  }

  console.log('\n  the switch is somewhere a merchant can find it');
  {
    ok('there is a control', /id="mp-enabled"/.test(HTML) && /Charge members a different price/.test(HTML));
    ok('…on the page that already owns membership', HTML.indexOf('id="mp-enabled"') < HTML.indexOf('id="sk-limit-qty"'),
      'it sits with rewards and stock rules under Loyalty rather than in a settings page of its own');
    ok('it loads with the rest of that page', /loadMemberPricingSettings\(\);/.test(UI));
    ok('…and reads absent as on', /\.enabled !== false/.test(UI));
    ok('…and an unreadable settings row as on too',
      /catch \(_\) \{\s*el\.checked = true;\s*\}/.test(UI));
    ok('saving touches only this key',
      /cfg\.memberPricing = Object\.assign\(\{\}, cfg\.memberPricing, \{ enabled: !!el\.checked \}\);/.test(UI),
      'a read-modify-write on a shared blob that rewrites the whole thing rolls back whatever else changed');
    ok('…and says what it did in words, not jargon',
      /Member prices are kept, just not applied/.test(UI));
    ok('the Pricing screen warns where the figure is TYPED',
      /_live\.memberPricing === false/.test(PANEL) && /saved but not charged/.test(PANEL),
      'a field that accepts a number and quietly does nothing with it is an afternoon wasted');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
