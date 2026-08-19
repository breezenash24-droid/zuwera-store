/* Where things sit in the header, chosen from a picker.
 *
 * The header had exactly one arrangement — logo left, categories centred,
 * actions right — and every other one a shop might want meant editing markup on
 * fourteen pages. A layout is now data: three slots, and which items sit in
 * each, in order.
 *
 * TWO RULES THIS FILE HOLDS.
 *
 * 1. A layout is POSITION ONLY. No colours, sizes or fonts — the theme owns
 *    those, and a "layout" that quietly sets them becomes a second styling
 *    system with no visible switch. This codebase has already had to remove one
 *    of those from the announcement bar.
 *
 * 2. The picker's tiles are GENERATED FROM the same slots the storefront
 *    rearranges the real header with. A picker whose pictures disagree with the
 *    result is worse than no picker, and the only way to guarantee they agree
 *    is to refuse to describe the arrangement twice.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  - ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const SRC = read('header-layouts.js');
const B = read('builder.html');
const SAVE = read('functions/api/save-page-builder.js');
const PV = read('functions/api/preview-config.js');
const MIG = read('migrations/0026_text_the_builder_can_edit_anywhere.sql');

/* Run the real file, unmodified, against a page that has no header.

   That is not a contrivance — it is the builder. The picker loads this file for
   its definitions and its miniatures, and the builder has no storefront nav of
   its own, so findNav() finds nothing and the whole storefront half stops
   before it asks the server for anything. Exercising that path here checks it
   really does stay quiet. */
let asked = 0;
const box = {
  console,
  document: {
    readyState: 'complete',
    querySelector: () => null,
    addEventListener: () => {},
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} },
  },
  localStorage: { getItem: () => null, setItem() {} },
  fetch: () => { asked++; return Promise.resolve({ ok: false }); },
  MutationObserver: function () { this.observe = function () {}; },
  setTimeout, clearTimeout,
};
box.window = box;
vm.createContext(box);
vm.runInContext(SRC, box);
const L = box.ZWHeaderLayouts;

console.log('\nThere are real, distinct arrangements to choose from');
{
  ok('the definitions load', !!L && Array.isArray(L.list));
  ok('and a page with no header asks the server for nothing', asked === 0,
    'the builder loads this file too, and it has no storefront nav');
  ok('there are enough to be worth scrolling', L.list.length >= 8, L.list.length + ' layouts');
  const ids = L.list.map((l) => l.id);
  ok('every id is unique', new Set(ids).size === ids.length);
  ok('every one has a name and an explanation',
    L.list.every((l) => l.name && l.note && l.note.length > 20));

  /* Two layouts that arrange things identically are two ways to say the same
     thing, and a picker full of those is what makes a gallery useless. */
  const shapes = L.list.map((l) => JSON.stringify(L.slots.map((s) => l.slots[s] || [])));
  ok('no two arrange things the same way', new Set(shapes).size === shapes.length);

  ok('the familiar one comes first', L.list[0].id === 'classic',
    'the first thing you see should be the arrangement you already have');
}

console.log('\nA layout says where, and nothing else');
{
  const KEYS = new Set(['id', 'name', 'note', 'slots']);
  ok('a layout carries no other properties',
    L.list.every((l) => Object.keys(l).every((k) => KEYS.has(k))),
    'colour, size and font belong to the theme');
  ok('and no layout mentions one', !/color|font|size|background|weight/i.test(
    JSON.stringify(L.list.map((l) => l.slots))));

  const ITEMS = Object.keys(L.items);
  ok('every slot names only known items',
    L.list.every((l) => L.slots.every((s) => (l.slots[s] || []).every((i) => ITEMS.includes(i)))));
  ok('no item is placed twice in one layout',
    L.list.every((l) => {
      const all = L.slots.reduce((a, s) => a.concat(l.slots[s] || []), []);
      return new Set(all).size === all.length;
    }), 'an item can only be in one place');
  ok('every layout keeps the bag', L.list.every((l) =>
    L.slots.some((s) => (l.slots[s] || []).includes('bag'))),
    'a shop with no way to open the bag is not an arrangement, it is a bug');
  ok('every layout keeps the logo', L.list.every((l) =>
    L.slots.some((s) => (l.slots[s] || []).includes('logo'))));

  /* Leaving an item out is how "the account button lives in the bag panel" is
     expressed, so at least one layout has to actually do it. */
  ok('leaving an item out is a real option', L.list.some((l) =>
    !L.slots.some((s) => (l.slots[s] || []).includes('account'))),
    'that is what "account in the bag panel" means');
}

console.log('\nThe picture cannot disagree with the result');
{
  const m = L.miniature('logo-center');
  ok('a miniature is generated, not hand-drawn', typeof m === 'string' && m.includes('zwhl-slot'));
  /* Read the arrangement back out of the generated markup and compare it with
     the slots the applier uses. */
  const order = [];
  m.replace(/zwhl-(left|center|right)">([\s\S]*?)<\/span><span class="zwhl-slot|zwhl-(left|center|right)">([\s\S]*?)$/g, () => '');
  for (const s of L.slots) {
    const seg = new RegExp('zwhl-' + s + '">([\\s\\S]*?)(?=<span class="zwhl-slot|</span>$)').exec(m);
    order.push(seg ? (seg[1].match(/title="([^"]+)"/g) || []).length : -1);
  }
  const want = L.slots.map((s) => (L.byId('logo-center').slots[s] || []).length);
  ok('it draws exactly the items the slots name', order.join() === want.join(),
    'drew ' + order.join() + ', slots say ' + want.join());
  ok('an unknown layout draws nothing', L.miniature('nope') === '');
  ok('the tile styles ship with the definitions', typeof L.css === 'string' && L.css.includes('.zwhl-bar'));
  ok('the builder draws from that function, not its own copy',
    /L\.miniature\(l\)/.test(B) && !/zwhl-logo/.test(B.replace(/<script src[^>]*>/g, '')),
    'a second drawing of the same thing is a second thing to keep in step');
}

console.log('\nItems are found on the page, never assumed');
{
  ok('each item has candidate selectors',
    Object.keys(L.items).every((k) => Array.isArray(L.items[k].sel) && L.items[k].sel.length));
  ok('the two header dialects are both covered',
    L.items.bag.sel.some((s) => /cart-btn/.test(s)) && L.items.bag.sel.some((s) => /zw-hdr-bag/.test(s)),
    'index/product ship .nav-right with .nbtn; other pages get .zw-hdr-group');
  ok('items are MOVED, never cloned', /appendChild MOVES/.test(SRC) && !/cloneNode/.test(SRC),
    'a cloned bag button has a click handler and a count belonging to a dead node');
  ok('an item that is not on the page is skipped', /if \(!el\) return;/.test(SRC));
  ok('an unnamed item is hidden rather than left adrift', /data-zw-hdr-off/.test(SRC));
  ok('the slot CSS is scoped so an unchosen header is untouched',
    /nav\.zw-hdr-arranged\{/.test(SRC) && !/^nav#nav\{/m.test(SRC));
  ok('a late-arriving nav is re-arranged', /MutationObserver/.test(SRC),
    'nav-menu.js builds the category links after this runs, and search later still');
}

console.log('\nIt follows the same rule as everything else in the builder');
{
  ok('the button sits with the other canvas controls', /id="hdrCfgBtn"/.test(B));
  ok('and opens a scrolling gallery', /id="hdrCfgList"/.test(B) && /overflow-y:auto/.test(B));
  ok('the choice is part of the chrome draft', /markChromeDirty\('header'\)/.test(B));
  ok('it previews at once', /post\(\{type:'ZW_HEADER_LAYOUT',id:chromeHeader\}\)/.test(B));
  ok('Save Draft can write it', /header: \['header_layout_draft'/.test(B));
  ok('Publish promotes it', /header_layout_draft: 'header_layout'/.test(SAVE));
  ok('the endpoint permits the draft key', /'header_layout_draft'/.test(SAVE));
  ok('and stores it verbatim', /'header_layout', 'header_layout_draft',/.test(SAVE));
  ok('Preview live shows the draft', /'header_layout_draft'/.test(PV) && /header_layout_draft: 'header_layout'/.test(PV));
  ok('the live key is publicly readable', /'header_layout'/.test(MIG.split('array[')[1] || ''));
  ok('...and the draft key is not', !/header_layout_draft/.test(MIG.split('array[')[1] || ''),
    'a readable draft key is a REST route to unpublished work');
  ok('the modal says it is position only', /Position only/.test(B));
  ok('...and that nothing is live until Publish', /Nothing is live until you press Publish/.test(B));

  const pages = ['index.html', 'product.html', 'drop001.html', 'about.html', 'journal.html',
                 'policies.html', 'bag.html', 'account.html', 'sizeguide.html', 'landing.html', '404.html'];
  for (const p of pages) ok(p + ' loads it', read(p).includes('header-layouts.js'));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
