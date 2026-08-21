/* How far apart Men, Women and New sit was the one thing about this header
   nobody could change.
   ═══════════════════════════════════════════════════════════════════════════

   `gap: 2.4rem`, written as a LITERAL in three files — storefront-cohesion.css,
   index.html and landing.html — with no control anywhere in the admin or the
   builder. It is also the first thing that looks wrong when the arrangement
   moves, because a centred strip wants air and a strip tucked beside the logo
   wants far less of it.

   ── MEASURED, 1280px, classic arrangement ───────────────────────────────────

       (unset)   38.4px      strip 269.9px
       tight     17.6px      strip 228.3px
       snug      27.2px      strip 247.5px
       normal    38.4px      strip 269.9px     identical to unset, by design
       roomy     51.2px      strip 295.5px
       wide      70.4px      strip 333.9px

   ── AND THE ONE ARRANGEMENT THAT CAPS IT ────────────────────────────────────

   A centred logo is out of flow, so categories running in flow beside it do not
   stop at the centre lane — they run underneath, and whatever is on the bottom
   stops being clickable. The stylesheet has guarded that for a while by
   tightening the strip. The guard stays; it is now proportional:

       clamp(.5rem, 1.2vw, calc(var(--zw-nav-gap, 2.4rem) / 2))

   At the default that is 1.2rem, exactly the literal it replaces, so nothing
   changes for a store that has not chosen. Measured on a centred-logo header at
   1280px: tight 8.8px, but normal, roomy and wide all 15.36px — the 1.2vw term
   caps them. So the setting can only ever TIGHTEN there, and the modal says so
   rather than claiming an effect it does not have. */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CSS = read('storefront-cohesion.css');
const B = read('builder.html');
const HL = read('header-layouts.js');
const TE = read('theme-engine.js');
const MID = read('functions/_middleware.js');
const STAMP = read('scripts/stamp-header-layout.js');
const STEPS = ['tight', 'snug', 'normal', 'roomy', 'wide'];

console.log('\n  the category spacing is a setting\n');

console.log('  no file still hard-codes it');
{
  for (const f of ['storefront-cohesion.css', 'index.html', 'landing.html']) {
    const src = code(read(f));
    ok(f + ' reads the variable instead of a literal',
      /\.nav-center\{[^}]*gap:\s*var\(--zw-nav-gap/.test(src.replace(/\n\s*/g, ''))
      || /gap:var\(--zw-nav-gap/.test(src.replace(/\s+/g, '')),
      'three copies of 2.4rem is how two of them end up disagreeing');
  }
  /* Scoped to the .nav-center rule. The step table below necessarily contains
     `--zw-nav-gap: 2.4rem` — that IS `normal` — and rejecting the string
     everywhere would fail on the definition that makes the default work. */
  ok('…and no .nav-center rule still says 2.4rem outright',
    !['storefront-cohesion.css', 'index.html', 'landing.html'].some((f) => {
      const flat = code(read(f)).replace(/\s+/g, '');
      return /\.nav-center\{[^}]*gap:2\.4rem/.test(flat);
    }));
  /* Non-zero on purpose: clean-css rewrites a zero inside a value to a bare 0,
     which has already cost this site a header. 2.4rem survives untouched. */
  ok('the fallback is non-zero, so the minifier leaves it alone',
    /var\(--zw-nav-gap, ?2\.4rem\)/.test(CSS));
}

console.log('\n  five named steps, and normal is what the header already had');
{
  for (const s of STEPS)
    ok('there is a rule for ' + s,
      new RegExp('html\\[data-zw-hdr-gap="' + s + '"\\]\\s*\\{ --zw-nav-gap:').test(CSS));
  ok('normal is 2.4rem, so choosing it changes nothing',
    /html\[data-zw-hdr-gap="normal"\]\s*\{ --zw-nav-gap: 2\.4rem; \}/.test(CSS),
    'a step called normal that is not the shipped value would be a trap');
  ok('…and they run in order, tight through wide',
    (() => {
      const vals = STEPS.map((s) => {
        const m = CSS.match(new RegExp('html\\[data-zw-hdr-gap="' + s + '"\\]\\s*\\{ --zw-nav-gap: ([\\d.]+)rem'));
        return m ? Number(m[1]) : NaN;
      });
      return vals.every((v, i) => i === 0 || v > vals[i - 1]);
    })());
}

console.log('\n  the collision guard survives, and now scales');
{
  ok('a centred logo still tightens the strip',
    /html\[data-zw-hdr-logo="center"\]\[data-zw-hdr-linksrow="1"\][\s\S]{0,600}gap: clamp\(\.5rem, 1\.2vw,/.test(CSS),
    'without it the categories run under an out-of-flow logo and stop being clickable');
  ok('…from the chosen gap rather than a second literal',
    /clamp\(\.5rem, 1\.2vw, calc\(var\(--zw-nav-gap, 2\.4rem\) \/ 2\)\)/.test(CSS));
  ok('…landing on the old value at the default',
    /At the default 2\.4rem that is 1\.2rem/.test(CSS),
    '2.4rem / 2 = 1.2rem, which is exactly the literal it replaces');
  /* The modal must not claim an effect the clamp does not allow. */
  ok('and the modal says the wider steps stop at the cap',
    /the tighter steps still apply, the wider ones stop at the cap/.test(B));
  ok('…deciding that from the spec, not by matching a layout name',
    /lay\.spec\.logo === 'center'[\s\S]{0,80}linksRow\) !== '2'/.test(code(B)),
    'a name match would miss a layout added later');
}

console.log('\n  it travels like every other header answer');
{
  ok('navGap is an extra with a validated vocabulary',
    /navGap:\s*\{ tight: 1, snug: 1, normal: 1, roomy: 1, wide: 1 \}/.test(HL)
    && /EXTRA_KEYS = \['lines', 'account', 'iconLabels', 'order', 'flip', 'navGap'\]/.test(HL));
  ok('…and rides the visitor cache tuple, appended so an old one still reads',
    /ATTR_FIELDS = \['lines', 'account', 'iconLabels', 'order', 'flip', 'navGap'\]/.test(HL));
  ok('theme-engine writes the attribute',
    /if \(HDR_GAPS\[spec\.navGap\]\) root\.setAttribute\('data-zw-hdr-gap', spec\.navGap\);/.test(code(TE)));
  ok('…rejecting anything the stylesheet has no rule for',
    /var HDR_GAPS = \{ tight: 1, snug: 1, normal: 1, roomy: 1, wide: 1 \};/.test(TE),
    'an unknown value must leave the shipped 2.4rem standing');
  ok('…and clear() removes it with the rest',
    /'data-zw-hdr-flip',\s*\n\s*'data-zw-hdr-gap'\]/.test(TE));
  ok('the edge stamps it', /if \(GAPS\[value\.navGap\]\) out\['data-zw-hdr-gap'\] = value\.navGap;/.test(code(MID)));
  ok('the build stamp reads it off the row', /navGap: pick\('navGap', \['tight', 'snug', 'normal', 'roomy', 'wide'\]\)/.test(code(STAMP)));
  ok('…writes it outside the placement block, since it is not a placement',
    /if \(chosen\.navGap\) keep \+= ' data-zw-hdr-gap="'/.test(code(STAMP))
    && /Category spacing is not a placement/.test(STAMP),
    'a store can want a tighter strip without ever choosing an arrangement');
  ok('…and strips it, so changing back actually changes back',
    /'data-zw-hdr-flip', 'data-zw-hdr-gap'\];/.test(STAMP));
}

console.log('\n  and the builder can set it');
{
  for (const s of STEPS)
    ok('there is a ' + s + ' button',
      new RegExp('id="hdrGap' + s.charAt(0).toUpperCase() + s.slice(1) + '"').test(B));
  ok('it applies on click, like the toggles beside it',
    /function setHdrGap\(v\)\{[\s\S]{0,300}sendChrome\(\)/.test(B));
  ok('the draft carries it', /if \(chromeHdrGap\) out\.navGap = chromeHdrGap;/.test(B));
  ok('the preview push carries it', /navGap:chromeHdrGap/.test(B));
  ok('Cancel puts it back', /chromeHdrGap=hdrCfgWas\.gap/.test(B));
  ok('…and it is loaded from the saved row',
    /chromeHdrGap=one\('navGap',\['tight','snug','normal','roomy','wide'\]\)/.test(B));
  /* '' and 'normal' are the same spacing, so an unanswered store must still see
     a button lit — otherwise the control reads as "nothing applies" while
     2.4rem plainly does. */
  ok('an unanswered store still sees which spacing it has',
    /const cur = chromeHdrGap \|\| 'normal';/.test(code(B)));
  ok('…and the note is repainted when the arrangement changes',
    /function pickHeaderLayout\(id\)\{[\s\S]{0,200}paintHdrGap\(\)/.test(B));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
