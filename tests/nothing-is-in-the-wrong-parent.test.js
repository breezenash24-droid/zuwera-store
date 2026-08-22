/* Countermeasures against markup landing in the wrong parent.
 *
 * ── THE BUG CLASS ───────────────────────────────────────────────────────────
 *
 * A patch moved four settings panels and a live storefront preview onto the
 * Website page. It anchored on the last line that looked like the right place:
 *
 *     <button type="button" class="tab-button" data-tab="tab-status">Status</button>
 *
 * which is inside the Add Product modal's tab row. 364 lines landed inside
 * <div class="tabs"> in #productFormModal, merged, and deployed.
 *
 * ── WHY NOTHING CAUGHT IT ───────────────────────────────────────────────────
 *
 * Nothing threw. loadWebsiteSettings() fills those panels by id, zwPreviewOpen()
 * boots the preview by id, and getElementById searches the whole document — it
 * does not care whether it finds an element on a page, in a form, or inside a
 * modal. The browser repaired nothing because nothing was broken: the markup was
 * valid, well-nested, and in the wrong place.
 *
 * So a document-wide id lookup will find anything, anywhere, and every layer
 * that could have noticed was built on one. Placement cannot be verified by the
 * code that consumes it. It has to be asserted from outside, which is here.
 *
 * ── THE FIVE COUNTERMEASURES ────────────────────────────────────────────────
 *
 *   1. the document parses            — nothing unclosed, nothing mismatched
 *   2. no id appears twice            — the other half of "getElementById lies"
 *   3. the search index is a map      — and every route on it has to be real
 *   4. page furniture stays on pages  — nothing page-shaped inside a modal
 *   5. a row of tabs holds tabs       — containers stay homogeneous
 *
 * The third is the one that would have caught this in the commit that caused it,
 * and it is worth saying why it works. The Ctrl+K search index in admin-main.js
 * already contains, hand-written, ~23 assertions of the form "the control
 * #settAnnouncementBarMessage is on the page #website" — because Ctrl+K has to
 * navigate there and then scroll to it. That is a machine-readable statement of
 * intent about placement, written by the same person doing the moving, sitting
 * in the repo, checked by nothing. All four moved panels declared page:'website'
 * while sitting in a modal.
 *
 * A map of the building that nobody compares against the building is how you get
 * a fire door that opens onto a wall.
 */
const { readAdmin, hasClass, ROOT } = require('./_admin-markup.js');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const doc = readAdmin();
const js = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8').replace(/\r\n/g, '\n');

console.log('\n  1 · the document parses\n');

ok('admin.html has no unclosed or mismatched elements',
  doc.problems.length === 0,
  doc.problems.slice(0, 3).join(' | '));

console.log('\n  2 · no id appears twice');

/* The same failure wearing the other hat. Two elements called #pricing — a page
   and a product-form tab — meant the tab switcher found the page and the tab
   never opened. getElementById returns the FIRST match and says nothing about
   the second. */
ok('every id in admin.html is unique',
  doc.duplicateIds.length === 0,
  doc.duplicateIds.slice(0, 6).map((id) => '#' + id + ' on lines ' + (doc.ids[id].duplicateLines || []).join(', ')).join(' | '));

console.log('\n  3 · the search index is a map, and the map matches the building');

/* {icon:'📣', main:'Announcement Bar', …, page:'website', el:'settAnnouncementBarMessage'} */
const ROUTES = [];
for (const m of js.matchAll(/\{[^{}]*\}/g)) {
  const blob = m[0];
  const page = /\bpage\s*:\s*'([^']+)'/.exec(blob);
  const el = /\bel\s*:\s*'([^']+)'/.exec(blob);
  const main = /\bmain\s*:\s*'([^']*)'/.exec(blob);
  if (page && el) ROUTES.push({ page: page[1], el: el[1], main: main ? main[1] : el[1] });
}

/* Fourteen entries carry BOTH a page and an element; the rest carry one or the
   other and are not assertions about placement. The floor is here so that a
   refactor which quietly drops the `page:` field turns this file red instead of
   turning it into three checks that iterate over an empty list and pass. */
ok('the index still declares where its controls live',
  ROUTES.length >= 12,
  'found ' + ROUTES.length + ' page/element pairs — if this collapses, the checks below assert nothing');

{
  const missing = ROUTES.filter((r) => !doc.ids[r.el]);
  ok('every element Ctrl+K jumps to exists',
    missing.length === 0,
    missing.map((r) => '#' + r.el + ' (“' + r.main + '”)').join(', '));

  const misplaced = ROUTES.filter((r) => doc.ids[r.el] && doc.ids[r.page] && !doc.isInside(r.el, r.page));
  ok('…and each one is on the page the index says it is on',
    misplaced.length === 0,
    misplaced.map((r) => '“' + r.main + '” claims page #' + r.page + ' but ' + doc.whereIs(r.el)).join(' | '));

  const noPage = ROUTES.filter((r) => !doc.ids[r.page]);
  ok('…and every page it names is a real page',
    noPage.length === 0,
    noPage.map((r) => '#' + r.page).join(', '));
}

console.log('\n  4 · page furniture stays on pages');

/* These three classes mean "I am part of a page", unambiguously. A modal is not
   a page. Nothing carrying them may be inside one — which is true of the whole
   364 lines, not just the ids somebody remembered to list. */
{
  const FURNITURE = ['page', 'page-header', 'set-jump-target'];
  const strays = [];
  for (const el of doc.containers) {
    if (!FURNITURE.some((c) => hasClass(el, c))) continue;
    if (!el.kids) continue;
    strays.push(el);
  }
  /* Walk from each modal downward instead: cheaper, and it names the modal. */
  const offences = [];
  const descend = (node, modal) => {
    for (const kid of node.kids || []) {
      if (FURNITURE.some((c) => hasClass(kid, c))) {
        offences.push('<' + kid.name + (kid.id ? '#' + kid.id : '') + ' class="' + kid.cls + '"> at line '
          + doc.line(kid.at) + ' is inside ' + modal);
      }
      descend(kid, modal);
    }
  };
  for (const el of doc.containers) {
    if (!hasClass(el, 'modal')) continue;
    descend(el, '#' + (el.id || '(an unnamed modal)'));
  }
  ok('no .page, .page-header or .set-jump-target sits inside a .modal',
    offences.length === 0,
    offences.slice(0, 4).join(' | '));
  ok('…and there is page furniture to find in the first place',
    strays.length > 10,
    'only ' + strays.length + ' elements carry those classes — the rule may be watching the wrong marker now');
}

console.log('\n  5 · a container stays the kind of container it is');

/* The visible symptom was the active tab stretched into a full-height pink
   column, because a flex row got a 364-line sibling. A tab row holds tabs. */
{
  const rows = doc.containers.filter((el) => hasClass(el, 'tabs'));
  ok('admin.html still has tab rows to check', rows.length > 0);
  const bad = [];
  for (const row of rows) {
    for (const kid of row.kids || []) {
      if (kid.name === 'button' && hasClass(kid, 'tab-button')) continue;
      bad.push('<' + kid.name + (kid.id ? '#' + kid.id : '') + '> at line ' + doc.line(kid.at)
        + ' in the .tabs row on line ' + doc.line(row.at));
    }
  }
  ok('every direct child of a .tabs row is a tab button',
    bad.length === 0,
    bad.slice(0, 4).join(' | '));
}

console.log('\n  and the tell that made it visible by eye');

/* A patch that lands markup in the wrong parent strands the comment that named
   it above whatever came next. Here that left <!-- Product Form Modal --> and
   <!-- Ctrl+K Global Search --> stacked with no element between them, four
   hundred lines from the modal it named.
 *
 * The rule is not "no two comments in a row" — this file has decorative banners
 * that are three comments deep:
 *
 *     <!-- ═══════════════════════════════════ -->
 *     <!-- Tax Page                            -->
 *     <!-- ═══════════════════════════════════ -->
 *
 * It is "no two comments that both NAME something", because a naming comment is
 * a label for the element underneath it and only one element can be underneath.
 * A divider names nothing and has no letters in it, which is how they are told
 * apart. Running this for the first time found a second live instance:
 * <!-- Journal Page --> sitting above the Loyalty page, 157 lines from its own. */
{
  const names = (body) => /[A-Za-z]/.test(body.replace(/[═─—–\-=*+.#|_~ ]/g, ''));
  const stranded = [];
  for (const m of doc.src.matchAll(/\n[ \t]*<!--([^\n]*?)-->\n[ \t]*<!--([^\n]*?)-->/g)) {
    if (names(m[1]) && names(m[2])) {
      stranded.push('line ' + doc.line(m.index + 1) + ': “' + m[1].trim() + '” then “' + m[2].trim() + '”');
    }
  }
  ok('no comment that names something is stranded above a different one',
    stranded.length === 0,
    stranded.slice(0, 3).join(' | '));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
