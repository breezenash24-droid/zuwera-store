#!/usr/bin/env node
/**
 * price-check — what would the store actually charge?
 *
 * Runs the REAL resolver (functions/api/_price-resolution.js, the same module
 * the checkout imports) over a scenario you describe on the command line. No
 * database, no credentials, no deploy.
 *
 * It exists because the dangerous step in the pricing system is APPROVING a
 * row: approval is live immediately, and the only ways to check the outcome
 * before this were to reason about the ordering rules or to try it on the shop.
 *
 * Usage
 *   node scripts/price-check.js --product 220 --member 198 --msrp 260 \
 *                              --colour 176.97 \
 *                              --list members:150:10 \
 *                              --as member
 *
 *   --product P[,MEMBER,MSRP]   the catalogue price on `products`
 *   --member M                  product member price (or use the comma form)
 *   --msrp M                    product compare-at
 *   --colour P[,MEMBER,MSRP]    this colourway's own price (migration 0021)
 *   --list CODE:AMOUNT[:PRIORITY][:GROUP][@FROM..TO]
 *                               a price-list row (repeatable). Dates are
 *                               YYYY-MM-DD; omit for "always".
 *   --as guest|member           who is shopping (default guest)
 *   --on YYYY-MM-DD             pretend it is this date (default today)
 *   --proposed CODE             treat that list's row as still awaiting
 *                               approval, to prove it changes nothing
 *
 * Examples
 *   # The Nike case: one product, one colour cheaper
 *   node scripts/price-check.js --product 220 --colour 176.97
 *
 *   # A sale that has not started yet
 *   node scripts/price-check.js --product 220 --list sale:176.97:5@2026-09-20..2026-09-27
 *
 *   # Would a member get the premium colour for the product's member price?
 *   node scripts/price-check.js --product 220 --member 198 --colour 250 --as member
 */
const path = require('path');
const { pathToFileURL } = require('url');

function parseArgs(argv) {
  const out = { lists: [], proposed: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--product')  out.product = next();
    else if (a === '--member')   out.memberPrice = next();
    else if (a === '--msrp')     out.msrp = next();
    else if (a === '--colour' || a === '--color') out.colour = next();
    else if (a === '--list')     out.lists.push(next());
    else if (a === '--as')       out.as = next();
    else if (a === '--on')       out.on = next();
    else if (a === '--proposed') out.proposed.push(String(next()).toLowerCase());
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) { console.error('Unknown option: ' + a); process.exit(2); }
  }
  return out;
}

/** "220,198,260" → { current_price, member_price, msrp } */
function priceTriple(spec) {
  if (!spec) return null;
  const [p, m, s] = String(spec).split(',').map((x) => x.trim());
  const num = (v) => (v === undefined || v === '') ? null : Number(v);
  return { current_price: num(p), member_price: num(m), msrp: num(s) };
}

/** "members:150:10:member@2026-09-20..2026-09-27" */
function parseList(spec, index) {
  const [head, window] = String(spec).split('@');
  const [code, amount, priority, group] = head.split(':');
  if (!code || !amount) throw new Error(`--list needs at least CODE:AMOUNT (got "${spec}")`);
  let startsAt = null, endsAt = null;
  if (window) {
    const [from, to] = window.split('..');
    if (from) startsAt = new Date(from + 'T00:00:00Z').toISOString();
    if (to)   endsAt   = new Date(to   + 'T00:00:00Z').toISOString();
  }
  return {
    list: { id: 'L' + index, code, name: code, priority: Number(priority) || 0, active: true,
            customer_group: group || null },
    row: { id: 'R' + index, price_list_id: 'L' + index, product_id: 'P', color_variant_id: null,
           amount: Number(amount), compare_at: null, starts_at: startsAt, ends_at: endsAt,
           status: 'approved' },
  };
}

const $ = (c) => '$' + (Number(c || 0) / 100).toFixed(2);

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.product) {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, ''));
    process.exit(args.help ? 0 : 2);
  }

  const ROOT = path.resolve(__dirname, '..');
  const R = await import(pathToFileURL(path.join(ROOT, 'functions/api/_price-resolution.js')).href);

  const product = { id: 'P', ...priceTriple(args.product) };
  if (args.memberPrice) product.member_price = Number(args.memberPrice);
  if (args.msrp) product.msrp = Number(args.msrp);

  const variant = args.colour ? { id: 'V', color_name: 'the selected colour', ...priceTriple(args.colour) } : null;

  const lists = [], rows = [];
  args.lists.forEach((spec, i) => {
    const { list, row } = parseList(spec, i);
    if (args.proposed.includes(String(list.code).toLowerCase())) row.status = 'proposed';
    lists.push(list); rows.push(row);
  });

  const isMember = String(args.as || 'guest').toLowerCase() === 'member';
  const now = args.on ? Date.parse(args.on + 'T12:00:00Z') : Date.now();
  if (!Number.isFinite(now)) { console.error('--on must be YYYY-MM-DD'); process.exit(2); }

  const shopper = R.shopperFor({ isMember });
  const result = R.resolvePrice({ product, variant, rows, lists, shopper, now });

  const on = new Date(now).toISOString().slice(0, 10);
  console.log('');
  console.log(`  Shopper      ${isMember ? 'signed-in member' : 'guest'}, on ${on}`);
  console.log(`  Product      ${$(Math.round((product.current_price || 0) * 100))}`
    + (product.member_price ? `  member ${$(Math.round(product.member_price * 100))}` : '')
    + (product.msrp ? `  msrp ${$(Math.round(product.msrp * 100))}` : ''));
  if (variant) {
    console.log(`  Colourway    ${variant.current_price ? $(Math.round(variant.current_price * 100)) : '(inherits)'}`
      + (variant.member_price ? `  member ${$(Math.round(variant.member_price * 100))}` : ''));
  }
  if (rows.length) {
    console.log('  Price lists');
    rows.forEach((r, i) => {
      const l = lists[i];
      const win = r.starts_at || r.ends_at
        ? `  ${String(r.starts_at || '').slice(0, 10) || '…'}..${String(r.ends_at || '').slice(0, 10) || '…'}`
        : '';
      const live = R.priceIsLive(r, now);
      const applies = R.listApplies(l, shopper);
      console.log(`    ${l.code.padEnd(12)} $${Number(r.amount).toFixed(2).padStart(8)}  priority ${String(l.priority).padStart(3)}`
        + `${l.customer_group ? '  for ' + l.customer_group + 's' : ''}${win}`
        + `   ${r.status !== 'approved' ? '· ' + r.status : (!applies ? '· not this shopper' : (!live ? '· outside its window' : '· live'))}`);
    });
  }
  console.log('');
  console.log(`  → CHARGED    ${$(result.priceCents)}`);
  console.log(`    compare-at ${result.compareAtCents ? $(result.compareAtCents) : '—'}`);
  console.log(`    because    ${{
    price_list: 'a price list' + (result.priceListCode ? ` (${result.priceListCode})` : ''),
    variant: "this colourway's own price",
    product: "the product's price",
  }[result.source] || result.source}`);
  if (result.ignoredZeroRow) {
    console.log(`    ⚠ ignored a price-list row set to zero (${result.ignoredZeroRow}) and fell back`);
  }
  console.log('');
})().catch((e) => { console.error('\n  ' + e.message + '\n'); process.exit(1); });
