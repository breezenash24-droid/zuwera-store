/* The four themes that ship have to survive an import.
 *
 * A theme import once overwrote the whole list. The themes were simply gone,
 * and gone silently: no error, no empty state, nothing naming what had happened
 * or that a button existed to undo it. Someone hunting for Dark and Light has
 * no reason to read "Restore built-ins" as the answer — they are looking for a
 * list, not a repair.
 *
 * Applying merges now, so it cannot happen again. But merging protects future
 * applies; it cannot resurrect what an earlier one already deleted, and the
 * engine only falls back to the built-ins when the row is EMPTY — a list with
 * one imported theme in it is not empty. So a store that hit the old bug stays
 * broken until somebody notices.
 *
 * This holds the three things that make that recoverable: the built-ins are
 * defined, they cannot be deleted, and their absence says so.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..') + '/';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

const T = fs.readFileSync(ROOT + 'admin-themes.js', 'utf8');
const A = fs.readFileSync(ROOT + 'admin.html', 'utf8');

const defaults = [...T.slice(T.indexOf('var DEFAULT_MODES'), T.indexOf('/* The seven.'))
  .matchAll(/id:\s*'([a-z-]+)'/g)].map((m) => m[1]);
const protectedIds = (T.match(/var BUILTIN_IDS = \[([^\]]*)\]/) || [, ''])[1]
  .split(',').map((s) => s.replace(/['\s]/g, '')).filter(Boolean);

console.log('\n  the themes that ship');
{
  ok('there are built-in themes', defaults.length >= 3, defaults.join(', '));

  /* two-tone sat in DEFAULT_MODES but not in BUILTIN_IDS, so it was the one
     built-in a click could delete — and "Restore built-ins" would then offer it
     back, a round trip the other three simply refuse. */
  const unprotected = defaults.filter((d) => !protectedIds.includes(d));
  ok('…and every one of them is protected from deletion', unprotected.length === 0,
    unprotected.join(', ') + ' — shipped as built-in but deletable');

  const phantom = protectedIds.filter((p) => !defaults.includes(p));
  ok('…and nothing is protected that does not exist', phantom.length === 0, phantom.join(', '));
}

console.log('\n  losing them is visible, not silent');
{
  /* The repair existed before this test and was unreachable in practice: you
     had to already know it was there. */
  ok('there is a way to bring them back', /themeRestoreBuiltins\s*=/.test(T));
  ok('…reachable from the page', /themeRestoreBuiltins\(\)/.test(A));

  /* The part that was missing. A store in this state now says so, where the
     list should have been. */
  const render = T.slice(T.indexOf('function render()'), T.indexOf('renderPages();'));
  ok('…and the page says when they are missing',
    /built-in theme/.test(render) && /absent/.test(render),
    'the list renders short with nothing explaining why');
  ok('…naming which ones', /absent\.map/.test(render));
  ok('…with the fix next to the message', /themeRestoreBuiltins\(\)/.test(render),
    'a message with no button is a message that makes you go looking');

  /* It must not scare someone whose list is fine. */
  ok('…and stays quiet when nothing is missing',
    /absent\.length\s*\?/.test(render));
}

console.log('\n  restoring is additive');
{
  const fn = T.slice(T.indexOf('window.themeRestoreBuiltins'), T.indexOf('window.themeSave'));
  ok('only what is missing comes back', /missing\s*=\s*DEFAULT_MODES\.filter/.test(fn));
  ok('…appended rather than replacing the list', /state\.modes\.concat/.test(fn),
    'a restore that overwrites is the original bug wearing a different hat');
  ok('…so a recoloured built-in is left alone', /recoloured/.test(fn));
  ok('…and it says so before doing it', /confirm\(/.test(fn));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
