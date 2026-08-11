/* customer-messages.js — the words the shopper reads when something is
   unavailable, and the colour they are read in, in one place. Editable from
   Admin → Loyalty → Customer messages.
 *
 * Before this there were five ways to say "only N left" and three copies of
 * every back-in-stock line, spread across product.html, bag.html,
 * quick-add-modal.js and stock-rules.js. Changing the wording meant finding all
 * of them, and nobody ever found all of them — which is the same fault that
 * made the product page and checkout disagree about stock in the first place.
 *
 * COLOUR IS PART OF THE MESSAGE, not decoration applied afterwards. A sentence
 * that reads as a warning in red and as a nudge in grey is two different
 * messages, and the colours were hardcoded next to each string — so a store
 * could rewrite "you are already on the list" into good news and still have it
 * painted like a failure. Text and colour travel together here for that reason.
 *
 * HOW IT FITS TOGETHER
 *   - The DEFAULTS below are the shipped copy and colours. They live in code,
 *     so a store that never opens the editor still reads correctly and a failed
 *     settings load can never blank a message.
 *   - An admin's edits are stored in commerce_config.customerExperience.messages
 *     and ride along on /api/stock, which every page showing these already
 *     fetches. No second round trip, so the wording and the numbers it wraps
 *     can never arrive out of step.
 *   - Overrides merge per key and per field. Clearing a box in admin restores
 *     that default rather than showing an empty string or an invisible colour.
 *
 * PLACEHOLDERS
 *   Each message declares which {tokens} it may use. An override that reaches
 *   for one it has no value for is REFUSED and the default stands, because the
 *   alternative is a shopper reading a literal "{title}". The admin editor
 *   checks the same table before saving, so this is the second line rather than
 *   the first.
 *
 * This file is loaded by the storefront AND by the admin editor, so the keys,
 * the defaults and the placeholder rules are read from one place by both sides.
 * Anything that keeps its own copy will drift; that is not a prediction, it is
 * what the messages this file replaces actually did.
 */
(function (w) {
  'use strict';
  if (w.ZWMessages) return;

  /* Colour ROLES rather than literal colours, so the palette stays consistent
     and a store editing one message cannot end up with three shades of "this
     went wrong". '' means inherit — the surrounding text's colour, which is
     right for anything that is merely information. */
  var ROLE = {
    plain: '',
    good: 'rgba(110,210,130,.95)',
    bad: 'var(--red,#dc2626)',
  };

  /* Every message the shopper can meet about availability. Keyed by SITUATION,
     not by page — "the bag is at its cap" is one thing that happens, and it
     read three different ways depending on where the shopper happened to be. */
  var DEFAULTS = {
    /* ── on the shelf ─────────────────────────────────────────────────────── */
    soldOut:        { label: 'A size is sold out', text: 'Out of stock', color: ROLE.plain },
    soldOutItem:    { label: 'A named item is sold out', text: '{title} ({size}) is out of stock', color: ROLE.plain },
    soldOutInBag:   { label: 'Something in the bag has sold out', text: 'Out of stock — remove it to check out', color: ROLE.bad },
    lowStock:       { label: 'Only a few left (product page)', text: 'Only {count} left in stock', color: ROLE.plain },
    lowStockShort:  { label: 'Only a few left (bag)', text: 'Only {count} left', color: ROLE.plain },

    /* ── in the shopper's own bag ─────────────────────────────────────────────
       Distinct from sold out on purpose, and the distinction is the point: the
       shelf still has stock, this shopper is simply holding all of it. Wording
       that reads as a sell-out here tells them the store is empty because of
       what is in their own bag. See stock-rules.js availability(). */
    lastInBag:      { label: 'They have the last one in their bag', text: 'The only one is in your bag', color: ROLE.plain },
    allInBag:       { label: 'They have all of them in their bag', text: 'All {count} are in your bag', color: ROLE.plain },
    maxedOut:       { label: 'They tried to add more than we have', text: "That's all we have — {count} in your bag already", color: ROLE.plain },
    capReached:     { label: 'They hit the limit for a size', text: 'Only {count} in stock for {size}', color: ROLE.plain },

    /* ── back in stock ────────────────────────────────────────────────────────
       restockAlready is deliberately NOT red: the shopper asked twice for the
       same thing and the answer is still yes. It was painted as a failure. */
    restockHint:    { label: 'Hint that sold-out sizes are tappable', text: "Tap a sold-out size to get notified when it's back.", color: ROLE.plain },
    restockInvite:  { label: 'Heading above the back-in-stock form', text: "Email me when it's back", color: ROLE.plain },
    restockPrompt:  { label: 'Asking for an email for a sold-out size', text: "Size {size} is sold out — get notified when it's back", color: ROLE.plain },
    restockSuccess: { label: 'They joined the back-in-stock list', text: "✓ We'll email you when {size} is back.", color: ROLE.good },
    restockAlready: { label: 'They were already on the list', text: "You're already on the list for this size.", color: ROLE.plain },
    restockInvalid: { label: 'The email they typed is not usable', text: 'Enter a valid email.', color: ROLE.bad },
    restockFailed:  { label: 'Joining the list did not work', text: 'Could not save that — try again.', color: ROLE.bad },

    /* ── card declines ────────────────────────────────────────────────────────
       Read at the worst moment in the whole shop: the shopper has decided to
       buy and been refused. Keyed by Stripe's own decline code, so the lookup
       in checkout.js is `decline:` + whatever Stripe said and there is no
       translation table in between to fall out of step.

       Only codes a shopper can ACT on get specific copy. A decline they cannot
       act on is not dressed up as advice -- inventing a reason is worse than
       not having one, because they spend the next five minutes fixing
       something that was never wrong. Fraud holds and lost/stolen reports
       deliberately share neutral wording: telling someone their card is
       reported stolen is a message for the cardholder, and the person at the
       checkout may not be them. Worth keeping in mind before rewriting these. */
    'decline:insufficient_funds': { label: 'Card has no funds available', text: 'That card does not have enough available. Try another card or a different payment method.', color: ROLE.bad },
    'decline:incorrect_cvc': { label: 'Security code did not match', text: 'The security code did not match. Check the 3 digits on the back and try again.', color: ROLE.bad },
    'decline:invalid_cvc': { label: 'Security code is not valid', text: 'That security code is not valid. Check the 3 digits on the back and try again.', color: ROLE.bad },
    'decline:incorrect_number': { label: 'Card number is not right', text: 'That card number is not right. Check it and try again.', color: ROLE.bad },
    'decline:invalid_number': { label: 'Card number is not valid', text: 'That card number is not valid. Check it and try again.', color: ROLE.bad },
    'decline:expired_card': { label: 'Card has expired', text: 'That card has expired. Try another card.', color: ROLE.bad },
    'decline:invalid_expiry_month': { label: 'Expiry month is not valid', text: 'That expiry month is not valid. Check the date on the card.', color: ROLE.bad },
    'decline:invalid_expiry_year': { label: 'Expiry year is not valid', text: 'That expiry year is not valid. Check the date on the card.', color: ROLE.bad },
    'decline:incorrect_zip': { label: 'Postcode did not match the bank', text: 'The postcode did not match the one your bank has. Check the billing address and try again.', color: ROLE.bad },
    'decline:card_not_supported': { label: 'Card cannot be used here', text: 'That card cannot be used for this kind of purchase. Try another card.', color: ROLE.bad },
    'decline:currency_not_supported': { label: 'Card cannot pay in this currency', text: 'That card cannot be charged in this currency. Try another card.', color: ROLE.bad },
    'decline:call_issuer': { label: 'Bank wants to approve it first', text: 'Your bank needs to approve this. Call the number on the back of your card, or try another card.', color: ROLE.bad },
    'decline:lost_card': { label: 'Card reported lost', text: 'That card was declined. Try another card.', color: ROLE.bad },
    'decline:stolen_card': { label: 'Card reported stolen', text: 'That card was declined. Try another card.', color: ROLE.bad },
    'decline:pickup_card': { label: 'Bank asked for the card back', text: 'That card was declined. Try another card.', color: ROLE.bad },
    'decline:fraudulent': { label: 'Bank flagged it as fraud', text: 'That payment could not be completed. Try another card or contact your bank.', color: ROLE.bad },
    'decline:merchant_blacklist': { label: 'Bank blocked this merchant', text: 'That payment could not be completed. Try another card or contact your bank.', color: ROLE.bad },
    'decline:do_not_honor': { label: 'Bank declined without a reason', text: 'Your bank declined it without giving a reason. Try another card, or call the number on the back of your card.', color: ROLE.bad },
    'decline:generic_decline': { label: 'Card declined, no reason given', text: 'That card was declined. Try another card, or call your bank.', color: ROLE.bad },
    'decline:processing_error': { label: 'Could not reach the bank', text: 'Something went wrong reaching your bank. Wait a moment and try again.', color: ROLE.bad },
    'decline:try_again_later': { label: 'Bank could not approve it yet', text: 'Your bank could not approve it just now. Wait a moment and try again.', color: ROLE.bad },
    /* When Stripe sends a code we have no copy for, and when it sends nothing
       at all. Never empty: a refused payment with no explanation is the worst
       of the three outcomes. */
    'decline:unknown': { label: 'Any other decline', text: 'That payment could not be completed. Please try again.', color: ROLE.bad },
  };

  /* `label` is what the admin editor calls this message. It lives here rather
     than in admin-main.js so there is still one list: an editor with its own
     names drifts from the messages it claims to describe, which is the fault
     this whole module exists to remove.

     What each message is allowed to interpolate. A key absent from here takes
     no placeholders at all. Kept beside the defaults so adding a message forces
     the question "what does this one know about?" to be answered once. */
  var PLACEHOLDERS = {
    soldOutItem:    ['title', 'size'],
    lowStock:       ['count'],
    lowStockShort:  ['count'],
    allInBag:       ['count'],
    maxedOut:       ['count'],
    capReached:     ['count', 'size'],
    restockPrompt:  ['size'],
    restockSuccess: ['size'],
  };


  /* How the editor lays these out. Here rather than in admin-main.js for the
     same reason the labels are: an editor with its own list drifts from the
     messages it claims to describe. Anything not named below still appears,
     under "Other", so a message added above shows up in admin without a second
     edit somewhere else. */
  var GROUPS = [
    { title: 'When something has sold out', keys: ['soldOut', 'soldOutItem', 'soldOutInBag'] },
    { title: 'When stock is running low', keys: ['lowStock', 'lowStockShort', 'capReached'] },
    { title: 'When they already have it in their bag', keys: ['lastInBag', 'allInBag', 'maxedOut'] },
    { title: 'Back-in-stock signup', keys: ['restockHint', 'restockInvite', 'restockPrompt', 'restockSuccess', 'restockAlready', 'restockInvalid', 'restockFailed'] },
    { title: 'When a card is declined', keys: Object.keys(DEFAULTS).filter(function (k) { return k.indexOf('decline:') === 0; }) },
  ];

  /** Grouped keys, with anything ungrouped collected at the end. */
  function groups() {
    var named = {};
    var out = GROUPS.map(function (g) {
      g.keys.forEach(function (k) { named[k] = 1; });
      return { title: g.title, keys: g.keys.filter(function (k) { return !!DEFAULTS[k]; }) };
    });
    var rest = Object.keys(DEFAULTS).filter(function (k) { return !named[k]; });
    if (rest.length) out.push({ title: 'Other', keys: rest });
    return out;
  }

  /** Is this a message we ship copy for? */
  function has(key) {
    return Object.prototype.hasOwnProperty.call(DEFAULTS, key);
  }

  var TOKEN = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

  /* A colour and nothing else. These are written into style.color, where the
     CSSOM would reject anything malformed anyway — this exists so an admin
     gets told at save time instead of wondering why their colour did nothing.
     var(--x) is allowed because the shipped defaults use it. */
  var COLOR_OK = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/deg]+\)|var\(--[a-zA-Z0-9-]+(,\s*[^;{}()]+)?\)|[a-zA-Z]+)$/;

  /** Tokens actually written in a template, in order of appearance. */
  function tokensIn(text) {
    var out = [];
    String(text == null ? '' : text).replace(TOKEN, function (_, name) {
      if (out.indexOf(name) === -1) out.push(name);
      return '';
    });
    return out;
  }

  /**
   * Is `text` a usable override for `key`?
   * Empty is not an error — it means "use the default" — but it is not usable
   * either, so it is reported the same way and the caller falls back.
   *
   * @returns null when fine, otherwise the reason, ready to show an admin.
   */
  function validate(key, text) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return 'Unknown message: ' + key;
    var s = String(text == null ? '' : text).trim();
    if (!s) return 'Empty';
    var allowed = PLACEHOLDERS[key] || [];
    var used = tokensIn(s);
    for (var i = 0; i < used.length; i += 1) {
      if (allowed.indexOf(used[i]) === -1) {
        return allowed.length
          ? '{' + used[i] + '} is not available here. This message can use: '
            + allowed.map(function (a) { return '{' + a + '}'; }).join(', ')
          : '{' + used[i] + '} is not available here. This message takes no placeholders.';
      }
    }
    return null;
  }

  /** Same contract as validate(), for the colour half. */
  function validateColor(value) {
    var s = String(value == null ? '' : value).trim();
    if (!s) return 'Empty';
    if (!COLOR_OK.test(s)) return 'Not a colour. Use a hex value like #dc2626, or rgb()/hsl().';
    return null;
  }

  /* Admin edits, once they have arrived. Only fields that passed validation get
     in, so get() and color() never have to defend themselves against a bad one. */
  var overrides = {};

  /* ── surfaces that have to be repainted when the wording lands ─────────────
     The overrides arrive over the network; the product page has already drawn
     its stock line by then. Without this, an admin's wording only appeared on
     whatever happened to render after the fetch resolved — which in the first
     version of this file was nothing at all on the product page, so the editor
     saved settings that never reached a shopper.

     Subscribers are called after every setOverrides, including the first. */
  var listeners = [];
  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i > -1) listeners.splice(i, 1);
    };
  }
  function notify() {
    for (var i = 0; i < listeners.length; i += 1) {
      try { listeners[i](); } catch (_) { /* one bad surface must not stop the rest */ }
    }
  }

  /**
   * Replace the stored overrides wholesale.
   *
   * Accepts either shape, because the text-only one shipped first and settings
   * written then must keep working:
   *     { soldOut: 'Gone!' }
   *     { soldOut: { text: 'Gone!', color: '#dc2626' } }
   *
   * Rejected fields are returned rather than thrown: one bad message must not
   * cost the store the other twelve, and text and colour are judged separately
   * so a bad colour cannot discard good wording.
   */
  function setOverrides(raw) {
    var next = {};
    var rejected = [];
    if (raw && typeof raw === 'object') {
      Object.keys(raw).forEach(function (key) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
          rejected.push({ key: key, reason: 'Unknown message' });
          return;
        }
        var v = raw[key];
        var entry = (v && typeof v === 'object') ? v : { text: v };
        var out = {};

        var whyText = validate(key, entry.text);
        if (whyText && whyText !== 'Empty') rejected.push({ key: key, reason: whyText });
        else if (!whyText) out.text = String(entry.text).trim();

        /* An explicit empty colour is meaningful — it means "inherit" — so it
           is only treated as "use the default" when the field is absent. */
        if (entry.color !== undefined && entry.color !== null) {
          var c = String(entry.color).trim();
          if (c === '') out.color = '';
          else {
            var whyColor = validateColor(c);
            if (whyColor) rejected.push({ key: key + ' colour', reason: whyColor });
            else out.color = c;
          }
        }

        if (out.text !== undefined || out.color !== undefined) next[key] = out;
      });
    }
    overrides = next;
    notify();
    if (rejected.length && w.console && console.warn) {
      console.warn('customer messages ignored (falling back to the shipped copy):',
        rejected.map(function (r) { return r.key + ' — ' + r.reason; }).join('; '));
    }
    return rejected;
  }

  function field(key, name) {
    var o = overrides[key];
    if (o && o[name] !== undefined) return o[name];
    var d = DEFAULTS[key];
    return d ? d[name] : undefined;
  }

  /**
   * The message for `key`, with `vars` filled in.
   *
   * Works before the overrides have loaded — it answers from DEFAULTS — because
   * these are read by click handlers and by render passes that cannot wait for
   * a fetch. That is the same reason ZWStock.peek() exists.
   *
   * A token with no value supplied collapses to nothing and the surrounding
   * spaces are tidied, so a half-supplied message reads as a short sentence
   * rather than as broken software.
   */
  function get(key, vars) {
    var template = field(key, 'text');
    if (template === undefined) return '';
    var v = vars || {};
    return String(template)
      .replace(TOKEN, function (whole, name) {
        var value = v[name];
        if (value === undefined || value === null || value === '') return '';
        return String(value);
      })
      /* Brackets first, THEN the spaces: dropping "()" leaves the two spaces
         that surrounded it, so collapsing whitespace before removing the empty
         bracket leaves a gap behind. */
      .replace(/\(\s*\)/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /** The colour for `key`. '' means inherit the surrounding text colour. */
  function color(key) {
    var c = field(key, 'color');
    return c === undefined ? '' : c;
  }

  /**
   * Write both halves onto an element. The one way to render a message, so a
   * surface cannot pick up the new wording and keep painting it the old
   * colour — which is precisely how "you're already on the list" stayed red
   * after being reworded into good news.
   */
  function apply(el, key, vars) {
    if (!el) return '';
    var text = get(key, vars);
    el.textContent = text;
    try { el.style.color = color(key); } catch (_) {}
    return text;
  }

  w.ZWMessages = {
    subscribe: subscribe,
    DEFAULTS: DEFAULTS,
    PLACEHOLDERS: PLACEHOLDERS,
    ROLE: ROLE,
    keys: function () { return Object.keys(DEFAULTS); },
    groups: groups,
    has: has,
    tokensIn: tokensIn,
    validate: validate,
    validateColor: validateColor,
    setOverrides: setOverrides,
    get: get,
    color: color,
    apply: apply,
  };
})(typeof window !== 'undefined' ? window : this);
