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
  [lift('applyChromeField'), lift('applyTextOverride'),
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
