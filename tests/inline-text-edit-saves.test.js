/* An on-canvas text edit either reaches the saved settings, or says it didn't.
 *
 * THE BUG THIS EXISTS FOR. You clicked a line of text in the builder preview,
 * typed a new one, and it appeared. You pressed Publish. The live site still
 * showed the old words.
 *
 * Nothing was broken about publishing. The edit had never been saved. The
 * builder maps an on-canvas edit back to a settings field by looking for a
 * stored string equal to the text that was there before — and when it found
 * none it returned, silently:
 *
 *     if(!done)return;   // couldn't map the text back to a field — ignore
 *
 * The preview kept showing the new words because contentEditable had already
 * changed them in the iframe's DOM. So the builder looked like it had worked,
 * nothing was marked dirty, and the loss only surfaced at publish time, long
 * after the edit — which is the worst possible moment to find out.
 *
 * Two things made that miss happen far more often than it should have:
 *
 *   1. The preview read the text with innerText, which returns the RENDERED
 *      text — and Chrome applies text-transform to it. index.html:917 styles
 *      .notify-label `text-transform:uppercase`, and index.html:2412 stores
 *      "Get Early Access". So the lookup searched for "GET EARLY ACCESS" and
 *      the field held "Get Early Access". Every uppercase-styled label on the
 *      site was unsaveable for exactly this reason.
 *
 *   2. The search only looked at top-level strings and one level into arrays of
 *      objects, so anything nested deeper had no field to find.
 *
 * These tests run the real functions, lifted out of builder.html, against the
 * real shape of a section's settings.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  - ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const B = read('builder.html');
const SF = read('storefront.js');

/* ── Lift the mapping out of builder.html and run it for real ─────────────── */
function lift(name) {
  const i = B.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let d = 0, started = false;
  for (let j = i; j < B.length; j++) {
    if (B[j] === '{') { d++; started = true; }
    else if (B[j] === '}') { d--; if (started && d === 0) return B.slice(i, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

let sections, dirtied, applied, opened;
const sandbox = {
  curSections: () => sections,
  curApply: () => { applied++; },
  curDirty: () => { dirtied++; },
  openEditor: () => { opened++; },
  selId: null,
  console,
};
vm.createContext(sandbox);
vm.runInContext(
  [lift('_zwNormText'), lift('_zwLoose'), lift('_zwStringSlots'), lift('applyInlineText')].join('\n'),
  sandbox
);
const applyInlineText = (id, o, n) => sandbox.applyInlineText(id, o, n);

const reset = (settings) => {
  sections = [{ id: 'sec1', type: 'release', settings }];
  dirtied = applied = opened = 0;
};

console.log('\nThe edit reaches the settings');
{
  reset({ notify_label: 'Get Early Access', heading: 'Release' });
  const r = applyInlineText('sec1', 'Get Early Access', 'Join the list');
  ok('a top-level field is found and written', r.ok && sections[0].settings.notify_label === 'Join the list');
  ok('and the change is marked unsaved', dirtied === 1 && applied === 1,
    'an edit that does not mark the builder dirty is an edit that never gets written');

  reset({ heading: 'Release', cards: [{ title: 'One', body: 'first' }, { title: 'Two', body: 'second' }] });
  ok('so is one inside an array of objects',
    applyInlineText('sec1', 'Two', 'Deux').ok && sections[0].settings.cards[1].title === 'Deux');
  ok('...and its neighbours are untouched', sections[0].settings.cards[0].title === 'One');

  /* The old search stopped one level into arrays. Anything deeper had no field
     to find, so the edit was dropped. */
  reset({ groups: [{ slides: [{ caption: 'Deep one' }] }] });
  ok('and one nested deeper than the old search reached',
    applyInlineText('sec1', 'Deep one', 'Deep two').ok &&
    sections[0].settings.groups[0].slides[0].caption === 'Deep two');

  reset({ block: { inner: { label: 'Buried' } } });
  ok('objects nest as well as arrays',
    applyInlineText('sec1', 'Buried', 'Found').ok &&
    sections[0].settings.block.inner.label === 'Found');
}

console.log('\nThe case that made uppercase labels unsaveable');
{
  /* index.html:917 renders .notify-label uppercase; index.html:2412 stores it
     mixed-case. Before the fix, the canvas reported "GET EARLY ACCESS" and the
     lookup for that string found nothing. */
  reset({ notify_label: 'Get Early Access' });
  const r = applyInlineText('sec1', 'GET EARLY ACCESS', 'Early access');
  ok('a CSS-uppercased label still maps to its mixed-case field',
    r.ok && sections[0].settings.notify_label === 'Early access',
    'this is the exact shape of the reported bug');

  reset({ notify_label: 'Get  Early\nAccess' });
  ok('so does one whose whitespace was re-flowed by layout',
    applyInlineText('sec1', 'Get Early Access', 'x').ok);

  /* Exact must still beat loose, or an edit lands in the wrong field. */
  reset({ a: 'Shop Now', b: 'SHOP NOW' });
  applyInlineText('sec1', 'SHOP NOW', 'Buy');
  ok('an exact match wins over a near neighbour',
    sections[0].settings.b === 'Buy' && sections[0].settings.a === 'Shop Now');
}

console.log('\nWhen it cannot be saved, it says so');
{
  reset({ heading: 'Release' });
  const r = applyInlineText('sec1', 'Text baked into the template', 'Nope');
  ok('an unmappable edit is refused, not swallowed', r.ok === false);
  ok('with a reason a person can act on', typeof r.reason === 'string' && r.reason.length > 30);
  ok('and nothing is marked dirty', dirtied === 0,
    'marking it dirty would publish a change that was never stored');

  reset(null);
  ok('a section with no settings is refused too', applyInlineText('sec1', 'x', 'y').ok === false);
  reset({ heading: 'Release' });
  ok('so is an empty original', applyInlineText('sec1', '   ', 'y').ok === false);
  ok('an unknown section is refused', applyInlineText('nope', 'a', 'b').ok === false);

  /* A cycle can arrive from the database; the walk must not hang on it. */
  const cyc = { label: 'Start' }; cyc.self = cyc;
  reset(cyc);
  ok('a cyclic settings object terminates', applyInlineText('sec1', 'Start', 'End').ok);
}

console.log('\nThe preview is told, every time');
{
  ok('the builder answers the message', B.includes('ZW_INLINE_TEXT_RESULT'));
  ok('the answer carries the reason', /ok:!!r\.ok,reason:r\.reason/.test(B));
  ok('the preview reverts the words when the answer is no',
    /p\.el\.textContent = p\.was/.test(SF),
    'otherwise it keeps showing an edit that was never stored — the original bug');
  ok('and shows why', SF.includes('flashRejected'));
  ok('a commit waits for the answer instead of assuming', /pending\[id\] = \{ el: el, was: was \}/.test(SF));
  ok('the reply is origin-checked', /ZW_INLINE_TEXT_RESULT/.test(SF) && /e\.origin !== location\.origin/.test(SF));
}

console.log('\nMore of the text can be clicked');
{
  const m = SF.match(/var EDITABLE = \/\^\(([^)]*)\)\$\//);
  ok('the editable tag list was found', !!m);
  const tags = m ? m[1].split('|') : [];
  for (const t of ['LABEL', 'SMALL', 'FIGCAPTION', 'TD', 'TH', 'DT', 'DD', 'TIME', 'B', 'I']) {
    ok('<' + t.toLowerCase() + '> counts as text now', tags.includes(t));
  }
  ok('a click walks up to the nearest editable ancestor', SF.includes('function editableFrom'),
    'clicking a label\'s padding used to hit an element the list rejected and do nothing');
  ok('leafness is decided by text, not by tag name', SF.includes('function isTextLeaf'),
    'the old check omitted div, so div-of-divs read as a leaf and div-of-span did not');
  ok('the old tag-list leaf check is gone',
    !SF.includes("querySelector('h1,h2,h3,h4,h5,h6,p,a,button,li,span')"));
  ok('the text is read unrendered', /function txt\(el\)\{ return \(el\.textContent/.test(SF),
    'innerText applies text-transform, which is what broke the mapping');
  ok('the cursor hints at everything that is editable',
    /body\.zw-text-edit \[data-zw-sec\][^']*label,small/.test(SF));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
