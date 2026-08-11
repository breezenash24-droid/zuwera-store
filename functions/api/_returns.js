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
export function returnEligibility(order, requests) {
  if (!order || !order.id) {
    return { ok: false, code: 'no_order', reason: 'We could not find that order.', availableItems: [] };
  }

  const status = String(order.status || '').trim().toLowerCase();
  if (CLOSED_ORDER_STATUSES.has(status)) {
    return {
      ok: false,
      code: status === 'refunded' ? 'already_refunded' : 'cancelled',
      reason: status === 'refunded'
        ? 'This order was refunded, so there is nothing left to return.'
        : 'This order was cancelled, so there is nothing to return.',
      availableItems: [],
    };
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
      reason: 'You already have a request open for this order. We will be in touch about that one.',
      availableItems: [],
      openRequestId: String(open.id || ''),
    };
  }

  /* Item level, and this is the check the order status cannot do for us: a
     PARTIAL refund leaves the order untouched, so an item refunded on its own
     is invisible above. */
  const spokenFor = new Set();
  mine.forEach((r) => {
    (Array.isArray(r.returnItems) ? r.returnItems : []).forEach((i) => {
      const k = itemKey(i);
      if (k) spokenFor.add(k);
    });
  });

  const all = parseItems(order);
  const availableItems = all.filter((i) => {
    const k = itemKey(i);
    return k ? !spokenFor.has(k) : true;
  });

  if (all.length && !availableItems.length) {
    return {
      ok: false,
      code: 'items_spent',
      reason: 'Every item on this order has already been returned or refunded.',
      availableItems: [],
    };
  }

  /* NOT HANDLED, and said out loud rather than left to be discovered: two of
     the same item on one order are one key, so returning one marks both as
     spoken for. That refuses a legitimate second return — the direction that
     costs an email rather than a double payout. Fixing it properly means
     counting quantities through the whole returns flow, which is a bigger
     change than this one. */
  return { ok: true, code: 'ok', reason: '', availableItems };
}
