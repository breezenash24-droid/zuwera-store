/**
 * /api/admin-prices — propose, approve, reject and read price changes.
 *
 * Everything here runs on the SERVER with the service key, and that is the
 * point rather than an implementation detail. The existing admin audit log is
 * written by the browser (`sb.from('admin_audit_log').insert(...)` in
 * admin-main.js), which makes it a record an admin could decline to write. A
 * price register that the priced party can skip is evidence, not governance.
 *
 * So: the browser may only ASK for a change. This file reads the current price,
 * writes the new row, and writes the audit line in the same request — the
 * before-figure comes from the database rather than from the request body,
 * because a body that carries "it used to be $220" is a body that can say
 * anything.
 *
 * ── SELF-APPROVAL ───────────────────────────────────────────────────────────
 *
 * Permitted, and stamped. A workflow that demands a second person is unusable
 * in a store with one owner, and an unusable control gets switched off — which
 * ends with no register at all. Approving your own change sets
 * price_audit.self_approved, so the record never implies a second pair of eyes
 * that was not there. A list can be set to require_second_approver the day
 * somebody else exists, and then it is refused outright.
 *
 * ── WHY 'pricing' IS ITS OWN PERMISSION ─────────────────────────────────────
 *
 * Editing product copy and deciding what the company charges are different
 * jobs. They were the same permission because price was a column on the product
 * form. A content editor should be able to fix a typo in a description without
 * being able to take 40% off it.
 */

import { cors, json, verifyAdmin, getSetting, sanitizeCommerceConfig } from './_commerce.js';
import { permsHave } from './_rbac.js';
import { resolveVariantPrice } from './_variant-price.js';
import { fetchPricingContext, resolvePrice, shopperFor } from './_price-resolution.js';

function H(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!env.SUPABASE_URL || !key) return null;
  return { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
}

/* verifyAdmin's signature is (env, accessToken) and it returns the admin object
   or NULL — it does not return {ok}. Getting that wrong is not a small mistake:
   passing (request, env) makes the Request object the `env`, so the first thing
   that reads env.SUPABASE_URL throws "Supabase is not configured for commerce
   features." and the page reports a configuration problem that does not exist.
   Copied from admin-returns.js, which is the working shape. */
async function requireAdmin(request, env, capability) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const admin = await verifyAdmin(env, token);
  if (!admin) throw new Error('Not authorised.');
  if (capability && !permsHave(admin.permissions, capability)) {
    throw new Error('Your role does not have permission for this action.');
  }
  return admin;
}

const money = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};

const when = (v) => {
  if (!v) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? `${v}T00:00:00.000Z` : String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/* The figure a shopper would be charged for this product/colour right now,
   read from the database rather than taken from the request. This is the
   "from" in the register, and it is the only reason the register is worth
   keeping — a log of new prices with no old ones records that something
   happened, which is what admin_audit_log already does for products. */
async function currentPriceCents(env, productId, colorVariantId) {
  const h = H(env);
  if (!h) return { cents: 0, memberCents: 0, title: '', colorName: '' };
  const base = env.SUPABASE_URL + '/rest/v1/';
  const [products, variants] = await Promise.all([
    fetch(`${base}products?select=id,title,current_price,member_price,msrp&id=eq.${productId}&limit=1`,
          { headers: h, cache: 'no-store' }).then((r) => r.ok ? r.json() : []).catch(() => []),
    colorVariantId
      ? fetch(`${base}color_variants?select=id,color_name,current_price,member_price,msrp&id=eq.${colorVariantId}&limit=1`,
              { headers: h, cache: 'no-store' }).then((r) => r.ok ? r.json() : []).catch(() => [])
      : Promise.resolve([]),
  ]);
  const product = (products || [])[0] || null;
  const variant = (variants || [])[0] || null;
  if (!product) return { cents: 0, memberCents: 0, title: '', colorName: '' };

  const ctx = await fetchPricingContext(env, [productId]);
  const r = resolvePrice({
    product, variant, rows: ctx.rows, lists: ctx.lists,
    /* Priced as an ordinary shopper: the register records the public price, not
       whatever the admin happens to qualify for. */
    shopper: shopperFor({ isMember: false }), now: Date.now(),
  });
  /* memberCents is what a MEMBER pays today, resolved separately rather than
     read off the same call: the line above deliberately prices as a guest, and
     the register needs both before-figures because "the price moved" and "the
     member price moved" are different statements. */
  const m = resolvePrice({
    product, variant, rows: ctx.rows, lists: ctx.lists,
    shopper: shopperFor({ isMember: true }), now: Date.now(),
  });
  return {
    cents: r.priceCents,
    memberCents: m.priceCents === r.priceCents ? 0 : m.priceCents,
    title: product.title || '',
    colorName: variant ? (variant.color_name || '') : '',
  };
}

async function writeAudit(env, row) {
  const h = H(env);
  if (!h) return;
  /* A rejected write was previously indistinguishable from a successful one:
     only a thrown error was caught, and PostgREST refusing a row (a CHECK
     constraint, a column added by a migration nobody ran) is a 4xx response
     rather than a throw. The register would quietly stop recording while every
     price change went on succeeding. It still must not fail the change — the
     price moved, and pretending otherwise helps nobody — but it says so. */
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/price_audit', {
    method: 'POST', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(row),
  }).catch((e) => { console.warn('price_audit write failed:', e && e.message); return null; });
  if (r && !r.ok) {
    const detail = await r.text().catch(() => '');
    console.warn(`price_audit rejected (${r.status}): ${detail.slice(0, 300)}`);
  }
}

/* ── What things actually sold for ──────────────────────────────────────────
 *
 * A persisted order line is `{ sku, name, size, color, amount, quantity }`, and
 * `amount` is in CENTS. It carries no product id — sku is the only identity —
 * so the join back to the catalogue is by sku, and a line whose product has
 * since been deleted still counts under its own name rather than vanishing.
 *
 * Exported so the arithmetic can be run over a table of orders in a test rather
 * than only through the network.
 */
export function summariseSold(orders, products) {
  const bySku = new Map((products || []).filter((p) => p && p.sku).map((p) => [String(p.sku), p]));

  /* One bucket shape, three groupings. An average is only meaningful over the
     units sold, not over the lines, so every bucket counts quantity — two
     shirts on one line is two sales at that price, not one. */
  const mk = () => ({ units: 0, revenueCents: 0, lowCents: 0, highCents: 0, orders: new Set(), prices: [] });
  const add = (map, key, label, extra, line, orderId) => {
    if (!key) return;
    let b = map.get(key);
    if (!b) { b = mk(); b.label = label; Object.assign(b, extra || {}); map.set(key, b); }
    const cents = Math.max(0, Math.round(Number(line.amount) || 0));
    const qty = Math.max(1, parseInt(line.quantity, 10) || 1);
    b.units += qty;
    b.revenueCents += cents * qty;
    b.lowCents = b.lowCents === 0 ? cents : Math.min(b.lowCents, cents);
    b.highCents = Math.max(b.highCents, cents);
    b.orders.add(orderId);
    /* Once per UNIT, not once per line. Two shirts on one line are two sales at
       that price, and a median taken over lines would call $32.50 the middle of
       "two at $30 and one at $35". Capped so a wholesale-sized quantity cannot
       turn one line into an unbounded array. */
    for (let n = 0; n < Math.min(qty, 500); n++) b.prices.push(cents);
  };

  const byProduct = new Map(), byColour = new Map(), byCategory = new Map();
  const sales = [];
  let counted = 0, skipped = 0;

  for (const order of (orders || [])) {
    const status = String(order && order.status || '').toLowerCase();
    if (status === 'refunded' || status === 'cancelled') { skipped++; continue; }
    let items = order && order.items;
    if (typeof items === 'string') { try { items = JSON.parse(items); } catch (_) { items = null; } }
    if (!Array.isArray(items) || !items.length) continue;
    counted++;

    for (const line of items) {
      if (!line) continue;
      const sku = String(line.sku || '').trim();
      const product = bySku.get(sku);
      const name = String(line.name || (product && product.title) || sku || 'Unknown');
      const colour = String(line.color || '').trim();
      /* "Uncategorised" rather than dropping the line: a product with no
         category still sold, and a total that silently omits it is worse than
         a bucket that admits what it is. */
      const category = String((product && product.category) || '').trim() || 'Uncategorised';
      const cents = Math.max(0, Math.round(Number(line.amount) || 0));
      const qty = Math.max(1, parseInt(line.quantity, 10) || 1);

      add(byProduct, sku || name, name, { sku, category, listedCents: Math.round((Number(product && product.current_price) || 0) * 100) }, line, order.id);
      add(byColour, (sku || name) + ' | ' + (colour || '—'), name, { sku, colour: colour || '—' }, line, order.id);
      add(byCategory, category, category, {}, line, order.id);

      sales.push({
        orderNumber: String(order.order_number || ''),
        at: order.created_at || '',
        sku, name, colour: colour || '', size: String(line.size || ''),
        soldCents: cents, quantity: qty, lineCents: cents * qty,
        category,
      });
    }
  }

  /* The median as well as the mean, because they answer different questions and
     one discount weekend pulls the mean somewhere the median will not go. */
  const median = (list) => {
    if (!list.length) return 0;
    const s = list.slice().sort((x, y) => x - y);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  };

  const finish = (map) => [...map.values()]
    .map((b) => ({
      label: b.label, sku: b.sku, colour: b.colour, category: b.category,
      units: b.units,
      orders: b.orders.size,
      revenueCents: b.revenueCents,
      avgCents: b.units ? Math.round(b.revenueCents / b.units) : 0,
      medianCents: median(b.prices),
      lowCents: b.lowCents, highCents: b.highCents,
      listedCents: b.listedCents || 0,
    }))
    .sort((x, y) => y.revenueCents - x.revenueCents);

  return {
    products: finish(byProduct),
    colours: finish(byColour),
    categories: finish(byCategory),
    /* Newest first, capped — the drill-down is for reading, not exporting. */
    sales: sales.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 500),
    ordersCounted: counted,
    ordersExcluded: skipped,
  };
}

/* ── GET: the board ─────────────────────────────────────────────────────── */
export async function onRequestGet({ request, env }) {
  try {
    const admin = await requireAdmin(request, env, 'pricing_write');
    const h = H(env);
    if (!h) return json({ ok: false, error: 'Not configured.' }, 503, cors(env));
    const base = env.SUPABASE_URL + '/rest/v1/';
    const url = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 500);

    /* ?quote=<product id> — what this product and each of its colourways cost
       TODAY, for a guest AND for a member.
       It lives here rather than on /api/prices because that endpoint is public
       and deliberately never says what a member pays: publishing one tier's
       price to anybody who asks is exactly what it withholds. The panel needs
       both figures to show "charged today", and the panel is already
       authenticated, so the admin gate is the right side of the line.
       Asked as two shoppers rather than one, because "member" is not a
       modifier on a price — it can select a different ROW entirely. */
    /* Comma-separated, because the product list beside the form shows what each
       product is CHARGED today and that is one question per product. Asking one
       at a time would be a round trip per row; resolving them in the panel
       instead would be a second implementation of the money rules, which is the
       fault this whole system was built to remove. */
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const quoteRaw = String(url.searchParams.get('quote') || '').trim();
    if (quoteRaw) {
      const quoteIds = [...new Set(quoteRaw.split(',').map((s) => s.trim()).filter((s) => UUID.test(s)))].slice(0, 200);
      if (!quoteIds.length) {
        return json({ ok: false, error: 'Bad product id.' }, 400, cors(env));
      }
      const quoteFor = quoteIds[0];
      const inList = `in.(${quoteIds.join(',')})`;
      const [prodRows, varRows] = await Promise.all([
        fetch(`${base}products?select=id,current_price,member_price,msrp&id=${inList}`,
              { headers: h, cache: 'no-store' }).then((r) => r.ok ? r.json() : []).catch(() => []),
        fetch(`${base}color_variants?select=id,product_id,color_name,current_price,member_price,msrp&product_id=${inList}`,
              { headers: h, cache: 'no-store' }).then((r) => r.ok ? r.json() : []).catch(() => []),
      ]);
      const allProducts = Array.isArray(prodRows) ? prodRows : [];
      const product = allProducts.find((p) => String(p.id) === String(quoteFor)) || allProducts[0];
      if (!product) return json({ ok: false, error: 'No such product.' }, 404, cors(env));

      const ctx = await fetchPricingContext(env, quoteIds);
      const now = Date.now();
      /* The same switch the storefront and the till read. With member pricing
         off, this panel must not print "Members pay $25" beside a product where
         nobody is charged $25 — the screen a merchant checks prices on is the
         last place a stale tier should survive. */
      let memberPricingOn = true;
      try {
        const cfg = sanitizeCommerceConfig(await getSetting(env, 'commerce_config', {}));
        memberPricingOn = cfg?.memberPricing?.enabled !== false;
      } catch (_) { memberPricingOn = true; }

      const both = (prod, variant) => {
        const g = resolvePrice({ product: prod, variant, rows: ctx.rows, lists: ctx.lists, shopper: shopperFor({ isMember: false }), now });
        const m = memberPricingOn
          ? resolvePrice({ product: prod, variant, rows: ctx.rows, lists: ctx.lists, shopper: shopperFor({ isMember: true }), now })
          : g;
        return {
          priceCents: g.priceCents,
          compareAtCents: g.compareAtCents,
          source: g.source,
          /* The row actually in effect, so the panel can offer to end THAT one
             rather than making somebody match dates by eye against a register. */
          priceId: g.priceId || '',
          priceListCode: g.priceListCode || '',
          memberPriceCents: m.priceCents,
          /* Only true when a member actually pays LESS. Equal figures mean
             there is no member price here, and saying "members pay $50" beside
             "charged $50" reads as a discount that does not exist. */
          memberDiffers: m.priceCents !== g.priceCents,
          memberSource: m.source,
        };
      };

      const variants = Array.isArray(varRows) ? varRows : [];
      const quoteOf = (prod) => ({
        productId: prod.id,
        base: both(prod, null),
        colours: variants
          .filter((v) => String(v.product_id) === String(prod.id))
          .map((v) => ({ id: v.id, colorName: v.color_name || '', ...both(prod, v) })),
      });

      const byProduct = allProducts.map(quoteOf);
      const first = byProduct.find((p) => String(p.productId) === String(quoteFor)) || byProduct[0];

      return json({
        ok: true, quote: true,
        /* `products` for the list beside the form; the single-product shape is
           kept alongside it so the selected-product panel does not have to
           unwrap an array it did not ask for. */
        products: byProduct,
        productId: first.productId,
        base: first.base,
        colours: first.colours,
        /* So the panel can say the member field is currently doing nothing,
           rather than accepting a figure and appearing to apply it. */
        memberPricing: memberPricingOn,
      }, 200, cors(env));
    }

    /* ?sold=<days> — what things ACTUALLY sold for.
       Every other figure on this screen is what the store INTENDS to charge.
       This is the only one that is a fact: it reads the line items off paid
       orders, where the amount was frozen at the moment the card went through.

       Aggregated on the server rather than in the panel for the same reason the
       quote is: an average is a number somebody will act on, and two
       implementations of it will disagree the first time a refund is involved.

       Refunded and cancelled orders are EXCLUDED. A refunded sale is not a sale,
       and leaving it in makes the average of what customers paid include money
       that was given back. */
    const soldRaw = url.searchParams.get('sold');
    if (soldRaw !== null) {
      const days = Math.min(Math.max(parseInt(soldRaw, 10) || 365, 1), 3650);
      const since = new Date(Date.now() - days * 86400000).toISOString();

      const [orders, products] = await Promise.all([
        fetch(`${base}orders?select=id,order_number,created_at,status,items&created_at=gte.${since}&order=created_at.desc&limit=2000`,
              { headers: h, cache: 'no-store' }).then((r) => r.ok ? r.json() : []).catch(() => []),
        fetch(`${base}products?select=id,sku,title,category,gender,current_price`,
              { headers: h, cache: 'no-store' }).then((r) => r.ok ? r.json() : []).catch(() => []),
      ]);

      return json({ ok: true, sold: true, days, ...summariseSold(orders, products) }, 200, cors(env));
    }

    const [lists, prices, audit] = await Promise.all([
      fetch(`${base}price_lists?select=*&order=priority.desc`, { headers: h, cache: 'no-store' })
        .then((r) => r.ok ? r.json() : []).catch(() => []),
      fetch(`${base}prices?select=*&order=created_at.desc&limit=${limit}`, { headers: h, cache: 'no-store' })
        .then((r) => r.ok ? r.json() : []).catch(() => []),
      fetch(`${base}price_audit?select=*&order=at.desc&limit=${limit}`, { headers: h, cache: 'no-store' })
        .then((r) => r.ok ? r.json() : []).catch(() => []),
    ]);

    return json({
      ok: true,
      lists: lists || [],
      prices: prices || [],
      audit: audit || [],
      /* So the panel can show "you proposed this" without a second round trip,
         and so self-approval can be labelled before it is committed. */
      you: admin.profile?.email || admin.email || '',
    }, 200, cors(env));
  } catch (e) {
    return json({ ok: false, error: e?.message || 'Could not load pricing.' }, 400, cors(env));
  }
}

/* ── POST: propose / approve / reject ───────────────────────────────────── */
export async function onRequestPost({ request, env }) {
  try {
    const admin = await requireAdmin(request, env, 'pricing_write');
    const actor = admin.profile?.email || admin.email || '';
    /* verifyAdmin spreads the auth user, so `admin.id` is the user id. `userId`
       was never a field on it — it would have made every audit row anonymous. */
    const actorId = admin.profile?.id || admin.id || null;
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || '').trim();
    const h = H(env);
    if (!h) return json({ ok: false, error: 'Not configured.' }, 503, cors(env));
    const base = env.SUPABASE_URL + '/rest/v1/';

    if (action === 'propose') {
      const productId = String(body.productId || '').trim();
      const colorVariantId = String(body.colorVariantId || '').trim() || null;
      const listId = String(body.priceListId || '').trim();
      const amount = money(body.amount);
      if (!productId || !listId) return json({ ok: false, error: 'A product and a price list are required.' }, 400, cors(env));
      if (amount === null || amount <= 0) {
        /* Zero is refused rather than stored. The resolver ignores a zero row
           and falls back, so storing one would create a change that appears in
           the register, appears approved, and prices nothing. */
        return json({ ok: false, error: 'A price above zero is required.' }, 400, cors(env));
      }

      const startsAt = when(body.startsAt);
      const endsAt = when(body.endsAt);
      if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
        return json({ ok: false, error: 'The end date must be after the start date.' }, 400, cors(env));
      }

      /* Refused rather than stored-and-ignored. The resolver already declines
         to honour a member price at or above the regular one, but storing it
         would leave an approved row that reads as a member discount and is not
         one — the register would show a movement nobody ever received. */
      const memberPrice = money(body.memberPrice);
      if (memberPrice !== null && memberPrice >= amount) {
        return json({ ok: false, error: 'The member price must be below the price.' }, 400, cors(env));
      }

      const before = await currentPriceCents(env, productId, colorVariantId);

      const insert = await fetch(base + 'prices', {
        method: 'POST', headers: { ...h, Prefer: 'return=representation' },
        body: JSON.stringify({
          price_list_id: listId, product_id: productId, color_variant_id: colorVariantId,
          amount, member_price: memberPrice, compare_at: money(body.compareAt),
          starts_at: startsAt, ends_at: endsAt,
          status: 'proposed', note: String(body.note || '').slice(0, 500),
          created_by: actorId,
        }),
      });
      if (!insert.ok) {
        const detail = await insert.text().catch(() => '');
        return json({ ok: false, error: 'Could not save that change. ' + detail.slice(0, 200) }, 502, cors(env));
      }
      const saved = (await insert.json().catch(() => []))[0] || {};

      await writeAudit(env, {
        actor_id: actorId, actor_email: actor, action: 'proposed',
        price_id: saved.id || null, product_id: productId,
        product_title: before.title, color_name: before.colorName,
        from_amount: before.cents / 100, to_amount: amount,
        from_member_amount: before.memberCents ? before.memberCents / 100 : null,
        to_member_amount: memberPrice,
        to_compare_at: money(body.compareAt),
        starts_at: startsAt, ends_at: endsAt,
        note: String(body.note || '').slice(0, 500),
      });

      return json({ ok: true, price: saved }, 200, cors(env));
    }

    if (action === 'approve' || action === 'reject') {
      const priceId = String(body.priceId || '').trim();
      if (!priceId) return json({ ok: false, error: 'Missing price id.' }, 400, cors(env));

      const rows = await fetch(`${base}prices?select=*&id=eq.${priceId}&limit=1`, { headers: h, cache: 'no-store' })
        .then((r) => r.ok ? r.json() : []).catch(() => []);
      const price = (rows || [])[0];
      if (!price) return json({ ok: false, error: 'That change no longer exists.' }, 404, cors(env));
      if (price.status !== 'proposed') {
        return json({ ok: false, error: `That change is already ${price.status}.` }, 409, cors(env));
      }

      const selfApproved = Boolean(price.created_by && actorId && String(price.created_by) === String(actorId));

      if (action === 'approve' && selfApproved) {
        /* Allowed by default, refused when the list demands a second pair of
           eyes. The check is here rather than in the UI because a rule enforced
           only in a form is a rule enforced only for people using the form. */
        const listRows = await fetch(`${base}price_lists?select=require_second_approver,name&id=eq.${price.price_list_id}&limit=1`,
                                     { headers: h, cache: 'no-store' })
          .then((r) => r.ok ? r.json() : []).catch(() => []);
        if ((listRows || [])[0]?.require_second_approver) {
          return json({
            ok: false,
            error: `${(listRows[0].name || 'This list')} requires a second person to approve a change. Ask another admin with pricing access to review it.`,
          }, 403, cors(env));
        }
      }

      const patch = action === 'approve'
        ? { status: 'approved', approved_by: actorId, approved_at: new Date().toISOString() }
        : { status: 'rejected', rejected_by: actorId, rejected_at: new Date().toISOString() };

      const upd = await fetch(`${base}prices?id=eq.${priceId}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      if (!upd.ok) return json({ ok: false, error: 'Could not update that change.' }, 502, cors(env));

      const before = await currentPriceCents(env, price.product_id, price.color_variant_id);
      await writeAudit(env, {
        actor_id: actorId, actor_email: actor, action: action === 'approve' ? 'approved' : 'rejected',
        price_id: priceId, product_id: price.product_id,
        product_title: before.title, color_name: before.colorName,
        from_amount: before.cents / 100,
        to_amount: action === 'approve' ? price.amount : null,
        starts_at: price.starts_at, ends_at: price.ends_at,
        self_approved: action === 'approve' ? selfApproved : false,
        note: String(body.note || '').slice(0, 500),
      });

      return json({ ok: true, status: patch.status, selfApproved }, 200, cors(env));
    }

    /* ── end: stop an approved price from pricing anything, from now ──────────
       Without this the only verb was "propose", so raising a price meant adding
       a SECOND open-ended row beside the first and hoping the resolver preferred
       it. Both rows stayed live forever and the tie-break decided — which is how
       a $30 row went on pricing a product somebody had already moved to $32.

       Ended rather than deleted: a price that charged real customers real money
       is a record, and the register is the thing an accountant reads. ends_at is
       set to now, so the row keeps its history and stops applying in the same
       stroke. */
    if (action === 'end') {
      const priceId = String(body.priceId || '').trim();
      if (!priceId) return json({ ok: false, error: 'Missing price id.' }, 400, cors(env));

      const rows = await fetch(`${base}prices?select=*&id=eq.${priceId}&limit=1`, { headers: h, cache: 'no-store' })
        .then((r) => r.ok ? r.json() : []).catch(() => []);
      const price = (rows || [])[0];
      if (!price) return json({ ok: false, error: 'That price no longer exists.' }, 404, cors(env));
      if (price.status !== 'approved') {
        return json({ ok: false, error: `Only an approved price can be ended — that one is ${price.status}. Reject it instead.` }, 409, cors(env));
      }
      const already = price.ends_at && Date.parse(price.ends_at) <= Date.now();
      if (already) return json({ ok: false, error: 'That price has already ended.' }, 409, cors(env));

      /* What it was charging, read BEFORE the change, so the register records a
         movement rather than a number with no counterpart. */
      const before = await currentPriceCents(env, price.product_id, price.color_variant_id);
      const endsAt = new Date().toISOString();

      /* A row whose window has not opened yet cannot be given an end date of
         now: prices_window_ordered demands ends_at > starts_at, so the PATCH
         would be refused and the button would fail on exactly the rows it is
         most useful for — a scheduled change somebody wants to call off.
         Nothing was ever charged under it, so there is no live window to close;
         it is marked superseded instead, which priceIsLive already declines to
         honour because it only ever considers 'approved'. */
      const notYetStarted = price.starts_at && Date.parse(price.starts_at) > Date.now();
      const patch = notYetStarted
        ? { status: 'superseded' }
        : { ends_at: endsAt };

      const upd = await fetch(`${base}prices?id=eq.${priceId}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
      if (!upd.ok) {
        const detail = await upd.text().catch(() => '');
        return json({ ok: false, error: 'Could not end that price. ' + detail.slice(0, 200) }, 502, cors(env));
      }

      /* Resolved again afterwards so "what it reverts to" is the resolver's
         answer and not a guess about which row is next in line. */
      const after = await currentPriceCents(env, price.product_id, price.color_variant_id);

      await writeAudit(env, {
        /* 'superseded', not 'ended': price_audit.action carries a CHECK
           constraint and 'ended' is not one of its values. Writing it would have
           been rejected by the database and swallowed by writeAudit, so the
           price would stop and the register would never mention it — a silent
           hole in the one record this system exists to keep. 'superseded' is in
           the constraint and means what happened. */
        actor_id: actorId, actor_email: actor, action: 'superseded',
        price_id: priceId, product_id: price.product_id,
        product_title: before.title, color_name: before.colorName,
        from_amount: before.cents / 100,
        to_amount: after.cents / 100,
        from_member_amount: before.memberCents ? before.memberCents / 100 : null,
        to_member_amount: after.memberCents ? after.memberCents / 100 : null,
        starts_at: price.starts_at, ends_at: endsAt,
        note: String(body.note || '').slice(0, 500),
      });

      return json({ ok: true, endsAt, revertsToCents: after.cents }, 200, cors(env));
    }

    return json({ ok: false, error: 'Unsupported action.' }, 400, cors(env));
  } catch (e) {
    return json({ ok: false, error: e?.message || 'Could not change pricing.' }, 400, cors(env));
  }
}
