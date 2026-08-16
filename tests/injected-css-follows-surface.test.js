/* The stylesheets that are not files.
 *
 * Three passes today converted 1,553 hardcoded colours to theme tokens, and
 * every one of them scanned *.css and the <style> blocks in the pages. None of
 * them could see this: CSS built as JavaScript strings and injected at runtime.
 * storefront-features.js, zw-login.js and storefront.js carry 65 rules that way,
 * and the tooling was blind to all of them.
 *
 * It showed up as a real bug rather than a statistic. The "Find your size" form
 * is rendered by fit-finder.js into two different surfaces — a modal on the
 * product page, which is light, and the size guide, which is an iframe whose
 * page is dark. The form's own styles were written against the first one:
 *
 *     .zwf-field input  { background: rgba(9,9,11,.04); border: 1px solid rgba(9,9,11,.16) }
 *     .zwf-seg button   { background: rgba(9,9,11,.04); … }
 *     .zwf-btn          { background: var(--zw-ink,#09090b); color: var(--zw-page,#f4f1eb) }
 *
 * Near-black at 4% is a faint grey box on a light panel and nothing at all on a
 * dark one. --zw-ink is a FIXED near-black, so the SEE MY SIZE button filled
 * itself near-black on a near-black page. The labels are drawn with `inherit`
 * and stayed visible, so what the shopper saw was three headings, no input
 * boxes, no fit buttons and no button — a form that looks broken rather than
 * unstyled.
 *
 * The comment that used to sit above the filled state had the reasoning half
 * right: it correctly worked out that --ink/--paper flip with the theme and
 * would make the chip vanish, then concluded --zw-ink/--zw-page are safe
 * because they are "ink-on-page by definition". That holds only while the
 * surface is light. The pair that inverts against whatever is actually behind
 * it is --fg-rgb over --bg-rgb.
 *
 * So the rule this file enforces is not "no literals in JS". It is the one the
 * bug is about: a control that can be drawn on more than one surface must take
 * its colours from that surface.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

console.log('\n  CSS that ships as JavaScript\n');

const features = fs.readFileSync(path.join(ROOT, 'storefront-features.js'), 'utf8');
/* Comments explain the old values, so they must not be read as the code that
   still holds them — the same trap that has cost three tools today. */
const code = features.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*$/gm, ' ');

console.log('  the fit finder is drawn on two different surfaces');
{
  /* The resting controls. A wash keyed to a fixed colour is invisible on half
     the surfaces this form appears on. */
  const resting = /\.zwf-field input,\.zwf-field select\{[^']*\}/.exec(code);
  /* This asked for var(--cNN) exactly, which pinned a SPELLING rather than the
     property the file is about — so it failed the day the select moved to
     --field-bg, a token that follows the surface just as closely and is the
     only one correct for a <select>. (A rung is the foreground at N% opacity,
     and the list a select opens has nothing behind it to be at N% of.)
     What matters is that the fill is derived from the theme rather than
     written down, so that is what is asked. */
  ok('the input and select take their fill from the surface',
    resting && /background:var\(--(?:c\d\d|field-bg)/.test(resting[0]),
    'rgba(9,9,11,.04) is a grey box on light and nothing on dark');
  ok('…and the select specifically takes the opaque one',
    resting && /background:var\(--field-bg\)/.test(resting[0]),
    'see tests/select-popup-has-a-surface.test.js — a rung here paints the dropdown cream');
  ok('…and their border too',
    resting && /border:1px solid var\(--c\d\d\)/.test(resting[0]));

  const seg = /\.zwf-seg button\{[^']*\}/.exec(code);
  ok('the fit buttons do the same', seg && /background:var\(--c\d\d\)/.test(seg[0]) && /var\(--c\d\d\)/.test(seg[0]));

  /* The filled ones have to INVERT, which is a different question from the
     wash: they need the foreground as a fill and the background as a label. */
  for (const [name, re] of [['the selected fit chip', /\.zwf-seg button\.on\{[^']*\}/],
                            ['the SEE MY SIZE button', /\.zwf-btn\{[^']*\}/]]) {
    const rule = re.exec(code);
    ok(name + ' fills with the foreground',
      rule && /background:rgb\(var\(--fg-rgb\)\)/.test(rule[0]),
      'var(--zw-ink) is a fixed near-black — on a dark page the button disappears');
    ok('…and labels itself with the background',
      rule && /color:rgb\(var\(--bg-rgb\)\)/.test(rule[0]),
      'the label survived the bug because it inherits; the button did not');
  }

  /* The specific values that were wrong, named so this cannot quietly return. */
  /* The FORM, not every .zwf- rule. .zwf-support-panel keeps its near-black
     wash on purpose — see the section below — and a blanket ban would have
     forced that one back to the wrong answer to keep a test quiet. */
  ok('no fixed near-black wash is left in the form',
    !/\.zwf-(field|seg|btn|modal|result)[a-z-]*[^']*rgba\(9,9,11/.test(code),
    'this is the exact shape of the reported bug');
  ok('…and the form does not fill from --zw-ink',
    !/\.zwf-(field|seg|btn|modal|result)[a-z-]*[^']*background:var\(--zw-ink/.test(code),
    '--zw-ink does not follow the page; it IS one of the two page colours');
}

console.log('\n  one form, two surfaces, and neither rule knows where it is');
{
  /* THE BUG SWAPPED SURFACES TWICE BEFORE THIS.
   *
   * The same form is mounted in two places:
   *
   *   product page   inside .zwf-modal-box, which paints itself with
   *                  --zw-page over --zw-ink — the FIXED pair. It is a cream
   *                  panel even when the page behind it is dark.
   *   size guide     bare into #sizeGuideFinder, inheriting the page.
   *
   * Written against the page, the button went pale-on-cream in the modal.
   * Written against the fixed pair, it went black-on-black in the guide. There
   * is no value for one set of control rules that is right on both — until the
   * SURFACE says what it is and the controls read that. Then the same rules
   * serve both and neither has to know which one it is in.
   */
  const box = /\.zwf-modal-box\{[^']*(?:'\s*\+\s*'[^']*)*\}/.exec(code.replace(/\n\s*/g, ''));
  ok('the modal panel follows the page',
    box && /background:rgb\(var\(--bg-rgb\)\)/.test(box[0]) && /color:rgb\(var\(--fg-rgb\)\)/.test(box[0]),
    'it is a DARK panel in dark mode — --zw-page/--zw-ink are the fixed pair and pinned it cream');

  /* The fixed pair must not come back here. It is what made the panel a cream
     slab on a dark store, and it is what forced the controls to be written
     against a second, contradictory surface. */
  ok('…and does not paint itself from the fixed pair',
    box && !/background:var\(--zw-page/.test(box[0]) && !/color:var\(--zw-ink/.test(box[0]));

  /* With both surfaces following the page there is nothing left to re-key —
     and re-keying would now be actively wrong, since the panel is the same
     lightness as the page it sits on. */
  ok('…and no longer re-keys the ladder, because it has nothing to correct',
    box && !/--c06:/.test(box[0]) && !/--fg-rgb:/.test(box[0]),
    'a panel that matches the page must not redeclare the page tokens');

  /* An edge is still needed — a dark panel on a dark page has no contrast of
     its own — and that edge must NOT flip with the theme. */
  ok('…but keeps a theme-neutral edge and shadow',
    box && /border:1px solid rgba\(128,128,128/.test(box[0]) && /rgba\(0,0,0,\.3\)/.test(box[0]),
    'a border derived from the foreground would vanish against one of the two grounds');

  /* And the guide mounts the form bare, so both renderings resolve their
     colours the same way — which is the whole reason one rule set works. */
  const guide = fs.readFileSync(path.join(ROOT, 'sizeguide.html'), 'utf8');
  ok('the size guide mounts the form bare, in the page',
    guide.indexOf('sizeGuideFinder') > 0 && !/zwf-modal-box/.test(guide),
    'both surfaces follow the page, so neither control rule has to know where it is');
}

console.log('\n  the surface behind the element is the whole question');
{
  /* Two rules in this file look identical and want opposite answers, which is
     the clearest statement of what the bug actually was. */

  /* The bag panel says outright that it follows the page. Anything filled with
     a fixed near-black inside it disappears whenever the page is dark. */
  ok('the bag panel follows the page',
    /\.zwf-bag-panel\{background:rgb\(var\(--bg-rgb/.test(code));
  ok('…so its buttons invert against it rather than picking a colour',
    /\.zwf-bag-review\{[^']*background:rgb\(var\(--fg-rgb\)\)/.test(code)
    && /\.zwf-bag-count\{background:rgb\(var\(--fg-rgb\)\)/.test(code));

  /* The support panel is a permanently cream surface. I converted its hover to
     --c07 in the first pass at this and had to put it back: --c07 derives from
     --fg-rgb, so on a dark page it is a near-WHITE wash on a panel that is
     still cream. The literal is correct here for exactly the reason it was
     wrong in the fit finder. */
  ok('the support panel does not follow the page',
    /\.zwf-support-panel\{background:#f4f1eb/.test(code));
  ok('…so its hover stays a fixed near-black wash',
    /\.zwf-support-panel a:hover\{background:rgba\(9,9,11,\.07\)\}/.test(code),
    'a theme-derived wash is invisible on a surface that is not themed');
}

console.log('\n  the size guide takes the theme it was opened from');
{
  /* Two documents answering the same question from different evidence is how
     the guide opened dark over a light product page. The parent knows; it says
     so, and the guide takes what it is given. */
  const product = fs.readFileSync(path.join(ROOT, 'product.html'), 'utf8');
  const guide = fs.readFileSync(path.join(ROOT, 'sizeguide.html'), 'utf8');

  ok('the product page hands its theme to the iframe',
    /__ZW_SIZEGUIDE_THEME__=/.test(product),
    'a srcdoc frame cannot always read localStorage, so it cannot resolve this itself');
  ok('…including the id, so a custom theme arrives as itself',
    /ZWTheme\.current\(\)/.test(product) && /id: themeNow/.test(product));
  ok('…and the base, which is always knowable',
    /base: baseNow/.test(product));

  ok('the guide prefers what it was handed',
    /__ZW_SIZEGUIDE_THEME__/.test(guide)
    && guide.indexOf('__ZW_SIZEGUIDE_THEME__') < guide.indexOf("applyThemeMode(localStorage.getItem('zw_theme_mode')"),
    'reading localStorage first puts the old answer back in front of the new one');
  ok('…and still works standing alone at /sizeguide',
    /applyThemeMode\(localStorage\.getItem\('zw_theme_mode'\)/.test(guide),
    'the page is a real URL as well as an embed');
}

console.log('\n  what is still injected from JavaScript');
{
  /* Not a failure — a number, recorded so it stops being invisible. The
     remainder is mostly mode-SCOPED (body.light-mode #zwlg-modal …), which is
     correct today and simply does not follow a custom theme; that is the same
     backlog as the stylesheets, not a bug. */
  const RULE = /'[^']*\{[^']*(rgba?\(\s*\d|#[0-9a-fA-F]{3,6})[^']*\}'/g;
  let total = 0;
  const per = [];
  for (const f of ['storefront-features.js', 'zw-login.js', 'storefront.js', 'email-popup.js', 'landing.js']) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const n = (src.match(RULE) || []).length;
    if (n) { per.push(f + ' ' + n); total += n; }
  }
  const BUDGET = 70;
  ok('injected rules holding literals are not increasing', total <= BUDGET,
    total + ' (budget ' + BUDGET + '): ' + per.join(', '));
  console.log('    ' + per.join('   '));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
