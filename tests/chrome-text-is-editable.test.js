/* Text the page builder could not reach: the nav, the bar, and template copy.
 *
 * A section can be edited on the canvas because a section has settings to write
 * into. Three kinds of text had no such home, so they could not be edited at
 * all — and the nav and the announcement bar are on EVERY page, which made them
 * the most conspicuous things the builder could not touch.
 *
 * THE RULE THIS FILE HOLDS: text is written to whoever already owns it.
 *
 *   nav labels    → site_settings.nav_menu[i].label      (existing owner)
 *   bar message   → site_settings.announcement_bar.message (existing owner)
 *   anything else → site_settings.text_overrides           (new; nobody owned it)
 *
 * The first two are NOT copied into a builder-side store. A value settable in
 * two places that disagree is the fault this codebase already had to remove
 * from the announcement bar once — it had a message field in the builder
 * writing builder_theme.bar_text while the live bar read announcement_bar, and
 * the builder's copy was simply never read by anything. Re-adding that with a
 * nicer interface would be the same mistake.
 *
 * Everything is a DRAFT. Nothing typed on the canvas reaches a shopper until
 * Publish, which is what makes this consistent with section edits rather than a
 * second, surprising way for the live site to change.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  - ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const B = read('builder.html');
const COPY = read('zw-copy.js');
const NAV = read('nav-menu.js');
const BAR = read('announcement-bar.js');
const SAVE = read('functions/api/save-page-builder.js');
const MIG = read('migrations/0026_text_the_builder_can_edit_anywhere.sql');

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

let sections = [];
const sandbox = {
  chromeNav: null, chromeBar: null, chromeCopy: {}, chromeDirty: false,
  markDirty() {}, showErr() {}, console,
  curSections: () => sections, curApply() {}, curDirty() {}, openEditor() {}, selId: null,
};
vm.createContext(sandbox);
vm.runInContext(
  'var markChromeDirty = function(){ chromeDirty = true; };\n' +
  [lift('applyChromeField'), lift('applyTextOverride'), lift('clearOverrideAt'),
   lift('_zwNormText'), lift('_zwLoose'), lift('_zwStringSlots'), lift('applyInlineText')].join('\n') +
  '\nvar sendChrome = function(){};',
  sandbox
);

/* Exactly what the message dispatcher does: prefer a section field, fall
   through to an override when no field holds the text. */
function canvasEdit(d) {
  let r = sandbox.applyInlineText(d.sectionId, d.oldText, d.newText);
  if (r && !r.ok && r.canOverride && d.path) {
    r = sandbox.applyTextOverride(d.page, d.path, d.was != null ? d.was : d.oldText, d.newText);
  }
  return r;
}
const setState = (nav, bar, copy) => {
  sandbox.chromeNav = nav; sandbox.chromeBar = bar; sandbox.chromeCopy = copy;
  sandbox.chromeDirty = false;
};

console.log('\nThe nav writes to the nav, not to a copy of it');
{
  setState([{ type: 'gender', label: 'Men' }, { type: 'tag', label: 'New' }], {}, {});
  const r = sandbox.applyChromeField('nav.1.label', 'Latest');
  ok('a nav label lands on nav_menu[i].label', r.ok && sandbox.chromeNav[1].label === 'Latest');
  ok('...and its neighbour is untouched', sandbox.chromeNav[0].label === 'Men');
  ok('and the builder knows it is unsaved', sandbox.chromeDirty === true);

  setState([{ label: 'Men' }], {}, {});
  ok('an index that no longer exists is refused', sandbox.applyChromeField('nav.9.label', 'x').ok === false);
  ok('and nothing is marked unsaved', sandbox.chromeDirty === false);
  ok('an unknown field name is refused', sandbox.applyChromeField('what.ever', 'x').ok === false);
}

console.log('\nThe bar writes to the bar');
{
  setState([], { message: 'FREE SHIPPING', mode: 'on' }, {});
  const r = sandbox.applyChromeField('bar.message', 'FREE RETURNS');
  ok('the message lands on announcement_bar.message', r.ok && sandbox.chromeBar.message === 'FREE RETURNS');
  ok('the rest of the bar config survives', sandbox.chromeBar.mode === 'on',
    'writing the whole object would silently reset the behaviour and the page list');
}

console.log('\nCopy nobody owns gets an override, anchored to the original');
{
  setState([], {}, {});
  const r = sandbox.applyTextOverride('/', 'p.hero:0', 'Original words', 'New words');
  ok('an override is recorded under page and path',
    r.ok && sandbox.chromeCopy['/']['p.hero:0'].now === 'New words');
  ok('the ORIGINAL is kept as the anchor', sandbox.chromeCopy['/']['p.hero:0'].was === 'Original words');
  ok('and it is handed back to the preview', r.was === 'Original words');

  /* Editing twice must not record the first edit as the thing being replaced —
     the anchor has to stay the template's own words or the override stops
     matching the page and silently stops applying. */
  const r2 = sandbox.applyTextOverride('/', 'p.hero:0', 'New words', 'Newer words');
  ok('a second edit keeps the first anchor',
    r2.ok && sandbox.chromeCopy['/']['p.hero:0'].was === 'Original words' &&
    sandbox.chromeCopy['/']['p.hero:0'].now === 'Newer words');

  /* Typing the original back is not an override of anything. */
  sandbox.applyTextOverride('/', 'p.hero:0', 'x', 'Original words');
  ok('typing the original back removes the override', !sandbox.chromeCopy['/']);

  setState([], {}, {});
  ok('an element with no path is refused', sandbox.applyTextOverride('/', '', 'a', 'b').ok === false);

  setState([], {}, {});
  sandbox.applyTextOverride('/about', 'h1:0', 'About', 'Our story');
  sandbox.applyTextOverride('/', 'h1:0', 'Home', 'Welcome');
  ok('overrides are per page, not global',
    sandbox.chromeCopy['/about']['h1:0'].now === 'Our story' &&
    sandbox.chromeCopy['/']['h1:0'].now === 'Welcome',
    'the same element path means different things on different pages');
}

console.log('\nTemplate copy INSIDE a section still gets saved');
{
  /* THE REGRESSION THIS EXISTS FOR. Being inside a section was treated as
     final, so text the section had no field for was refused — and the preview
     snapped the words straight back. That is most of the page: the release
     section is settings-driven for four strings (eyebrow, title, notify_label,
     launch date) while "LAUNCHING IN", "DAYS", "No spam, ever." and the button
     are plain markup with nothing behind them. A section is a PREFERENCE now,
     not an exclusion. */
  sections = [{ id: 'rel', settings: { eyebrow: 'Zuwera Release 001', notify_label: 'Get Early Access' } }];
  setState([], {}, {});
  const r = canvasEdit({ sectionId: 'rel', oldText: 'No spam, ever.', newText: 'We never share it.',
                         page: '/', path: 'p.notify-hint:2', was: 'No spam, ever.' });
  ok('markup with no field falls through to an override', r.ok === true,
    'this is the edit that used to be rejected and visibly reverted');
  ok('and it is stored as page copy', sandbox.chromeCopy['/']['p.notify-hint:2'].now === 'We never share it.');
  ok('anchored to the template words', sandbox.chromeCopy['/']['p.notify-hint:2'].was === 'No spam, ever.');

  /* A real field must still win, or the same string is stored twice and the two
     copies can disagree — the fault this whole area keeps producing. */
  setState([], {}, {});
  sections = [{ id: 'rel', settings: { notify_label: 'Get Early Access' } }];
  const r2 = canvasEdit({ sectionId: 'rel', oldText: 'Get Early Access', newText: 'Early access',
                          page: '/', path: 'p.notify-label:0', was: 'Get Early Access' });
  ok('a section field still wins over an override',
    r2.ok === true && sections[0].settings.notify_label === 'Early access');
  ok('...and no override is written for it', !sandbox.chromeCopy['/']);

  /* End to end for the uppercase case: CSS-transformed text matched loosely
     must land in the field, not become a stray override beside it. */
  setState([], {}, {});
  sections = [{ id: 'rel', settings: { notify_label: 'Get Early Access' } }];
  canvasEdit({ sectionId: 'rel', oldText: 'GET EARLY ACCESS', newText: 'Join up',
               page: '/', path: 'p.notify-label:0', was: 'GET EARLY ACCESS' });
  ok('an uppercase-styled label still reaches its field',
    sections[0].settings.notify_label === 'Join up' && !sandbox.chromeCopy['/']);

  setState([], {}, {});
  sections = [];
  ok('a section that no longer exists does not lose the words',
    canvasEdit({ sectionId: 'gone', oldText: 'Some words', newText: 'Other words',
                 page: '/', path: 'p:0', was: 'Some words' }).ok === true);

  ok('the dispatcher wires the fall-through', /r\.canOverride&&d\.path\) r=applyTextOverride/.test(B));
  ok('and the preview sends the path alongside the section id',
    /type: 'ZW_INLINE_TEXT', id: id, sectionId: sec[\s\S]{0,160}path: elPath\(el\)/.test(COPY),
    'without it the builder has nothing to fall through to');
}

console.log('\nAn element path means the same thing in both places it is used');
{
  /* An override is WRITTEN in the builder preview and READ on the live page,
     and those two DOMs are not identical — the preview injects elements the
     live page has never had. Anything in the key that depends on what is
     around the element therefore has to be written the same way in both.

     The index was not. It was emitted only when an element had siblings, so
     the same element was `div` as an only child and `div:0` once a sibling
     appeared. Live data caught this: every stored key carries `:0` on a
     wrapper that, on the plain page, is an only child and computes no index at
     all — so not one of them could ever match. */
  const LIVE_KEYS = [
    '#about>div.zw-reveal.zw-revealed:0>h2.about-h2',
    '#drop001>div.drop-inner:1>div.zw-reveal.zw-revealed:0>div.drop-title>span',
  ];
  ok('the index is always written', /\+ ':' \+ idx\);/.test(COPY) && !/sibs > 1 \? ':' \+ idx/.test(COPY));
  ok('and a stored key without one is read as zero', /\(idx \|\| ':0'\)/.test(COPY));

  /* Run the real normaliser over the real keys. */
  const box = { console };
  vm.createContext(box);
  vm.runInContext(
    COPY.slice(COPY.indexOf('var VOLATILE_CLASS'), COPY.indexOf('function loosePath')) +
    COPY.slice(COPY.indexOf('function normStoredPath'), COPY.indexOf('/* One pass over the leaves')),
    box
  );
  const normed = LIVE_KEYS.map(box.normStoredPath);
  ok('the volatile classes come out of a stored key',
    normed.every((p) => !/zw-reveal|zw-revealed/.test(p)), normed.join(' | '));
  ok('every segment ends up carrying an index',
    normed.every((p) => p.split('>').every((s) => s[0] === '#' || /:\d+$/.test(s))), normed.join(' | '));
  ok('and the about heading normalises to what the page computes',
    normed[0] === '#about>div:0>h2.about-h2:0', normed[0]);
  ok('an already-clean key is left alone', box.normStoredPath('#a>p.copy:2') === '#a>p.copy:2');
}

console.log('\nOne line of a multi-line field goes to the field');
{
  /* A setting holding "Release\n001" is rendered as `Release<br><span>001</span>`.
     Clicking the span reports "001", which equals no field, so the whole thing
     fell through to a page override — which then fought the renderer for the
     same words, and the number appeared not to save. Live data had exactly
     this: an override with was:"001" sitting beside a title setting containing
     it. */
  sections = [{ id: 'rel', settings: { title: 'Release\n001', eyebrow: 'Drop' } }];
  setState([], {}, {});
  const r = canvasEdit({ sectionId: 'rel', oldText: '001', newText: '002',
                         page: '/', path: 'div.drop-title:0>span:0', was: '001' });
  ok('the matching line is replaced', r.ok && sections[0].settings.title === 'Release\n002');
  ok('...and the other line survives', sections[0].settings.title.split('\n')[0] === 'Release');
  ok('...and no override is written to fight the renderer', !sandbox.chromeCopy['/'],
    'storefront.js rewrites the title from settings on every push');

  sections = [{ id: 'rel', settings: { title: 'Release\n001' } }];
  setState([], {}, {});
  canvasEdit({ sectionId: 'rel', oldText: 'RELEASE', newText: 'Drop',
               page: '/', path: 'p:0', was: 'RELEASE' });
  ok('a CSS-uppercased line matches too', sections[0].settings.title === 'Drop\n001');

  /* A whole-field match must still beat a line match, or editing a one-line
     field could rewrite a line of a different one. */
  sections = [{ id: 'rel', settings: { a: 'Release\n001', b: 'Release' } }];
  setState([], {}, {});
  canvasEdit({ sectionId: 'rel', oldText: 'Release', newText: 'Drop',
               page: '/', path: 'p:0', was: 'Release' });
  ok('a whole-field match still wins over a line match',
    sections[0].settings.b === 'Drop' && sections[0].settings.a === 'Release\n001');
}

console.log('\nAn override survives the classes that come and go');
{
  /* scroll-reveal.js puts zw-reveal on everything it watches and zw-revealed on
     each element as it scrolls into view. Baking classes into the key meant the
     same paragraph had one identity above the fold and another once you had
     scrolled to it — so an override saved while revealed silently stopped
     matching, and the text "just didn't update". */
  const REVEAL = read('scroll-reveal.js');
  ok('scroll-reveal really does add classes at runtime',
    /classList\.add\('zw-revealed'\)/.test(REVEAL) && /classList\.add\('zw-reveal'\)/.test(REVEAL),
    'if this ever stops being true the volatile list can shrink');
  for (const c of ['zw-revealed', 'zw-reveal', 'active', 'open', 'visible', 'is-open', 'has-x'])
    ok(c + ' is excluded from an element path', new RegExp(
      'VOLATILE_CLASS[\\s\\S]{0,400}').test(COPY) && (function () {
        const m = COPY.match(/var VOLATILE_CLASS = (\/.*\/);/);
        return m ? new RegExp(m[1].slice(1, -1)).test(c) : false;
      })());
  ok('class order cannot change the key', /\.sort\(\)\.slice\(0, 2\)/.test(COPY),
    'a renderer emitting the same classes in another order must not produce another key');

  /* The real rescue: a second, class-free identity. Safe to match loosely only
     because applying still requires the text to equal `was`. */
  ok('a class-free path is computed too', COPY.includes('function loosePath'));
  ok('and sent with the edit', (COPY.match(/loose: loosePath\(el\)/g) || []).length === 2,
    'both the section fall-through and the plain override need it');
  ok('the builder stores it', /loose:loose\|\|prevLoose\|\|''/.test(B));
  ok('an existing override does not lose it', /const prevLoose=/.test(B));
  ok('the storefront falls back to it', /byLoose\[loosePath\(el\)\]/.test(COPY));
  ok('...but the text check still guards every apply',
    /norm\(el\.textContent\) !== norm\(entry\.was\)\) continue/.test(COPY),
    'loose matching is only safe because finding the wrong element gets you nothing');

  setState([], {}, {});
  sandbox.applyTextOverride('/', 'p.a:0', 'Was', 'Now', 'p:0');
  ok('the loose form is written alongside the path',
    sandbox.chromeCopy['/']['p.a:0'].loose === 'p:0');
}

console.log('\nThe published copy cannot overwrite the draft');
{
  /* The preview fetches published overrides while the builder pushes the draft
     in. If the response lands second it reinstates the published words — which
     reads as "my edit did not take", intermittently, depending on the network. */
  ok('a draft marks itself authoritative', /function setOverrides\(next, fromDraft\)/.test(COPY));
  ok('and later server values are ignored', /if \(draftPushed && !fromDraft\) return;/.test(COPY));
  ok('the builder push counts as a draft', /setOverrides\(d\.value, true\)/.test(COPY));
  ok('so does a ?zwpreview= link', /setOverrides\(p\.text_overrides, true\)/.test(COPY));
  ok('the plain fetch does not', /setOverrides\(v\);/.test(COPY));
}

console.log('\nSaving writes only what changed');
{
  ok('dirtiness is per key', COPY !== null && /const chromeDirtyKeys = new Set\(\)/.test(B),
    'three POSTs on every save, each re-verifying the session, for one edited word');
  for (const [fn, key] of [['nav', "markChromeDirty\\('nav'\\)"], ['bar', "markChromeDirty\\('bar'\\)"],
                           ['copy', "markChromeDirty\\('copy'\\)"]])
    ok('the ' + fn + ' edit marks only itself', new RegExp(key).test(B));
  ok('Save Draft writes just those', /const want = pub \? \['nav','bar','copy','header','bag'\] : \[\.\.\.chromeDirtyKeys\]/.test(B));
  ok('Publish still writes every one of them', /pub \? \['nav','bar','copy','header','bag'\]/.test(B),
    'a draft saved an hour ago still has to be promoted');
  ok('and they go in parallel', /await Promise\.all\(want\.map/.test(B));
  ok('nothing dirty means no request at all', /if\(!want\.length\) return true;/.test(B));
}

console.log('\nA word that shares its element with another element');
{
  /* The release title renders as `Release<br><span>002</span>`. The span is a
     leaf, so "002" was editable; "Release" is a bare text node in a parent that
     is NOT a leaf, and nothing could select it. Reported exactly that way — the
     numbers after it are editable, the word itself is not. */
  ok('an element’s own text nodes are found', COPY.includes('function directTextNodes'));
  ok('and from the outer scope, not the editor',
    COPY.indexOf('function directTextNodes') < COPY.indexOf('function initEditor'),
    'applyOverrides needs it on a shopper page, where the editor never loads');
  ok('the one under the cursor is identified', COPY.includes('caretRangeFromPoint'),
    'a click targets the element, so the text node has to come from the caret');
  ok('a whole leaf still wins over a slot',
    /var leaf = editableFrom\(e\.target, null\);\s*\n\s*if \(leaf\) return/.test(COPY),
    'every edit that already worked must keep working');
  ok('the node is wrapped to be edited', COPY.includes('function wrapSlot'));
  ok('...and unwrapped again afterwards', COPY.includes('function unwrapSlot'));
  ok('the key names which text node', /slot = ti >= 0 \? '\|t' \+ ti : ''/.test(COPY));
  ok('applying touches only that node', /tns\[t\]\.nodeValue = te\.now/.test(COPY),
    'assigning textContent to the parent would flatten the <br> and the span away');
  ok('a rejection restores only that node', /tn\.nodeValue = p\.was/.test(COPY));
  ok('the anchor is per node too', /'data-zw-was-t' \+ ti/.test(COPY));
  ok('a stored key keeps its slot through normalising', /cut = str\.indexOf\('\|t'\)/.test(COPY));
}

console.log('\nEvery tab publishes its page text');
{
  /* No page but the homepage tags its sections, so ALL the text on the landing,
     product and collection pages is stored as page copy — and Publish returned
     early on exactly those tabs, so saveChrome never ran where it was the only
     place an edit could go. */
  for (const t of ['pages', 'product', 'collection'])
    ok('the ' + t + ' tab publishes it',
      new RegExp("curTab==='" + t + "'\\)\\{[^}]*saveChrome\\(true\\)").test(B));
  ok('and the pages tab saves it as a draft too',
    /saveLandingPages\(false\); await saveChrome\(false\)/.test(B));
}

console.log('\nA field and an override never both own the same words');
{
  /* An override repaints on every re-render, so one left in place over an
     element whose section field was just edited wins for ever — and the field
     edit looks like it did nothing. Live data has that pairing already: an
     override on the release title beside the title setting it shadows. */
  ok('a successful field edit clears the override there', B.includes('function clearOverrideAt'));
  ok('and it is called on exactly that path',
    /else if\(r&&r\.ok\) clearOverrideAt\(d\.page,d\.path\)/.test(B));

  setState([], {}, {});
  sandbox.applyTextOverride('/', 'div.drop-title:0|t0', 'Release', 'Drop', '');
  ok('an override exists first', !!sandbox.chromeCopy['/']['div.drop-title:0|t0']);
  sandbox.clearOverrideAt('/', 'div.drop-title:0|t0');
  ok('...and a field edit removes it', !sandbox.chromeCopy['/']);
}

console.log('\nPreview live shows what Save Draft saved');
{
  /* "Preview live" opens the real storefront on a ?zwpreview= token and renders
     the DRAFT. It has its own allow-list, separate from everything else, and
     the three new draft keys were not in it — so the button whose entire job is
     "show me what I have saved but not published" rendered draft sections
     around a published nav, a published bar and published page copy. */
  const PV = read('functions/api/preview-config.js');
  const MODE = read('preview-mode.js');
  const keys = (PV.match(/const DRAFT_KEYS = \[([^\]]*)\]/) || [])[1] || '';
  const list = (keys.match(/'[^']+'/g) || []).map((s) => s.slice(1, -1));
  const alias = {};
  ((PV.match(/const DRAFT_ALIAS = \{([\s\S]*?)\};/) || [])[1] || '')
    .replace(/([a-z_]+):\s*'([^']+)'/g, (m, k, v) => { alias[k] = v; return m; });
  const delivered = list.map((k) => alias[k] || k);

  for (const k of ['nav_menu_draft', 'announcement_bar_draft', 'text_overrides_draft'])
    ok(k + ' is fetched for a preview', list.includes(k));
  for (const k of ['nav_menu', 'announcement_bar', 'text_overrides'])
    ok('...and arrives named ' + k, delivered.includes(k),
      'the storefront renders a preview through its normal path, so the draft has '
      + 'to come back under the live name');

  ok('the nav takes it', /pv\.nav_menu/.test(NAV) && /__zwNavPreview/.test(NAV));
  ok('the bar takes it', /pv\.announcement_bar/.test(BAR) && /__zwBarPreview/.test(BAR));
  ok('page copy takes it', /p\.text_overrides/.test(COPY));

  /* Each module also fetches the PUBLISHED value, and that response usually
     lands second. Without a guard it would undo the preview. */
  ok('the published nav does not overwrite it', /if \(window\.__zwNavPreview\) return;/.test(NAV));
  ok('nor the published bar', /if \(window\.__zwBarPreview\) return;/.test(BAR));
  ok('nor the published copy', /if \(draftPushed && !fromDraft\) return;/.test(COPY));

  ok('Preview live saves before it opens', /await saveDraft\(\);[\s\S]{0,400}preview-token/.test(B),
    'previewing an unsaved draft shows the previous one, which looks like it worked');
  ok('and it opens the page you are on, not always the homepage',
    /const f=document\.getElementById\('pvIframe'\);[\s\S]{0,200}u\.pathname/.test(B),
    'the draft you just saved was on a page the homepage preview never showed');
  ok('the token is still the only way in', /verifyPreviewToken/.test(PV));
  ok('and a preview still never writes anything', !/(POST|PUT|PATCH|DELETE)/.test(MODE));
}

console.log('\nAn edit made before the drafts land is not thrown away');
{
  /* "Save draft doesn't do anything, and on reload the draft is deleted."
     The drafts load asynchronously. An edit arriving before they do found
     chromeNav still null, was answered "that navigation item no longer exists",
     reverted the words and marked nothing dirty — after which Save Draft
     honestly had nothing to write, and a reload showed the published values
     because no draft had ever been saved. Every symptom, one cause. */
  ok('there is something to wait for', /let chromeReady = null;/.test(B));
  ok('and the loader resolves it', /chromeReady = loadChrome\(\)/.test(B));
  ok('a chrome edit waits for it', /Promise\.resolve\(chromeReady\)\.then\(\(\)=>\{\s*\n\s*_answerCanvasEdit\(d,applyChromeField/.test(B));
}

console.log('\nSaving says what it saved');
{
  ok('the save records which keys it wrote', /chromeSaved = want\.slice\(\)/.test(B));
  ok('and clears that when nothing is dirty', /chromeSaved=\[\];\s*\n\s*if\(!want\.length\) return true;/.test(B));
  ok('the toast names them', /Draft saved · '\+extra\.join/.test(B),
    '"Draft saved" alone let a header change look saved when only the sections were');
  ok('...and says so when only the sections went', /sections only/.test(B));
  ok('loading says what it restored', /Draft restored/.test(B) && /chromeFound/.test(B),
    '"my draft vanished" and "there was never a draft" look identical otherwise');
}

console.log('\nOne element, one override');
{
  /* The live store currently holds TWO entries anchored to the same heading —
     one written before volatile classes came out of the key. Two entries for
     one element means whichever the storefront matches first wins. */
  setState([], {}, {});
  sandbox.applyTextOverride('/', 'old>path>h2.about-h2', 'Built ForMovement.', 'I Am Inevitable.', '');
  sandbox.applyTextOverride('/', '#about>div:0>h2.about-h2:0', 'Built ForMovement.', 'Built For Movement.', '#about>div:0>h2:0');
  const keys = Object.keys(sandbox.chromeCopy['/']);
  ok('writing one supersedes an older entry for the same words', keys.length === 1, keys.join(' | '));
  ok('and the surviving one is the new key', keys[0] === '#about>div:0>h2.about-h2:0');

  /* A different element that happens to be edited must NOT be swept away. */
  setState([], {}, {});
  sandbox.applyTextOverride('/', 'a:0', 'One', 'Uno');
  sandbox.applyTextOverride('/', 'b:0', 'Two', 'Dos');
  ok('a different original is left alone', Object.keys(sandbox.chromeCopy['/']).length === 2);
}

console.log('\nA carousel holds still while you type');
{
  const SF = read('storefront.js');
  ok('the loop checks a hold flag', /window\.__zwHoldCarousels/.test(SF));
  ok('and so does the restart', /!isPaused && !window\.__zwHoldCarousels/.test(SF),
    'the rAF loop returns rather than idling, so something has to start it again');
  ok('Text mode sets it', /window\.__zwHoldCarousels = window\.__zwTextEditMode/.test(COPY));
  ok('and announces the change', /zw:carousel-hold/.test(COPY) && /zw:carousel-hold/.test(SF));
  ok('the shopper-facing pause button is untouched',
    /isPaused \|\| window\.__zwHoldCarousels/.test(SF) && /updatePauseIcon/.test(SF),
    'a hold must not leave the pause icon lying about what it will do');
}

console.log('\nThe preview asks the right owner');
{
  ok('a named field beats a section', COPY.indexOf("closest('[data-zw-field]')") < COPY.indexOf("closest('[data-zw-sec]')"),
    'the nav and bar sit inside chrome no section owns; their fields are exact');
  ok('a section beats an override',
    COPY.indexOf("closest('[data-zw-sec]')") < COPY.indexOf("kind: 'override'"));
  ok('the editor sends three different messages',
    COPY.includes('ZW_CHROME_TEXT') && COPY.includes('ZW_INLINE_TEXT') && COPY.includes('ZW_TEXT_OVERRIDE'));
  ok('and the bar says where the words are going', /saves to ' \+ owner\.label/.test(COPY),
    'a nav label and a heading look identical on the canvas and are stored in different places');
  ok('the font control is section-only', COPY.includes("owner.kind === 'section'"),
    'it writes a section setting, and there is none behind a nav label');
  ok('the builder answers all three the same way', B.includes('function _answerCanvasEdit'));
}

console.log('\nThe nav label maps to the right item');
{
  /* resolveItem can drop an item — a gender with no products vanishes — so the
     position on screen is not the position in the stored array. */
  ok('the stored index is carried through the filter', /if \(r\) r\._i = i;/.test(NAV));
  ok('and it is what the attribute names', /data-zw-field="nav\.' \+ n\._i \+ '\.label"/.test(NAV));
  ok('the attribute is preview-only', /if \(!window\.__ZW_BUILDER_PREVIEW__ .*\) return '';/.test(NAV));
  ok('both the desktop and mobile renders carry it',
    (NAV.match(/fieldAttr\(n\)/g) || []).length >= 3);
  ok('the bar tags its message too', BAR.includes("'bar.message'"));
  ok('and only in preview', /if \(window\.__ZW_BUILDER_PREVIEW__\) \{\s*\n\s*textEl\.setAttribute/.test(BAR));
}

console.log('\nNothing is live until Publish');
{
  for (const k of ['nav_menu_draft', 'announcement_bar_draft', 'text_overrides_draft']) {
    ok(k + ' is a permitted key', SAVE.includes("'" + k + "'"));
    ok('...and it publishes onto its live key', new RegExp(k + ": '" + k.replace('_draft', '') + "'").test(SAVE));
    ok('...and is NOT publicly readable', !MIG.split('array[')[1].includes(k),
      'a readable draft key is a direct REST route to unpublished copy');
  }
  ok('the live key IS publicly readable', MIG.split('array[')[1].includes("'text_overrides'"));
  ok('Save Draft writes them', /saveChrome\(false\)/.test(B));
  ok('Publish promotes them', /saveChrome\(true\)/.test(B));
  ok('the preview is fed from memory, not the database', B.includes('function sendChrome'));
  ok('and it is fed on every config push', /sendChrome\(\);\s*\/\/ the nav, the bar/.test(B));
}

console.log('\nThe stored value is the data, and nothing else');
{
  /* nav_menu is an ARRAY. { ...['Men'] } is { '0': 'Men' }, which nav-menu.js
     rejects outright — it tests Array.isArray. And text_overrides is keyed BY
     PAGE PATH, so merging meta into it invents pages called updated_at and
     published. */
  ok('these keys are stored verbatim', SAVE.includes('const VERBATIM = new Set(['));
  for (const k of ['nav_menu', 'announcement_bar', 'text_overrides']) {
    ok(k + ' and its draft are both verbatim',
      new RegExp("'" + k + "', '" + k + "_draft'").test(SAVE));
  }
  ok('the spread is conditional now', /VERBATIM\.has\(key\)\s*\n?\s*\? payload/.test(SAVE));
}

console.log('\nThe allow-list did not lose anything on the way in');
{
  /* 0002 and 0005 both rewrite this policy and ALTER POLICY replaces rather than
     appends. Building 0026 on 0002 — the older one — silently revoked public
     read for the palette and the icon library sitewide. */
  const arr = MIG.split('array[')[1] || '';
  for (const k of ['theme_modes', 'icons', 'announcement_bar', 'nav_menu', 'feature_flags', 'fit_finder', 'integrations']) {
    ok(k + ' survived', arr.includes("'" + k + "'"));
  }
  const base = read('migrations/0005_theme_icon_public_read.sql').split('array[')[1] || '';
  const keysOf = (s) => (s.match(/'[a-z_]+'/g) || []);
  const lost = keysOf(base).filter((k) => !keysOf(arr).includes(k));
  ok('nothing from 0005 was dropped', lost.length === 0, 'lost: ' + lost.join(', '));
}

console.log('\nThe editor is not shipped to shoppers');
{
  ok('it initialises only under the builder guard',
    /if \(window\.__ZW_BUILDER_PREVIEW__\) initEditor\(\);/.test(COPY),
    'zw-copy.js is on every storefront page, so the guard is what keeps it off a shopper’s');
  ok('applying overrides is NOT guarded', COPY.indexOf('applyOverrides()') < COPY.indexOf('initEditor()'),
    'published overrides are real content and must render for everyone');
  const pages = ['index.html', 'product.html', 'drop001.html', 'about.html', 'journal.html',
                 'policies.html', 'bag.html', 'account.html', 'sizeguide.html', 'landing.html', '404.html'];
  for (const p of pages) ok(p + ' loads it', read(p).includes('zw-copy.js'));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
