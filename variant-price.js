/**
 * variant-price.js — what ONE colourway costs, in the browser.
 *
 * The browser half of functions/api/_variant-price.js. It exists twice because
 * the browser has to render a swatch change and a Worker has to decide the
 * charge, and a Worker cannot load an IIFE — the same split stock-rules.js
 * already lives with.
 *
 * TWO COPIES ARE ONLY SAFE BECAUSE OF THE PARITY TEST.
 * tests/variant-pricing.test.js runs both over one table of cases and fails on
 * any disagreement. Editing this file without editing its twin turns CI red on
 * the same commit — which is the whole point, because the last time two pieces
 * of code answered a pricing question independently the bag said $35 and
 * checkout charged $40.
 *
 * THE RULE (identical to the server's, deliberately):
 *   current_price set on the colour  → that colour's own current_price,
 *                                      member_price and msrp apply, INCLUDING
 *                                      when the last two are null.
 *   current_price not set            → every figure comes from the product.
 *
 * All-or-nothing, so a $250 limited colourway cannot inherit the product's $35
 * member price and end up cheaper for members than the standard colour.
 */
(function () {
  'use strict';

  function priceCents(value) {
    if (value === null || value === undefined || value === '') return 0;
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.round(n * 100);
  }

  /* current_price is the switch, and the only one. A colour with a member price
     but no regular price is a data mistake, not an instruction — honouring it
     would give a colour nothing but a discounted price. */
  function variantOverrides(variant) {
    return priceCents(variant && variant.current_price) > 0;
  }

  function resolveVariantPrice(product, variant, isMember) {
    var p = product || {};
    var own = variantOverrides(variant);
    var src = own ? variant : p;

    var regularCents = own
      ? priceCents(src.current_price)
      : priceCents(p.current_price !== null && p.current_price !== undefined ? p.current_price : p.price);
    var memberCents = priceCents(src.member_price);
    var msrpCents   = priceCents(src.msrp);

    /* Only when it is actually cheaper. A member price above the regular one is
       a typo, and honouring it would charge somebody more for being a member. */
    var useMember = Boolean(isMember) && memberCents > 0 && (!regularCents || memberCents < regularCents);

    return {
      regularCents: regularCents,
      memberCents: memberCents,
      msrpCents: msrpCents,
      priceCents: useMember ? memberCents : regularCents,
      usingMember: useMember,
      source: own ? 'variant' : 'product'
    };
  }

  /* The "from $X" a grid shows before a colour is chosen. Colourways priced at
     zero are skipped: they cannot be sold (the server refuses them), and
     advertising "from $0" because one colour is misconfigured is worse than
     showing the product's own price. */
  function lowestPriceCents(product, variants, isMember) {
    var list = Array.isArray(variants) ? variants : [];
    var base = resolveVariantPrice(product, null, isMember).priceCents;
    var low = base > 0 ? base : 0;
    var anyOverride = false;
    var i, cents;

    for (i = 0; i < list.length; i++) {
      if (!variantOverrides(list[i])) continue;
      anyOverride = true;
      cents = resolveVariantPrice(product, list[i], isMember).priceCents;
      if (cents > 0 && (low === 0 || cents < low)) low = cents;
    }

    var prices = {};
    var count = 0;
    for (i = 0; i < list.length; i++) {
      if (!variantOverrides(list[i])) continue;
      cents = resolveVariantPrice(product, list[i], isMember).priceCents;
      if (!prices[cents]) { prices[cents] = 1; count++; }
    }
    var hasPlain = false;
    for (i = 0; i < list.length; i++) if (!variantOverrides(list[i])) hasPlain = true;
    if (anyOverride && hasPlain && base > 0 && !prices[base]) { prices[base] = 1; count++; }

    return { lowestCents: low, varies: count > 1 };
  }

  /* ── The price lists (migration 0022) ─────────────────────────────────────
     Everything above answers from the CATALOGUE — the product row and the
     colourway row. It does not know about price lists, effective dates or
     customer groups, and it must not: those need the calendar and the group
     membership resolved, and a browser copy of that is a second answer to a
     money question.

     So the browser ASKS. Same shape checkout-tax.js uses for tax: a synchronous
     reader that answers from cache, an async ask that fills it, and an event so
     whatever drew a price can redraw it. Until an answer arrives, resolvedFor
     returns null and callers fall back to the catalogue — which is what the
     page showed before price lists existed, and is never a figure nobody
     intended.

     THE BUG THIS FIXES: the charge path consulted the price lists and no
     display did. An approved row of $30 meant the page said $35 and the card
     was charged $30. Harmless in that direction; the same gap with the row
     ABOVE the catalogue price is a checkout that refuses the sale for
     exceeding the figure it just displayed. */
  var _cache = {};      // productId -> { base, colours: [] }
  var _asked = {};      // productId -> true, so a redraw does not re-ask

  var STORE_KEY = 'zw_prices_v1';
  /* Ten minutes. The fetch ALWAYS runs and corrects, so this only bounds how
     long a stale figure can be the FIRST thing painted — and the thing most
     likely to go stale is a scheduled price crossing its start date, which this
     keeps within ten minutes of being right on a cold load. */
  var TTL_MS = 10 * 60 * 1000;

  function token() {
    try {
      if (window.ZWStock && typeof window.ZWStock.storedAccessToken === 'function') {
        return window.ZWStock.storedAccessToken() || '';
      }
    } catch (_) {}
    return '';
  }

  /* ── Paint the last known answer immediately ──────────────────────────────
     Without this the page draws the CATALOGUE price, waits for the round trip,
     then redraws — a visible second of the wrong number on every load. Exactly
     the flash the theme cache exists to prevent, solved the same way: read the
     previous answer synchronously before anything renders, then let the fetch
     correct it.

     Keyed by whether the shopper was signed in, because a member and a guest
     get different figures and showing one to the other is worse than showing
     the catalogue price. Signing in or out simply discards it. */
  function memberish() { return token() ? 1 : 0; }

  function loadCache() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!raw || raw.v !== 1) return;
      if (raw.member !== memberish()) return;              // different shopper
      if (!raw.at || Date.now() - raw.at > TTL_MS) return; // too old to trust first
      if (raw.byId && typeof raw.byId === 'object') _cache = raw.byId;
    } catch (_) {}
  }

  function saveCache() {
    try {
      /* Bounded. Without a cap this map only ever grows — a shopper who browses
         a large catalogue over months ends up with every product they have ever
         seen in localStorage, and the write eventually throws QuotaExceeded and
         silently stops caching anything. Keeping the most recent is enough:
         the ones worth painting instantly are the ones just looked at. */
      var keys = Object.keys(_cache);
      var trimmed = _cache;
      if (keys.length > 60) {
        trimmed = {};
        keys.slice(-60).forEach(function (k) { trimmed[k] = _cache[k]; });
        _cache = trimmed;
      }
      localStorage.setItem(STORE_KEY, JSON.stringify({
        v: 1, at: Date.now(), member: memberish(), byId: trimmed,
      }));
    } catch (_) {}
  }

  loadCache();

  function resolvedFor(productId, variantId) {
    var entry = _cache[String(productId || '')];
    if (!entry) return null;
    if (variantId) {
      var hit = (entry.colours || []).filter(function (c) { return String(c.id) === String(variantId); })[0];
      if (hit) return hit;
    }
    return entry.base || null;
  }

  function ask(productIds) {
    var ids = (Array.isArray(productIds) ? productIds : [productIds])
      .map(String).filter(function (id) { return id && !_asked[id]; });
    if (!ids.length) return Promise.resolve(_cache);
    ids.forEach(function (id) { _asked[id] = true; });

    var t = token();
    return fetch('/api/prices?productIds=' + encodeURIComponent(ids.join(',')), {
      cache: 'no-store',
      headers: t ? { Authorization: 'Bearer ' + t } : {}
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.ok || !Array.isArray(j.products)) return _cache;
        var changed = false;
        j.products.forEach(function (p) {
          var key = String(p.productId);
          var next = { base: p.base, colours: p.colours || [] };
          if (JSON.stringify(_cache[key]) !== JSON.stringify(next)) changed = true;
          _cache[key] = next;
        });
        saveCache();
        /* Only when the answer actually MOVED. Firing regardless makes every
           page load redraw its prices for nothing, which is the flash again
           with an extra step. */
        if (changed) {
          try {
            window.dispatchEvent(new CustomEvent('zw:prices', { detail: { productIds: ids } }));
          } catch (_) {}
        }
        return _cache;
      })
      .catch(function () {
        /* Leave the catalogue answer standing. A pricing read that fails must
           not blank a price or invent one. */
        return _cache;
      });
  }

  window.ZWVariantPrice = {
    cents: priceCents,
    overrides: variantOverrides,
    resolve: resolveVariantPrice,
    lowest: lowestPriceCents,
    ask: ask,
    resolvedFor: resolvedFor
  };
})();
