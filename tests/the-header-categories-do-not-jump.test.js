/* The category strip shipped somebody else's answer and then corrected it.
   ═══════════════════════════════════════════════════════════════════════════

   index.html bakes four category links into its markup:

       Jackets   T-Shirts   Sweatpants   Socks

   and nav-menu.js replaces the lot with what the store actually configured,
   which on the live site is:

       men   Women   New

   Four long words become three short ones, so the strip paints visibly wider
   than it ends up and then collapses. That is the "wrong distancing that fixes
   itself" — it was never the SPACING. data-zw-hdr-gap has been stamped on
   <html> by the edge since the category-spacing control shipped, and the live
   page carries data-zw-hdr-gap="tight" on the first byte. The gap was right all
   along; the things being spaced were wrong.

   ── WHAT THE EDGE CAN AND CANNOT KNOW ───────────────────────────────────────

   resolveItem() in nav-menu.js needs the CATALOGUE. It builds each item's
   mega-menu from the product taxonomy, and it DROPS a gender or tag with no
   products. None of that is available at the edge without a second, far larger
   read, and a copy of that logic there is the duplication this codebase has
   been bitten by before.

   It does not have to be. nav-menu.js already has a branch for exactly this
   moment — the taxonomy has not arrived — and renders the labels alone:

       if (!tax || tax.empty) return { label: label, url: landing, columns: [] };

   navStripHtml() reproduces THAT branch and nothing else, in the same markup
   shape, so the strip measures identically before and after. This file holds
   the two to the same output, the way mirrorSpec is held to mirror().

   ── THE ONE THING IT CAN STILL BE WRONG ABOUT ───────────────────────────────

   An item the catalogue would drop — a gender or tag with no products — gets
   stamped and then removed. Measured against the live catalogue, nothing is
   dropped: Men has 5 products, Women 2, and the New tag 4. And a single item
   disappearing is a far smaller shift than four wrong words becoming three
   right ones, which is the trade being made deliberately. */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const NAV = read('nav-menu.js');
const MW = read('functions/_middleware.js');

/* ── nav-menu.js's own renderer, driven with no taxonomy ────────────────────
   Run for real rather than re-implemented: the whole point is to compare the
   edge against what the browser will actually produce. The module is an IIFE,
   so it is driven through the DOM it renders into. */
function renderWithNavMenu(cfg) {
  const host = {
    id: 'nav-category-links', className: 'nav-center', innerHTML: '',
    querySelectorAll: () => [], getBoundingClientRect: () => ({ width: 0, bottom: 0 }),
    addEventListener() {}, appendChild() {}, contains: () => false, closest: () => null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty() {}, removeProperty() {} },
  };
  const doc = {
    documentElement: {
      style: { setProperty() {}, removeProperty() {} },
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      getAttribute: () => null, setAttribute() {}, removeAttribute() {}, hasAttribute: () => false,
    },
    getElementById: (id) => (id === 'nav-category-links' ? host : null),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    createElement: () => ({ style: {}, classList: { add() {} }, setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} }, body: { appendChild() {} },
    readyState: 'complete', cookie: '',
  };
  const win = {
    document: doc, location: { pathname: '/', search: '', href: 'https://x/' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    requestAnimationFrame(cb) { return 0; }, cancelAnimationFrame() {},
    setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
    fetch: () => new Promise(() => {}),   // never resolves: no taxonomy, which is the case under test
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    IntersectionObserver: function () { this.observe = function () {}; this.disconnect = function () {}; },
    MutationObserver: function () { this.observe = function () {}; this.disconnect = function () {}; },
  };
  win.window = win;

  /* Expose the two internals this file needs, from INSIDE the module's IIFE —
     appended after it they are simply not in scope, which is the whole reason
     the closure exists. Spliced before the final `})();` rather than appended,
     and reaching in here rather than widening the production file's surface. */
  /* nav-menu.js holds THREE IIFEs; the renderer is in the first. Anchor on the
     function itself and take the next close, or the hook lands in a module that
     has never heard of it — which is exactly what lastIndexOf did. */
  const anchor = NAV.indexOf('function renderDesktop');
  if (anchor === -1) throw new Error('renderDesktop is gone from nav-menu.js');
  const close = NAV.indexOf('})();', anchor);
  if (close === -1) throw new Error('nav-menu.js does not end in an IIFE any more');
  const hook = '\n  window.__test_render = function (items) { navCfg = items; renderDesktop(resolveAll()); };\n';
  const src = NAV.slice(0, close) + hook + NAV.slice(close);
  new Function('window', 'document', 'localStorage', 'location', 'fetch', 'setTimeout',
    'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'matchMedia',
    'getComputedStyle', 'IntersectionObserver', 'MutationObserver', src)(
    win, doc, win.localStorage, win.location, win.fetch, win.setTimeout,
    win.clearTimeout, win.setInterval, win.clearInterval, win.requestAnimationFrame,
    win.matchMedia, win.getComputedStyle, win.IntersectionObserver, win.MutationObserver);

  win.__test_render(cfg);
  return host.innerHTML;
}

(async () => {
  const mod = await import('../functions/_middleware.js');
  const { navStripHtml } = mod;

  console.log('\n  the header categories do not jump\n');

  console.log('  the edge writes what nav-menu.js would write');
  {
    /* The live configuration, verbatim. */
    const LIVE = [
      { type: 'gender', label: 'men', gender: 'Men', columns: [], shopAll: true },
      { type: 'gender', label: 'Women', gender: 'Women', columns: [], shopAll: true },
      { tag: 'New', type: 'tag', label: 'New' },
    ];
    const CASES = [
      ['the live menu', LIVE],
      ['a custom link', [{ type: 'link', label: 'Sale', url: '/drop001.html?tag=Sale' }]],
      ['a mega trigger with no url', [{ type: 'link', label: 'Shop' }]],
      ['a gender with an explicit url', [{ type: 'gender', label: 'Kids', gender: 'Kids', url: '/kids' }]],
      ['a tag with an explicit url', [{ type: 'tag', label: 'Sale', tag: 'Sale', url: '/sale' }]],
      ['a label needing escaping', [{ type: 'link', label: 'A & B <x>', url: '/a?b=1&c=2' }]],
      ['a hostile url', [{ type: 'link', label: 'X', url: 'javascript:alert(1)' }]],
      ['a protocol-relative url', [{ type: 'link', label: 'Y', url: '//evil.example' }]],
      ['an item with no label at all', [{ type: 'link', url: '/x' }, { type: 'link', label: 'Real', url: '/y' }]],
    ];
    let browserFailed = false;
    for (const [name, cfg] of CASES) {
      let fromBrowser;
      try { fromBrowser = renderWithNavMenu(cfg); }
      catch (e) { browserFailed = true; ok(name + ' — nav-menu.js could be driven', false, e.message); continue; }
      const fromEdge = navStripHtml(cfg);
      ok(name + ' matches byte for byte', fromBrowser === fromEdge,
        '\n      browser: ' + fromBrowser + '\n      edge   : ' + fromEdge);
    }
    if (browserFailed) {
      ok('the harness drove nav-menu.js', false,
        'a comparison that cannot run the real renderer proves nothing');
    }
  }

  console.log('\n  and it refuses rather than guessing');
  {
    ok('nothing configured writes nothing',
      navStripHtml(null) === '' && navStripHtml([]) === '' && navStripHtml('x') === '',
      'the baked markup is left exactly as it was');
    ok('the stamp is skipped when there is nothing to write',
      /if \(attrs\.nav\) rw = rw\.on\('#nav-category-links', new NavStamp\(attrs\.nav\)\);/.test(MW));
    ok('…and it targets the host nav-menu.js renders into',
      /#nav-category-links/.test(MW) && /host\.innerHTML = items\.map/.test(NAV));
  }

  console.log('\n  the url rules are the same rules');
  {
    /* safeUrl is duplicated at the edge because a Worker cannot import a browser
       file. Same reason as mirrorSpec, same obligation to prove they agree. */
    ok('the edge carries its own copy of safeUrl', /function navSafeUrl\(u\) \{/.test(MW));
    ok('…and says why', /nav-menu\.js's safeUrl, character for character/.test(MW));
    const shapes = ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc',
      '//evil.example', '', '   ', '/ok', '#top', 'https://ok.example', 'mailto:a@b.c',
      'drop001.html?tag=New', 'nonsense url with spaces'];
    let same = true;
    const detail = [];
    for (const u of shapes) {
      const fromEdge = navStripHtml([{ type: 'link', label: 'L', url: u }]);
      const fromBrowser = renderWithNavMenu([{ type: 'link', label: 'L', url: u }]);
      if (fromEdge !== fromBrowser) { same = false; detail.push(JSON.stringify(u)); }
    }
    ok('every url shape resolves identically on both sides', same, detail.join(', '));
  }

  console.log('\n  what this deliberately does not try to do');
  {
    /* If the edge ever started resolving mega-menus it would need the catalogue,
       and it would be a second implementation of the taxonomy. */
    ok('no mega-menu markup is produced at the edge',
      !/zw-mega/.test(MW),
      'that needs the catalogue, and a copy of buildTax() at the edge is the duplication to avoid');
    ok('every stamped item is column-less, like the pre-taxonomy branch',
      navStripHtml([{ type: 'gender', label: 'Men', gender: 'Men', columns: [{ heading: 'X', categories: ['Y'] }] }])
        === '<div class="zw-navitem"><a href="landing.html?page=men" class="nav-link">Men</a></div>',
      'a configured column must not become markup the browser will then rebuild differently');
    ok('the limitation is written down, not discovered later',
      /a gender or tag with no products would be stamped and then removed/.test(MW));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
