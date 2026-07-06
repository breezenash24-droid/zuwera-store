/*
 * meta-pixel.js — Meta (Facebook) Pixel + Conversions-API relay.
 *
 * CONSENT-GATED: window.zwPixel.* stays callable at all times (no-ops until
 * consent), but the Pixel init, the fbevents.js download, the PageView, AND the
 * first-party /api/c relay all happen ONLY after the visitor accepts cookies
 * (consent.js). Decline / no choice => no pixel, no relay, no Facebook cookies.
 *
 * DUAL DELIVERY (once consented) — every event is sent two ways with one shared
 * event_id: the browser pixel (fbq) + a first-party POST to /api/c (Conversions
 * API), de-duplicated by event_id. Pixel ID lives only here.
 *
 * CATALOG MATCHING — content_ids use the product UUID (= the feed's
 * item_group_id) with content_type 'product_group'; see functions/api/product-feed.js.
 */
(function () {
  'use strict';

  /* Shared "run on first interaction OR browser idle" helper — NOT gated (it's a
     generic scheduling util that google-tag.js / posthog-init.js also use). */
  window.zwWhenIdle = window.zwWhenIdle || function (cb) {
    var done = false;
    function run() { if (done) return; done = true; cb(); }
    ['pointerdown', 'keydown', 'scroll', 'touchstart', 'visibilitychange'].forEach(function (ev) {
      (ev === 'visibilitychange' ? document : window).addEventListener(ev, run, { once: true, passive: true });
    });
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 3000 });
    else setTimeout(run, 2500);
  };

  /* No-op API so pre-consent call sites (addToCart/purchase/…) never throw. It's
     replaced with the real tracking implementation inside start() on consent. */
  var noop = function () {};
  window.zwPixel = window.zwPixel || {
    viewContent: noop, addToCart: noop, initiateCheckout: noop,
    purchase: noop, lead: noop, completeRegistration: noop
  };

  function start() {
    /* ---- Meta Pixel base code (standard snippet, ID inlined) ---- */
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0';
      n.queue = [];
      window.zwWhenIdle(function () {
        if (f.__zwFbLoaded) return; f.__zwFbLoaded = 1;
        t = b.createElement(e); t.async = !0; t.src = v;
        s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
      });
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

    fbq('init', '1695269795093400');

    /* ---- relay / dedup plumbing ---- */
    var RELAY_URL = '/api/c';

    function uuid() {
      try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
      return 'e-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    }
    function readCookie(name) {
      var m = document.cookie.match('(?:^|; )' + name + '=([^;]*)');
      return m ? decodeURIComponent(m[1]) : '';
    }
    function fbcValue() {
      var fbc = readCookie('_fbc');
      if (fbc) return fbc;
      try {
        var id = new URLSearchParams(location.search).get('fbclid');
        return id ? ('fb.1.' + Date.now() + '.' + id) : '';
      } catch (_) { return ''; }
    }
    function relay(eventName, eventId, customData) {
      try {
        var body = JSON.stringify({
          event_name: eventName,
          event_id: eventId,
          event_source_url: location.href,
          custom_data: customData || {},
          fbp: readCookie('_fbp'),
          fbc: fbcValue()
        });
        fetch(RELAY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true,
          credentials: 'omit'
        }).catch(function () {});
      } catch (_) {}
    }
    function track(eventName, params, eventId) {
      eventId = eventId || uuid();
      try { if (window.fbq) fbq('track', eventName, params || {}, { eventID: eventId }); } catch (_) {}
      relay(eventName, eventId, params || {});
      return eventId;
    }

    /* ---- value helpers ---- */
    function num(v) { var x = parseFloat(v); return isFinite(x) ? x : 0; }
    function qty(it) { return Number(it && it.quantity) || 1; }
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

    /* PageView — on consent/load, both paths, shared id. */
    track('PageView', {});

    window.zwPixel = {
      viewContent: function (p) {
        if (!p) return;
        track('ViewContent', {
          content_type: 'product_group',
          content_ids: [groupId(p)],
          content_name: p.title || p.product_name || '',
          value: num(p.price),
          currency: 'USD'
        });
      },
      addToCart: function (item) {
        if (!item) return;
        var id = groupId(item);
        track('AddToCart', {
          content_type: 'product_group',
          content_ids: [id],
          contents: [{ id: id, quantity: qty(item), item_price: num(item.price) }],
          content_name: item.title || '',
          value: num(item.price) * qty(item),
          currency: 'USD'
        });
      },
      initiateCheckout: function (items, total) {
        track('InitiateCheckout', {
          content_type: 'product_group',
          content_ids: ids(items),
          contents: contents(items),
          num_items: count(items),
          value: num(total),
          currency: 'USD'
        });
      },
      purchase: function (items, total, orderId) {
        var data = {
          content_type: 'product_group',
          content_ids: ids(items),
          contents: contents(items),
          num_items: count(items),
          value: num(total),
          currency: 'USD'
        };
        if (orderId) data.order_id = String(orderId);
        track('Purchase', data, orderId ? ('purchase_' + orderId) : undefined);
      },
      lead: function (name) {
        track('Lead', { content_name: name || '' });
      },
      completeRegistration: function (method) {
        track('CompleteRegistration', { content_name: method || 'Email', status: true });
      }
    };
  }

  // Consent gate (no dependency on consent.js load order).
  function consent() { try { return localStorage.getItem('zw_cookie_consent'); } catch (_) { return null; } }
  if (consent() === 'accepted') start();
  else if (consent() !== 'declined') {
    window.addEventListener('zw-consent-accepted', function h() {
      window.removeEventListener('zw-consent-accepted', h); start();
    }, { once: true });
  }
})();
