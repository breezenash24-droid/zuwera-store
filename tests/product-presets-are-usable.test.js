/* A button that does nothing, silently, because a dialog was suppressed.
 *
 * Product Presets snapshot which products are live and switch the whole shop in
 * one click. Reported symptom: "it says save original, but it won't allow me to
 * create a new one that I can use."
 *
 * The create path was:
 *
 *     const name = (prompt('Name this preset …') || '').trim();
 *     if (!name) return;
 *
 * prompt() returns null in two completely different situations — the person
 * pressed Cancel, and THE BROWSER REFUSED TO ASK. Chrome offers "prevent this
 * page from creating additional dialogs" after a few, and this panel shows a
 * confirm() on every preset switch, so it is an easy state to reach. Once there,
 * the button returns immediately and says nothing. No toast, no error, no
 * console line. Indistinguishable from broken.
 *
 * Rename had the identical shape.
 *
 * ── What is asserted ────────────────────────────────────────────────────────
 *
 * The name comes from a field on the page, not a dialog, so there is no state
 * in which the browser can decline to collect it. And an empty name SAYS so —
 * an early return with no feedback is the thing being fixed, not the dialog.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const MAIN = read('admin-main.js');
const HTML = read('admin.html');

/* Bounded to each handler, so an assertion about saving cannot be satisfied by
   something in renaming. */
function handler(name) {
  let a = -1, end = '\n        };';
  for (const [start, close] of [
    ['window.' + name + ' = async function', '\n        };'],
    ['async function ' + name + '(', '\n        }'],
    ['function ' + name + '(', '\n        }'],
  ]) {
    a = MAIN.indexOf(start);
    if (a >= 0) { end = close; break; }
  }
  if (a < 0) throw new Error(name + ' not found — it has been renamed');
  const b = MAIN.indexOf(end, a);
  if (b <= a) throw new Error('could not bound ' + name);
  /* Comments stripped. The assertions below check that prompt() is GONE, and the
     comments explaining why it went mention it by name — a scanner that cannot
     tell code from prose finds the explanation and reports it as the fault. That
     is the fourth time this exact slip has appeared today. */
  return MAIN.slice(a, b).replace(/\/\*[\s\S]*?\*\//g, '');
}

console.log('\n  product presets can actually be created\n');

/* THE CREATE PATH, not one function.
   These checks are about a property — "the name comes from the page and an
   empty one is reported" — and that property is kept by saveProductPreset
   together with the two helpers it delegates to. Pinning them to whichever
   function happened to hold the code broke all six the moment a second caller
   (the empty preset) made sharing it the obvious thing to do. The property did
   not change; only its address did. */
const SAVE = handler('saveProductPreset') + handler('_newPresetName') + handler('_createProductPreset');
const RENAME = handler('renameProductPreset');

console.log('  the handlers were lifted');
{
  ok('the create path was found', SAVE.length > 400, String(SAVE.length));
  ok('rename was found', RENAME.length > 200, String(RENAME.length));
}

console.log('\n  the name comes from the page, not a dialog');
{
  ok('there is a field for it', /id="prodPresetName"/.test(HTML));
  ok('save reads that field', /getElementById\('prodPresetName'\)/.test(SAVE));
  ok('rename reads it too', /getElementById\('prodPresetName'\)/.test(RENAME));

  /* The regression: a suppressed dialog is a state the browser can put you in,
     and no amount of care in the handler can detect it. */
  ok('save no longer calls prompt()', !/\bprompt\(/.test(SAVE),
    'prompt() returning null is both "cancelled" and "the browser refused to ask"');
  ok('rename no longer calls prompt()', !/\bprompt\(/.test(RENAME));
}

console.log('\n  an empty name says so instead of returning quietly');
{
  ok('save reports it', /showToast\('Give the preset a name first/.test(SAVE),
    'a bare `if (!name) return;` is exactly what looked like a dead button');
  ok('…and puts the cursor where the fix is', /nameEl\.focus\(\)/.test(SAVE));
  ok('rename reports it', /showToast\('Edit the name in the box/.test(RENAME));
  ok('…and pre-fills the current name so it reads as a rename',
    /nameEl\.value = p\.name/.test(RENAME));
}

console.log('\n  two presets cannot share a name');
{
  /* Two chips with the same label that switch to different lineups is a shop
     whose state depends on which of two identical buttons you pressed. */
  ok('a duplicate name is refused', /already a preset called/.test(SAVE));
  ok('…case-insensitively', /toLowerCase\(\) === name\.toLowerCase\(\)/.test(SAVE));
}

console.log('\n  the field does not linger');
{
  ok('saving clears it', /nameEl\.value = ''/.test(SAVE),
    'a stale name in the box reads as the next preset already being named');
  ok('renaming clears it too', /nameEl\.value = ''/.test(RENAME));
}

console.log('\n  switching still explains itself');
{
  const SWITCH = handler('switchProductPreset');
  /* A confirm() here is fine and worth keeping: it is a destructive publish and
     the copy names the count. If IT is suppressed the switch simply does not
     happen, which is the safe direction — unlike a silent create. */
  ok('the switch still confirms', /confirm\(/.test(SWITCH));
  /* Matched on the counts being IN the message rather than on its wording — the
     previous version required the literal phrases "publishes the preset" and
     "hides the rest", so rewriting the copy to cover the empty case broke a
     check whose subject had not changed. */
  ok('…and says how many it publishes and hides',
    /publishes ' \+ plural\(wanted\.length/.test(SWITCH) && /hides ' \+ plural\(toHide\.length/.test(SWITCH));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
