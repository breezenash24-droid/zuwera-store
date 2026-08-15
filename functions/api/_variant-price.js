/**
 * _variant-price.js — what ONE colourway costs.
 *
 * Price lived on the product, and colour lived in color_variants, so every
 * colourway of a product had to cost the same. That is not how the thing being
 * modelled works: a limited colour, a collaboration, or a colour left over from
 * last season are routinely different money, and a store that cannot say so has
 * to either leave margin on the table or split one product into several — which
 * breaks the swatch row, the reviews and the stock.
 *
 * ── THE RULE, AND WHY IT IS ALL-OR-NOTHING ──────────────────────────────────
 *
 * A colour variant either carries its own prices or it carries none:
 *
 *   variant.current_price IS SET   → the variant's own current_price,
 *                                    member_price and msrp apply, INCLUDING
 *                                    when those two are null.
 *   variant.current_price IS NULL  → every figure comes from the product.
 *
 * One switch, no mixed states. The tempting alternative — fall back field by
 * field — produces the worst possible bug in this system: a premium colourway
 * priced at $250 that inherits the product's $35 member price, so members buy
 * the expensive colour for less than the cheap one. Field-by-field inheritance
 * reads as more helpful and is the reason that would happen silently.
 *
 * The cost is real and worth stating: an admin who sets a colour's price and
 * forgets its member price gives that colour no member discount. That direction
 * is the safe one — nobody is charged more than shown, and nobody is
 * accidentally sold a $250 shoe for $35 — and the admin says so at the point of
 * entry rather than leaving it to be discovered.
 *
 * ── ONE RULE, TWO RUNTIMES ──────────────────────────────────────────────────
 *
 * The browser needs this to render a swatch change and the server needs it to
 * decide the charge, and a Worker cannot load a browser IIFE. So it exists twice
 * — here and in variant-price.js — exactly as stock-rules.js already mirrors
 * the stock rules. What keeps them honest is tests/variant-pricing.test.js,
 * which runs BOTH over the same table of cases and fails on any disagreement.
 * Two copies with a parity test is a deliberate trade; two copies without one is
 * how the bag came to say $35 while checkout charged $40.
 */

/** Dollars (number|string|null) → integer cents, or 0 for anything unusable. */
export function priceCents(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

/**
 * Does this variant set its own prices?
 *
 * `current_price` is the switch, and deliberately the ONLY switch. A variant
 * with a member price but no regular price is a data mistake rather than an
 * instruction — honouring it would mean a colour whose only price is its
 * discounted one.
 */
export function variantOverrides(variant) {
  return priceCents(variant && variant.current_price) > 0;
}

/**
 * The prices for one (product, colour) pair.
 *
 * Returns integer cents throughout plus `source`, which is what lets an admin
 * screen and a support answer say WHERE a figure came from — the question asked
 * every time a customer reports a price they did not expect.
 */
export function resolveVariantPrice(product, variant, isMember) {
  const p = product || {};
  const own = variantOverrides(variant);
  const src = own ? variant : p;

  /* Products carry the older `price` as well as `current_price`; variants only
     ever have current_price, so the fallback is harmless on that branch and
     necessary on this one. */
  const regularCents = own ? priceCents(src.current_price)
                           : priceCents(p.current_price ?? p.price);
  const memberCents  = priceCents(src.member_price);
  const msrpCents    = priceCents(src.msrp);

  /* Member pricing applies only when it is actually cheaper. A member price
     ABOVE the regular one is a data entry error, and charging it would be
     charging somebody more for being a member. */
  const useMember = Boolean(isMember) && memberCents > 0 && (!regularCents || memberCents < regularCents);

  return {
    regularCents,
    memberCents,
    msrpCents,
    priceCents: useMember ? memberCents : regularCents,
    usingMember: useMember,
    source: own ? 'variant' : 'product',
  };
}

/**
 * The lowest price across a product's colourways — the "from $X" a grid shows
 * when it has no colour selected yet.
 *
 * Counts only colours that could actually be bought at that figure: a variant
 * priced at 0 is unsellable (resolveCatalogItems refuses it) and advertising a
 * product "from $0" because one colourway is misconfigured is worse than
 * showing the product's own price.
 */
export function lowestPriceCents(product, variants, isMember) {
  const list = Array.isArray(variants) ? variants : [];
  const base = resolveVariantPrice(product, null, isMember).priceCents;
  let low = base > 0 ? base : 0;
  let anyOverride = false;

  for (const v of list) {
    if (!variantOverrides(v)) continue;
    anyOverride = true;
    const cents = resolveVariantPrice(product, v, isMember).priceCents;
    if (cents > 0 && (low === 0 || cents < low)) low = cents;
  }

  /* When NO colour overrides, every colour is the product price and there is
     nothing to say "from" about. The caller uses `varies` to decide between
     "$220" and "from $176.97". */
  const prices = new Set(
    list.filter(variantOverrides).map((v) => resolveVariantPrice(product, v, isMember).priceCents)
  );
  if (anyOverride && list.some((v) => !variantOverrides(v)) && base > 0) prices.add(base);

  return { lowestCents: low, varies: prices.size > 1 };
}
