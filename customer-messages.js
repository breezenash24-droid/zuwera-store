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
    /* The short forms. A card in a grid and a size button have room for two
       words, not a sentence, so these are deliberately not `soldOut` -- but
       they are still written once and shared by the collection grid and the
       quick-add panel, which each had their own copy. */
    soldOutBadge:   { label: 'Sold-out badge on a product card', text: 'Sold Out', color: ROLE.plain },
    lowStockBadge:  { label: 'Low-stock badge on a product card', text: 'Low Stock', color: ROLE.plain },
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
    /* ── signing in ───────────────────────────────────────────────────────────
       The auth service returns its own messages, and the two below are the ones
       a shopper actually meets: a wrong password and an address that already
       has an account. Those were reaching the screen verbatim from Supabase and
       could not be changed. Everything else it says still passes through as-is,
       because a specific reason beats a generic one -- these two are mapped
       because they are the common cases, the same reasoning as the card
       declines. */
    authBadCredentials: { label: 'Email or password was wrong', text: 'That email and password do not match. Try again, or reset your password below.', color: ROLE.bad },
    authEmailInUse:     { label: 'Address already has an account', text: 'There is already an account with that email. Try logging in instead.', color: ROLE.bad },
    authMissingFields:  { label: 'A box was left empty', text: 'Enter your email and password.', color: ROLE.bad },
    authNeedEmail:      { label: 'Password reset with no address', text: 'Enter your email.', color: ROLE.bad },
    authPasswordShort:  { label: 'Chosen password is too short', text: 'Password must be at least 6 characters.', color: ROLE.bad },
    authNoConnection:   { label: 'Could not reach the login service', text: 'Connection unavailable — use the link below.', color: ROLE.bad },
    authFailed:         { label: 'Signing in did not work', text: 'Something went wrong. Try again.', color: ROLE.bad },

    /* ── at checkout, refused by the server ──────────────────────────────────
       These come from the payment path, which is the code that decides whether
       money moves. They are repeated in functions/api/_messages.js because a
       Worker module and a browser script cannot import one another, and a test
       holds the two character-for-character identical.

       Note what is NOT here: "Missing cart items" and "Cart has too many line
       items". Those mean the request was malformed, which a shopper cannot
       cause or fix -- editing them would be dressing up a bug as advice. */
    checkoutNotEnough:    { label: 'Not enough left, found at checkout', text: 'Only {count} left in stock for {title} ({size}).', color: ROLE.bad },
    checkoutUnavailable:  { label: 'Product has gone from the catalogue', text: 'Product is no longer available: {title}', color: ROLE.bad },
    checkoutNoPrice:      { label: 'Product has no price set', text: 'Product has no checkout price: {title}', color: ROLE.bad },
    checkoutPriceChanged: { label: 'Price changed since the bag was filled', text: 'The price of {title} has changed. Refresh your bag to see the current price before paying.', color: ROLE.bad },
    checkoutRateExpired:  { label: 'Shipping quote went stale', text: 'Selected shipping rate expired. Please reload shipping options.', color: ROLE.bad },
    checkoutRateInvalid:  { label: 'Shipping quote was not usable', text: 'Invalid shipping rate — please reload shipping options.', color: ROLE.bad },

    /* ── promo codes ──────────────────────────────────────────────────────────
       A coupon can also carry its OWN message (set per code in admin), and that
       still wins where it exists -- "expired on 1 June" beats a generic refusal.
       These are what a shopper sees when the code has nothing specific to say. */
    promoApplied:   { label: 'Promo code worked', text: '{label} applied!', color: ROLE.good },
    promoEmpty:     { label: 'They pressed Apply with an empty box', text: 'Enter a promo code.', color: ROLE.plain },
    promoInvalid:   { label: 'Promo code was not accepted', text: 'Invalid promo code.', color: ROLE.bad },
    promoFailed:    { label: 'Could not check the promo code', text: 'Could not validate code. Try again.', color: ROLE.bad },

    restockFailed:  { label: 'Joining the list did not work', text: 'Could not save that — try again.', color: ROLE.bad },

    /* ── card declines ────────────────────────────────────────────────────────
       Read at the worst moment in the shop: the shopper has decided to buy and
       been refused.

       NINE messages, not one per Stripe decline code. There are twenty-odd
       codes and they collapse into far fewer things a shopper can actually DO
       about it -- a lost card, a stolen card and a bank's fraud hold all mean
       "use a different card", and writing three separate sentences for them is
       three chances to say it differently and no extra help to anyone. The
       mapping from code to message lives in DECLINE_MAP below.

       What survives as its own message is a distinct ACTION: check the security
       code, check the number, use a different card, call the bank, wait and
       retry. A decline the shopper cannot act on is not dressed up as advice --
       inventing a reason costs them five minutes fixing what was never wrong. */
    declineFunds:    { label: 'Card had no funds', text: 'That card does not have enough available. Try another card or a different payment method.', color: ROLE.bad },
    declineCvc:      { label: 'Security code was wrong', text: 'The security code did not match. Check the 3 digits on the back and try again.', color: ROLE.bad },
    declineNumber:   { label: 'Card number was wrong', text: 'That card number is not right. Check it and try again.', color: ROLE.bad },
    declineExpired:  { label: 'Card had expired', text: 'That card has expired. Try another card.', color: ROLE.bad },
    declinePostcode: { label: 'Billing postcode did not match', text: 'The postcode did not match the one your bank has. Check the billing address and try again.', color: ROLE.bad },
    declineCallBank: { label: 'Bank wants to approve it first', text: 'Your bank needs to approve this. Call the number on the back of your card, or try another card.', color: ROLE.bad },
    declineNoReason: { label: 'Bank declined without saying why', text: 'Your bank declined it without giving a reason. Try another card, or call the number on the back of your card.', color: ROLE.bad },
    declineRetry:    { label: 'Bank could not be reached', text: 'Something went wrong reaching your bank. Wait a moment and try again.', color: ROLE.bad },
    /* The catch-all, and where lost/stolen/fraud/pickup deliberately land.
       Telling someone their card is reported stolen is a message for the
       cardholder, and the person at the checkout may not be them. */
    declined:        { label: 'Declined, any other reason', text: 'That card was declined. Try another card, or call your bank.', color: ROLE.bad },
  };


  /* Which message answers which Stripe decline code. Here, next to the
     messages, so adding a code is one edit in one file -- and so checkout.js
     needs no table of its own to fall out of step with.

     Anything not listed falls through to `declined`, which is why a code Stripe
     invents next year still gets a usable sentence instead of silence. */
  var DECLINE_MAP = {
    insufficient_funds:     'declineFunds',

    incorrect_cvc:          'declineCvc',
    invalid_cvc:            'declineCvc',

    incorrect_number:       'declineNumber',
    invalid_number:         'declineNumber',

    expired_card:           'declineExpired',
    invalid_expiry_month:   'declineExpired',
    invalid_expiry_year:    'declineExpired',

    incorrect_zip:          'declinePostcode',
    call_issuer:            'declineCallBank',
    do_not_honor:           'declineNoReason',

    processing_error:       'declineRetry',
    try_again_later:        'declineRetry',

    /* All of these mean the same thing to the person standing at the checkout:
       use a different card. Listed rather than left to the fallback so it is
       visible that the grouping is deliberate. */
    generic_decline:        'declined',
    lost_card:              'declined',
    stolen_card:            'declined',
    pickup_card:            'declined',
    fraudulent:             'declined',
    merchant_blacklist:     'declined',
    card_not_supported:     'declined',
    currency_not_supported: 'declined',
  };

  /** The message key for a Stripe decline code. Never null: unknown falls back. */
  function declineKey(code) {
    return DECLINE_MAP[String(code || '').trim()] || 'declined';
  }

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
    promoApplied:   ['label'],
    checkoutNotEnough:    ['count', 'title', 'size'],
    checkoutUnavailable:  ['title'],
    checkoutNoPrice:      ['title'],
    checkoutPriceChanged: ['title'],
  };




  /* The colours worth offering as a choice, named for what they MEAN rather
     than for what they look like. A store picking "Alert" gets whatever this
     theme's alert red is, on every message, instead of three hand-typed reds
     that drift apart.

     Each message's shipped `color` is one of these, and that is the
     RECOMMENDATION -- the editor marks it as such and can put it back. Anything
     else is still allowed: the box takes any CSS colour. */
  var PALETTE = [
    { name: 'Normal', value: ROLE.plain, note: 'follows the surrounding text' },
    { name: 'Positive', value: ROLE.good, note: 'good news' },
    { name: 'Alert', value: ROLE.bad, note: 'something is wrong or blocked' },
  ];

  /** The colour we recommend for this message, i.e. the one it ships with. */
  function recommendedColor(key) {
    var d = DEFAULTS[key];
    return d ? d.color : '';
  }

  /** The palette entry a colour corresponds to, or null for a custom one. */
  function paletteName(value) {
    var v = String(value == null ? '' : value).trim();
    for (var i = 0; i < PALETTE.length; i += 1) {
      if (PALETTE[i].value === v) return PALETTE[i].name;
    }
    return null;
  }


  /* ── where each message actually appears ───────────────────────────────────
     The admin map is built from this, so it describes the code rather than
     someone's memory of it. A message that is not listed on any surface shows
     up as such in the test below rather than quietly becoming invisible on the
     map -- which would be the same failure as a message nobody can find in the
     editor.

     `where` is the screen in a shopper's words, not the filename. */
  var SURFACES = [
    {
      name: 'Product page',
      where: 'Under the size buttons, and the toasts',
      keys: ['soldOut', 'lowStock', 'lastInBag', 'allInBag', 'maxedOut',
             'lowStockBadge', 'restockPrompt', 'restockSuccess', 'restockAlready'],
      /* Referenced here, but only as a safety net: Add to Bag is already
         disabled by the time either could fire, so a shopper should never meet
         them on this screen. Kept because the guard is correct -- a disabled
         button is a display, not a rule -- but listed separately so nobody
         spends time on wording that is not read. */
      rare: ['soldOutItem', 'restockFailed'],
    },
    {
      name: 'Bag',
      where: 'On each line, and the promo box',
      keys: ['soldOutInBag', 'lowStockShort', 'capReached', 'soldOut', 'soldOutItem',
             'restockInvite', 'restockSuccess', 'restockAlready', 'restockInvalid',
             'promoApplied', 'promoEmpty', 'promoInvalid'],
      // Only when the database itself refuses the write, or the code call fails.
      rare: ['restockFailed', 'promoFailed'],
    },
    {
      name: 'Quick-add panel',
      where: 'Homepage, saved items, account',
      keys: ['soldOutBadge', 'restockHint', 'restockPrompt', 'restockSuccess',
             'restockAlready', 'restockInvalid'],
      rare: ['restockFailed'],
    },
    {
      name: 'Collection grid',
      where: 'The badges on each card',
      keys: ['soldOutBadge', 'lowStockBadge'],
    },
    {
      name: 'Checkout — paying',
      where: 'The line under the card fields',
      keys: ['declineFunds', 'declineCvc', 'declineNumber', 'declineExpired', 'declinePostcode',
             'declineCallBank', 'declineNoReason', 'declineRetry', 'declined'],
    },
    {
      name: 'Checkout — refused by the server',
      where: 'Before the card is charged',
      keys: ['soldOutItem', 'checkoutNotEnough', 'checkoutPriceChanged', 'checkoutRateExpired'],
      /* checkoutUnavailable and checkoutNoPrice describe a CATALOGUE mistake --
         a product unpublished or priced at nothing while sitting in a bag --
         and checkoutRateInvalid means a shipping token failed its signature.
         Real, worth having, and not things a working store produces. */
      rare: ['checkoutUnavailable', 'checkoutNoPrice', 'checkoutRateInvalid'],
    },
    {
      name: 'Log in',
      where: 'The sign-in, sign-up and reset forms',
      keys: ['authBadCredentials', 'authEmailInUse', 'authMissingFields', 'authNeedEmail',
             'authPasswordShort'],
      // Only when the auth service cannot be reached, or answers unexpectedly.
      rare: ['authNoConnection', 'authFailed'],
    },
  ];

  /** Surfaces, with any key that no longer exists dropped. */
  function surfaces() {
    var live = function (list) {
      return (list || []).filter(function (k) { return !!DEFAULTS[k]; });
    };
    return SURFACES.map(function (s) {
      return {
        name: s.name,
        where: s.where,
        keys: live(s.keys),
        /* Reached only when something has already gone wrong. Shown, because a
           message nobody can find is a message nobody can fix -- but shown
           apart, so time goes on the wording shoppers actually read. */
        rare: live(s.rare),
      };
    });
  }

  /** Every surface a message appears on, by name. */
  function surfacesFor(key) {
    return SURFACES.filter(function (s) {
      return s.keys.indexOf(key) > -1 || (s.rare || []).indexOf(key) > -1;
    }).map(function (s) { return s.name; });
  }

  /* Which messages the editor keeps out of the way.
     Anything NOT listed here is shown straight away, so a message added later
     is visible by default -- the failure mode of the other arrangement is a new
     message nobody knows exists, hidden behind a toggle they never open.

     These are the ones a shopper meets rarely, or that only differ from a main
     message by context (the bag's shorter "Only 2 left", say). They are still
     fully editable; they are just not what the panel opens on. */
  var SECONDARY = {
    soldOutBadge: 1, lowStockBadge: 1, lowStockShort: 1,
    promoEmpty: 1, promoFailed: 1,
    checkoutNoPrice: 1, checkoutRateExpired: 1, checkoutRateInvalid: 1,
    authNeedEmail: 1, authPasswordShort: 1, authNoConnection: 1, authFailed: 1, capReached: 1, allInBag: 1, maxedOut: 1,
    restockHint: 1, restockInvite: 1, restockAlready: 1, restockInvalid: 1, restockFailed: 1,
    declinePostcode: 1, declineCallBank: 1, declineNoReason: 1, declineRetry: 1,
  };

  /** Is this one of the messages the editor leads with? */
  function isMain(key) { return !SECONDARY[key]; }

  /* How the editor lays these out. Here rather than in admin-main.js for the
     same reason the labels are: an editor with its own list drifts from the
     messages it claims to describe. Anything not named below still appears,
     under "Other", so a message added above shows up in admin without a second
     edit somewhere else. */
  var GROUPS = [
    { title: 'When something has sold out', keys: ['soldOut', 'soldOutBadge', 'soldOutItem', 'soldOutInBag'] },
    { title: 'When stock is running low', keys: ['lowStock', 'lowStockBadge', 'lowStockShort', 'capReached'] },
    { title: 'When they already have it in their bag', keys: ['lastInBag', 'allInBag', 'maxedOut'] },
    { title: 'Back-in-stock signup', keys: ['restockHint', 'restockInvite', 'restockPrompt', 'restockSuccess', 'restockAlready', 'restockInvalid', 'restockFailed'] },
    { title: 'Signing in', keys: ['authBadCredentials', 'authEmailInUse', 'authMissingFields', 'authNeedEmail', 'authPasswordShort', 'authNoConnection', 'authFailed'] },
    { title: 'Refused at checkout', keys: ['checkoutNotEnough', 'checkoutUnavailable', 'checkoutPriceChanged', 'checkoutNoPrice', 'checkoutRateExpired', 'checkoutRateInvalid'] },
    { title: 'Promo codes', keys: ['promoApplied', 'promoEmpty', 'promoInvalid', 'promoFailed'] },
    { title: 'When a card is declined', keys: ['declineFunds', 'declineCvc', 'declineNumber', 'declineExpired', 'declinePostcode', 'declineCallBank', 'declineNoReason', 'declineRetry', 'declined'] },
  ];

  /** Grouped keys, with anything ungrouped collected at the end. */
  function groups() {
    var named = {};
    var split = function (title, keys) {
      var live = keys.filter(function (k) { return !!DEFAULTS[k]; });
      return {
        title: title,
        keys: live,                                          // everything, in order
        main: live.filter(isMain),
        more: live.filter(function (k) { return !isMain(k); }),
      };
    };
    var out = GROUPS.map(function (g) {
      g.keys.forEach(function (k) { named[k] = 1; });
      return split(g.title, g.keys);
    });
    var rest = Object.keys(DEFAULTS).filter(function (k) { return !named[k]; });
    if (rest.length) out.push(split('Other', rest));
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


  /* Stand-in values for a preview. Here rather than in the editor so what an
     admin is shown is filled in the same way, by the same code, as what a
     shopper is shown -- a preview built from its own substitution routine is a
     preview that can lie, and this whole module exists because two copies of
     one thing drifted. */
  var SAMPLE = { count: 2, size: 'M', title: 'Zuwera Aero Pro' };

  /**
   * Fill `template` in exactly as get() would, without needing it to be saved
   * first. This is what lets the editor show the finished sentence as it is
   * typed, so checking a change does not mean deploying it, opening a console
   * or putting a declined card through a live checkout.
   */
  function render(template, vars) {
    return fill(template, vars || SAMPLE);
  }

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
  /* The one substitution routine. get() and render() both go through it, so a
     preview cannot show something the shopper would not get. */
  function fill(template, vars) {
    var v = vars || {};
    return String(template == null ? '' : template)
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

  function get(key, vars) {
    var template = field(key, 'text');
    if (template === undefined) return '';
    return fill(template, vars);
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


  /* ── making sure the overrides are actually fetched ────────────────────────
     stock-rules.js fetches /api/stock and hands the wording here, and on the
     shopping pages that is the only request anyone should make. But the login
     modal appears on pages that have no reason to load stock rules at all --
     About, Journal, Policies -- and on those the wording would never arrive.
     An admin edit applying on some pages and not others is worse than it not
     applying anywhere, because it looks like the edit half-worked.

     So: stock-rules.js CLAIMS this synchronously when it loads, and if nothing
     has claimed it by the time the document is ready, this fetches for itself.
     One request either way. */
  var claimed = false;
  function claim() { claimed = true; }

  function selfFetch() {
    if (claimed) return;
    claimed = true;
    try {
      fetch('/api/stock', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d) setOverrides(d.messages); })
        .catch(function () { /* defaults stand — never blank a message */ });
    } catch (_) {}
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', selfFetch, { once: true });
    } else if (typeof setTimeout === 'function') {
      setTimeout(selfFetch, 0);
    }
  }

  w.ZWMessages = {
    subscribe: subscribe,
    claim: claim,
    DEFAULTS: DEFAULTS,
    PLACEHOLDERS: PLACEHOLDERS,
    ROLE: ROLE,
    keys: function () { return Object.keys(DEFAULTS); },
    groups: groups,
    surfaces: surfaces,
    surfacesFor: surfacesFor,
    has: has,
    isMain: isMain,
    PALETTE: PALETTE,
    recommendedColor: recommendedColor,
    paletteName: paletteName,
    SAMPLE: SAMPLE,
    render: render,
    declineKey: declineKey,
    tokensIn: tokensIn,
    validate: validate,
    validateColor: validateColor,
    setOverrides: setOverrides,
    get: get,
    color: color,
    apply: apply,
  };
})(typeof window !== 'undefined' ? window : this);
