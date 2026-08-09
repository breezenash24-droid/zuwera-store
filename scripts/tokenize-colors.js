#!/usr/bin/env node
/**
 * tokenize-colors.js — replace hardcoded foreground literals with theme tokens.
 *
 *   node scripts/tokenize-colors.js --report                 what's left, everywhere
 *   node scripts/tokenize-colors.js storefront-cohesion.css  convert one file
 *   node scripts/tokenize-colors.js index.html --dry         show, don't write
 *
 * WHY A SCRIPT. Roughly 900 places write the foreground colour as a literal
 * — rgba(244,241,235,.5) — instead of asking the theme for it. Each one is a
 * spot that stays cream when the page turns cream, which is what "light mode is
 * broken" actually means. Nine hundred hand edits would introduce more bugs than
 * they fix; the mapping itself is mechanical, so the machine should do the
 * mechanical part and hand back everything it isn't sure about.
 *
 * WHAT IT CONVERTS, AND WHAT IT REFUSES TO.
 *
 *   rgba(244,241,235,0.30)  →  var(--c30)     the foreground at an opacity.
 *                                             Converted: the ladder already
 *                                             derives from the active theme.
 *
 *   rgba(9,9,11,0.30)       →  left alone     ambiguous. Inside a light-mode
 *                                             block it is the paired override
 *                                             (and becomes redundant once the
 *                                             base rule is tokenised — reported,
 *                                             not deleted). Anywhere else it is
 *                                             a deliberate absolute, like a
 *                                             scrim over a photograph, and
 *                                             converting it would be wrong.
 *
 *   rgba(244,241,235,0.04)  →  rgb(var(--fg-rgb) / 4%)
 *                                             An alpha with no rung. There are
 *                                             38 distinct ones in a long tail —
 *                                             4%, 3%, 2%, 28%, 18%, 90% … — and
 *                                             minting a token for each would
 *                                             trade a small ladder anyone can
 *                                             hold in their head for a glossary
 *                                             of fifty. The derived form is
 *                                             exactly as theme-following and
 *                                             needs no new name. Rungs stay for
 *                                             the values that repeat enough to
 *                                             be worth naming.
 *
 * Never rewrites inside a light-mode or super-light-mode block. Those exist
 * precisely to hardcode the other side, and touching them mid-migration would
 * make a half-converted file wrong in both modes instead of one.
 */

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

// The rungs base.css defines. An alpha only converts on an exact match.
const RUNGS = [6, 7, 8, 10, 12, 14, 15, 20, 30, 35, 40, 45, 50, 55, 65, 70, 80];

const FG = /rgba\(\s*244\s*,\s*241\s*,\s*235\s*,\s*([0-9.]+)\s*\)/g;
const INK = /rgba\(\s*9\s*,\s*9\s*,\s*11\s*,\s*([0-9.]+)\s*\)|rgba\(\s*10\s*,\s*10\s*,\s*10\s*,\s*([0-9.]+)\s*\)/g;

// Files worth touching: the storefront. The admin has its own palette and its
// own dark mode, and is not part of this migration.
const TARGETS = [
  'base.css', 'storefront-cohesion.css', 'cart.css', 'nav.css', 'product.css',
  'reviews.css', 'reviews-vibe.css', 'quick-add-modal.css', 'email-popup.css',
  'storefront-mobile-rebuild.css',
  'index.html', 'product.html', 'drop001.html', 'bag.html', 'checkout.html',
  'account.html', 'about.html', 'journal.html', 'returns.html', 'landing.html',
  'sizeguide.html', 'policies.html', '404.html', 'confirm.html',
  'storefront.js', 'storefront-features.js', 'announcement-bar.js',
];

function alphaToRung(raw) {
  const pct = Math.round(parseFloat(raw) * 100);
  return RUNGS.indexOf(pct) !== -1 ? pct : null;
}

/* Which character ranges sit inside a light-mode / super-light-mode rule.
   Deliberately crude — it finds the selector, then walks braces to the matching
   close. Good enough because these blocks are flat CSS rules, and being crude
   in the safe direction (skipping something convertible) costs a follow-up pass,
   while being crude the other way corrupts a file. */
function protectedRanges(src) {
  const ranges = [];
  const sel = /body\.(?:super-)?light-mode[^{]*\{/g;
  let m;
  while ((m = sel.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    ranges.push([m.index, i]);
  }
  return ranges;
}

function inRanges(pos, ranges) {
  return ranges.some(([a, b]) => pos >= a && pos < b);
}

function convert(src) {
  const protectedR = protectedRanges(src);
  const skipped = new Map();     // alpha → count, the ones with no rung
  let converted = 0, guarded = 0;

  let derived = 0;
  const out = src.replace(FG, (whole, alpha, offset) => {
    if (inRanges(offset, protectedR)) { guarded++; return whole; }
    const rung = alphaToRung(alpha);
    if (rung === null) {
      const pct = +(parseFloat(alpha) * 100).toFixed(2);
      if (!isFinite(pct)) { skipped.set(alpha, (skipped.get(alpha) || 0) + 1); return whole; }
      derived++;
      return `rgb(var(--fg-rgb) / ${pct}%)`;
    }
    converted++;
    return `var(--c${String(rung).padStart(2, '0')})`;
  });

  return { out, converted, derived, guarded, skipped };
}

/* Once a base rule uses the ladder it flips by itself, so the light-mode rule
   that used to do the flipping is dead weight — and worse, it is a second place
   to remember when the design changes. Counting them, not deleting them: which
   overrides are genuinely redundant depends on the selector pair, and that is a
   judgement call per rule rather than a regex. */
function countRedundantOverrides(src) {
  let n = 0;
  for (const [a, b] of protectedRanges(src)) {
    const block = src.slice(a, b);
    INK.lastIndex = 0;
    if (INK.test(block)) n++;
  }
  return n;
}

function report() {
  let totalFg = 0, totalConvertible = 0, totalOverrides = 0;
  const rows = [];
  for (const f of TARGETS) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const { converted, derived, guarded, skipped } = convert(src);
    FG.lastIndex = 0;
    const all = (src.match(FG) || []).length;
    if (!all) continue;
    const unmapped = derived;
    const overrides = countRedundantOverrides(src);
    totalFg += all; totalConvertible += converted; totalOverrides += overrides;
    rows.push({ f, all, converted, guarded, unmapped, overrides });
  }
  rows.sort((x, y) => y.converted - x.converted);
  console.log('\n  file                            literals  convertible  in light-mode  no rung  overrides');
  console.log('  ' + '─'.repeat(92));
  for (const r of rows) {
    console.log('  ' + r.f.padEnd(32) + String(r.all).padStart(8) +
      String(r.converted).padStart(13) + String(r.guarded).padStart(15) +
      String(r.unmapped).padStart(9) + String(r.overrides).padStart(11));
  }
  console.log('  ' + '─'.repeat(92));
  console.log('  ' + 'TOTAL'.padEnd(32) + String(totalFg).padStart(8) +
    String(totalConvertible).padStart(13) + ' '.repeat(15) + ' '.repeat(9) +
    String(totalOverrides).padStart(11));
  console.log('\n  Convert one file:  node scripts/tokenize-colors.js <file>\n');
}

function run(file, dry) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) { console.error('  no such file: ' + file); process.exit(1); }
  const src = fs.readFileSync(p, 'utf8');
  const { out, converted, guarded, skipped } = convert(src);
  console.log(`\n  ${file}`);
  console.log(`    ${converted} converted to tokens`);
  console.log(`    ${guarded} left alone inside light-mode blocks`);
  if (skipped.size) {
    console.log('    no matching rung, left alone:');
    [...skipped.entries()].sort((a, b) => b[1] - a[1])
      .forEach(([a, n]) => console.log(`      alpha ${a} × ${n}`));
  }
  if (dry) { console.log('\n  --dry: nothing written\n'); return; }
  if (converted) fs.writeFileSync(p, out);
  console.log(converted ? '\n  written\n' : '\n  nothing to do\n');
}

const args = process.argv.slice(2);
if (!args.length || args[0] === '--report') report();
else run(args[0], args.includes('--dry'));
