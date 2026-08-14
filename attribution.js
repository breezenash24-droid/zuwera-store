/**
 * attribution.js — remember which ad, email or post brought someone here.
 *
 * Runs on every storefront page. Reads the campaign parameters off the landing
 * URL, keeps first touch and last touch, and hands them to checkout so they can
 * be written onto the order. Nothing else in the codebase did any of this: a
 * click id lives for one page load, and an order placed without capturing it is
 * anonymous permanently. There is no backfill.
 *
 * ── CONSENT ─────────────────────────────────────────────────────────────────
 *
 * The cookie banner says analytics and marketing do not run until accepted, and
 * this is marketing — a gclid is Google's handle on a person, not a site
 * preference. So the URL is read into MEMORY on every page load, and only
 * WRITTEN to storage once consent is granted.
 *
 * That ordering matters. Consent is usually given a few seconds after landing,
 * by which time a naive implementation has either already stored the click id
 * (making the banner a lie) or thrown it away (losing the campaign for every
 * visitor who accepts). Reading now and persisting on the 'accepted' event
 * keeps both promises.
 *
 * The honest cost, stated plainly: someone who ignores the banner and buys
 * anyway is not attributed, because their landing page's parameters are gone by
 * the second page load. That is the price of the banner meaning what it says.
 *
 * ── FIRST TOUCH AND LAST TOUCH ──────────────────────────────────────────────
 *
 * Both, because they answer different questions. First touch says what found
 * this customer; last touch says what closed them, and it is what the ad
 * platforms will report. They disagree often, and a store that keeps only one
 * is choosing an answer before knowing the question.
 *
 * First touch is written once and never overwritten. Last touch is overwritten
 * ONLY by a visit that actually carries campaign parameters — a returning
 * visitor typing the address in must not erase the ad that brought them, which
 * is the single most common way home-grown attribution quietly zeroes itself.
 */
(function () {
  'use strict';

  var KEY = 'zw_attr';
  var VERSION = 1;

  /* Mirrors FIELDS in functions/api/_attribution.js. The server sanitises and
     caps independently — this list is about what to LOOK for, not about trust. */
  var PARAMS = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'gclid', 'fbclid', 'msclkid', 'ttclid'
  ];
  /* Presence of any ONE of these makes a visit campaign-bearing. utm_term and
     utm_content are deliberately absent: they refine a campaign rather than
     name one, and alone they are not enough to overwrite a last touch. */
  var CAMPAIGN_KEYS = [
    'utm_source', 'utm_medium', 'utm_campaign',
    'gclid', 'fbclid', 'msclkid', 'ttclid'
  ];

  function readCookie(name) {
    try {
      var m = document.cookie.match('(?:^|; )' + name + '=([^;]*)');
      return m ? decodeURIComponent(m[1]) : '';
    } catch (_) { return ''; }
  }

  /* Referring DOMAIN only, and never our own — an internal link is not a
     referral, and recording one would overwrite a real one with "zuwera.store"
     on the second page of every visit. */
  function referringDomain() {
    try {
      if (!document.referrer) return '';
      var host = new URL(document.referrer).hostname.replace(/^www\./, '');
      if (!host || host === location.hostname.replace(/^www\./, '')) return '';
      return host;
    } catch (_) { return ''; }
  }

  /* The current page, as a touch. Never stored on its own — see persist(). */
  function readTouch() {
    var touch = {};
    var qs;
    try { qs = new URLSearchParams(location.search); } catch (_) { return touch; }

    for (var i = 0; i < PARAMS.length; i++) {
      var v = qs.get(PARAMS[i]);
      if (v) touch[PARAMS[i]] = String(v).slice(0, 200);
    }
    var ref = referringDomain();
    if (ref) touch.referrer = ref;
    /* Path only. The query string is where the click ids were, and they are
       already captured above — keeping it would store the same values twice
       inside a budget measured in characters. */
    touch.landing = String(location.pathname || '/').slice(0, 120);
    touch.ts = Date.now();
    return touch;
  }

  function hasCampaign(touch) {
    for (var i = 0; i < CAMPAIGN_KEYS.length; i++) {
      if (touch[CAMPAIGN_KEYS[i]]) return true;
    }
    return false;
  }

  /* An organic visit with a referring domain still counts as a touch worth
     keeping when nothing has ever been recorded — "arrived from reddit.com"
     beats knowing nothing. It is not enough to REPLACE a campaign, though;
     that is what hasCampaign guards. */
  function worthRecording(touch) {
    return hasCampaign(touch) || !!touch.referrer;
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== VERSION) return null;
      return parsed;
    } catch (_) { return null; }
  }

  function save(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {}
  }

  /* The current page's parameters, held here from load until consent decides
     whether they may be written down. */
  var pending = readTouch();

  function persist() {
    if (!worthRecording(pending)) return;
    var state = load() || { v: VERSION, first: null, last: null };
    if (!state.first) state.first = pending;
    /* Only a campaign-bearing visit moves last touch. A returning visitor
       arriving direct leaves it exactly as it was. */
    if (hasCampaign(pending) || !state.last) state.last = pending;
    save(state);
  }

  /* ── Consent, WITHOUT a load-order dependency ──────────────────────────────
     consent.js is loaded near the END of every page and this file sits near the
     top with the other trackers, so `window.zwConsent` does NOT exist yet when
     this runs. Calling zwConsent.onGranted() here would therefore have done
     nothing at all, on every page, forever — the feature would have shipped,
     passed review, and quietly never recorded a single order.

     meta-pixel.js already solved this: read the stored choice directly and
     listen for the event. Same two lines here, deliberately identical, because
     the alternative is this module and that one disagreeing about whether
     consent was given.

     policies.html is worth knowing about: it loads the pixel but NOT consent.js,
     so no banner is ever shown there. A returning visitor's stored choice is
     still honoured; a new one is treated as undecided. Fails closed either way. */
  function consentGranted() {
    try { return localStorage.getItem('zw_cookie_consent') === 'accepted'; }
    catch (_) { return false; }
  }
  if (consentGranted()) persist();
  else {
    window.addEventListener('zw-consent-accepted', function h() {
      window.removeEventListener('zw-consent-accepted', h);
      persist();
    });
  }

  window.zwAttribution = {
    /* Meta's browser cookies, read here so there is ONE answer to "what is this
       browser's fbc" instead of two. meta-pixel.js asks this rather than
       re-deriving it — when the pixel's value and the server event's value
       disagree, Meta silently matches worse and nothing reports it. */
    fbp: function () { return readCookie('_fbp'); },
    fbc: function () {
      var fbc = readCookie('_fbc');
      if (fbc) return fbc;
      /* No cookie yet — the pixel may not have loaded, or consent may be
         pending. Meta's own format, built from the click id on this URL. */
      var id = pending.fbclid || '';
      return id ? ('fb.1.' + Date.now() + '.' + id) : '';
    },

    /* What checkout sends. `pending` is folded in so an order placed on the
       SAME page load as the click still carries it even though consent may
       have arrived after this module ran.

       Gated on consent for the same reason persist() is, and separately from
       it: storage being empty is not proof of a decline, because `pending`
       exists in memory whatever the visitor chose. Reading only storage here
       would have sent a declining visitor's click id to the server on the one
       page load where it was still in hand — the exact leak the banner
       promises will not happen. Fails closed when consent.js is absent. */
    forOrder: function () {
      if (!consentGranted()) return null;
      var state = load() || { first: null, last: null };
      var first = state.first || (worthRecording(pending) ? pending : null);
      var last  = (hasCampaign(pending) ? pending : state.last) || first;
      if (!first && !last) return null;
      return {
        first: first || last,
        last:  last  || first,
        fbp:   this.fbp(),
        fbc:   this.fbc()
      };
    },

    /* For the console when an order's attribution looks wrong. */
    current: function () { return { stored: load(), thisPage: pending }; }
  };
})();
