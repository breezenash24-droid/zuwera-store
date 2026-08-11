/**
 * The shopper-facing copy the PAYMENT PATH uses, editable from the same admin
 * panel as the storefront's.
 *
 * WHY THERE IS A SECOND COPY OF THIS
 * customer-messages.js is a classic browser script that assigns to `window`;
 * this is an ES module running in a Cloudflare Worker. Neither can import the
 * other, so the defaults for the keys the server needs are repeated here — and
 * tests/customer-messages.test.js asserts the two are character-for-character
 * identical. That is the same "two lists must stay identical" arrangement this
 * codebase already uses where a shared import is impossible; the duplication is
 * deliberate, checked, and the alternative was a build step.
 *
 * soldOutItem is deliberately the SAME key the product page and the bag use.
 * "Out of stock" had five different wordings across the storefront and a sixth
 * here, which is how a shopper could be told "Only 1 left" on one screen and
 * "is out of stock" on the next. One situation, one sentence, wherever it is
 * said.
 *
 * The remaining keys are checkout's alone: they describe things that can only
 * go wrong once money is involved, and nothing in the browser can produce them.
 */

const TOKEN = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

/* Must match customer-messages.js exactly for every key that appears in both.
   Colours are not here: nothing in a Worker renders anything. */
export const DEFAULTS = {
  soldOutItem:          '{title} ({size}) is out of stock',
  checkoutNotEnough:    'Only {count} left in stock for {title} ({size}).',
  checkoutUnavailable:  'Product is no longer available: {title}',
  checkoutNoPrice:      'Product has no checkout price: {title}',
  checkoutPriceChanged: 'The price of {title} has changed. Refresh your bag to see the current price before paying.',
  checkoutRateExpired:  'Selected shipping rate expired. Please reload shipping options.',
  checkoutRateInvalid:  'Invalid shipping rate — please reload shipping options.',
};

/* Same substitution as the browser's: a token with no value collapses, empty
   brackets go before the whitespace is tidied, so a half-supplied message reads
   as a short sentence rather than as broken software. */
function fill(template, vars) {
  const v = vars || {};
  return String(template == null ? '' : template)
    .replace(TOKEN, (whole, name) => {
      const value = v[name];
      return (value === undefined || value === null || value === '') ? '' : String(value);
    })
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Build the message function for this request from an already-loaded
 * commerce_config, so no extra settings read happens on the payment path.
 *
 * An override is used only when it is a non-empty string. Anything else — a
 * number, an object, a blank box — falls back to the shipped copy, because the
 * one thing a refusal must never be is empty: a shopper told "no" with no
 * reason cannot act, and this is the moment they are trying to pay.
 *
 * @param cfg parsed commerce_config, or anything at all — this never throws.
 * @returns (key, vars) => string
 */
export function messagesFrom(cfg) {
  let overrides = {};
  try {
    const raw = cfg?.customerExperience?.messages;
    if (raw && typeof raw === 'object') overrides = raw;
  } catch (_) { overrides = {}; }

  return (key, vars) => {
    let template = DEFAULTS[key];
    const entry = overrides[key];
    /* Both stored shapes: a bare string, and { text, color } — the browser
       gained colours later and old settings keep working. */
    const text = (entry && typeof entry === 'object') ? entry.text : entry;
    if (typeof text === 'string' && text.trim()) template = text.trim();
    return fill(template, vars);
  };
}

/** The shipped copy, for callers with no settings to hand. */
export const shippedMessages = messagesFrom(null);
