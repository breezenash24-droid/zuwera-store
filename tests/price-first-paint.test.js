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
 * The fix is the one the theme already uses: keep the last answer and paint
 * from it synchronously, then let the fetch correct it. Which means the thing
 * to test is not "does ask() work" but "what does the SECOND load paint before
 * any network happens" — so every case here runs the module twice against one
 * localStorage, and reads what the first frame would show.
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

  function load(payload, signedIn) {
    calls = 0;
    const listeners = [];
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
      return { ok: true, json: async () => payload };
    };
    const CustomEventShim = function (type, init) { this.type = type; this.detail = init && init.detail; };
    new Function('window', 'localStorage', 'fetch', 'CustomEvent', SRC)(
      win, win.localStorage, fetchImpl, CustomEventShim);
    return { api: win.ZWVariantPrice, win, listeners, fired: () => listeners.filter((l) => l.n === 'zw:prices').length, callCount: () => calls };
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
    await same.api.ask('p-1');
    ok('an unchanged answer fires no redraw', same.fired() === 0,
      'redrawing every load for an identical figure is the flash again with an extra step');

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

  console.log('\n  a stale cache expires rather than lingering');
  {
    const b = browser();
    const first = b.load(PRICED, false);
    await first.api.ask('p-1');

    /* Age it past the window. A scheduled price crossing its start date is the
       thing most likely to go stale, and this bounds how long it can be the
       first thing painted. */
    const raw = JSON.parse(b.store.zw_prices_v1);
    raw.at = Date.now() - (11 * 60 * 1000);
    b.store.zw_prices_v1 = JSON.stringify(raw);

    const later = b.load(PRICED, false);
    ok('an old cache is not painted', later.api.resolvedFor('p-1') === null);
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

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
