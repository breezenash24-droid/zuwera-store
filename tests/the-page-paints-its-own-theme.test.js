/* The white flash was three rows disagreeing, not one bug.
   ═══════════════════════════════════════════════════════════════════════════

   Reported as: "when you load into a brand new window / when there is no cache
   it's still flashing the white before it switches to the current dark mode."

   Three settings name a theme, and on the live store they do not agree:

       site_settings.theme.mode                dark
       page_builder_published.theme            dark
       site_settings.theme_modes.default       imported-mslmiae8  → base LIGHT

   Only the last one was ever read before the page painted. So the order an
   incognito visitor actually saw was:

       1. the build's bake            imported-mslmiae8   WHITE
       2. theme-preboot.head.js       follows the bake    WHITE
       3. theme-engine.js             config.default      WHITE
       4. storefront.js               pb.theme = dark     DARK

   Four writers, one question, and the only one that had the right answer was
   the last and largest script on the page.

   ── THE TWO HALVES ──────────────────────────────────────────────────────────

   THE BUILD. stamp-theme-default.js baked ONE theme into all fourteen pages —
   the store default. It now resolves per page, so index.html is baked with the
   homepage's own theme and the other thirteen keep the default they actually
   render. That is a build-time answer: no round trip, no race, nothing to lose.

   THE ENGINE. theme-engine.js deferred to what shipped only via shippedBase(),
   which read the <body> classes — and dark is expressed by the ABSENCE of a
   class, so it could not tell "this page is dark" from "nobody has said yet".
   It therefore fell through to config.default and repainted light on a page the
   build had just baked dark. It now reads data-zw-base, which the pre-paint
   block writes once it has decided and which can say all three.

   ── WHAT IS DELIBERATELY NOT DONE HERE ──────────────────────────────────────

   The three rows are not reconciled in the database. Which theme the store
   defaults to is the merchant's to choose, not a bug to repair — the code's job
   is to paint whichever one is true of the page, first time, and that is what
   is asserted below. Setting theme_modes.default to Dark in Builder → Themes
   would make all three agree and is one click; nothing here depends on it. */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const STAMP = read('scripts/stamp-theme-default.js');
const ENG = read('theme-engine.js');
const MW = read('functions/_middleware.js');

/* The live rows, as read from the store on 2026-08-21. Kept as literals rather
   than fetched: a test that needs the network is a test that fails on a plane,
   and the SHAPE is what is being asserted, not today's values. */
const MODES = {
  default: 'imported-mslmiae8',
  modes: [
    { id: 'imported-mslmiae8', base: 'light', label: 'Dawn', tokens: { bg: '255 255 255', fg: '18 18 18' } },
    { id: 'imported-msmdwxzf', base: 'light', label: 'Fabric', tokens: { bg: '255 255 255', fg: '3 3 2' } },
    { id: 'dark', base: 'dark', label: 'Dark', tokens: { bg: '9 9 11', fg: '244 241 235' } },
    { id: 'light', base: 'light', label: 'Light', tokens: { bg: '240 238 233', fg: '10 10 10' } },
    { id: 'super-light', base: 'super-light', label: 'Super Light', tokens: { bg: '255 255 255', fg: '10 10 10' } },
  ],
  pages: {},
};

/* pageMode() is not exported — the file is a build script that exits before it
   does anything without CF_PAGES. Lifting the function out of the source is
   deliberate: it runs the SHIPPED text, so an edit that changes the rule fails
   here rather than passing against a copy that has drifted. */
function loadPageMode() {
  const body = STAMP.slice(STAMP.indexOf('function pageMode('));
  const end = body.indexOf('\n}\n');
  const classesFor = (base) => (base === 'super-light' ? 'light-mode super-light-mode'
    : base === 'light' ? 'light-mode' : base === 'dark' ? '' : null);
  // eslint-disable-next-line no-new-func
  return new Function('classesFor', body.slice(0, end + 2) + '\nreturn pageMode;')(classesFor);
}
const pageMode = loadPageMode();
const byId = (id) => MODES.modes.filter((m) => m.id === id)[0];
const DEF = byId(MODES.default);

(async () => {
  console.log('\n  the page paints its own theme\n');

  console.log('  the build bakes what each page actually renders');
  {
    const home = pageMode('index.html', MODES.modes, DEF, { theme: 'dark' });
    ok('the homepage gets page_builder_published.theme', home.id === 'dark' && home.base === 'dark',
      'this is the one that was white for the first few hundred milliseconds of every load');
    ok('…and every other page keeps the store default',
      pageMode('about.html', MODES.modes, DEF, { theme: 'dark' }).id === 'imported-mslmiae8'
      && pageMode('product.html', MODES.modes, DEF, { theme: 'dark' }).id === 'imported-mslmiae8',
      'only the homepage has a page_builder_published to speak for it');

    /* Each of these is a way the builder row can be useless, and each has to
       leave the fourteen pages exactly as they are rather than blank. */
    ok('a missing row falls back', pageMode('index.html', MODES.modes, DEF, null).id === 'imported-mslmiae8');
    ok('…as does a row with no theme', pageMode('index.html', MODES.modes, DEF, {}).id === 'imported-mslmiae8');
    ok('…and an empty string', pageMode('index.html', MODES.modes, DEF, { theme: '  ' }).id === 'imported-mslmiae8');
    ok('a theme the store has since deleted falls back',
      pageMode('index.html', MODES.modes, DEF, { theme: 'two-tone' }).id === 'imported-mslmiae8',
      'baking a palette that no longer exists is worse than baking the wrong one');
    /* An unrecognised base has no rules in base.css, so classesFor returns null
       and the class would name nothing at all. */
    ok('…as does a theme whose base no stylesheet answers to',
      pageMode('index.html', [{ id: 'x', base: 'sepia' }].concat(MODES.modes), DEF, { theme: 'x' }).id === 'imported-mslmiae8');
    ok('super-light is a real answer, not an unrecognised one',
      pageMode('index.html', MODES.modes, DEF, { theme: 'super-light' }).id === 'super-light',
      'three bases have rules, not two');
  }

  console.log('\n  and the build really does write it per page');
  {
    ok('the two rows are read together', /key=in\.\(theme_modes,page_builder_published\)/.test(STAMP),
      'one request, because it is one question');
    ok('the theme is resolved inside the page loop, not before it',
      STAMP.indexOf('for (const page of PAGES) {') < STAMP.indexOf('const mode = pageMode(page,'),
      'resolving once outside the loop is what baked one answer into all fourteen');
    ok('…and the css is built per theme, not per page', /if \(baked\[mode\.id\]\) return baked\[mode\.id\];/.test(STAMP),
      'fourteen pages, at most two answers');
    ok('the page attributes come from the page mode',
      /keep \+= ' data-zw-theme-default="' \+ String\(mode\.base\)/.test(STAMP)
      && /keep \+= ' data-zw-theme-stamp="' \+ String\(mode\.id\)/.test(STAMP));
  }

  console.log('\n  the engine can finally say "dark"');
  {
    /* THE DEFECT, IN ONE LINE. The old reader returned '' for dark, which is
       the same value it returns for "no answer" — so the one page that most
       needed deferring to the build was the one page it could not. */
    ok('the base is read from data-zw-base first',
      /var a = \(h && h\.getAttribute && h\.getAttribute\('data-zw-base'\)\) \|\| '';/.test(ENG)
      && /if \(a === 'light' \|\| a === 'super-light' \|\| a === 'dark'\) return a;/.test(ENG),
      'body classes express dark by having none, which is indistinguishable from unset');
    ok('…with the body classes still read when the attribute is absent',
      /classList\.contains\('super-light-mode'\)\) return 'super-light';/.test(ENG)
      && /classList\.contains\('light-mode'\)\) return 'light';/.test(ENG));
    ok('the old lossy reader is gone', !/function shippedBase\(\)/.test(ENG));
  }

  console.log('\n  …but only when nobody has chosen for themselves');
  {
    ok("a visitor's own pick is consulted first",
      /var picked = byId\(chosenId\(\)\);[\s\S]{0,60}?if \(picked\) return picked;/.test(ENG),
      'somebody who chose Dark asked for Dark on every page of the shop');
    ok('…then a per-path pin', /var forPath = byId\(themeForPath\(location\.pathname\)\);/.test(ENG));
    /* And only when it DISAGREES. A store with four light themes must not be
       moved off the one it picked just because the page is also light. */
    ok('the default stands when its base already matches the page',
      /if \(base && \(!def \|\| def\.base !== base\)\)/.test(ENG),
      'otherwise "first mode with this base" would silently replace the chosen default');
    ok('…and there is one resolver, used by both passes',
      (ENG.match(/resolveTheme\(\)/g) || []).length >= 3
      && !/byId\(chosenId\(\)\) \|\| byId\(themeForPath/.test(ENG),
      'two copies of this precedence is how the page came to be repainted a third time');
  }

  console.log('\n  and the edge corrects the window the build cannot');
  {
    /* The build is right until the merchant changes a theme; after that the
       deployed HTML carries yesterday's answer until the next deploy. That gap
       is the edge's job, and it is the same comparison. */
    ok('the homepage theme is preferred at the edge too',
      /themeAttrs\(byKey\.theme_modes, home \? byKey\.page_builder_published : null\)/.test(MW));
    ok('…and the baked palette is dropped when the BASE differs, not only the id',
      /if \(baked !== id \|\| \(base && bakedBase && bakedBase !== base\)\)/.test(MW),
      'the bake IS the default here — it is a light theme on a page that renders dark');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
