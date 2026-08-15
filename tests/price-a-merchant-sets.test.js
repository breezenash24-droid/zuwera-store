/* The price a merchant sets is the price a shopper sees.
 *
 * Four faults, found together, all of them the same shape: a number entered on
 * the Pricing screen that never reached the product page.
 *
 * 1. MEMBER PRICES ON PRICE LISTS DID NOTHING. Migration 0023 added
 *    prices.member_price, the panel wrote to it, the resolver read it — and the
 *    query that loaded the rows never asked for the column. `undefined` became
 *    "no member price" in silence, so every member price typed into that screen
 *    was accepted, stored, approved, and ignored.
 *
 * 2. RAISING A PRICE WAS A COIN FLIP. Two approved rows with no dates are both
 *    live forever, and the tie-break compared uuids — which sort by their random
 *    first bytes. Move a product from $30 to $32 and roughly half the time the
 *    $30 row went on winning, with nothing on screen to explain it.
 *
 * 3. THE PAGE INVENTED THE MEMBER FIGURE. /api/prices sent the charged price and
 *    no member price, so product.html patched one in from the catalogue. A
 *    member already being charged $30 by a price list was shown "Members pay
 *    $35.00" beside it — the page advertising a WORSE price than the one it was
 *    about to charge.
 *
 * 4. THE ADMIN LIST SHOWED THE CATALOGUE PRICE. The column beside each product
 *    read products.current_price, so a product moved to $32 by a price list
 *    still read $40 in the one place a merchant looks to check what things cost.
 *
 * Everything that can be run is run. Assertions over source text pass just as
 * happily when the logic beneath them is disabled.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const UI      = fs.readFileSync(path.join(ROOT, 'admin-pricing.js'), 'utf8');
const ADMIN   = fs.readFileSync(path.join(ROOT, 'functions/api/admin-prices.js'), 'utf8');
const MIG22   = fs.readFileSync(path.join(ROOT, 'migrations/0022_pricing_is_its_own_system.sql'), 'utf8');
const BROWSER = fs.readFileSync(path.join(ROOT, 'variant-price.js'), 'utf8');
const PROD    = fs.readFileSync(path.join(ROOT, 'product.html'), 'utf8');

const NOW = Date.parse('2026-09-01T12:00:00Z');
const PRODUCT = { id: 'p-1', current_price: 40, member_price: 35, msrp: 40 };
const LISTS = [{ id: 'L-default', code: 'default', name: 'Default', priority: 0, active: true }];

(async () => {
  const R = await load('functions/api/_price-resolution.js');

  console.log('\n  the price a merchant sets\n');

  /* ── 1. A member price on a price list ───────────────────────────────────── */
  console.log('  a member price on a price list is charged to a member');
  {
    const rows = [{
      id: 'r-1', price_list_id: 'L-default', product_id: 'p-1', color_variant_id: null,
      amount: 32, member_price: 28, status: 'approved', created_at: '2026-08-15T00:00:00Z',
    }];
    const guest  = R.resolvePrice({ product: PRODUCT, variant: null, rows, lists: LISTS, shopper: R.shopperFor({ isMember: false }), now: NOW });
    const member = R.resolvePrice({ product: PRODUCT, variant: null, rows, lists: LISTS, shopper: R.shopperFor({ isMember: true }),  now: NOW });

    ok('the guest pays the row amount', guest.priceCents === 3200, 'got ' + guest.priceCents);
    ok('the member pays the row member price', member.priceCents === 2800, 'got ' + member.priceCents);
    ok('…and is told that is why', member.usingMember === true);
    ok('the catalogue member price does NOT leak past the row',
      member.priceCents !== 3500,
      'the product row says $35; a live price list row is the price, not a starting point');
  }

  console.log('\n  …and a member price ABOVE the price is refused, not honoured');
  {
    const rows = [{ id: 'r-1', price_list_id: 'L-default', product_id: 'p-1', color_variant_id: null,
      amount: 30, member_price: 34, status: 'approved', created_at: '2026-08-15T00:00:00Z' }];
    const m = R.resolvePrice({ product: PRODUCT, variant: null, rows, lists: LISTS, shopper: R.shopperFor({ isMember: true }), now: NOW });
    ok('a member is never charged more for being one', m.priceCents === 3000);
    ok('…and is not told a discount applied', m.usingMember === false);
  }

  /* ── 2. The query that loads the rows ────────────────────────────────────── */
  console.log('\n  the rows are loaded WITH the columns the resolver reads');
  {
    const asked = [];
    const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
    global.fetch = async (url) => {
      asked.push(String(url));
      return { ok: true, status: 200, json: async () => [] };
    };
    await R.fetchPricingContext(env, ['p-1']);
    const priceQuery = asked.find((u) => u.includes('/prices?'));

    ok('member_price is asked for', /member_price/.test(priceQuery || ''),
      'THE BUG: the column existed, the panel wrote to it, and this query never selected it');
    ok('created_at is asked for', /created_at/.test(priceQuery || ''),
      'without it the tie-break cannot tell which of two rows is the later one');
    ok('…and so is everything the resolver reads',
      ['amount', 'compare_at', 'starts_at', 'ends_at', 'status', 'color_variant_id', 'price_list_id']
        .every((c) => (priceQuery || '').includes(c)));
  }

  console.log('\n  …and a database without 0023 still prices everything else');
  {
    /* PostgREST rejects the WHOLE query for one unknown column. Asking for
       member_price before 0023 is applied would turn "members are not
       discounted" into "no price list works at all" — a worse failure than the
       one being fixed, on every store that has not run the migration yet. */
    const asked = [];
    const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
    global.fetch = async (url) => {
      const u = String(url);
      asked.push(u);
      if (u.includes('/prices?') && u.includes('member_price')) {
        return { ok: false, status: 400, json: async () => ({}), text: async () => 'column does not exist' };
      }
      if (u.includes('/prices?')) {
        return { ok: true, status: 200, json: async () => [{ id: 'r-1', price_list_id: 'L-default', product_id: 'p-1', amount: 32, status: 'approved' }] };
      }
      return { ok: true, status: 200, json: async () => LISTS };
    };
    const ctx = await R.fetchPricingContext(env, ['p-1']);
    ok('it asks again without the new column', asked.filter((u) => u.includes('/prices?')).length === 2);
    ok('…and the price list still applies', ctx.rows.length === 1 && Number(ctx.rows[0].amount) === 32,
      'a missing migration must cost the member price, not every price');
    delete global.fetch;
  }

  /* ── 3. Which of two live rows wins ──────────────────────────────────────── */
  console.log('\n  raising a price actually raises it');
  {
    /* The shape the panel tells you to create: "Leave both blank to start now
       and run until you change it." Do that twice and both rows are live. */
    const older = { id: 'ffff-old', price_list_id: 'L-default', product_id: 'p-1', color_variant_id: null,
      amount: 30, status: 'approved', created_at: '2026-08-10T00:00:00Z' };
    const newer = { id: '0000-new', price_list_id: 'L-default', product_id: 'p-1', color_variant_id: null,
      amount: 32, status: 'approved', created_at: '2026-08-14T00:00:00Z' };

    /* Both orders, because the old tie-break's answer depended on which uuid
       happened to sort higher — and these two are chosen so that id-ordering
       gives the WRONG one. */
    const a = R.pickPrice({ rows: [older, newer], lists: LISTS, productId: 'p-1', shopper: R.shopperFor({}), now: NOW });
    const b = R.pickPrice({ rows: [newer, older], lists: LISTS, productId: 'p-1', shopper: R.shopperFor({}), now: NOW });

    ok('the row written later wins', Number(a.amount) === 32, 'got ' + (a && a.amount));
    ok('…whichever order the database returned them in', Number(b.amount) === 32, 'got ' + (b && b.amount));
    ok('…and it is not the uuid deciding', a.id === '0000-new',
      'uuids sort by their random first bytes, so id-ordering picked the $30 row here');
  }

  console.log('\n  …and the rules that outrank recency still do');
  {
    const wide   = { id: 'r-wide', price_list_id: 'L-default', product_id: 'p-1', color_variant_id: null,
      amount: 32, status: 'approved', created_at: '2026-08-14T00:00:00Z' };
    const colour = { id: 'r-colour', price_list_id: 'L-default', product_id: 'p-1', color_variant_id: 'v-1',
      amount: 25, status: 'approved', created_at: '2026-08-01T00:00:00Z' };
    const hit = R.pickPrice({ rows: [wide, colour], lists: LISTS, productId: 'p-1', colorVariantId: 'v-1', shopper: R.shopperFor({}), now: NOW });
    ok('a colour-specific row still beats a newer product-wide one', Number(hit.amount) === 25,
      'recency is the LAST tie-break, not the first');

    const scheduled = { id: 'r-sched', price_list_id: 'L-default', product_id: 'p-1', color_variant_id: null,
      amount: 20, status: 'approved', starts_at: '2026-08-20T00:00:00Z', created_at: '2026-08-01T00:00:00Z' };
    const standing  = { id: 'r-stand', price_list_id: 'L-default', product_id: 'p-1', color_variant_id: null,
      amount: 32, status: 'approved', created_at: '2026-08-14T00:00:00Z' };
    const s = R.pickPrice({ rows: [scheduled, standing], lists: LISTS, productId: 'p-1', shopper: R.shopperFor({}), now: NOW });
    ok('…and a later START still beats a later write', Number(s.amount) === 20,
      'a scheduled change supersedes the standing price the moment its window opens');
  }

  /* ── 4. What /api/prices sends the page ──────────────────────────────────── */
  console.log('\n  the page is TOLD what a member pays, rather than guessing');
  {
    const rows = [{ id: 'r-1', price_list_id: 'L-default', product_id: 'p-1', color_variant_id: null,
      amount: 30, member_price: null, status: 'approved', created_at: '2026-08-14T00:00:00Z' }];

    const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SITE_URL: 'https://zuwera.store' };
    global.fetch = async (url) => {
      const u = String(url);
      const body = u.includes('/products?') ? [PRODUCT]
        : u.includes('/color_variants?') ? []
        : u.includes('/prices?') ? rows
        : u.includes('/price_lists?') ? LISTS : [];
      return { ok: true, status: 200, json: async () => body };
    };

    const API = await load('functions/api/prices.js');
    const req = new Request('https://zuwera.store/api/prices?productId=00000000-0000-4000-8000-000000000001');
    /* The uuid filter is on the query parameter, so the product id used above
       has to look like one; the fake database answers regardless. */
    const res = await API.onRequestGet({ request: req, env });
    const out = await res.json();
    const base = out.base || {};

    ok('the charged price is the list price', base.priceCents === 3000, JSON.stringify(base));
    ok('no member discount is claimed where there is none', base.memberPriceCents === 0,
      'the catalogue says members pay $35, but this $30 row is what a member is charged too — '
      + 'and "Members pay $35.00" beside a $30 price is the page contradicting the till');
    ok('an absent member price is not spelled as a price',
      base.memberPriceCents === 0 && base.usingMember === false);
    ok('the price before any member discount is sent', base.regularCents === 3000,
      'inferring it from compare-at conflates two different figures');
    ok('the list is still not named', !('priceListCode' in base) && base.source === 'list');
    delete global.fetch;
  }

  console.log('\n  …and where there IS a member price, it is the row\'s');
  {
    const rows = [{ id: 'r-1', price_list_id: 'L-default', product_id: 'p-1', color_variant_id: null,
      amount: 30, member_price: 26, status: 'approved', created_at: '2026-08-14T00:00:00Z' }];
    const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SITE_URL: 'https://zuwera.store' };
    global.fetch = async (url) => {
      const u = String(url);
      const body = u.includes('/products?') ? [PRODUCT]
        : u.includes('/color_variants?') ? []
        : u.includes('/prices?') ? rows
        : u.includes('/price_lists?') ? LISTS : [];
      return { ok: true, status: 200, json: async () => body };
    };
    const API = await load('functions/api/prices.js');
    const res = await API.onRequestGet({
      request: new Request('https://zuwera.store/api/prices?productId=00000000-0000-4000-8000-000000000001'),
      env,
    });
    const base = (await res.json()).base || {};
    ok('a guest is quoted the guest price', base.priceCents === 3000);
    ok('…and told what a member would pay', base.memberPriceCents === 2600,
      'got ' + base.memberPriceCents + ' — the catalogue $35 must not be what appears here');
    delete global.fetch;
  }

  /* ── The product page reads those figures rather than the catalogue ─────── */
  console.log('\n  the product page uses what it was sent');
  {
    const src = PROD.slice(PROD.indexOf('function resolvedPrices(product) {'));
    const body = src.slice(0, src.indexOf('\n}') + 2);
    const run = (server, signedIn) => new Function('window', 'priceVariant', 'isMemberSignedIn',
      body + '\nreturn resolvedPrices({ id: "p-1", current_price: 40, member_price: 35 });')(
      { ZWVariantPrice: {
        resolvedFor: () => server,
        resolve: () => ({ regularCents: 4000, memberCents: 3500, msrpCents: 4000, priceCents: 3500, usingMember: true, source: 'product' }),
      } },
      () => null, () => signedIn);

    const listPrice = run({ priceCents: 3000, regularCents: 3000, compareAtCents: 4000, memberPriceCents: 0, usingMember: false, source: 'list' }, true);
    ok('a member on a list price is not offered a worse one',
      listPrice.memberCents === 0,
      'THE BUG ON THE LIVE SITE: this read 3500 from the catalogue and the page printed '
      + '"Members pay $35.00" beside the $30 it was charging');
    ok('…and no member discount is claimed', listPrice.usingMember === false);
    ok('…while the charged figure is still the list price', listPrice.priceCents === 3000);

    const memberPrice = run({ priceCents: 2600, regularCents: 3000, compareAtCents: 4000, memberPriceCents: 2600, usingMember: true, source: 'list' }, true);
    ok('a list member price reaches the page', memberPrice.memberCents === 2600);
    ok('…and it is labelled as one', memberPrice.usingMember === true);
    ok('…struck against the non-member price, not the compare-at', memberPrice.regularCents === 3000,
      'regularCents used to be filled from compare-at, which is a different figure');

    const noServer = run(null, false);
    ok('with no answer yet, the catalogue rule still stands', noServer.priceCents === 3500,
      'a pricing read that has not returned must never blank a price');
  }

  /* ── The admin list ──────────────────────────────────────────────────────── */
  console.log('\n  the list beside the form says what is charged');
  {
    ok('the row shows the resolved price, not products.current_price',
      /function chargedCell\(/.test(UI) && /_charged\[String\(p\.id\)\]/.test(UI)
      && !/">\$\{dollars\(p\.current_price\)\}<\/span>\s*<\/button>/.test(UI),
      'the one place a merchant looks to check what things cost was showing the figure the price list overrode');
    /* The panel DISPLAYS a list's priority in the Price Lists table, which is
       fine — reading a column is not deciding a price. What it must never do is
       work out which row wins: no window arithmetic, no priority comparison, no
       status filtering to arrive at a figure. */
    const chargedFn = UI.slice(UI.indexOf('function chargedCell('), UI.indexOf('/* Pricing something nobody can buy'));
    ok('…resolved by the server, not recomputed here',
      /\?quote=/.test(UI)
      && !/priceIsLive|pickPrice|listApplies/.test(UI)
      && !/_prices/.test(chargedFn)
      && !/starts_at|ends_at|priority/.test(chargedFn),
      'a second implementation of the pricing rules in the panel is the fault this system removes');
    ok('…and it falls back to the catalogue while the quotes are in flight',
      /if \(!q \|\| !q\.base\)/.test(UI) && /dollars\(p\.current_price\)/.test(UI));
    ok('every colourway is asked, so one figure is only shown when they agree',
      /const varies = /.test(UI) && /from /.test(UI),
      'a product whose colours are priced apart has no single price to print');
    ok('the whole list is quoted in one request, chunked',
      /i \+= 60/.test(UI),
      'a request per product is a round trip per row; an unchunked one eventually exceeds what a URL may hold');
  }

  console.log('\n  a live price can be ended, not just added to');
  {
    ok('the panel offers it', /pricingEnd/.test(UI) && /End this price/.test(UI),
      'the only verb was "propose", so changing a price meant stacking a second row beside the live one');
    ok('…only for a price LIST row', /hit\.source === 'price_list' \|\| hit\.source === 'list'/.test(UI),
      'a catalogue price is not a row and has nothing to end');
    ok('…and it says what the price falls back to', /revertsToCents/.test(UI) && /revertsToCents/.test(ADMIN),
      'resolved by the server afterwards rather than guessed at');
    ok('the server ends rather than deletes', /action === 'end'/.test(ADMIN) && /ends_at: endsAt/.test(ADMIN)
      && !/method: 'DELETE'/.test(ADMIN),
      'a price that charged real customers real money is a record');
    ok('…and a not-yet-started row is superseded instead',
      /notYetStarted/.test(ADMIN) && /status: 'superseded'/.test(ADMIN),
      'prices_window_ordered refuses ends_at <= starts_at, so the PATCH would fail on exactly the rows this is most useful for');
    ok('…which is a status the database allows',
      /check \(status in \('proposed', 'approved', 'rejected', 'superseded'\)\)/.test(MIG22));
    ok('the register records it under an action the constraint permits',
      /action: 'superseded'/.test(ADMIN) && !/action: 'ended'/.test(ADMIN),
      "'ended' is not in the price_audit CHECK, so the row would be refused and writeAudit would swallow it");
    ok('…and a refused audit row is no longer silent',
      /price_audit rejected/.test(ADMIN),
      'only a thrown error was caught, and PostgREST refusing a row is a 4xx rather than a throw');
  }

  console.log('\n  the reload no longer paints the old price');
  {
    /* Discarding the cache does not leave the page with nothing to draw — it
       leaves it drawing the CATALOGUE price, which on any product with a price
       list is further from the truth than the figure just thrown away. */
    const ttl = /var TTL_MS = ([^;]+);/.exec(BROWSER);
    const ms = ttl ? Function('return ' + ttl[1])() : 0;
    ok('the last thing the server said is painted, however old', ms >= 60 * 60 * 1000,
      'a ten-minute cache meant an eleventh-minute visit painted $40 over a $30 product and then corrected it');
    ok('…but not forever', ms <= 7 * 24 * 60 * 60 * 1000,
      'past some age the catalogue price is the more honest guess');
    ok('…and the fetch still always runs and corrects',
      /_asked\[id\] = true;/.test(BROWSER) && /dispatchEvent\(new CustomEvent\('zw:prices'/.test(BROWSER));
    /* THIS ASSERTION USED TO READ "only when the answer moved", and that was
       right while the page painted from cache and wrong the moment it started
       waiting for the server. The first answer of a page load usually MATCHES
       the cache — and that is precisely the redraw that swaps the placeholder
       for a real price. Firing only on a change left it a placeholder forever.
       The event now fires when the answer moved OR when it first becomes
       known, which is still not "every load, for nothing". */
    ok('…when the answer moved, or has just become known',
      /if \(!changed && !flipped\) return;/.test(BROWSER),
      'a redraw for nothing is a flash with an extra step; no redraw at all is a permanent placeholder');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
