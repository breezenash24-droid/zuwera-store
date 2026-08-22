/* A panel has to live on the page whose hook opens it.
 *
 * The incident record. `nothing-is-in-the-wrong-parent.test.js` is the general
 * gate against this bug class; this file pins the specific six elements that
 * moved and the specific hook that boots them, so that a future refactor which
 * satisfies the general rules while putting these somewhere new still has to
 * come here and say so deliberately.
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
 */
const { readAdmin, hasClass, ROOT } = require('./_admin-markup.js');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const doc = readAdmin();
const js = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8').replace(/\r\n/g, '\n');

console.log('\n  the Add Product tab row holds tabs, and nothing else\n');

{
  const form = doc.ids.productForm && doc.ids.productForm.node;
  ok('the product form is still there', !!form && !!form.kids);
  const row = form && (form.kids || []).find((k) => hasClass(k, 'tabs'));
  ok('…with a tab row in it', !!row);
  if (row) {
    const strays = (row.kids || []).filter((k) => !(k.name === 'button' && hasClass(k, 'tab-button')));
    ok('every direct child of it is a tab button',
      strays.length === 0,
      strays.map((s) => '<' + s.name + (s.id ? '#' + s.id : '') + '>').join(', ')
        + ' — a patch anchored on the Status button and pasted a settings page in here once');
    ok('…and there are still six of them',
      (row.kids || []).length === 6,
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
  ok('  #' + id + ' — ' + what + ' is inside #website', doc.isInside(id, 'website'), doc.whereIs(id));
}
for (const id of Object.keys(OWNED)) {
  ok('  …and #' + id + ' is not inside a modal', !doc.isInsideClass(id, 'modal'), doc.whereIs(id));
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
console.log('\n  and the comment that names it sits on it');

ok('the Product Form Modal comment sits on the modal',
  /<!-- Product Form Modal -->\n\s*<div id="productFormModal"/.test(doc.src),
  'it spent one deploy sitting above the Ctrl+K search box instead');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
