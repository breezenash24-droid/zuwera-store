/* A <select>'s drop-down is not on the page.
 *
 * Everything else in this codebase can be translucent, because the page is
 * always behind it. A rung of the alpha ladder — `var(--c06)` — is the
 * foreground colour at 6% opacity, and it only becomes a colour once something
 * is underneath. On the page that is the page.
 *
 * The list a <select> opens is the exception, and it is the only one. It is
 * drawn in its own window by the browser, and the only thing behind it is the
 * browser's own canvas. So 6% white composited in there is CREAM, no matter
 * how dark the page an inch above it is.
 *
 * The fit finder's height field was exactly that:
 *
 *     .zwf-field select { background: var(--c06); color: inherit }
 *
 * a correctly dark control that opened a cream panel carrying the dark theme's
 * near-white text. Six rows of it, unreadable.
 *
 * color-scheme could not save it and did not, which is worth being precise
 * about, because color-scheme was the fix that shipped the day before and this
 * bug survived it. An author-specified background on a <select> is what the
 * popup paints itself with; the browser's dark canvas never gets a chance.
 * They are two different failures with the same symptom:
 *
 *   - no color-scheme  →  the browser draws the popup in the wrong theme
 *   - translucent bg   →  we draw the popup in no theme at all
 *
 * This file asserts both, by reading the CSS the site actually ships rather
 * than by naming the rules I happen to have fixed — so the next select someone
 * adds is covered before it is written.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

/* Comments first, always. This codebase has paid four separate times for a
   scanner that read prose as code. */
const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');

/* ── Collect every stylesheet the storefront actually serves ────────────────
   Three shapes: real .css files, <style> blocks inside pages, and the CSS
   storefront-features.js builds as an array of strings and injects. The last
   one is where the bug was, so a scanner that skipped it would have been
   green through the whole thing. */
function sources() {
  const out = [];
  for (const f of fs.readdirSync(ROOT)) {
    if (f.endsWith('.css')) out.push([f, decomment(fs.readFileSync(path.join(ROOT, f), 'utf8'))]);
  }
  for (const f of fs.readdirSync(ROOT)) {
    if (!f.endsWith('.html') || f.includes('.bak')) continue;
    const raw = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of raw.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) out.push([f, decomment(m[1])]);
  }
  for (const f of ['storefront-features.js', 'lang.js', 'zw-login.js', 'quick-add.js']) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    /* The injected sheets are arrays of quoted CSS fragments. Take the string
       literals and glue them, which is what the module does at runtime. */
    const src = decomment(fs.readFileSync(p, 'utf8'));
    const frags = [...src.matchAll(/'((?:[^'\\]|\\.)*\{(?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
    if (frags.length) out.push([f, frags.join('\n')]);
  }
  return out;
}

/** Every `selector { … }` rule in a sheet, at-rules flattened away. */
function rules(css) {
  const out = [];
  for (const m of css.matchAll(/([^{}@][^{}]*)\{([^{}]*)\}/g)) {
    out.push({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
  }
  return out;
}

/** Does this selector target a <select> element (not a class merely named …select…)? */
const targetsSelect = (sel) => /(^|[\s>+~,(])select\b/.test(sel) || /-select\b(?!-)/.test(sel);
const targetsOption = (sel) => /(^|[\s>+~,(])option\b/.test(sel);

/** The value of a background/background-color declaration, if the rule sets one. */
function bgOf(body) {
  const m = [...body.matchAll(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/g)];
  return m.length ? m[m.length - 1][1].trim() : null;
}

/** Is this value see-through? A ladder rung, an explicit alpha, or `none`. */
function translucent(v) {
  if (/var\(\s*--c\d\d\b/.test(v)) return 'a ladder rung (var(--cNN)) — foreground at N% opacity';
  if (/rgba?\([^)]*\/\s*\d/.test(v)) return 'an explicit alpha (rgb(… / N%))';
  if (/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*(?:0?\.\d+|0)\s*\)/.test(v)) return 'an explicit alpha (rgba)';
  if (/\btransparent\b/.test(v)) return 'transparent';
  return null;
}

const ALL = sources();
console.log('\n  a <select> opens in a window our page colour does not reach\n');
console.log('  scanning ' + ALL.length + ' stylesheets\n');

console.log('  no select is painted with something you can see through');
{
  const bad = [];
  for (const [file, css] of ALL) {
    for (const r of rules(css)) {
      if (!targetsSelect(r.sel) || targetsOption(r.sel)) continue;
      const bg = bgOf(r.body);
      if (!bg) continue;
      const why = translucent(bg);
      /* `transparent` USED TO BE EXEMPT HERE, on the reasoning that it has no
         popup surface to get wrong. That reasoning was wrong, and the guest
         returns page proved it: `background: transparent` on a <select> is
         still an AUTHOR background, so Chromium paints the popup from it —
         transparent over the popup's own white canvas is a white panel, and
         `color: inherit` puts the dark theme's near-white text on it. Exactly
         the bug this file was written for, waved through by its own exception.
         `none` stays exempt: it is the shorthand reset, and a select carrying
         it has appearance:none and draws no native popup chrome at all. */
      if (why && !/^none\b/.test(bg)) {
        bad.push(file + ' → ' + r.sel + '  {' + bg + '}  is ' + why);
      }
    }
  }
  ok('every styled select has an opaque background', bad.length === 0,
    '\n      ' + bad.join('\n      ')
    + '\n      → use var(--field-bg) / var(--field-bg-lift), which are those same washes'
    + '\n        composited against the page so they survive being lifted out of it');
}

console.log('\n  and its rows are painted ground-and-text together');
{
  /* The half that goes wrong on its own. An `option` rule that sets a
     background without a colour inherits the page's — which is the near-white
     of whichever theme is on, on a ground that is now something else. That is
     the same "ground moved, text did not" failure the pre-paint block had, in
     the one place CSS cannot see the result. */
  const bad = [];
  for (const [file, css] of ALL) {
    for (const r of rules(css)) {
      if (!targetsOption(r.sel)) continue;
      const setsBg = /background(?:-color)?\s*:/.test(r.body);
      const setsFg = /(?:^|;)\s*color\s*:/.test(r.body);
      if (setsBg !== setsFg) {
        bad.push(file + ' → ' + r.sel + ' sets ' + (setsBg ? 'a background with no colour' : 'a colour with no background'));
      }
    }
  }
  ok('no option rule moves the ground without the text', bad.length === 0, '\n      ' + bad.join('\n      '));
}

console.log('\n  the selects a customer actually opens');
{
  /* Named on purpose. The scanner above proves nothing new is broken; these
     three are the ones that WERE, and a rule quietly deleted is a rule the
     scanner has nothing to complain about. */
  const feat = decomment(fs.readFileSync(path.join(ROOT, 'storefront-features.js'), 'utf8'));
  ok('the fit finder\'s height/weight fields are opaque',
    /\.zwf-field input,\.zwf-field select\{[^']*background:var\(--field-bg\)/.test(feat),
    'this is the field in the screenshot');
  ok('…and its rows carry both halves',
    /\.zwf-field select option\{background-color:var\(--field-bg\);color:rgb\(var\(--fg-rgb\)\)\}/.test(feat));

  const guide = decomment(fs.readFileSync(path.join(ROOT, 'sizeguide.html'), 'utf8'));
  ok('the size guide calculator is opaque',
    /\.calc-input, \.calc-select \{[\s\S]*?background: var\(--field-bg\);/.test(guide));
  ok('…including while focused, which is when the list is open',
    /\.calc-input:focus, \.calc-select:focus \{[\s\S]*?background-color: var\(--field-bg-lift\)/.test(guide),
    'a select is focused for exactly as long as its popup is up');
  ok('…and it no longer needs a per-mode override to stay in step',
    !/body\.(light|super-light)-mode \.calc-select option/.test(guide),
    'those existed because the base rule used tokens that did not move on their own');

  const vibe = decomment(fs.readFileSync(path.join(ROOT, 'reviews-vibe.css'), 'utf8'));
  /* [^}]* not [\s\S]*? — a lazy any-character run does not stop at the closing
     brace, so "does this block still contain #09090b" happily found one four
     hundred lines further down the file and failed a rule that was correct.
     Bound the search to the block or it is not a search of the block. */
  const vibeOpt = (/\.review-select option \{[^}]*\}/.exec(vibe) || [''])[0];
  ok('the review sort list follows the theme',
    /background-color: var\(--field-bg\)/.test(vibeOpt) && !/#09090b/.test(vibeOpt),
    'it was #09090b on #f4f1eb — legible, but only ever the dark one');
}

console.log('\n  the tokens exist, in both copies of the palette');
{
  /* base.css and storefront-cohesion.css each carry the ladder, and only
     product.html and bag.html load base.css — so a token added to one and not
     the other is present on two pages out of fourteen. */
  for (const f of ['base.css', 'storefront-cohesion.css']) {
    const css = decomment(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    ok(f + ' declares --field-bg and --field-bg-lift',
      /--field-bg:\s*color-mix/.test(css) && /--field-bg-lift:\s*color-mix/.test(css));
    ok('…on body, where the mode class is',
      new RegExp('body\\s*\\{[^}]*--field-bg:').test(css.replace(/\n/g, ' ')),
      'declared on :root it would resolve against :root\'s --fg-rgb and inherit the RESULT — '
      + 'the exact mistake the alpha ladder was moved off :root to avoid');
    ok('…composited against the page, not layered over it',
      /--field-bg:\s*color-mix\(in srgb, rgb\(var\(--fg-rgb\)\)\s+6%, rgb\(var\(--bg-rgb\)\)\)/.test(css),
      'the value has to be the SAME colour --c06 resolves to on the page, or the '
      + 'field stops matching the surface it sits on');
  }
}

console.log('\n  the other half: what the browser draws');
{
  /* Bound to the class, not set by script. It was set by script, in two
     scripts, and the size guide's own applyThemeMode has a fallback branch —
     the branch that actually runs, because theme-engine.js is deferred and
     that code is inline — which set the class, the theme-colour meta and the
     background, and not this. One more answerer, one more chance to forget.

     A class cannot be set without its declarations. That is the whole point of
     moving it into CSS. */
  /* Asked for the declaration, not the rule's shape. Requiring `body {
     color-scheme: dark }` on its own failed the moment it was folded into the
     body rule that already exists — which is the better home for it, and a
     test should not be the reason a declaration has to live alone. */
  for (const f of ['base.css', 'storefront-cohesion.css']) {
    const css = decomment(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const all = rules(css);
    ok(f + ' gives plain body the dark scheme',
      all.some((r) => r.sel === 'body' && /color-scheme:\s*dark\b/.test(r.body)),
      'so scrollbars, date pickers, autofill and select popups cannot lag a theme switch');
    ok('…and the mode classes the light one',
      all.some((r) => /body\.light-mode/.test(r.sel) && /color-scheme:\s*light\b/.test(r.body)));
  }

  const engine = decomment(fs.readFileSync(path.join(ROOT, 'theme-engine.js'), 'utf8'));
  ok('the engine still sets it on the root element',
    /root\.style\.colorScheme = theme\.base === 'dark' \? 'dark' : 'light'/.test(engine),
    'the CSS above is on body; the PAGE scrollbar and canvas read it from :root, '
    + 'which no body rule can reach');

  /* super-light carries BOTH classes, so the light rule has to name it too or
     it would fall through to the dark default. Cheap to get wrong, invisible
     until someone on the whitest theme opens a dropdown.

     Read the BODY rule specifically. Looking for the first `color-scheme:
     light` anywhere found cohesion's html:has(body.light-mode) rule two
     hundred lines earlier and reported a selector that legitimately does not
     mention super-light — a scanner failing on the wrong rule and calling it
     a bug in the right one. */
  for (const f of ['base.css', 'storefront-cohesion.css']) {
    const css = decomment(fs.readFileSync(path.join(ROOT, f), 'utf8')).replace(/\s+/g, ' ');
    const rule = /((?:body[.\w-]*\s*,\s*)*body[.\w-]*)\s*\{\s*color-scheme:\s*light;?\s*\}/.exec(css);
    ok(f + ' remembers super-light is a light theme',
      !!rule && /super-light-mode/.test(rule[1]),
      'it carries both classes, but the selector still has to name it');
  }

  /* And the dark default has to be a DEFAULT, not a shrug. `color-scheme:
     dark light` reads as "either of these is fine", and the browser resolves
     it from the visitor's OS setting — so the shipped dark page drew light
     scrollbars and light dropdowns for everyone on a light desktop. */
  const coh = decomment(fs.readFileSync(path.join(ROOT, 'storefront-cohesion.css'), 'utf8'));
  ok('the root does not leave the choice to the operating system',
    !/color-scheme:\s*(?:dark light|light dark)/.test(coh),
    'a page that has a theme must state it, not list its options');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
