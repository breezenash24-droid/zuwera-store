/* Stock comes back to the row it left from.
 *
 * THE BUG. Restocking a returned "M / Cyan" failed with "Size/color row not
 * found" — on an order that had sold and decremented that exact garment without
 * complaint. The restock modal looked the row up itself:
 *
 *     .eq('size', op.size).eq('color_name', op.color)
 *
 * which is character-for-character the matching migration 0007 took OUT of
 * decrement_stock, and for the same reasons: case-sensitive, whitespace-
 * sensitive, no size folding, and no fallback for the colour-agnostic rows that
 * legacy products use. A garment stored as "cyan" is unreachable from a return
 * saying "Cyan". A product with one row per size and color_name NULL is
 * unreachable from any return at all.
 *
 * WHY IT LASTED. It is quieter than the sell-side version and worse for it. The
 * refund goes out, the customer is made whole, the garment is physically back on
 * the shelf — and the storefront still lists it sold out. Nothing anywhere says
 * the stock never went back, so it stays unsellable until someone edits it by
 * hand and happens to notice.
 *
 * THE PROPERTY. Not "restock matches decrement" — two things maintained in step
 * drift the moment one is edited. There is ONE function that answers "which row
 * describes this garment", and both sides call it.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SQL = fs.readFileSync(path.join(ROOT, 'migrations/0013_restock_uses_the_same_row_rule.sql'), 'utf8');
const UI = fs.readFileSync(path.join(ROOT, 'admin-returns-ui.js'), 'utf8');

/* Comments in this migration quote the old broken matching on purpose, so the
   assertions below must read the SQL, not the prose explaining it. */
const CODE = SQL.replace(/^--.*$/gm, '');

console.log('\n  restock parity\n');

console.log('  one function decides which row a garment is');
{
  ok('zw_find_size_row exists', /CREATE OR REPLACE FUNCTION public\.zw_find_size_row/.test(CODE));
  ok('…and selling calls it',
    /FUNCTION public\.decrement_stock[\s\S]*?zw_find_size_row\(p_product_id, p_size, p_color_name\)/.test(CODE));
  ok('…and returning calls it',
    /FUNCTION public\.restock_stock[\s\S]*?zw_find_size_row\(p_product_id, p_size, p_color_name\)/.test(CODE));

  /* The point of extracting it. If either side still carried the WHERE clause,
     the two could disagree again on the next edit. */
  const decrement = CODE.slice(CODE.indexOf('FUNCTION public.decrement_stock'), CODE.indexOf('FUNCTION public.restock_stock'));
  ok('selling keeps no copy of the matching rule',
    !/color_name IS NULL/.test(decrement) && !/lower\(btrim/.test(decrement));
  const restock = CODE.slice(CODE.indexOf('FUNCTION public.restock_stock'));
  ok('returning keeps no copy either',
    !/color_name IS NULL/.test(restock) && !/lower\(btrim/.test(restock));
}

console.log('\n  and it matches the way the storefront matched');
{
  const finder = CODE.slice(CODE.indexOf('FUNCTION public.zw_find_size_row'), CODE.indexOf('FUNCTION public.decrement_stock'));
  ok('colour is compared normalised, not exactly',
    /lower\(btrim\(coalesce\(color_name, ''\)\)\) = lower\(btrim\(p_color_name\)\)/.test(finder),
    'this is the whole bug: "Cyan" must find "cyan"');
  ok('size is folded, so XXL finds 2XL', /zw_canon_size\(size\) = zw_canon_size\(p_size\)/.test(finder));
  ok('it falls back to colour-agnostic rows', /AND color_name IS NULL/.test(finder));

  /* The dangerous direction. Falling back to ANOTHER colour's row is what made a
     sold colour never decrement while an unsold one drained to zero — 0007's
     second bug. It must not come back through the restock door. */
  const fallback = finder.slice(finder.indexOf('IF v_id IS NULL'));
  ok('…and never to a different colour',
    /color_name IS NULL/.test(fallback) && !/color_name\s*=\s*/.test(fallback),
    'another colour is a different garment');
  ok('no match returns NULL rather than a guess', /RETURN v_id;/.test(finder));
}

console.log('\n  the admin screen stopped answering it separately');
{
  ok('the restock modal calls the RPC', /sb\.rpc\('restock_stock'/.test(UI));
  ok('…and no longer matches colour itself', !/\.eq\('color_name', op\.color\)/.test(UI));
  ok('…nor size', !/\.eq\('size', op\.size\)/.test(UI));
  ok('…and stopped writing product_sizes directly',
    !/from\('product_sizes'\)\.update\(/.test(UI),
    'a direct update bypasses the shared rule');

  /* Reporting a restock that did not happen is the failure mode that made this
     survivable for so long: the shop believes the garment is back. */
  ok('zero rows changed is surfaced, not swallowed', /if \(!Number\(changed\)\)/.test(UI));
  ok('…with a message naming what did not match',
    /Nothing in the catalogue matches/.test(UI) && /op\.sku/.test(UI));
  ok('…and it does not claim success', UI.indexOf('if (!Number(changed))') < UI.indexOf('Items restocked successfully'));
}

console.log('\n  the migration is real and reachable');
{
  const reg = fs.readFileSync(path.join(ROOT, 'functions/api/_migrations.js'), 'utf8');
  ok('0013 is registered for the admin apply button', /0013/.test(reg));
  ok('it grants execute to the admin session, which is what calls it',
    /GRANT EXECUTE ON FUNCTION public\.restock_stock[\s\S]{0,60}TO authenticated/.test(SQL));
  /* SECURITY DEFINER here would hand product_sizes writes to anyone who could
     reach the RPC. The admin already has the rights through RLS. */
  ok('…without escalating privileges to do it', !/SECURITY DEFINER/.test(CODE));
  ok('restocking has no upper clamp that could swallow returned stock',
    /stock_quantity = coalesce\(stock_quantity, 0\) \+ p_qty/.test(CODE));
  ok('…while selling still cannot go below zero',
    /GREATEST\(0, coalesce\(stock_quantity, 0\) - p_qty\)/.test(CODE));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
