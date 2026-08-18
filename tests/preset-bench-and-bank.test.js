/* Building a preset off-stage, and the bank that holds what it puts away.
 *
 * Two things were true and both were wrong:
 *
 *   1. Every action worked on activePreset — the one the STOREFRONT is wearing.
 *      So the only preset you could change was the one already published: to
 *      build a lineup you had to put it in front of customers first.
 *
 *   2. Switching a preset drafted everything it hid. Draft already means "I am
 *      still working on this", so eleven shelved products landed in the same
 *      pile as the three being edited and the word stopped meaning anything.
 *
 * ── Why the bank is NOT a product status ────────────────────────────────────
 *
 * The obvious fix is a fifth status. It is also the dangerous one: product
 * visibility is decided in several places with a mix of allow-lists
 * (status=eq.Live) and deny-lists (status !== 'Draft'), and a status those
 * deny-lists have never heard of is a shelved product on sale. The worst
 * outcome of an untidy admin table is an untidy admin table; the worst outcome
 * of a leaked status is a customer buying something you put away.
 *
 * So the bank is admin-only metadata beside the presets, and membership is
 * DERIVED — in the list AND still Draft. Set a banked product Live by any route
 * and it leaves the bank on its own, which is what stops the flag going stale
 * in the places nobody remembered to update.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const MAIN = read('admin-main.js');
const HTML = read('admin.html');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function lift(name) {
  const starts = [
    'window.' + name + ' = async function', 'window.' + name + ' = function',
    'async function ' + name + '(', 'function ' + name + '(',
  ];
  let a = -1;
  for (const s of starts) { a = MAIN.indexOf(s); if (a >= 0) break; }
  if (a < 0) throw new Error(name + ' not found — renamed?');
  const b = MAIN.indexOf('\n        }', a);
  if (b <= a) throw new Error('could not bound ' + name);
  return strip(MAIN.slice(a, b));
}

console.log('\n  a preset can be built without publishing it\n');

const SWITCH = lift('switchProductPreset');
const EDITOR = lift('renderPresetEditor');
const SAVE_CONTENTS = lift('savePresetContents');
const UNBANK = lift('unbankProduct');
const FILTER = lift('getFilteredSortedProducts');
const ISBANKED = lift('_isBanked');

console.log('  editing is separate from publishing');
{
  ok('there is a selection distinct from the live preset', /let _selectedPreset/.test(MAIN),
    'everything used to act on activePreset, so only the published preset was editable');
  ok('clicking a chip selects rather than switches',
    /onclick="selectProductPreset/.test(MAIN) && !/onclick="switchProductPreset\(\\'/.test(MAIN),
    'a click used to publish to the real storefront');
  ok('publishing has its own button', /makeProductPresetLive\(\)/.test(HTML));
  ok('…and it is the only thing that calls the switch',
    /switchProductPreset\(_selectedPreset\)/.test(MAIN));

  /* If these still read activePreset you could only edit what was live. */
  ok('update/rename/delete act on the selection',
    (MAIN.match(/_prodPresetById\(_selectedPreset\)/g) || []).length >= 3,
    'found ' + (MAIN.match(/_prodPresetById\(_selectedPreset\)/g) || []).length);
  ok('nothing still edits by way of the live preset',
    !/_prodPresetById\(_productPresets\.activePreset\)/.test(MAIN));
}

console.log('\n  the contents editor touches no product');
{
  ok('there is an editor', /toggleProductPresetEditor/.test(HTML) && EDITOR.length > 400);
  /* THE WHOLE POINT. If this wrote products.status the storefront would change
     while you were still deciding. */
  ok('it never writes a product status', !/from\('products'\)/.test(EDITOR) && !/from\('products'\)/.test(SAVE_CONTENTS),
    'composing a lineup must not publish it');
  /* The property is "this handler writes the preset and nothing else". Stated as
     "no table is touched directly" rather than by hunting for the substring
     `status:` — which appears legitimately in the member it builds, on the same
     line as the part the old version tried to mask off, so the check fired on
     correct code. */
  ok('saving contents only writes the preset',
    /_saveProductPresetsState\(\)/.test(SAVE_CONTENTS) && !/sb\.from\(/.test(SAVE_CONTENTS),
    'the preset is data; the storefront is not touched until Make live');
  ok('…and says it is not live yet', /Not live yet/.test(SAVE_CONTENTS));
  ok('a saved member keeps the status the preset recorded',
    /\(was && was\.status\) \|\| 'Live'/.test(SAVE_CONTENTS),
    'a Sold Out item must not be silently promoted to Live');
  ok('Legacy is not offered as a candidate', /!== 'Legacy'/.test(EDITOR),
    'the retired shelf should not be resurrected by ticking a box');
}

console.log('\n  the bank is not a product status');
{
  ok('membership is derived, not stored as truth',
    /\(p\.status \|\| 'Draft'\) !== 'Draft'/.test(ISBANKED) && /banked \|\| \[\]\)\.indexOf/.test(ISBANKED),
    'in the list AND still Draft — so publishing by any route un-banks it');
  ok('no new status reaches the products table',
    !/status:\s*'Banked'/.test(MAIN) && !/'Shelved'/.test(MAIN),
    'a status the storefront deny-lists have never heard of is a shelved product on sale');
  ok('the switch still hides by setting Draft', /update\(\{ status: 'Draft' \}\)/.test(SWITCH));
  ok('…and records what it put away', /_productPresets\.banked = Array\.from\(bank\)/.test(SWITCH));
  ok('…and takes the published ones back out',
    /wantedIds\.forEach\(x => bank\.delete/.test(SWITCH),
    'a product cannot be on the storefront and in the bank at once');
}

console.log('\n  the bank keeps out of the way without hiding');
{
  ok('the default view excludes it', /_prodStatusFilter === 'all'[\s\S]{0,200}!_isBanked\(p\)/.test(FILTER));
  ok('Draft keeps meaning "being worked on"',
    /_prodStatusFilter === 'draft'[\s\S]{0,160}!_isBanked\(p\)/.test(FILTER));
  ok('there is a view that shows it', /_prodStatusFilter === 'banked'/.test(FILTER)
    && /data-f="banked"/.test(HTML));
  /* Excluding rows from "All" without saying so is how a product goes missing. */
  ok('the count is on the chip', /prodBankCount/.test(MAIN) && /prodBankCount/.test(HTML));
  ok('…and the page says how many it is not showing',
    /in the bank and hidden here/.test(MAIN),
    '"All" that silently means "some" is how a product goes missing');
  ok('the chip is hidden until there is a bank', /btn\.style\.display = n \? '' : 'none'/.test(MAIN));
}

console.log('\n  a clean slate is reachable directly');
{
  /* Banking used to happen only as a side effect of switching to a preset, so
     the only way to clear the decks was to publish an empty shop first — the
     same "you have to do it live" problem the bench fixes one level up. */
  const BANKBULK = lift('prodBulkBank');
  ok('the products table can bank a selection', /prodBulkBank\(\)/.test(HTML));
  ok('…without going through a preset', BANKBULK.length > 300, String(BANKBULK.length));
  /* The bank is DERIVED from the status, so a list write before the status
     write would be a no-op until the status landed. */
  const st = BANKBULK.indexOf("update({ status: 'Draft' })");
  const bk = BANKBULK.indexOf('_productPresets.banked = Array.from(bank)');
  ok('it drafts before it banks', st >= 0 && bk > st, 'status=' + st + ' bank=' + bk);
  ok('…and says nothing is deleted', /Nothing is deleted/.test(BANKBULK));
  ok('…and is gated like the other bulk writes', /zwGuard\('bulk_edit'/.test(BANKBULK));

  /* The editor is the other place the old catalogue was in your face. */
  ok('the editor separates banked from everything else',
    /notMember\.filter\(x => !_isBanked\(x\)\)/.test(EDITOR)
      && /notMember\.filter\(_isBanked\)/.test(EDITOR),
    'listing them under "Everything else" puts the shelved catalogue straight back');
  ok('…and collapses them rather than dropping them',
    /<details/.test(EDITOR) && /In the bank/.test(EDITOR),
    'a preset you cannot add a banked product to makes the bank a one-way door');
  /* Collapsed <details> keeps its inputs in the DOM, so a ticked banked product
     still reaches the save. */
  ok('a ticked banked product is still read on save',
    /querySelectorAll\('#presetEditor input\[type="checkbox"\]'\)/.test(lift('_readPresetEditorSelection')),
    'the read must not be scoped to the open sections');
}

console.log('\n  an empty preset looks empty');
{
  /* The candidate list sat open directly under the words "Contents of X", so a
     preset holding nothing displayed eleven products beneath the heading naming
     its own contents. It meant "things you could add"; it read as "what is in
     here". Reported exactly that way: "I started with an empty preset, it should
     remove all of the products from below". */
  ok('the picker is shut until asked for',
    EDITOR.includes('<details style="margin-top:12px;"') && EDITOR.includes('+ Add products'),
    'an empty preset must not list the whole catalogue under its own contents');
  ok('...and says how many are outside the preset', EDITOR.includes('not in this preset'));

  /* A re-render would drop ticks made before it was shut; <details> keeps its
     inputs in the DOM, which is why this is a disclosure and not a state flag. */
  ok('shutting it cannot lose a tick',
    lift('_readPresetEditorSelection').includes("querySelectorAll('#presetEditor input[type=\"checkbox\"]')"),
    'the read walks the whole panel, so the picker must stay in the DOM when closed');
  ok('the heading no longer promises a list that is not shown',
    !EDITOR.includes('Tick what belongs in this preset') && EDITOR.includes('+ Add products</strong>'));
}

console.log('\n  the buttons say what they do');
{
  /* Seven verbs with no object - "Update" what, with what, and does the shop
     move? Colour carries the cost; the strip carries the meaning. */
  const helps = (HTML.match(/data-help="/g) || []).length;
  ok('every preset action carries an explanation', helps >= 7, 'found ' + helps);
  ok('there is somewhere to show it', HTML.includes('id="presetHelp"'));
  ok('...and it is announced to screen readers', HTML.includes('aria-live="polite"'));

  const BIND = lift('bindPresetHelp');
  ok('hover, focus and click all explain',
    BIND.includes("'mouseenter'") && BIND.includes("'focus'") && BIND.includes("'click'"),
    'a title attribute answers only the first of those');
  /* Four of the seven start disabled and fire no pointer events of their own. */
  ok('a disabled button can still be explained',
    BIND.includes('.zw-preset-actions') && BIND.includes('mousemove'),
    'otherwise the four that start disabled are the four you can never get help for');
  ok('...and says why it is disabled rather than describing what it will not do',
    BIND.includes('pick a preset first'));
  ok('binding twice does not stack listeners', BIND.includes('box.dataset.bound'),
    'renderProductPresets runs on every change');

  /* Colour is the consequence. Only one of these is visible to a customer. */
  ok('Make live is the only one coloured as publishing', HTML.includes('#16a34a'));
  ok('overwriting is warned in amber', HTML.includes('#d97706'));
  ok('removing is red', HTML.includes('#dc2626'));
  ok('the resting text names the one customers see',
    HTML.includes('is the only button here that changes what customers see'));
}

console.log('\n  there is a way back out');
{
  ok('a banked row offers Unbank instead of Archive', /unbankProduct\('\$\{productId\}'\)/.test(MAIN));
  ok('unbanking does not publish', !/from\('products'\)/.test(UNBANK),
    'taking something off a shelf is not putting it in the window');
  ok('…and says so', /Nothing is published/.test(UNBANK));
  ok('emptying the whole bank is possible', /_bankedProducts\(\)\.map/.test(UNBANK));
}

console.log('\n  the two views cannot disagree about which filter is on');
{
  ok('one function changes the filter', /window\.setProductFilter = function/.test(MAIN));
  ok('…and it lights the matching chip',
    /classList\.toggle\('active', b\.dataset\.f === _prodStatusFilter\)/.test(MAIN));
  ok('the chip handler goes through it', /setProductFilter\(btn\.dataset\.f\)/.test(MAIN));
}

console.log('\n  the table learns about the bank before it is drawn');
{
  /* loadProducts() renders and THEN loads the presets, so the first paint does
     not know what is banked. */
  const LOAD = lift('loadProductPresets');
  ok('loading presets redraws the list', /renderProducts\(\)/.test(LOAD),
    'otherwise the first paint shows banked products until something else redraws');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
