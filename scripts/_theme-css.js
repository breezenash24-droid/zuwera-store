/**
 * What a theme MEANS, as CSS. One answer, used by the build and by the tests.
 *
 * ── The bug this exists to end ───────────────────────────────────────────────
 *
 * theme-engine.js says it plainly, at the top of apply():
 *
 *     "On body, not :root. The alpha ladder is declared on body so that the
 *      body.light-mode class can move it; setting the triplet on :root would
 *      lose to that class every time, and a custom theme's colours would be
 *      silently replaced by the built-in light ones."
 *
 * That is exactly what the pre-paint block in <head> does. It sets the theme's
 * tokens on <html>, and base.css declares every one of them on
 * `body.light-mode` / `body.super-light-mode`. A declaration on the nearer
 * ancestor wins, so the moment the stylesheet lands, every pre-painted token is
 * discarded and the page renders in the BUILT-IN palette for that base — not
 * the store's own theme.
 *
 * Nothing corrects it until theme-engine.js has downloaded, parsed and run,
 * because that file sets the same tokens as INLINE styles on <body>, which
 * outrank the class. It is deferred and cache-busted, so every Cloudflare
 * deploy re-hashes it and guarantees one cold fetch. That is why "the first
 * load after a deploy is wrong and a refresh fixes it": the refresh is served
 * theme-engine.js from disk, and the gap closes to nothing.
 *
 * And the gap is not subtle when the store's default is a CUSTOM theme, which
 * is the normal case — a custom theme carries its own type scale, density,
 * motion and accent, and the built-in it falls back to carries none of them. A
 * page at typeScale 1 that reflows to 1.25 is not a flicker, it is a relayout.
 *
 * ── The fix ─────────────────────────────────────────────────────────────────
 *
 * Put the answer in the render-blocking CSS, where it cannot lose a race with a
 * network request. The build resolves the default theme and writes it as a real
 * stylesheet rule, at a specificity that beats the built-in body-class blocks:
 *
 *     html[data-zw-theme-stamp] body { … }      (0,1,2)  beats
 *     body.super-light-mode         { … }       (0,1,1)
 *
 * and theme-engine.js still wins over both, because an inline style outranks
 * any selector. So the order of authority reads correctly top to bottom:
 * built-in default, then the store's baked default, then the live answer.
 *
 * The whole block is switched off by removing ONE attribute, which is what the
 * pre-paint block does the instant it learns this visitor chose something else.
 *
 * ── Parity ──────────────────────────────────────────────────────────────────
 *
 * This must agree with theme-engine.js apply(), token for token, or the first
 * frame and the second disagree — which is the same class of bug one level up.
 * tests/theme-css-parity.test.js reads apply() and fails if it names a token
 * this file does not.
 */

/* Body-level tokens: [css custom property, theme token key].
   Order and spelling mirror apply(). */
const BODY_TOKENS = [
  ['--fg-rgb', 'fg'],
  ['--bg-rgb', 'bg'],
  ['--ink', 'ink'],
  ['--paper', 'paper'],
  ['--zw-theme-surface', 'surface'],
  ['--accent', 'accent'],
  ['--zw-cream', 'cream'],
  ['--zw-surface', 'surfaceAlt'],
  ['--zw-fg-hover', 'fgHover'],
  ['--zw-accent', 'accent'],
  ['--zw-price-now', 'priceNow'],
  ['--zw-price-was', 'priceWas'],
  ['--zw-price-off', 'priceOff'],
  ['--zw-price-member', 'priceMember'],
  ['--err', 'err'],
  ['--zw-nav-bg', 'navBg'],
  ['--zw-nav-fg', 'navFg'],
  ['--zw-bar-bg', 'barBg'],
  ['--zw-bar-fg', 'barFg'],
  ['--zw-radius', 'radius'],
  ['--zw-density', 'density'],
  ['--zw-ease', 'ease'],
  ['--zw-label-font', 'labelFont'],
];

/* A value safe to put inside a CSS declaration. Theme tokens come from the
   store's own settings row, but they reach a <style> block in every page, so
   anything that could close the declaration or the element is refused rather
   than escaped — a token containing `}` or `</style` is a broken theme, not a
   value to be clever about. */
function safe(v) {
  /* Falsy means UNSET, including a literal 0, because that is what apply()'s
     set() does — it removes the property, leaving base.css's own value. A
     theme with radius 0 renders square either way, so the two agree; emitting
     `0` here where the engine emits nothing would be a first frame that
     disagrees with the second, which is the whole bug being fixed. --zw-motion
     is the one token where 0 is a real value, and it is handled on its own
     terms below rather than by widening this. */
  if (!v) return '';
  const s = String(v).trim();
  if (!s) return '';
  if (/[{}<>;]|\/\*|\*\//.test(s)) return '';
  return s;
}

function decls(pairs) {
  return pairs
    .map(([prop, val]) => (val ? prop + ':' + val + ';' : ''))
    .join('');
}

/**
 * The two rules a theme becomes.
 *
 * `scope` is the attribute selector that turns the block on, so the caller
 * decides what switches it off. Returns '' for a theme with nothing in it,
 * rather than an empty rule nobody can read.
 */
function themeCss(tokens, scope) {
  const t = tokens && typeof tokens === 'object' ? tokens : {};
  const sel = scope || 'html[data-zw-theme-stamp]';

  const body = [];
  for (const [prop, key] of BODY_TOKENS) body.push([prop, safe(t[key])]);

  /* --black and --white are the older spelling of the page pair, and apply()
     sets them from bg/fg AFTER setting them from ink/paper — the second write
     is the one that survives, so it is the only one mirrored here. */
  const bg = safe(t.bg);
  const fg = safe(t.fg);
  body.push(['--black', bg ? 'rgb(' + bg + ')' : '']);
  body.push(['--white', fg ? 'rgb(' + fg + ')' : '']);

  /* Root-level, because these are read where they are declared. --text-hero and
     its siblings are declared in :root as
     `calc(clamp(…) * var(--zw-type-scale, 1))`, so the scale is substituted
     against :root's value — putting it on body would change nothing at all.
     apply() sets it on root for the same reason. */
  const root = [];
  const scale = parseFloat(t.typeScale);
  root.push(['--zw-type-scale', isFinite(scale) && scale > 0 ? String(scale) : '1']);
  const motion = parseFloat(t.motion);
  if (isFinite(motion) && motion >= 0) root.push(['--zw-motion', String(motion)]);
  /* The area outside body — overscroll, the notch strip — is painted from the
     root element, which is why apply() sets these two there as well. */
  if (bg) {
    root.push(['background-color', 'rgb(' + bg + ')']);
    root.push(['--zw-notch-bar', 'rgb(' + bg + ')']);
  }

  const rootCss = decls(root);
  const bodyCss = decls(body);
  let out = '';
  if (rootCss) out += sel + '{' + rootCss + '}';
  if (bodyCss) out += sel + ' body{' + bodyCss + '}';
  return out;
}

/**
 * The attributes a theme carries that are shapes rather than values.
 *
 * A custom property cannot switch a grid template, so these stay attributes.
 * Only the two that are a plain lookup are baked; header composition and icon
 * packs have their own resolution in theme-engine.js and are left to it, so
 * this file never becomes a second, drifting copy of that logic.
 */
function themeAttrs(tokens) {
  const t = tokens && typeof tokens === 'object' ? tokens : {};
  const html = {};
  const body = {};
  if (t.iconLabels === 'mobile' || t.iconLabels === 'always') {
    html['data-zw-iconlabels'] = t.iconLabels;
  }
  if (t.accountIn === 'header') body['data-zw-account'] = 'header';
  return { html, body };
}

module.exports = { themeCss, themeAttrs, BODY_TOKENS, safe };
