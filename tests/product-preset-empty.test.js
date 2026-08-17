/* A preset that holds no products — clearing the storefront without losing it.
 *
 * Asked for as: "a preset option that doesn't get rid of anything, but wipes all
 * of the products for that preset, don't delete any current settings though."
 *
 * So there are three promises to keep, and each is a way this could go wrong:
 *
 *   1. It holds NO products, so switching to it drafts the whole lineup.
 *   2. It DELETES nothing — products go to Draft, which keeps their images,
 *      prices, stock and reviews. A preset that reached for .delete() would be
 *      unrecoverable, and the panel is one click with one confirm.
 *   3. It changes NO settings. An ordinary preset captures the product-page
 *      layout and writes it back on switch; an empty one must capture none, or
 *      "clear the shop" quietly reverts a layout somebody edited afterwards.
 *
 * ── And one bug this file exists to keep dead ────────────────────────────────
 *
 * deleteProductPreset ended with `if (nameEl) nameEl.value = '';` where nameEl
 * was never declared in that function — a ReferenceError thrown AFTER the
 * delete had been written to the database. The preset was gone, the panel said
 * "Could not delete", and the chip stayed on screen until a reload. A throw
 * placed after the commit reports the opposite of what happened.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const MAIN = read('admin-main.js');
const HTML = read('admin.html');

/* Bounded to one function, comments stripped.
   Stripped because the assertions below check that certain things are ABSENT —
   prompt(), .delete(), a stray nameEl — and the comments explaining why they are
   absent name them. A scanner that cannot tell code from prose finds the
   explanation and reports it as the fault; that has happened five times in this
   codebase now, so it is done once here and relied on. */
function lift(name) {
  const starts = [
    'window.' + name + ' = async function',
    'async function ' + name + '(',
    'function ' + name + '(',
  ];
  let a = -1;
  for (const s of starts) { a = MAIN.indexOf(s); if (a >= 0) break; }
  if (a < 0) throw new Error(name + ' not found — renamed?');
  const b = MAIN.indexOf('\n        }', a);
  if (b <= a) throw new Error('could not bound ' + name);
  return MAIN.slice(a, b).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

console.log('\n  an empty preset clears the shop without losing it\n');

const CREATE = lift('_createProductPreset');
const SAVE_EMPTY = lift('saveEmptyProductPreset');
const SWITCH = lift('switchProductPreset');
const DELETE = lift('deleteProductPreset');
const UPDATE = lift('updateProductPreset');

console.log('  the pieces exist');
{
  ok('there is a button for it', /saveEmptyProductPreset\(\)/.test(HTML));
  ok('…and a handler behind it', /window\.saveEmptyProductPreset\s*=/.test(MAIN));
  ok('the shared create path was lifted', CREATE.length > 200, String(CREATE.length));
  ok('the switch handler was lifted', SWITCH.length > 400, String(SWITCH.length));
}

console.log('\n  promise 1 — it holds no products');
{
  ok('an empty preset stores an empty list', /empty\s*\?\s*\[\]\s*:\s*_snapshotLiveLineup\(\)/.test(CREATE),
    'otherwise it snapshots whatever is live and is not empty at all');
  ok('saving one asks for empty', /_createProductPreset\(name,\s*true\)/.test(SAVE_EMPTY));
  ok('saving the current lineup does not', /_createProductPreset\(name,\s*false\)/.test(lift('saveProductPreset')));
}

console.log('\n  promise 2 — it deletes nothing');
{
  /* The switch drafts. If this ever reaches for a delete, one confirm click
     destroys the catalogue. */
  ok('switching hides by setting Draft', /update\(\{\s*status:\s*'Draft'\s*\}\)/.test(SWITCH));
  ok('…and never deletes a product row', !/\.delete\(/.test(SWITCH),
    'a preset switch must be reversible');
  ok('the confirm says so in words', /Nothing is deleted/.test(SWITCH),
    'the person clicking it cannot read the source');
  ok('…and names what survives', /images, prices and stock/.test(SWITCH));
}

console.log('\n  promise 3 — it changes no settings');
{
  ok('an empty preset captures no product-page layout',
    /empty\s*\?\s*null\s*:\s*await\s*_currentProductPageLayout\(\)/.test(CREATE),
    'a captured layout would be written back over a later edit on switch');
  /* Step 3 of the switch is `if (p.productPage) upsert(product_page)`, so a null
     layout is what makes the switch leave site_settings alone. */
  ok('…and the switch only writes a layout when the preset has one',
    /if\s*\(p\.productPage\)/.test(SWITCH));
  ok('Update keeps an empty preset layout-free',
    /p\.productPage\s*=\s*p\.empty\s*\?\s*null\s*:/.test(UPDATE));
  ok('…but a preset that gains products stops being empty',
    /if\s*\(p\.products\.length\)\s*p\.empty\s*=\s*false/.test(UPDATE),
    'otherwise it would hold products and still refuse to carry a layout');
}

console.log('\n  it does not claim to be active while the shop is full');
{
  ok('active is only set when the preset matches what is live',
    /if\s*\(!empty\s*\|\|\s*!_snapshotLiveLineup\(\)\.length\)\s*_productPresets\.activePreset/.test(CREATE),
    'a lit chip beside a full shop says the switch already happened');
}

console.log('\n  the confirm describes the real action');
{
  ok('an empty preset gets its own wording', /takes ' \+ plural\(toHide\.length/.test(SWITCH),
    '"publishes 0 products" is true and tells you nothing');
  ok('nothing live is a message, not a no-op', /already what the storefront shows/.test(SWITCH));
  /* What gets hidden was being computed twice — once for the message that was
     never shown and once for the action. Two answers to one question drift. */
  const hides = (SWITCH.match(/filter\(pr =>/g) || []).length;
  ok('what gets hidden is computed once', hides === 1, 'found ' + hides + ' copies');
  ok('the way back is named before the switch, not after', /in no other preset/.test(SWITCH),
    'a hidden product in no preset has to be found by hand');
}

console.log('\n  the chip reads as a deliberate choice');
{
  ok('zero renders as a word, not 0', /n \|\| 'empty'/.test(MAIN),
    '"Blank 0" beside "Orig 11" looks like a preset that failed to save');
  ok('…and explains itself on hover', /No products — switching takes the whole lineup/.test(MAIN));
}

console.log('\n  the delete that reported failure after succeeding');
{
  ok('deleting no longer touches an undeclared nameEl', !/nameEl/.test(DELETE),
    'it threw AFTER the row was saved, so the panel said "could not delete" about a preset that was gone');
  ok('…and still re-renders', /renderProductPresets\(\)/.test(DELETE));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
