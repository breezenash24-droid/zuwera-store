/**
 * POST /api/admin-refund
 *
 * Two-factor protected refund / cancellation endpoint.
 *
 * Factor 1 — Supabase admin JWT:    proves who you are
 * Factor 2 — REFUND_SECRET env var: proves you authorized this specific action
 *            (separate from admin password, never stored in the database)
 *
 * Rate limiting: 5 wrong codes within 10 minutes → 1-hour lockout.
 * On lockout: alert email sent immediately via Resend (Brevo fallback).
 * Every attempt (success and failure) is appended to the refund audit log.
 */

/* No Stripe import. This route used to construct a client and call three of its
   APIs directly; all of that moved into _processors.js when a second processor
   arrived, so the file that decides WHETHER to refund no longer knows HOW. */
import { cors, json, verifyAdmin, decide, getSetting, setSetting, getCommerceBundle, mutateSetting } from './_commerce.js';
import { permsHave } from './_rbac.js';
import { orderNo, orderNoPlain } from './_order-no.js';
import { reverseTaxSale } from './_tax.js';
import { fetchSiteSettings, resolveSetting } from './_settings.js';
/* One place that knows how each processor differs. This route no longer names
   any of them: it looks one up and calls the interface. */
import { processorFor } from './_processors.js';
import { sha256Base64Url } from './_cart-pricing.js';
import { getEmailAppearance, renderEmailShell } from './_email-theme.js';
/* Settling a return as store credit issues an instrument instead of calling a
   processor. It is the same money decision — this route already asks who you
   are, asks for the authorization code, checks the limits and refuses a second
   payout — so it happens HERE rather than in a second endpoint that would have
   to grow its own copy of all of that. */
import { issue as issueStoredValue, storedValueEnabled, voidCode } from './_stored-value.js';

/**
 * The gift cards this order created, and what is left on them.
 *
 * ── THE HOLE THIS CLOSES ───────────────────────────────────────────────
 *
 * Buy a $100 gift card, receive the code, spend it, then ask for a refund. The
 * refund route knew nothing about gift cards, so the store paid twice: once in
 * goods bought with the code, once in cash back to the payment card. A
 * chargeback does the same thing without needing anybody's cooperation, and
 * neither half leaves a trace pointing at the other.
 *
 * Found by source_ref, which _fulfil.js stamps as `order:<number>` when it
 * mints them.
 *
 * NEVER THROWS, and "could not tell" is not "nothing to worry about". A failed
 * lookup returns known:false, and the caller stops rather than refunding
 * blind — the same rule the processor ledger already follows, where an unknown
 * refunded-so-far must not be read as zero.
 */
async function cardsIssuedByOrder(env, orderNumber) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
  if (!env.SUPABASE_URL || !key || !orderNumber) return { known: false, cards: [] };
  const head = { apikey: key, Authorization: `Bearer ${key}` };
  try {
    const resp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/stored_value`
      + `?source_ref=eq.${encodeURIComponent('order:' + orderNumber)}`
      + '&select=id,code,kind,initial_cents,status&limit=200',
      { headers: head }
    );
    /* A 404 is the table not existing — migration 0030 not run — which means no
       card can have been issued by anything, so there is nothing to void. */
    if (resp.status === 404) return { known: true, cards: [] };
    if (!resp.ok) return { known: false, cards: [] };
    const rows = await resp.json().catch(() => null);
    if (!Array.isArray(rows)) return { known: false, cards: [] };

    const cards = [];
    for (const row of rows) {
      let balance = 0;
      if (row.status !== 'void') {
        const b = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/zw_stored_value_balance_cents`, {
          method: 'POST',
          headers: { ...head, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_id: row.id }),
        });
        if (!b.ok) return { known: false, cards: [] };
        balance = Number(await b.json().catch(() => 0)) || 0;
      }
      cards.push({
        code: row.code,
        issuedCents: Number(row.initial_cents) || 0,
        balanceCents: balance,
        alreadyVoid: row.status === 'void',
      });
    }
    return { known: true, cards };
  } catch (_) {
    return { known: false, cards: [] };
  }
}

const RATE_LIMIT_KEY = 'refund_rate_limit';
const AUDIT_LOG_KEY  = 'refund_audit_log';
const MAX_BAD        = 5;
const WINDOW_MS      = 10 * 60 * 1000;  // 10 minutes
const LOCKOUT_MS     = 60 * 60 * 1000;  // 1 hour

// ── Entry point ───────────────────────────────────────────────────────────────

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  const h = cors(env);

  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid request body.' }, 400, h);
  }

  const { accessToken, orderId, refundKey, action, amountCents, reason, customerNote } = body;

  /* WHERE the money goes back to, which is a different question from whether it
     goes back. 'card' sends it through the processor that took it; the order is
     settled either way, owes the same tax either way, and the return closes
     either way. Anything unrecognised is treated as 'card' — the direction that
     cannot invent a balance out of a typo. */
  const settlement = String(body.settlement || 'card').toLowerCase() === 'store_credit'
    ? 'store_credit' : 'card';

  // ── 1. Verify admin JWT + refund permission ─────────────────────────────────
  const admin = await verifyAdmin(env, accessToken);
  if (!admin) return json({ error: 'Unauthorized.' }, 403, h);
  if (!permsHave(admin.permissions, 'refund')) {
    await audit(env, {
      adminId: String(admin.id || ''), adminEmail: String(admin.email || ''),
      orderId, action, success: false, note: `blocked: role "${admin.admin_role}" lacks refund permission`,
    });
    return json({ error: 'Your role does not have permission to issue refunds.' }, 403, h);
  }

  // ── 2. REFUND_SECRET must exist in Cloudflare env vars ──────────────────────
  const secret = env.REFUND_SECRET;
  if (!secret) {
    return json({
      error: 'Refund system is not configured. Add REFUND_SECRET to your Cloudflare environment variables.',
    }, 503, h);
  }

  const adminId    = String(admin.id || admin.profile?.id || 'unknown');
  const adminEmail = String(admin.email || admin.profile?.email || '');

  // ── 3. Rate-limit check ──────────────────────────────────────────────────────
  const limitData = await getSetting(env, RATE_LIMIT_KEY, {}).catch(() => ({}));
  const entry = limitData?.[adminId] || { attempts: 0, windowStart: 0, lockedUntil: 0 };
  const now = Date.now();

  if (entry.lockedUntil && now < entry.lockedUntil) {
    const mins = Math.ceil((entry.lockedUntil - now) / 60000);
    await audit(env, { adminId, adminEmail, orderId, action, success: false, note: 'rate_limited' });
    return json({
      error: `Too many failed attempts. Refund access is locked for ${mins} more minute${mins !== 1 ? 's' : ''}.`,
    }, 429, h);
  }

  // ── 4. Validate authorization code ──────────────────────────────────────────
  if (!refundKey || refundKey !== secret) {
    const inWindow    = now - (entry.windowStart || 0) < WINDOW_MS;
    const attempts    = inWindow ? (entry.attempts || 0) + 1 : 1;
    const windowStart = inWindow ? (entry.windowStart || now) : now;
    const justLocked  = attempts >= MAX_BAD;
    const lockedUntil = justLocked ? now + LOCKOUT_MS : (entry.lockedUntil || 0);

    await setSetting(env, RATE_LIMIT_KEY, {
      ...limitData,
      [adminId]: { attempts, windowStart, lockedUntil },
    });
    await audit(env, { adminId, adminEmail, orderId, action, success: false, note: 'invalid_key', attempts });

    // Send alert email when the lockout threshold is crossed
    if (justLocked) {
      await sendLockoutAlert(env, { adminEmail, adminId, orderId, attempts, lockedUntil });
    }

    const remaining = MAX_BAD - attempts;
    const msg = remaining <= 0
      ? 'Incorrect code. Refund access is locked for 1 hour. A security alert has been sent to your email.'
      : `Incorrect authorization code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining before lockout.`;
    return json({ error: msg }, 403, h);
  }

  // Good code — reset rate-limit counter for this admin
  if ((entry.attempts || 0) > 0) {
    await setSetting(env, RATE_LIMIT_KEY, {
      ...limitData,
      [adminId]: { attempts: 0, windowStart: 0, lockedUntil: 0 },
    });
  }

  // ── 5. Validate action ───────────────────────────────────────────────────────
  if (!['cancel', 'cancel_refund', 'refund', 'check'].includes(action)) {
    return json({ error: 'Invalid action.' }, 400, h);
  }
  if (!orderId) return json({ error: 'orderId is required.' }, 400, h);

  /* ── 5b. Store credit has to be a thing this store does ────────────────────
     Asked BEFORE anything moves, and asked of the same switch the till reads.
     Issuing credit into a checkout that will not accept it hands somebody a
     code that does nothing — which is the exact promise this whole feature was
     removed from the return forms for making. */
  if (settlement === 'store_credit') {
    if (action !== 'refund' && action !== 'cancel_refund') {
      return json({ error: 'Store credit can only settle a refund.' }, 400, h);
    }
    if (!await storedValueEnabled(env)) {
      return json({
        error: 'Store credit is switched off. Turn it on under Coupons → Gift Cards & Store Credit before settling a return this way.',
      }, 409, h);
    }
  }

  // ── 6. Fetch order from Supabase ─────────────────────────────────────────────
  const sbKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
  const sbH   = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  const orderRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&select=*&limit=1`,
    { headers: sbH }
  );
  const orders = orderRes.ok ? await orderRes.json().catch(() => []) : [];
  const order  = orders?.[0];
  if (!order) return json({ error: 'Order not found.' }, 404, h);

  /* The limits an owner set under Users. The role said yes; this asks whether
     it is allowed for THIS refund.

     Placed AFTER the order loads, because it needs the order: the amount, and
     how many items the refund covers. Written earlier in the handler it read
     `order` before its declaration — a temporal dead zone error that would have
     thrown on every refund, not just limited ones.

     Amount in DOLLARS, because that is the unit the panel asks for. Passing
     cents against a limit written as "$500" would refuse every refund over five
     dollars and look exactly like the limit working. */
  const refundDollars = Number.isFinite(Number(amountCents))
    ? Number(amountCents) / 100
    : (Number(order.total) || null);
  const verdict = await decide(env, accessToken, 'refund', {
    action: 'refund',
    resource: {
      amount: refundDollars,
      /* How MANY, not just how much. A ten-item refund is a different kind of
         decision from an expensive one, and a store may want to stop one
         without stopping the other. */
      itemCount: Array.isArray(order.items) ? order.items.length : null,
      orderId: String(orderId || ''),
    },
  });
  if (!verdict.allow) {
    await audit(env, {
      adminId: String(admin.id || ''), adminEmail: String(admin.email || ''),
      orderId, action, success: false, note: `blocked by limit: ${verdict.reason}`,
    });
    return json({
      error: verdict.reason || 'A limit on your account stopped this refund.',
      limited: !!verdict.limited,
      /* Which limit, so the panel can ask about THIS one. A request that does
         not name the rule it is about cannot be turned into a waiver — the
         engine matches on it, and a yes to one limit is not a yes to all. */
      rule: verdict.rule || '',
      /* A super admin on a "notify" limit is told they may proceed by changing
         it — they have the power, they just have not used it. */
      ownerMayOverride: !!verdict.ownerMayOverride,
    }, 403, h);
  }

  // ── 7. Guard against invalid state transitions ───────────────────────────────
  if (order.status === 'cancelled') {
    return json({ error: 'Order is already cancelled.' }, 400, h);
  }
  /* `check` is allowed past, because the whole point of it is to report on an
     order in exactly this state before somebody tries. */
  if (order.status === 'refunded' && action !== 'cancel' && action !== 'check') {
    return json({ error: 'Order has already been fully refunded.' }, 400, h);
  }
  /* The column is named after Stripe and holds every processor's reference —
     see 0018. The message must not be, or a PayPal order with no capture id
     would be reported as a missing Stripe payment, sending whoever reads it to
     the wrong dashboard. */
  if (action !== 'cancel' && !order.stripe_payment_intent_id) {
    return json({ error: 'No payment reference on record for this order — cannot issue refund.' }, 400, h);
  }

  /* ── Refund it where it was taken ──────────────────────────────────────────
     order.stripe_payment_intent_id holds PayPal capture ids too:
     saveOrderToSupabase dedupes on that column, so reusing it kept idempotency
     working across both processors with no second code path. The cost is that
     the id no longer says who took the money — 0018 added `processor`.

     Everything in the Stripe block below would otherwise be handed a capture id
     Stripe has never seen, failing in Stripe's own words about a missing
     resource, at the moment a customer is owed money.

     `cancel` is allowed past either way: cancelling an unpaid order moves no
     money and touches no processor. */
  const processor = String(order.processor || 'stripe').toLowerCase();

  /* Cards this refund cancelled on its way through, so the response and the
     audit row can say so. An admin who refunds an order and is not told a $100
     card went with it will find out from the customer. */
  const voidedCards = [];


  /* ── 7b. A REFUND MUST NOT LEAVE A LIVE CARD THIS ORDER PAID FOR ─────────
     Buy a card, take the code, spend it, ask for the money back. Both halves
     are ordinary on their own and nothing connected them, so the store paid
     twice — in goods against the code, and in cash to the payment card.

     Three outcomes, and only one of them is automatic:

       nothing issued        proceed, this is every other order
       issued and unspent    void it here, then refund, and say what was voided
       issued and SPENT      refuse, with the amount, because this is now a
                             decision about who absorbs a loss and that is not
                             a decision an endpoint should make quietly

     A lookup that FAILED is treated as the third case. "Could not tell" is not
     "nothing to worry about" — the same rule the processor ledger already
     follows, where an unknown refunded-so-far must never be read as zero.

     Voided BEFORE the money moves. The other order — refund, then void — has a
     window where the customer has both the cash and a live code, and the void
     is the half more likely to fail. */
  if (action === 'refund' || action === 'cancel_refund') {
    const issued = await cardsIssuedByOrder(env, orderNo(order));
    const live = issued.cards.filter((c) => !c.alreadyVoid && c.balanceCents > 0);
    const spent = issued.cards.filter((c) => !c.alreadyVoid && c.balanceCents < c.issuedCents);

    if (!issued.known) {
      await audit(env, { adminId, adminEmail, orderId, action, success: false, note: 'blocked: could not read the gift cards this order issued' });
      return json({
        error: 'This order may have issued gift cards and we could not check them. '
             + 'Refunding now could pay for the same money twice — check the ledger and try again.',
      }, 503, h);
    }

    if (spent.length) {
      const spentCents = spent.reduce((sum, c) => sum + (c.issuedCents - c.balanceCents), 0);
      await audit(env, { adminId, adminEmail, orderId, action, success: false, note: `blocked: ${spent.length} gift card(s) from this order already spent` });
      return json({
        error: `This order bought gift cards and $${(spentCents / 100).toFixed(2)} of them has already been spent. `
             + 'Refunding in full would pay for that twice. Refund the unspent part, or void the cards first '
             + 'from Coupons and refund what is left.',
        giftCardsSpentCents: spentCents,
      }, 409, h);
    }

    for (const card of live) {
      try {
        await voidCode(env, card.code, 'Order ' + orderNo(order) + ' refunded');
        voidedCards.push({ cents: card.balanceCents });
      } catch (e) {
        /* Nothing has moved yet, which is the whole reason this runs first. */
        await audit(env, { adminId, adminEmail, orderId, action, success: false, note: 'blocked: could not void a gift card this order issued' });
        return json({
          error: 'Could not cancel a gift card this order paid for, so nothing was refunded. ' + ((e && e.message) || ''),
        }, 503, h);
      }
    }
  }

  // ── 8. Block refund if associated return item not yet received ───────────────
  if (action === 'refund' || action === 'cancel_refund') {
    try {
      const bundle = await getCommerceBundle(env);
      const requests = Array.isArray(bundle.returnsState?.requests) ? bundle.returnsState.requests : [];
      /* EVERY request for this order, not the first one found. An order can
         carry more than one — the bug that started this audit produced exactly
         that, a finished request beside a fresh one — and .find() picked
         whichever happened to be first. Which one that was decided whether the
         refund went through. */
      const linked = requests.filter(r => String(r.orderId || '') === String(orderId));

      /* `refunded` used to be in this set, so a return already paid out was
         read as clearance to pay it out again. It is the opposite: the
         strongest signal in the list that this is a second attempt. */
      const READY_TO_REFUND = new Set(['item_received', 'completed', 'closed']);

      const done = linked.find(r => String(r.status || '') === 'refunded');
      if (done) {
        await audit(env, { adminId, adminEmail, orderId, action, success: false, note: 'blocked: a return on this order is already refunded' });
        return json({
          error: 'A return on this order has already been refunded. Refunding again would pay for the same item twice — '
               + 'check the Returns tab for this order before continuing.',
          alreadyRefunded: true,
        }, 409, h);
      }

      const waiting = linked.find(r => !READY_TO_REFUND.has(String(r.status || '')));
      if (waiting) {
        await audit(env, { adminId, adminEmail, orderId, action, success: false, note: `blocked: return status is "${waiting.status}"` });
        return json({
          error: `Cannot issue refund — the returned item has not been received yet (return status: "${waiting.status}"). Mark the return as "Item Received" before refunding.`,
        }, 400, h);
      }
    } catch { /* if bundle fetch fails, do not block the refund — log only */ }
  }

  /* ── 8b. What has ALREADY been refunded ──────────────────────────────────────

     Nothing tracked this. A full refund sets order.status = 'refunded' and the
     guard above catches a second one — but a PARTIAL refund deliberately
     leaves the status alone, so $20 could be refunded on a $50 order four
     times over and every attempt looked like the first.

     Money did not actually escape, because Stripe keeps its own ledger and
     refuses a refund past the charge. But that is a backstop nobody chose,
     reached by pressing the button and reading whatever error came back — and
     it is silent about the far more common version, where the second refund is
     small enough to fit and simply should not have happened.

     So it is asked, and asked of STRIPE rather than tracked here. A number this
     side would be a second ledger to keep in step with the real one, and the
     day they disagree is the day it matters. */
  /* Which processor, asked once. Everything below goes through the interface
     in _processors.js rather than branching on a name: adding a third one
     should be a file and a registry line, not another arm on every `if`. */
  const proc = processorFor(order);
  if (!proc && action !== 'cancel') {
    await audit(env, { adminId, adminEmail, orderId, action, success: false, note: 'unknown processor: ' + processor });
    return json({
      error: 'This order was taken by "' + processor + '", which this build does not know how to refund. '
           + 'Issue it in that processor directly against ' + (order.stripe_payment_intent_id || 'the payment reference') + '.',
      processor,
    }, 400, h);
  }
  const reference = proc ? proc.reference(order) : '';

  /* What this panel has already sent back on this order. Some processors can
     answer completely from their own API and some cannot, so the ledger is
     read for all of them and each decides what to do with it. */
  let ledgerCents = 0, ledgerCount = 0;
  /* Money already sent back as CREDIT rather than through a processor, which no
     processor can be asked about — Stripe has never heard of it. Kept in its own
     field for exactly that reason: writing a credit settlement into
     `stripeRefundAmount` would make it count against the processor's own
     ledger, and the reconciliation above would report refunds that never
     happened to any card.

     It still has to be counted somewhere, because $50 given as credit and then
     $50 returned to the card is paying for the same item twice. */
  let creditCents = 0, creditCount = 0;
  try {
    const log = await getSetting(env, AUDIT_LOG_KEY, []);
    const mine = (Array.isArray(log) ? log : [])
      .filter((e) => e && e.success === true
        && String(e.orderId || '') === String(orderId)
        && (e.action === 'refund' || e.action === 'cancel_refund'));
    mine.filter((e) => Number(e.stripeRefundAmount) > 0)
      .forEach((e) => { ledgerCents += Math.round(Number(e.stripeRefundAmount)); ledgerCount++; });
    mine.filter((e) => Number(e.storeCreditCents) > 0)
      .forEach((e) => { creditCents += Math.round(Number(e.storeCreditCents)); creditCount++; });
  } catch (e) {
    console.warn('refund: could not read the refund ledger —', e && e.message);
  }

  let already = { refundedCents: 0, chargedCents: 0, count: 0, known: false };
  if (proc && reference) {
    already = await proc.refundedSoFar({ env, order, reference, ledgerCents, ledgerCount });
  }

  /* A read-only look at the same answer, so the panel can warn BEFORE somebody
     presses the button rather than after. It runs behind the identical
     authorization and authorization-code checks above — a preflight that is
     easier to reach than the action it describes is an information leak. */
  if (action === 'check') {
    return json({
      success: true, check: true, orderId, processor,
      alreadyRefundedCents: already.refundedCents,
      chargedCents: already.chargedCents,
      refundCount: already.count,
      known: already.known,
      /* So the panel can say "already settled as $40 of store credit" before
         somebody presses a button, rather than after. No processor can be asked
         this, so it comes from the ledger here. */
      storeCreditCents: creditCents,
      storeCreditCount: creditCount,
      /* PayPal can say a capture is partly refunded without saying by how much.
         Surfaced so the panel can warn rather than present an unqualified
         "nothing refunded yet". */
      ...(already.partiallyRefunded ? { partiallyRefunded: true } : {}),
      orderStatus: String(order.status || ''),
    }, 200, h);
  }

  // ── 9. Issue the refund, through whoever took the money ──────────────────────
  /* Named after Stripe and no longer about it: these hold whichever processor's
     refund id and amount. Deliberately NOT renamed — they are the field names
     in refund_audit_log, and the ledger reconciliation above sums
     `stripeRefundAmount` out of it. Renaming here without a migration over the
     existing log would make every historical refund invisible to that sum,
     which is the one number a double refund depends on. */
  let stripeRefundId     = null;
  let stripeRefundAmount = null;
  /* Kept apart from the two above on purpose — see the ledger note. The code is
     returned to the panel and put in the customer's email, and deliberately
     never written to the audit log: that log is readable by more admins than
     may issue, and a list of live codes is a list of spendable money. */
  let storeCreditCents = 0;
  let storeCreditCode  = '';

  if (action === 'refund' || action === 'cancel_refund') {
    /* Somebody refunded this in the processor's own dashboard and this panel
       has no record of how much. Refusing is the only honest move: a full
       refund would send back money that has partly gone already, and the
       processor's own ceiling catches the total but not a partial that happens
       to fit under it. Reported by any processor that can tell. */
    if (already.refundedOutsideThisPanel) {
      await audit(env, { adminId, adminEmail, orderId, action, success: false, note: 'blocked: refunded outside this panel, amount unknown' });
      return json({
        error: proc.label + ' reports part of this payment has already been refunded, but it was not done here — '
             + 'so this panel cannot tell how much is left. Check it in ' + proc.label + ' and issue the remainder there.',
        processor, chargedCents: already.chargedCents, partiallyRefunded: true,
      }, 409, h);
    }

    /* Refuse rather than let the processor refuse. Same outcome for the money,
       but this can say what already happened and who did it, instead of handing
       an admin a raw API error about an amount they cannot see.

       Only when the figure is KNOWN. An unknown one must not be treated as
       zero — a zero reads as "nothing refunded yet" and permits exactly the
       second refund these guards exist to stop. */
    /* Credit already given comes off the same ceiling as money already sent
       back. They are different tenders and the same debt: an order that has had
       $50 returned to the card and an order that has had $50 issued as credit
       both owe the customer nothing more. */
    const remaining = Math.max(0, already.chargedCents - already.refundedCents - creditCents);
    const wanted = (action === 'refund' && amountCents && Number.isFinite(Number(amountCents)))
      ? Math.round(Number(amountCents))
      : remaining;

    /* "$40 has already gone back" is wrong when $40 of it went out as credit —
       it never went back anywhere, and an admin reading that would go looking
       for a card refund that does not exist. Both figures, named. */
    const goneBack = () => {
      const parts = [];
      if (already.refundedCents > 0) parts.push(`$${(already.refundedCents / 100).toFixed(2)} to the card`);
      if (creditCents > 0) parts.push(`$${(creditCents / 100).toFixed(2)} as store credit`);
      return parts.join(' and ');
    };

    if (already.known) {
      if (remaining <= 0) {
        await audit(env, { adminId, adminEmail, orderId, action, success: false,
          note: `blocked: already settled in full (${already.count} refund${already.count === 1 ? '' : 's'}, ${creditCount} credit${creditCount === 1 ? '' : 's'})` });
        return json({
          error: `This order has already been settled in full — ${goneBack()}. Nothing further can be refunded.`,
          processor, alreadyRefundedCents: already.refundedCents, chargedCents: already.chargedCents,
          storeCreditCents: creditCents,
        }, 409, h);
      }
      if (wanted > remaining) {
        await audit(env, { adminId, adminEmail, orderId, action, success: false,
          note: `blocked: ${wanted}c requested, ${remaining}c remaining` });
        return json({
          error: `Only $${(remaining / 100).toFixed(2)} is left to refund on this order — `
               + `${goneBack()} already. Nothing was charged or refunded.`,
          processor, alreadyRefundedCents: already.refundedCents, chargedCents: already.chargedCents,
          storeCreditCents: creditCents,
        }, 409, h);
      }
    }

    /* 0 means "everything" to every processor here, and letting each one apply
       its own idea of the full amount avoids a cent of disagreement on the one
       refund that has to be exact. */
    const wantedCents = (action === 'refund' && amountCents && Number.isFinite(Number(amountCents)))
      ? Math.round(Number(amountCents)) : 0;

    /* ── SETTLED AS STORE CREDIT ─────────────────────────────────────────────
       No processor is called and no money leaves the bank. The customer gets an
       instrument worth what they paid, the sale is still reversed for tax, the
       order is still marked settled and the return still closes — the only
       difference is the tender.

       A CREDIT ISSUED TWICE IS MONEY GIVEN TWICE, and the realistic way that
       happens is an admin clicking again because the first click looked like it
       did nothing. A processor would absorb that through an idempotency key;
       nothing here can, because issuing writes a new instrument every time by
       design. So the amount has to be KNOWN before anything is written: an
       unknown ceiling is refused rather than guessed at, and the ledger read
       above is what a second click runs into.

       `full` here has to be decided from the ORDER, not from wantedCents being
       zero the way the processors read it — nothing downstream would know how
       much to issue. */
    if (settlement === 'store_credit') {
      if (!already.known) {
        await audit(env, { adminId, adminEmail, orderId, action, success: false,
          note: 'blocked: store credit needs a known ceiling' });
        return json({
          error: 'We could not confirm how much is left to refund on this order, and store credit cannot be un-issued. '
               + 'Refund it to the card, or check the payment in ' + (proc ? proc.label : processor) + ' first.',
          processor,
        }, 409, h);
      }
      const creditToIssue = wantedCents > 0 ? wantedCents : remaining;
      if (creditToIssue <= 0) {
        return json({ error: 'There is nothing left to settle on this order.', processor }, 409, h);
      }

      let issued;
      try {
        issued = await issueStoredValue(env, {
          kind: 'store_credit',
          cents: creditToIssue,
          /* Bound to the account when the order has one, so it appears on their
             account page rather than only in an email they have to keep. An
             order placed as a guest has no account to bind and travels as a
             code, which is what the email is for. */
          ownerUserId: order.user_id || null,
          ownerEmail: order.email || '',
          issuedBy: adminId,
          reason: `Return settled as store credit — order ${orderNo(order)}${reason ? ` (${reason})` : ''}`,
          sourceRef: 'refund:' + String(orderId),
        });
      } catch (e) {
        /* Nothing has moved. The order is untouched, the return is still open,
           and the admin can try again or settle it to the card instead — which
           is why issuing comes before every write below rather than after. */
        await audit(env, { adminId, adminEmail, orderId, action, success: false, note: 'store credit not issued: ' + (e && e.message) });
        return json({ error: 'Could not issue the store credit: ' + ((e && e.message) || 'unknown error') + ' Nothing was refunded.' }, 502, h);
      }

      storeCreditCents = creditToIssue;
      storeCreditCode = issued.code;
    } else {

      const out = await proc.refund({
        env, order, reference,
        amountCents: wantedCents,
        reason, adminId, adminEmail, action,
        /* Derived from the order and the amount, so a double-click is the SAME
           request rather than a second refund. This matters more than at capture:
           a refund issued twice is money leaving twice, and the obvious trigger
           is an admin clicking again because the first click looked like it did
           nothing. Processors that support an idempotency key use it; the others
           ignore it. */
        idempotencyKey: 'zwr_' + (await sha256Base64Url(String(orderId) + ':' + wantedCents)).slice(0, 40),
      });

      if (!out.ok) {
        await audit(env, { adminId, adminEmail, orderId, action, success: false, note: proc.id + ': ' + out.error });
        return json({ error: out.error, processor }, out.alreadyRefunded ? 409 : 400, h);
      }
      stripeRefundId     = out.id;
      stripeRefundAmount = out.amountCents || wantedCents || already.chargedCents;
    }

    /* Tell the tax provider the sale came back, so the tax on it stops being
       something this store owes the state. Refunding the customer without
       reversing the filing record means paying tax on a sale that no longer
       exists — quietly, and only discoverable by reconciling by hand.

       Whichever provider is configured; this code does not know which. After
       the refund, never before: reversing tax on a refund that then fails is
       worse than the other order, and never fatal, because the customer's money
       has already moved and a bookkeeping call must not turn that into an
       error the admin sees as "the refund failed". */
    try {
      const orderTax = Math.round(Number(order.tax || 0) * 100);
      const orderGross = Math.round(Number(order.total || 0) * 100);
      /* Whichever tender settled it. A sale returned as store credit is just as
         returned as one refunded to a card — the goods came back, so the tax on
         them stops being something this store owes the state. The customer will
         owe tax again on whatever they spend the credit on, which is a
         different sale. */
      const refunded = Number(stripeRefundAmount || storeCreditCents || 0);
      const isFull = !refunded || refunded >= orderGross;
      /* The tax inside this refund, in proportion to what was sent back. */
      const taxPortion = isFull
        ? orderTax
        : (orderGross > 0 ? Math.round(orderTax * (refunded / orderGross)) : 0);

      /* The filing reference now lives on the order (0019). It used to be
         written as metadata onto the Stripe PaymentIntent, which works for
         exactly as long as Stripe is the only processor — a PayPal order has no
         intent, so the reference was never stored and the refund reversed
         nothing, silently.

         Orders placed before 0019 still have it only on the intent, so each
         processor supplies its own legacy lookup and Stripe's is the only one
         that finds anything. Nothing needs backfilling. */
      const taxTxn = String(order.tax_txn || '')
        || (proc.legacyTaxTransactionId ? await proc.legacyTaxTransactionId({ env, reference }) : '');
      const result = await reverseTaxSale({
        env,
        transactionId: taxTxn,
        order: {
          orderNumber: orderNo(order),
          address: {
            line1: order.ship_line1 || '', city: order.ship_city || '',
            state: order.ship_state || '', zip: order.ship_zip || '',
            country: order.ship_country || 'US',
          },
        },
        amountCents: refunded || orderGross,
        taxCents: taxPortion,
        full: isFull,
      });
      if (!result.ok && !result.skipped) {
        console.error('[tax] refund NOT reversed with ' + result.engine + ':', result.error);
        await audit(env, {
          adminId, adminEmail, orderId, action, success: true,
          note: `tax not reversed (${result.engine}): ${result.error}`,
        });
      }
    } catch (e) {
      console.error('[tax] refund reversal threw:', e && e.message);
    }
  }

  // ── 10. Update order in Supabase ─────────────────────────────────────────────
  const orderTotalCents = Math.round(Number(order.total || 0) * 100);
  const isFullRefund    = action === 'cancel_refund'
    || (action === 'refund' && (!amountCents || Math.round(Number(amountCents)) >= orderTotalCents));

  const patch = {
    status: action === 'cancel' ? 'cancelled' : isFullRefund ? 'refunded' : order.status,
  };

  await fetch(`${env.SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`, {
    method:  'PATCH',
    headers: { ...sbH, Prefer: 'return=minimal' },
    body:    JSON.stringify(patch),
  });

  /* ── 10b. Close the return this refund just settled ─────────────────────────

     Three places can refund an order, and only the one doing it knew. A return
     sitting at "item received" stayed open after the money went back from
     Receipts — so the workspace showed work outstanding that was already done,
     and the customer's account page showed a request still under review after
     they had been refunded.

     Marked `refunded` rather than `completed`, which is what the returns
     workspace sets when somebody does it from there — same status, so the two
     routes leave the same record and nothing downstream has to know which was
     used.

     Never fatal. The money has already moved; failing the request now would
     say the refund did not happen, and somebody would do it again. */
  if ((action === 'refund' || action === 'cancel_refund') && (stripeRefundId || storeCreditCode)) {
    try {
      const bundle = await getCommerceBundle(env);
      const list = Array.isArray(bundle.returnsState?.requests) ? bundle.returnsState.requests : [];
      const OPEN = new Set(['requested', 'approved', 'label_sent', 'item_received', 'exchange_in_progress']);
      const hits = list.filter(r => r && String(r.orderId || '') === String(orderId) && OPEN.has(String(r.status || '')));
      if (hits.length) {
        const at = new Date().toISOString();
        /* Appended, not replaced — an inspection note somebody wrote by
           hand is the reason this return was settled the way it was. */
        const line = storeCreditCode
          ? `Settled as $${(storeCreditCents / 100).toFixed(2)} of store credit from the refund panel `
            + `by ${adminEmail || adminId} on ${at}. The code is in the customer's email and on their account.`
          : `Refunded from the ${action === 'cancel_refund' ? 'cancellation' : 'refund'} `
            + `panel by ${adminEmail || adminId} on ${at}.`;
        const noteWith = (prev) => (String(prev || '').trim() ? `${String(prev).trim()}
${line}` : line);
        await mutateSetting(env, 'commerce_returns', (cur) => {
          const state = (cur && typeof cur === 'object') ? cur : {};
          const reqs = Array.isArray(state.requests) ? state.requests : [];
          return {
            ...state,
            requests: reqs.map(r => (r && hits.some(h => h.id === r.id)
              ? {
                  ...r,
                  status: 'refunded',
                  /* So the customer's account page and the admin table say
                     "Store Credit" rather than "Refund" — the vocabulary that
                     was deliberately kept when the option was removed is now
                     being written again, by the thing that actually issued it. */
                  ...(storeCreditCode ? { resolution: 'store_credit', storeCreditCents } : {}),
                  updatedAt: at,
                  internalNotes: noteWith(r.internalNotes),
                }
              : r)),
          };
        });
      }
    } catch (e) {
      console.warn('refund: could not close the linked return —', e && e.message);
    }
  }

  // ── 11. Audit log ─────────────────────────────────────────────────────────────
  await audit(env, {
    adminId, adminEmail, orderId, action, success: true,
    reason:            reason || '',
    stripeRefundId,
    stripeRefundAmount,
    /* The amount, never the code. This is the field the ledger read at the top
       sums to stop a second payout, so it has to be here — and it is separate
       from stripeRefundAmount so the processor reconciliation never sees a
       refund that no card ever received. */
    settlement,
    ...(storeCreditCents > 0 ? { storeCreditCents } : {}),
    /* Cards this refund cancelled. The amount, never the code — same rule the
       issuing log follows, and these are dead codes either way. */
    ...(voidedCards.length ? {
      giftCardsVoided: voidedCards.length,
      giftCardsVoidedCents: voidedCards.reduce((sum, c) => sum + c.cents, 0),
    } : {}),
    newStatus:         patch.status,
    customerEmail:     order.email,
    orderTotal:        order.total,
  });

  // ── 12. Customer refund notification email ────────────────────────────────────
  if ((action === 'cancel_refund' || action === 'refund') && order.email) {
    await sendRefundEmail(env, {
      customerEmail:     order.email,
      customerName:      order.customer_name || order.email,
      orderNumber:       orderNo(order),
      action,
      orderTotal:        order.total,
      stripeRefundAmount,
      reason,
      customerNote:      String(customerNote || '').trim(),
      /* The one place the code is allowed to go: to the person it belongs to.
         A customer with no account has nothing but this email — it IS the
         instrument for them, which is why the email is worth more here than a
         "your refund is on its way" ever was. */
      storeCreditCode,
      storeCreditCents,
    });
  }

  return json({
    success: true, action, orderId, settlement,
    newStatus: patch.status, stripeRefundId, stripeRefundAmount,
    /* Returned so the panel can show it once and the admin can read it out if
       the email does not arrive. Nothing stores it anywhere they can get it
       back from. */
    ...(storeCreditCode ? { storeCreditCode, storeCreditCents } : {}),
    ...(voidedCards.length ? {
      giftCardsVoided: voidedCards.length,
      giftCardsVoidedCents: voidedCards.reduce((sum, c) => sum + c.cents, 0),
    } : {}),
  }, 200, h);
}

// ── Helpers ───────────────────────────────────────────────────────────────────


/* Stripe's ledger, not ours. `known` is the load-bearing field: a failed read
   must not read as "nothing refunded yet", which is what a bare 0 would do —
   and that reading permits exactly the refund this exists to stop. Callers
   check `known` before trusting the numbers. */

async function audit(env, entry) {
  try {
    const existing = await getSetting(env, AUDIT_LOG_KEY, []);
    const log = Array.isArray(existing) ? existing : [];
    log.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), ...entry });
    await setSetting(env, AUDIT_LOG_KEY, log.slice(0, 500));
  } catch { /* never block a refund because logging failed */ }
}

// ── Lockout alert email ───────────────────────────────────────────────────────

async function sendLockoutAlert(env, { adminEmail, adminId, orderId, attempts, lockedUntil }) {
  try {
    const cache      = await fetchSiteSettings(['RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM', 'brand'], env);
    const resendKey  = resolveSetting('RESEND_API_KEY', env, cache);
    const brevoKey   = resolveSetting('BREVO_API_KEY',  env, cache);
    const fromEmail  = resolveSetting('EMAIL_FROM', env, cache) || 'alerts@zuwera.store';
    const alertEmail = adminEmail || env.ADMIN_EMAILS?.split(',')[0]?.trim();
    const brand      = getEmailAppearance(cache, env).brand;

    if (!alertEmail || (!resendKey && !brevoKey)) return;

    const lockedUntilStr = new Date(lockedUntil).toUTCString();
    const subject = '⚠ Security Alert — Refund Authorization Lockout';
    const html = `
<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111">
  <div style="border-top:3px solid #e05050;padding-top:20px">
    <h2 style="margin:0 0 8px;color:#e05050">Refund Lockout Triggered</h2>
    <p style="color:#555;margin:0 0 20px">Someone entered the wrong refund authorization code <strong>${attempts} times</strong> on your ${esc(brand)} admin panel. Refund access has been locked for 1 hour.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
      <tr style="border-bottom:1px solid #eee"><td style="padding:8px 4px;color:#888">Admin account</td><td style="padding:8px 4px"><strong>${esc(adminEmail)}</strong></td></tr>
      <tr style="border-bottom:1px solid #eee"><td style="padding:8px 4px;color:#888">Failed attempts</td><td style="padding:8px 4px"><strong>${attempts}</strong></td></tr>
      <tr style="border-bottom:1px solid #eee"><td style="padding:8px 4px;color:#888">Target order</td><td style="padding:8px 4px">${orderId ? esc(orderNoPlain(String(orderId))) : 'N/A'}</td></tr>
      <tr><td style="padding:8px 4px;color:#888">Locked until</td><td style="padding:8px 4px">${esc(lockedUntilStr)}</td></tr>
    </table>
    <p style="font-size:13px;color:#888">If this was you, wait 1 hour and try again with the correct code. If you did not attempt this, your admin session may be compromised — change your password immediately.</p>
    <p style="font-size:12px;color:#bbb;margin-top:24px;border-top:1px solid #eee;padding-top:12px">${esc(brand)} Admin Security &nbsp;·&nbsp; This is an automated alert</p>
  </div>
</body></html>`;

    if (resendKey) {
      await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ from: fromEmail, to: [alertEmail], subject, html }),
      });
      return;
    }

    if (brevoKey) {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method:  'POST',
        headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          sender:  { email: fromEmail, name: brand + ' Security' },
          to:      [{ email: alertEmail }],
          subject,
          htmlContent: html,
        }),
      });
    }
  } catch { /* alert is best-effort, never block the lockout response */ }
}

// ── Customer refund / cancellation email ─────────────────────────────────────

// Builds the refund email on the shared shell. Exported so the admin email
// preview can render it with sample data (a refund can't be triggered on demand).
export function buildRefundEmail({ action, orderNumber, orderTotal, stripeRefundAmount, reason, customerName, customerNote, fromEmail, appearance, storeCreditCode = '', storeCreditCents = 0 }) {
  const a = appearance;
  const isCredit    = !!storeCreditCode;
  const isPartial   = action === 'refund';
  const refundAmt   = isCredit
    ? `$${(Number(storeCreditCents || 0) / 100).toFixed(2)}`
    : stripeRefundAmount ? `$${(stripeRefundAmount / 100).toFixed(2)}` : `$${Number(orderTotal || 0).toFixed(2)}`;
  const orderAmt    = `$${Number(orderTotal || 0).toFixed(2)}`;
  const firstName   = esc(String(customerName || '').split(' ')[0] || 'there');
  const reasonText  = reason === 'duplicate'   ? 'Duplicate order'
    : reason === 'fraudulent'                  ? 'Fraudulent transaction'
    : reason === 'out_of_stock'                ? 'Item out of stock'
    : 'Customer request';

  const subject = isCredit
    ? `${refundAmt} in store credit — Order ${esc(orderNumber)}`
    : isPartial
      ? `Partial refund of ${refundAmt} processed — Order ${esc(orderNumber)}`
      : `Your refund of ${refundAmt} is on its way — Order ${esc(orderNumber)}`;

  const sumRow = (labelTxt, val, strong) => `
    <tr><td style="padding:11px 16px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${a.muted};width:42%;border-bottom:1px solid ${a.border};font-family:${a.fontMono};">${labelTxt}</td>
    <td style="padding:11px 16px;font-size:13px;color:${a.text};${strong ? 'font-weight:700;' : ''}border-bottom:1px solid ${a.border};">${val}</td></tr>`;
  /* ── THE CREDIT VERSION IS A DIFFERENT EMAIL, NOT A RELABELLED ONE ────────
     Everything the refund email says about timing is false here: no bank is
     involved, nothing takes 5–10 business days, and nothing will ever appear on
     a statement. Telling somebody to watch their card for money that is sitting
     in their account instead is how a settled return turns into a support
     ticket. And for a guest order this email IS the instrument — there is no
     account page to fall back on — so the code is the loudest thing on it. */
  const creditBody = `
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${a.border};border-radius:8px;overflow:hidden;margin-bottom:24px;text-align:center;">
      <tr><td style="padding:24px 20px;background:rgba(128,128,128,.06);">
        <p style="margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:${a.muted};font-family:${a.fontMono};">Store credit</p>
        <p style="margin:0;font-size:42px;font-weight:800;color:${a.text};letter-spacing:-.02em;font-family:${a.fontHead};line-height:1;">${esc(refundAmt)}</p>
      </td></tr>
    </table>
    <p style="margin:0 0 22px;font-size:14px;color:${a.muted};line-height:1.75;">Hi ${firstName}, your return is settled. We've put <strong style="color:${a.text};">${esc(refundAmt)}</strong> of store credit on your account — enter the code below at checkout and it comes straight off what you owe.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px dashed ${a.border};border-radius:8px;overflow:hidden;margin-bottom:24px;text-align:center;">
      <tr><td style="padding:20px;">
        <p style="margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:${a.muted};font-family:${a.fontMono};">Your code</p>
        <p style="margin:0;font-size:22px;font-weight:700;letter-spacing:.16em;color:${a.text};font-family:${a.fontMono};">${esc(storeCreditCode)}</p>
      </td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${a.border};border-radius:8px;overflow:hidden;margin-bottom:24px;">
      ${sumRow('Order', esc(orderNumber), true)}
      ${sumRow('Credit', esc(refundAmt), true)}
      ${sumRow('Reason', esc(reasonText))}
      ${sumRow('Available', 'Now — it does not expire')}
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(128,128,128,.06);border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${a.muted};font-family:${a.fontMono};">How to use it</p>
        <p style="margin:0;font-size:13px;color:${a.muted};line-height:1.65;">At checkout, enter the code in the <strong style="color:${a.text};">Gift Card or Store Credit</strong> box. If it is worth more than your order, the rest stays on the code for next time. Keep this email — it is the only copy of the code we send.</p>
      </td></tr>
    </table>
    ${customerNote ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${a.border};border-radius:8px;overflow:hidden;margin-bottom:24px;">
      <tr><td style="padding:11px 16px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${a.muted};background:rgba(128,128,128,.06);font-family:${a.fontMono};">A note from us</td></tr>
      <tr><td style="padding:14px 16px;font-size:13px;color:${a.text};line-height:1.65;white-space:pre-wrap;">${esc(customerNote)}</td></tr>
    </table>` : ''}
    <p style="margin:0;font-size:13px;color:${a.muted};line-height:1.6;">Questions? Reach us at <a href="mailto:${esc(fromEmail)}" style="color:${a.accent};font-weight:600;text-decoration:underline;">${esc(fromEmail)}</a></p>`;

  const body = `
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${a.border};border-radius:8px;overflow:hidden;margin-bottom:24px;text-align:center;">
      <tr><td style="padding:24px 20px;background:rgba(128,128,128,.06);">
        <p style="margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:${a.muted};font-family:${a.fontMono};">Amount refunded</p>
        <p style="margin:0;font-size:42px;font-weight:800;color:${a.text};letter-spacing:-.02em;font-family:${a.fontHead};line-height:1;">${esc(refundAmt)}</p>
        ${isPartial ? `<p style="margin:8px 0 0;font-size:12px;color:${a.muted};">Partial refund · Order total was ${esc(orderAmt)}</p>` : ''}
      </td></tr>
    </table>
    <p style="margin:0 0 22px;font-size:14px;color:${a.muted};line-height:1.75;">Hi ${firstName}, we've processed your ${isPartial ? 'partial refund' : 'refund'}. Depending on your bank or card issuer, it will appear on your statement within <strong style="color:${a.text};">5–10 business days</strong>.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${a.border};border-radius:8px;overflow:hidden;margin-bottom:24px;">
      ${sumRow('Order', esc(orderNumber), true)}
      ${sumRow('Refund', esc(refundAmt), true)}
      ${sumRow('Reason', esc(reasonText))}
      ${sumRow('Timeline', '5–10 business days')}
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(128,128,128,.06);border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${a.muted};font-family:${a.fontMono};">Don't see it after 10 days?</p>
        <p style="margin:0;font-size:13px;color:${a.muted};line-height:1.65;">Check your bank statement for a credit from ${esc(a.brand)}. If it still hasn't appeared, reply to this email and we'll look into it right away.</p>
      </td></tr>
    </table>
    ${customerNote ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${a.border};border-radius:8px;overflow:hidden;margin-bottom:24px;">
      <tr><td style="padding:11px 16px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${a.muted};background:rgba(128,128,128,.06);font-family:${a.fontMono};">A note from us</td></tr>
      <tr><td style="padding:14px 16px;font-size:13px;color:${a.text};line-height:1.65;white-space:pre-wrap;">${esc(customerNote)}</td></tr>
    </table>` : ''}
    <p style="margin:0;font-size:13px;color:${a.muted};line-height:1.6;">Questions? Reach us at <a href="mailto:${esc(fromEmail)}" style="color:${a.accent};font-weight:600;text-decoration:underline;">${esc(fromEmail)}</a></p>`;

  const html = renderEmailShell(a, {
    kicker:  isCredit ? 'Store credit' : isPartial ? 'Partial refund' : 'Refund confirmed',
    heading: isCredit ? 'Your credit is ready to spend' : 'Your money is on its way back',
    intro:   '',
    bodyHtml: isCredit ? creditBody : body,
    footer:  `© ${new Date().getFullYear()} ${esc(a.brand)} · This is an automated message`,
  });
  return { subject, html };
}

async function sendRefundEmail(env, { customerEmail, customerName, orderNumber, action, orderTotal, stripeRefundAmount, reason, customerNote, storeCreditCode = '', storeCreditCents = 0 }) {
  try {
    const cache     = await fetchSiteSettings(['RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM', 'BRAND_LOGO_URL', 'fonts', 'brand', 'email_theme'], env);
    const resendKey = resolveSetting('RESEND_API_KEY', env, cache);
    const brevoKey  = resolveSetting('BREVO_API_KEY',  env, cache);
    const fromEmail = resolveSetting('EMAIL_FROM', env, cache) || 'support@zuwera.store';
    const a         = getEmailAppearance(cache, env);
    a.logo = resolveSetting('BRAND_LOGO_URL', env, cache) || a.logo;   // covers an env-var logo

    if (!customerEmail || (!resendKey && !brevoKey)) return;

    const { subject, html } = buildRefundEmail({
      action, orderNumber, orderTotal, stripeRefundAmount, reason, customerName, customerNote, fromEmail, appearance: a,
      storeCreditCode, storeCreditCents,
    });

    if (resendKey) {
      await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ from: fromEmail, to: [customerEmail], subject, html }),
      });
      return;
    }

    if (brevoKey) {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method:  'POST',
        headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          sender:      { email: fromEmail, name: a.brand },
          to:          [{ email: customerEmail }],
          subject,
          htmlContent: html,
        }),
      });
    }
  } catch { /* never block the refund response because email failed */ }
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
