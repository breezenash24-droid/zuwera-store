/* ────────────────────────────────────────────────────────────────────────────
   checkout-tax.js — what the shopper is told the tax will be.

   This file used to contain a rate table: fifty state rates, eighty-eight Ohio
   counties, thirty Illinois ZIP prefixes. It computed tax itself and nothing
   ever asked the server whether it agreed.

   It didn't. A cart displayed at $93.75 was charged $94.39, because this table
   said Hamilton County was 7.0% and the tax engine the store had configured
   said 7.8%. The table could not have known it was wrong — it had no idea the
   engine setting existed. Editing the number would have fixed that one ZIP and
   left every other jurisdiction free to drift again, so the table is gone
   rather than corrected.

   Tax is now asked for, at /api/tax-quote, which calls the same resolveTax()
   the payment path calls. One answerer. If the figure is wrong it is now wrong
   in both places by the same amount, which is a bug that can be found.

   The awkward part, handled below: the answer arrives over the network, and six
   call sites across the storefront call taxCents() synchronously in the middle
   of rendering a summary. So the reads stay synchronous and answer from cache,
   asking in the background on a miss and announcing the answer with a `zw:tax`
   event when it lands. Anything showing tax listens for that and re-renders.

   Until an answer arrives the tax is not known, and isKnown() says so. Callers
   are expected to show a pending line rather than a number, because the whole
   point of deleting the table was to stop displaying figures nobody is going to
   honour. "Don't know yet" is true; a confident wrong total is not.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var STATE_NAME_TO_CODE = {
    ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
    COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA',
    HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA',
    KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD',
    MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO',
    MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ',
    'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND',
    OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI',
    'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT',
    VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI',
    WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC',
  };

  /* Names, not rates. Turning "Ohio" into "OH" is spelling, and spelling cannot
     drift away from the server the way money can. */
  function normalizeStateCode(value) {
    var upper = String(value == null ? '' : value).trim().toUpperCase().replace(/\./g, '');
    if (upper.length === 2) return upper;
    return STATE_NAME_TO_CODE[upper] || '';
  }

  /* A ZIP only counts once it is all five digits. Half-typed ones are not a
     different jurisdiction, they are the same one not finished being entered —
     and treating them as distinct meant "45202" asked five times and cached
     five answers on the way in. Below five digits we ask about the state, which
     is exactly what we knew before the ZIP started. */
  function zip5(value) {
    var digits = String(value == null ? '' : value).replace(/\D/g, '');
    return digits.length >= 5 ? digits.slice(0, 5) : '';
  }

  function key(state, zip) {
    return normalizeStateCode(state) + '|' + zip5(zip);
  }

  /* ── The cache ────────────────────────────────────────────────────────────
     Rates for the session, keyed by jurisdiction. Kept in sessionStorage as
     well as memory so moving bag → checkout doesn't re-ask and re-flicker; a
     rate is a public figure about a ZIP code, so there is nothing here worth
     protecting. Deliberately NOT localStorage: a stale rate surviving for weeks
     is the failure this file was written to end. */
  var STORE_KEY = 'zw_tax_rates_v1';
  var TTL_MS = 60 * 60 * 1000;   // an hour; rates move quarterly at most

  var rates = {};
  try {
    var saved = JSON.parse(window.sessionStorage.getItem(STORE_KEY) || '{}');
    if (saved && typeof saved === 'object') rates = saved;
  } catch (_) {}

  function persist() {
    try { window.sessionStorage.setItem(STORE_KEY, JSON.stringify(rates)); } catch (_) {}
  }

  function cached(state, zip) {
    var hit = rates[key(state, zip)];
    if (!hit) return null;
    if (Date.now() - (hit.at || 0) > TTL_MS) return null;
    return hit;
  }

  /* ── Asking ───────────────────────────────────────────────────────────────
     One request in flight per jurisdiction. Six call sites all rendering the
     same summary must not become six identical fetches. */
  var inFlight = {};

  function ask(state, zip, amountCents) {
    var k = key(state, zip);
    if (inFlight[k]) return inFlight[k];

    var params = [];
    if (normalizeStateCode(state)) params.push('state=' + encodeURIComponent(normalizeStateCode(state)));
    if (zip5(zip)) params.push('zip=' + encodeURIComponent(zip5(zip)));
    if (amountCents > 0) params.push('amount=' + Math.round(amountCents));

    inFlight[k] = fetch('/api/tax-quote?' + params.join('&'), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || data.unavailable) return null;
        var rate = Number(data.rate);
        if (!isFinite(rate) || rate < 0) return null;
        rates[k] = {
          rate: rate,
          engine: data.engine || '',
          /* The server's view of which state this is, which for an address-less
             ask is the only way the page learns it — that is what labels the
             line "Tax (OH)" before anyone has typed anything. */
          state: data.stateCode || normalizeStateCode(state),
          at: Date.now(),
        };
        persist();
        /* Somebody is showing a pending tax line right now. Tell them. */
        try {
          window.dispatchEvent(new CustomEvent('zw:tax', {
            detail: { state: rates[k].state, zip: zip5(zip), rate: rate, engine: rates[k].engine },
          }));
        } catch (_) {}
        return rate;
      })
      .catch(function () { return null; })
      .then(function (v) { delete inFlight[k]; return v; });

    return inFlight[k];
  }

  /* Ask if we don't already know. Safe to call on every keystroke — a cache hit
     costs nothing and a miss is deduped.

     An empty state and ZIP is a legitimate question, not a no-op: the endpoint
     answers it from the country and region Cloudflare reads off the connection.
     That geo answer is how the bag and product pages show a tax line at all
     before an address exists, so returning early here — as this did briefly —
     silently left those pages with no tax and no way to get one. */
  function ensure(state, zip, amountCents) {
    var hit = cached(state, zip);
    if (hit) return Promise.resolve(hit.rate);
    return ask(state, zip, amountCents);
  }

  /* Has the server told us about this address yet? The distinction that matters
     to a summary: 0 because Oregon has no sales tax, or 0 because we haven't
     been told. The first is a number to show; the second is a spinner. */
  function isKnown(state, zip) {
    return cached(state, zip) !== null;
  }

  function rateFor(state, zip) {
    var hit = cached(state, zip);
    if (hit) return hit.rate;
    /* Kick off the ask so the caller's next render has an answer, and report
       nothing for now rather than inventing something. */
    ensure(state, zip);
    return 0;
  }

  /* Math.round on CENTS, matching resolveTax() exactly. Multiplying dollars as
     floats and rounding at the end lands a penny out often enough to be worth
     never doing: 0.1 + 0.2 is not 0.3 in either language. */
  function cents(subtotalCents, state, zip) {
    var amount = Number(subtotalCents) || 0;
    if (amount <= 0) return 0;
    return Math.round(amount * rateFor(state, zip));
  }

  /* Dollars in, dollars out — but routed through the cents path so the two can
     never round differently from each other. */
  function dollars(subtotalDollars, state, zip) {
    var amount = Number(subtotalDollars) || 0;
    if (amount <= 0) return 0;
    return cents(Math.round(amount * 100), state, zip) / 100;
  }

  window.ZWCheckoutTax = {
    normalizeStateCode: normalizeStateCode,
    rateForState: rateFor,
    taxCents: cents,
    taxDollars: dollars,
    /* Newer half of the contract: ask, and know whether you have been told. */
    ensure: ensure,
    isKnown: isKnown,
    engineFor: function (state, zip) { var h = cached(state, zip); return h ? h.engine : ''; },
    /* Which state the tax is FOR — the typed one, or the one the server worked
       out from the connection when nothing has been typed. Pages label the line
       with this rather than with the raw input field. */
    stateFor: function (state, zip) {
      var h = cached(state, zip);
      return (h && h.state) || normalizeStateCode(state);
    },
  };

  /* A first, address-less ask on load. The endpoint falls back to the country
     and region Cloudflare already knows from the connection, which is how the
     bag and product pages show a plausible tax line before anyone has typed an
     address. Costs one cached request per session. */
  ensure('', '');
}());
