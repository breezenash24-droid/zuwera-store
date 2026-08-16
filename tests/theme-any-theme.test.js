/* Can this store wear a theme it does not already ship with?
 *
 * The theme system is two halves that do not agree with each other.
 *
 *   The ENGINE is general. theme-engine.js reads a list of themes out of the
 *   database, each carrying its own tokens, and paints them onto <body>. Add a
 *   theme in the admin and the engine will apply it, whatever it is called and
 *   whatever colours it holds.
 *
 *   The STYLESHEETS were not. 885 of the 1,799 colour declarations across the
 *   site were hardcoded literals — #09090b, #F0EEE9, rgba(9,9,11,.55) — sitting
 *   under `body.light-mode`. Those are not "light mode"; they are the built-in
 *   Light theme's palette, written out by hand. A new theme with a light base
 *   got them regardless of its own tokens, so it could change the page ground
 *   and almost nothing else.
 *
 * 1,268 of those were converted in place by
 * `node scripts/tokenize-colors.js --overrides`, taking the site from 51% to
 * 73% theme-following. This file guards both ends of that: the premise the
 * conversion rests on (the rungs still derive, on body, from the triplet the
 * engine writes), and a budget on what is left so it cannot grow back.
 *
 * It also enforces the part that was cheap and silently broken: nothing may
 * DECIDE the theme without the engine.
 *
 * Three pages carried a private copy of applyThemeMode:
 *
 *     var resolved = mode === 'dark' ? 'dark'
 *                  : mode === 'super-light' ? 'super-light' : 'light';
 *
 * Read that last branch. Any id it does not recognise — which is every theme
 * anybody will ever add — is coerced to 'light' and then painted with the
 * built-in light palette. A custom theme did not fail to apply on those pages;
 * it applied as a DIFFERENT theme, silently, which is why the size guide could
 * open in a scheme the product page behind it was not in.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

console.log('\n  a theme this store has never heard of\n');

console.log('  nothing coerces an unknown theme to a built-in');
{
  /* Anywhere this ternary appears, an unrecognised theme id becomes 'light'.
     That is only safe if the engine has already been given the chance to
     recognise it — so the rule is not "never write this", it is "never write
     this without delegating first". */
  const COERCE = /mode === 'dark' \? 'dark' : mode === 'super-light' \? 'super-light' : 'light'/;
  /* Matched loosely on purpose. storefront-theme.js delegates through a
     different shape (an outer `if (window.ZWTheme) {`, because it also has to
     handle the engine resolving to a DIFFERENT theme than the one asked for),
     and pinning the exact spelling reported it as rogue when it was the file
     that got this right first. What matters is that apply() is handed the id
     and its answer is acted on — not how the braces are arranged. */
  const DELEGATE = /ZWTheme\.apply\(mode\b[\s\S]{0,40}?return/;

  const files = fs.readdirSync(ROOT)
    .filter((f) => /\.(html|js)$/.test(f))
    .filter((f) => COERCE.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));

  ok('the files that coerce are the ones we know about', files.length > 0,
    'if this drops to zero the pattern was renamed and this test stopped testing anything');

  const rogue = files.filter((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const at = src.search(COERCE);
    /* The delegation has to come BEFORE the coercion, in the same function.
       After it is not a delegation, it is dead code. */
    const del = src.search(DELEGATE);
    return del < 0 || del > at;
  });
  ok('every one of them hands the id to the engine first', rogue.length === 0,
    rogue.join(', ') + ' — an unknown theme id becomes "light" there');
}

console.log('\n  the engine is the thing that knows the themes');
{
  const engine = fs.readFileSync(path.join(ROOT, 'theme-engine.js'), 'utf8');
  /* apply() must report whether it recognised the id. A delegation that cannot
     tell success from failure has to guess, and guessing is the bug. */
  ok('apply() returns false for a theme it does not have',
    /return false;/.test(engine) && /function apply\(/.test(engine),
    'the callers above branch on this — without it they cannot know to fall through');

  ok('themes carry their own tokens rather than a mode name',
    /tokens: \{ fg:/.test(engine),
    'a theme that is only a name can never be more than one of the built-ins');
}

console.log('\n  the premise the conversion rests on');
{
  /* 1,268 declarations inside light-mode blocks were rewritten from literals to
     tokens by scripts/tokenize-colors.js --overrides. That is only value-
     preserving because base.css says these exact things. If someone changes
     them, every one of those rules moves at once — so the numbers the
     conversion assumed are asserted here rather than remembered.

         rgba(9,9,11,0.65)  →  var(--c65)  →  rgb(10 10 10 / 65%)

     differs by 1/255 on red and green and 2/255 on blue. Nothing shows that.
     What it buys is the case the store could not reach before: theme-engine.js
     sets --fg-rgb inline on <body>, the ladder on <body> recomputes from it,
     and all 1,268 follow whatever theme is actually applied. */
  const base = fs.readFileSync(path.join(ROOT, 'base.css'), 'utf8');
  const lightBlock = base.slice(base.indexOf('body.light-mode {'), base.indexOf('SUPER LIGHT MODE'));

  ok('light mode still keys the foreground to near-black',
    /--fg-rgb:\s*10 10 10\b/.test(lightBlock),
    'the converted rules resolve through this — if it moves, they all move');
  /* Every rung, not a sampled one: a single rung that stops deriving turns
     every rule using it into a fixed colour again, silently. */
  const rungs = [...base.matchAll(/--c(\d\d):\s*([^;]+);/g)];
  ok('…and all ' + rungs.length + ' rungs still derive from that triplet, on body',
    rungs.length >= 17 && rungs.every(([, n, v]) => v.trim() === 'rgb(var(--fg-rgb) / ' + Number(n) + '%)'),
    rungs.filter(([, n, v]) => v.trim() !== 'rgb(var(--fg-rgb) / ' + Number(n) + '%)').map((r) => r[0]).join(', '));
  ok('…declared on body, where the mode class and the engine both write',
    base.indexOf('--c65') > base.lastIndexOf('body {', base.indexOf('--c65')),
    'a rung declared on :root resolves against :root and inherits the finished colour');
  ok('…and the engine writes the triplet where the ladder can see it',
    /set\('--fg-rgb'/.test(fs.readFileSync(path.join(ROOT, 'theme-engine.js'), 'utf8')),
    'this is the line that makes a custom theme reach all 1,268');

  /* The conversion must not have leaked page-keyed colour into a panel that
     keys its own — see PANEL_KEYED in the script. */
  const qa = fs.readFileSync(path.join(ROOT, 'quick-add-modal.css'), 'utf8');
  ok('the panel that keys its own foreground was left out of it',
    !/rgb\(var\(--fg-rgb\)/.test(qa),
    'page foreground inside a panel-keyed surface is invisible the moment a theme separates them');
}

console.log('\n  what is still hardcoded, counted honestly');
{
  /* Was 885. The light-mode foreground overrides are done; what is left is
     white and cream inside light-mode blocks (entangled with the super-light
     cascade, since a body.light-mode rule applies in super-light too), the
     panel-keyed modal, and the genuine absolutes — accents, the semantic green
     and red, scrims over photographs. The budget is a ratchet: a change that
     makes it worse has to come and edit this line, and say why. */
  const BUDGET = 490;
  const PROPS = /(^|[;{])\s*(color|background|background-color|border|border-color|border-[a-z]+-color|fill|stroke|box-shadow|outline-color)\s*:\s*([^;}]+)/gi;
  const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d/;

  let literals = 0, tokens = 0;
  for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    let m;
    PROPS.lastIndex = 0;
    while ((m = PROPS.exec(css))) {
      if (/var\(/.test(m[3])) tokens++;
      else if (LITERAL.test(m[3])) literals++;
    }
  }
  ok('hardcoded colours are not increasing', literals <= BUDGET,
    literals + ' literal colour declarations (budget ' + BUDGET + '). '
    + 'Each one is a rule a new theme cannot reach — use a token from base.css.');
  console.log('    ' + tokens + ' of ' + (tokens + literals) + ' colour declarations ('
    + Math.round(tokens * 100 / (tokens + literals)) + '%) follow the theme tokens.');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
