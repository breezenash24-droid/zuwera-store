/* The Worker's copy of what an order is called.
   The browser's is order-number.js, loaded as a plain script by the admin and
   the storefront; a Worker cannot use that file. tests/order-number.test.js
   compares the two and fails if they drift, which is the arrangement
   stock-rules.js already uses — a second copy nothing checks is exactly how
   this order ended up with six different names in the first place.
   Read order-number.js for why order_number comes first. */

export function orderNo(order) {
  if (!order) return '';
  const o = typeof order === 'string' ? { id: order } : order;

  const n = String(o.order_number == null ? '' : o.order_number).trim();
  if (n) return n.charAt(0) === '#' ? n : '#' + n;

  const fallback = String(o.stripe_payment_intent_id || o.id || '');
  return fallback ? '#' + fallback.slice(-8).toUpperCase() : '';
}

export function orderNoPlain(order) {
  return orderNo(order).replace(/^#/, '');
}

/**
 * An order number reduced to what a human meant by it.
 *
 * orderNo() prints a leading '#', so the number on a receipt reads "#ZW-1234".
 * A customer copying that into a returns form was then matched literally
 * against a stored value with no '#', or the reverse — and told, in effect,
 * that their own order number was wrong. Nobody types a hash on purpose, and
 * nobody omits one on purpose either; both are the same order.
 *
 * So comparisons go through here: case, spaces, hashes, dashes and any other
 * punctuation are all noise. "#ZW-1234", "zw 1234" and "ZW1234" are one order.
 *
 * Use it on BOTH sides of a comparison, never on one — normalising only the
 * input is how this bug happens in the first place.
 */
export function normalizeOrderNo(value) {
  return String(value == null ? '' : value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** True when two order numbers mean the same order, however they were typed. */
export function sameOrderNo(a, b) {
  const left = normalizeOrderNo(a);
  return Boolean(left) && left === normalizeOrderNo(b);
}
