/* Where an order came from — and the three ways this feature could ship,
 * pass review, and record nothing at all.
 *
 * This is a capture problem, not a reporting problem. A click id exists for one
 * page load; an order saved without it is anonymous permanently, and no export
 * or support ticket recovers it. So the failure that matters is not "the report
 * is wrong" — it is "the column is empty and nobody noticed for a month".
 *
 * The three ways that happens, each with tests below:
 *
 *   1. The browser module reads consent through a global that does not exist
 *      yet. consent.js loads at the BOTTOM of every page; attribution.js sits
 *      at the top with the trackers. `window.zwConsent.onGranted(...)` would
 *      throw or no-op on every page load, silently. It must read the stored
 *      choice directly, exactly as meta-pixel.js does.
 *   2. The value is injected at ONE call site instead of the shared wrapper.
 *      There are four paths that price a cart, and the forgotten one produces
 *      orders that look organic rather than orders that look broken.
 *   3. The column is written in the INSERT rather than a follow-up PATCH.
 *      PostgREST rejects the whole row over one unknown column, so an order
 *      would fail to save entirely between deploy and migration 0020.
 *
 * Everything about the compact/expanded pair is exercised by RUNNING it. The
 * lesson from this session, more than once: an assertion over source text
 * passes just as happily when the logic underneath is disabled.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const ATTR_JS   = fs.readFileSync(path.join(ROOT, 'attribution.js'), 'utf8');
const CHECKOUT  = fs.readFileSync(path.join(ROOT, 'commerce-checkout.js'), 'utf8');
const FULFIL    = fs.readFileSync(path.join(ROOT, 'functions/api/_fulfil.js'), 'utf8');
const PRICING   = fs.readFileSync(path.join(ROOT, 'functions/api/_cart-pricing.js'), 'utf8');
const PIXEL     = fs.readFileSync(path.join(ROOT, 'meta-pixel.js'), 'utf8');
const MIG       = fs.readFileSync(path.join(ROOT, 'migrations/0020_orders_remember_where_they_came_from.sql'), 'utf8');
const BUNDLE    = fs.readFileSync(path.join(ROOT, 'functions/api/_migrations.js'), 'utf8');

/* Comments in this codebase quote code and SQL. Three separate tests have been
   broken by prose being read as the thing it describes, so anything doing an
   ordering or absence check strips them first. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

(async () => {
  const A = await import(pathToFileURL(path.join(ROOT, 'functions/api/_attribution.js')).href);
  const { sanitizeAttribution, attributionToMeta, attributionFromMeta, sanitizeMatchKeys, META_BUDGET } = A;

  console.log('\n  an order remembers where it came from\n');

  console.log('  the round trip is lossless for the fields that matter');
  {
    const input = {
      first: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'brand-us',
               gclid: 'Cj0KCQ' + 'x'.repeat(80), referrer: 'google.com',
               landing: '/product.html', ts: 1755000000000 },
      last:  { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'retarget',
               fbclid: 'IwAR' + 'y'.repeat(90), referrer: 'facebook.com',
               landing: '/bag.html', ts: 1755100000000 },
    };
    const meta = attributionToMeta(input);
    ok('it fits Stripe\'s cap with two full click ids', meta.length <= META_BUDGET,
      'length was ' + meta.length + ' — Stripe rejects the PaymentIntent, so this loses the SALE not the report');

    const back = attributionFromMeta(meta);
    ok('first touch survives', back.first.utm_source === 'google' && back.first.gclid === input.first.gclid);
    ok('last touch survives',  back.last.utm_source === 'facebook' && back.last.fbclid === input.last.fbclid);
    ok('…and they are still distinguishable',
      back.first.utm_source !== back.last.utm_source,
      'collapsing them would credit every sale to whichever touch won');
    ok('the timestamps come back as numbers',
      typeof back.first.ts === 'number' && back.first.ts === 1755000000000);
    ok('the database form uses readable keys',
      Object.keys(back.first).includes('utm_campaign') && !Object.keys(back.first).includes('ca'),
      'a column nobody can query without a decoder ring stops being used');
  }

  console.log('\n  a single-visit order still answers "last touch"');
  {
    const touch = { utm_source: 'newsletter', utm_medium: 'email', ts: 1755000000000 };
    const meta = attributionToMeta({ first: touch, last: { ...touch } });
    const back = attributionFromMeta(meta);
    ok('last is present rather than a hole', !!back.last && back.last.utm_source === 'newsletter',
      'a report reading ->last should not have to special-case one-visit orders');
    /* The saving that makes two touches affordable inside 500 characters. */
    ok('…without storing it twice on the wire', !meta.includes('newsletter'.repeat(2)) && meta.length < 120,
      'identical touches must collapse or the budget is spent on a duplicate');
  }

  console.log('\n  it refuses to break a payment');
  {
    /* The failure mode that matters most: too much data must cost the
       ATTRIBUTION, never the order. */
    const huge = {
      first: { utm_source: 'x'.repeat(400), utm_campaign: 'y'.repeat(400),
               gclid: 'g'.repeat(400), fbclid: 'f'.repeat(400),
               utm_term: 't'.repeat(400), utm_content: 'c'.repeat(400),
               referrer: 'r'.repeat(400), landing: '/'.repeat(400) },
      last:  { utm_source: 'z'.repeat(400), gclid: 'h'.repeat(400),
               fbclid: 'i'.repeat(400), utm_term: 'u'.repeat(400) },
    };
    const meta = attributionToMeta(huge);
    ok('an absurd input never exceeds the budget', meta.length <= META_BUDGET,
      'was ' + meta.length + ' — over 500 and Stripe rejects the intent');
    ok('…and something survives if it can', meta === '' || meta.includes('so'),
      'trimming should drop context before it drops the campaign');

    /* Trimming order: the cheap fields go first. Sizes here are a realistic bad
       case — a ~100-char gclid, a long campaign name, full context on both
       touches — not the absurd one above. */
    const wide = {
      first: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'c'.repeat(90),
               gclid: 'g'.repeat(100), utm_term: 't'.repeat(90),
               utm_content: 'n'.repeat(90), referrer: 'r'.repeat(90), landing: '/l'.repeat(45) },
      last:  { utm_source: 'bing', msclkid: 'm'.repeat(100), utm_content: 'q'.repeat(90) },
    };
    const wideMeta = attributionToMeta(wide);
    const trimmed = attributionFromMeta(wideMeta);
    ok('the campaign outlives the context',
      wideMeta.length <= META_BUDGET && trimmed && trimmed.first.utm_source === 'google' && trimmed.first.gclid,
      'utm_source and the click id are the point; landing/referrer are decoration');
    ok('…and both touches are still told apart',
      trimmed && trimmed.last && trimmed.last.utm_source === 'bing');

    /* When even the stripped pair will not fit, first touch is kept and last is
       DROPPED — and flagged, so it is not silently reconstructed from first. */
    const overflowing = {
      first: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'c'.repeat(110),
               gclid: 'g'.repeat(190), ts: 1755000000000 },
      last:  { utm_source: 'bing', utm_campaign: 'd'.repeat(110), msclkid: 'm'.repeat(190) },
    };
    const kept = attributionFromMeta(attributionToMeta(overflowing));
    ok('an impossible pair keeps first touch rather than nothing',
      kept && kept.first && kept.first.utm_source === 'google');
    ok('…and does NOT claim bing\'s sale for google',
      kept && !kept.last && kept.truncated === true,
      'copying first into last would assert the opening channel closed the sale — the exact error two touches exist to prevent');
    /* Trimming is a LADDER, not a cliff: dropping `last` should be tried before
       also stripping `first` of its timestamp and context. Without this, the
       gentlest rung can be deleted and every other assertion still passes. */
    ok('…giving up the least it can',
      kept && kept.first.ts === 1755000000000,
      'once last is dropped there is room for first\'s timestamp — losing it too is gratuitous');
  }

  console.log('\n  junk in does not become junk stored');
  {
    ok('a non-object is null', attributionToMeta('hello') === '' && sanitizeAttribution(42) === null);
    ok('unknown keys are dropped',
      !JSON.stringify(sanitizeAttribution({ first: { evil: 'x', utm_source: 'ok' } })).includes('evil'),
      'a visitor appending ?anything= should not be able to grow the row');
    ok('a nested object is not stringified into a field',
      sanitizeAttribution({ first: { utm_source: { a: 1 } } }) === null,
      '"[object Object]" is worse than nothing');
    ok('malformed metadata writes nothing rather than junk',
      attributionFromMeta('{not json') === null && attributionFromMeta('') === null);

    /* A wrong browser clock would otherwise put an order's first touch in 1970
       and ruin any cohort built on it. */
    const old = sanitizeAttribution({ first: { utm_source: 'a', ts: 1 } });
    ok('an implausible timestamp is dropped, not stored', !old.first.ts);
    const future = sanitizeAttribution({ first: { utm_source: 'a', ts: Date.now() + 9e9 } });
    ok('…in both directions', !future.first.ts);

    const ctl = sanitizeAttribution({ first: { utm_source: 'a bc' } });
    ok('control characters are removed', !/[ -]/.test(ctl.first.utm_source));
  }

  console.log('\n  nothing to say says nothing');
  {
    ok('no parameters produces no metadata key', attributionToMeta({ first: {}, last: {} }) === '');
    ok('null is handled', attributionToMeta(null) === '' && attributionToMeta(undefined) === '');
    /* Empty string rather than "null"/"{}" so buildOrderMetadata leaves it out
       and an unattributed order reads as NULL in the column, not as "we looked
       and found nothing" — a different and false statement. */
    ok('…as an empty string, not the word null', attributionToMeta({}) === '');
  }

  console.log('\n  the Meta match keys stay out of the order');
  {
    const mk = sanitizeMatchKeys({ fbp: 'fb.1.123.456', fbc: 'fb.1.789.abc', utm_source: 'google' });
    ok('fbp and fbc come through', mk.fbp === 'fb.1.123.456' && mk.fbc === 'fb.1.789.abc');
    ok('nothing else does', Object.keys(mk).sort().join(',') === 'fbc,fbp');
    ok('absent is empty string, not undefined', sanitizeMatchKeys({}).fbp === '');

    /* They identify a browser to Meta. Storing them against a named customer
       with a shipping address buys nothing a report can use. */
    const stored = attributionFromMeta(attributionToMeta({ first: { utm_source: 'g' } }));
    ok('they never reach the attribution column',
      !JSON.stringify(stored).includes('fbp') && !JSON.stringify(stored).includes('fbc'));
  }

  console.log('\n  the browser module cannot be defeated by load order');
  {
    /* THE bug this feature was most likely to ship with. consent.js is loaded
       at the bottom of every page; this file sits at the top with the trackers,
       so window.zwConsent does not exist when it runs. */
    const code = strip(ATTR_JS);
    ok('it does not depend on window.zwConsent existing',
      !/window\.zwConsent/.test(code),
      'consent.js loads AFTER this file on every page — onGranted() would no-op silently, forever');
    ok('…it reads the stored choice directly, as meta-pixel.js does',
      /localStorage\.getItem\('zw_cookie_consent'\)/.test(code) &&
      /localStorage\.getItem\('zw_cookie_consent'\)/.test(strip(PIXEL)),
      'two modules disagreeing about consent is worse than either answer');
    ok('…and still catches consent given later',
      /addEventListener\('zw-consent-accepted'/.test(code));
  }

  console.log('\n  consent is honoured on both paths, separately');
  {
    const code = strip(ATTR_JS);
    ok('storage is gated', /function persist\(\)/.test(code) && /if \(consentGranted\(\)\) persist\(\)/.test(code));
    /* Storage being empty is NOT proof of a decline: this page's parameters sit
       in memory whatever the visitor chose. Gating only persist() would still
       have sent a declining visitor's click id on the page where it was in
       hand. */
    ok('and so is what checkout sends',
      /forOrder: function \(\) \{\s*if \(!consentGranted\(\)\) return null;/.test(code),
      'gating storage alone leaks the landing page load — the one that has the click id');
    ok('the pixel asks this module for fbc instead of re-deriving it',
      /window\.zwAttribution\.fbc\(\)/.test(strip(PIXEL)),
      'two answers to "what is this browser\'s fbc" means Meta matches worse and nothing reports it');
  }

  console.log('\n  a returning visitor does not erase the ad that found them');
  {
    const code = strip(ATTR_JS);
    ok('first touch is written once', /if \(!state\.first\)/.test(code));
    ok('last touch moves only for a campaign visit',
      /if \(hasCampaign\(pending\) \|\| !state\.last\)/.test(code),
      'the commonest way home-grown attribution zeroes itself is a direct return overwriting last touch');
    ok('utm_term/utm_content alone do not count as a campaign',
      /CAMPAIGN_KEYS/.test(code) &&
      !/CAMPAIGN_KEYS\s*=\s*\[[^\]]*utm_term/.test(code),
      'they refine a campaign rather than name one');
    ok('our own domain is not a referrer',
      /location\.hostname/.test(code),
      'otherwise page two of every visit overwrites the real referrer with our own host');
  }

  console.log('\n  it is injected once, for every path that prices a cart');
  {
    const code = strip(CHECKOUT);
    ok('the shared wrapper adds it', /attribution: \(window\.zwAttribution/.test(code));
    ok('…so all four priced endpoints carry it',
      /PRICED_ENDPOINTS/.test(code) &&
      /create-payment-intent/.test(code) && /paypal-create-order/.test(code) && /paypal-capture/.test(code),
      'the forgotten path produces orders that look organic rather than orders that look broken');

    /* Every page that can be landed on. A click id captured on a page the
       script is missing from is gone before checkout ever runs. */
    const PAGES = ['index.html', 'product.html', 'bag.html', 'checkout.html', 'drop001.html',
                   'landing.html', 'about.html', 'journal.html', 'policies.html', 'returns.html',
                   'sizeguide.html', 'account.html'];
    const missing = PAGES.filter((p) => !fs.readFileSync(path.join(ROOT, p), 'utf8').includes('attribution.js'));
    ok('every landable page loads it', missing.length === 0, 'missing from: ' + missing.join(', '));

    /* Order matters: meta-pixel.js delegates to window.zwAttribution, and both
       are deferred, so document order is execution order. */
    const wrong = PAGES.filter((p) => {
      const s = fs.readFileSync(path.join(ROOT, p), 'utf8');
      const a = s.indexOf('attribution.js'), m = s.indexOf('/meta-pixel.js');
      return a === -1 || m === -1 ? false : a > m;
    });
    ok('…before meta-pixel.js, which delegates to it', wrong.length === 0, 'after the pixel in: ' + wrong.join(', '));
  }

  console.log('\n  the server carries it without deciding it knows better');
  {
    ok('both processors build the same metadata',
      /attributionMeta/.test(fs.readFileSync(path.join(ROOT, 'functions/api/create-payment-intent.js'), 'utf8')) &&
      /attributionMeta/.test(fs.readFileSync(path.join(ROOT, 'functions/api/paypal-capture.js'), 'utf8')),
      'a PayPal order coming back unattributed reads as "PayPal buyers arrive organically"');
    ok('the metadata carries attribution and the match keys separately',
      /attribution: attributionMeta/.test(PRICING) && /fbp: \(matchKeys/.test(PRICING));
  }

  console.log('\n  writing it cannot cost an order');
  {
    const code = strip(FULFIL);
    /* PostgREST rejects the WHOLE row for one unknown column. In the insert,
       every order would fail to save between this deploy and 0020 being
       applied — payment taken, order lost. */
    const insertStart = code.indexOf('stripe_payment_intent_id: pi.id');
    const insertEnd   = code.indexOf('Supabase insert failed');
    ok('attribution is NOT in the insert',
      !code.slice(insertStart, insertEnd).includes('attribution'),
      'one unknown column rejects the row — money taken, order lost, until 0020 is applied');
    ok('…it is a follow-up PATCH like risk and feature_flags',
      code.indexOf('attributionFromMeta(meta.attribution)') > insertEnd);
    ok('…and it is non-fatal', /catch \(_\) \{ \/\* column not present/.test(FULFIL));

    ok('fbp and fbc reach the server-side Purchase',
      /fbp:\s*meta\.fbp/.test(code) && /fbc:\s*meta\.fbc/.test(code),
      'buildUserData has always accepted these and this call has always omitted them');
    const udStart = code.indexOf('const user_data = await buildUserData');
    ok('…on the CAPI call specifically, not somewhere else',
      code.indexOf('fbp:', udStart) - udStart < 400 && udStart !== -1);
  }

  console.log('\n  and the browser module actually does it');
  {
    /* Everything above about attribution.js reads its SOURCE, and source
       assertions pass just as happily when the logic is disabled. So: run it,
       in a fake browser, across the sequence that matters — land on an ad,
       accept the banner, come back direct, buy.
       No DOM library. This module touches location, localStorage, document
       .referrer/.cookie and addEventListener, and that is a small enough
       surface to stand up honestly here. */
    const vm = require('vm');
    const SRC = fs.readFileSync(path.join(ROOT, 'attribution.js'), 'utf8');

    const makeWindow = (url, referrer, store) => {
      const u = new URL(url);
      const listeners = {};
      const win = {
        location: { search: u.search, pathname: u.pathname, hostname: u.hostname, href: url },
        document: { referrer: referrer || '', cookie: '' },
        localStorage: {
          getItem: (k) => (k in store ? store[k] : null),
          setItem: (k, v) => { store[k] = String(v); },
          removeItem: (k) => { delete store[k]; },
        },
        addEventListener: (n, f) => { (listeners[n] = listeners[n] || []).push(f); },
        removeEventListener: (n, f) => { listeners[n] = (listeners[n] || []).filter((x) => x !== f); },
        URL, URLSearchParams, Date, JSON, String, Number,
        fire: (n) => (listeners[n] || []).slice().forEach((f) => f()),
      };
      win.window = win;
      vm.createContext(win);
      vm.runInContext(SRC, win);
      return win;
    };

    // 1. Land on a Google ad. Consent not yet given.
    const store = {};
    let w = makeWindow('https://zuwera.store/product.html?utm_source=google&utm_medium=cpc&utm_campaign=brand&gclid=ABC123',
      'https://www.google.com/', store);
    ok('nothing is stored before consent', Object.keys(store).length === 0,
      'the banner promises marketing does not run until accepted');
    ok('…and checkout would send nothing', w.zwAttribution.forOrder() === null);

    // 2. Accept the banner on that same page load.
    store.zw_cookie_consent = 'accepted';
    w.fire('zw-consent-accepted');
    ok('accepting stores the touch that is still in memory', !!store.zw_attr,
      'consent arrives seconds AFTER landing — capturing then persisting is the whole design');
    const stored = JSON.parse(store.zw_attr);
    ok('…with the click id intact', stored.first.gclid === 'ABC123');
    ok('…and the referring domain, not the full url', stored.first.referrer === 'google.com');
    ok('…and the landing path without the query', stored.first.landing === '/product.html');

    // 3. Return later, directly, and buy.
    w = makeWindow('https://zuwera.store/checkout.html', '', store);
    const order = w.zwAttribution.forOrder();
    ok('a direct return still credits the ad that found them',
      order && order.first.utm_source === 'google' && order.last.utm_source === 'google',
      'this is the commonest way home-grown attribution silently zeroes itself');
    const after = JSON.parse(store.zw_attr);
    ok('…and did not overwrite last touch with nothing', after.last.gclid === 'ABC123');

    // 4. An internal navigation must not become a referral.
    w = makeWindow('https://zuwera.store/bag.html', 'https://zuwera.store/product.html', store);
    ok('our own domain is never recorded as a referrer',
      JSON.parse(store.zw_attr).first.referrer === 'google.com');

    // 5. A second campaign moves LAST touch but never FIRST.
    w = makeWindow('https://zuwera.store/?utm_source=facebook&utm_medium=paid_social&fbclid=XYZ789',
      'https://l.facebook.com/', store);
    const both = JSON.parse(store.zw_attr);
    ok('a later ad becomes last touch', both.last.utm_source === 'facebook');
    ok('…and first touch is untouched', both.first.utm_source === 'google');
    ok('fbc is derived from the click id when the pixel cookie is absent',
      /^fb\.1\.\d+\.XYZ789$/.test(w.zwAttribution.fbc()));

    // 6. The whole journey survives the server round trip.
    const roundTripped = attributionFromMeta(attributionToMeta(w.zwAttribution.forOrder()));
    ok('google found them, facebook closed them — and the order says so',
      roundTripped.first.utm_source === 'google' && roundTripped.last.utm_source === 'facebook',
      'this is the single number a last-click-only model gets wrong');

    // 7. Decline: nothing is kept and nothing is sent.
    const declined = { zw_cookie_consent: 'declined' };
    const dw = makeWindow('https://zuwera.store/?utm_source=google&gclid=SHOULDNOTPERSIST', '', declined);
    ok('a decline stores nothing', !declined.zw_attr);
    ok('…and sends nothing to the server', dw.zwAttribution.forOrder() === null);
    ok('…on the landing page itself, where the id is still in hand',
      !JSON.stringify(declined).includes('SHOULDNOTPERSIST'));
  }

  console.log('\n  the column');
  {
    ok('0020 adds it', /add column if not exists attribution jsonb/.test(MIG));
    ok('…nullable with no default', !/attribution jsonb not null/.test(MIG) && !/attribution jsonb.*default/.test(MIG),
      'an empty object would read as "we looked and found nothing", which is false');
    ok('…and documented in the database', /comment on column public\.orders\.attribution/.test(MIG));
    ok('…with indexes on what reports group by',
      /utm_source/.test(MIG) && /utm_campaign/.test(MIG) && /gclid/.test(MIG),
      'this is the reason jsonb costs nothing here');
    ok('…partial, because most rows will be null for a long time',
      /where attribution is not null/.test(MIG));
    ok('the bundle picked it up', /0020/.test(BUNDLE),
      'Workers have no filesystem — an unbundled migration cannot be applied');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
