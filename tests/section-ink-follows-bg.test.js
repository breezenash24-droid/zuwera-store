/* The product names were the same colour as the band behind them.
 *
 * A section's BACKGROUND and its TEXT were decided from two different readings
 * of one field.
 *
 *   background:  resolveSectionBackground('#ffffff') → LEGACY_BG_TOKENS says
 *                that literal meant "the page colour", so it returns
 *                var(--black) — which on a dark theme paints DARK.
 *   text:        _zwIsLightColor('#ffffff') on the RAW literal → true → force
 *                #09090b on everything inside, plus .zw-on-light to darken any
 *                child that sets its own colour.
 *
 * Dark ink on a dark band. The names under the product cards were still on the
 * page, in the colour of what was behind them.
 *
 * The literal is not the problem and must not be rewritten: it is what the
 * colour picker handed over when somebody meant "a light band", back before
 * naming that intention was possible, and reading it as the token it stood for
 * is the entire purpose of LEGACY_BG_TOKENS. The problem was asking it a
 * question it had already stopped being the answer to.
 *
 * A background that tracks the theme keeps the page's own foreground, which is
 * right by construction. Only a literal that stays light in EVERY theme needs
 * its text darkened.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SF = fs.readFileSync(path.join(ROOT, 'storefront.js'), 'utf8');

/* The real predicate and the real resolver, lifted out and run together — the
   bug was that they disagreed, so testing either alone would have missed it. */
const slice = (from, to) => SF.slice(SF.indexOf(from), SF.indexOf(to));
const src = slice('const SECTION_BG_TOKENS = {', 'function sectionFgForToken')
  + slice('const LEGACY_BG_TOKENS = {', '  function resolveSectionBackground(value) {')
  + slice('  function resolveSectionBackground(value) {', '  window.zwSectionBgTokens');
const M = new Function(src + ';return { resolve: resolveSectionBackground, tracks: sectionBgTracksTheme };')();

/* The luminance check the page uses, close enough for these inputs. */
function isLight(c) {
  const h = String(c).replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return false;
  const [r, g, b] = h.match(/../g).map((x) => parseInt(x, 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}
/* The decision as the page now makes it. */
const forcesDarkInk = (bg) => !!(bg && !M.tracks(bg) && isLight(bg));

console.log('\n  a section’s ink follows the background it will actually have\n');

console.log('  the case from the screenshot');
{
  /* This is the value in the live page_builder_published row. */
  ok('a legacy white background resolves to the page colour',
    M.resolve('#ffffff') === 'var(--black)',
    'so on a dark theme it paints dark, not white');
  ok('…so it must NOT force dark ink', forcesDarkInk('#ffffff') === false,
    'forcing #09090b onto a band the theme just painted dark is the bug');
  ok('…and it is recognised as theme-tracking', M.tracks('#ffffff') === true);
}

console.log('\n  the other legacy literals behave the same way');
{
  for (const c of ['#f4f1eb', '#F0EEE9', '#FFFFFF']) {
    ok(c + ' tracks the theme', M.tracks(c) === true, 'case must not matter');
    ok('…and does not force dark ink', forcesDarkInk(c) === false);
  }
  /* The dark legacy literal was never broken — it forced nothing before and
     forces nothing now — but it has to keep resolving to the inverted band. */
  ok('#09090b still means the inverted band', M.resolve('#09090b') === 'var(--ink)');
  ok('…and still forces nothing', forcesDarkInk('#09090b') === false);
}

console.log('\n  tokens were already handled, and still are');
{
  for (const t of ['token:page', 'token:surface', 'token:tint', 'token:ink']) {
    ok(t + ' tracks the theme', M.tracks(t) === true);
    ok('…and forces nothing', forcesDarkInk(t) === false);
  }
}

console.log('\n  a colour somebody actually picked is still honoured');
{
  /* The whole point of the exclusion is that it is narrow. A light literal
     that is nobody's palette entry was a real decision about that colour, it
     stays that colour in every theme, and its text still has to be readable
     on it. */
  ok('a genuine light brand colour still forces dark ink', forcesDarkInk('#FFE8A3') === true);
  ok('…and is not treated as theme-tracking', M.tracks('#FFE8A3') === false);
  ok('…and resolves to itself', M.resolve('#FFE8A3') === '#FFE8A3');

  ok('a genuine dark brand colour forces nothing', forcesDarkInk('#123456') === false);
  ok('no background at all forces nothing', forcesDarkInk('') === false);
  ok('…and resolves to nothing', M.resolve('') === '');
}

console.log('\n  wired into the decision');
{
  ok('the branch consults it', /s\.sec_bg && !sectionBgTracksTheme\(s\.sec_bg\) && _zwIsLightColor\(s\.sec_bg\)/.test(SF));
  /* Reading it as the token it stood for is a READ-time thing. Rewriting the
     stored literal would destroy what the builder's "Custom colour" option
     needs to put it back. */
  ok('nothing is rewritten on disk', !/sec_bg\s*=\s*['"]token:/.test(SF));
  ok('the resolver and the predicate share one table',
    (SF.match(/LEGACY_BG_TOKENS/g) || []).length >= 3,
    'a second copy of the legacy list is a second answer');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
