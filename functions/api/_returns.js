/* ────────────────────────────────────────────────────────────────────────────
   _returns.js — "can this order be returned?", answered once.

   FOUND BY REFUNDING A REAL ORDER. Order #8A5B205C was fully refunded, with a
   label issued and the request marked `refunded`. The customer's account page
   still offered to start a return on it, they did, and a SECOND request for
   the same item appeared under review — beside the finished one.

   Nothing stopped it, at four separate layers:

     · the picker listed every order the customer had ever placed, unfiltered
     · account.html offered "Start a Return" whatever the order's status
     · submit_return checked ONE thing, that the order belonged to them
     · nothing anywhere looked at the requests that already existed

   The last is the one that matters. The other three are a stray button; that
   one hands an admin a second request for an item already refunded, which
   looks exactly like a first request. Approve it and the same item is paid out
   twice, with the return system's own records as the evidence it was fine.

   So this is one function, called by the endpoint that decides and used for
   what the pages display, rather than three near-copies of the rule that drift
   until they disagree — the shape of the bug above.

   FAIL CLOSED, and here that means REFUSE. A returns question we cannot answer
   should not offer a return: the cost of wrongly refusing is a customer email,
   and the cost of wrongly allowing is paying twice for one item.
   ──────────────────────────────────────────────────────────────────────────── */

/* An order in one of these has nothing left to give back. `refunded` is set by
   a FULL refund; a partial one deliberately leaves the order alone, which is
   why the item-level check below exists and cannot be skipped. */
/* The shipped wording, for callers with no settings to hand. Imported rather
   than repeated: _messages.js is where both copies of this text are kept in
   step by a test. */
import { shippedMessages } from './_messages.js';
/* `vars` is forwarded, and dropping it was a latent bug rather than a style
   point: shippedMessages is (key, vars) => string, so a one-argument wrapper
   silently renders every placeholder as empty. It went unnoticed because no
   refusal had variables until the window one, whose message is "open for {days}
   days … arrived {ago} days ago" and read as "open for days after delivery, and
   this order arrived days ago" whenever no settings were loaded. */
const SHIPPED = (k, vars) => shippedMessages(k, vars);

const CLOSED_ORDER_STATUSES = new Set(['refunded', 'cancelled', 'canceled']);

/* A request in any status EXCEPT these still holds its items. Denied frees
   them — the customer was told no and may ask again, perhaps with a better
   reason. Everything else, including one merely `requested`, holds: an item
   already being talked about is not an item to start a second conversation
   about.
   Listed as what RELEASES rather than what holds, so a status added later to
   admin-returns.js holds by default. The safe direction: a new status nobody
   remembered to classify blocks a duplicate instead of permitting one. */
const RELEASING_STATUSES = new Set(['denied']);

/* How many of each item the live requests on one order already claim. Exported
   because the endpoint needs the same number the eligibility check used, and
   two ways of counting the same thing is how the first version of this went
   wrong. */
export function spokenForOn(requests, orderId) {
  const counts = new Map();
  (Array.isArray(requests) ? requests : [])
    .filter((r) => r && String(r.orderId || '').trim() === String(orderId || '').trim())
    .filter(isLiveRequest)
    .forEach((r) => {
      (Array.isArray(r.returnItems) ? r.returnItems : []).forEach((i) => {
        const k = itemKey(i);
        if (k) counts.set(k, (counts.get(k) || 0) + lineQty(i));
      });
    });
  return counts;
}

/**
 * How long returns stay open, from commerce_config.
 *
 * DEFAULTS TO OFF, and that is a deliberate choice rather than timidity. This
 * store has 61 orders already placed, none with a delivery date, all of them
 * old enough that a 30-day window applied retroactively would refuse every one.
 * Switching enforcement on for existing customers without being asked is not a
 * bug fix, it is a policy change made on somebody's behalf.
 *
 * So the rule exists, the plumbing is live, and the number is the shop owner's
 * to set. The admin says plainly that the policy already promises 30 days and
 * that nothing holds the store to it until this is filled in.
 */
export function returnWindowFrom(cfg) {
  const r = (cfg && typeof cfg === 'object' && cfg.returns) || {};
  const days = Math.floor(Number(r.windowDays));
  const transit = Math.floor(Number(r.transitAllowanceDays));
  return {
    windowDays: Number.isFinite(days) && days > 0 ? Math.min(days, 3650) : 0,
    /* What to assume delivery took when nothing recorded it. Applied to the
       order date so an order with no delivery record is judged from roughly
       when it would have arrived, not from when it was paid for. */
    transitDays: Number.isFinite(transit) && transit >= 0 ? Math.min(transit, 60) : 7,
  };
}

/* Live requests are the ones still holding items. */
export function isLiveRequest(request) {
  if (!request || typeof request !== 'object') return false;
  return !RELEASING_STATUSES.has(String(request.status || 'requested').trim().toLowerCase());
}

/* Items are compared on name + size + colour, because that is what the return
   form sends and what an order line carries. Quantity is deliberately not part
   of the key: returning 1 of 2 is a case this does not yet handle, and folding
   it in here silently would be the same mistake as the one being fixed —
   see the note in returnEligibility. */
export function itemKey(item) {
  if (!item || typeof item !== 'object') return '';
  const part = (v) => String(v == null ? '' : v).trim().toLowerCase();
  return [
    part(item.name || item.title),
    part(item.size),
    part(item.color || item.colour || item.color_name),
  ].join('|');
}

/* How many of a line were bought. Absent means one — an order line with no
   quantity is one thing, not zero and not unlimited. Anything unparseable,
   negative, or fractional collapses to one for the same reason: this number
   decides how many an admin is shown as owing back. */
export function lineQty(item) {
  const raw = item && (item.quantity ?? item.qty ?? item.count);
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 999) : 1;
}

/* What this order actually contains: key → how many, counted rather than
   collected into a set. A set was the earlier version of this and it could not
   tell "bought two, returned one" from "bought two, returned both". */
export function purchasedCounts(order) {
  const counts = new Map();
  parseItems(order).forEach((i) => {
    const k = itemKey(i);
    if (!k) return;
    counts.set(k, (counts.get(k) || 0) + lineQty(i));
  });
  return counts;
}

/**
 * Which of the requested items are real, and how many of each may still go
 * back.
 *
 * THE REASON THIS EXISTS. The only check on a submitted item was that its NAME
 * appeared somewhere on the order:
 *
 *     const allNames = new Set(allItems.map(i => i.name.toLowerCase()));
 *     returnItems = returnItems.filter(i => allNames.has(i.name.toLowerCase()));
 *
 * Everything else on the item came from the request body and was stored as
 * sent. So somebody who bought one small yellow shirt could ask to return an
 * extra-large black one, or ask for the same shirt five times, and the queue
 * would show an admin exactly that — five items, in sizes never purchased,
 * against a real order. The request is what a refund gets read from.
 *
 * The items returned here are the ORDER's objects, not the customer's, carrying
 * only a reconciled quantity. Nothing a requester wrote survives into what an
 * admin is shown: not the name, not the price, not the size.
 *
 * @param spokenFor  key → how many already claimed by live requests
 * @returns { items, rejected }  rejected is for telling somebody why, not for
 *          quietly dropping — see the caller.
 */
export function reconcileReturnItems(order, requested, spokenFor) {
  const remaining = purchasedCounts(order);
  (spokenFor instanceof Map ? spokenFor : new Map()).forEach((n, k) => {
    remaining.set(k, Math.max(0, (remaining.get(k) || 0) - n));
  });

  const byKey = new Map();
  parseItems(order).forEach((i) => { const k = itemKey(i); if (k && !byKey.has(k)) byKey.set(k, i); });

  const items = [];
  const rejected = [];
  (Array.isArray(requested) ? requested : []).forEach((req) => {
    const k = itemKey(req);
    const left = k ? (remaining.get(k) || 0) : 0;
    if (!k || !byKey.has(k)) {
      /* Not on this order at all — a different size, a different colour, or
         something never bought. Named back rather than silently dropped. */
      rejected.push({ item: req, why: 'not on this order' });
      return;
    }
    if (left <= 0) {
      rejected.push({ item: req, why: 'already returned' });
      return;
    }
    const want = Math.min(lineQty(req), left);
    remaining.set(k, left - want);
    /* The order's object, with only the quantity taken from the request. */
    items.push({ ...byKey.get(k), quantity: want });
  });

  return { items, rejected };
}

function parseItems(order) {
  if (!order) return [];
  const raw = order.items;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

/**
 * Can this order be returned, and which of its items are still available?
 *
 * @param order     the order row
 * @param requests  every return request for this customer (any order — they
 *                  are filtered here, so no caller has to remember to)
 * @returns { ok, code, reason, availableItems, openRequestId }
 *
 * `reason` is customer-facing copy. A refusal a customer cannot understand
 * becomes an email to support, which costs more than the return did.
 */
export function returnEligibility(order, requests, msg, opts) {
  /* The refusals are editable copy, not strings this file owns. A store's
     voice is its own, and a refusal a shopper cannot act on becomes an email
     to support — which costs more than the return would have.
     `msg` comes from messagesFrom(commerce_config) in the caller, which has
     the settings loaded already. Absent, it falls back to the shipped wording,
     so nothing here depends on a settings read succeeding. */
  /* SHIPPED is a function, and this indexed it — `SHIPPED[k]` is undefined for
     every key, so with no overrides passed every refusal came back blank. A
     shopper told "no" with no reason cannot act on it, which is the one thing
     a refusal must never be. */
  const say = typeof msg === 'function' ? msg : SHIPPED;
  if (!order || !order.id) {
    return { ok: false, code: 'no_order', reason: 'We could not find that order.', availableItems: [] };
  }

  const status = String(order.status || '').trim().toLowerCase();
  if (CLOSED_ORDER_STATUSES.has(status)) {
    return {
      ok: false,
      code: status === 'refunded' ? 'already_refunded' : 'cancelled',
      reason: status === 'refunded' ? say('returnAlreadyRefunded') : say('returnCancelled'),
      availableItems: [],
    };
  }

  /* ── Is it still inside the window we promised? ─────────────────────────
     Every confirmation email, the returns page and the policy say "30-day free
     returns", and until now nothing enforced it — an order from three years ago
     was returnable today.

     COUNTED FROM DELIVERY, because that is the promise. Counting from payment
     would give an order paid on the 1st and delivered on the 10th twenty days
     while telling that customer thirty, and refusing someone inside the window
     they were told about is worse than having no window at all.

     Orders placed before 0015 have no delivered_at and never will, so the
     fallback is created_at plus a transit allowance — the window a customer
     would have had if delivery had taken the usual week. Generous on purpose.

     AND IT FAILS OPEN. No usable date, an unparseable one, a window configured
     to nonsense: allow the return. A wrongly refused return is a support email
     and a customer who does not come back; a wrongly allowed one costs a single
     item. Those are not the same mistake and should not be equally likely. */
  const windowDays = Number(opts && opts.windowDays);
  if (Number.isFinite(windowDays) && windowDays > 0) {
    const delivered = Date.parse(order.delivered_at || '');
    const placed    = Date.parse(order.created_at || '');
    const transitAllowanceDays = Number.isFinite(Number(opts.transitDays)) ? Number(opts.transitDays) : 7;

    const from = Number.isFinite(delivered) ? delivered
      : (Number.isFinite(placed) ? placed + transitAllowanceDays * 86400000 : NaN);

    if (Number.isFinite(from)) {
      const closesAt = from + windowDays * 86400000;
      if (Date.now() > closesAt) {
        const daysAgo = Math.floor((Date.now() - from) / 86400000);
        return {
          ok: false,
          code: 'window_closed',
          reason: say('returnWindowClosed', { days: String(windowDays), ago: String(daysAgo) }),
          availableItems: [],
          windowClosedAt: new Date(closesAt).toISOString(),
        };
      }
    }
  }

  const mine = (Array.isArray(requests) ? requests : [])
    .filter((r) => r && String(r.orderId || '').trim() === String(order.id).trim())
    .filter(isLiveRequest);

  /* One conversation at a time. Somebody with a request under review who
     starts another has not asked twice — they have failed to find the first
     one, and the fix is to show it to them, not to file a duplicate. */
  const open = mine.find((r) => !['completed', 'closed', 'refunded'].includes(
    String(r.status || '').trim().toLowerCase()));
  if (open) {
    return {
      ok: false,
      code: 'already_open',
      reason: say('returnAlreadyOpen'),
      availableItems: [],
      openRequestId: String(open.id || ''),
    };
  }

  /* Item level, and this is the check the order status cannot do for us: a
     PARTIAL refund leaves the order untouched, so an item refunded on its own
     is invisible above. */
  /* COUNTED, not collected. This was a Set, which could not tell "bought two,
     returned one" from "bought two, returned both" — so returning one of a
     pair marked the pair spent, and a legitimate second return was refused. */
  const spokenFor = new Map();
  mine.forEach((r) => {
    (Array.isArray(r.returnItems) ? r.returnItems : []).forEach((i) => {
      const k = itemKey(i);
      if (k) spokenFor.set(k, (spokenFor.get(k) || 0) + lineQty(i));
    });
  });

  const remaining = purchasedCounts(order);
  spokenFor.forEach((n, k) => remaining.set(k, Math.max(0, (remaining.get(k) || 0) - n)));

  const seen = new Map();
  const all = parseItems(order);
  const availableItems = [];
  all.forEach((i) => {
    const k = itemKey(i);
    if (!k) { availableItems.push(i); return; }
    const left = (remaining.get(k) || 0) - (seen.get(k) || 0);
    if (left <= 0) return;
    const take = Math.min(lineQty(i), left);
    seen.set(k, (seen.get(k) || 0) + take);
    availableItems.push({ ...i, quantity: take });
  });

  if (all.length && !availableItems.length) {
    return {
      ok: false,
      code: 'items_spent',
      reason: say('returnItemsSpent'),
      availableItems: [],
    };
  }

  return { ok: true, code: 'ok', reason: '', availableItems };
}
