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
import { orderNo, normalizeOrderNo, sameOrderNo } from './_order-no.js';
import { messagesFrom } from './_messages.js';

/* Long enough to read an email and fill a form, short enough that a forwarded
   message is not a standing key to someone's order. */
const TOKEN_TTL_MS = 60 * 60 * 1000;

const b64uEncodeBytes = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};
const b64uEncode = (str) => btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const b64uDecode = (v) => {
  const s = String(v || '').replace(/-/g, '+').replace(/_/g, '/');
  return atob(s.padEnd(Math.ceil(s.length / 4) * 4, '='));
};

async function hmac(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return b64uEncodeBytes(new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)),
  ));
}

function constantTimeEqual(a, b) {
  const l = String(a || ''), r = String(b || '');
  if (l.length !== r.length) return false;
  let diff = 0;
  for (let i = 0; i < l.length; i += 1) diff |= l.charCodeAt(i) ^ r.charCodeAt(i);
  return diff === 0;
}

/* Its own secret where one is configured, falling back to the checkout rate
   secret so the feature works on a store that has not set a new variable.
   The `p` (purpose) field is what makes that sharing safe: a rate token and a
   return token are signed by the same key but can never be mistaken for one
   another, because the purpose is inside the signed body. */
const secretFor = (env) => env.RETURN_TOKEN_SECRET || env.CHECKOUT_RATE_SECRET || '';

async function mintToken(env, { orderId, email }) {
  const secret = secretFor(env);
  if (!secret) return '';
  const body = b64uEncode(JSON.stringify({
    p: 'guest-return',
    o: String(orderId || ''),
    e: String(email || '').trim().toLowerCase(),
    exp: Date.now() + TOKEN_TTL_MS,
  }));
  return body + '.' + await hmac(body, secret);
}

async function readToken(env, token) {
  const secret = secretFor(env);
  if (!secret) return null;
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  if (!constantTimeEqual(await hmac(body, secret), sig)) return null;
  let payload;
  try { payload = JSON.parse(b64uDecode(body)); } catch (_) { return null; }
  if (payload.p !== 'guest-return') return null;
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

/* Orders are read with the service key because there is no session to read them
   under — that is the entire point. Narrowed to the one order the token names,
   never a list. */
async function fetchOrder(env, orderId) {
  const url = (env.SUPABASE_URL || '').trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !key || !orderId) return null;
  const resp = await fetch(
    url + '/rest/v1/orders?id=eq.' + encodeURIComponent(orderId) + '&select=*&limit=1',
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

      const token = await mintToken(env, { orderId: order.id, email: order.email });
      if (!token) {
        console.error('[guest-return] no signing secret configured — link not sent');
        return same;
      }

      const site = (env.SITE_URL || 'https://zuwera.store').replace(/\/$/, '');
      const link = site + '/returns.html?t=' + encodeURIComponent(token);
      const cache = await fetchSiteSettings(['RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM'], env);

      await sendTransactional({
        env, cache,
        to: order.email,
        subject: 'Start your return — order ' + orderNo(order),
        fromEmail: resolveSetting('EMAIL_FROM', env, cache) || 'orders@zuwera.store',
        text: 'Start your return for order ' + orderNo(order) + ':\n\n' + link
          + '\n\nThis link works for one hour and only for this order. '
          + 'If you did not ask for it, you can ignore this email — nothing has changed.',
        html: '<p>Start your return for order <strong>' + orderNo(order) + '</strong>:</p>'
          + '<p><a href="' + link + '">Start my return</a></p>'
          + '<p style="color:#666;font-size:13px;">This link works for one hour and only for this order. '
          + 'If you did not ask for it, you can ignore this email — nothing has changed.</p>',
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
    const claim = await readToken(env, body.token);
    if (!claim) return json({ error: 'That link has expired. Please request a new one.' }, 401, h);

    const order = await fetchOrder(env, claim.o);
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
      order: {
        id: order.id,
        orderNumber: orderNo(order),
        createdAt: order.created_at,
        total: order.total,
        items: order.items,
        status: order.status,
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
    const claim = await readToken(env, body.token);
    if (!claim) return json({ error: 'That link has expired. Please request a new one.' }, 401, h);

    const order = await fetchOrder(env, claim.o);
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
