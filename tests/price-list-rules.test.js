/* A price list that carries a RULE instead of a row per product.
 *
 * ── Why a rule at all ───────────────────────────────────────────────────────
 *
 * "Trade is 40% off" stated as fifty rows is fifty chances to fat-finger a
 * figure, and — the part that actually bites — every product added afterwards
 * has no trade price at all. Nothing errors: pickPrice() finds no row,
 * resolvePrice() falls back to the catalogue, and an approved wholesale buyer
 * is quietly charged full retail on the newest half of the range. The fallback
 * that stops an empty pricing system selling at zero is the same fallback that
 * hides this.
 *
 * ── What is asserted ────────────────────────────────────────────────────────
 *
 * The two things that make a rule safe rather than merely convenient:
 *
 *   PRECEDENCE — an explicit approved row always beats it. A row is a decision
 *   somebody made and signed; a rule is what applies when nobody did.
 *
 *   NO STACKING — a rule prices off the REGULAR catalogue figure, never the
 *   member one. Compounding a trade percentage onto a member price is two
 *   discounts for one entitlement, and it is the shape that sells a $250
 *   colourway for $35.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

(async () => {
  const R = await import('file://' + path.join(ROOT, 'functions', 'api', '_price-resolution.js').replace(/\\/g, '/'));
  const { resolvePrice, shopperFor } = R;
  const fs = require('fs');

  const PRODUCT = { id: 'p1', current_price: 100, member_price: 80, msrp: 120 };
  const TRADE = { id: 'L-trade', code: 'wholesale', customer_group: 'wholesale', priority: 100, active: true, rule_percent_off: 40 };
  const wholesaler = shopperFor({ isMember: false, isWholesale: true });
  const guest = shopperFor({ isMember: false, isWholesale: false });
  const member = shopperFor({ isMember: true, isWholesale: false });
  const memberTrade = shopperFor({ isMember: true, isWholesale: true });

  const price = (shopper, lists, rows) => resolvePrice({
    product: PRODUCT, variant: null, rows: rows || [], lists: lists || [], shopper, now: Date.now(),
  });

  console.log('\n  a price list that carries a rule\n');

  console.log('  the rule prices the catalogue');
  {
    const r = price(wholesaler, [TRADE]);
    ok('40% off $100 is $60', r.priceCents === 6000, String(r.priceCents));
    ok('the source says it came from a rule', r.source === 'price_rule', r.source);
    ok('…and names the list', r.priceListCode === 'wholesale', r.priceListCode);
    ok('the rule percentage is reported back', r.rulePercentOff === 40, String(r.rulePercentOff));

    /* The whole reason a rule beats rows: a product with no row still prices. */
    const fresh = resolvePrice({
      product: { id: 'brand-new', current_price: 250 }, variant: null,
      rows: [], lists: [TRADE], shopper: wholesaler, now: Date.now(),
    });
    ok('a product added later is priced too, with no row for it',
      fresh.priceCents === 15000, String(fresh.priceCents));
  }

  console.log('\n  only the group the list names');
  {
    ok('a guest pays the catalogue price', price(guest, [TRADE]).priceCents === 10000);
    ok('…and it is not marked as ruled', price(guest, [TRADE]).source !== 'price_rule');
    ok('a member still gets the member price, not the trade rule',
      price(member, [TRADE]).priceCents === 8000, String(price(member, [TRADE]).priceCents));
  }

  console.log('\n  no stacking, ever');
  {
    /* $100 catalogue, $80 member. 40% off the MEMBER price would be $48 — two
       discounts for one entitlement. 40% off the regular price is $60. */
    const r = price(memberTrade, [TRADE]);
    ok('a member who is also a trade buyer pays 40% off REGULAR, not off member',
      r.priceCents === 6000, 'got ' + r.priceCents + ' — 4800 means it compounded');
    ok('…and no member figure is quoted alongside it', r.memberCents === 0 && r.usingMember === false,
      'quoting one invites the compounding this exists to refuse');
  }

  console.log('\n  an explicit row always wins');
  {
    const row = {
      id: 'row1', price_list_id: 'L-trade', product_id: 'p1',
      amount: 35, status: 'approved', starts_at: null, ends_at: null,
    };
    const r = price(wholesaler, [TRADE], [row]);
    ok('the row is charged, not the rule', r.priceCents === 3500, String(r.priceCents));
    ok('…and the source says so', r.source === 'price_list', r.source);
  }

  console.log('\n  a rule that would do harm does nothing');
  {
    const bad = (pct) => price(wholesaler, [{ ...TRADE, rule_percent_off: pct }]).priceCents;
    ok('100% off falls back rather than selling for nothing', bad(100) === 10000, String(bad(100)));
    ok('a negative discount does not raise the price', bad(-20) === 10000, String(bad(-20)));
    ok('zero is not a rule', bad(0) === 10000, String(bad(0)));
    ok('nonsense is ignored', bad('abc') === 10000, String(bad('abc')));
    ok('a list with no rule prices nothing by itself',
      price(wholesaler, [{ ...TRADE, rule_percent_off: null }]).priceCents === 10000);
  }

  console.log('\n  two rules cannot disagree between runs');
  {
    const a = { ...TRADE, id: 'A', code: 'a', priority: 10, rule_percent_off: 10 };
    const b = { ...TRADE, id: 'B', code: 'b', priority: 90, rule_percent_off: 50 };
    ok('the higher priority wins', price(wholesaler, [a, b]).priceCents === 5000);
    ok('…whichever order they arrive in', price(wholesaler, [b, a]).priceCents === 5000);
  }

  console.log('\n  the column the resolver reads is the column it asks for');
  {
    /* A column left out of the select is undefined by the time the rule is
       read, so the rule never fires and every trade buyer is charged retail
       with nothing logged. Invisible at the only place it could be noticed. */
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'api', '_price-resolution.js'), 'utf8');
    const sel = /price_lists\?select=([^'"&]+)/.exec(src);
    ok('the price_lists select was found', !!sel, 'the query has been reshaped');
    ok('…and it asks for rule_percent_off',
      !!sel && sel[1].split(',').includes('rule_percent_off'),
      sel ? sel[1] : '');

    const mig = fs.readFileSync(path.join(ROOT, 'migrations', '0025_a_price_list_can_carry_a_rule.sql'), 'utf8');
    ok('the migration adds that same column', /add column if not exists rule_percent_off/.test(mig));
    ok('…and refuses 0 and 100 at the database',
      /rule_percent_off > 0 and rule_percent_off < 100/.test(mig),
      '100 prices at zero; 0 looks like a rule and is not one');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
