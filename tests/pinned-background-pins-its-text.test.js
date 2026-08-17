/* A surface that pins its own background must pin its own text.
 *
 * ── The bug, three times over ───────────────────────────────────────────────
 *
 * The cookie banner's Accept button:
 *
 *     #cookie-banner button:first-child { background:#f4f1eb; color:rgb(var(--fg-rgb)) }
 *
 * The background is a constant. The foreground is the PAGE's, and in dark mode
 * --fg-rgb is `244 241 235` — which IS #f4f1eb. The label was painted in
 * exactly its own background colour: a button with nothing written on it, on
 * every dark-theme load, for as long as the rule existed. The comment above it
 * said it had been "fixed so both read".
 *
 * The email popup, twice: its light block pinned --zwp-bg to #ffffff and took
 * every foreground from --fg-rgb, and the selector for the admin's explicit
 * "light" choice carries no body class at all — so a light popup on a dark page
 * drew near-white text on a white card. Its dark block had the same fault
 * pointing the other way, which is why nobody caught it from the other theme.
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 *
 * Mixing a literal background with a token foreground is only safe when
 * something guarantees the two agree. The body theme class is that guarantee:
 * inside `body.light-mode …`, --fg-rgb is the light theme's dark value and
 * cannot be anything else. Outside it, nothing is promised — the class can be
 * absent, or an inline style from theme-engine.js can move the token while the
 * class says otherwise, and the two meet in the middle.
 *
 * So the rule is not "never mix". It is: pin BOTH, or scope the rule to the
 * class that pins the polarity for you.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

/* Backgrounds light enough that near-white text disappears on them. */
const LIGHT_BG = /^\s*(#fff(f{3})?|#f[0-9a-f]{5}|white|rgb\(\s*255[\s,]+255[\s,]+255\s*\))\s*$/i;
/* Foregrounds whose polarity is decided somewhere else and can flip. */
const FLIPPABLE = /var\(\s*--(fg-rgb|paper|white|ink)\b|(^|[^-\w])inherit\b/;
/* The guarantee: a selector scoped to a theme class, where --fg-rgb is fixed. */
const PINS_POLARITY = /body\.(light-mode|super-light-mode|dark)/;

function rules(css) {
  const out = [];
  /* Comments first, or they leak into both halves. The block above this file's
     own scanner quotes `rgb(var(--fg-rgb))` while EXPLAINING the bug, and a
     scanner that reads its own prose finds faults that are descriptions. The
     same slip in the other direction hides real ones inside a commented-out
     rule. */
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    /* Bounded to a single rule body — a lazy [\s\S]*? here runs past the first
       close brace and attributes a declaration to the wrong selector, which is
       how a scanner in this repo once reported a colour 400 lines away. */
    out.push({ sel: m[1].trim(), body: m[2] });
  }
  return out;
}

const decl = (body, prop) => {
  const m = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;!]+)').exec(body);
  return m ? m[1].trim() : null;
};

console.log('\n  a pinned background pins its text\n');

const files = fs.readdirSync(ROOT).filter((f) => /\.css$/.test(f) && !/\.min\./.test(f));

console.log('  the scan actually ran');
{
  ok('stylesheets were found', files.length > 5, String(files.length));
  const total = files.reduce((n, f) => n + rules(fs.readFileSync(path.join(ROOT, f), 'utf8')).length, 0);
  ok('rules were parsed out of them', total > 500, String(total));
}

console.log('\n  no surface pins a light background and borrows its text');
{
  const offenders = [];
  for (const f of files) {
    for (const r of rules(fs.readFileSync(path.join(ROOT, f), 'utf8'))) {
      const bg = decl(r.body, '(?:background|background-color)');
      if (!bg || !LIGHT_BG.test(bg)) continue;
      const fg = decl(r.body, 'color');
      if (!fg || !FLIPPABLE.test(fg)) continue;
      /* Scoped to a theme class → the class pins --fg-rgb, so they agree. */
      if (PINS_POLARITY.test(r.sel)) continue;
      offenders.push(f + '  ' + r.sel.split('\n').pop().trim().slice(0, 70)
        + '  { background:' + bg + '; color:' + fg + ' }');
    }
  }
  ok('every light-pinned surface names its own text colour',
    offenders.length === 0, '\n      ' + offenders.join('\n      '));
}

console.log('\n  the two that were actually invisible');
{
  const cohesion = fs.readFileSync(path.join(ROOT, 'storefront-cohesion.css'), 'utf8');
  const accept = rules(cohesion).find((r) => /#cookie-banner button:first-child/.test(r.sel));
  ok('the Accept button rule still exists', !!accept);
  const acceptFg = accept ? decl(accept.body, 'color') : '';
  ok('…and its label is not drawn from --fg-rgb',
    !!acceptFg && !FLIPPABLE.test(acceptFg), 'got ' + acceptFg);
  /* The specific collision: in dark mode --fg-rgb IS 244 241 235, which is
     #f4f1eb, which is this button's background. */
  ok('…so it cannot resolve to its own background again',
    !!acceptFg && acceptFg.replace(/\s/g, '').toLowerCase() !== '#f4f1eb',
    'got ' + acceptFg);

  const popup = fs.readFileSync(path.join(ROOT, 'email-popup.css'), 'utf8');
  const lightBlock = rules(popup).find((r) => /\.zwp-root\[data-theme="light"\]/.test(r.sel));
  ok('the popup light block still exists', !!lightBlock);
  ok('…and none of its tokens flip with the page',
    !!lightBlock && !FLIPPABLE.test(lightBlock.body),
    'still flippable: ' + (lightBlock ? (lightBlock.body.match(FLIPPABLE) || [''])[0] : ''));

  const darkBlock = rules(popup).find((r) => /^\.zwp-root$/.test(r.sel.trim()));
  ok('the popup dark block does not flip either',
    !!darkBlock && !FLIPPABLE.test(darkBlock.body),
    'the same fault points the other way and only shows in the other theme');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
