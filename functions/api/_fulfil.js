/**
 * _fulfil.js — everything that happens AFTER a payment succeeds.
 *
 * Lifted out of stripe-webhook.js unchanged. It lived there because Stripe was
 * the only way to pay, and leaving it there would have forced a second
 * processor to either import that route — dragging the Stripe SDK into a worker
 * with no use for it — or write fulfilment again.
 *
 * The second option is the one that matters. Two implementations of "an order
 * happened" drift, and they drift where nobody looks: stock decremented on one
 * path and not the other, loyalty points awarded twice, a confirmation email
 * that goes out for card payments only. This is the same reasoning that split
 * _cart-pricing.js out, and the same shape of bug it was avoiding.
 *
 * WHAT WAS STRIPE-SPECIFIC IN HERE: one call.
 *   stripe.paymentIntents.update(pi.id, { metadata: { tracking_number, ... } })
 * It is now an injected `onTracking` callback, so the Stripe route can still
 * write tracking back onto its PaymentIntent and a route with no PaymentIntent
 * simply passes nothing.
 *
 * Everything else was already processor-agnostic: it runs off a flat `meta`
 * object and a payment object needing only id, amount, currency and metadata.
 * A processor that can produce that shape gets fulfilment for free — which is
 * the whole point of moving it.
 */

import { fetchSiteSettings, resolveSetting } from './_settings.js';
import { sendOrderAlerts } from './_order-alerts.js';
import { mutateSetting } from './_commerce.js';
import { notifyOps } from './_notify-ops.js';
import { loopsFallback, orderStatusUrl } from './_email.js';
import { getEmailAppearance, getEmailContent, fillTemplate, renderEmailShell } from './_email-theme.js';
import { buildUserData, sendCapiEvents } from './_capi.js';
import { attributionFromMeta } from './_attribution.js';
import { veeqoBookShipment } from './_veeqo.js';
import { incrementShippoMonthlyCount, recordLabelFailure } from './_shipping-usage.js';
import { recordTaxSale } from './_tax.js';
import { shipFrom } from './_ship-from.js';
import { mintOrderToken } from './_order-token.js';
import { capture as captureStoredValue, issue as issueStoredValue } from './_stored-value.js';
/* One function decides what an order is called. Spelling the fallback out
   here again is how a store ends up with six names for one order. */
import { orderNoPlain } from './_order-no.js';

const SERVICE_TOKEN_MAP = {
  'Priority Mail':         'usps_priority',
  'Ground Advantage':      'usps_ground_advantage',
  'Priority Mail Express': 'usps_priority_express',
  'First-Class Mail':      'usps_first',
  'UPS Ground':            'ups_ground',
  'UPS 2nd Day Air':       'ups_second_day_air',
  'FedEx Ground':          'fedex_ground',
  'FedEx 2Day':            'fedex_2_day',
};
const getServicelevelToken = (name) => SERVICE_TOKEN_MAP[name] || 'usps_ground_advantage';
export const getSupabaseServiceKey = (env) => env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;

// instead of the product's default image (two colours of the same product would
// otherwise show an identical picture). Keyed by `${key}::${colour}` where key is
// the product id, sku (lowercased) or title (lowercased+trimmed); the value is the
// colour variant's first image (lowest sort_order), taken from product_images via
// its color_variant_id.
async function fetchVariantImageMap(env, serviceKey) {
  const map = {};
  if (!env.SUPABASE_URL || !serviceKey) return map;
  const H = { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } };
  try {
    // Three plain fetches joined in JS (no PostgREST embeds, so it doesn't depend
    // on FK auto-detection): colour variants, products (for sku/title keys), and
    // the images that belong to a colour variant.
    const [cvRes, prRes, piRes] = await Promise.all([
      fetch(env.SUPABASE_URL + '/rest/v1/color_variants?select=id,product_id,color_name&limit=5000', H),
      fetch(env.SUPABASE_URL + '/rest/v1/products?select=id,sku,title&limit=2000', H),
      fetch(env.SUPABASE_URL + '/rest/v1/product_images?select=image_url,sort_order,color_variant_id&color_variant_id=not.is.null&limit=10000', H),
    ]);
    const cvs = cvRes.ok ? await cvRes.json().catch(() => []) : [];
    const prs = prRes.ok ? await prRes.json().catch(() => []) : [];
    const pis = piRes.ok ? await piRes.json().catch(() => []) : [];
    const prodById = {};
    for (const p of prs || []) if (p && p.id) prodById[p.id] = p;
    // color_variant_id -> first image (lowest sort_order)
    const imgByVariant = {};
    for (const pi of pis || []) {
      if (!pi || !pi.color_variant_id || !pi.image_url) continue;
      const so = pi.sort_order == null ? 9999 : pi.sort_order;
      const cur = imgByVariant[pi.color_variant_id];
      if (!cur || so < cur.so) imgByVariant[pi.color_variant_id] = { url: pi.image_url, so };
    }
    for (const cv of cvs || []) {
      if (!cv || !cv.color_name) continue;
      const rec = imgByVariant[cv.id];
      if (!rec) continue;
      const colour = cv.color_name.trim().toLowerCase();
      const prod = prodById[cv.product_id] || {};
      if (cv.product_id) map[cv.product_id + '::' + colour] = rec.url;
      if (prod.sku)      map[prod.sku.toLowerCase() + '::' + colour] = rec.url;
      if (prod.title)    map[prod.title.trim().toLowerCase() + '::' + colour] = rec.url;
    }
  } catch (_) { /* non-fatal — falls back to the product default image */ }
  return map;
}

// Best image for an order item: the item's COLOUR variant photo first, then any
// image the item already carries, then the product default (`defaults` = a
// {id|sku|title -> image_url} map).
function pickItemImage(item, variantMap, defaults) {
  const colour = (item.color || item.colorName || item.c || '').trim().toLowerCase();
  const pid  = item.productId || item.product_id;
  const sku  = (item.sku  || '').toLowerCase();
  const name = (item.name || item.title || '').trim().toLowerCase();
  if (colour) {
    const v = (pid && variantMap[pid + '::' + colour])
           || (sku  && variantMap[sku  + '::' + colour])
           || (name && variantMap[name + '::' + colour]);
    if (v) return v;
  }
  return item.image
      || (pid && defaults[pid])
      || (sku  && defaults[sku])
      || (name && defaults[name])
      || '';
}

/* Radar scores live on the charge, not the PaymentIntent, and the charge is
   only present when the webhook payload expanded it. Reading it defensively
   rather than assuming: an outcome that is not there must yield null, never a
   guess, because a fabricated 'normal' is indistinguishable from a real one the
   moment anyone looks at the numbers. */
function riskOf(pi) {
  const charge = (pi && pi.charges && Array.isArray(pi.charges.data) && pi.charges.data[0])
    || (pi && typeof pi.latest_charge === 'object' ? pi.latest_charge : null);
  const outcome = charge && charge.outcome;
  if (!outcome) return { level: null, score: null };
  const level = typeof outcome.risk_level === 'string' ? outcome.risk_level : null;
  const score = Number.isInteger(outcome.risk_score) ? outcome.risk_score : null;
  return { level, score };
}

/* Claim this delivery, or report that someone else already has.
   Returns TRUE only when we are certain it was handled before. Every other
   outcome — table absent, network wobble, unexpected status — returns false and
   lets the handler run, because a missed dedupe costs a duplicate order and a
   false dedupe costs the order entirely. */

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export async function handleSuccessfulPayment(pi, meta, env, onTracking) {
  /* ── THE GIFT CARD IS SPENT FIRST, BEFORE ANYTHING ELSE HAPPENS ────────────
     The card was RESERVED when the payment was created; this is where the
     reservation becomes a payment. It runs before the label, the order row and
     the email, because those are all things that can be repaired afterwards and
     an uncaptured hold is not: it expires quietly, hands the balance back to a
     customer who has already been shipped the goods, and nothing anywhere says
     it happened.

     Idempotent in the database, which matters more here than anywhere else in
     this file — a Stripe webhook is delivered more than once by design, and the
     second delivery must not spend the balance a second time. See
     zw_stored_value_capture in migration 0030.

     A failure is logged and does NOT stop fulfilment. The customer's card has
     already been charged for the remainder; refusing to ship because the ledger
     is unreachable would turn a bookkeeping problem into a missing order. */
  if (meta.stored_value_ref) {
    try {
      const cap = await captureStoredValue(env, meta.stored_value_ref, meta.order_number || pi.id);
      if (!cap.ok) {
        console.error('stored value NOT captured for', meta.order_number, '—', cap.reason,
          '— expected', meta.stored_value_cents, 'cents from', meta.stored_value_code);
      }
    } catch (e) {
      console.error('stored value capture threw for', meta.order_number, '—', e && e.message);
    }
  }

  /* ── GIFT CARDS BOUGHT ON THIS ORDER ──────────────────────────────────────
     The other direction: that block SPENDS a balance, this one CREATES the
     balances somebody just paid for.

     Its own metadata key rather than a flag on the line items, because those
     are trimmed to fit Stripe's 500-char cap and the trim drops everything but
     sku/name/amount/quantity — so on a big cart, which is the cart most likely
     to hold gift cards, the flag would vanish and nothing would be issued. The
     customer would be charged for cards that never existed.

     ONE CODE PER CARD. Forty people cannot share one, which is why quoteCart
     refuses more than a hundred on an order: this loop is one write each, and
     the cart's own limits would otherwise permit 2,475 of them.

     ISSUED BEFORE THE EMAILS BELOW, so the confirmation can carry the codes.
     Failure is logged and does not stop fulfilment — the card has been charged
     and the goods, if any, still have to go. What it leaves behind is an order
     that is short some codes, which is recoverable by hand from the Coupons
     page; refusing to fulfil would lose the whole order to save the recovery. */
  const giftCardCodes = await issueGiftCardsFor(meta, env);

  // Pre-fetch email keys + branding from Supabase api_key_overrides (admin overrides take priority)
  const emailKeyCache = await fetchSiteSettings(
    ['RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM', 'BRAND_LOGO_URL',
     'LOOPS_API_KEY', 'LOOPS_TRANSACTIONAL_ID',
     'fonts', 'brand', 'email_theme', 'email_settings'], env
  );

  // Step 1: Purchase the shipping label → gets tracking number.
  // Hand-delivery orders are dropped off in person, so there is no label and no
  // tracking number (the confirmation email then goes out without tracking).
  let labelData = null;
  if (meta.delivery_method === 'hand_delivery') {
    console.log('Hand-delivery order — skipping shipping label for', pi.id);
  } else {
    try {
      labelData = await createShippingLabel(pi, meta, env);
      console.log('Label created:', labelData?.tracking_number);
    } catch (e) {
      console.error('Label creation failed:', e.message);
      // Surface it on the admin dashboard (a declined card on the Shippo/Veeqo
      // account would otherwise fail silently), then continue — still save the
      // order and send the email without tracking.
      await recordLabelFailure(env, {
        order: meta.order_number,
        pi: pi.id,
        source: meta.shipping_source || 'shippo',
        error: e.message,
      });
    }
  }

  const tracking = {
    number: labelData?.tracking_number || '',
    url:    labelData?.tracking_url_provider || '',
    label:  labelData?.label_url || '',
  };

  /* Saving the order must not be able to cancel everything after it.

     It could, and did. This line threw, and the confirmation email, the
     tracking write-back, the stock decrement, the loyalty points and the CAPI
     event are all BELOW it — so one rejected insert silently took out the whole
     of fulfilment. The customer paid, got nothing, and the only trace was a
     console.error in a Worker log.

     What triggered it was a single new column written before its migration had
     been run: PostgREST rejects the whole row for one unknown field. That is a
     mistake anyone can make again, and the cost of making it should be one
     missing order row, not a silent outage across every order.

     So: the failure is caught, shouted about, and the rest of fulfilment
     continues. A customer who has been charged gets their confirmation even
     when our bookkeeping fell over — and somebody finds out that it did. */
  let orderSaved = true;
  try {
    await saveOrderToSupabase(pi, meta, tracking, env);
  } catch (e) {
    orderSaved = false;
    console.error('ORDER NOT SAVED for', pi.id, '—', e && e.message);
    /* Loudest channel available. An order taken and not recorded is the worst
       state this system has: the money moved and nothing knows about it. */
    try {
      await notifyOps(env, {
        key: 'order-save-failed',
        severity: 'critical',
        event: 'Order was paid but NOT saved',
        detail: 'Payment ' + pi.id + ' (' + (meta.order_number || 'no number') + ') was charged '
          + 'but the order row could not be written. The customer has been billed. '
          + 'Reason: ' + ((e && e.message) || 'unknown'),
      });
    } catch (_) { /* alerting failing must not compound the original failure */ }
  }

  // Abandoned-cart: this shopper completed checkout, so mark their saved cart
  // recovered — no recovery email should go out. Best-effort, never blocks.
  try {
    const _svc = getSupabaseServiceKey(env);
    const _acEmail = String(meta.customer_email || '').trim().toLowerCase();
    if (_svc && env.SUPABASE_URL && _acEmail) {
      fetch(`${env.SUPABASE_URL}/rest/v1/abandoned_carts?email=eq.${encodeURIComponent(_acEmail)}`, {
        method: 'PATCH',
        headers: { apikey: _svc, Authorization: 'Bearer ' + _svc, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ recovered_at: new Date().toISOString() }),
      }).catch(() => {});
    }
  } catch (_) {}

  const [stripeUpdateResult, emailResult, invResult, promoResult, capiResult, loyaltyResult, referralResult, taxFilingResult] = await Promise.allSettled([
    /* Writing tracking back onto the payment record is the one thing here that
       was ever processor-specific. The Stripe route passes a callback that
       updates its PaymentIntent; a processor with nothing to write back passes
       nothing and this resolves to null. */
    (tracking.number && typeof onTracking === 'function')
      ? onTracking(tracking)
      : Promise.resolve(null),

    sendConfirmationEmail(pi, meta, tracking, env, emailKeyCache),

    // Decrement product_sizes stock_quantity for each purchased item
    decrementInventory(meta, env),

    // Increment promotion usage count
    incrementPromoUsage(meta.discount_code, env),

    // Mirror the browser Purchase pixel server-side (survives ad blockers;
    // deduped against the browser event by event_id = purchase_<pi.id>).
    sendPurchaseEvent(pi, meta, env),

    // Credit loyalty points (signed-in shoppers only). Non-fatal by design —
    // a points failure must never affect the order.
    awardLoyaltyPoints(pi, meta, env),

    // If the order used someone's referral code, pay the referrer.
    creditReferrer(pi, meta, env),

    /* Tell the tax provider the sale completed, so it has something to file.
       Whichever provider is configured — this code does not know or care which,
       which is the point: switching from Stripe Tax to TaxJar is a setting, not
       a change here. Engines with nothing to file (the built-in table, Zip-Tax)
       skip themselves. Non-fatal like everything else in this list: the money
       is already taken, so a provider outage is a bookkeeping retry rather than
       a reason to fail an order. */
    reportSaleToTaxProvider(pi, meta, env),
  ]);

  if (stripeUpdateResult.status === 'rejected') console.error('Tracking write-back failed:', stripeUpdateResult.reason);
  if (emailResult.status     === 'rejected') console.error('Email failed:',                   emailResult.reason);
  if (invResult.status       === 'rejected') console.error('Inventory decrement failed:',     invResult.reason);
  if (promoResult.status     === 'rejected') console.error('Promo usage increment failed:',   promoResult.reason);
  if (capiResult.status      === 'rejected') console.error('CAPI Purchase failed:',           capiResult.reason);
  if (loyaltyResult.status   === 'rejected') console.error('Loyalty points failed:',          loyaltyResult.reason);
  if (referralResult.status  === 'rejected') console.error('Referral credit failed:',         referralResult.reason);
  if (taxFilingResult.status === 'rejected') console.error('Tax filing record failed:',       taxFilingResult.reason);
}

/* Report the completed sale to whichever tax provider priced it.

   A calculation is a quote, not a record: both Stripe Tax and TaxJar bill for
   pricing an order and file from a separate list of sales they were told
   completed. Nothing here ever told them, so the store was paying to calculate
   and would have arrived at filing season with nothing to file from.

   This does not know which provider is configured, and must not learn — that is
   what makes switching one a setting rather than a change to this file.

   The provider's id for the recorded transaction is written back onto the
   PaymentIntent, because a refund later has to reverse THAT transaction, and
   the intent is the one place both halves can reach without a new column. */
async function reportSaleToTaxProvider(pi, meta, env) {
  const result = await recordTaxSale({
    env,
    ref: meta.tax_ref || '',
    order: {
      orderNumber: meta.order_number || pi.id,
      createdAt: new Date((pi.created || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      subtotalCents: parseInt(meta.subtotal_amount_cents || '0', 10),
      shippingCents: parseInt(meta.charged_shipping_cents || '0', 10),
      taxCents: parseInt(meta.tax_amount_cents || '0', 10),
      address: {
        line1: meta.ship_line1 || '', city: meta.ship_city || '',
        state: meta.ship_state || '', zip: meta.ship_zip || '',
        country: meta.ship_country || 'US',
      },
    },
  });

  if (result.skipped) return result;
  if (!result.ok) {
    /* Loud, because nothing else will notice: the order is fine and the
       customer was charged correctly. What is missing is the filing record. */
    console.error('[tax] sale NOT reported to ' + result.engine + ':', result.error);
    return result;
  }

  /* Where this reference is kept decides whether a refund can ever reverse the
     filing. It used to be written as metadata onto the Stripe PaymentIntent,
     which works for exactly as long as Stripe is the only processor: a PayPal
     order has no intent, that call fails, the id is lost, and the refund later
     reverses nothing. The store then pays tax on a sale that came back —
     silently, because this whole block is best-effort by design and a failure
     here must not fail an order that has already taken money.

     The order row is the processor-agnostic home (0019), and it is where the
     refund route is already looking for everything else about the order. */
  if (result.id) {
    const key = getSupabaseServiceKey(env);
    if (env.SUPABASE_URL && key && pi.id) {
      try {
        await fetch(env.SUPABASE_URL + '/rest/v1/orders?stripe_payment_intent_id=eq.'
          + encodeURIComponent(pi.id), {
          method: 'PATCH',
          headers: {
            apikey: key, Authorization: 'Bearer ' + key,
            'Content-Type': 'application/json', Prefer: 'return=minimal',
          },
          body: JSON.stringify({ tax_txn: result.id }),
        });
      } catch (e) {
        console.error('[tax] filed ' + result.id + ' but could not store it on the order:', e.message);
      }
    }
  }
  return result;
}

// Pay the referrer when an order used their code. Guards: no self-referral, and
// one credit per order (Stripe can retry a webhook).
async function creditReferrer(pi, meta, env) {
  const serviceKey = getSupabaseServiceKey(env);
  if (!env.SUPABASE_URL || !serviceKey) return;
  const code = String(meta.discount_code || '').trim();
  if (!code) return;

  const H = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' };

  const settingsRows = await fetch(`${env.SUPABASE_URL}/rest/v1/site_settings?select=value&key=eq.referral_settings&limit=1`, { headers: H })
    .then((r) => (r.ok ? r.json() : [])).catch(() => []);
  let s = settingsRows && settingsRows[0] && settingsRows[0].value;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch (_) { s = null; } }
  s = s || {};
  if (s.enabled !== true) return;
  const points = Math.floor(Number(s.referrerPoints) > 0 ? Number(s.referrerPoints) : 0);
  if (points <= 0) return;

  /* Referrals pay in loyalty points, and loyalty can be switched off
     independently — which it currently is, while referrals are on. The points
     are still banked, deliberately: they cost nothing to store and they become
     real the moment loyalty is enabled, whereas dropping them loses a reward
     somebody genuinely earned and there is no record to reconstruct it from.
     What must NOT happen is this staying quiet. Somebody referred a friend and
     was promised 100 points; until loyalty is on, that promise is unspendable
     and only the shop owner can fix it. */
  try {
    const loyRows = await fetch(`${env.SUPABASE_URL}/rest/v1/site_settings?select=value&key=eq.loyalty_settings&limit=1`, { headers: H })
      .then((r) => (r.ok ? r.json() : [])).catch(() => []);
    let loy = loyRows && loyRows[0] && loyRows[0].value;
    if (typeof loy === 'string') { try { loy = JSON.parse(loy); } catch (_) { loy = null; } }
    if (!loy || loy.enabled !== true) {
      await notifyOps(env, {
        key: 'referral-points-unspendable',
        severity: 'warn',
        event: 'A referral earned points that cannot be spent',
        detail: 'Referrals are switched ON and award ' + points + ' points, but the loyalty '
          + 'programme is switched OFF — so there is nowhere for the referrer to see or redeem '
          + 'them. The points are being banked and will become real if you enable loyalty. '
          + 'Either turn loyalty on (Admin → Loyalty) or set referrerPoints to 0.',
      });
    }
  } catch (_) { /* the award below matters more than the warning about it */ }

  // Is this code somebody's referral code?
  const owners = await fetch(`${env.SUPABASE_URL}/rest/v1/referral_codes?select=user_id&code=eq.${encodeURIComponent(code)}&limit=1`, { headers: H })
    .then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const referrerId = owners && owners[0] && owners[0].user_id;
  if (!referrerId) return;

  // Don't pay someone for referring themselves.
  if (String(meta.user_id || '').trim() === String(referrerId)) return;

  // Already credited for this order? (webhook retries)
  const dupe = await fetch(`${env.SUPABASE_URL}/rest/v1/loyalty_ledger?select=id&user_id=eq.${encodeURIComponent(referrerId)}&reason=eq.referral&order_id=eq.${encodeURIComponent(pi.id)}&limit=1`, { headers: H })
    .then((r) => (r.ok ? r.json() : [])).catch(() => []);
  if (dupe && dupe.length) return;

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/loyalty_ledger`, {
    method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: referrerId, points, reason: 'referral', order_id: pi.id, promo_code: code }),
  });
  if (!res.ok) throw new Error('referral credit insert failed: ' + (await res.text().catch(() => '')));
}

// Credit points for a purchase. Guests (no user_id) earn nothing — there's no
// account to credit. Rules live in site_settings.loyalty_settings.
async function awardLoyaltyPoints(pi, meta, env) {
  const serviceKey = getSupabaseServiceKey(env);
  if (!env.SUPABASE_URL || !serviceKey) return;
  const userId = String(meta.user_id || '').trim();
  if (!userId) return;

  const H = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' };
  const rows = await fetch(`${env.SUPABASE_URL}/rest/v1/site_settings?select=value&key=eq.loyalty_settings&limit=1`, { headers: H })
    .then((r) => (r.ok ? r.json() : [])).catch(() => []);
  let v = rows && rows[0] && rows[0].value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
  v = v || {};
  if (v.enabled !== true) return;

  const perDollar = Number(v.pointsPerDollar) > 0 ? Number(v.pointsPerDollar) : 1;
  const minOrder = Number(v.minOrderToEarn) > 0 ? Number(v.minOrderToEarn) : 0;
  const subtotalCents = parseInt(meta.subtotal_amount_cents || '0', 10) || 0;
  // Orders under the admin's threshold earn nothing.
  if (minOrder > 0 && subtotalCents < Math.round(minOrder * 100)) return;
  const points = Math.floor((subtotalCents / 100) * perDollar);
  if (points <= 0) return;

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/loyalty_ledger`, {
    method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: userId, points, reason: 'purchase', order_id: pi.id }),
  });
  if (!res.ok) throw new Error('loyalty_ledger insert failed: ' + (await res.text().catch(() => '')));
}

// ─── Meta Conversions API: server-side Purchase ────────────────────────────────
// Fires Purchase straight to Meta from the server, so it lands even when the
// shopper's browser blocked the pixel. event_id matches the browser Purchase
// (purchase_<pi.id>) so Meta keeps a single de-duplicated event. No-op until
// META_CAPI_TOKEN is set. Never throws (sendCapiEvents swallows failures).

async function sendPurchaseEvent(pi, meta, env) {
  if (!env.META_CAPI_TOKEN) return;

  const nameParts = String(meta.customer_name || '').trim().split(/\s+/).filter(Boolean);
  const firstName = nameParts.shift() || '';
  const lastName  = nameParts.join(' ');

  // content_ids / contents from the compact inv metadata ({p,s,q,c}[]).
  let inv = [];
  try { inv = JSON.parse(meta.inv || '[]'); } catch (_) {}
  const contentIds = [...new Set((inv || []).map((x) => x && x.p).filter(Boolean))];
  const contents   = (inv || []).filter((x) => x && x.p).map((x) => ({ id: x.p, quantity: Number(x.q) || 1 }));
  const numItems   = (inv || []).reduce((n, x) => n + (Number(x && x.q) || 0), 0);

  // Match the browser Purchase value (merchandise subtotal); fall back to the
  // charged amount for older intents that predate the subtotal metadata.
  const subtotalCents = parseInt(meta.subtotal_amount_cents || '', 10);
  const valueDollars  = Number.isFinite(subtotalCents) && subtotalCents > 0
    ? subtotalCents / 100
    : (pi.amount || 0) / 100;

  /* fbp / fbc — Meta's own browser identifiers, and by a wide margin the
     strongest match keys it has. buildUserData() has always accepted them
     (_capi.js) and this call has always omitted them, so the server-side
     Purchase built specifically to land when the pixel was blocked was matching
     on hashed email and address alone. Nothing reported that: Meta answers 200
     either way and simply attributes less.

     They arrive in metadata because the browser is the only thing that can read
     them and the webhook is the only thing that runs at this point. Absent —
     consent declined, or an order placed before this shipped — they are simply
     left out, which is what buildUserData does with an empty value. */
  const user_data = await buildUserData({
    email:   meta.customer_email,
    firstName, lastName,
    city:    meta.ship_city,
    state:   meta.ship_state,
    zip:     meta.ship_zip,
    country: meta.ship_country || 'US',
    fbp:     meta.fbp || '',
    fbc:     meta.fbc || '',
  });

  const custom_data = {
    currency: (pi.currency || 'usd').toUpperCase(),
    value:    Number(valueDollars.toFixed(2)),
  };
  if (contentIds.length) { custom_data.content_type = 'product_group'; custom_data.content_ids = contentIds; }
  if (contents.length)   custom_data.contents = contents;
  if (numItems > 0)      custom_data.num_items = numItems;

  await sendCapiEvents(env, [{
    event_name:       'Purchase',
    event_time:       Math.floor(Date.now() / 1000),
    event_id:         'purchase_' + pi.id,
    action_source:    'website',
    event_source_url: 'https://zuwera.store/checkout',
    user_data,
    custom_data,
  }]);
}

// ─── Create shipping label ─────────────────────────────────────────────────────

async function createShippingLabel(pi, meta, env) {
  // Veeqo-sourced rate → book via Veeqo (label returned as a base64 data URL).
  if (meta.shipping_source === 'veeqo') {
    const cache = await fetchSiteSettings(['VEEQO_API_KEY'], env);
    return await veeqoBookShipment({
      env,
      rateId: meta.shipping_rate_object_id,
      remoteShipmentId: meta.veeqo_remote_shipment_id,
      settingsCache: cache,
    });
  }

  if (!env.SHIPPO_API_KEY) throw new Error('SHIPPO_API_KEY not set');

  const rateObjectId = meta.shipping_rate_object_id;

  let body;

  if (rateObjectId) {
    // ✅ Fast path: use the exact rate fetched/shown at checkout
    body = {
      rate:            rateObjectId,
      label_file_type: 'PDF',
      async:           false,
    };
  } else {
    // Fallback: create a brand-new shipment (rate ID wasn't stored — rare)
    const fromAddress = {
      ...shipFrom(env),
    };
    // Scale parcel weight/size by total item quantity
    const _labelItems   = (() => { try { return JSON.parse(meta.items || '[]'); } catch { return []; } })();
    const _totalQty     = Math.max(1, _labelItems.reduce((s, i) => s + (i.quantity || 1), 0));
    const _weightLb     = (0.5 + _totalQty * 0.5).toFixed(1);
    const _heightIn     = _totalQty <= 1 ? '4' : _totalQty <= 3 ? '6' : '8';
    const _widthIn      = _totalQty <= 1 ? '10' : _totalQty <= 3 ? '12' : '14';

    body = {
      shipment: {
        address_from: fromAddress,
        address_to: {
          name:    meta.customer_name  || 'Customer',
          street1: meta.ship_line1     || '',
          street2: meta.ship_line2     || '',
          city:    meta.ship_city      || '',
          state:   meta.ship_state     || '',
          zip:     meta.ship_zip       || '',
          country: meta.ship_country   || 'US',
          email:   meta.customer_email || '',
        },
        parcels: [{
          length: '14', width: _widthIn, height: _heightIn, distance_unit: 'in',
          weight: _weightLb, mass_unit: 'lb',
        }],
      },
      servicelevel_token: getServicelevelToken(meta.shipping_service || ''),
      label_file_type: 'PDF',
      async: false,
    };
  }

  const resp = await fetch('https://api.goshippo.com/transactions/', {
    method:  'POST',
    headers: {
      Authorization:  'ShippoToken ' + env.SHIPPO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();

  if (data.status !== 'SUCCESS') {
    throw new Error('Shippo label failed: ' + JSON.stringify(data.messages || data));
  }

  /* Count it — unless it was a TEST label.
   *
   * This counted every successful transaction, whatever mode the key was in. So
   * a shop testing checkout burned through its own free-tier budget with labels
   * that were never real: Shippo's test labels cost nothing and carry fake
   * tracking numbers, but each one pushed the counter closer to the threshold
   * that switches LIVE rate-shopping over to Veeqo. Test traffic was making a
   * production routing decision.
   *
   * Two signals, because either alone can be absent. Shippo stamps `test` on
   * the transaction object, which is authoritative when present; the key prefix
   * is the fallback for a response that omits it. Neither being conclusive
   * means counting it — over-counting costs a slightly early switch to a
   * provider that also works, while under-counting means silently blowing
   * through a real free tier. */
  const isTestLabel = data.test === true
    || String(env.SHIPPO_API_KEY || '').trim().startsWith('shippo_test_');
  if (isTestLabel) {
    console.log('Shippo TEST label — not counted against the free tier');
  } else {
    await incrementShippoMonthlyCount(env);   // non-fatal
  }

  return data; // { tracking_number, tracking_url_provider, label_url, ... }
}

// ─── Decrement inventory ───────────────────────────────────────────────────────
// Reads the compact `inv` metadata field ({p: productId, s: size, q: qty}[])
// and subtracts the purchased quantities from product_sizes.stock_quantity.
// Non-fatal — a failed decrement never blocks order saving or emails.

/**
 * Mint the gift cards an order paid for, and hand back the codes.
 *
 * Never throws. Every failure mode here leaves the order intact and some codes
 * unissued, which is a thing a human can put right from the Coupons page. The
 * alternative — failing fulfilment — loses the whole order to save the
 * recovery, and the card has already been charged.
 *
 * Bound to the buyer's account when the order has one, so the cards show up on
 * their account page as well as in the email. A guest order has no account to
 * bind, and the email is the only copy — which is why the email carries them
 * rather than linking to a page.
 */
export async function issueGiftCardsFor(meta, env) {
  let lines;
  try {
    lines = JSON.parse(meta.gift_cards || '[]');
  } catch (_) {
    console.error('gift cards: could not parse metadata for', meta.order_number, '—', meta.gift_cards);
    return [];
  }
  if (!Array.isArray(lines) || !lines.length) return [];

  const issued = [];
  for (const line of lines) {
    const cents = Math.round(Number(Array.isArray(line) ? line[0] : line && line.v) || 0);
    const qty = Math.max(1, Math.min(100, Math.round(Number(Array.isArray(line) ? line[1] : line && line.q) || 1)));
    if (cents <= 0) continue;
    for (let n = 0; n < qty; n += 1) {
      try {
        const out = await issueStoredValue(env, {
          kind: 'gift_card',
          cents,
          ownerUserId: meta.user_id || null,
          ownerEmail: meta.customer_email || '',
          reason: 'Bought on order ' + (meta.order_number || ''),
          /* Which order paid for it. The same shape admin-refund uses, so
             "where did this card come from" has one answer format. */
          sourceRef: 'order:' + String(meta.order_number || ''),
        });
        issued.push({ code: out.code, cents });
      } catch (e) {
        /* Logged with the amount so the shortfall is recoverable by hand, and
           never with a code — a log carrying live codes is spendable money
           sitting where more people can read it than can issue it. */
        console.error('gift card NOT issued on', meta.order_number, '—', cents, 'cents —', e && e.message);
      }
    }
  }
  if (issued.length) console.log('gift cards issued on', meta.order_number, '—', issued.length);
  return issued;
}

export async function decrementInventory(meta, env) {
  const serviceKey = getSupabaseServiceKey(env);
  if (!env.SUPABASE_URL || !serviceKey) return;

  let invItems;
  try {
    invItems = JSON.parse(meta.inv || '[]');
  } catch {
    console.warn('decrementInventory: could not parse inv metadata:', meta.inv);
    return;
  }
  if (!Array.isArray(invItems) || !invItems.length) return;

  const rpcHeaders = {
    apikey:         serviceKey,
    Authorization:  'Bearer ' + serviceKey,
    'Content-Type': 'application/json',
  };

  for (const { p: productId, s: size, q: qty, c: colorName } of invItems) {
    if (!productId || !size || !qty) continue;
    try {
      const rpcBody = { p_product_id: productId, p_size: size, p_qty: qty };
      if (colorName) rpcBody.p_color_name = colorName;
      const rpcRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/decrement_stock`, {
        method:  'POST',
        headers: rpcHeaders,
        body:    JSON.stringify(rpcBody),
      });
      if (!rpcRes.ok) {
        console.warn(`decrementInventory: RPC failed for ${productId} / ${size}:`, await rpcRes.text());
      } else {
        /* The RPC now reports how many rows it changed. It used to return void,
           so "found no row and did nothing" was indistinguishable from success —
           which is how a size sold out while still advertising one left. A miss
           here means stock is now wrong on a live product, so it is an error
           rather than a note. */
        const changed = Number(await rpcRes.json().catch(() => 0)) || 0;
        if (changed > 0) {
          console.log(`Inventory decremented: ${productId} / ${size} by ${qty}`);
        } else {
          console.error(
            `decrementInventory: NOTHING decremented for ${productId} / ${size} / ${colorName || '(no colour)'} ` +
            `— stock is now overstated. Either no product_sizes row matches, or migration 0007 has not been applied.`
          );
        }
      }
    } catch (e) {
      console.warn(`decrementInventory error for ${productId} / ${size}:`, e.message);
    }
  }
}

// ─── Increment promo code usage count ──────────────────────────────────────────
export async function incrementPromoUsage(code, env) {
  if (!env.SUPABASE_URL || !getSupabaseServiceKey(env) || !code) return;
  const normalized = code.trim().toLowerCase();

  try {
    // Atomic compare-and-swap increment. A plain read-modify-write here loses
    // updates under concurrent checkouts (both read usageCount=N, both write N+1),
    // letting a maxUsage-capped code slip past its limit. mutateSetting retries on a
    // rev conflict and falls back to a plain write if the rev column isn't deployed.
    let matched = false;
    await mutateSetting(env, 'commerce_config', (cfg) => {
      const config = cfg && typeof cfg === 'object' ? cfg : {};
      if (!Array.isArray(config.promotions)) return config;
      return {
        ...config,
        promotions: config.promotions.map((promo) => {
          if (promo.code && promo.code.trim().toLowerCase() === normalized) {
            matched = true;
            return { ...promo, usageCount: (parseInt(promo.usageCount || 0, 10) || 0) + 1 };
          }
          return promo;
        }),
      };
    });
    if (matched) console.log(`Promo code usage incremented: ${code}`);
  } catch (e) {
    console.warn('incrementPromoUsage error:', e.message);
  }
}

// ─── Save order to Supabase ────────────────────────────────────────────────────

export async function saveOrderToSupabase(pi, meta, tracking, env) {
  const serviceKey = getSupabaseServiceKey(env);
  if (!env.SUPABASE_URL || !serviceKey) throw new Error('Supabase order storage is not configured');

  // Idempotency: skip if an order for this PaymentIntent already exists
  const existingRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/orders?stripe_payment_intent_id=eq.${encodeURIComponent(pi.id)}&select=id&limit=1`,
    { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
  );
  if (existingRes.ok) {
    const existing = await existingRes.json().catch(() => []);
    if (Array.isArray(existing) && existing.length) {
      console.log(`Order for PI ${pi.id} already exists — idempotent skip`);
      return true;
    }
  }

  const items = (() => { try { return JSON.parse(meta.items || '[]'); } catch { return []; } })();

  // Augment items with image_url so deleted products still show their image in order history.
  // Images are not in Stripe metadata (URLs exceed the 500-char limit) so we fetch them now
  // while the products still exist, and store them permanently in the order record.
  const productImgSnap = {};
  if (env.SUPABASE_URL && serviceKey) {
    try {
      const imgRes = await fetch(
        env.SUPABASE_URL + '/rest/v1/products?select=id,sku,title,image_url&limit=500',
        { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
      );
      if (imgRes.ok) {
        const rows = await imgRes.json().catch(() => []);
        for (const p of rows || []) {
          if (!p.image_url) continue;
          if (p.id)    productImgSnap[p.id]                           = p.image_url;
          if (p.sku)   productImgSnap[p.sku.toLowerCase()]            = p.image_url;
          if (p.title) productImgSnap[p.title.trim().toLowerCase()]   = p.image_url;
        }
      }
    } catch (_) { /* non-fatal — order still saves, just without images */ }
  }
  const variantImgMap = await fetchVariantImageMap(env, serviceKey);
  const itemsWithImages = items.map(i => ({
    ...i,
    image: pickItemImage(i, variantImgMap, productImgSnap),
  }));

  /* ── THE ORDER NUMBER IS NOT INVENTED HERE ────────────────────────────────

     It used to be. This built `ZW-<category>-00001` from a row count and wrote
     it to the column — while the number the CUSTOMER was given had already been
     generated at payment time, put in the metadata, and printed on their
     confirmation email. Two numbers for one order, and the one in the email was
     thrown away here.

     Worse, this one usually produced nothing: it needed the first item's
     product to have a `category`, and when that was empty the `if` simply did
     not run. Non-fatal, unlogged, and null in the column on every real order.
     So the panel fell back to a label derived from the payment reference, the
     email showed the metadata number, and neither matched the other or the
     database. Three names, one order.

     It also counted rows to find the next one, which two simultaneous orders do
     at the same time — both read N, both write N+1, and two orders share a
     number permanently. The column now carries a unique index (0031), which
     that scheme could not have satisfied.

     The number the customer already has is the number. It comes in on the
     metadata from create-payment-intent or paypal-create-order, and this writes
     it down. */
  const orderNumber = String(meta.order_number || '').trim() || null;

  const subtotalCents = parseInt(meta.subtotal_amount_cents    || '0', 10);
  // charged_shipping_cents = what the customer actually paid (0 for free shipping)
  const shippingCents = parseInt(meta.charged_shipping_cents   || meta.shipping_amount_cents || '0', 10);
  const taxCents      = parseInt(meta.tax_amount_cents         || '0', 10);

  const orderRow = {
      stripe_payment_intent_id: pi.id,
      /* Who took the money. The column above holds the reference and no longer
         implies the processor — a PayPal capture id goes in it too, so that
         saveOrderToSupabase keeps deduping on one column instead of growing a
         second code path. This says which one, because a refund has to be
         issued through the processor that took it, and reading the id's prefix
         would be trusting a convention nothing enforces.

         Defaults to stripe rather than throwing on an unknown value: the
         metadata is ours, an absent field means the Stripe path (which does not
         set it), and refusing to save an order over a missing label would be
         losing the order to protect a report. */
      processor:        meta.payment_provider || 'stripe',
      user_id:          meta.user_id       || null,
      email:            meta.customer_email,
      customer_name:    meta.customer_name,
      items:            JSON.stringify(itemsWithImages),
      subtotal:         (subtotalCents / 100).toFixed(2),
      shipping:         (shippingCents  / 100).toFixed(2),
      /* What the label actually cost, against what the customer was charged
         above. Both numbers existed already — this one only in Stripe metadata,
         where nothing could subtract one from the other. NULL rather than 0
         when there was no label (hand delivery) or no figure, because zero
         would read as "shipped for free" and drag the average down with a
         number nobody measured. */
      actual_shipping_cost: meta.actual_shipping_cost_cents
        ? (parseInt(meta.actual_shipping_cost_cents, 10) / 100).toFixed(2)
        : null,
      tax:              (taxCents       / 100).toFixed(2),
      // Which engine produced that figure, so a year of collections can still be
      // attributed after the setting changes. NULL on orders older than this.
      tax_engine:       meta.tax_engine || null,
      total:            (pi.amount      / 100).toFixed(2),
      free_shipping:    meta.free_shipping === 'true',
      ship_line1:       meta.ship_line1,
      ship_line2:       meta.ship_line2    || '',
      ship_city:        meta.ship_city,
      ship_state:       meta.ship_state,
      ship_zip:         meta.ship_zip,
      ship_country:     meta.ship_country  || 'US',
      shipping_provider: meta.shipping_provider || '',
      shipping_service:  meta.shipping_service  || '',
      tracking_number:   tracking.number,
      tracking_url:      tracking.url,
      label_url:         tracking.label,
      status:           'confirmed',
      order_number:      orderNumber,
  };

  const insertOrder = (row) => fetch(env.SUPABASE_URL + '/rest/v1/orders', {
    method:  'POST',
    headers: {
      apikey:         serviceKey,
      Authorization:  'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
      Prefer:         'return=minimal',
    },
    body: JSON.stringify(row),
  });

  let resp = await insertOrder(orderRow);

  /* ── A COLLISION MUST NOT COST THE ORDER ──────────────────────────────────
     0031 puts a unique index on order_number, which is what stops two orders
     sharing a name and sending a refund to the wrong one. The cost of an index
     that can reject is that a rejection here happens AFTER the customer has
     been charged: the throw below would fail the webhook, Stripe would redeliver
     the identical metadata, it would collide again, and the order would never
     save. An infinite retry over an order that is already paid for.

     Ten random characters of a 28-symbol alphabet makes this about a one-in-six-
     million event across ten thousand orders, so this is the branch that should
     never run. It exists because "should never" and "cannot" are different, and
     the difference is a paid order that does not exist.

     The retry keeps the customer's number and appends to it, so what they were
     emailed is still a prefix of what the panel shows — findable by search,
     which is what somebody quoting a number actually needs. Logged loudly,
     because a collision at these odds means the generator is wrong. */
  if (resp.status === 409 && orderNumber) {
    const detail = await resp.text().catch(() => '');
    console.error('order number collision on', orderNumber, '—', detail.slice(0, 200));
    const suffixed = orderNumber + '-' + Math.floor(Math.random() * 900 + 100);
    resp = await insertOrder({ ...orderRow, order_number: suffixed });
  }

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error('Supabase insert failed (' + resp.status + '): ' + detail);
  }

  /* Radar's verdict, stamped AFTER the order is saved and fully non-fatal —
     the same shape the feature-flag stamp below uses, and for the same reason:
     PostgREST rejects the WHOLE row for one unknown column, so putting these in
     the insert would mean every order failing to save until migration 0006 is
     applied. A payment succeeded; nothing about recording a risk score is worth
     losing the order over.

     Captured at all because Radar does essentially nothing in test mode and the
     score is NOT recoverable — a charge scored last week cannot be re-scored,
     so a day without this is a day of evidence gone about whether real
     customers are being wrongly flagged. */
  try {
    const risk = riskOf(pi);
    if (risk.level || risk.score !== null) {
      await fetch(env.SUPABASE_URL + '/rest/v1/orders?stripe_payment_intent_id=eq.' + encodeURIComponent(pi.id), {
        method: 'PATCH',
        headers: {
          apikey: serviceKey, Authorization: 'Bearer ' + serviceKey,
          'Content-Type': 'application/json', Prefer: 'return=minimal',
        },
        body: JSON.stringify({ risk_level: risk.level, risk_score: risk.score }),
      });
    }
  } catch (e) {
    console.warn('Risk stamp skipped (non-fatal):', e.message);
  }

  // Best-effort: stamp the buyer's active feature-flag variants onto the order so
  // revenue/orders can be split by variant in admin. Runs AFTER the order is
  // saved and is fully non-fatal — if the orders.feature_flags jsonb column
  // hasn't been added yet (see supabase-feature-flags.sql), this simply no-ops
  // and the order is unaffected.
  try {
    const ff = meta.feature_flags ? JSON.parse(meta.feature_flags) : null;
    if (ff && typeof ff === 'object' && Object.keys(ff).length && env.SUPABASE_URL && serviceKey) {
      await fetch(env.SUPABASE_URL + '/rest/v1/orders?stripe_payment_intent_id=eq.' + encodeURIComponent(pi.id), {
        method: 'PATCH',
        headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ feature_flags: ff }),
      });
    }
  } catch (_) { /* column not present / parse issue — non-fatal, order already saved */ }

  // Best-effort: record hand-delivery so admin can distinguish it from mail orders.
  // Non-fatal — if orders.delivery_method hasn't been added yet (see
  // supabase-local-delivery.sql) this no-ops and the order is unaffected.
  try {
    if (meta.delivery_method === 'hand_delivery' && env.SUPABASE_URL && serviceKey) {
      await fetch(env.SUPABASE_URL + '/rest/v1/orders?stripe_payment_intent_id=eq.' + encodeURIComponent(pi.id), {
        method: 'PATCH',
        headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ delivery_method: 'hand_delivery' }),
      });
    }
  } catch (_) { /* column not present — non-fatal, order already saved */ }

  /* Best-effort: which ad, email or post produced this order (migration 0020).
     Stamped AFTER the insert and non-fatal for the same reason the two stamps
     above are — PostgREST rejects the WHOLE row over one unknown column, so
     putting `attribution` in the insert would mean every order failing to save
     between this deploy and 0020 being applied. A payment has already
     succeeded; no reporting field is worth losing the order over.

     Expanded from the compact metadata form to full key names on the way in, so
     the column can be queried as `attribution->'last'->>'utm_source'` rather
     than through a decoder ring. See _attribution.js. */
  try {
    const attribution = attributionFromMeta(meta.attribution);
    if (attribution && env.SUPABASE_URL && serviceKey) {
      await fetch(env.SUPABASE_URL + '/rest/v1/orders?stripe_payment_intent_id=eq.' + encodeURIComponent(pi.id), {
        method: 'PATCH',
        headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ attribution }),
      });
    }
  } catch (_) { /* column not present / parse issue — non-fatal, order already saved */ }

  return true;
}

// ─── Send confirmation email ───────────────────────────────────────────────────

// Assembles the order-confirmation email on the shared shell from pre-built HTML
// fragments (items/address/carrier). Exported so the admin email preview can
// render it with sample data — a real order can't be placed just to preview it.
export function buildOrderConfirmation({ appearance, content, orderId, toName, itemsHtml, subtotalCents, discountRow, shippingDisplay, taxCents, totalDollars, addressHtml, carrierHtml, userId, orderNumber, token }) {
  const a = appearance;
  const emailC = content;
  const body = `
        <!-- Items -->
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
          ${itemsHtml}
        </table>

        <!-- Pricing -->
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:20px;">
          <tr>
            <td style="padding:6px 0;font-size:14px;color:${a.muted};">Subtotal</td>
            <td style="padding:6px 0;font-size:14px;text-align:right;color:${a.text};">$${(subtotalCents / 100).toFixed(2)}</td>
          </tr>
          ${discountRow}
          <tr>
            <td style="padding:6px 0;font-size:14px;color:${a.muted};">Shipping</td>
            <td style="padding:6px 0;font-size:14px;text-align:right;color:${a.text};">${shippingDisplay}</td>
          </tr>
          <tr>
            <td style="padding:6px 0 0;font-size:14px;color:${a.muted};">Tax</td>
            <td style="padding:6px 0 0;font-size:14px;text-align:right;color:${a.text};">$${(taxCents / 100).toFixed(2)}</td>
          </tr>
          <tr>
            <td colspan="2" style="padding:0;"><div style="margin:12px 0;border-top:1px solid ${a.border};"></div></td>
          </tr>
          <tr>
            <td style="font-size:16px;font-weight:700;color:${a.text};">Total</td>
            <td style="font-size:16px;font-weight:700;text-align:right;color:${a.text};">$${totalDollars}</td>
          </tr>
        </table>

        <!-- Shipping address + carrier -->
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
          ${addressHtml}
          ${carrierHtml}
        </table>`;

  /* Where "View order status" should send this particular customer.

     It was hardcoded to /account for everyone. A guest has no account, so the
     link asked them to log in — and on a shared computer where somebody else
     was still signed in, it showed THAT person's orders instead. The customer
     clicks a link in their own receipt and lands in a stranger's account.

     An order with a user_id belongs to an account holder, and /account is
     right for them. Everyone else goes to the guest lookup with their order
     number already filled in, so the only thing left to type is the email the
     receipt was sent to.

     `userId` and `orderNumber` are PARAMETERS, and that is load-bearing. They
     were written as `meta.user_id` and `meta.order_number` — but `meta` is not
     in scope here, it is an argument of the caller two functions up. A free
     variable throws ReferenceError rather than reading as undefined, so this
     line took down every order confirmation ever sent: the throw happened
     before the Resend call, Promise.allSettled swallowed it into a single
     console.error, and the webhook still answered 200. Stripe showed a
     successful delivery, the order saved, the label printed, the stock
     decremented, and no email went out for any order, ever, with no alert —
     because the alerting only fires inside the provider-failure path this
     never reached.

     Destructured parameters cannot do that. An argument the caller forgets is
     undefined, and orderStatusUrl() handles undefined by returning the plain
     guest-lookup URL. The wrong link is a bad link; the free variable was no
     email at all.

     `token`, where present, takes a guest straight to their order instead of
     to a form that asks for the email this message was just read in. */
  const statusHref = orderStatusUrl({ userId, orderNumber, token });

  const footerHtml = `
          <a href="${statusHref}" style="color:${a.text};text-decoration:underline;">View order status</a>
          &nbsp;·&nbsp;
          <a href="${orderStatusUrl({ userId: null, orderNumber, token })}" style="color:${a.text};text-decoration:underline;">30-day free returns</a><br>
          <span style="display:inline-block;margin-top:8px;">Questions? <a href="mailto:orders@zuwera.store" style="color:${a.muted};text-decoration:underline;">orders@zuwera.store</a></span><br>
          <span style="display:inline-block;margin-top:8px;">© ${new Date().getFullYear()} ${appearance.brand}. All rights reserved.</span>`;

  return renderEmailShell(a, {
    kicker:  fillTemplate(emailC.kicker, { name: toName, order: orderId }),
    heading: fillTemplate(emailC.heading, { order: orderId }),
    intro:   fillTemplate(emailC.intro, { name: toName, order: orderId }),
    bodyHtml: body,
    footerHtml,
  });
}

async function sendConfirmationEmail(pi, meta, tracking, env, emailKeyCache = {}) {
  const resendKey = resolveSetting('RESEND_API_KEY', env, emailKeyCache);
  if (!resendKey) return null;

  const toEmail  = (meta.customer_email || '').trim();
  if (!toEmail) return null;

  // Single from address used by BOTH Resend and Brevo — must be verified in both
  const fromEmail = resolveSetting('EMAIL_FROM', env, emailKeyCache)
    || (env.RESEND_FROM_EMAIL || '').trim()
    || 'orders@zuwera.store';

  // Brand logo — shown in email header (white wordmark works on dark background)
  const logoUrl = resolveSetting('BRAND_LOGO_URL', env, emailKeyCache)
    || 'https://zuwera.store/assets/Zuwera_Wordmark_White.png';

  // Admin-controlled fonts + editable copy (site_settings, via _email-theme.js).
  // Layout/colours stay as this order-detail template's tested dark design; the
  // admin Emails editor drives the fonts, the subject, and the header copy.
  const a = getEmailAppearance(emailKeyCache, env);
  a.logo = logoUrl;   // resolveSetting also covers an env-var logo, which getEmailAppearance can't see
  const emailC = getEmailContent(emailKeyCache, 'order_confirmation');
  const escE = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const orderId      = orderNoPlain({ order_number: meta.order_number, stripe_payment_intent_id: pi.id });
  const toName       = meta.customer_name || 'Customer';
  const totalDollars = (pi.amount / 100).toFixed(2);
  const carrier      = [meta.shipping_provider, meta.shipping_service].filter(Boolean).join(' ') || 'Standard Shipping';
  const subtotalCents = parseInt(meta.subtotal_amount_cents  || '0', 10);
  const shippingCents = parseInt(meta.charged_shipping_cents || '0', 10);
  const taxCents      = parseInt(meta.tax_amount_cents       || '0', 10);
  const discountCode  = (meta.discount_code || '').toUpperCase();
  const discountCents = parseInt(meta.discount_amount_cents  || '0', 10);

  // Fetch product images from Supabase by SKU/name (images are NOT stored in metadata
  // because long URLs exceed Stripe's 500-char per-value metadata limit)
  const productImageMap = {}; // key: sku or lowercased name → image_url
  const serviceKey = getSupabaseServiceKey(env);
  if (env.SUPABASE_URL && serviceKey) {
    try {
      const imgRes = await fetch(
        env.SUPABASE_URL + '/rest/v1/products?select=title,sku,image_url&limit=200',
        {
          headers: {
            apikey:        serviceKey,
            Authorization: 'Bearer ' + serviceKey,
          },
        }
      );
      if (imgRes.ok) {
        const prods = await imgRes.json();
        (prods || []).forEach(p => {
          if (p.sku        && p.image_url) productImageMap[p.sku.toLowerCase()]           = p.image_url;
          if (p.title      && p.image_url) productImageMap[p.title.trim().toLowerCase()]  = p.image_url;
        });
      }
    } catch (_) { /* non-fatal — email still sends without images */ }
  }
  const variantImageMap = await fetchVariantImageMap(env, serviceKey);

  let parsedItems = [];
  try { parsedItems = JSON.parse(meta.items || '[]'); } catch (_) {}

  const itemsHtml = parsedItems.length
    ? parsedItems.map(i => {
        const imageUrl = pickItemImage(i, variantImageMap, productImageMap);
        const imgCell = imageUrl
          ? `<img src="${imageUrl}" alt="${i.name}" width="72" height="90" style="width:72px;height:90px;object-fit:cover;border-radius:4px;display:block;">`
          : `<div style="width:72px;height:90px;background:rgba(128,128,128,.12);border-radius:4px;"></div>`;
        const variant = [i.size, i.color].filter(Boolean).join(' · ');
        return `<tr>
          <td style="padding:16px 0;border-bottom:1px solid ${a.border};vertical-align:top;width:80px;">${imgCell}</td>
          <td style="padding:16px 12px;border-bottom:1px solid ${a.border};vertical-align:top;">
            <div style="font-weight:600;font-size:15px;color:${a.text};margin-bottom:4px;">${i.name}</div>
            ${variant ? `<div style="font-size:13px;color:${a.muted};margin-bottom:4px;">${variant}</div>` : ''}
            ${i.sku ? `<div style="font-size:11px;color:${a.muted};letter-spacing:.04em;font-family:${a.fontMono};">SKU: ${i.sku}</div>` : ''}
          </td>
          <td style="padding:16px 0;border-bottom:1px solid ${a.border};vertical-align:top;text-align:right;white-space:nowrap;">
            <div style="font-size:14px;color:${a.text};font-weight:500;">$${(i.amount / 100).toFixed(2)}</div>
            ${i.quantity > 1 ? `<div style="font-size:12px;color:${a.muted};margin-top:3px;">× ${i.quantity}</div>` : ''}
          </td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="3" style="padding:16px 0;color:${a.muted};">Your ${a.brand} order</td></tr>`;

  const addrParts = [
    meta.ship_line1,
    meta.ship_line2,
    [meta.ship_city, meta.ship_state, meta.ship_zip].filter(Boolean).join(', '),
    meta.ship_country && meta.ship_country.toUpperCase() !== 'US' ? meta.ship_country : '',
  ].filter(Boolean);

  const addressHtml = addrParts.length ? `
      <tr><td style="padding:24px 0 4px;">
        <p style="margin:0 0 8px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${a.muted};font-weight:600;font-family:${a.fontMono};">Ships to</p>
        <p style="margin:0;font-size:14px;color:${a.text};line-height:1.65;">${toName}<br>${addrParts.join('<br>')}</p>
      </td></tr>` : '';

  const discountColor = a.light ? '#2e7d43' : '#86c98e';
  const discountRow = discountCode && discountCents > 0 ? `
            <tr>
              <td style="padding:4px 0;font-size:14px;color:${a.muted};">Discount (${discountCode})</td>
              <td style="padding:4px 0;font-size:14px;text-align:right;color:${discountColor};">−$${(discountCents / 100).toFixed(2)}</td>
            </tr>` : '';

  const shippingDisplay = meta.free_shipping === 'true' ? 'Free' : `$${(shippingCents / 100).toFixed(2)}`;

  const etaText = (() => {
    const s = (meta.shipping_service || '').toLowerCase();
    if (/priority|express|overnight/.test(s)) return '1–3 business days';
    if (/first.?class/.test(s)) return '3–5 business days';
    if (/ground/.test(s)) return '5–7 business days';
    return '3–7 business days';
  })();

  const carrierHtml = `
      <tr><td style="padding:16px 0 8px;">
        <p style="margin:0 0 8px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${a.muted};font-weight:600;font-family:${a.fontMono};">Delivery</p>
        <p style="margin:0;font-size:14px;color:${a.text};">Ships via ${carrier}</p>
        <p style="margin:4px 0 0;font-size:14px;color:${a.muted};">Estimated delivery: ${etaText}</p>
        ${tracking.number ? `<p style="margin:6px 0 0;font-size:14px;color:${a.text};">Tracking: ${tracking.url ? `<a href="${tracking.url}" style="color:${a.accent};text-decoration:underline;">${tracking.number}</a>` : tracking.number}</p>` : ''}
      </td></tr>`;

  /* Identified by PaymentIntent, not by order id: this email is built in
     parallel with the row being written, and that insert uses
     `Prefer: return=minimal`, so there is no id to name yet. Minting failure
     (no signing secret) returns '' and the footer falls back to the ordinary
     lookup link — the flow that existed before, not a broken URL. */
  const statusToken = await mintOrderToken(env, {
    purpose: 'order-status',
    paymentIntentId: pi.id,
    email: toEmail,
  }).catch(() => '');

  const html = buildOrderConfirmation({
    appearance: a, content: emailC, orderId, toName, itemsHtml,
    subtotalCents, discountRow, shippingDisplay, taxCents, totalDollars,
    addressHtml, carrierHtml,
    /* Who this order belongs to, so the footer can send an account holder to
       /account and a guest to the lookup. Passed explicitly rather than reached
       for off `meta` — see the note in buildOrderConfirmation. */
    userId: meta.user_id, orderNumber: meta.order_number, token: statusToken,
  });

  // ── Try Resend first ────────────────────────────────────────────────
  const resendResp = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      Authorization:  'Bearer ' + resendKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:     `${a.brand} <${fromEmail}>`,
      to:       [toEmail],
      reply_to: fromEmail,
      subject:  fillTemplate(emailC.subject, { order: orderId }),
      html,
    }),
  });

  if (resendResp.ok) {
    console.log('Email sent via Resend to', toEmail);
    return { provider: 'resend' };
  }

  // ── Resend failed — try Brevo fallback ──────────────────────────────
  const resendError = resendResp.status + ': ' + await resendResp.text().catch(() => '');
  console.warn('Resend failed (' + resendError + '), trying Brevo fallback…');

  const brevoKey = resolveSetting('BREVO_API_KEY', env, emailKeyCache);
  if (!brevoKey) {
    throw new Error('Resend error ' + resendError + ' — no BREVO_API_KEY set for fallback');
  }

  const brevoResp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method:  'POST',
    headers: {
      'api-key':      brevoKey,
      'Content-Type': 'application/json',
      Accept:         'application/json',
    },
    body: JSON.stringify({
      sender:      { name: a.brand, email: fromEmail },
      to:          [{ email: toEmail, name: toName }],
      replyTo:     { email: fromEmail },
      subject:     fillTemplate(emailC.subject, { order: orderId }),
      htmlContent: html,
    }),
  });

  if (!brevoResp.ok) {
    const brevoError = brevoResp.status + ': ' + await brevoResp.text().catch(() => '');
    // ── Third tier: Resend AND Brevo both down — last-resort Loops fallback ──
    const loops = await loopsFallback({
      env, cache: emailKeyCache, to: toEmail, subject: fillTemplate(emailC.subject, { order: orderId }), html,
      /* confirm.html is the AUTH confirmation page — password resets and email
         verification. Pointing a customer there to "view your order" showed
         them a sign-in flow with no order anywhere on it. Same destination as
         the main confirmation email now, which is also the point of having one
         helper decide this. */
      text: `Your ${a.brand} order #${orderId} is confirmed and being prepared.\n\nView your order: ${orderStatusUrl({ userId: meta.user_id, orderNumber: meta.order_number, token: statusToken })}\n\nQuestions? orders@zuwera.store`,
      dataVariables: {
        orderId,
        orderUrl: orderStatusUrl({ userId: meta.user_id, orderNumber: meta.order_number, token: statusToken }),
      },
    });
    if (loops.ok) {
      /* Two down, one left. Warn rather than critical — the customer got their
         email — but this is the last tier, so it is worth someone's morning. */
      await notifyOps(env, { settings: emailKeyCache,
        severity: 'warn', key: 'email-fallback-loops',
        event: 'Email sent via Loops — Resend AND Brevo both failed',
        detail: 'Resend: ' + resendError + '\nBrevo: ' + brevoError,
        avoid: ['resend', 'brevo'],
      });
      return { provider: 'loops', resendError, brevoError };
    }
    const allFailed = 'All email providers failed. Resend: ' + resendError + ' | Brevo: ' + brevoError + (loops.skipped ? ' | Loops: not configured' : ' | ' + (loops.error || 'Loops failed'));
    /* Critical: an order confirmation is not being delivered. SMS fires here
       and nowhere in this chain, because this is the only tier where a customer
       is actually left without their email. */
    await notifyOps(env, { settings: emailKeyCache,
      severity: 'critical', key: 'email-all-providers-down',
      event: 'Every email provider failed — order confirmations are not sending',
      detail: allFailed, avoid: ['resend', 'brevo'],
    });
    throw new Error(allFailed);
  }

  console.log('Email sent via Brevo fallback to', toEmail, '(Resend was unavailable)');
  /* The alert this file previously did not have. Deliberately NOT routed
     through Resend — an alert saying "Resend is down", sent via Resend, arrives
     only when it is not needed. */
  await notifyOps(env, { settings: emailKeyCache,
    severity: 'warn', key: 'email-fallback-brevo',
    event: 'Email fell back to Brevo — Resend was unavailable',
    detail: 'Resend: ' + resendError, avoid: ['resend'],
  });
  return { provider: 'brevo', resendError };
}
