/* Turning a section's Text Color OFF — which used to be impossible.
 *
 * The Page Builder built its two colour settings with two different helpers and
 * the difference was a live bug. Background got a proper control: Default, a
 * theme colour, or a custom one. Text Color got a bare hex pair — no "Default",
 * no theme tokens, and an <input type="color"> that has no empty state, so it
 * always LOOKED like a colour was set even with the text box beside it blank.
 *
 * What that produced on this store: the products strip saved as sec_bg #ffffff
 * with text_color #000000. Both literals, frozen against whatever theme was
 * active when they were picked. Switch the site to dark and storefront.js does
 * exactly what it is told — forces #000 onto the section with !important, which
 * cascades onto .pcard-name — and the product names go black on a dark page.
 * Diagnosed by walking the computed-colour chain: body was correctly
 * rgb(244,241,235) and black was injected at .products-section.
 *
 * storefront.js has resolved token: values in text_color the whole time. Only
 * the editor could not say it, and could not say "none" either.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────
 *
 * syncForm() collects every [data-f] in the form and assigns last-one-wins. So
 * exactly ONE input may claim a key at a time. Two claimants is how a cleared
 * text box loses to a colour swatch that cannot be empty — the original bug in
 * one sentence. That invariant is what these tests are really about, and it is
 * checked in every mode rather than asserted once.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const HTML = fs.readFileSync(path.join(ROOT, 'builder.html'), 'utf8');
const SF   = fs.readFileSync(path.join(ROOT, 'storefront.js'), 'utf8');

/* The real builders, lifted and run. */
const A = HTML.indexOf('const SEC_BG_TOKENS=[');
const B = HTML.indexOf('const secTextF=');
const C = HTML.indexOf('\n', HTML.indexOf("'#f4f1eb');", B));
if (A < 0 || B < 0 || C < 0) { console.log('  ✗ could not find the colour controls in builder.html'); process.exit(1); }
const SRC = HTML.slice(A, C);

const api = new Function('he', `${SRC}
  return { secBgF, secTextF, tokenColorF, SEC_TEXT_TOKENS, SEC_BG_TOKENS };`)(
  (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
);

/* Every input in the rendered control that claims a settings key, with the
   value syncForm would read from it. */
function claimants(html, key) {
  const out = [];
  const re = new RegExp('<input[^>]*>', 'g');
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (!new RegExp('data-f="' + key + '"').test(tag)) continue;
    const val = (tag.match(/value="([^"]*)"/) || [, ''])[1];
    const type = (tag.match(/type="([^"]*)"/) || [, 'text'])[1];
    out.push({ type, val });
  }
  return out;
}

console.log('\n  a section can be told to stop colouring its text\n');

console.log('  exactly one input owns the setting, in every mode');
{
  for (const [label, v] of [['Default (blank)', ''], ['a theme token', 'token:paper']]) {
    const c = claimants(api.secTextF(v), 'text_color');
    ok(label + ' → one claimant', c.length === 1,
      'got ' + c.length + ' — syncForm takes the last, so a second one silently wins');
  }
  /* Same control, same guarantee, for the field that already worked. */
  for (const [label, v] of [['Default', ''], ['token', 'token:tint']]) {
    const c = claimants(api.secBgF(v), 'sec_bg');
    ok('background, ' + label + ' → one claimant', c.length === 1);
  }

  /* Custom is the deliberate exception: the swatch and the hex box are a pair,
     kept in step by their oninput handlers, and both claim the key. That is
     safe only while they agree AND the text box is last — syncForm's
     last-one-wins is what makes typing a hex beat the swatch rather than the
     other way round. Both halves are asserted, because the failure mode if
     either slips is silent. */
  for (const [label, mk, key, v] of [
    ['text', api.secTextF, 'text_color', '#000000'],
    ['background', api.secBgF, 'sec_bg', '#ffffff'],
  ]) {
    const c = claimants(mk(v), key);
    ok('custom ' + label + ' → swatch and hex box, agreeing', c.length === 2 &&
      c[0].val.toLowerCase() === c[1].val.toLowerCase());
    ok('…with the typed value last, so it wins', c[c.length - 1].type !== 'color',
      'if the swatch were last, a hex you typed would lose to a colour you never picked');
  }
}

console.log('\n  what each mode actually saves');
{
  const off = claimants(api.secTextF(''), 'text_color');
  /* THE FIX. A blank value is what storefront.js reads as "no chosen Text
     Color", which sends it down the branch that works the colour out from the
     background instead of forcing one. */
  ok('Default saves an empty string', off[0] && off[0].val === '',
    'this is the "off" that did not exist — an <input type=color> cannot express it');
  ok('…and it is not the colour swatch that carries it', off[0] && off[0].type !== 'color',
    'a colour input always has a value, so it can never mean "none"');

  const tok = claimants(api.secTextF('token:paper'), 'text_color');
  ok('a theme colour saves the token, not a resolved hex', tok[0] && tok[0].val === 'token:paper',
    'resolving it here would freeze the colour at edit time — exactly the bug being fixed');

  const cus = claimants(api.secTextF('#000000'), 'text_color');
  ok('a custom colour still saves the hex', cus[0] && cus[0].val === '#000000',
    'deliberate fixed colours must keep working');
}

console.log('\n  the choices offered');
{
  const vals = api.SEC_TEXT_TOKENS.map((o) => o[0]);
  ok('there is a Default', vals[0] === '');
  ok('…and it is the first thing in the list', /Default/.test(api.SEC_TEXT_TOKENS[0][1]));
  ok('theme colours are offered at all', vals.some((v) => String(v).slice(0, 6) === 'token:'),
    'without these you can make a background follow the theme but not the text on it');
  ok('a custom colour is still possible', vals.includes('__custom'));
  /* The sentence that stops this happening again. */
  ok('the hint says a custom colour will not follow the theme',
    /never does|stays that colour|fixed forever/.test(api.secTextF('')),
    'the products strip was set on a light theme and kept black text into dark');
}

console.log('\n  one control, not two that drift');
{
  ok('both fields are built by the same function',
    /const secBgF=\(v=''\)=>tokenColorF\(/.test(HTML) && /const secTextF=\(v=''\)=>tokenColorF\(/.test(HTML),
    'two near-identical helpers is how these two got out of step in the first place');
  ok('…and switched by the same handler', /window\.zwTokenColorMode=function/.test(HTML));
  ok('…which reads the key off the wrapper rather than hardcoding one',
    /wrap\.dataset\.tcKey/.test(HTML),
    'a hardcoded key is what made the handler unshareable');
  ok('every rendered control is wired to it',
    (HTML.match(/data-tc-mode onchange="zwTokenColorMode\(this\)"/g) || []).length === 1 &&
    /data-tc-key="\$\{key\}"/.test(HTML));
  ok('the old single-purpose handler is gone', !/zwSecBgMode/.test(HTML),
    'a leftover would be a second answerer for the same question');
}

console.log('\n  the storefront still honours all three');
{
  ok('a chosen colour is resolved through the token resolver',
    /const _tc = resolveSectionBackground\(s\.text_color\)/.test(SF),
    'so token:paper means the theme colour, not the literal string');
  ok('…and a blank one falls through to measuring the background',
    /\} else if \(s\.sec_bg\) \{[\s\S]{0,900}?const ink = zwInkFor\(el\)/.test(SF));
  /* Scoped to the block that actually decides, because zwInkFor is also called
     from the theme-change handler far earlier in the file — an unscoped
     indexOf finds that one and compares two unrelated lines. */
  const block = SF.slice(SF.indexOf('const _tc = resolveSectionBackground(s.text_color)'));
  ok('a chosen colour still wins over the measurement',
    block.indexOf('if (_tc) {') >= 0 &&
    block.indexOf('if (_tc) {') < block.indexOf('const ink = zwInkFor(el)'),
    'an explicit choice must not be overridden by a guess');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
