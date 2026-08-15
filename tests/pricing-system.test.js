/* Pricing as its own system: who a price is for, when it applies, who approved it.
 *
 * Price used to be a column on the thing it priced. Whoever could edit a product
 * could change what it cost, instantly, with no record of the old figure. The
 * admin audit log did record `product.update` — but its metadata carries sku,
 * title, status and image counts and NO price fields, so a price change left a
 * row saying somebody edited a product, unable to say the price moved at all.
 * The old number is gone the moment it is overwritten.
 *
 * ── THE TWO WAYS THIS FEATURE COULD BE WORSE THAN NOT HAVING IT ─────────────
 *
 * 1. AN EMPTY PRICING SYSTEM PRICES THE CATALOGUE AT ZERO. Every store is in
 *    that state until somebody opens the screen, and 0022 is applied before
 *    anybody does. The resolver must fall through to the catalogue price, and
 *    must do so on a missing table, a rejected select, and an unreachable
 *    database — not only on "no rows".
 *
 * 2. TWO LIVE ROWS RESOLVE DIFFERENTLY RUN TO RUN. Several rows can match one
 *    shopper at one instant, and if the winner depends on row order the same
 *    cart prices differently on two page loads and nobody can reproduce the
 *    complaint. The ordering is fixed and total, and it is asserted here by
 *    shuffling the input.
 *
 * Everything below RUNS the resolver. Assertions over source text pass just as
 * happily when the logic beneath them is disabled, which this session has been
 * caught by more than once.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const MIG    = fs.readFileSync(path.join(ROOT, 'migrations/0022_pricing_is_its_own_system.sql'), 'utf8');
const BUNDLE = fs.readFileSync(path.join(ROOT, 'functions/api/_migrations.js'), 'utf8');
const ADMIN  = fs.readFileSync(path.join(ROOT, 'functions/api/admin-prices.js'), 'utf8');
const PUBLIC = fs.readFileSync(path.join(ROOT, 'functions/api/prices.js'), 'utf8');
const RBAC   = fs.readFileSync(path.join(ROOT, 'functions/api/_rbac.js'), 'utf8');
const MIG23  = fs.readFileSync(path.join(ROOT, 'migrations/0023_a_price_row_carries_the_member_price.sql'), 'utf8');
const CART   = fs.readFileSync(path.join(ROOT, 'functions/api/_cart-pricing.js'), 'utf8');

const DAY = 86400000;
const NOW = Date.parse('2026-09-01T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const PRODUCT = { id: 'p-1', current_price: 220, member_price: 198, msrp: 260 };
const CRIMSON = { id: 'v-crimson', color_name: 'Crimson' };

const LISTS = [
  { id: 'L-default', code: 'default', priority: 0,  active: true },
  { id: 'L-members', code: 'members', priority: 10, active: true, customer_group: 'member' },
  { id: 'L-eu',      code: 'eu',      priority: 5,  active: true, region: 'EU' },
  { id: 'L-off',     code: 'dormant', priority: 99, active: false },
];

const row = (o) => ({
  id: o.id, price_list_id: o.list, product_id: 'p-1',
  color_variant_id: o.variant || null, amount: o.amount,
  compare_at: o.compareAt || null,
  starts_at: o.startsAt || null, ends_at: o.endsAt || null,
  status: o.status || 'approved',
});

(async () => {
  const R = await import(pathToFileURL(path.join(ROOT, 'functions/api/_price-resolution.js')).href);
  const { resolvePrice, pickPrice, priceIsLive, listApplies, shopperFor } = R;

  const guest  = shopperFor({ isMember: false });
  const member = shopperFor({ isMember: true });
  const price = (rows, shopper, variant, now) =>
    resolvePrice({ product: PRODUCT, variant: variant || null, rows, lists: LISTS, shopper, now: now || NOW });

  console.log('\n  pricing as its own system\n');

  console.log('  an empty system prices the catalogue, not zero');
  {
    ok('no rows at all → the product price', price([], guest).priceCents === 22000);
    ok('…and the member price for a member', price([], member).priceCents === 19800);
    ok('…reported as coming from the catalogue', price([], guest).source === 'product');
    ok('undefined rows are survivable',
      resolvePrice({ product: PRODUCT, variant: null, rows: undefined, lists: undefined, shopper: guest, now: NOW }).priceCents === 22000,
      'a failed fetch hands back nothing — that must price the catalogue, not crash the checkout');
    /* 0021's colourway price still applies underneath. */
    ok('a colourway price still wins over the product',
      price([], guest, { id: 'v-x', current_price: 176.97 }).priceCents === 17697);
  }

  console.log('\n  a broken pricing table never stops the store selling');
  {
    /* THE failure that would take the store down, and the one a source-reading
       assertion cannot see: fetchPricingContext does network I/O, so it has to
       be run against a fetch that fails the way production fails. */
    const realFetch = globalThis.fetch;
    const ENV = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
    const stub = (impl) => { globalThis.fetch = impl; };

    try {
      /* Before 0022 is applied the tables do not exist — a 404 from PostgREST. */
      stub(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
      let ctx = await R.fetchPricingContext(ENV, ['p-1']);
      ok('a missing table yields no rows', ctx.rows.length === 0 && ctx.lists.length === 0);
      ok('…and the catalogue price still resolves',
        resolvePrice({ product: PRODUCT, variant: null, rows: ctx.rows, lists: ctx.lists, shopper: guest, now: NOW }).priceCents === 22000);

      /* Rejected select — a policy change, a renamed column. */
      stub(async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => '' }));
      ctx = await R.fetchPricingContext(ENV, ['p-1']);
      ok('a rejected select yields no rows', ctx.rows.length === 0);

      /* Unreachable database. */
      stub(async () => { throw new Error('ECONNREFUSED'); });
      ctx = await R.fetchPricingContext(ENV, ['p-1']);
      ok('an unreachable database yields no rows', ctx.rows.length === 0);

      /* THE ASYMMETRIC ONE: prices come back, lists do not. Keeping the rows
         would price against lists we cannot check the audience of — a members
         price handed to a guest. Both or neither. */
      stub(async (url) => String(url).includes('price_lists')
        ? { ok: false, status: 500, json: async () => ({}), text: async () => '' }
        : { ok: true, status: 200, json: async () => [row({ id: 'x', list: 'L-members', amount: 1 })], text: async () => '' });
      ctx = await R.fetchPricingContext(ENV, ['p-1']);
      ok('prices without their lists are discarded, not applied', ctx.rows.length === 0,
        'a row whose audience cannot be checked could hand a members price to anybody');

      /* And the ordinary case, so the above is not passing because the function
         always returns empty. */
      stub(async (url) => ({
        ok: true, status: 200,
        json: async () => String(url).includes('price_lists') ? LISTS : [row({ id: 'ok', list: 'L-default', amount: 5 })],
        text: async () => '',
      }));
      ctx = await R.fetchPricingContext(ENV, ['p-1']);
      ok('a working read does return rows', ctx.rows.length === 1 && ctx.lists.length === 4,
        'if this fails the four assertions above prove nothing');

      ok('no product ids means no query at all',
        (await R.fetchPricingContext(ENV, [])).rows.length === 0);
      ok('an unconfigured environment is survivable',
        (await R.fetchPricingContext({}, ['p-1'])).rows.length === 0);
    } finally { globalThis.fetch = realFetch; }
  }

  console.log('\n  only approved rows inside their window are charged');
  {
    ok('a proposed row prices nothing',
      price([row({ id: 'r1', list: 'L-default', amount: 99, status: 'proposed' })], guest).priceCents === 22000,
      'if proposals priced things the approval step would be decorative');
    ok('a rejected row prices nothing',
      price([row({ id: 'r2', list: 'L-default', amount: 99, status: 'rejected' })], guest).priceCents === 22000);

    const future = row({ id: 'r3', list: 'L-default', amount: 176.97, startsAt: iso(NOW + 5 * DAY) });
    ok('a scheduled row does not apply early', price([future], guest).priceCents === 22000);
    ok('…and does once its window opens', price([future], guest, null, NOW + 6 * DAY).priceCents === 17697);

    const past = row({ id: 'r4', list: 'L-default', amount: 176.97, endsAt: iso(NOW - DAY) });
    ok('an expired row stops applying', price([past], guest).priceCents === 22000);

    /* Exclusive end: inclusive would leave two rows live for one instant at
       every handover, which is the ambiguity the ordering exists to remove. */
    const endsNow = row({ id: 'r5', list: 'L-default', amount: 176.97, endsAt: iso(NOW) });
    ok('a window ending now prices nothing now', priceIsLive(endsNow, NOW) === false);
    ok('…and did a millisecond earlier', priceIsLive(endsNow, NOW - 1) === true);
  }

  console.log('\n  a price list is for somebody');
  {
    const rows = [
      row({ id: 'a', list: 'L-default', amount: 200 }),
      row({ id: 'b', list: 'L-members', amount: 150 }),
    ];
    ok('a guest does not get the members price', price(rows, guest).priceCents === 20000);
    ok('a member does', price(rows, member).priceCents === 15000);
    ok('…because the list has higher priority, and it says so',
      price(rows, member).priceListCode === 'members');

    ok('a region list does not apply outside its region',
      price([row({ id: 'c', list: 'L-eu', amount: 111 })], guest).priceCents === 22000);
    ok('…and does inside it',
      price([row({ id: 'c', list: 'L-eu', amount: 111 })], { groups: [], region: 'EU', channel: 'web' }).priceCents === 11100);

    ok('an inactive list is ignored however high its priority',
      price([row({ id: 'd', list: 'L-off', amount: 1 })], guest).priceCents === 22000,
      'switching a list off must actually switch it off');
    ok('listApplies agrees on its own', listApplies(LISTS[3], guest) === false);
  }

  console.log('\n  the winner is the same every time');
  {
    /* Same shopper, same instant, four live rows. If the answer depends on the
       order they arrive in, the same cart prices differently on two page loads. */
    const rows = [
      row({ id: 'p1', list: 'L-default', amount: 200 }),
      row({ id: 'p2', list: 'L-default', amount: 180, variant: 'v-crimson' }),
      row({ id: 'p3', list: 'L-members', amount: 150 }),
      row({ id: 'p4', list: 'L-members', amount: 140, variant: 'v-crimson', startsAt: iso(NOW - DAY) }),
    ];
    const answers = new Set();
    for (let i = 0; i < 40; i++) {
      const shuffled = rows.slice().sort(() => Math.random() - 0.5);
      answers.add(price(shuffled, member, CRIMSON).priceCents);
    }
    ok('forty shuffles give one answer', answers.size === 1, 'got ' + [...answers].join(', '));

    /* The rows above differ by list and by colour, so the LAST tiebreak — id —
       is never reached and could be deleted with everything still green. These
       two are identical in every respect the sort looks at, so only that final
       comparison separates them. Without it the answer follows row order. */
    const tied = [
      row({ id: 'aaa', list: 'L-default', amount: 200, startsAt: iso(NOW - DAY) }),
      row({ id: 'zzz', list: 'L-default', amount: 111, startsAt: iso(NOW - DAY) }),
    ];
    const tiedAnswers = new Set();
    for (let i = 0; i < 40; i++) {
      tiedAnswers.add(price(i % 2 ? tied : tied.slice().reverse(), guest).priceCents);
    }
    ok('…even for two rows tied on every other axis', tiedAnswers.size === 1,
      'got ' + [...tiedAnswers].join(', ') + ' — the final tiebreak is what makes this reproducible');
    ok('…and it is the most specific row on the highest-priority list',
      price(rows, member, CRIMSON).priceCents === 14000);

    /* Specificity only breaks ties WITHIN a list — priority is checked first,
       or a product-wide members price would lose to a colour-specific default. */
    ok('a colour row on a low list does not beat a product row on a high one',
      price([
        row({ id: 'q1', list: 'L-default', amount: 180, variant: 'v-crimson' }),
        row({ id: 'q2', list: 'L-members', amount: 150 }),
      ], member, CRIMSON).priceCents === 15000);

    /* A row for a DIFFERENT colour must not price this one. */
    ok('another colour\'s price does not leak across',
      price([row({ id: 'r', list: 'L-default', amount: 5, variant: 'v-other' })], guest, CRIMSON).priceCents === 22000);

    /* Of two otherwise-equal rows, the later start wins — that is what makes a
       scheduled change supersede the standing price. */
    ok('the more recently effective row wins a tie',
      price([
        row({ id: 's1', list: 'L-default', amount: 200, startsAt: iso(NOW - 30 * DAY) }),
        row({ id: 's2', list: 'L-default', amount: 176.97, startsAt: iso(NOW - DAY) }),
      ], guest).priceCents === 17697);
  }

  console.log('\n  a zero row is refused, not charged');
  {
    const zero = price([row({ id: 'z', list: 'L-default', amount: 0 })], guest);
    ok('a zero-priced row falls back to the catalogue', zero.priceCents === 22000,
      'a free product is never what somebody meant, and it is what an empty form submits');
    ok('…and says which row it ignored', zero.ignoredZeroRow === 'z');
    ok('the admin route refuses to store one', /A price above zero is required/.test(ADMIN));
  }

  console.log('\n  compare-at follows the winning row');
  {
    const withCompare = price([row({ id: 'c1', list: 'L-default', amount: 176.97, compareAt: 220 })], guest);
    ok('the row\'s compare-at is used', withCompare.compareAtCents === 22000);
    const without = price([row({ id: 'c2', list: 'L-default', amount: 176.97 })], guest);
    ok('…and the catalogue msrp when the row has none', without.compareAtCents === 26000);
  }

  console.log('\n  a price row can say what a member pays');
  {
    /* 0022 rows had `amount` and `compare_at` only, so this screen could
       express two of the three figures the product form has — and the missing
       one is the one nearly every product here uses. */
    const rows = [row({ id: 'm1', list: 'L-default', amount: 50 })];
    rows[0].member_price = 45;
    ok('a member pays the row\'s member price', price(rows, member).priceCents === 4500);
    ok('…and a guest does not', price(rows, guest).priceCents === 5000);
    ok('…with both figures reported', price(rows, member).regularCents === 5000
      && price(rows, member).memberCents === 4500 && price(rows, member).usingMember === true);

    const noMember = [row({ id: 'm2', list: 'L-default', amount: 50 })];
    ok('a row with no member figure charges members the amount',
      price(noMember, member).priceCents === 5000,
      'rows written before 0023 must behave exactly as they did');

    /* Same rule as products and colourways: never charge more for being a
       member. It is what a transposed pair of numbers produces. */
    const inverted = [row({ id: 'm3', list: 'L-default', amount: 50 })];
    inverted[0].member_price = 60;
    ok('a member price above the amount is ignored', price(inverted, member).priceCents === 5000);
    ok('…and the route refuses to store one', /member price must be below the price/i.test(ADMIN));

    /* THE ambiguity this design had to avoid: two stages that never compete. */
    const both = [
      row({ id: 'd', list: 'L-default', amount: 50 }),
      row({ id: 'x', list: 'L-members', amount: 40 }),
    ];
    both[0].member_price = 45;
    ok('a Members LIST still wins over a member figure on a default row',
      price(both, member).priceCents === 4000,
      'the row is chosen first and only its figures are read — membership never picks the row');

    ok('0023 adds the column', /add column if not exists member_price/.test(
      fs.readFileSync(path.join(ROOT, 'migrations/0023_a_price_row_carries_the_member_price.sql'), 'utf8')));
    ok('…and the register gains both member figures',
      /from_member_amount/.test(MIG23) && /to_member_amount/.test(MIG23));
    ok('the bundle picked 0023 up', /0023/.test(BUNDLE));
  }

  console.log('\n  the register records the change, not just the event');
  {
    ok('0022 stores what it was before', /from_amount/.test(MIG) && /to_amount/.test(MIG),
      'a log of new prices with no old ones is what admin_audit_log already fails to be');
    ok('…who approved it', /approved_by/.test(MIG) && /approved_at/.test(MIG));
    ok('…and whether that was the same person', /self_approved/.test(MIG));
    /* Checked on the PROPOSE path specifically. The approve path has its own
       `const before = await currentPriceCents(...)` line, so a generic search
       for that phrase stayed green when the propose path was rewritten to read
       the old figure out of the request body — which is the whole thing this
       assertion exists to prevent. */
    ok('the before-figure is read from the database, not the request body',
      /async function currentPriceCents\(env, productId, colorVariantId\)/.test(ADMIN)
      && /const before = await currentPriceCents\(env, productId, colorVariantId\);/.test(ADMIN),
      'a body that carries "it used to be $220" can say anything');
    ok('…and nothing in the register comes off the body but the note',
      !/from_amount:\s*(money\()?body\./.test(ADMIN) && !/wasAmount/.test(ADMIN),
      'the one field a proposer may write is why they did it');
    ok('the register is written server-side',
      /rest\/v1\/price_audit/.test(ADMIN) && !/price_audit/.test(fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8')),
      'admin_audit_log is written by the browser, which is why it is evidence rather than governance');
    ok('…and a browser cannot insert into it', /for insert to authenticated with check \(false\)/.test(MIG));
    ok('…nor update or delete it', /revoke update, delete on public\.price_audit/.test(MIG));
  }

  console.log('\n  approval');
  {
    ok('a proposal starts as proposed', /status: 'proposed'/.test(ADMIN));
    ok('approving records who and when', /status: 'approved', approved_by: actorId/.test(ADMIN));
    ok('a change cannot be approved twice', /already \$\{price\.status\}/.test(ADMIN));
    /* Self-approval is permitted by design at this size — and stamped, so the
       register never implies a second pair of eyes that was not there. */
    ok('self-approval is detected', /const selfApproved = Boolean\(price\.created_by/.test(ADMIN));
    ok('…allowed by default', /require_second_approver boolean not null default false/.test(MIG));
    ok('…and refused when the list demands two people',
      /requires a second person to approve/.test(ADMIN));
    ok('that rule is enforced on the server, not in the form',
      ADMIN.indexOf('require_second_approver') < ADMIN.indexOf("status: 'approved', approved_by"),
      'a rule enforced only in a form is a rule enforced only for people using the form');
  }

  console.log('\n  who may change a price');
  {
    ok('pricing is its own page', /'pricing'/.test(RBAC));
    ok('…with its own write capability', /pricing: 'pricing_write'/.test(RBAC));
    ok('…which the content editor does not get',
      !/content:[\s\S]{0,400}pricing/.test(RBAC),
      'fixing a typo in a description must not also allow taking 40% off it');
    ok('both routes demand it',
      /requireAdmin\(request, env, 'pricing_write'\)/.test(ADMIN));

    /* RUN IT. The assertion above matched happily while the route was calling
       verifyAdmin(request, env) — whose real signature is (env, accessToken).
       That made the Request object the `env`, so the first read of
       env.SUPABASE_URL threw "Supabase is not configured for commerce
       features." and the page reported a configuration problem that did not
       exist. A regex over the call site cannot see an argument order; only
       calling the thing can.

       Stubbed so the auth check FAILS: the interesting part is which failure
       comes back. "Not authorised" means the handler got a real env and got as
       far as checking a token. Anything about configuration means it did not. */
    const A = await import(pathToFileURL(path.join(ROOT, 'functions/api/admin-prices.js')).href);
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '' });
      const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SITE_URL: 'https://zuwera.store' };
      const req = new Request('https://zuwera.store/api/admin-prices', {
        headers: { Authorization: 'Bearer not-a-real-token' },
      });
      const resp = await A.onRequestGet({ request: req, env });
      const body = await resp.json().catch(() => ({}));
      ok('an unauthenticated GET is refused as UNAUTHORISED',
        /not authoris/i.test(String(body.error || '')),
        'got: ' + JSON.stringify(body));
      ok('…not as a configuration problem',
        !/not configured/i.test(String(body.error || '')),
        'this is what a wrong argument order looks like from the outside, and it sends you to check Cloudflare env vars that are fine');

      const post = await A.onRequestPost({
        request: new Request('https://zuwera.store/api/admin-prices', {
          method: 'POST', headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'propose' }),
        }), env,
      });
      const postBody = await post.json().catch(() => ({}));
      ok('and so is an unauthenticated POST',
        /not authoris/i.test(String(postBody.error || '')) && !/not configured/i.test(String(postBody.error || '')),
        'got: ' + JSON.stringify(postBody));
    } finally { globalThis.fetch = realFetch; }
  }

  console.log('\n  the browser is never told how to price');
  {
    ok('there is an endpoint to ask', /onRequestGet/.test(PUBLIC));
    ok('membership comes from the token, not a parameter',
      /verifyAccessToken\(token, env\)/.test(PUBLIC) && !/searchParams\.get\('member'\)/.test(PUBLIC),
      'a claimed member price is one the till then refuses — it would look like the store breaking');
    ok('…and the response does not name the other tiers',
      /source: r\.source === 'price_list' \? 'list' : r\.source/.test(PUBLIC),
      'a wholesale tier is commercially sensitive');
    ok('it is never cached', /'Cache-Control': 'no-store'/.test(PUBLIC),
      'per-shopper and time-dependent: a scheduled price starts partway through any cache window');
    ok('storefront tables are unreadable from a browser',
      /create policy "prices are server-side"[\s\S]{0,120}using \(false\)/.test(MIG));
  }

  console.log('\n  the charge path');
  {
    const code = CART.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
    ok('the cart resolves through the pricing system', /resolvePrice\(\{/.test(code));
    /* One read for the cart, not one per line. */
    ok('…reading the price context once for the whole cart',
      /const pricingContext = await fetchPricingContext\(/.test(code)
      && code.indexOf('fetchPricingContext') < code.indexOf('for (const raw of items)'),
      'a fetch inside the loop is five round trips for a five-line cart');
    ok('…and the shown-price guard still runs after pricing',
      code.indexOf('resolvePrice({') < code.indexOf('const shownCents'));
  }

  console.log('\n  and an admin can actually reach it');
  {
    /* "Built but unreachable" is the repeat failure in this codebase — the
       PayPal endpoints, the return-window rule, the tax health check. An
       approval workflow nobody can open is a price change nobody can make. */
    const UI    = fs.readFileSync(path.join(ROOT, 'admin-pricing.js'), 'utf8');
    const HTML  = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
    const MAIN  = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');

    ok('there is a page', /id:'pricing'/.test(HTML) && /<div id="pricing" class="page">/.test(HTML));
    ok('…which loads the module', /admin-pricing\.js/.test(HTML));
    ok('…and something calls it when the page opens',
      /page === 'pricing'/.test(MAIN) && /window\.pricingLoadData\(\)/.test(MAIN),
      'a page that renders nothing looks exactly like a page with nothing in it');
    ok('propose and decide are both wired', /pricingPropose/.test(UI) && /pricingDecide/.test(UI));

    /* THE CRASH THAT SHIPPED. Replacing the product <select> with the search
       picker deleted #pricing-product, but pricingPropose still read
       $('pricing-product').value — so every Propose threw "Cannot read
       properties of null (reading 'value')" before sending anything. Nothing
       caught it because no test read a field the form no longer had. */
    /* Comments stripped first. The note explaining this very bug quotes
       $('pricing-product'), and reading prose as code has now broken four
       separate checks in this codebase. #pricing-body lives in admin.html, so
       both files count as places an id can be rendered. */
    const uiCode = UI.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
    const ids = [...uiCode.matchAll(/\$\('([a-z-]+)'\)/g)].map((m) => m[1]);
    const rendered = new Set([
      ...[...uiCode.matchAll(/id="([a-z-]+)"/g)].map((m) => m[1]),
      ...[...HTML.matchAll(/id="([a-z-]+)"/g)].map((m) => m[1]),
    ]);
    const orphans = [...new Set(ids)].filter((id) => id.startsWith('pricing-') && !rendered.has(id));
    ok('every field the panel reads is a field it renders', orphans.length === 0,
      'reads with no matching id: ' + orphans.join(', '));
    ok('…and the product comes from the selection, not a deleted field',
      /productId: _pick\.id/.test(uiCode) && !/\$\('pricing-product'\)/.test(uiCode));

    /* All three figures the product form has. */
    ok('member price can be set here', /id="pricing-member"/.test(UI) && /memberPrice:/.test(UI),
      'the screen could express two of the three figures a product carries');
    ok('…and it is shown in the before/after', /Members pay/.test(UI));

    /* Two panes, catalogue persistent on the left. */
    ok('the catalogue stays visible beside the form', /zw-price-panes/.test(UI));
    ok('…and that layout class exists in the stylesheet',
      /\.zw-price-panes/.test(fs.readFileSync(path.join(ROOT, 'admin.css'), 'utf8')));
    ok('…with the selected product marked', /aria-current=/.test(UI));

    /* Browser-drawn controls follow the panel theme. */
    const CSS = fs.readFileSync(path.join(ROOT, 'admin.css'), 'utf8');
    ok('native controls follow the theme', /color-scheme: dark/.test(CSS) && /color-scheme: light/.test(CSS),
      'the calendar button inside <input type="date"> is drawn by the browser — no colour we set reaches it');

    /* A <select> of every product is unusable past about twenty of them. */
    ok('products are searchable, not a raw select',
      /pricing-search/.test(UI) && /type="search"/.test(UI) && !/id="pricing-product" class="form-input">\$\{opts\}/.test(UI));
    ok('…by SKU as well as name',
      /String\(p\.title \|\| ''\) \+ ' ' \+ String\(p\.sku \|\| ''\)/.test(UI));
    ok('…and typing does not lose the caret',
      /setSelectionRange\(at, at\)/.test(UI),
      're-rendering an input on every keystroke drops focus, so the second character goes nowhere');

    /* The screen exists to CHANGE a price, so the current one has to be on it. */
    ok('the price charged today is shown before you change it',
      /Charged today/.test(UI) && /\/api\/prices\?productId=/.test(UI),
      'typing a new price with no idea of the old one is the core failure of this form');
    ok('…asked WITHOUT an admin token, so it is the shopper\'s price',
      /fetch\('\/api\/prices\?productId=' \+ encodeURIComponent\(id\), \{ cache: 'no-store' \}\)/.test(UI),
      'sending the admin session would show member pricing and mislead the person setting it');
    ok('pricing something no customer can see is flagged',
      /function statusWarning/.test(UI));

    /* The tables were written against a class that does not exist. */
    ok('tables use a class admin.css actually defines',
      !/class="data-table"/.test(UI) && /class="products-table"/.test(UI),
      'data-table is not in admin.css — the columns render unstyled and unaligned');
    ok('…and that class is real',
      /\.products-table th/.test(fs.readFileSync(path.join(ROOT, 'admin.css'), 'utf8')));

    /* The browser must not write to the pricing tables — that is what keeps the
       register unskippable. */
    ok('the panel goes through the API, never the tables',
      !/from\('prices'\)/.test(UI) && !/from\('price_audit'\)/.test(UI) && !/from\('price_lists'\)/.test(UI),
      'a browser that can write the row can decline to write the audit line');
    ok('…and it does not compute a price of its own',
      !/priority/.test(UI.split('function windowLabel')[0]) || !/sort\(/.test(UI),
      'the panel labels windows; it must never decide which row wins');
    ok('a missing table is explained rather than shown as an empty screen',
      /apply migration 0022/i.test(UI));
    ok('approving asks first', /confirm\(/.test(UI));
    ok('…and self-approval is reported back to the person who did it',
      /Recorded as self-approved/.test(UI),
      'the register records it; the person should not have to read the register to find out');
  }

  console.log('\n  the tables');
  {
    ok('0022 creates all three', /create table if not exists public\.price_lists/.test(MIG)
      && /create table if not exists public\.prices/.test(MIG)
      && /create table if not exists public\.price_audit/.test(MIG));
    ok('a default list is seeded', /insert into public\.price_lists[\s\S]{0,200}'default'/.test(MIG));
    ok('…and the members list ships INACTIVE',
      /'members', 'Members', 'member', 10, false/.test(MIG),
      'member_price already expresses this; two live ways to say it could disagree');
    ok('an end before a start is refused by the database',
      /constraint prices_window_ordered/.test(MIG),
      'a backwards window prices nothing and looks like a working row');
    ok('a negative amount is refused too', /check \(amount >= 0\)/.test(MIG));
    ok('the catalogue columns are NOT dropped',
      !/drop column/.test(MIG),
      'they are the fallback — dropping them is what makes an empty system price at zero');
    ok('the bundle picked it up', /0022/.test(BUNDLE));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
