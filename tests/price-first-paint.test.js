/* The price on screen is right on the FIRST frame of a reload.
 *
 * "It still loads the old price when you reload, it shows it for probably 1
 *  second."
 *
 * That second is the round trip. The page drew the CATALOGUE figure — the
 * product row and the colourway row, which know nothing about price lists —
 * then asked the server, then redrew. Correct in the end and wrong for as long
 * as the network took, on every single load.
 *
 * THE FIRST ATTEMPT was the one the theme uses: keep the last answer and paint
 * from it synchronously, then let the fetch correct it. It made the flash
 * shorter and did not remove it — a cached figure is last week's answer, and on
 * a store whose prices are being edited it is exactly the number nobody wants
 * to see again. "It still loads the old price first when you reload. I don't
 * want that at all."
 *
 * So the rule is now the one checkout-tax.js follows for the tax total: a figure
 * the browser has not been TOLD is never rendered as though it had been.
 * known() separates "I have a figure" from "the server has answered", the page
 * shows a placeholder until the second is true, and the request goes out in
 * parallel with the product fetch rather than after it.
 *
 * The cache survives as the FALLBACK — what to draw when the network fails —
 * which is why the reload cases below still check it is there and still correct.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SRC = fs.readFileSync(path.join(ROOT, 'variant-price.js'), 'utf8');

const PRICED = {
  ok: true,
  products: [{
    productId: 'p-1',
    base: { priceCents: 3000, compareAtCents: 4000, source: 'list' },
    colours: [{ id: 'v-1', colorName: 'Yellow', priceCents: 2500, compareAtCents: 4000, source: 'list' }],
  }],
};

/* One browser: a persistent localStorage, a fresh module each "load". */
function browser(opts) {
  const store = {};
  let calls = 0;
  const o = opts || {};

  function load(payload, signedIn, search) {
    calls = 0;
    const listeners = [];
    const docListeners = [];
    /* The module now asks for the price itself, off the URL, at
       DOMContentLoaded — so it needs a document and a location. Default
       readyState is 'complete' and the default URL carries no id, which makes
       the auto-ask a no-op unless a test asks for one. */
    const doc = {
      readyState: 'complete',
      addEventListener: (n, f) => docListeners.push({ n, f }),
    };
    const loc = { search: search || '' };
    const win = {
      localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
      },
      ZWStock: { storedAccessToken: () => (signedIn ? 'TOKEN' : '') },
      addEventListener: (n, f) => listeners.push({ n, f }),
      dispatchEvent: (e) => { listeners.filter((l) => l.n === e.type).forEach((l) => l.f(e)); },
    };
    const fetchImpl = async () => {
      calls++;
      if (o.fail) throw new Error('offline');
      /* A request that never answers — a captive-portal wifi, a dead tunnel.
         Not the same as a failure: nothing rejects, so the catch never runs. */
      if (o.hang) return new Promise(() => {});
      return { ok: true, json: async () => payload };
    };
    /* Fires the module's own timeout at once instead of waiting out its four
       seconds. The point is that the timeout EXISTS and settles, not how long
       it is. */
    const timers = o.hang
      ? { set: (fn) => { fn(); return 0; }, clear: () => {} }
      : { set: setTimeout, clear: clearTimeout };
    const CustomEventShim = function (type, init) { this.type = type; this.detail = init && init.detail; };
    new Function('window', 'localStorage', 'fetch', 'CustomEvent', 'document', 'location', 'URLSearchParams', 'setTimeout', 'clearTimeout', SRC)(
      win, win.localStorage, fetchImpl, CustomEventShim, doc, loc, URLSearchParams, timers.set, timers.clear);
    return {
      api: win.ZWVariantPrice, win, listeners, docListeners,
      fired: () => listeners.filter((l) => l.n === 'zw:prices').length,
      callCount: () => calls,
    };
  }

  return { load, store };
}

(async () => {
  console.log('\n  the price is right on the first frame\n');

  console.log('  a cold load has nothing, and says so');
  {
    const b = browser();
    const first = b.load(PRICED, false);
    /* Nothing cached: the caller falls back to the catalogue, which is what
       the page showed before price lists existed. Never a guess. */
    ok('resolvedFor is null before anything is asked', first.api.resolvedFor('p-1') === null);
    await first.api.ask('p-1');
    ok('…and holds the answer afterwards', first.api.resolvedFor('p-1').priceCents === 3000);
    ok('…including per colourway', first.api.resolvedFor('p-1', 'v-1').priceCents === 2500);
  }

  console.log('\n  the RELOAD paints the right price with no network at all');
  {
    const b = browser();
    const first = b.load(PRICED, false);
    await first.api.ask('p-1');

    /* THE BUG. Everything below happens before any fetch on the second load. */
    const second = b.load(PRICED, false);
    ok('the answer is there synchronously', second.api.resolvedFor('p-1') !== null,
      'this is the second the shopper was watching the old price for');
    ok('…and it is the price-list figure, not the catalogue one',
      second.api.resolvedFor('p-1').priceCents === 3000);
    ok('…per colourway too', second.api.resolvedFor('p-1', 'v-1').priceCents === 2500);
    ok('…with nothing fetched yet', second.callCount() === 0);
  }

  console.log('\n  and the correction still happens, quietly');
  {
    const b = browser();
    const first = b.load(PRICED, false);
    await first.api.ask('p-1');

    const same = b.load(PRICED, false);
    let sameSeen = 0;
    /* Counted through a REGISTERED LISTENER. This read `same.fired()`, which is
       the harness counting how many listeners exist — nothing in the module
       registers one, so it was zero no matter what the module did, and the
       assertion passed while testing nothing at all. */
    same.win.addEventListener('zw:prices', () => { sameSeen++; });
    await same.api.ask('p-1');
    ok('an unchanged answer redraws exactly once', sameSeen === 1,
      'once to replace the placeholder with the confirmed figure — and not again, '
      + 'because redrawing a settled price for an identical figure is the flash with an extra step');

    const moved = b.load({ ok: true, products: [{ productId: 'p-1', base: { priceCents: 1999, compareAtCents: 4000, source: 'list' }, colours: [] }] }, false);
    let seen = 0;
    moved.win.addEventListener('zw:prices', () => { seen++; });
    await moved.api.ask('p-1');
    ok('a changed answer does fire one', seen === 1);
    ok('…and the new figure is what is read back', moved.api.resolvedFor('p-1').priceCents === 1999);
  }

  console.log('\n  a cached price is never shown to the wrong shopper');
  {
    const b = browser();
    const asMember = b.load(PRICED, true);
    await asMember.api.ask('p-1');

    const asGuest = b.load(PRICED, false);
    ok('signing out discards the member cache', asGuest.api.resolvedFor('p-1') === null,
      'a member figure painted for a guest is worse than the catalogue price');

    const b2 = browser();
    const asGuestFirst = b2.load(PRICED, false);
    await asGuestFirst.api.ask('p-1');
    const nowMember = b2.load(PRICED, true);
    ok('…and signing in discards the guest one', nowMember.api.resolvedFor('p-1') === null);
  }

  console.log('\n  a cache from yesterday still beats the catalogue');
  {
    /* THIS TEST USED TO ASSERT THE OPPOSITE, and the opposite was wrong.
       The window was ten minutes, on the reasoning that a stale figure should
       not be the first thing painted. But discarding the cache does not leave
       the page with nothing to draw — it leaves the page drawing the CATALOGUE
       price, which is not a stale answer to this question but an answer to a
       different one. On a product with a live price list it is further from the
       truth than the figure just thrown away: eleven minutes after a visit, $40
       was being painted over a $30 product and then corrected, which is exactly
       the flash the cache exists to prevent, caused by the cache.

       So the last thing the SERVER said is painted however old it is, and the
       fetch — which always runs — corrects it. */
    const b = browser();
    const first = b.load(PRICED, false);
    await first.api.ask('p-1');

    const raw = JSON.parse(b.store.zw_prices_v1);
    raw.at = Date.now() - (11 * 60 * 1000);
    b.store.zw_prices_v1 = JSON.stringify(raw);

    const later = b.load(PRICED, false);
    ok('an eleven-minute-old answer is still painted', later.api.resolvedFor('p-1').priceCents === 3000,
      'the alternative is not "no price", it is the catalogue price');
    await later.api.ask('p-1');
    ok('…and the fetch confirms it', later.api.resolvedFor('p-1').priceCents === 3000);
  }

  console.log('\n  …but not one from last month');
  {
    /* There is still an outer bound. Past some age a figure is old enough that
       the catalogue price is the more honest guess, and a cache with no expiry
       at all is one that can outlive the product it prices. */
    const b = browser();
    const first = b.load(PRICED, false);
    await first.api.ask('p-1');

    const raw = JSON.parse(b.store.zw_prices_v1);
    raw.at = Date.now() - (30 * 24 * 60 * 60 * 1000);
    b.store.zw_prices_v1 = JSON.stringify(raw);

    const later = b.load(PRICED, false);
    ok('a month-old answer is discarded', later.api.resolvedFor('p-1') === null);
    await later.api.ask('p-1');
    ok('…and the fetch refills it', later.api.resolvedFor('p-1').priceCents === 3000);
  }

  console.log('\n  it survives everything going wrong');
  {
    const b = browser({ fail: true });
    const first = b.load(PRICED, false);
    await first.api.ask('p-1');
    ok('a failed fetch leaves the catalogue answer standing', first.api.resolvedFor('p-1') === null,
      'blanking a price or inventing one is worse than showing what the catalogue says');

    const b2 = browser();
    b2.store.zw_prices_v1 = '{not json';
    const corrupt = b2.load(PRICED, false);
    ok('corrupt storage is ignored, not thrown', corrupt.api.resolvedFor('p-1') === null);

    const b3 = browser();
    b3.store.zw_prices_v1 = JSON.stringify({ v: 99, at: Date.now(), member: 0, byId: { 'p-1': { base: { priceCents: 1 } } } });
    const wrongVersion = b3.load(PRICED, false);
    ok('a cache from an older shape is ignored', wrongVersion.api.resolvedFor('p-1') === null,
      'a version stamp is what lets the shape change without poisoning every returning browser');
  }

  console.log('\n  the cache cannot grow without bound');
  {
    const b = browser();
    const many = { ok: true, products: [] };
    for (let i = 0; i < 80; i++) {
      many.products.push({ productId: 'p-' + i, base: { priceCents: 100 + i, source: 'list' }, colours: [] });
    }
    const l = b.load(many, false);
    await l.api.ask(many.products.map((p) => p.productId));
    const stored = JSON.parse(b.store.zw_prices_v1);
    ok('it is trimmed to a bound', Object.keys(stored.byId).length <= 60,
      'unbounded, localStorage eventually throws QuotaExceeded and caching silently stops');
    ok('…keeping the most recent', !!stored.byId['p-79']);
  }

  console.log('\n  a cached figure is not an ANSWER');
  {
    /* "It still loads the old price first when you reload."
       Removing the cache would not have fixed that — with nothing cached the
       page drew the CATALOGUE price instead, which on a discounted product is
       just as wrong. The mistake was drawing a price before knowing one, so the
       module now distinguishes "I have a figure" from "the server has told me",
       and the page prints nothing until the second is true. */
    const b = browser();
    const first = b.load(PRICED, false);
    await first.api.ask('p-1');

    const later = b.load(PRICED, false);
    ok('the cached figure is still there on the next load', !!later.api.resolvedFor('p-1'));
    ok('…but it does not count as known', later.api.known('p-1') === false,
      'this is the whole fix: a stale number and a confirmed one must not look alike');
    await later.api.ask('p-1');
    ok('…until the server answers', later.api.known('p-1') === true);
  }

  console.log('\n  …and the page is told even when the answer has not moved');
  {
    /* The redraw that replaces the placeholder with a real price is almost
       always the case where the answer MATCHES the cache. Firing zw:prices only
       on a change left that page showing a placeholder forever. */
    const b = browser();
    const first = b.load(PRICED, false);
    await first.api.ask('p-1');

    const later = b.load(PRICED, false);
    let redraws = 0;
    later.win.addEventListener('zw:prices', () => { redraws++; });
    await later.api.ask('p-1');
    ok('an unchanged answer still fires zw:prices', redraws > 0,
      'the first answer of a page load usually matches the cache, and that is exactly the redraw that matters');
  }

  console.log('\n  …and a failure settles rather than hanging');
  {
    const b = browser({ fail: true });
    const l = b.load(PRICED, false);
    let redraws = 0;
    l.win.addEventListener('zw:prices', () => { redraws++; });
    await l.api.ask('p-1');
    ok('a failed request still marks the price known', l.api.known('p-1') === true,
      'a placeholder waiting on a request that will never answer is worse than the flash it replaced');
    ok('…and tells the page to draw its fallback', redraws > 0);
    ok('…without inventing a figure', l.api.resolvedFor('p-1') === null);
  }

  console.log('\n  …and a request that never answers settles too');
  {
    /* Not the same as a failure. Nothing rejects, so the catch never runs — a
       captive-portal wifi, a tunnel that dropped. Without a timeout the
       placeholder would still be on screen when the shopper gave up. */
    const b = browser({ hang: true });
    const l = b.load(PRICED, false);
    let redraws = 0;
    l.win.addEventListener('zw:prices', () => { redraws++; });
    l.api.ask('p-1');
    ok('the page stops waiting', l.api.known('p-1') === true,
      'a placeholder with no timeout is permanent on any network that hangs rather than fails');
    ok('…and is told to draw its fallback', redraws > 0);
  }

  console.log('\n  the request goes out in parallel with the product');
  {
    /* It used to be fired only after the product had been fetched, so two round
       trips ran back to back and the placeholder was on screen for both. */
    const id = '185c7f10-d692-40f2-8a4c-a4825b1d5a2d';
    const withId = { ok: true, products: [{ productId: id, base: { priceCents: 2500, source: 'list' }, colours: [] }] };
    const b = browser();
    const l = b.load(withId, false, '?id=' + id + '&sku=ZW-MTP-002');
    await new Promise((r) => setTimeout(r, 0));
    ok('the id in the URL is enough to ask', l.callCount() === 1,
      'the product id is in the URL, so the price can be asked for at the same time as the product');

    const noId = browser().load(PRICED, false, '?sku=ZW-MTP-002');
    await new Promise((r) => setTimeout(r, 0));
    ok('…and a URL without one asks for nothing', noId.callCount() === 0);

    const junk = browser().load(PRICED, false, '?id=not-a-uuid');
    await new Promise((r) => setTimeout(r, 0));
    ok('…nor does a URL with a made-up one', junk.callCount() === 0,
      'an unvalidated id from the query string is a request shaped by whoever sent the link');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
