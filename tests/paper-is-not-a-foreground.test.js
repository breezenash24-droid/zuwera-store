/* --paper means a surface at :root and a foreground under the light classes.
 *
 * storefront-cohesion.css declares both:
 *
 *   :root                  { --paper: var(--zw-paper) }    → #f4f1eb, a panel
 *   body.light-mode        { --paper: rgb(var(--fg-rgb)) } → text
 *   body.super-light-mode  { --paper: rgb(var(--fg-rgb)) } → text
 *
 * One name, two opposite jobs, and which one you get depends on whether a class
 * has matched yet. index.html used it as TEXT in 29 rules and as a SURFACE in
 * 37 — so on any frame where neither the light classes nor the build's baked
 * block is in effect, the page, the announcement bar, the wordmark and the hero
 * headline all painted CREAM on a white ground, while the 37 surface uses went
 * dark. A perfectly inverted header.
 *
 * That is the "the header loads wrong on first paint" report, and unlike a
 * race it does not need bad luck: it is what the stylesheet says to do.
 *
 * ── What is asserted ────────────────────────────────────────────────────────
 *
 * The PAGE-LEVEL text rules — the ones drawing on the page's own ground — must
 * name --fg-rgb, which has exactly one meaning in every theme and at every
 * stage. Not every use: text sitting ON a --paper surface is correctly --ink's
 * partner, and a blanket swap would set those to their own background.
 *
 * A budget rather than a ban, for the same reason the brand-literal budget is
 * one: 29 rules cannot be converted safely in a single pass, and a number that
 * only goes down is how the rest get done without pretending they are already
 * done.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = (css) => {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(strip(css)))) out.push({ sel: m[1].trim().split('\n').pop().trim(), body: m[2] });
  return out;
};

console.log('\n  --paper is a surface, not a foreground\n');

console.log('  the token really does mean two things');
{
  const coh = fs.readFileSync(path.join(ROOT, 'storefront-cohesion.css'), 'utf8');
  const rootPaper = rules(coh).find((r) => r.sel === ':root' && /--paper\s*:/.test(r.body));
  const lightPaper = rules(coh).find((r) => r.sel === 'body.light-mode' && /--paper\s*:/.test(r.body));
  ok(':root defines --paper', !!rootPaper);
  ok('body.light-mode redefines it', !!lightPaper);
  /* If these ever agree, the whole hazard is gone and this file can be deleted
     — which is worth detecting rather than assuming. */
  const rv = rootPaper && /--paper\s*:\s*([^;]+)/.exec(rootPaper.body)[1].trim();
  const lv = lightPaper && /--paper\s*:\s*([^;]+)/.exec(lightPaper.body)[1].trim();
  ok('…and they still disagree, which is why this test exists',
    rv !== lv, 'both now say ' + rv + ' — if that is deliberate, delete this suite');
}

console.log('\n  the page-level text rules name the foreground');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  /* The four that draw directly on the page's ground. Each was cream-on-white
     for one frame per deploy. */
  const PAGE_LEVEL = [
    ['body', 'the page text'],
    ['#bar', 'the announcement bar'],
    ['.nav-logo', 'the wordmark'],
    ['.hero-h1', 'the hero headline'],
  ];
  for (const [sel, what] of PAGE_LEVEL) {
    const r = rules(html).find((x) => x.sel === sel && /(?:^|;)\s*color\s*:/.test(x.body));
    ok(what + ' (' + sel + ') has a colour rule', !!r, 'the selector has moved');
    if (!r) continue;
    const c = /(?:^|;)\s*color\s*:\s*([^;]+)/.exec(r.body)[1].trim();
    ok('…and it is the foreground, not --paper',
      /var\(--fg-rgb\)/.test(c), sel + ' → color: ' + c);
  }
}

console.log('\n  the rest is a budget that only goes down');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  let asText = 0;
  for (const r of rules(html)) {
    for (const d of r.body.split(';')) {
      const [prop, val] = d.split(':');
      if (!prop || !val) continue;
      const p = prop.trim();
      if (p.startsWith('--')) continue;
      if (p !== 'color' && p !== '-webkit-text-fill-color') continue;
      if (/--paper\b/.test(val)) asText++;
    }
  }
  /* 29 → 25 with the four page-level rules converted. Lower it when more are
     done; it must never rise. A rule using --paper as text is correct ONLY
     while the light classes are in effect, and the first frame is the one time
     they might not be. */
  const BUDGET = 25;
  ok('no new --paper-as-text rules on the homepage', asText <= BUDGET,
    asText + ' rules use --paper as a colour (budget ' + BUDGET + ')');
  ok('…and the budget is not stale', asText >= BUDGET - 3,
    'only ' + asText + ' left — lower BUDGET to ' + asText);
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
