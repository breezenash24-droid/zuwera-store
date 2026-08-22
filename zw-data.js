/* ────────────────────────────────────────────────────────────────────────────
   zw-data.js — the two things every storefront page asks the server for.

   ── WHY THIS EXISTS: TWELVE ANSWERS TO ONE QUESTION ────────────────────────

   Twelve modules read site_settings, and every one of them opened its own
   connection to Supabase to do it:

       announcement-bar.js   announcement_bar        icon-sets.js      icons
       header-scroll.js      header_behavior         theme-engine.js   theme_modes
       image-effects.js      image_effects           zw-copy.js        text_overrides
       integrations.js       integrations            nav-menu.js       nav_menu
       express-wallet.js     integrations  (again)   fit-finder.js     fit_finder
       header-layouts.js     header_layout           flags.js          feature_flags
       storefront-features.js bag_panel

   Measured on the live homepage, those twelve requests started between 2,107 ms
   and 3,021 ms — not together, but as each module's own script happened to run
   — and the last of them settled around 3,520 ms. Twelve round trips to an
   origin in another region for twelve small JSON values.

   Meanwhile index.html was ALREADY fetching /api/storefront-settings in the
   <head>, before anything else on the page, and that one response carries most
   of the same values. The site was asking twice and using the slow answer.

   So: one request, and every module reads from it. Four keys had to be added to
   that endpoint's allow-list first (icons, theme_modes, text_overrides,
   header_layout) — see functions/api/storefront-settings.js.

   ── WHY A REJECTION IS NOT AN EMPTY ANSWER ─────────────────────────────────

   Each of those modules already distinguishes two things: a settings row that
   is absent (apply the defaults) and a read that failed (keep the cache, change
   nothing). Today the first arrives as `rows[0] === undefined` and the second
   as a rejected promise they .catch() and ignore.

   get() preserves exactly that. A missing key resolves to null. A settings read
   that FAILED rejects, so every existing .catch(){} keeps behaving as it always
   has. Collapsing the two would mean a Supabase blip silently resetting a
   store's theme, header and copy to the shipped defaults, which is a far worse
   failure than the slow one being fixed here.

   ── AND THE CATALOGUE, WHICH USED TO BE UNBOUNDED ──────────────────────────

   /api/catalog is now paginated (see that file for the numbers). Everything
   that reads a catalogue reads it through zwFetchCatalog, so there is one
   paging loop rather than one per caller — and one place that knows the
   difference between "that is the whole catalogue" and "that is page one".
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* ── Settings ───────────────────────────────────────────────────────────── */

  var settingsPromise = null;

  /* ── THE ANSWER THAT ARRIVED WITH THE DOCUMENT ────────────────────────────
     functions/_middleware.js reads the first-paint settings as the page is
     served and writes them into <head> as inline JSON. Fourteen keys, 3,986
     bytes on the live store, 1,552 gzipped — the colours, fonts, copy, icons,
     categories, announcement bar and header arrangement.

     Every module that reads a setting used to do the same thing: paint from
     localStorage, then fetch, then correct itself. That is wrong twice, and
     both times in front of somebody:

         a first-ever visitor      has nothing cached, so they watch the
                                   shipped defaults become the real store.
         the visit after a change  has the OLD value cached, so they watch
                                   last week's store become this week's.

     A stamped key needs neither. It is already in the document.

     FRESHNESS, STATED. The stamp is at most as old as the middleware's edge
     cache — five minutes. So within one page load a stamped key does not see a
     change published in the last few minutes; the next load does. That is the
     same contract the header attributes have carried since they were stamped,
     and it is a far better trade than a correct value that arrives after the
     visitor has already read the wrong one. */
  var stamped = (function () {
    try {
      var el = document.getElementById('zw-first-paint');
      if (!el) return null;
      var v = JSON.parse(el.textContent || 'null');
      if (!v || typeof v.settings !== 'object' || !v.settings) return null;
      return { settings: v.settings, updatedAt: (v.updatedAt && typeof v.updatedAt === 'object') ? v.updatedAt : {} };
    } catch (_) { return null; }
  }());

  /* hasOwnProperty rather than `!== undefined`: the edge omits a key that has no
     row, so "stamped as null" and "not stamped" are genuinely different — the
     first is an answer, the second has to go to the network. */
  function isStamped(key) {
    return !!stamped && Object.prototype.hasOwnProperty.call(stamped.settings, key);
  }

  function fetchSettings() {
    if (settingsPromise) return settingsPromise;

    /* index.html fires this in <head>, before the stylesheets, so on the
       homepage the answer is usually already on its way before this file has
       even been parsed. Taken once and cleared, so a later caller starts a
       fresh request rather than awaiting a promise somebody already drained. */
    var early = null;
    try {
      early = window.__zwSettingsEarlyFetch || null;
      window.__zwSettingsEarlyFetch = null;
    } catch (_) {}

    settingsPromise = (early || fetch('/api/storefront-settings', {
      headers: { Accept: 'application/json' },
    }))
      .then(function (r) {
        if (!r || !r.ok) throw new Error('settings http ' + (r && r.status));
        return r.json();
      })
      .then(function (body) {
        /* ok:false means the server could not read the settings — NOT that
           there are none. Turning that into an empty object here is how a
           one-second outage would become a store with no configuration. */
        if (!body || body.ok !== true) throw new Error('settings not ok');
        return {
          settings: (body.settings && typeof body.settings === 'object') ? body.settings : {},
          updatedAt: (body.updatedAt && typeof body.updatedAt === 'object') ? body.updatedAt : {},
        };
      });

    /* A failed read must not be remembered as the answer for the rest of the
       page's life. Clearing the memo lets the next caller try again — which
       matters because these modules run seconds apart. */
    settingsPromise.catch(function () { settingsPromise = null; });

    return settingsPromise;
  }

  /**
   * One setting, by key.
   * @returns {Promise<*>} the value, or null when no such row exists.
   *                       REJECTS when the settings could not be read at all.
   */
  function get(key) {
    if (isStamped(key)) return Promise.resolve(stamped.settings[key]);
    return fetchSettings().then(function (d) {
      var v = d.settings[key];
      return v === undefined ? null : v;
    });
  }

  /**
   * The stamped value, synchronously, or undefined if this key was not stamped.
   *
   * WHY A SYNCHRONOUS READ EXISTS AT ALL. get() resolves in a microtask, which
   * is early enough for almost everything. It is NOT early enough for a module
   * whose whole job is to be right before the first paint — theme-engine.js
   * decides the page's colours, and a microtask is one turn too late if the
   * browser paints in between. Those callers ask peek() first and fall back to
   * their existing path when it answers undefined.
   *
   * Returns undefined for "not stamped" and the value for "stamped", including
   * when that value is null.
   */
  function peek(key) {
    return isStamped(key) ? stamped.settings[key] : undefined;
  }

  /**
   * A setting plus when it last changed — header-layouts.js compares that
   * timestamp against the one stamped on the document to decide whether its
   * pre-paint cache is still the freshest thing it has.
   */
  function getWithMeta(key) {
    if (isStamped(key)) {
      return Promise.resolve({
        value: stamped.settings[key],
        updated_at: stamped.updatedAt[key] || null,
      });
    }
    return fetchSettings().then(function (d) {
      var v = d.settings[key];
      return { value: v === undefined ? null : v, updated_at: d.updatedAt[key] || null };
    });
  }

  /** Everything, for a caller that wants several keys at once. */
  function all() {
    return fetchSettings().then(function (d) { return d.settings; });
  }

  /**
   * Publish a settings response this page already has, so the first get() does
   * not start a second request for it. Used by pages that fetch settings in
   * their own <head> under a different name.
   */
  function prime(responsePromise) {
    if (!settingsPromise && responsePromise) {
      try { window.__zwSettingsEarlyFetch = responsePromise; } catch (_) {}
    }
  }

  /* ── The catalogue ──────────────────────────────────────────────────────── */

  /* Enough to walk a catalogue far larger than any this ships to, and low
     enough that a bug cannot turn into an unbounded request loop against the
     origin. Hitting it is reported, not swallowed — a caller that thinks it has
     the whole catalogue when it does not is the failure this whole endpoint
     change exists to prevent. */
  var MAX_PAGES = 40;

  /**
   * The catalogue, paged until it is complete.
   *
   * @param {Object}  [opts]
   * @param {string}  [opts.view='full']   'list' drops the columns only a
   *                                       product page reads — grids want this.
   * @param {number}  [opts.pageSize=250]
   * @param {number}  [opts.max]           stop after this many products; the
   *                                       result then says complete:false.
   * @param {Promise} [opts.first]         an already-in-flight response for
   *                                       page one (the homepage's early fetch).
   * @param {Function}[opts.onPage]        (pageProducts, state) after each page,
   *                                       so a grid can paint page one rather
   *                                       than wait for the last.
   * @returns {Promise<{ok, products, total, complete}>}
   *          `complete` is the only safe basis for deciding that something is
   *          absent from the catalogue.
   */
  function fetchCatalog(opts) {
    var o = opts || {};
    var view = o.view === 'list' ? 'list' : 'full';
    var pageSize = Math.max(1, Math.min(500, Number(o.pageSize) || 250));
    var products = [];
    var total = null;
    var pages = 0;

    function url(offset) {
      return '/api/catalog?view=' + view + '&limit=' + pageSize + '&offset=' + offset;
    }

    function readPage(resp) {
      if (!resp || !resp.ok) throw new Error('catalog http ' + (resp && resp.status));
      return resp.json();
    }

    function step(offset, firstResponse) {
      pages++;
      var p = firstResponse || fetch(url(offset), { headers: { Accept: 'application/json' } });
      return Promise.resolve(p).then(readPage).then(function (body) {
        /* A bare array is what this endpoint answered before it was paginated.
           A page cached from before the change still has to render. */
        var batch = Array.isArray(body) ? body : ((body && body.products) || []);
        var ok = Array.isArray(body) ? true : !!(body && body.ok);
        if (!Array.isArray(body) && body && typeof body.total === 'number') total = body.total;

        products = products.concat(batch);

        /* Three independent ways to know the catalogue is exhausted, because
           any one of them alone leaves a hole:
             the server says this response holds everything;
             we have as many products as it says exist;
             the page came back short, which only happens at the end.
           `atEnd` answers "did we see all of it". `done` answers "stop
           looping", which is a different question — a caller that asked for
           only the first N stops without having seen all of it, and must not be
           told otherwise. */
        var serverComplete = !Array.isArray(body) && !!body && body.complete === true;
        var haveAll = total !== null && products.length >= total;
        var shortPage = batch.length < pageSize;
        var atEnd = serverComplete || haveAll || shortPage;
        var reachedMax = !!o.max && products.length >= o.max;
        var done = atEnd || reachedMax || pages >= MAX_PAGES;

        if (pages >= MAX_PAGES && !atEnd) {
          try { console.warn('zwFetchCatalog: stopped at ' + MAX_PAGES + ' pages; the result is NOT the whole catalogue'); } catch (_) {}
        }

        var state = { ok: ok, total: total, loaded: products.length, complete: atEnd };
        if (typeof o.onPage === 'function') {
          try { o.onPage(batch, state); } catch (_) {}
        }

        if (done) return { ok: ok, products: products, total: total, complete: atEnd };
        return step(products.length, null);
      });
    }

    return step(0, o.first || null);
  }

  window.zwSettings = {
    get: get,
    getWithMeta: getWithMeta,
    peek: peek,
    all: all,
    prime: prime,
    /* Whether this document arrived with its first-paint settings in it. Lets a
       caller tell "not stamped" from "stamped as absent" without reaching into
       the DOM a second time. */
    stamped: function () { return !!stamped; },
    /* Testing and diagnostics only — a module should ask for its key. */
    _reset: function () { settingsPromise = null; },
  };
  window.zwFetchCatalog = fetchCatalog;

  /* ── IS THIS A GIFT CARD? THE BROWSER'S COPY OF THE TILL'S RULE ────────────
   *
   * _cart-pricing.js has known this for as long as gift cards have existed: a
   * line with giftCardCents above zero takes no shipping weight, is excluded
   * from promotions and member pricing, and a cart where EVERY line is one gets
   * zero shipping and zero tax.
   *
   * The browser knew none of it. So a $50 gift card went into the bag with the
   * default half-pound weight every cart item gets, the bag fetched a real USPS
   * rate against that phantom parcel, and the summary read:
   *
   *     Subtotal   $50.00
   *     Shipping    $5.58
   *     Total      $55.58
   *
   * while the server was going to charge $50.00. Every one of those numbers was
   * produced honestly by code that had no way to know what it was holding.
   *
   * This is the missing fact, in one place, so the bag, the product page and the
   * checkout cannot each grow their own version of it — which is the shape of
   * every money bug this codebase has already paid for.
   *
   * IT IS FOR DISPLAY ONLY. The till still decides, off the catalogue, exactly
   * as before: a browser that could declare its own cart untaxable would.
   */
  window.ZWGiftCard = {
    /** One line. Reads the flag the cart carries, and falls back to a raw
        product row so the product page can ask before anything is in a bag. */
    is: function (item) {
      if (!item) return false;
      return Number(item.giftCardCents || item.gift_card_cents || 0) > 0;
    },
    /** Nothing in this cart ships, so nothing about shipping applies to it.
        An EMPTY cart is not a gift-card cart — `every` says true for one, and
        an empty bag must keep saying "Free on orders $100+" rather than
        quietly becoming a digital order. */
    cartIsAllCards: function (items) {
      var list = Array.isArray(items) ? items : [];
      if (!list.length) return false;
      return list.every(window.ZWGiftCard.is);
    },
    /** Mixed carts still ship, and still need an address. */
    cartHasACard: function (items) {
      return (Array.isArray(items) ? items : []).some(window.ZWGiftCard.is);
    },
  };
})();
