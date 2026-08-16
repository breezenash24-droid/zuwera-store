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
  /* productId -> the server has ANSWERED this page load (or the attempt has
     definitively finished). Not the same as having a cached figure: the cache
     is last week's answer, and a page that cannot tell those apart is a page
     that prints a stale price with total confidence. See known() below. */
  var _known = {};

  var STORE_KEY = 'zw_prices_v1';
  /* HOW OLD IS TOO OLD TO PAINT.
     This was ten minutes, on the reasoning that a stale figure should not be
     the first thing on screen. That had it backwards. Discarding the cache does
     not leave the page with nothing to draw — it leaves the page drawing the
     CATALOGUE price, which is not a stale answer to this question but an answer
     to a different one, and on any product with a price list it is further from
     the truth than the stale figure just thrown away. Eleven minutes after a
     visit, $40 was being painted over a $30 product and then corrected: exactly
     the flash the cache exists to prevent, caused by the cache.

     So: paint the last thing the SERVER said, however old, and let the fetch
     correct it — the fetch always runs. A day is the outer bound, past which a
     figure is old enough that the catalogue is the more honest guess. */
  var TTL_MS = 24 * 60 * 60 * 1000;

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

  /* HAS THE SERVER ANSWERED FOR THIS PRODUCT, THIS PAGE LOAD?
     The page uses this to decide whether it may print a number at all. A
     cached figure is not an answer — it is the answer to the last time
     somebody asked, and on a store whose prices are being edited it is exactly
     the number nobody wants to see again.

     Same shape as checkout-tax.js's isKnown(): a figure the browser has not
     been told is never rendered as though it had been. `false` here does not
     mean "no price", it means "not yet", and the caller shows a placeholder
     rather than guessing. */
  function known(productId) {
    return _known[String(productId || '')] === true;
  }

  /* Does this store charge members differently at all?
     The server decides it; this is only what the server last said, so that the
     CATALOGUE fallback — the rule this file applies when /api/prices cannot be
     reached — does not go on offering a member price the store has switched
     off. Defaults to on, and stays on until told otherwise, because every store
     predates the switch and guessing "off" would withdraw a discount that is
     currently being honoured at the till. */
  var _memberPricing = true;
  function memberPricingOn() { return _memberPricing !== false; }

  /* Settle a set of ids and tell whoever drew a price to redraw.
     Called on success, on failure and on timeout — a page waiting for an
     answer that never comes must fall back, not wait forever. */
  function settle(ids, changed) {
    var flipped = false;
    ids.forEach(function (id) {
      if (!_known[id]) { _known[id] = true; flipped = true; }
    });
    /* Fired when the answer moved OR when it has just become known. Firing only
       on `changed` was right while the page painted from cache and wrong the
       moment it started waiting: the first answer of a page load frequently
       MATCHES the cache, and the redraw that replaces the placeholder with a
       real price is exactly that case. */
    if (!changed && !flipped) return;
    try {
      window.dispatchEvent(new CustomEvent('zw:prices', { detail: { productIds: ids } }));
    } catch (_) {}
  }

  /* The same answer, found by COLOUR NAME rather than by variant id.
     A cart line carries colorName and nothing else — no variant id was ever
     stored — so every surface that prices a bag needs this door in. It is the
     same key _cart-pricing.js uses when it resolves the colour for the charge,
     which is what keeps the bag and the till on one answer.

     Folded the way colour is compared everywhere else: a swatch writes "Bright
     Crimson" and a stale bag entry may hold "bright crimson". A line with no
     colour, or a colour the server did not return, falls back to the
     product-wide figure — which is what a product without colourway pricing
     costs anyway. */
  function resolvedForColor(productId, colorName) {
    var entry = _cache[String(productId || '')];
    if (!entry) return null;
    var want = String(colorName || '').trim().toLowerCase();
    if (want) {
      var hit = (entry.colours || []).filter(function (c) {
        return String(c.colorName || '').trim().toLowerCase() === want;
      })[0];
      if (hit) return hit;
    }
    return entry.base || null;
  }

  function ask(productIds) {
    var ids = (Array.isArray(productIds) ? productIds : [productIds])
      .map(String).filter(function (id) { return id && !_asked[id]; });
    if (!ids.length) return Promise.resolve(_cache);
    ids.forEach(function (id) { _asked[id] = true; });

    /* A hung request must not leave a placeholder on screen indefinitely. At
       this point the page gives up waiting and draws what it has — the cached
       figure, or the catalogue price. That is the old behaviour, reached only
       when the network has failed to answer. */
    var timer = setTimeout(function () { settle(ids, false); }, 4000);

    var t = token();
    return fetch('/api/prices?productIds=' + encodeURIComponent(ids.join(',')), {
      cache: 'no-store',
      headers: t ? { Authorization: 'Bearer ' + t } : {}
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        clearTimeout(timer);
        if (!j || !j.ok || !Array.isArray(j.products)) { settle(ids, false); return _cache; }
        if (typeof j.memberPricing === 'boolean') _memberPricing = j.memberPricing;
        var changed = false;
        j.products.forEach(function (p) {
          var key = String(p.productId);
          var next = { base: p.base, colours: p.colours || [] };
          if (JSON.stringify(_cache[key]) !== JSON.stringify(next)) changed = true;
          _cache[key] = next;
        });
        saveCache();
        settle(ids, changed);
        return _cache;
      })
      .catch(function () {
        /* Leave the catalogue answer standing. A pricing read that fails must
           not blank a price or invent one. */
        clearTimeout(timer);
        settle(ids, false);
        return _cache;
      });
  }

  /* ── Ask as early as it is SAFE to ask ────────────────────────────────────
     The request used to be fired only once the product had been fetched from
     the database, so two round trips ran back to back and the placeholder — or,
     before it, the wrong price — was on screen for the length of both. The
     product id is in the URL, so the price can be asked for at the same time as
     the product rather than after it.

     On DOMContentLoaded rather than right now, and that timing is load-bearing:
     the access token is read through ZWStock, which is a deferred script far
     below this one. Asking before it exists would send the request with no
     Authorization header, the server would answer as a GUEST, and a signed-in
     member would be quoted the wrong price and then corrected — a worse flash
     than the one being removed, and a harder one to notice. Deferred scripts
     have all run by DOMContentLoaded. */
  function askFromUrl() {
    try {
      var id = new URLSearchParams(location.search).get('id') || '';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) ask(id);
    } catch (_) {}
  }
  /* typeof, not a bare reference. The pricing RULE at the top of this file is
     run directly by the parity test against its Worker twin, in an environment
     with no document and no location — and a ReferenceError here would take
     that whole comparison down over a line that has nothing to do with it. */
  if (typeof document !== 'undefined' && typeof location !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', askFromUrl, { once: true });
    } else {
      askFromUrl();
    }
  }

  /* THE GRIDS, WHICH WERE NEVER BROUGHT IN.
   *
   * The homepage and the collection page both paint a card price straight off
   * the catalogue row — `p.current_price || p.msrp` — and never ask the
   * resolver. Everywhere a shopper can see a price AFTER the card does went
   * through /api/prices when price lists were built; the two grids did not, so
   * on a store with any price list at all they disagree with the page they
   * link to. Measured live while auditing this: catalogue $40, resolver $32.
   *
   * One implementation for both, because there are already two grid renderers
   * to keep in step and a third copy of the price rule would be the thing that
   * drifts. A card marks its price element with data-zw-price-for="<product
   * id>" and calls this; ids that the server has not answered for are left
   * exactly as the card rendered them, so a failed or slow request shows the
   * catalogue price rather than a blank or a spinner.
   */
  function paintCards(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var nodes = scope.querySelectorAll('[data-zw-price-for]');
    if (!nodes.length) return Promise.resolve(0);
    var ids = [];
    for (var i = 0; i < nodes.length; i++) {
      var id = nodes[i].getAttribute('data-zw-price-for');
      if (id && ids.indexOf(id) === -1) ids.push(id);
    }
    var paint = function () {
      var n = 0;
      for (var j = 0; j < nodes.length; j++) {
        var el = nodes[j];
        var pid = el.getAttribute('data-zw-price-for');
        if (!known(pid)) continue;               // no answer: leave what it rendered
        var r = resolvedFor(pid);
        if (!r || typeof r.priceCents !== 'number') continue;
        /* The member figure only when this store charges one — the same switch
           the product page and the till consult, so a store with member pricing
           off never shows a member number on a card. */
        var cents = (r.usingMember && memberPricingOn() && typeof r.memberPriceCents === 'number')
          ? r.memberPriceCents : r.priceCents;
        var next = '$' + (cents / 100).toFixed(2);
        if (el.textContent !== next) { el.textContent = next; n++; }
      }
      return n;
    };
    return ask(ids).then(paint).catch(function () { return paint(); });
  }

  window.ZWVariantPrice = {
    cents: priceCents,
    paintCards: paintCards,
    overrides: variantOverrides,
    resolve: resolveVariantPrice,
    lowest: lowestPriceCents,
    ask: ask,
    resolvedFor: resolvedFor,
    resolvedForColor: resolvedForColor,
    known: known,
    memberPricingOn: memberPricingOn
  };
})();
