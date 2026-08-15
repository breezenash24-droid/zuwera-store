/**
 * variant-price.js — what ONE colourway costs, in the browser.
 *
 * The browser half of functions/api/_variant-price.js. It exists twice because
 * the browser has to render a swatch change and a Worker has to decide the
 * charge, and a Worker cannot load an IIFE — the same split stock-rules.js
 * already lives with.
 *
 * TWO COPIES ARE ONLY SAFE BECAUSE OF THE PARITY TEST.
 * tests/variant-pricing.test.js runs both over one table of cases and fails on
 * any disagreement. Editing this file without editing its twin turns CI red on
 * the same commit — which is the whole point, because the last time two pieces
 * of code answered a pricing question independently the bag said $35 and
 * checkout charged $40.
 *
 * THE RULE (identical to the server's, deliberately):
 *   current_price set on the colour  → that colour's own current_price,
 *                                      member_price and msrp apply, INCLUDING
 *                                      when the last two are null.
 *   current_price not set            → every figure comes from the product.
 *
 * All-or-nothing, so a $250 limited colourway cannot inherit the product's $35
 * member price and end up cheaper for members than the standard colour.
 */
(function () {
  'use strict';

  function priceCents(value) {
    if (value === null || value === undefined || value === '') return 0;
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.round(n * 100);
  }

  /* current_price is the switch, and the only one. A colour with a member price
     but no regular price is a data mistake, not an instruction — honouring it
     would give a colour nothing but a discounted price. */
  function variantOverrides(variant) {
    return priceCents(variant && variant.current_price) > 0;
  }

  function resolveVariantPrice(product, variant, isMember) {
    var p = product || {};
    var own = variantOverrides(variant);
    var src = own ? variant : p;

    var regularCents = own
      ? priceCents(src.current_price)
      : priceCents(p.current_price !== null && p.current_price !== undefined ? p.current_price : p.price);
    var memberCents = priceCents(src.member_price);
    var msrpCents   = priceCents(src.msrp);

    /* Only when it is actually cheaper. A member price above the regular one is
       a typo, and honouring it would charge somebody more for being a member. */
    var useMember = Boolean(isMember) && memberCents > 0 && (!regularCents || memberCents < regularCents);

    return {
      regularCents: regularCents,
      memberCents: memberCents,
      msrpCents: msrpCents,
      priceCents: useMember ? memberCents : regularCents,
      usingMember: useMember,
      source: own ? 'variant' : 'product'
    };
  }

  /* The "from $X" a grid shows before a colour is chosen. Colourways priced at
     zero are skipped: they cannot be sold (the server refuses them), and
     advertising "from $0" because one colour is misconfigured is worse than
     showing the product's own price. */
  function lowestPriceCents(product, variants, isMember) {
    var list = Array.isArray(variants) ? variants : [];
    var base = resolveVariantPrice(product, null, isMember).priceCents;
    var low = base > 0 ? base : 0;
    var anyOverride = false;
    var i, cents;

    for (i = 0; i < list.length; i++) {
      if (!variantOverrides(list[i])) continue;
      anyOverride = true;
      cents = resolveVariantPrice(product, list[i], isMember).priceCents;
      if (cents > 0 && (low === 0 || cents < low)) low = cents;
    }

    var prices = {};
    var count = 0;
    for (i = 0; i < list.length; i++) {
      if (!variantOverrides(list[i])) continue;
      cents = resolveVariantPrice(product, list[i], isMember).priceCents;
      if (!prices[cents]) { prices[cents] = 1; count++; }
    }
    var hasPlain = false;
    for (i = 0; i < list.length; i++) if (!variantOverrides(list[i])) hasPlain = true;
    if (anyOverride && hasPlain && base > 0 && !prices[base]) { prices[base] = 1; count++; }

    return { lowestCents: low, varies: count > 1 };
  }

  window.ZWVariantPrice = {
    cents: priceCents,
    overrides: variantOverrides,
    resolve: resolveVariantPrice,
    lowest: lowestPriceCents
  };
})();
