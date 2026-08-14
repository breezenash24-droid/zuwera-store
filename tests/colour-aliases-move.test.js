/* --black/--white are older names for --ink/--paper, and they have to move too.
 *
 * base.css defines them as literally the same values in every block:
 *
 *   :root                    --black #09090b   --ink #09090b
 *                            --white #f4f1eb   --paper #f4f1eb
 *   body.light-mode          --black #F0EEE9   --ink #F0EEE9
 *                            --white #09090b   --paper #09090b
 *   body.super-light-mode    --black #FFFFFF   --ink #FFFFFF
 *
 * So they are aliases, not a second palette — and 88 rules still use the older
 * spelling: 35 in product.css, 35 in drop001.html, 17 in product.html.
 *
 * theme-engine.js applies a theme by setting custom properties INLINE on body,
 * which beat the class rules. It set --ink and --paper and left the aliases
 * behind. With one of the three built-in themes that is invisible, because the
 * body class supplies both pairs with matching values anyway. Put a CUSTOM theme
 * on — an imported one, or anything made in the theme editor — and the pairs
 * come apart: --ink becomes the theme's colour, --white stays whatever the
 * built-in for that base said, and the product page draws its labels in one
 * palette on a background from another.
 *
 * Reported as "the page degenerates in dark mode". Two names for one colour is
 * the same fault as two answerers for one question: hidden until something
 * moves.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const TE   = fs.readFileSync(path.join(ROOT, 'theme-engine.js'), 'utf8');
const BASE = fs.readFileSync(path.join(ROOT, 'base.css'), 'utf8');

/* The real apply block, lifted and run against a body that records what was
   set. Asserting the source contains a line would pass just as well if the
   line were setting the wrong token. */
const START = TE.indexOf("set('--fg-rgb', t.fg);");
const END   = TE.indexOf("set('--zw-nav-bg'");
if (START < 0 || END < START) { console.log('  ✗ could not find the token block in theme-engine.js'); process.exit(1); }
const SRC = TE.slice(START, END);

function applyTokens(tokens) {
  const props = {};
  const set = (name, value) => { if (value) props[name] = value; else delete props[name]; };
  new Function('set', 't', SRC)(set, tokens);
  return props;
}

console.log('\n  the old colour names move with the theme\n');

console.log('  base.css treats them as aliases, not a second palette');
{
  /* If this ever stops being true the fix below is wrong, so it is checked
     rather than assumed. */
  const root = BASE.slice(BASE.indexOf(':root'), BASE.indexOf('body.light-mode'));
  const grab = (block, name) => (block.match(new RegExp('--' + name + ':\\s*([#\\w]+)')) || [])[1];
  ok(':root --black equals --ink', grab(root, 'black') === grab(root, 'ink'),
    grab(root, 'black') + ' vs ' + grab(root, 'ink'));
  ok(':root --white equals --paper', grab(root, 'white') === grab(root, 'paper'),
    grab(root, 'white') + ' vs ' + grab(root, 'paper'));

  const light = BASE.slice(BASE.indexOf('body.light-mode {'), BASE.indexOf('body.super-light-mode'));
  ok('light-mode --black equals --ink', grab(light, 'black') === grab(light, 'ink'));
  ok('light-mode --white equals --paper', grab(light, 'white') === grab(light, 'paper'));
}

console.log('\n  a theme sets both spellings');
{
  const dark = applyTokens({ fg: '244 241 235', bg: '9 9 11', ink: '#09090b', paper: '#f4f1eb', surface: '#111113' });
  ok('--ink is set', dark['--ink'] === '#09090b');
  ok('--black follows it', dark['--black'] === '#09090b',
    'got ' + dark['--black'] + ' — 88 rules read this name');
  ok('--paper is set', dark['--paper'] === '#f4f1eb');
  ok('--white follows it', dark['--white'] === '#f4f1eb', 'got ' + dark['--white']);
}

console.log('\n  the case that was actually broken: a custom theme');
{
  /* An imported theme whose colours are nothing like the built-ins. Before the
     fix --ink became #121212 while --white stayed at the built-in for that
     base, so a label and the surface behind it came from different palettes. */
  const custom = applyTokens({ fg: '18 18 18', bg: '255 255 255', ink: '#121212', paper: '#FAF7F0', surface: '#F3F3F3' });
  ok('--black tracks the custom ink', custom['--black'] === '#121212',
    'this is the one that produced washed-out product labels');
  ok('--white tracks the custom paper', custom['--white'] === '#FAF7F0');
  ok('…so the two spellings agree', custom['--black'] === custom['--ink'] && custom['--white'] === custom['--paper'],
    'disagreeing here means one palette on top of another');
}

console.log('\n  a theme that omits a token clears both names together');
{
  /* set() removes a property when the value is falsy, so an incomplete theme
     must not leave the alias holding a stale colour from the previous one. */
  const partial = applyTokens({ fg: '0 0 0', bg: '255 255 255', ink: '', paper: '' });
  ok('--ink is cleared', partial['--ink'] === undefined);
  ok('--black is cleared with it', partial['--black'] === undefined,
    'a leftover alias is the same bug one theme-switch later');
  ok('--white is cleared with --paper', partial['--white'] === undefined && partial['--paper'] === undefined);
}

console.log('\n  the pages that depend on it');
{
  /* Named here so that if someone deletes the aliases, this test says which
     files they have to fix first. */
  const counts = {};
  for (const f of ['product.css', 'product.html', 'drop001.html', 'storefront-cohesion.css']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    counts[f] = (src.match(/var\(--white\)|var\(--black\)/g) || []).length;
  }
  ok('product.css still uses the old names', counts['product.css'] > 0,
    'if this reaches 0 the alias can be retired');
  ok('so does the collection page', counts['drop001.html'] > 0);
  ok('and the product page', counts['product.html'] > 0);
  console.log('      (' + Object.keys(counts).map((k) => k + ' ' + counts[k]).join(', ') + ')');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
