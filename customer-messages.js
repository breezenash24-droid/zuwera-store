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
    soldOut:        { text: 'Out of stock', color: ROLE.plain },
    soldOutItem:    { text: '{title} ({size}) is out of stock', color: ROLE.plain },
    soldOutInBag:   { text: 'Out of stock — remove it to check out', color: ROLE.bad },
    lowStock:       { text: 'Only {count} left in stock', color: ROLE.plain },
    lowStockShort:  { text: 'Only {count} left', color: ROLE.plain },

    /* ── in the shopper's own bag ─────────────────────────────────────────────
       Distinct from sold out on purpose, and the distinction is the point: the
       shelf still has stock, this shopper is simply holding all of it. Wording
       that reads as a sell-out here tells them the store is empty because of
       what is in their own bag. See stock-rules.js availability(). */
    lastInBag:      { text: 'The only one is in your bag', color: ROLE.plain },
    allInBag:       { text: 'All {count} are in your bag', color: ROLE.plain },
    maxedOut:       { text: "That's all we have — {count} in your bag already", color: ROLE.plain },
    capReached:     { text: 'Only {count} in stock for {size}', color: ROLE.plain },

    /* ── back in stock ────────────────────────────────────────────────────────
       restockAlready is deliberately NOT red: the shopper asked twice for the
       same thing and the answer is still yes. It was painted as a failure. */
    restockHint:    { text: "Tap a sold-out size to get notified when it's back.", color: ROLE.plain },
    restockPrompt:  { text: "Size {size} is sold out — get notified when it's back", color: ROLE.plain },
    restockSuccess: { text: "✓ We'll email you when {size} is back.", color: ROLE.good },
    restockAlready: { text: "You're already on the list for this size.", color: ROLE.plain },
    restockInvalid: { text: 'Enter a valid email.', color: ROLE.bad },
    restockFailed:  { text: 'Could not save that — try again.', color: ROLE.bad },
  };

  /* What each message is allowed to interpolate. A key absent from here takes
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
    DEFAULTS: DEFAULTS,
    PLACEHOLDERS: PLACEHOLDERS,
    ROLE: ROLE,
    keys: function () { return Object.keys(DEFAULTS); },
    tokensIn: tokensIn,
    validate: validate,
    validateColor: validateColor,
    setOverrides: setOverrides,
    get: get,
    color: color,
    apply: apply,
  };
})(typeof window !== 'undefined' ? window : this);
