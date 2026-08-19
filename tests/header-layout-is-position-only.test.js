/* Where things sit in the header, chosen from a picker.
 *
 * THE FIRST VERSION OF THIS FEATURE DID NOT WORK, and the tests passed anyway.
 * They asserted that the module named slots, generated its tiles from those
 * slots, and moved elements into them — all true, and none of it the question.
 * The question was whether the header ENDED UP that way, and it did not: the
 * categories are centred by `position:absolute`, so moving that element into a
 * "left" wrapper left it exactly where it was, and every arrangement that
 * centred something else stacked it underneath the still-centred categories.
 * Two of ten arrangements changed nothing; four made the logo unclickable.
 *
 * So this file now checks the two things that actually decide it:
 *
 * 1. THE VOCABULARY IS THE ONE THE STYLESHEET IMPLEMENTS. A layout is four
 *    placement values that storefront-cohesion.css already understands and
 *    theme-engine.js already writes. If a layout used a value the stylesheet
 *    has no rule for, the attribute would still be set — reading as "placed"
 *    and suppressing the default — and the header would quietly do nothing.
 *
 * 2. ONLY ONE THING WRITES THE ATTRIBUTES. Two writers is how an arrangement
 *    survives being chosen and then vanishes on the next theme change.
 *
 * The geometry itself — that each arrangement lands where its tile says, with
 * nothing on top of anything — is measured in a real browser rather than
 * asserted here, because that is the part that was wrong and the part no
 * string comparison can see.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  - ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

/* Comments in these files quote the very strings some assertions look for
   ("appendChild", "position:absolute"), so every "is absent" check runs
   against the code with its comments removed. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SRC = read('header-layouts.js');
const CODE = strip(SRC);
const B = read('builder.html');
const BCODE = strip(B);
const TE = read('theme-engine.js');
const CSS = read('storefront-cohesion.css');
const SAVE = read('functions/api/save-page-builder.js');
const PV = read('functions/api/preview-config.js');
const MIG = read('migrations/0027_the_header_arrangement_is_public.sql');
const MIG26 = read('migrations/0026_text_the_builder_can_edit_anywhere.sql');

/* Run the real file, unmodified, against a page that has no header.

   That is not a contrivance — it is the builder. The picker loads this file for
   its definitions and its tiles, and the builder has no storefront nav of its
   own, so the whole storefront half stops before it asks the server for
   anything. It also must not put a data-zw-hdr attribute on the BUILDER's own
   <html>, which would rearrange the builder's chrome. */
let asked = 0;
const attrsSet = [];
const box = {
  console,
  document: {
    readyState: 'complete',
    documentElement: {
      setAttribute: (k) => attrsSet.push(k),
      removeAttribute: () => {},
    },
    querySelector: () => null,
    addEventListener: () => {},
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} },
  },
  localStorage: { getItem: () => null, setItem() {} },
  fetch: () => { asked++; return Promise.resolve({ ok: false }); },
  setTimeout, clearTimeout,
};
box.window = box;
vm.createContext(box);
vm.runInContext(SRC, box);
const L = box.ZWHeaderLayouts;

console.log('\nThere are real, distinct arrangements to choose from');
{
  ok('the definitions load', !!L && Array.isArray(L.list));
  ok('a page with no header asks the server for nothing', asked === 0);
  ok('...and sets no attribute on it either', attrsSet.length === 0,
    'the builder loads this file too; arranging ITS header is not the job');
  ok('there are enough to be worth a gallery', L.list.length >= 8, L.list.length + ' layouts');
  const ids = L.list.map((l) => l.id);
  ok('every id is unique', new Set(ids).size === ids.length);
  ok('every one has a name and an explanation',
    L.list.every((l) => l.name && l.note && l.note.length > 20));
  const shapes = L.list.map((l) => JSON.stringify(l.spec));
  ok('no two are the same arrangement', new Set(shapes).size === shapes.length);
  ok('the familiar one comes first', L.list[0].id === 'classic',
    'the first tile should be the arrangement you already have');
}

console.log('\nA layout says where, in the vocabulary the stylesheet implements');
{
  const KEYS = new Set(['id', 'name', 'note', 'spec']);
  ok('a layout carries nothing but a name and a placement',
    L.list.every((l) => Object.keys(l).every((k) => KEYS.has(k))),
    'colour, size and font belong to the theme');
  const SPEC_KEYS = new Set(['logo', 'links', 'actions', 'linksRow']);
  ok('and the placement has only the four parts',
    L.list.every((l) => Object.keys(l.spec).every((k) => SPEC_KEYS.has(k))));
  ok('no layout mentions a colour, size or font',
    !/color|font|size|background|weight/i.test(JSON.stringify(L.list.map((l) => l.spec))));

  /* The decisive check. Every value a layout can carry must be one the
     stylesheet has an actual rule for — otherwise the attribute is written,
     counts as "placed", and suppresses the arrangement the page shipped with
     while producing nothing in its place. */
  const has = (attr, val) => CSS.includes('html[data-zw-hdr-' + attr + '="' + val + '"]');
  for (const part of ['logo', 'links', 'actions']) {
    const used = [...new Set(L.list.map((l) => l.spec[part]))];
    ok('every "' + part + '" value has a rule in storefront-cohesion.css',
      used.every((v) => has(part, v)),
      used.filter((v) => !has(part, v)).join(', ') || '');
  }
  ok('the two-row mode has a rule too',
    L.list.every((l) => String(l.spec.linksRow) !== '2') || CSS.includes('html[data-zw-hdr-linksrow="2"]'));
  ok('theme-engine writes exactly these four attributes',
    ['logo', 'links', 'actions', 'linksrow'].every((a) => TE.includes("'data-zw-hdr-" + a + "'")));
}

console.log('\nThe picker offers nothing the header cannot hold');
{
  /* Both limits are the stylesheet's, and both were found by measuring:
     centring is absolute positioning, so two centred parts overlap; "right" is
     margin-left:auto, and two parts taking it spread apart. */
  ok('conflict() rejects two centred parts',
    !!L.conflict({ logo: 'center', links: 'center', actions: 'right', linksRow: 1 }));
  ok('conflict() rejects two right-hand parts',
    !!L.conflict({ logo: 'left', links: 'right', actions: 'right', linksRow: 1 }));
  ok('conflict() rejects centred actions beside in-flow categories',
    !!L.conflict({ logo: 'left', links: 'right', actions: 'center', linksRow: 1 }),
    'measured: they overlapped by 73px with the four categories this shop has');
  ok('...but allows it once the categories leave the bar',
    !L.conflict({ logo: 'left', links: 'none', actions: 'center', linksRow: 1 }));
  ok('two parts on the LEFT is fine', !L.conflict({ logo: 'left', links: 'left', actions: 'left', linksRow: 1 }),
    'only the first element takes the leading margin, so they simply sit in order');

  const bad = L.list.filter((l) => L.conflict(l.spec));
  ok('every shipped layout passes its own rule', bad.length === 0,
    bad.map((l) => l.id + ': ' + L.conflict(l.spec)).join(' | '));
}

console.log('\nThe picture cannot disagree with the result');
{
  for (const l of L.list) {
    const z = L.zones(l.spec);
    const m = L.miniature(l);
    const drawn = {};
    for (const s of L.spots) {
      const seg = new RegExp('zwhl-' + s + '">([\\s\\S]*?)(?=<span class="zwhl-z|</span><span class="zwhl-row2|</span></span>$)').exec(m);
      drawn[s] = seg ? (seg[1].match(/class="zwhl-p /g) || []).length : -1;
    }
    const want = L.spots.map((s) => z[s].length).join();
    const got = L.spots.map((s) => drawn[s]).join();
    ok(l.id + ': the tile draws exactly the parts the placement puts in each zone', want === got,
      'drew ' + got + ', placement says ' + want);
  }
  ok('a second row is drawn only when the placement asks for one',
    L.list.every((l) => (L.zones(l.spec).row2.length > 0) === /zwhl-row2/.test(L.miniature(l))));
  ok('an unknown layout draws nothing', L.miniature('nope') === '');
  ok('the tile styles ship with the definitions', typeof L.css === 'string' && L.css.includes('.zwhl-bar'));
  ok('the builder draws from that function, not its own copy',
    /L\.miniature\(l\)/.test(B) && !/zwhl-logo|zwhl-links/.test(BCODE),
    'a second drawing of the same thing is a second thing to keep in step');
}

console.log('\nNothing is moved, and only one thing writes the attributes');
{
  ok('the layout module moves no markup',
    !/appendChild|insertBefore|removeChild|\.remove\(\)/.test(CODE),
    'moving an absolutely-positioned element does not move it; that was the bug');
  ok('it creates no wrapper elements', !/createElement\(['"]div/.test(CODE));
  ok('it hides nothing', !/style\.display|data-zw-hdr-off/.test(CODE),
    'a part missing from the header is an icon setting, not a placement');
  ok('it does not write the attributes itself', !/data-zw-hdr-(logo|links|actions|linksrow)/.test(CODE),
    'two writers is how an arrangement survives being chosen and dies on the next theme change');
  ok('it asks theme-engine to place the header', /ZWTheme\.setHeader/.test(CODE));
  ok('theme-engine offers that entry point', /setHeader: function \(spec\)/.test(TE));
  ok('...and consults the override inside the one function that writes them',
    /function applyHeader\(root, header\) \{\s*applyHeaderLines\(root\);\s*if \(hdrOverride\) header = hdrOverride;/.test(TE),
    'set from outside instead, it would be wiped by the next theme apply');
  ok('the override outranks the theme rather than the reverse',
    TE.indexOf('if (hdrOverride) header = hdrOverride;') < TE.indexOf("var spec = typeof header === 'string'"));
}

console.log('\nPlacement is deterministic, not left to space-between');
{
  ok('a placed header packs from the start',
    /html\[data-zw-hdr\] :is\(#nav, \.nav, \.zw-nav\) \{[\s\S]*?justify-content: flex-start;/.test(CSS),
    'every dialect ships space-between, which spreads parts that claim no auto margin');
  ok('the centred-logo case buys the categories room',
    /html\[data-zw-hdr-logo="center"\]\[data-zw-hdr-linksrow="1"\][\s\S]{0,120}\.nav-center \{\s*gap:/.test(CSS),
    'measured: the category strip ended 9px inside a centred wordmark');
}

console.log('\nChoosing is not applying');
{
  ok('the button sits with the other canvas controls', /id="hdrCfgBtn"/.test(B));
  ok('and opens a gallery you can compare in', /id="hdrCfgList" class="hdrcfg-grid"/.test(B)
    && /\.hdrcfg-grid\{display:grid/.test(B));
  ok('a tile click only highlights it',
    /function pickHeaderLayout\(id\)\{[\s\S]*?hdrCfgSel=id;\s*paintHeaderCfg\(\);\s*\}/.test(B),
    'browsing the gallery must not rewrite the header once per tile');
  /* Scoped to that function's own body. Matched across the whole file, any
     `markChromeDirty` anywhere later satisfies a lazy quantifier and the check
     passes for the wrong reason. */
  const pickBody = (B.split('function pickHeaderLayout(id){')[1] || '').split('\n}')[0];
  ok('...and marks nothing dirty on the way',
    pickBody.length > 0 && !/markChromeDirty|sendChrome|toast\(/.test(pickBody));
  ok('there is an apply button', /id="hdrCfgApply"/.test(B) && /Apply layout/.test(B));
  ok('applying is what changes the draft',
    /function applyHeaderCfg\(\)\{[\s\S]*?markChromeDirty\('header'\)[\s\S]*?sendChrome\(\)/.test(B));
  ok('the button says so when there is nothing to apply', /Already applied/.test(B));
  ok('the current arrangement is marked as current, separately from the selection',
    /hdrcfg-cur/.test(B) && /hdrcfg-mark/.test(B));
  ok('it previews at once', /post\(\{type:'ZW_HEADER_LAYOUT',id:chromeHeader,lines:chromeHdrLines\}\)/.test(B));
}

console.log('\nA preview shows the draft, not a flash of what is live first');
{
  ok('the module can tell it is inside the builder',
    /function isPreview\(\)/.test(SRC) && /__ZW_BUILDER_PREVIEW__/.test(SRC) && /__zwPreviewReady/.test(SRC));
  ok('the published arrangement is held rather than applied there',
    /if \(preview && !draftSettled\) \{ held = \{ id: id, lines: lines \}; return; \}/.test(SRC),
    'it is the LOCAL value, so it always won the race and the canvas rearranged twice');
  ok('both the cache and the server go through that hold',
    (SRC.match(/fromServer\(/g) || []).length >= 3,
    'the cache is the one that arrives first, so skipping only the fetch fixes nothing');
  ok('a draft that carries no arrangement releases the held one',
    /if \(held\) \{ set\(held\.id, held\.lines\); held = null; \}/.test(SRC),
    'otherwise the canvas shows neither the draft nor what is live');
  ok('a draft that never arrives releases it too',
    /if \(preview && window\.__ZW_BUILDER_PREVIEW__\) \{[\s\S]{0,140}draftSettled\) draftDone\(null, ''\)/.test(SRC),
    'a postMessage that is never sent has no failure to catch');
  ok('the modal says it is position only', /Position only/.test(B));
  ok('...and that nothing is live until Publish', /nothing is live until you press Publish/.test(B));
}

console.log('\nThe arrangement is in place before the first frame');
{
  const PRE = read('scripts/theme-preboot.head.js');
  ok('the pre-paint block stamps all four attributes',
    ['logo', 'links', 'actions', 'linksrow'].every((a) => PRE.includes("'data-zw-hdr-" + a + "'")),
    'header-layouts.js is deferred, so without this the header paints in the arrangement the MARKUP is in and then jumps');
  ok('it reads the resolved values, not a layout name',
    PRE.includes("'zw_hdr_attrs'") &&
    !L.list.some((l) => new RegExp("['\"]" + l.id + "['\"]").test(PRE)),
    'a copy of the layout table in the head is a second definition to keep in step');
  ok('it checks them against the same vocabulary theme-engine accepts',
    /_hs\s*=\s*\{ left: 1, center: 1, right: 1 \}/.test(PRE) && /_hc\[1\] === 'none'/.test(PRE),
    'an attribute the stylesheet has no rule for still counts as placed, and suppresses the shipped arrangement');

  /* ── The case a cache can never fix ──────────────────────────────────────
     A first-ever visitor has nothing stored, so there is nothing to pre-paint
     from and the header rearranges in front of them. The only answer is for
     the arrangement to be in the document when it arrives. */
  const STAMP = read('scripts/stamp-header-layout.js');
  const stamper = require('../scripts/stamp-header-layout.js');
  ok('a build step bakes the arrangement into <html>',
    ['data-zw-hdr="1"', 'data-zw-hdr-logo="', 'data-zw-hdr-links="',
     'data-zw-hdr-actions="', 'data-zw-hdr-linksrow="'].every((a) => STAMP.includes(a)));
  ok('it reads the layout table rather than restating it',
    !L.list.some((l) => new RegExp("['\"]" + l.id + "['\"]").test(strip(STAMP))),
    'a second copy of the table is how the tile and the page start disagreeing');
  /* The riskiest line in the whole feature: header-layouts.js is browser code
     run under a stub here, and if it ever reaches for a DOM API the stub lacks,
     this silently stamps nothing on the deploy and nobody sees the log. */
  const T = stamper.loadLayouts();
  ok('...and that table really does load in Node',
    !!T && Array.isArray(T.list) && T.list.length === L.list.length
      && !!T.byId('classic') && T.byId('classic').spec.logo === 'left');
  ok('it stamps the row timestamp too', STAMP.includes('data-zw-hdr-at="'),
    'without it the baked answer and a cached one cannot be ranked');
  ok('it removes only attributes it wrote',
    /const OURS = \[/.test(STAMP) && /for \(const attr of OURS\)/.test(STAMP));
  ok('an arrangement the store no longer names is cleared, not left baked',
    /if \(spec\) \{/.test(STAMP) && /placement cleared/.test(STAMP));
  ok('it runs on the deploy only', /if \(!process\.env\.CF_PAGES && !process\.argv\.includes\('--local'\)\)/.test(STAMP),
    'locally it would rewrite committed HTML on every npm install');
  ok('it can never break the build',
    /\} catch \(e\) \{[\s\S]{0,200}<html> unchanged/.test(STAMP));
  ok('and it guards against corrupting the page',
    /html count changed in/.test(STAMP));
  ok('postinstall runs it', /stamp-header-layout\.js/.test(read('package.json')));
  ok('...after the other <html> stamper, so the two cannot interleave',
    read('package.json').indexOf('stamp-theme-default.js') < read('package.json').indexOf('stamp-header-layout.js'));

  ok('the pre-paint block prefers a NEWER cache over the baked answer',
    /_hfresh = !_hb \|\| \(_hc\[4\] \|\| ''\) > _hb/.test(PRE),
    'publishing without deploying and deploying without publishing fail in opposite directions');
  ok('...and falls back to the cache when nothing was baked',
    /!_hb \|\|/.test(PRE),
    'a local build stamps nothing, and an undated cache is still better than none');
  ok('a builder preview strips the baked arrangement as well as ignoring the cache',
    /if \(window\.__ZW_BUILDER_PREVIEW__\) \{[\s\S]{0,320}removeAttribute\('data-zw-hdr-linksrow'\)/.test(PRE),
    'the baked value is the published one, which is exactly what a draft preview must not show');

  ok('the cache is written from the published value only',
    /remember\(id, row && row\.updated_at, lines\);/.test(SRC) && !/draftDone[\s\S]{0,200}remember\(/.test(SRC),
    'a draft that survived into the next page load would show a shopper unpublished work');
  ok('and cleared when the store names no arrangement',
    /if \(!l\) \{ localStorage\.removeItem\(CACHE\); localStorage\.removeItem\(ATTRS\); return; \}/.test(SRC),
    'otherwise the head keeps stamping an arrangement nothing on the server still names');

  /* sync-preboot.js stamps this block into every storefront page and
     theme-preboot.test.js fails the build on a single byte of drift; this only
     checks the block actually reached them. */
  for (const p of ['index.html', 'product.html', 'drop001.html', 'about.html', 'bag.html', 'landing.html']) {
    ok(p + ' carries the pre-paint arrangement block', read(p).includes('zw_hdr_attrs'));
  }
}

console.log('\nThe line under the header is a choice, and it moves nothing');
{
  const PRE2 = read('scripts/theme-preboot.head.js');
  const STAMP2 = read('scripts/stamp-header-layout.js');

  /* Two rules draw it — the nav's own border and the announcement bar's — so a
     store with the bar on shows two faint seams a header apart. */
  ok('both rules are covered by one setting',
    /html\[data-zw-hdr-lines="off"\][\s\S]{0,160}#bar \{\s*border-bottom-color: transparent/.test(CSS),
    'turning off only the nav leaves the seam between the bar and the nav');
  ok('it is turned off by COLOUR, not by removing the border',
    !/html\[data-zw-hdr-lines="off"\][\s\S]{0,220}border-bottom: none/.test(CSS)
    && /html\[data-zw-hdr-lines="off"\][\s\S]{0,220}border-bottom-color: transparent/.test(CSS),
    'removing it would shift the header, and everything measured from it, by 1px per line');
  ok('...and it is not behind the desktop-only media query',
    CSS.indexOf('html[data-zw-hdr-lines="off"]') > CSS.indexOf('@media (max-width: 900px)'),
    'a phone shows the same lines');

  ok('theme-engine is still the only thing that writes it',
    /root\.setAttribute\('data-zw-hdr-lines'/.test(TE) && !/setAttribute\('data-zw-hdr-lines'/.test(CODE));
  /* The early return in applyHeader is the trap: a store that wants the line
     off without choosing an arrangement has no placement to carry it. */
  ok('it applies even when no arrangement is chosen',
    /function applyHeader\(root, header\) \{\s*applyHeaderLines\(root\);/.test(TE),
    'applyHeader returns early with no placement, and would have dropped it');
  ok('and a spec with no placement still sets it',
    /hdrOverride = s && s\.logo \? s : null;/.test(TE));

  ok('the module carries it on every route in',
    /function apply\(id, lines\)/.test(SRC) && /lineChoice\(d\.lines\)/.test(SRC)
    && /var cl = parts\[5\] \|\| '';/.test(SRC));
  ok('an unknown layout id does not discard the line choice',
    /var spec = l \? l\.spec : null;/.test(SRC),
    'they are two answers and only one of them is missing');
  ok('the pre-paint block stamps it before the first frame',
    /data-zw-hdr-lines', _hc\[5\]/.test(PRE2));
  ok('...ranked by the same timestamp as the placement', /_hfresh && \(_hc\[5\]/.test(PRE2));
  ok('...and stripped in a builder preview', /removeAttribute\('data-zw-hdr-lines'\)/.test(PRE2));
  ok('the build bakes it too', /data-zw-hdr-lines="/.test(STAMP2));

  ok('the builder has a two-state control', /id="hdrLinesOn"/.test(B) && /id="hdrLinesOff"/.test(B));
  ok('...which says it applies to every page', /Applies to every page/.test(B));
  ok('...and writes it into the same draft as the arrangement',
    /function setHdrLines\(v\)\{[\s\S]{0,340}markChromeDirty\('header'\)/.test(B));
  ok('the saved value carries both answers',
    /const out = \{ id, lines: chromeHdrLines \|\| 'on' \};/.test(B));
  ok('and the preview push carries it',
    /post\(\{type:'ZW_HEADER_LAYOUT',id:chromeHeader,lines:chromeHdrLines\}\)/.test(B));
}

console.log('\nOne header height, whichever arrangement is chosen');
{
  /* Measured before this rule: 63px with the logo centred against 67px with it
     on the left, because a centred part is absolutely positioned and stops
     contributing height. Two-row arrangements were 96-97px against 67px. */
  ok('a centred part cannot collapse the bar',
    /html\[data-zw-hdr\] :is\(#nav, \.nav, \.zw-nav\) \{\s*min-height: var\(--zw-hdr-minh/.test(CSS),
    'the bar was sized by the action buttons instead, and a taller logo hung out of it');
  ok('a second row costs a row, not half a header again',
    /html\[data-zw-hdr-linksrow="2"\] :is\(#nav, \.nav, \.zw-nav\) \{\s*padding-bottom:/.test(CSS),
    'the inter-row gap and the bar padding were both sized for a single row');
}

console.log('\nIt travels like the rest of the chrome draft');
{
  ok('Save Draft can write it', /header: \['header_layout_draft'/.test(B));
  ok('Publish promotes it', /header_layout_draft: 'header_layout'/.test(SAVE));
  ok('the endpoint permits the draft key', /'header_layout_draft'/.test(SAVE));
  ok('and stores it verbatim', /'header_layout', 'header_layout_draft',/.test(SAVE));
  ok('Preview live shows the draft', /'header_layout_draft'/.test(PV) && /header_layout_draft: 'header_layout'/.test(PV));
  /* The storefront reads this key with the anon key on every page load. Left
     off the allow-list it returns [] forever, and the arrangement applies in
     the builder (the draft travels by postMessage) while the live site keeps
     the header it shipped with — which is exactly how it shipped broken. */
  const allow = MIG.split('array[')[1] || '';
  ok('the live key is publicly readable', /'header_layout'/.test(allow));
  ok('...and the draft key is not', !/header_layout_draft/.test(allow),
    'a readable draft key is a REST route to unpublished work');

  /* ALTER POLICY REPLACES the allow-list, so a later migration that forgets a
     key silently revokes public read for it sitewide. This is the check that
     caught 0026 being built on the wrong base. */
  const keysOf = (m) => new Set(((m.split('array[')[1] || '').match(/'[a-z_]+'/g) || []));
  const lost = [...keysOf(MIG26)].filter((k) => !keysOf(MIG).has(k));
  ok('0027 keeps everything 0026 allowed', lost.length === 0, 'dropped: ' + lost.join(', '));

  /* The addition had to be a NEW file. It was first made as an edit to 0026,
     after 0026 had been applied — and migrations are recorded by version and
     skipped once recorded, so the edit could never run. The file and the
     database disagreed and nothing said so. */
  ok('0026 is left as the version that actually ran',
    !/header_layout/.test(MIG26),
    'editing an applied migration cannot take effect; it needs its own version');

  const pages = ['index.html', 'product.html', 'drop001.html', 'about.html', 'journal.html',
                 'policies.html', 'bag.html', 'account.html', 'sizeguide.html', 'landing.html', '404.html'];
  for (const p of pages) {
    const s = read(p);
    ok(p + ' loads it, and loads theme-engine first', s.includes('header-layouts.js')
      && s.indexOf('theme-engine.js') > -1 && s.indexOf('theme-engine.js') < s.indexOf('header-layouts.js'),
      'setHeader has to exist by the time this asks for it');
  }
}

console.log('\nNothing quietly undoes the answer the document arrived with');
{
  const PRE3 = read('scripts/theme-preboot.head.js');

  /* THE ONE THAT SURVIVED EVERY PREVIOUS FIX. theme-engine.js runs before
     header-layouts.js, both deferred, and no theme in this store carries a
     header — so applyHeader was reached with nothing set and cleared all five
     attributes. That wiped the build's bake and the edge stamp on every single
     load, and the arrangement was then restored a moment later from cache or
     from the network. Pre-paint undone one step further along. */
  ok('theme-engine clears only the attributes it wrote itself',
    /function clear\(\) \{\s*if \(!hdrWritten\) return;/.test(TE),
    'a document that arrived already knowing its arrangement has to keep it');
  ok('...and records having written them', /hdrWritten = true;/.test(TE));
  ok('...and a theme switch still undoes the previous theme’s placement',
    /hdrWritten = false;/.test(TE),
    'that is what the clearing was for, and it still has to work');

  /* THE SECOND CACHE READER. The pre-paint block declined to overwrite a
     document that already knew its arrangement; header-layouts.js then did it
     anyway, a moment later, with the same stale value. */
  ok('the module checks the document before applying its cache',
    /var docAt = document\.documentElement\.getAttribute\('data-zw-hdr-at'\)/.test(SRC)
    && /if \(!docAt \|\| \(parts\[4\] \|\| ''\) > docAt\)/.test(SRC),
    'two readers of one cache, and only one of them was checking');
  ok('...using the same comparison the pre-paint block uses',
    /_hfresh = !_hb \|\| \(_hc\[4\] \|\| ''\) > _hb/.test(PRE3),
    'two different answers to "is this cache newer" is how they disagree');
  ok('a document that makes no claim still gets the cache',
    /!docAt \|\|/.test(SRC),
    'an older build stamps nothing, and the cache is then the best available');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
