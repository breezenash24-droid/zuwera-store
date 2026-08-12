let stripe, elements, cardElement;
let stripeInitPromise;

function getStripeCardTheme() {
  const isLight = document.body.classList.contains('light-mode');
  return {
    text: isLight ? '#09090b' : '#f5f5f0',
    placeholder: isLight ? 'rgba(9,9,11,0.58)' : 'rgba(245,245,240,0.38)',
    invalid: '#c0392b',
  };
}

/* ── What a decline actually means ────────────────────────────────────────
   Stripe returns a generic message for most declines — "Your card was
   declined." is what insufficient_funds, incorrect_cvc and lost_card all say.
   True, and useless: each needs a different next step from the shopper, and
   surfacing error.message alone dead-ends all three identically.

   The real code is in error.decline_code, which this file never read. Test
   mode hides the problem, because test cards return clean documented codes on
   demand while real issuers decline for messy reasons.

   Only codes where a shopper can DO something get their own copy. A decline
   they cannot act on ("do_not_honor" — the issuer refusing without saying why)
   should not be dressed up as advice; it gets an honest "try another card".
   Inventing a reason is worse than not having one, because the shopper spends
   their next five minutes fixing something that was never wrong. */
/* The copy lives in customer-messages.js and is editable in Admin -> Loyalty ->
   Customer messages. Stripe's twenty-odd decline codes map onto nine messages
   there -- the grouping is in DECLINE_MAP beside them, so this file carries no
   table of its own to fall out of step with. */
function declineMessage(err) {
  const M = typeof window !== 'undefined' ? window.ZWMessages : null;
  /* Without the module there is still an answer, because a refused payment
     with no explanation is the worst outcome available here. It is the only
     sentence in this file, and it is word-for-word the shipped catch-all, so
     it cannot say something different from the editable copy. */
  const generic = 'That card was declined. Try another card, or call your bank.';
  if (!M) return (err && err.message) || generic;

  const say = (code) => M.get(M.declineKey(code));

  if (!err) return say('') || generic;

  /* Stripe puts the reason in decline_code for card_declined, and in code for
     everything else (expired_card, incorrect_cvc arrive either way). The
     specific one wins when both are present. */
  const code = String(err.decline_code || '').trim();
  const top = String(err.code || '').trim();
  const known = (c) => c && M.declineKey(c) !== 'declined';

  if (known(code)) return say(code) || generic;
  if (known(top)) return say(top) || generic;
  /* Nothing we recognise. Stripe's own message first -- it is written for
     shoppers and is often more specific than our catch-all. */
  return err.message || say('') || generic;
}

if (typeof window !== 'undefined') window.zwDeclineMessage = declineMessage;

function getStripeCardStyle() {
  const theme = getStripeCardTheme();
  return {
    base: {
      color: theme.text,
      iconColor: theme.text,
      fontFamily: '"DM Sans", sans-serif',
      fontSmoothing: 'antialiased',
      fontSize: '16px',
      fontWeight: '500',
      '::placeholder': { color: theme.placeholder },
    },
    invalid: { color: theme.invalid, iconColor: theme.invalid },
  };
}

function refreshStripeCardTheme() {
  if (cardElement?.update) {
    cardElement.update({ style: getStripeCardStyle() });
  }
}

async function getCheckoutPublishableKey() {
  if (window.zwGetStripePublishableKey) return window.zwGetStripePublishableKey();
  const resp = await fetch('/api/stripe-config', { headers: { Accept: 'application/json' } });
  const data = await resp.json();
  if (!resp.ok || !data?.publishableKey) throw new Error(data?.error || 'Unable to load Stripe configuration.');
  return data.publishableKey;
}

function cardStyleForMode(light) {
  return {
    base: {
      color: light ? '#09090b' : '#f5f5f0',
      iconColor: light ? '#09090b' : '#f5f5f0',
      fontFamily: '"DM Sans", sans-serif',
      fontSmoothing: 'antialiased',
      fontSize: '16px',
      fontWeight: '500',
      '::placeholder': { color: light ? 'rgba(9,9,11,0.58)' : 'rgba(245,245,240,0.38)' },
    },
    invalid: { color: '#c0392b', iconColor: '#c0392b' },
  };
}

function isLightMode() {
  if (document.body.classList.contains('light-mode')) return true;
  // storefront-theme.js stores the resolved mode here
  try { return localStorage.getItem('zw_theme_mode') === 'light'; } catch (_) { return false; }
}

function mountCard(light) {
  // Destroy any existing card element first — cardElement.update() does not
  // reliably re-render base.color after creation (Stripe limitation).
  if (cardElement) {
    try { cardElement.destroy(); } catch (_) {}
    cardElement = null;
  }
  const container = document.getElementById('stripe-card-element');
  if (container) container.innerHTML = '';
  const useLightColors = (light !== undefined) ? Boolean(light) : isLightMode();
  cardElement = elements.create('card', { style: cardStyleForMode(useLightColors) });
  cardElement.mount('#stripe-card-element');
}

// Called from the checkout button with the explicit current mode —
// no async detection, no race condition.
window.refreshCardStyle = function(light) {
  if (elements) mountCard(light);
};

async function initStripe() {
  if (stripe) return stripe;
  if (stripeInitPromise) return stripeInitPromise;
  stripeInitPromise = (async () => {
    if (typeof Stripe === 'undefined') throw new Error('Stripe.js is not loaded.');
    const publishableKey = await getCheckoutPublishableKey();
    stripe = Stripe(publishableKey);
    elements = stripe.elements();
    mountCard();
    return stripe;
  })().catch((error) => {
    stripeInitPromise = null;
    throw error;
  });
  return stripeInitPromise;
}

/* Paid with a wallet on the bag page. That page has no success screen and no
   purchase analytics — this one owns both — so it hands the order over and sends
   the customer here, cart still intact so the tracking has something to count. */
function consumeWalletOrderHandoff() {
  let order;
  try {
    const raw = sessionStorage.getItem('zw_wallet_order');
    if (!raw) return false;
    sessionStorage.removeItem('zw_wallet_order');
    order = JSON.parse(raw);
  } catch (_) { return false; }
  if (!order || !order.orderNumber) return false;
  showOrderConfirmed(order.orderNumber, order.email || '', order.paymentIntentId || '');
  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  // Before Stripe: the payment already happened, there is nothing left to mount.
  if (consumeWalletOrderHandoff()) return;
  initStripe()
    .then(() => {
      // The inline wallet init runs before Stripe is ready and no-ops; sync
      // here once stripe exists so the Apple Pay / Google Pay button actually
      // initializes — with the current promo-discounted total.
      if (typeof window.zwSyncWalletTotal === 'function') window.zwSyncWalletTotal();
    })
    .catch((error) => console.error('Stripe init failed:', error));
  refreshStripeCardTheme();
});

window.addEventListener('zw-theme-applied', refreshStripeCardTheme);

// ===================== HELPERS =====================

// Single reusable fetch helper
/* resp.json() on an HTML error page throws SyntaxError: Unexpected token '<',
   which surfaced to the shopper as "Something went wrong" and told nobody that
   the API had returned 500 with a Cloudflare error page. The parse failure
   replaced the real failure, so the console said the response was malformed
   JSON rather than that the endpoint was down.

   An /api/ route answering with HTML means the route did not match at all —
   a Functions build that did not deploy, not a bug in the handler. Worth
   distinguishing, because the two have completely different fixes. */
/* API-shaped failures a shopper can do nothing with: idempotency keys, rate
   tokens, API versions, internal identifiers. Matched on the vocabulary rather
   than on a list of codes, because the next one will be worded differently and
   the failure mode — integrator prose on a checkout screen — is the same. */
const INTERNAL_ERROR = /idempoten|api[_ ]key|api version|no such |signature|token|rate limit|invalid request/i;

async function postJSON(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* not JSON — handled below */ }

  if (data) {
    // A JSON error body is the handler talking. Let the caller read it.
    if (!resp.ok && !data.error) data.error = 'Request failed (' + resp.status + ')';
    /* …but not verbatim. Stripe's API errors are addressed to the integrator,
       not to someone trying to buy a jacket — "Keys for idempotent requests can
       only be used with the same parameters they were first used with. Try
       using a key other than 'pi_Fgs3…'" was reaching the checkout screen.
       It names an internal identifier, describes a mechanism the shopper has no
       access to, and suggests an action only we can take.

       The server-side detail is kept on the object for the console; only what
       is shown to a person is replaced. */
    if (!resp.ok && typeof data.error === 'string' && INTERNAL_ERROR.test(data.error)) {
      data.detail = data.error;
      data.error = 'We could not start that payment. Please try again — if it keeps happening, use a different payment method.';
    }
    return data;
  }

  /* No usable JSON. Say what actually happened rather than letting a parse
     error stand in for it — and name the likely cause, because "the payment
     service is unreachable" is actionable and "unexpected token <" is not. */
  const looksLikeHtml = /^\s*<(!doctype|html)/i.test(text || '');
  const err = new Error(
    looksLikeHtml
      ? 'The payment service is unreachable (' + resp.status + ' from ' + url + '). This usually means the API did not deploy.'
      : 'The payment service returned an unreadable response (' + resp.status + ').'
  );
  err.zwEndpoint = url;
  err.zwStatus = resp.status;
  err.zwBody = String(text || '').slice(0, 300);
  throw err;
}

/* The token the server will be asked to believe.
 *
 * A member's cart came to $35 on one load and $40 on the next. The storefront
 * decides membership by asking "is there a session object?" — a presence check
 * that an expired session still passes — while the server calls /auth/v1/user
 * and asks "is this token VALID?". Those are different questions, and they
 * disagree the moment an access token expires (Supabase issues them for about
 * an hour) while the cached session object lives on.
 *
 * It alternated rather than failing outright because the refresh is racing the
 * checkout: getSession() kicks off a renewal when the token is stale, but it
 * resolves with whatever it has. Win the race and the quote carries a fresh
 * token and member pricing; lose it and the same cart is quoted at full price.
 * Reloading re-ran the race, which is why the price appeared to be a coin toss.
 *
 * So this refuses to hand back a token the server would reject: anything
 * expired, or close enough to expiry that it may lapse in flight, is renewed
 * FIRST and the new one returned. A quote is worth a round trip — being quoted
 * the wrong price is worse than waiting for it. */
const TOKEN_SAFETY_WINDOW_S = 120;

async function getCheckoutAuthPayload() {
  const sb = window.sb || window._sb || null;
  /* No Supabase client on this page — checkout.html does not build one. That
     used to mean an empty token, so the payment request carried no proof of
     who the shopper was and the server priced them as a guest. A member was
     not merely SHOWN the wrong price, they were charged it.
     The stored token is the same credential the SDK would have handed over,
     read from the same place; it just cannot be refreshed without the SDK, so
     only a live one is used. */
  if (!sb?.auth?.getSession) {
    const stored = window.ZWStock && typeof ZWStock.storedAccessToken === 'function'
      ? ZWStock.storedAccessToken() : '';
    return { accessToken: stored };
  }

  const result = await sb.auth.getSession().catch(() => null);
  let session = result?.data?.session || null;

  /* A client that reports no session is NOT proof of a signed-out shopper.
     This codebase runs more than one Supabase client, and they do not all use
     the same storage key — so the one this page happens to hold can return
     null while a perfectly good session sits in localStorage under another
     key. That is the current split: the bag prices as a member, checkout as a
     guest, same browser, same second.

     So when the SDK comes back empty, look in storage before concluding
     anything. Only an unexpired token is used, and if there is genuinely none
     the answer is still "guest" — this only stops us throwing away a session
     we actually have. */
  if (!session?.access_token) {
    const stored = window.ZWStock && typeof ZWStock.storedAccessToken === 'function'
      ? ZWStock.storedAccessToken() : '';
    return { accessToken: stored };
  }

  /* expires_at is epoch SECONDS. Treating a missing value as "renew" is the
     safe reading: an unknown expiry we cannot check is exactly the case that
     has been silently costing members their discount. */
  const expiresAt = Number(session.expires_at) || 0;
  const secondsLeft = expiresAt ? expiresAt - Math.floor(Date.now() / 1000) : -1;

  if (secondsLeft < TOKEN_SAFETY_WINDOW_S && typeof sb.auth.refreshSession === 'function') {
    const refreshed = await sb.auth.refreshSession().catch(() => null);
    const next = refreshed?.data?.session || null;
    /* Keep the old token when the refresh fails. It is probably stale, so the
       server will price this as a guest — but that is the pre-existing
       behaviour, and dropping the token outright would guarantee it. */
    if (next?.access_token) session = next;
    else console.warn('[checkout] session refresh failed — pricing may fall back to guest rates');
  }

  return { accessToken: session.access_token || '' };
}

// ===================== LIVE CATALOG REPRICE =====================
// Cart items snapshot their price at add-to-bag time, so an admin price change
// left stale numbers in already-filled bags. Display-only inconsistency — the
// server always re-prices from the catalog at payment time — but the bag and
// the charge could disagree. On page load, pull the CURRENT catalog prices for
// everything in the cart, update the stored cart, and re-render whichever page
// (bag or checkout) we're on. Fails soft: any error leaves the cart untouched.
(function refreshCartCatalogPrices() {
  const SB_URL = 'https://qfgnrsifcwdubkolsgsq.supabase.co';
  const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';

  /* Does this visitor have a session the SERVER would accept?
   *
   * This used to return true if a key MATCHING sb-*-auth-token merely existed.
   * Not whether it held a session, not whether that session had expired —
   * whether the key was there. supabase-js writes that key when it initialises,
   * so a signed-out visitor had one, and so did anyone whose token lapsed.
   *
   * The consequence was not cosmetic. This function decides which price gets
   * written into the stored cart, so a guest had the MEMBER price ($35)
   * persisted into localStorage while the server correctly quoted the regular
   * one ($40). The header rendered the cart, the summary rendered the server,
   * and the two disagreed on the same screen. Because the rewrite is async, a
   * reload showed whichever won — the price looked random and survived
   * refreshes, because the wrong number had been SAVED.
   *
   * The server's test is "does /auth/v1/user accept this token". The closest
   * honest local answer is "is there a stored session whose token has not
   * expired", so that is what this asks now. Same rule as
   * getCheckoutAuthPayload above, so the two cannot disagree about who is a
   * member. */
  /* Returns the JSON text of a stored Supabase session, whatever wrapper it
     arrived in. Two shapes exist in the wild and a browser may hold either
     depending on which version last wrote it:
        {"access_token":...}            plain JSON
        base64-eyJhY2Nlc3NfdG9rZW4i...  base64url of that JSON
     Returns 'null' — valid JSON meaning "no session" — rather than throwing,
     so a shape we do not recognise is treated as signed out instead of
     crashing the price derivation. */
  function readStoredSession(raw) {
    const s = String(raw || '');
    if (!s) return 'null';
    if (!s.startsWith('base64-')) return s;
    let b64 = s.slice(7).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';                    // base64url drops padding
    try {
      const bin = atob(b64);
      /* The payload is UTF-8; atob yields bytes. Decoding them properly matters
         for anything non-ASCII in the profile (a name with an accent), which
         would otherwise corrupt the JSON and read as signed out. */
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch (_) { return 'null'; }
  }

  /* THE answer, once the server has given it. Everything below is a guess made
     while waiting for this.

     Five browser-side checks disagreed with the server on five different days,
     each for a different reason. The browser is simply not in a position to
     decide token validity, so it stops trying: /api/me runs verifyAccessToken —
     the same function that decides which price is CHARGED — and the result is
     cached here for every price derivation on the page.

     sessionStorage so a second page in the same tab starts with the right
     answer instead of guessing again. Not localStorage: this is per-session
     state and must not outlive signing out in another tab. */
  const MEMBER_CACHE_KEY = 'zw_member_verified';
  let verifiedMember = null;
  try {
    const cached = sessionStorage.getItem(MEMBER_CACHE_KEY);
    if (cached === '1') verifiedMember = true;
    else if (cached === '0') verifiedMember = false;
  } catch (_) {}

  async function confirmMembershipWithServer() {
    let token = '';
    try { token = (await getCheckoutAuthPayload()).accessToken || ''; } catch (_) {}
    try {
      const resp = await fetch('/api/me', {
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        cache: 'no-store',
      });
      if (!resp.ok) return;                       // leave the guess in place
      const data = await resp.json().catch(() => null);
      if (!data || typeof data.member !== 'boolean') return;

      const changed = verifiedMember !== data.member;
      verifiedMember = data.member;
      try { sessionStorage.setItem(MEMBER_CACHE_KEY, data.member ? '1' : '0'); } catch (_) {}
      /* Re-derive prices only when the server contradicted the guess —
         otherwise this is a no-op and the page must not flicker. */
      if (changed) { try { await run(); } catch (_) {} }
      try { if (typeof renderCart === 'function') renderCart(); } catch (_) {}
    } catch (_) { /* offline or blocked: the guess stands */ }
  }

  function isLoggedIn() {
    /* The server's answer wins whenever we have it. */
    if (verifiedMember !== null) return verifiedMember;
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (!/^(zuwera-auth|sb-.*-auth-token)$/.test(k || '')) continue;   // this site uses 'zuwera-auth'

        /* supabase-js stores this either as plain JSON or, since it started
           handling non-ASCII safely, as "base64-<base64url of the JSON>".
           Parsing only the first shape means a signed-in member reads as a
           guest — which is this bug: the bag showed the regular price while
           the server, which asks the real client, quoted the member one. */
        let session;
        try { session = JSON.parse(readStoredSession(localStorage.getItem(k))); } catch (_) { continue; }
        // Supabase has stored this both bare and wrapped over the years.
        const s = session && (session.access_token ? session : session.currentSession);
        if (!s || !s.access_token) continue;

        /* No expiry we can read means we cannot claim it is valid. The whole
           failure here was treating "cannot tell" as "yes". */
        const expiresAt = Number(s.expires_at) || 0;
        if (!expiresAt) continue;
        if (expiresAt - Math.floor(Date.now() / 1000) <= 0) continue;   // lapsed
        return true;
      }
    } catch (_) {}
    return false;
  }

  /* Published because the bag derives its own prices too, and had its own
     answer to "is this a member" (Boolean(_bagUser)). Two answers means the
     repricing writes one number and the bag's render writes another over it —
     which is how a guest kept seeing a member price that localStorage no longer
     contained. One function, one answer, both callers. */
  window.zwHasValidSession = isLoggedIn;

  async function run() {
    let cart;
    try { cart = JSON.parse(localStorage.getItem('cart') || '[]'); } catch (_) { return; }
    if (!Array.isArray(cart) || !cart.length) return;

    const ids = [...new Set(cart.map((i) => String(i.productId || '').trim())
      .filter((v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)))];
    const skus = [...new Set(cart.map((i) => String(i.sku || '').trim())
      .filter((v) => v && /^[\w-]+$/.test(v)))];
    if (!ids.length && !skus.length) return;

    const H = { apikey: SB_ANON, Authorization: 'Bearer ' + SB_ANON };
    const sel = 'select=id,sku,current_price,member_price';   // products has no bare `price` column
    const fetches = [];
    if (ids.length)  fetches.push(fetch(`${SB_URL}/rest/v1/products?${sel}&id=in.(${ids.join(',')})`, { headers: H }).then((r) => r.ok ? r.json() : []).catch(() => []));
    if (skus.length) fetches.push(fetch(`${SB_URL}/rest/v1/products?${sel}&sku=in.(${skus.join(',')})`, { headers: H }).then((r) => r.ok ? r.json() : []).catch(() => []));
    const rows = (await Promise.all(fetches)).flat();
    if (!rows.length) return;

    const byId  = new Map(rows.map((p) => [String(p.id), p]));
    const bySku = new Map(rows.filter((p) => p.sku).map((p) => [String(p.sku), p]));
    const member = isLoggedIn();

    let changed = false;
    for (const item of cart) {
      const p = byId.get(String(item.productId || '')) || bySku.get(String(item.sku || ''));
      if (!p) continue;   // product deleted — server rejects it at payment; leave display as-is
      const regular = parseFloat(p.current_price);
      const memberPrice = parseFloat(p.member_price);
      if (!(regular > 0)) continue;
      const next = (member && memberPrice > 0 && memberPrice < regular) ? memberPrice : regular;
      if (parseFloat(item.regularPrice) !== regular) { item.regularPrice = regular; changed = true; }
      if (memberPrice > 0 && parseFloat(item.memberPrice) !== memberPrice) { item.memberPrice = memberPrice; changed = true; }
      if (parseFloat(item.price) !== next) { item.price = String(next); changed = true; }
    }
    if (!changed) return;

    try { localStorage.setItem('cart', JSON.stringify(cart)); } catch (_) {}
    // Sync the in-memory array the pages render from (same objects the payment
    // call sends — mutate matching entries, don't swap the array).
    if (Array.isArray(window.cartItems)) {
      window.cartItems.forEach((it) => {
        const src = cart.find((c) =>
          String(c.productId || '') === String(it.productId || '') &&
          String(c.size || '') === String(it.size || '') &&
          String(c.colorName || '') === String(it.colorName || ''));
        if (src) { it.price = src.price; it.regularPrice = src.regularPrice; it.memberPrice = src.memberPrice; }
      });
    }
    // Re-render whichever page hosts us + downstream totals.
    try { if (typeof renderCart === 'function') renderCart(); } catch (_) {}
    try { if (typeof window._zwRenderCheckoutSummary === 'function') window._zwRenderCheckoutSummary(); } catch (_) {}
    try { if (typeof refreshTaxDisplay === 'function') refreshTaxDisplay(); } catch (_) {}
    try { if (typeof window.zwPromoUpdateSummaryTotals === 'function') window.zwPromoUpdateSummaryTotals(); } catch (_) {}
    try { if (typeof window.zwSyncWalletTotal === 'function') window.zwSyncWalletTotal(); } catch (_) {}
  }

  /* Price from the best guess immediately so the page is not blank, then ask
     the server and correct if it disagrees. The guess is only ever wrong for
     the length of one request, and the correction re-renders. */
  function start() {
    run().catch(() => {});
    confirmMembershipWithServer();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

// ── Cache payment DOM refs once ───────────────────────────────────
const _pay = {
  errEl:     document.getElementById('pay-error'),
  btnTxt:    document.getElementById('pay-btn-text'),
  btn:       document.getElementById('pay-submit'),
  zipInput:  document.getElementById('pay-zip'),
  stateInput: document.getElementById('pay-state'),
  ratesField:   document.getElementById('shipping-rates-field'),
  ratesLoading: document.getElementById('shipping-rates-loading'),
  ratesList:    document.getElementById('shipping-rates-list'),
  shippingEl:   document.getElementById('summary-shipping'),
  totalEl:      document.getElementById('summary-total'),
  taxEl:        document.getElementById('summary-tax'),
  prBtn:        document.getElementById('payment-request-btn'),
  expressBtn:   document.getElementById('express-checkout-btn'),
  divider:      document.getElementById('pay-divider'),
};

// ===================== APPLE PAY / GOOGLE PAY =====================
let paymentRequest    = null;
let prButtonEl        = null;
let selectedShippingRate = null;
let prTaxCents = 0;
let prShipCents = 0;

/* What the server will actually charge for shipping.

   The wallet sheet used to hardcode "Free Shipping" at $0 and a total of
   subtotal + tax. The server does not: resolveShipping in
   create-payment-intent charges the quoted rate whenever the order is under
   the free-shipping threshold. So below that threshold the sheet showed one
   number, the PaymentIntent was created for a larger one, and the customer was
   charged an amount they never agreed to — silently, because a wallet confirms
   against the intent rather than against what the sheet displayed.

   The product page, the homepage quick-buy and the mobile checkout all worked
   this out correctly already. This page — the main one — was the outlier.

   Mirrors resolveShipping exactly: free above the threshold on the PRE-discount
   subtotal, otherwise the quoted rate, falling back to the standard rate when
   no quote came back. */
function walletShipping() {
  const policy = window._shippingPolicy || { enabled: true, threshold: 100, standardRate: 8 };
  const subtotal = (window.cartItems || cartItems || [])
    .reduce((sum, i) => sum + parseFloat(i.price || 0) * (i.quantity || 1), 0);
  if (policy.enabled && subtotal >= policy.threshold) return { cents: 0, label: 'Free Shipping' };
  if (selectedShippingRate) {
    return {
      cents: Math.round(parseFloat(selectedShippingRate.amount || 0) * 100),
      label: String(selectedShippingRate.servicelevel || 'Standard Shipping'),
    };
  }
  return { cents: Math.round((policy.standardRate || 8) * 100), label: 'Standard Shipping' };
}
// Current sheet subtotal (after any promo discount). The shipping/tax event
// handlers read this instead of closing over initPaymentRequest's argument,
// so promo changes after init are reflected when the sheet recalculates.
let prSubtotalCents = 0;

/* Which wallet button to mount. The Payment Request Button below is the default;
   express-wallet.js is the opt-in replacement that can also show Apple Pay in
   Chrome, Edge and Firefox (by QR code) and draws every available wallet side by
   side instead of only one. See that file for why they differ. */
function initPaymentRequest(subtotalCents) {
  if (!stripe) return;
  prSubtotalCents = subtotalCents;
  if (!window.ZWExpressWallet) { initPaymentRequestButton(prSubtotalCents); return; }
  // Both paths are idempotent, so the repeat calls a promo apply/remove triggers
  // land as an amount update. They read prSubtotalCents rather than the captured
  // argument — the total can move again while the flag is still in flight.
  window.ZWExpressWallet.forPage('checkout').then((cfg) => {
    if (!stripe) return;
    // Switched off, or switched on but set to show only on the bag: this page
    // falls back to the older button rather than losing its wallet entirely.
    if (cfg.show) initExpressCheckout(prSubtotalCents, cfg.maxColumns);
    else initPaymentRequestButton(prSubtotalCents);
  });
}

function initPaymentRequestButton(subtotalCents) {
  prSubtotalCents = subtotalCents;
  // If a paymentRequest already exists (user opened checkout a second time,
  // or a promo was applied/removed), update the amount instead of creating a
  // duplicate button.
  if (paymentRequest) {
    paymentRequest.update({
      total: { label: 'Zuwera', amount: subtotalCents, pending: true },
    });
    return;
  }

  paymentRequest = stripe.paymentRequest({
    country: 'US',
    currency: 'usd',
    total: { label: 'Zuwera', amount: subtotalCents, pending: true },
    requestPayerName: true,
    requestPayerEmail: true,
    requestShipping: true,
    shippingOptions: [],
  });

  paymentRequest.on('shippingaddresschange', async (ev) => {
    const addr = ev.shippingAddress;
    try {
      const data = await postJSON('/api/shippo-rates', {
        items: cartItems,
        totalWeightLb: cartItems.reduce((s, i) => s + ((parseFloat(i.weightLb) || 0.5) * (i.quantity || 1)), 0),
        address: {
          name: '',
          line1: addr.addressLine?.[0] || '',
          city: addr.city, state: addr.region,
          zip: addr.postalCode, country: addr.country,
        },
      });
      // The curated rate, not raw rates[0]: that can be a restricted service.
      if (data.rates?.length) selectedShippingRate = pickShippingRate(data.rates) || data.rates[0];
      /* Wait for the tax quote before pricing the sheet. A wallet confirms
         against the total shown HERE — the customer never sees the amount the
         PaymentIntent is created for — so a tax figure that is still resolving
         becomes an amount they agreed to without being shown it. We are already
         awaiting shipping rates in this handler, so it costs no extra wait in
         practice; the quote is usually cached by now anyway. */
      if (window.ZWCheckoutTax) {
        await window.ZWCheckoutTax.ensure(addr.region || '', addr.postalCode || '', prSubtotalCents);
        prTaxCents = window.ZWCheckoutTax.taxCents(prSubtotalCents, addr.region || '', addr.postalCode || '');
      } else {
        prTaxCents = 0;
      }
      const ship = walletShipping();
      prShipCents = ship.cents;
      ev.updateWith({
        status: 'success',
        shippingOptions: [{
          id: 'standard',
          label: ship.cents ? ship.label : 'Free Shipping',
          detail: ship.cents ? 'Est. 5-7 business days' : 'Standard delivery',
          amount: ship.cents,
        }],
        total: { label: 'Zuwera', amount: prSubtotalCents + prTaxCents + ship.cents },
      });
    } catch { ev.updateWith({ status: 'fail' }); }
  });

  paymentRequest.on('shippingoptionchange', (ev) => {
    // One option is ever offered, so there is nothing to recalculate — but the
    // event still has to be answered or the sheet sits there spinning.
    ev.updateWith({
      status: 'success',
      total: { label: 'Zuwera', amount: prSubtotalCents + prTaxCents + prShipCents },
    });
  });

  paymentRequest.on('paymentmethod', async (ev) => {
    try {
      const addr = ev.shippingAddress || {};
      const auth = await getCheckoutAuthPayload();
      const piData = await postJSON('/api/create-payment-intent', {
        items: cartItems,
        shippingRate: selectedShippingRate,
        promoCode: window.zwGetActivePromoCode?.() || '',
        accessToken: auth.accessToken,
        address: {
          name: ev.payerName || '', email: ev.payerEmail || '',
          line1: addr.addressLine?.[0] || '', line2: addr.addressLine?.[1] || '',
          city: addr.city || '', state: addr.region || '',
          zip: addr.postalCode || '', country: addr.country || 'US',
        },
      });
      if (piData.error) { ev.complete('fail'); return; }
      const initialResult = await stripe.confirmCardPayment(
        piData.clientSecret,
        { payment_method: ev.paymentMethod.id },
        { handleActions: false }
      );
      if (initialResult.error) {
        ev.complete('fail');
        _pay.errEl.textContent = declineMessage(initialResult.error);
        return;
      }

      let finalIntent = initialResult.paymentIntent;
      if (finalIntent?.status === 'requires_action') {
        const actionResult = await stripe.confirmCardPayment(piData.clientSecret);
        if (actionResult.error) {
          ev.complete('fail');
          _pay.errEl.textContent = declineMessage(actionResult.error);
          return;
        }
        finalIntent = actionResult.paymentIntent;
      }

      const successStatuses = ['succeeded', 'processing', 'requires_capture'];
      if (!finalIntent || !successStatuses.includes(finalIntent.status)) {
        ev.complete('fail');
        _pay.errEl.textContent = `Payment is ${finalIntent?.status || 'incomplete'}. Please try again.`;
        return;
      }

      ev.complete('success');
      showOrderConfirmed(piData.orderNumber, ev.payerEmail, finalIntent?.id || '');
    } catch (err) {
      ev.complete('fail');
      console.error('Payment request error:', err);
    }
  });

  prButtonEl = elements.create('paymentRequestButton', {
    paymentRequest,
    // theme follows the page so the button always contrasts: on the light/super-light
    // checkout a 'light' button was white-on-white and invisible.
    style: { paymentRequestButton: { type: 'buy', theme: document.body.classList.contains('light-mode') ? 'dark' : 'light', height: '48px' } },
  });
  paymentRequest.canMakePayment().then(result => {
    if (result) {
      prButtonEl.mount('#payment-request-btn');
      _pay.prBtn.style.display  = 'block';
      _pay.divider.style.display = 'block';
    }
  }).catch(err => console.warn('Apple/Google Pay unavailable:', err));
}

// ===================== EXPRESS CHECKOUT (APPLE PAY QR) =====================
// The opt-in wallet path, wired to the shared module. Same order, same server,
// same emails — the only thing that changes is which Stripe element draws the
// button, and that element is the one Apple Pay can reach from a browser that
// is not Safari.
let expressWallet = null;

function initExpressCheckout(subtotalCents, maxColumns) {
  prSubtotalCents = subtotalCents;
  if (expressWallet) { expressWallet.update(subtotalCents); return; }   // promo moved the total
  expressWallet = window.ZWExpressWallet.mount({
    stripe,
    container: '#express-checkout-btn',
    subtotalCents,
    maxColumns,
    getItems: () => cartItems,
    getPromoCode: () => window.zwGetActivePromoCode?.() || '',
    getAccessToken: () => getCheckoutAuthPayload().then((a) => a.accessToken),
    onReady: (available) => {
      if (!available) return;   // no wallet here — leave the card form to stand alone
      _pay.expressBtn.style.display = 'block';
      _pay.expressBtn.setAttribute('aria-hidden', 'false');
      _pay.divider.style.display = 'block';
    },
    onError: (message) => { if (_pay.errEl) _pay.errEl.textContent = message; },
    onSuccess: ({ orderNumber, email, paymentIntentId }) => showOrderConfirmed(orderNumber, email, paymentIntentId),
  });
}

// ===================== LIVE SHIPPING RATES =====================
let ratesFetchTimeout = null;
let ratesFetchPromise = null;

async function doFetchRates(zip, state) {
  const totalWeightLb = cartItems.reduce((s, i) => s + ((parseFloat(i.weightLb) || 0.5) * (i.quantity || 1)), 0);
  const data = await postJSON('/api/shippo-rates', {
    items: cartItems,
    totalWeightLb,
    address: {
      name:  document.getElementById('pay-name').value.trim(),
      line1: document.getElementById('pay-addr1').value.trim(),
      city:  document.getElementById('pay-city').value.trim(),
      state, zip, country: 'US',
    },
  });
  const subtotal = cartItems.reduce((s, i) => s + parseFloat(i.price) * i.quantity, 0);
  const policy   = window._shippingPolicy || { enabled: true, threshold: 100, standardRate: 8 };
  const qualifiesFree = policy.enabled && subtotal >= policy.threshold;

  if (data.rates?.length) {
    // Keep the rate stored even during hand-delivery (harmless — the server
    // ignores it for eligible hand-delivery orders, and it's ready if the
    // shopper switches back to mail). Use the curated pick, NOT raw rates[0]
    // — the raw cheapest can be a restricted service (Media Mail).
    selectedShippingRate = pickShippingRate(data.rates) || data.rates[0];
  } else if (data.error) {
    console.error('Shippo rates error:', data.error);
  }

  // RACE GUARD: this fetch was debounced ~600ms + network, so the shopper may
  // have picked "Campus hand-delivery — Free" while it was in flight. A late
  // resolution must never overwrite the $0 summary with a mail rate (it made
  // hand-delivery orders DISPLAY a shipping charge).
  if (_deliveryMethod === 'hand_delivery') { updateCartSummaryShipping(0); return; }

  if (data.rates?.length) {
    // A picker appears ONLY when the admin pinned multiple services (the
    // server flags that with pinned:true). Auto/cheapest mode and single pins
    // stay a silent single option. Free-shipping orders never show it — the
    // customer pays $0 either way, and an open picker would let them choose an
    // expensive express label the store eats.
    const usableRates = usableShippingRates(data.rates);
    if (data.pinned && usableRates.length > 1 && !qualifiesFree) {
      // Default = the first pinned option (admin's order), matching the
      // pre-checked radio — not the USPS-first pick used in silent mode.
      selectedShippingRate = usableRates[0];
      renderPinnedRateChoices(usableRates);
    } else if (_pay.ratesField) {
      _pay.ratesField.style.display = 'none';
    }
    updateCartSummaryShipping(qualifiesFree ? 0 : parseFloat(selectedShippingRate.amount));
  } else if (!qualifiesFree) {
    // Show standard fallback rate so the customer knows what they'll pay
    updateCartSummaryShipping(policy.standardRate || 8);
  }
}

// ── Shipping options ───────────────────────────────────────────────
// The admin Shipping page decides what checkout offers
// (site_settings.shipping_preferred_service, enforced server-side): automatic
// cheapest (single, silent), one pinned service (single, silent), or several
// pinned services (radio choice, first = default). The restricted-service
// exclusion stays as belt-and-suspenders: apparel can't ship on printed-matter
// services, and "tender to carrier" rates need a facility drop-off.
function usableShippingRates(rates) {
  return (rates || []).filter((r) => !/media mail|bound printed|library mail|tender to/i.test(String(r.servicelevel || '')));
}
function pickShippingRate(rates) {
  const usable = usableShippingRates(rates);
  const usps = usable.filter((r) => String(r.provider || '').toUpperCase() === 'USPS');
  const pool = usps.length ? usps : usable;  // safety: never lose checkout if USPS is missing
  return pool[0] || null;                    // server sorts USPS-first, then cheapest
}
function _escRate(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function renderPinnedRateChoices(options) {
  if (!_pay.ratesField || !_pay.ratesList) return;
  _pay.ratesList.innerHTML = options.map((r, i) => {
    // ETA only when the provider returned one (Veeqo quotes often don't).
    const eta = r.days ? ` · ${Number(r.days) === 1 ? 'next day' : r.days + ' days'}` : '';
    const carrier = String(r.provider || '');
    let service = String(r.servicelevel || 'Shipping');
    if (!service.toUpperCase().startsWith(carrier.toUpperCase())) service = (carrier + ' ' + service).trim();
    return `
      <label class="zw-rate-opt" style="display:flex;align-items:center;gap:.6rem;padding:.62rem .8rem;border:1px solid rgba(128,128,128,.35);cursor:pointer;font-size:.85rem;${i > 0 ? 'border-top:none;' : ''}">
        <input type="radio" name="shipping-rate-choice" value="${i}" ${i === 0 ? 'checked' : ''} style="margin:0;flex-shrink:0;">
        <span style="flex:1;min-width:0;">${_escRate(service)}<span style="opacity:.55;">${eta}</span></span>
        <span style="font-weight:700;white-space:nowrap;">$${parseFloat(r.amount).toFixed(2)}</span>
      </label>`;
  }).join('');
  _pay.ratesField.style.display = 'block';

  _pay.ratesList.querySelectorAll('input[name="shipping-rate-choice"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const rate = options[parseInt(radio.value, 10)];
      if (!rate) return;
      selectedShippingRate = rate;
      if (_deliveryMethod !== 'hand_delivery') updateCartSummaryShipping(parseFloat(rate.amount));
    });
  });
}

// 'ship' (mail, default) or 'hand_delivery' (free in-person campus delivery).
let _deliveryMethod = 'ship';
window.zwDeliveryMethod = () => _deliveryMethod;

function maybeLoadRates() {
  // Hand-delivery is free and needs no shipping rate — never fetch/overwrite it.
  if (_deliveryMethod === 'hand_delivery') { updateCartSummaryShipping(0); return; }
  const zip   = (_pay.zipInput?.value   || '').trim();
  const state = (_pay.stateInput?.value || '').trim();
  if (zip.length < 5 || state.length < 2) return;

  clearTimeout(ratesFetchTimeout);
  ratesFetchTimeout = setTimeout(() => {
    if (_pay.ratesField)   _pay.ratesField.style.display   = 'none';
    // No loading text — the rate fetch is sub-second; just show nothing until it resolves.
    ratesFetchPromise = doFetchRates(zip, state).catch(err => {
      console.error('Rate fetch error:', err);
      // Same race guard as the success path: never overwrite a hand-delivery $0.
      if (_deliveryMethod === 'hand_delivery') { updateCartSummaryShipping(0); return; }
      // Show fallback rate so user isn't stuck with no shipping option
      const fallback = (window._shippingPolicy?.standardRate) || 8;
      updateCartSummaryShipping(fallback);
      // Write into the inner list, NOT the field — replacing the field's HTML
      // would destroy the #shipping-rates-list node the picker renders into.
      if (_pay.ratesField && _pay.ratesList) {
        _pay.ratesField.style.display = 'block';
        _pay.ratesList.innerHTML = `<p style="font-size:.78rem;color:rgba(244,241,235,.5);margin:.4rem 0">Standard shipping: $${fallback.toFixed(2)}</p>`;
      }
    }).finally(() => {
      if (_pay.ratesLoading) _pay.ratesLoading.style.display = 'none';
      ratesFetchPromise = null;
    });
  }, 600);
}

function updateCartSummaryShipping(amount) {
  const dollarAmt = Number(amount) || 0;
  const shippingText = dollarAmt > 0 ? `$${dollarAmt.toFixed(2)}` : 'Free';
  if (_pay.shippingEl) {
    _pay.shippingEl.textContent = shippingText;
    _pay.shippingEl.classList.remove('dash');
  }
  if (_pay.totalEl) {
    const parse = el => parseFloat(el?.textContent?.replace(/[^0-9.]/g, '') || '0');
    _pay.totalEl.textContent = `$${(parse(document.getElementById('pm-subtotal')) + parse(_pay.taxEl) + dollarAmt).toFixed(2)}`;
    _pay.totalEl.classList.remove('dash');
  }
  // Keep payment modal summary in sync
  const pmShipping = document.getElementById('pm-shipping');
  const pmTotal    = document.getElementById('pm-total');
  const pmToggle   = document.getElementById('pm-toggle-total');
  if (pmShipping) pmShipping.textContent = shippingText;
  if (pmTotal || pmToggle) {
    const parse = el => parseFloat(el?.textContent?.replace(/[^0-9.]/g, '') || '0');
    const tot = `$${(parse(document.getElementById('pm-subtotal')) + parse(document.getElementById('pm-tax')) + dollarAmt).toFixed(2)}`;
    if (pmTotal)  pmTotal.textContent  = tot;
    if (pmToggle) pmToggle.textContent = tot;
  }
  // Re-apply any active promo so shipping changes don't drop the discount.
  try { if (typeof window.zwPromoUpdateSummaryTotals === 'function') window.zwPromoUpdateSummaryTotals(); } catch (_) {}
}

function refreshTaxDisplay() {
  if (!window.ZWCheckoutTax) return;
  const parse = el => parseFloat(el?.textContent?.replace(/[^0-9.]/g, '') || '0');
  const subtotal = parse(document.getElementById('pm-subtotal'));
  if (!subtotal) return;
  const state = (_pay.stateInput?.value || '').trim().toUpperCase().slice(0, 2);
  const zip   = (_pay.zipInput?.value   || '').trim();

  /* Ask the server, and render what it has actually said. `known` is the whole
     point: it separates "Oregon charges no sales tax" from "we have not been
     told yet", which the old code could not tell apart because it always had a
     table to answer from — including when the table was wrong. Unknown shows a
     dash and leaves it out of the total, exactly as an unentered state already
     did, and the zw:tax listener below re-renders the moment an answer lands. */
  window.ZWCheckoutTax.ensure(state, zip, Math.round(subtotal * 100));
  const known = window.ZWCheckoutTax.isKnown(state, zip);
  const tax = known ? window.ZWCheckoutTax.taxDollars(subtotal, state, zip) : 0;
  const taxText = known ? `$${tax.toFixed(2)}` : '—';
  const total = subtotal + tax;

  // Update cart sidebar elements (kept in sync even though hidden behind modal)
  if (_pay.taxEl) _pay.taxEl.textContent = taxText;
  if (_pay.totalEl) _pay.totalEl.textContent = `$${total.toFixed(2)}`;

  // Update payment modal order summary panel
  const pmTax        = document.getElementById('pm-tax');
  const pmTaxLbl     = document.getElementById('pm-tax-label');
  const pmTotal      = document.getElementById('pm-total');
  const pmToggleTot  = document.getElementById('pm-toggle-total');
  const pmSubtotal   = document.getElementById('pm-subtotal');
  if (pmSubtotal)   pmSubtotal.textContent   = `$${subtotal.toFixed(2)}`;
  if (pmTax)        pmTax.textContent        = taxText;
  /* The state the tax is FOR, which before an address is typed is the one the
     server worked out from the connection — not the empty input field. */
  if (pmTaxLbl) {
    const forState = window.ZWCheckoutTax.stateFor(state, zip);
    pmTaxLbl.textContent = known && forState ? `Tax (${forState})` : 'Tax';
  }
  if (pmTotal)      pmTotal.textContent      = `$${total.toFixed(2)}`;
  if (pmToggleTot)  pmToggleTot.textContent  = `$${total.toFixed(2)}`;
  // We just wrote an undiscounted total; re-apply any active promo so the discount
  // isn't wiped from the shown total when tax recomputes (e.g. on address entry).
  try { if (typeof window.zwPromoUpdateSummaryTotals === 'function') window.zwPromoUpdateSummaryTotals(); } catch (_) {}
}

_pay.zipInput?.addEventListener('input', () => { updateDeliveryOptions(); maybeLoadRates(); if ((_pay.zipInput?.value || '').length >= 5) refreshTaxDisplay(); });
_pay.stateInput?.addEventListener('input', () => { maybeLoadRates(); refreshTaxDisplay(); });

/* The quote arrives after the summary has already been drawn, so the summary
   has to be told. Without this the tax line renders '—' once and stays there. */
window.addEventListener('zw:tax', () => refreshTaxDisplay());

// ===================== CAMPUS HAND-DELIVERY =====================
// Reveal a free in-person delivery option when the ZIP is on the admin-managed
// allow-list (config comes from /api/commerce-config via commerce-checkout.js).
function _localDeliveryConfig() {
  try {
    const cfg = (typeof window.zwLocalDelivery === 'function') ? window.zwLocalDelivery() : null;
    return (cfg && typeof cfg === 'object') ? cfg : { enabled: false, zips: [] };
  } catch (_) { return { enabled: false, zips: [] }; }
}
function _zipEligibleForHandDelivery() {
  const cfg = _localDeliveryConfig();
  const zip = (_pay.zipInput?.value || '').trim().slice(0, 5);
  return !!(cfg.enabled && Array.isArray(cfg.zips) && cfg.zips.includes(zip));
}
function updateDeliveryOptions() {
  const field = document.getElementById('delivery-method-field');
  if (!field) return;
  const cfg = _localDeliveryConfig();
  if (!_zipEligibleForHandDelivery()) {
    field.style.display = 'none';
    if (_deliveryMethod === 'hand_delivery') {        // ZIP changed to an ineligible one
      _deliveryMethod = 'ship';
      const shipRadio = field.querySelector('input[value="ship"]');
      if (shipRadio) shipRadio.checked = true;
      _syncDeliverySelected();
      const note = document.getElementById('delivery-hand-note');
      if (note) note.style.display = 'none';
      maybeLoadRates();
    }
    return;
  }
  field.style.display = 'block';
  const lbl = document.getElementById('delivery-hand-label');
  if (lbl) lbl.textContent = (cfg.label || 'Campus hand-delivery') + ' — Free';
  _syncDeliverySelected();
}
function _syncDeliverySelected() {
  document.querySelectorAll('.co-delivery-opt').forEach((opt) => {
    const r = opt.querySelector('input[name="delivery-method"]');
    opt.classList.toggle('is-selected', !!(r && r.checked));
  });
}
function _onDeliveryMethodChange(e) {
  const val = e.target.value === 'hand_delivery' ? 'hand_delivery' : 'ship';
  _deliveryMethod = val;
  _syncDeliverySelected();
  const note = document.getElementById('delivery-hand-note');
  const cfg = _localDeliveryConfig();
  if (val === 'hand_delivery') {
    if (note) {
      note.textContent = cfg.instructions || "You'll be contacted to arrange a campus drop-off. No package will be mailed.";
      note.style.display = 'block';
    }
    if (_pay.ratesField) _pay.ratesField.style.display = 'none';  // no mail options needed
    updateCartSummaryShipping(0);                     // free
  } else {
    if (note) note.style.display = 'none';
    maybeLoadRates();                                 // recompute mail shipping
  }
}
document.querySelectorAll('input[name="delivery-method"]').forEach((r) => r.addEventListener('change', _onDeliveryMethodChange));
// Re-check once the commerce config has had time to load (covers autocompleted ZIPs).
setTimeout(updateDeliveryOptions, 1500);

// ===================== PAYMENT MODAL CLOSE =====================
document.getElementById('payment-close')?.addEventListener('click', () => {
  _closeModal('payment-modal');
  if (_pay.errEl) _pay.errEl.textContent = '';
});
document.getElementById('payment-modal')?.addEventListener('click', e => {
  if (e.target === e.currentTarget) _closeModal('payment-modal');
});

// ===================== PAY SUBMIT (CARD) =====================
_pay.btn?.addEventListener('click', async () => {
  const get   = id => (document.getElementById(id)?.value || '').trim();
  const name  = get('pay-name');
  const email = get('pay-email');
  const addr1 = get('pay-addr1');
  const addr2 = get('pay-addr2');
  const city  = get('pay-city');
  const state = (_pay.stateInput?.value || '').trim();
  const zip   = (_pay.zipInput?.value   || '').trim();

  if (_pay.errEl) _pay.errEl.textContent = '';
  if (!name || !email)                   { if (_pay.errEl) _pay.errEl.textContent = 'Please enter your name and email.'; return; }
  if (!addr1 || !city || !state || !zip) { if (_pay.errEl) _pay.errEl.textContent = 'Please enter your full shipping address.'; return; }

  _pay.btn.disabled = true;
  _pay.btnTxt.textContent = 'Processing…';

  try {
    // If the debounced rate fetch hasn't fired or finished yet, resolve it now
    // before creating the payment intent so the correct Shippo rate is used.
    if (!selectedShippingRate && zip.length >= 5 && state.length >= 2) {
      clearTimeout(ratesFetchTimeout);
      if (ratesFetchPromise) {
        await ratesFetchPromise;
      } else {
        try { await doFetchRates(zip, state); } catch (_) {}
      }
    }

    const auth = await getCheckoutAuthPayload();
    const piData = await postJSON('/api/create-payment-intent', {
      items: cartItems,
      shippingRate: selectedShippingRate,
      promoCode: window.zwGetActivePromoCode?.() || '',
      accessToken: auth.accessToken,
      address: { name, email, line1: addr1, line2: addr2, city, state, zip, country: 'US' },
    });
    if (piData.error) {
      _pay.errEl.textContent = piData.error;
      _pay.btn.disabled = false;
      _pay.btnTxt.textContent = 'Pay Now';
      return;
    }

    /* No `shipping` here. The server sets it on the PaymentIntent when it
       creates it, using the secret key — and Stripe then refuses to let a
       publishable key change it: "The shipping information on this
       PaymentIntent was last set with a secret key and therefore cannot be
       changed with a publishable key."

       That is the correct behaviour on Stripe's part and the right place for
       the address to be set. The browser sends the address to
       /api/create-payment-intent, which is where it becomes the shipping
       record; repeating it here only re-sends the same values from the weaker
       key and breaks the confirm. */
    const { error, paymentIntent } = await stripe.confirmCardPayment(piData.clientSecret, {
      payment_method: { card: cardElement, billing_details: { name, email } },
      receipt_email: email,
    });
    if (error) {
      console.error('Stripe confirmCardPayment error:', error);
      _pay.errEl.textContent = declineMessage(error);
      _pay.btn.disabled = false;
      _pay.btnTxt.textContent = 'Pay Now';
      return;
    }

    showOrderConfirmed(piData.orderNumber, email, paymentIntent?.id || '');
  } catch (err) {
    /* This swallowed everything. A card decline that arrives as a THROWN error
       rather than a returned one — which is what happens when the failure is
       raised anywhere other than confirmCardPayment's resolved value — landed
       here and became "Something went wrong", identical for every cause. Which
       is exactly the bug the decline copy above was written to fix, reappearing
       one level out.

       Same mapping, so a Stripe error carries its real reason whichever way it
       reaches us, and only a genuinely non-Stripe failure falls through. */
    _pay.errEl.textContent =
      (err && (err.decline_code || err.code || err.type)) ? declineMessage(err)
      /* postJSON throws with a message that already says what failed. Replacing
         it with "Something went wrong" is how the 500 stayed invisible. */
      : (err && err.zwEndpoint && err.message) ? err.message
      : 'Something went wrong. Please try again.';
    /* Kept, and now the only place the raw error is visible: if the message on
       screen is the generic one, this line says why. */
    console.error('Checkout error:', err);
    _pay.btn.disabled = false;
    _pay.btnTxt.textContent = 'Pay Now';
  }
});

// ===================== ORDER CONFIRMED =====================
function showOrderConfirmed(orderNumber, email, paymentIntentId) {
  document.getElementById('success-order').textContent = orderNumber ? `Order #${orderNumber}` : '';
  document.getElementById('success-msg').textContent =
    `Thank you for your purchase. A confirmation has been sent to ${email || 'your email'}.`;
  _openModal('payment-success');

  // Someone who just checked out has given us their address. The signup popup
  // shouldn't greet them with "join the list for 10% off your first order" on
  // the next page they open.
  if (email && window.ZWEmailPopup && window.ZWEmailPopup.markKnown) window.ZWEmailPopup.markKnown();

  const _purchaseTotal = cartItems.reduce((s, i) => s + (parseFloat(i.price) * i.quantity), 0);

  if (typeof gtag === 'function') {
    // Enhanced Conversions: hand the Google tag the customer email (unhashed —
    // the tag SHA-256 hashes it client-side before sending). Lifts Google Ads
    // match rates, the equivalent of Meta's CAPI advanced matching. Inert until
    // Enhanced Conversions is switched on in the Google Ads conversion settings.
    if (email) gtag('set', 'user_data', { email: email });
    gtag('event', 'purchase', {
      transaction_id: paymentIntentId,
      value: _purchaseTotal,
      currency: 'USD',
      items: cartItems.map(item => ({
        item_id: item.productId,
        item_name: item.title,
        price: item.price,
        quantity: item.quantity
      }))
    });
  }

  if (typeof zwTrack === 'function') {
    zwTrack('purchase_completed', {
      order_id:   paymentIntentId,
      value:      _purchaseTotal,
      currency:   'USD',
      item_count: cartItems.reduce((n, i) => n + i.quantity, 0),
      items:      cartItems.map(i => ({
        product_id:   i.productId,
        product_name: i.title,
        price:        i.price,
        quantity:     i.quantity,
        size:         i.size  || '',
      })),
    });
  }

  if (window.zwPixel) window.zwPixel.purchase(cartItems, _purchaseTotal, paymentIntentId);

  // Clear cart from storage and update header count
  cartItems = [];
  localStorage.removeItem('cart');
  const _bagCountEl = document.getElementById('co-bag-count');
  if (_bagCountEl) _bagCountEl.textContent = '0';
}

document.getElementById('success-continue')?.addEventListener('click', () => {
  window.location.href = '/';
});

// Countdown is handled by the inline script in index.html
// to avoid two intervals racing on the same DOM elements.

// ===================== DROP 001 NOTIFY =====================
async function homeNotifyMe() {
  const emailInput = document.getElementById('home-notify-email');
  const email = emailInput.value.trim();
  if (!email || !email.includes('@')) { emailInput.style.borderColor = '#e07060'; return; }
  emailInput.style.borderColor = '';
  if (_sb) {
    try { await _sb.from('waitlist').upsert({ email, source: 'drop001_home' }); }
    catch { /* silently ignore */ }
  }
  document.querySelector('.notify-form-inline').style.display = 'none';
  document.querySelector('.notify-note').style.display = 'none';
  document.getElementById('home-notify-success').style.display = 'block';
}

/* ── Abandoned-cart capture ──────────────────────────────────────────────────
   When the shopper enters their email at checkout, remember their email + cart so
   /api/abandoned-cart can trigger a recovery email if they don't complete. Purely
   additive + fire-and-forget — it never touches or blocks the payment flow. */
(function () {
  function attach() {
    var el = document.getElementById('pay-email');
    if (!el || el.dataset.zwAcHooked) return;
    el.dataset.zwAcHooked = '1';
    var last = '';
    el.addEventListener('blur', function () {
      var email = (el.value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
      var cart; try { cart = JSON.parse(localStorage.getItem('cart') || '[]'); } catch (_) { cart = []; }
      if (!Array.isArray(cart) || !cart.length) return;
      var sig = email + '|' + cart.length;
      if (sig === last) return; last = sig;
      try {
        fetch('/api/abandoned-cart', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
          body: JSON.stringify({ email: email, cart: cart })
        }).catch(function () {});
      } catch (_) {}
    });
  }
  if (document.readyState !== 'loading') attach();
  else document.addEventListener('DOMContentLoaded', attach);
})();
