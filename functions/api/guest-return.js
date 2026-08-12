/**
 * POST /api/guest-return — returns for people who never made an account.
 *
 * The whole returns flow hung off the account page, so a guest could buy but
 * could not send anything back. That is not a small gap: guest checkout is the
 * default path, and on this store's own numbers the single largest spender has
 * no profile at all. "Create an account to return the thing you already bought"
 * is a support email, not a policy.
 *
 * THE SHAPE, and why it is this shape.
 *
 * An order number plus an email is a lookup anyone can attempt. So a successful
 * lookup does not hand back access — it EMAILS a link to the address already on
 * the order. Guess right and the person who actually placed the order gets an
 * email; you get the same sentence you would have got for guessing wrong.
 *
 * That is also why every reply to `start` is identical. Answering "no such
 * order" would turn this into an oracle for which order numbers exist and which
 * address goes with them, and order numbers are not secret — they are printed
 * on packing slips.
 *
 * The link carries a signed token that is good for one order, for a short
 * while, and for nothing else. It is not a login: it cannot read a profile,
 * change an address, or see another order.
 */

import { cors, json, getCommerceBundle, mutateSetting } from './_commerce.js';
import { fetchSiteSettings, resolveSetting } from './_settings.js';
import { sendTransactional } from './_email.js';
import { returnEligibility, reconcileReturnItems, spokenForOn } from './_returns.js';
import { orderNo, orderNoPlain, normalizeOrderNo, sameOrderNo } from './_order-no.js';
import { messagesFrom } from './_messages.js';
import { notifyOps } from './_notify-ops.js';
import { getEmailAppearance, getEmailContent, fillTemplate, renderEmailShell } from './_email-theme.js';
import { TTL } from './_order-token.js';

/* How long the link lasts, said in words, derived from the TTL rather than
   written beside it. The email used to state "one hour" as a literal string, so
   changing the constant would have left the email confidently lying about it —
   and this is the sentence a customer uses to decide whether to click now or
   later. */
function linkLifetimeSentence() {
  const hours = Math.round(TTL['guest-return'] / (60 * 60 * 1000));
  const span = hours >= 48 ? Math.round(hours / 24) + ' days'
    : hours > 1 ? hours + ' hours'
    : 'one hour';
  return 'This link works for ' + span + ' and only for this order.';
}

/**
 * The "start your return" email.
 *
 * It was three bare <p> tags — no shell, no logo, no theme — which is how it
 * ended up looking like a password reset from 2009. That is a poor thing to
 * send someone at the exact moment they are already unhappy enough to be
 * returning something.
 *
 * Exported so the admin preview renders the real thing rather than a copy of
 * it, which is the arrangement every other email here uses and the reason the
 * preview cannot drift from what actually sends.
 */
export function buildReturnLinkEmail({ appearance, content, orderLabel, link }) {
  const a = appearance;
  const body = `
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
          <tr><td align="center" style="padding:8px 0 4px;">
            <a href="${link}" style="display:inline-block;padding:15px 38px;background:${a.accent};color:${a.light ? '#fff' : '#0b0b0d'};text-decoration:none;border-radius:3px;font-size:13px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;font-family:${a.fontMono};">Start my return</a>
          </td></tr>
          <tr><td style="padding:22px 0 0;">
            <p style="margin:0;font-size:13px;line-height:1.7;color:${a.muted};text-align:center;">${linkLifetimeSentence()}</p>
          </td></tr>
          <tr><td style="padding:18px 0 0;">
            <div style="border-top:1px solid ${a.border};padding-top:18px;">
              <p style="margin:0 0 6px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${a.muted};font-weight:600;font-family:${a.fontMono};">If the button does not work</p>
              <p style="margin:0;font-size:12px;line-height:1.6;color:${a.muted};word-break:break-all;">
                <a href="${link}" style="color:${a.muted};text-decoration:underline;">${link}</a>
              </p>
            </div>
          </td></tr>
        </table>`;

  return renderEmailShell(a, {
    kicker:  fillTemplate(content.kicker, { order: orderLabel }),
    heading: fillTemplate(content.heading, { order: orderLabel }),
    intro:   fillTemplate(content.intro, { order: orderLabel }),
    bodyHtml: body,
    footerHtml: fillTemplate(content.footer || '', { order: orderLabel }),
  });
}
/* Minting and reading moved to _order-token.js when the order confirmation
   email needed to mint one too. Three callers, one definition of what a valid
   token is — a second copy is how two definitions drift and only one of them
   gets the next fix. */
import { mintOrderToken, readOrderToken } from './_order-token.js';

/* Orders are read with the service key because there is no session to read them
   under — that is the entire point. Narrowed to the one order the token names,
   never a list.
 *
 * A token identifies its order EITHER by row id (the returns flow, which found
 * the row before it minted anything) or by PaymentIntent id (the confirmation
 * email, which is composed before the row exists and never learns its id).
 * Both land on exactly one order; which column is used is an accident of when
 * the token was made, not a difference in what it may see. */
async function fetchOrder(env, claim) {
  const url = (env.SUPABASE_URL || '').trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !key || !claim) return null;
  const where = claim.o
    ? 'id=eq.' + encodeURIComponent(claim.o)
    : 'stripe_payment_intent_id=eq.' + encodeURIComponent(claim.pi || '');
  if (!claim.o && !claim.pi) return null;
  const resp = await fetch(
    url + '/rest/v1/orders?' + where + '&select=*&limit=1',
    { headers: { apikey: key, Authorization: 'Bearer ' + key } },
  );
  if (!resp.ok) return null;
  const rows = await resp.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/* Match on the order number as printed, and on the email as typed. Both are
   compared loosely on case and spacing only — a customer reading a packing slip
   should not fail on a capital letter. */
async function findOrderByNumber(env, orderNumber, email) {
  const url = (env.SUPABASE_URL || '').trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
  const wanted = normalizeOrderNo(orderNumber);
  const mail = String(email || '').trim().toLowerCase();
  if (!url || !key || !wanted || !mail) return null;

  const resp = await fetch(
    url + '/rest/v1/orders?email=ilike.' + encodeURIComponent(mail) + '&select=*&limit=50',
    { headers: { apikey: key, Authorization: 'Bearer ' + key } },
  );
  if (!resp.ok) return null;
  const rows = await resp.json().catch(() => []);
  /* orderNo() rather than the raw column, so whatever is printed on the
     customer's receipt is what matches here — the two drifting apart is a bug
     this codebase has already had once.

     sameOrderNo, not string equality: the printed number carries a leading '#'
     and a pasted one may or may not. Telling a customer their own order number
     is wrong because of a character they did not type is the kind of thing that
     turns a return into a support email. */
  return (Array.isArray(rows) ? rows : []).find((o) => sameOrderNo(orderNo(o), wanted)) || null;
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  const h = cors(env);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, 400, h); }
  const action = String(body?.action || '').trim();

  // ── 1. "Send me a link" ───────────────────────────────────────────────────
  if (action === 'start') {
    /* One sentence, always, whatever happened. See the note at the top: any
       variation here turns this into a way to test which order numbers and
       emails are real. */
    const same = json({
      success: true,
      message: 'If that order number and email match an order, we have emailed a link to start your return.',
    }, 200, h);

    try {
      const order = await findOrderByNumber(env, body.orderNumber, body.email);
      if (!order) return same;

      const token = await mintOrderToken(env, { purpose: 'guest-return', orderId: order.id, email: order.email });
      if (!token) {
        /* The entire returns flow is off, and the page still says "we have
           emailed a link". That sentence is deliberately unconditional so it
           cannot be used to probe which orders exist — which is right for the
           CUSTOMER and useless for the operator, who then has a feature that is
           silently dead and a customer who thinks they started a return.
           Nobody finds out until someone complains.
           The customer's reply is unchanged. The person who can fix it gets
           told, on the loudest channel there is. */
        console.error('[guest-return] no signing secret configured — link not sent');
        try {
          await notifyOps(env, {
            key: 'returns-no-signing-secret',
            severity: 'critical',
            event: 'Returns are silently failing — no signing secret configured',
            detail: 'A customer asked to start a return on order ' + orderNo(order)
              + ' and no email could be sent, because neither RETURN_TOKEN_SECRET nor '
              + 'CHECKOUT_RATE_SECRET is set in Cloudflare. Every return request is '
              + 'failing this way, and the returns page tells customers the link was '
              + 'sent. Set RETURN_TOKEN_SECRET to any long random string to fix it.',
          });
        } catch (_) { /* alerting failing must not change the customer's reply */ }
        return same;
      }

      const site = (env.SITE_URL || 'https://zuwera.store').replace(/\/$/, '');
      const link = site + '/returns.html?t=' + encodeURIComponent(token);
      const cache = await fetchSiteSettings(
        ['RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM', 'BRAND_LOGO_URL',
         'fonts', 'brand', 'email_theme', 'email_settings'], env,
      );

      const appearance = getEmailAppearance(cache);
      appearance.logo = resolveSetting('BRAND_LOGO_URL', env, cache)
        || 'https://zuwera.store/assets/Zuwera_Wordmark_White.png';
      const content = getEmailContent(cache, 'return_link');
      const label = orderNoPlain(order);

      await sendTransactional({
        env, cache,
        to: order.email,
        subject: fillTemplate(content.subject, { order: label }),
        fromEmail: resolveSetting('EMAIL_FROM', env, cache) || 'orders@zuwera.store',
        text: 'Start your return for order ' + orderNo(order) + ':\n\n' + link
          + '\n\n' + linkLifetimeSentence()
          + ' If you did not ask for it, you can ignore this email — nothing has changed.',
        html: buildReturnLinkEmail({ appearance, content, orderLabel: label, link }),
      });
    } catch (e) {
      /* Logged, not surfaced: telling the caller that sending failed would
         distinguish a real order from a wrong guess just as clearly as saying
         "no such order" would. */
      console.error('[guest-return] start failed:', e && e.message);
    }
    return same;
  }

  // ── 2. What can this order return? ────────────────────────────────────────
  if (action === 'lookup') {
    const claim = await readOrderToken(env, body.token);
    if (!claim) return json({ error: 'That link has expired. Please request a new one.' }, 401, h);

    const order = await fetchOrder(env, claim);
    if (!order) return json({ error: 'We could not find that order.' }, 404, h);

    const bundle = await getCommerceBundle(env);
    const all = Array.isArray(bundle.returnsState?.requests) ? bundle.returnsState.requests : [];
    /* Only this order's history — a token for one order must not become a way
       to read what else that email has bought. */
    const mine = all.filter((r) => r && String(r.orderId) === String(order.id));
    const say = messagesFrom(bundle.config);
    const eligible = returnEligibility(order, mine, say);

    return json({
      success: true,
      /* The link that leads here is labelled "View order status", so it has to
         be able to answer that — carrier and tracking included. Without them
         the page could only offer a return form, which is not what the customer
         clicked and is no use at all on an order still in transit.

         Still only this order, and still only what its own receipt already
         showed. No profile, no other orders, no payment details. */
      order: {
        id: order.id,
        orderNumber: orderNo(order),
        createdAt: order.created_at,
        total: order.total,
        items: order.items,
        status: order.status,
        shippingProvider: order.shipping_provider || '',
        shippingService: order.shipping_service || '',
        trackingNumber: order.tracking_number || '',
        trackingUrl: order.tracking_url || '',
      },
      eligible: eligible.ok,
      reason: eligible.reason || '',
      code: eligible.code || '',
      requests: mine.map((r) => ({
        id: r.id, status: r.status, resolution: r.resolution,
        createdAt: r.createdAt, reason: r.reason,
      })),
    }, 200, h);
  }

  // ── 3. Submit it ──────────────────────────────────────────────────────────
  if (action === 'submit') {
    const claim = await readOrderToken(env, body.token);
    if (!claim) return json({ error: 'That link has expired. Please request a new one.' }, 401, h);

    const order = await fetchOrder(env, claim);
    if (!order) return json({ error: 'We could not find that order.' }, 404, h);

    const reason = String(body.reason || '').trim();
    if (!reason) return json({ error: 'Please tell us why you are sending it back.' }, 400, h);

    const bundle = await getCommerceBundle(env);
    const all = Array.isArray(bundle.returnsState?.requests) ? bundle.returnsState.requests : [];
    const mine = all.filter((r) => r && String(r.orderId) === String(order.id));
    const say = messagesFrom(bundle.config);

    /* The same eligibility check the account page uses. Guests get neither a
       looser rule nor a stricter one — a second door into the same room, not a
       different room. */
    const eligible = returnEligibility(order, mine, say);
    if (!eligible.ok) return json({ error: eligible.reason, code: eligible.code }, 409, h);

    const allItems = (() => {
      try {
        return typeof order.items === 'string' ? JSON.parse(order.items)
          : (Array.isArray(order.items) ? order.items : []);
      } catch (_) { return []; }
    })();

    const nextRequest = {
      id: crypto.randomUUID(),
      /* No userId — that is the point. Flagged rather than left blank, so the
         admin queue shows "guest" instead of a gap that reads like a fault. */
      userId: null,
      guest: true,
      userEmail: String(order.email || '').trim(),
      userName: String(order.customer_name || '').trim(),
      customerEmail: String(order.email || '').trim(),
      customerName: String(order.customer_name || order.email || 'Customer').trim(),
      orderId: String(order.id),
      orderLabel: orderNo(order),
      orderTotal: Number(order.total || 0),
      orderCreatedAt: order.created_at || '',
      orderItems: allItems,
      resolution: String(body.resolution || 'return').trim(),
      reason,
      notes: String(body.notes || '').trim(),
      status: 'requested',
      createdAt: new Date().toISOString(),
      shippingAddress: {
        name: String(order.customer_name || '').trim(),
        line1: order.ship_line1 || '', line2: order.ship_line2 || '',
        city: order.ship_city || '', state: order.ship_state || '',
        zip: order.ship_zip || '', country: order.ship_country || 'US',
      },
    };

    /* Item checking, identical to the account path — same function, same
       arguments, same meaning for an empty selection ("the whole order").
       Anything else here would let a guest ask for items they never bought
       through the one door that skipped the check. */
    const submitted = Array.isArray(body.returnItems) ? body.returnItems : [];
    if (!submitted.length) {
      nextRequest.returnItems = (eligible.availableItems && eligible.availableItems.length)
        ? eligible.availableItems : allItems;
    } else {
      const { items, rejected } = reconcileReturnItems(order, submitted, spokenForOn(mine, order.id));
      /* Refused rather than trimmed: falling back to the entire order when
         every submitted line failed is the worst possible reading of "none of
         that was valid". */
      if (!items.length) {
        return json({
          error: rejected.length ? say('returnItemsInvalid') : say('returnNoItems'),
          code: 'items_invalid',
        }, 409, h);
      }
      nextRequest.returnItems = items;
      if (rejected.length) nextRequest.rejectedItems = rejected.slice(0, 20);
    }
    nextRequest.returnItems = (nextRequest.returnItems || []).slice(0, 20);

    /* Compare-and-set, because the returns list is one JSON blob and a
       read-modify-write here would drop a request made a moment earlier. */
    await mutateSetting(env, 'commerce_returns', (current) => {
      const list = Array.isArray(current?.requests) ? current.requests : [];
      return { ...(current || {}), requests: [nextRequest, ...list].slice(0, 500) };
    });

    return json({ success: true, requestId: nextRequest.id, orderNumber: orderNo(order) }, 200, h);
  }

  return json({ error: 'Unknown action.' }, 400, h);
}
