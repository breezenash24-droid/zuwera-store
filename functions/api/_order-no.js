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
