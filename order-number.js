/* ────────────────────────────────────────────────────────────────────────────
   order-number.js — what an order is called, decided once.

   There were five formulas. Orders showed `order_number` (#0RT9CPIA). Receipts
   showed the last eight of the Stripe payment intent. The refund log, the
   approval queue, the returns workspace and the customer's own account page
   each showed the last eight of the row id. And the returns endpoint stamped a
   sixth onto every request as `orderLabel`.

   Same order, six names. Nobody notices until they try to look one up — a
   customer quoting the number from their account page, or an admin checking a
   refund they have been asked to approve — and the search finds nothing.

   `order_number` first, because it is the real one: a stored column, what the
   Orders page shows, and the only one a customer could ever have been given.
   The others are fallbacks for rows written before it existed, kept in the
   order they were previously trusted so no existing order silently changes the
   name it has already been referred to by.

   Loaded as a plain script by both the admin and the storefront. The Worker
   cannot use this file, so functions/api/_order-no.js carries the same
   function and a test compares the two — the arrangement stock-rules.js
   already uses, because a second copy that nothing checks is how this started.
   ──────────────────────────────────────────────────────────────────────────── */
(function (w) {
  'use strict';

  /* Takes an order row. Given a bare id it does what it can, which is the
     last-eight fallback — a caller holding only an id cannot know the real
     number, and inventing one would be the bug this file exists to remove. */
  function orderNo(order) {
    if (!order) return '';
    var o = typeof order === 'string' ? { id: order } : order;

    var n = String(o.order_number == null ? '' : o.order_number).trim();
    if (n) return n.charAt(0) === '#' ? n : '#' + n;

    var fallback = String(o.stripe_payment_intent_id || o.id || '');
    return fallback ? '#' + fallback.slice(-8).toUpperCase() : '';
  }

  /* Without the '#', for search boxes and CSV cells where the hash is noise
     and, in a CSV, an accidental comment marker in some spreadsheets. */
  function orderNoPlain(order) {
    return orderNo(order).replace(/^#/, '');
  }

  w.ZWOrderNo = orderNo;
  w.ZWOrderNoPlain = orderNoPlain;
})(typeof window !== 'undefined' ? window : this);
