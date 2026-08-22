/* A panel has to live on the page whose hook opens it.
 *
 * ── WHAT HAPPENED ───────────────────────────────────────────────────────────
 *
 * e3364ba moved four settings panels — Announcement Bar, Header Scroll
 * Behavior, Product Cards, Navigation Menu — from Settings to the Website page,
 * along with a new live storefront preview to prove the changes. The patch
 * anchored on the last line it could find that looked like the right place:
 *
 *     <button type="button" class="tab-button" data-tab="tab-status">Status</button>
 *
 * which is inside the Add Product modal's tab row. 364 lines of settings page
 * landed inside <div class="tabs"> in #productFormModal and stayed there
 * through a merge to main and a deploy.
 *
 * ── WHY NOTHING BROKE LOUDLY ────────────────────────────────────────────────
 *
 * This is the important part, and the reason a test is worth writing rather
 * than just fixing the markup.
 *
 * Every one of those panels kept working. loadWebsiteSettings() populates them
 * by id, zwPreviewOpen() boots the preview by id, and getElementById searches
 * the whole document — it does not care which page, form or modal it finds the
 * element in. So the JS was happy, no console error was raised, and the only
 * symptom was visual: opening Add Product showed a live storefront preview, a
 * STOREFRONT CHROME heading and a Save Header button, while the Website page
 * that was supposed to have gained them showed nothing new at all.
 *
 * A document-wide id lookup will find anything, anywhere. That is exactly why
 * placement cannot be verified by the code that uses it, and has to be asserted
 * separately — here.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────
 *
 * navigateTo('website') is what calls zwPreviewOpen() and loadWebsiteSettings().
 * Everything those two touch must therefore be inside #website, and nothing that
 * belongs to a page may be inside a modal.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8').replace(/\r\n/g, '\n');
const js = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8').replace(/\r\n/g, '\n');

/* ── A real tokenizer, not a regex over lines ────────────────────────────────
   Two regex passes over this file once disagreed with each other by thousands
   of lines about where #productFormModal ended. Anything that reasons about
   WHERE something sits has to actually parse. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);

/** Every element carrying an id, with its ancestor chain; plus the direct
    children of each `.tabs` row. */
function parse(src) {
  const byId = {};
  const tabRows = [];
  const stack = [];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) break;
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e === -1 ? src.length : e + 3; continue; }
    if (src.startsWith('<!', lt)) { const e = src.indexOf('>', lt); i = e === -1 ? src.length : e + 1; continue; }
    const closing = src[lt + 1] === '/';
    let j = lt + (closing ? 2 : 1);
    let name = '';
    while (j < src.length && /[a-zA-Z0-9:-]/.test(src[j])) { name += src[j]; j += 1; }
    name = name.toLowerCase();
    if (!name) { i = lt + 1; continue; }
    let selfClose = false;
    let quote = '';
    while (j < src.length) {
      const c = src[j];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      else if (c === '/' && src[j + 1] === '>') selfClose = true;
      j += 1;
    }
    const after = j + 1;
    const raw = src.slice(lt, after);
    const idm = /\sid\s*=\s*["']([^"']+)["']/.exec(raw);
    const clm = /\sclass\s*=\s*["']([^"']*)["']/.exec(raw);
    const node = { name, id: idm ? idm[1] : '', cls: clm ? clm[1] : '' };

    for (const row of tabRows) {
      if (row.closed || stack.length !== row.depth) continue;
      if (closing) row.closed = true; else row.kids.push(node);
    }

    if (closing) {
      let k = stack.length - 1;
      while (k >= 0 && stack[k].name !== name) k -= 1;
      if (k >= 0) stack.length = k;
    } else if (!selfClose && !VOID.has(name)) {
      if (node.id && !byId[node.id]) byId[node.id] = { chain: stack.slice() };
      stack.push(node);
      if (/(^|\s)tabs(\s|$)/.test(node.cls)) {
        tabRows.push({ depth: stack.length, kids: [], closed: false, chain: stack.slice(0, -1) });
      }
    }
    if (!closing && RAW.has(name) && !selfClose) {
      const close = src.toLowerCase().indexOf('</' + name, after);
      if (close !== -1) { i = close; continue; }
    }
    i = after;
  }
  return { byId, tabRows };
}

const { byId, tabRows } = parse(html);
const inside = (id, ancestorId) => !!byId[id] && byId[id].chain.some((n) => n.id === ancestorId);
const insideAModal = (id) => !!byId[id] && byId[id].chain.some((n) => /(^|\s)modal(\s|$)/.test(n.cls));
const whereIs = (id) => {
  if (!byId[id]) return 'not in the document at all';
  const named = byId[id].chain.filter((n) => n.id).pop();
  return 'it is inside #' + (named ? named.id : '(nothing with an id)');
};

console.log('\n  the Add Product tab row holds tabs, and nothing else\n');

{
  const row = tabRows.find((r) => r.chain.some((n) => n.id === 'productForm'));
  ok('the product form has a tab row at all', !!row);
  if (row) {
    const strays = row.kids.filter((k) => !(k.name === 'button' && /(^|\s)tab-button(\s|$)/.test(k.cls)));
    ok('every direct child of it is a tab button',
      strays.length === 0,
      strays.length
        ? 'found ' + strays.map((s) => '<' + s.name + (s.id ? '#' + s.id : '') + '>').join(', ')
          + ' — a patch anchored on the Status button and pasted a settings page in here once'
        : '');
    ok('…and there are still six of them',
      row.kids.length === 6,
      'Core Identity, Pricing, Variants & Stock, Visuals & Model, Technical, Status');
  }
}

console.log('\n  everything the Website page boots is on the Website page');

/* Named individually rather than counted. Three of four moving correctly and
   one left behind is the shape of the original bug, and a count would pass. */
const OWNED = {
  'zw-sf-preview': 'the live storefront preview',
  'set-jump-chrome': 'the STOREFRONT CHROME heading',
  saveAnnouncementBtn: 'Announcement Bar',
  saveHeaderBtn: 'Header Scroll Behavior',
  saveCardCtaBtn: 'Product Cards',
  saveNavMenuBtn: 'Navigation Menu',
};
for (const [id, what] of Object.entries(OWNED)) {
  ok('  #' + id + ' — ' + what + ' is inside #website', inside(id, 'website'), whereIs(id));
}
for (const id of Object.keys(OWNED)) {
  ok('  …and #' + id + ' is not inside a modal', !insideAModal(id), whereIs(id));
}

console.log('\n  the hook that opens them is why they have to be there');

ok('navigateTo boots the preview when the website page opens',
  /if \(page === 'website'\)[\s\S]{0,600}?zwPreviewOpen\(\)/.test(js),
  'if this hook moves, the ownership assertions above are aimed at the wrong page');

ok('…and loads the settings those panels display',
  /if \(page === 'website'\)[\s\S]{0,600}?loadWebsiteSettings/.test(js));

/* The tell that made this findable by eye. A patch that lands markup in the
   wrong parent leaves the comment that named it stranded above whatever came
   next — here, two comments stacked with no element between them. */
console.log('\n  and no comment is stranded from what it names');

ok('the Product Form Modal comment sits on the modal',
  /<!-- Product Form Modal -->\n\s*<div id="productFormModal"/.test(html),
  'it spent one deploy sitting above the Ctrl+K search box instead');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
