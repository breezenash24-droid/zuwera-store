/*
 * meta-pixel.js — Meta (Facebook) Pixel base + ZUWERA e-commerce events.
 *
 * Loaded (deferred) in the <head> of every customer-facing page. Fires PageView
 * on load and exposes window.zwPixel.* helpers that the existing analytics call
 * sites invoke right alongside gtag / zwTrack (PostHog). Every helper no-ops
 * safely when the pixel is blocked (ad blockers), so callers never throw.
 *
 * Pixel ID lives ONLY here — one source of truth for all pages.
 *
 * CATALOG MATCHING — content_ids below line up with the product feed
 * (functions/api/product-feed.js), whose item_group_id is the product UUID.
 * Every product and cart line carries that UUID as `productId` (or `id`), so all
 * events report group-level ids with content_type 'product_group'. That gives a
 * clean catalog match for every event and sidesteps variant-id ambiguity
 * (variant_sku vs product sku, plus 'One Size'/'Standard' fallbacks that never
 * appear in the feed). Meta then retargets at the product-group level — the
 * right granularity for apparel, where the ad lets the shopper pick size/colour.
 */
(function () {
  'use strict';

  /* ---- Meta Pixel base code (standard snippet, ID inlined) ---- */
  !function (f, b, e, v, n, t, s) {
    if (f.fbq) return; n = f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0';
    n.queue = []; t = b.createElement(e); t.async = !0; t.src = v;
    s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
  }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

  fbq('init', '1695269795093400');
  fbq('track', 'PageView');

  /* ---- helpers ---- */

  function num(v) { var x = parseFloat(v); return isFinite(x) ? x : 0; }
  function qty(it) { return Number(it && it.quantity) || 1; }

  // Feed item_group_id === product UUID; product/cart objects carry it as
  // productId (or id). Group-level ids match the catalog with no ambiguity.
  function groupId(it) { return String((it && (it.productId || it.id || it.sku)) || ''); }

  function contents(items) {
    return (items || []).map(function (i) {
      return { id: groupId(i), quantity: qty(i), item_price: num(i.price) };
    });
  }
  function ids(items) {
    var seen = {}, out = [];
    contents(items).forEach(function (c) {
      if (c.id && !seen[c.id]) { seen[c.id] = 1; out.push(c.id); }
    });
    return out;
  }
  function count(items) {
    return (items || []).reduce(function (n, i) { return n + qty(i); }, 0);
  }

  window.zwPixel = {
    /* Product detail page. */
    viewContent: function (p) {
      if (!window.fbq || !p) return;
      fbq('track', 'ViewContent', {
        content_type: 'product_group',
        content_ids: [groupId(p)],
        content_name: p.title || p.product_name || '',
        value: num(p.price),
        currency: 'USD'
      });
    },

    /* A single cart line was added. */
    addToCart: function (item) {
      if (!window.fbq || !item) return;
      var id = groupId(item);
      fbq('track', 'AddToCart', {
        content_type: 'product_group',
        content_ids: [id],
        contents: [{ id: id, quantity: qty(item), item_price: num(item.price) }],
        content_name: item.title || '',
        value: num(item.price) * qty(item),
        currency: 'USD'
      });
    },

    /* Checkout opened with the current cart. */
    initiateCheckout: function (items, total) {
      if (!window.fbq) return;
      fbq('track', 'InitiateCheckout', {
        content_type: 'product_group',
        content_ids: ids(items),
        contents: contents(items),
        num_items: count(items),
        value: num(total),
        currency: 'USD'
      });
    },

    /* Order confirmed. Fire once per order. */
    purchase: function (items, total, orderId) {
      if (!window.fbq) return;
      var params = {
        content_type: 'product_group',
        content_ids: ids(items),
        contents: contents(items),
        num_items: count(items),
        value: num(total),
        currency: 'USD'
      };
      if (orderId) params.order_id = String(orderId);
      fbq('track', 'Purchase', params);
    },

    /* Waitlist / newsletter opt-ins. */
    lead: function (name) {
      if (!window.fbq) return;
      fbq('track', 'Lead', { content_name: name || '' });
    },

    /* Account created. */
    completeRegistration: function (method) {
      if (!window.fbq) return;
      fbq('track', 'CompleteRegistration', { content_name: method || 'Email', status: true });
    }
  };
})();
