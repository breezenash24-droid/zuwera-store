/* A theme cannot make text invisible.
 *
 * This exists because I did exactly that, to the whole live site, in one line.
 *
 * ── WHAT HAPPENED ───────────────────────────────────────────────────────────
 *
 * The bag panel read --zw-page / --zw-ink for its ground and text, and nothing
 * set those from the theme — so in dark mode it opened as a cream card with
 * dark text under a dark header. The obvious fix was to have theme-engine.js
 * set them from the theme's bg/fg. It shipped, and copy went invisible on the
 * homepage, the product page and the collection.
 *
 * --zw-ink is NOT a semantic foreground. It is a LITERAL near-black, declared
 * once at :root, read as `color:` in 21 rules and as `background:` in 8. Those
 * rules were written against it being near-black in EVERY mode. Pointing it at
 * the theme's foreground turned 21 of them into near-white text on surfaces
 * that had stayed light.
 *
 * ── THE INVARIANT, AND WHY IT IS THIS ONE ───────────────────────────────────
 *
 * "Used in both color: and background: roles" is NOT the discriminator — it was
 * my first guess and the measurement killed it. --fg-rgb is read as `color:`
 * 136 times and as `background:` 131 times, and every one of those is correct:
 * rgb(var(--fg-rgb) / 8%) is a legitimate background DERIVED from the
 * foreground.
 *
 * The real difference is whether the stylesheets already declare the token
 * per-mode. Every polarity-flipping token the engine legitimately drives —
 * --fg-rgb, --bg-rgb, --ink, --paper, --black, --white, --zw-theme-surface —
 * is redefined under body.light-mode / body.super-light-mode, so every rule
 * reading it was written knowing it flips. --zw-ink is declared exactly once.
 * A token declared once is a CONSTANT, and rules depend on its constancy.
 *
 *   A token the engine sets from the theme's fg / bg / ink / paper must
 *   already be declared per-mode in the stylesheets.
 *
 * The second half of this file stops caring how the colours got there and just
 * checks the answer: resolve each mode's ground and text and measure the
 * contrast. That catches an unreadable pair however it was introduced.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const ENGINE = fs.readFileSync(path.join(ROOT, 'theme-engine.js'), 'utf8');
const SHEETS = ['base.css', 'storefront-cohesion.css', 'nav.css', 'product.css']
  .filter((f) => fs.existsSync(path.join(ROOT, f)))
  .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));

/* Custom-property declarations, per scope. Only the scopes that carry a whole
   palette — a token declared on some component is not a mode definition. */
const SCOPES = [':root', 'body', 'body.light-mode', 'body.super-light-mode'];
function declarations() {
  const out = {}; SCOPES.forEach((s) => { out[s] = {}; });
  for (const text of SHEETS) {
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(text))) {
      /* SPLIT ON COMMAS. Taking the last line of the selector text was enough
         until a rule was written as `body.light-mode,\nbody.super-light-mode` —
         and then this silently recorded only the second half, so the test
         reported light mode as still carrying the old value. A parser that
         models CSS wrongly does not fail; it lies. */
      const sels = m[1].split(',').map((s) => s.trim().split('\n').pop().trim());
      const body = m[2];
      for (const sel of sels) {
        if (!SCOPES.includes(sel)) continue;
        const dre = /(--[a-z0-9-]+)\s*:\s*([^;]+)/g;
        let d;
        while ((d = dre.exec(body))) {
          if (out[sel][d[1]] === undefined) out[sel][d[1]] = d[2].trim();
        }
      }
    }
  }
  return out;
}
const DECL = declarations();

/* What the engine writes, and which theme field it writes from. */
function engineAssignments() {
  const out = {};
  const re = /set\('(--[a-z0-9-]+)',\s*([^)]*?)\)/g;
  let m;
  while ((m = re.exec(ENGINE))) {
    const field = /t\.([a-zA-Z]+)/.exec(m[2]);
    out[m[1]] = field ? field[1] : null;
  }
  return out;
}
const ASSIGN = engineAssignments();

/* The fields that carry the theme's POLARITY — swap them and light becomes
   dark. A hue like accent does not; it is the same colour on either ground. */
const POLARITY = new Set(['fg', 'bg', 'ink', 'paper']);

console.log('\n  a theme cannot make text invisible\n');

console.log('  a token driven from the theme\'s light/dark pair must vary by mode');
{
  const driven = Object.keys(ASSIGN).filter((t) => POLARITY.has(ASSIGN[t]));
  ok('the engine does drive some of them', driven.length >= 4, 'found: ' + driven.join(', '));

  const constants = driven.filter((t) => {
    const declaredAnywhere = SCOPES.some((s) => DECL[s][t] !== undefined);
    const perMode = DECL['body.light-mode'][t] !== undefined
                 || DECL['body.super-light-mode'][t] !== undefined;
    /* A token no stylesheet declares at all is fine — nothing was written
       against a previous value of it. Only a declared CONSTANT is the trap. */
    return declaredAnywhere && !perMode;
  });

  ok('none of them is a stylesheet constant', constants.length === 0,
    constants.join(', ') + ' — declared once and never per-mode, so every rule reading it '
    + 'was written against that one value. This is exactly what --zw-ink was when driving it '
    + 'turned 21 `color:` rules into near-white text.');
}

console.log('\n  …and the two that caused it stay out of the engine');
{
  ok('--zw-ink is not driven', ASSIGN['--zw-ink'] === undefined);
  ok('--zw-page is not driven', ASSIGN['--zw-page'] === undefined);
  ok('…with the reason left where the line was',
    /--zw-ink AND --zw-page ARE NOT SET HERE/.test(ENGINE),
    'a deleted line leaves no trace, and this is an inviting change to make twice');
  /* The check above is generic and would catch --zw-ink again. These three are
     the specific case, kept because the generic rule can only fire on tokens
     somebody has already declared. */
  ok('--zw-ink really is the constant this describes',
    DECL[':root']['--zw-ink'] !== undefined
    && DECL['body.light-mode']['--zw-ink'] === undefined
    && DECL['body.super-light-mode']['--zw-ink'] === undefined,
    'if it ever gains a per-mode declaration this reasoning changes and the comment should too');
}

/* ── Does the text show up? ──────────────────────────────────────────────── */

function hex(c) {
  const s = String(c || '').trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return m[1].split('').map((h) => parseInt(h + h, 16));
  m = /^(\d+)\s+(\d+)\s+(\d+)$/.exec(s);            // a bare triplet
  if (m) return [+m[1], +m[2], +m[3]];
  m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(s);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}

/* Resolve a token in a mode: the mode's own declaration wins, then light (a
   super-light body carries BOTH classes), then the base scopes. */
function resolve(token, mode) {
  const chain = mode === 'super-light'
    ? ['body.super-light-mode', 'body.light-mode', 'body', ':root']
    : mode === 'light' ? ['body.light-mode', 'body', ':root'] : ['body', ':root'];
  for (const s of chain) {
    if (DECL[s][token] !== undefined) return DECL[s][token];
  }
  return null;
}

function luminance([r, g, b]) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

console.log('\n  the page\'s own ground and text are legible in every mode');
{
  for (const mode of ['dark', 'light', 'super-light']) {
    const bg = hex(resolve('--bg-rgb', mode));
    const fg = hex(resolve('--fg-rgb', mode));
    if (!bg || !fg) { ok(mode + ': both tokens resolve', false, 'bg=' + resolve('--bg-rgb', mode) + ' fg=' + resolve('--fg-rgb', mode)); continue; }
    const ratio = contrast(bg, fg);
    ok(mode + ': body text reads against the body ground (' + ratio.toFixed(1) + ':1)', ratio >= 4.5,
      'rgb(' + fg.join(' ') + ') on rgb(' + bg.join(' ') + ') — below 4.5:1 is unreadable body copy');
  }
}

console.log('\n  …and so is the pair the drawers use');
{
  /* The bag and search panels paint their own ground rather than inheriting
     one, so they are the surfaces most able to end up light-on-light. They read
     the same two tokens the body does, which is the point — but assert it
     resolves, rather than trusting that it does. */
  const PANEL = fs.readFileSync(path.join(ROOT, 'storefront-features.js'), 'utf8');
  ok('they read the page pair', /\.zwf-bag-panel\{background:rgb\(var\(--bg-rgb/.test(PANEL)
    && /\.zwf-search-panel\{background:rgb\(var\(--bg-rgb/.test(PANEL));

  for (const mode of ['dark', 'light', 'super-light']) {
    const bg = hex(resolve('--bg-rgb', mode));
    const fg = hex(resolve('--fg-rgb', mode));
    if (!bg || !fg) continue;
    ok(mode + ': the drawer is legible too', contrast(bg, fg) >= 4.5);
  }
}

console.log('\n  …and the price colours show up on the ground they sit on');
{
  /* --zw-price-off is a fixed green rather than a theme token, so it is the one
     price colour that cannot follow the ground. Worth knowing it still reads on
     all three. */
  for (const mode of ['dark', 'light', 'super-light']) {
    const bg = hex(resolve('--bg-rgb', mode));
    const off = hex(resolve('--zw-price-off', mode));
    if (!bg || !off) { ok(mode + ': the saving colour resolves', false, String(resolve('--zw-price-off', mode))); continue; }
    const ratio = contrast(bg, off);
    /* 3:1 rather than 4.5 — a short, bold, non-essential label beside a struck
       figure that already carries the same meaning. Below 3 it is decoration
       pretending to be information. */
    ok(mode + ': "% off" reads (' + ratio.toFixed(1) + ':1)', ratio >= 3,
      'on rgb(' + bg.join(' ') + ') — one green cannot clear this on both grounds, which is why it is declared per mode');
  }
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
