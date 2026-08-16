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
 *
 * ── PHASE TWO: the overrides themselves  (--overrides)  ──────────────────────
 *
 * The base rules are tokenised now, so the pass above finds almost nothing left
 * to do. What it still reports is 388 light-mode blocks holding 1,268 near-black
 * literals — and those are no longer just redundant, they are the thing
 * stopping this store from wearing a theme it does not already ship with.
 *
 * `body.light-mode .summary-row { color: rgba(9,9,11,.65) }` does not mean
 * "light mode". It means "the built-in Light theme's foreground", written out
 * by hand. Add a theme in the admin with a light base and its own colours and
 * that rule still paints near-black, so the new theme can change the page
 * ground and almost nothing else. Half the storefront is pinned to one palette.
 *
 * The conversion is value-preserving, and that is checkable rather than hoped
 * for. base.css declares `body.light-mode { --fg-rgb: 10 10 10 }`, so
 *
 *     rgba(9,9,11,0.65)   →   var(--c65)   →   rgb(10 10 10 / 65%)
 *
 * differs by one part in 255 on two channels and two on the third. Nothing on a
 * screen shows that. What DOES change is the case the store cannot currently
 * reach: theme-engine.js sets --fg-rgb inline on <body>, the ladder on <body>
 * recomputes from it, and every converted rule follows the theme it is actually
 * in. tests/theme-any-theme.test.js re-reads those token declarations out of
 * base.css and fails if the premise ever moves.
 *
 * STILL NOT TOUCHED, on purpose:
 *
 *   white inside a light-mode block — `body.light-mode` rules also apply in
 *   super-light (super-light carries both classes), and white is the light
 *   theme's SURFACE but super-light's PAGE. One literal, two roles, decided by
 *   a cascade that is not local to the rule. Converting it would be a visual
 *   change dressed up as a refactor.
 *
 *   #F0EEE9 — same entanglement in the other direction.
 *
 *   Anything that is not the foreground: accents, the semantic green and red,
 *   scrims over photographs. Those are absolutes and are meant to be.
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

/* A copy of the source with every comment blanked to spaces — same length, so
   offsets found in it are valid in the original.
 *
 * Without this the block finder reads prose as CSS. storefront.js explains the
 * theme system in a comment that contains the lines
 *
 *     body.light-mode { --fg-rgb: … }
 *     body.light-mode .thing { color: #09090b }
 *
 * and a --dry run happily offered to rewrite both of them. That is the same
 * trap as counting <body> inside an explanation of <body>: a tool that reads
 * comments as code will eventually edit one, and the edit lands in the one
 * place nobody re-reads. Blanking rather than deleting keeps every index
 * lined up with the file the replacements are actually written to. */
function maskComments(src, file) {
  const chars = src.split('');
  const blank = (a, b) => { for (let i = a; i < b && i < chars.length; i++) if (chars[i] !== '\n') chars[i] = ' '; };

  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) blank(m.index, m.index + m[0].length);
  for (const m of src.matchAll(/<!--[\s\S]*?-->/g)) blank(m.index, m.index + m[0].length);
  /* Line comments only where they are one: `//` inside a .css file is not a
     comment, and `https://` is not one anywhere. */
  if (!/\.css$/i.test(file || '')) {
    for (const m of src.matchAll(/(^|[^:"'`\\])\/\/[^\n]*/g)) {
      const at = m.index + m[1].length;
      blank(at, at + (m[0].length - m[1].length));
    }
  }
  return chars.join('');
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

/* ── Phase two: the light-mode overrides ────────────────────────────────────
 *
 * Converted IN PLACE rather than deleted. Deleting looks tidier and is the
 * wrong call: which overrides are genuinely redundant depends on the base rule
 * for the same selector, the alphas usually differ by a few percent, and a
 * missing rule is a much harder thing to see than a converted one. In place
 * keeps the cascade, the specificity and the count identical, changes nothing
 * a shopper can see in the three built-in themes, and is the whole fix for a
 * fourth.
 *
 * Foreground only. The opaque forms convert to the bare triplet; the alpha
 * forms to a rung when one matches exactly, and to the derived form otherwise.
 */
const OVERRIDE_ALPHA = /rgba\(\s*(?:9\s*,\s*9\s*,\s*11|10\s*,\s*10\s*,\s*10)\s*,\s*([0-9.]+)\s*\)/g;
const OVERRIDE_SOLID = /#(?:09090b|0a0a0a)\b/gi;

function convertOverrides(src, file) {
  const mask = maskComments(src, file);
  const ranges = protectedRanges(mask);
  if (!ranges.length) return { out: src, alpha: 0, solid: 0, inComments: 0 };

  /* True only where the original still has real code at that offset. */
  const isCode = (at, text) => mask.substr(at, text.length) === text;

  let alpha = 0, solid = 0, inComments = 0;
  /* Rewritten range by range, back to front, so every offset stays valid while
     the string underneath is changing length. Doing it forwards silently
     corrupts the file after the first replacement that is not the same width. */
  let out = src;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const [a, b] = ranges[i];
    let block = out.slice(a, b);

    block = block.replace(OVERRIDE_ALPHA, (whole, raw, at) => {
      if (!isCode(a + at, whole)) { inComments++; return whole; }
      const pct = +(parseFloat(raw) * 100).toFixed(2);
      if (!isFinite(pct)) return whole;
      alpha++;
      const rung = alphaToRung(raw);
      return rung === null
        ? `rgb(var(--fg-rgb) / ${pct}%)`
        : `var(--c${String(rung).padStart(2, '0')})`;
    });

    /* The alpha pass may have changed the block's length, so the solid pass
       cannot reuse offsets into the mask. It runs on the ORIGINAL text first to
       learn which occurrences are real, then rewrites that many. */
    const original = out.slice(a, b);
    const realSolid = [];
    OVERRIDE_SOLID.lastIndex = 0;
    for (const m of original.matchAll(OVERRIDE_SOLID)) realSolid.push(isCode(a + m.index, m[0]));
    let seen = 0;
    block = block.replace(OVERRIDE_SOLID, (whole) => {
      const real = realSolid[seen++];
      if (!real) { inComments++; return whole; }
      solid++;
      return 'rgb(var(--fg-rgb))';
    });

    out = out.slice(0, a) + block + out.slice(b);
  }
  return { out, alpha, solid, inComments };
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

/* Files whose colours are NOT keyed to the page, and which this pass must not
 * touch.
 *
 * quick-add-modal.css is a panel that re-keys the ladder onto itself:
 *
 *     .quick-add-review-modal>.mbox { --c08: color-mix(in srgb, var(--paper) 8%, transparent); … }
 *
 * because a panel painted var(--ink) has to draw its text from the PANEL's
 * foreground, not the page's. In the three built-in themes those are the same
 * colour, so the difference is invisible — until an imported theme sets them
 * apart, and then it is pale grey on white, which is what happened to this
 * modal's size buttons once before. Converting its literals to rgb(var(--fg-rgb))
 * would put the page's foreground back inside the panel and reintroduce exactly
 * that bug. The right mapping here is --paper and the panel's own re-keyed
 * rungs, and which of the two each rule wants is a judgement per rule.
 * tests/theme-tokens.test.js holds the line.
 */
const PANEL_KEYED = ['quick-add-modal.css'];

function runOverrides(dry) {
  let alphaAll = 0, solidAll = 0, commentAll = 0;
  const rows = [];
  for (const f of TARGETS) {
    if (PANEL_KEYED.indexOf(f) !== -1) continue;
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const { out, alpha, solid, inComments } = convertOverrides(src, f);
    commentAll += inComments;
    if (!alpha && !solid) continue;
    /* A conversion must not change the SIZE of the rule set. If a brace walk
       went wrong the count of declarations would move, and that is a corrupted
       file rather than a refactor. */
    const before = (src.match(/\{/g) || []).length;
    const after = (out.match(/\{/g) || []).length;
    if (before !== after) { console.error('  SKIPPED ' + f + ' — brace count moved (' + before + ' → ' + after + ')'); continue; }
    alphaAll += alpha; solidAll += solid;
    rows.push({ f, alpha, solid });
    if (!dry) fs.writeFileSync(p, out);
  }
  console.log('\n  light-mode overrides → theme tokens\n');
  for (const r of rows) {
    console.log('  ' + r.f.padEnd(32) + String(r.alpha).padStart(5) + ' with alpha'
      + String(r.solid).padStart(6) + ' solid');
  }
  console.log('\n  ' + (alphaAll + solidAll) + ' declarations now follow the theme'
    + (dry ? ' (--dry: nothing written)' : ''));
  if (commentAll) console.log('  ' + commentAll + ' left alone — they are examples inside comments, not rules');
  console.log('');
}

const args = process.argv.slice(2);
if (args[0] === '--overrides') runOverrides(args.includes('--dry'));
else if (!args.length || args[0] === '--report') report();
else run(args[0], args.includes('--dry'));
