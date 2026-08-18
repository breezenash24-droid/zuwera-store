/* Every control in the page builder changes something.
 *
 * The builder had a class of control that was worse than confusing: inert. You
 * could fill it in, press Save, watch the toast go green, and nothing anywhere
 * would change — not then, not ever. Three of them:
 *
 *   bar_text, bar_mode   Design tab -> Announcement Bar. Both appeared EXACTLY
 *                        ONCE in the whole repository: in the template that
 *                        drew the input. The live bar reads
 *                        site_settings.announcement_bar (announcement-bar.js).
 *
 *   builder_nav.links    Design -> Navigation. The storefront's renderer for
 *                        this array was deliberately deleted — storefront.js
 *                        records that it raced with the mobile menu and
 *                        overwrote it — but the editor stayed behind, complete
 *                        with a "Navigation saved" toast.
 *
 * And one that was live but wrong: bar_bg / bar_text_color worked, on the
 * homepage only, by overriding --zw-bar-bg/--zw-bar-fg after load. Those tokens
 * are set pre-paint on all fourteen pages from the theme. A second colour
 * system whose only reachable effect was making one page disagree with
 * thirteen. This file already fixed that exact shape once for the theme gallery
 * ("four of those pickers were also a second colour system"); the bar was the
 * leftover.
 *
 * THE INVARIANT THIS HOLDS: a field in the builder must name a key that
 * something outside the builder reads. Storage keys are checked, not labels,
 * because the bug was never visible in the label.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  - ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const B = read('builder.html');
const ADMIN_MAIN = read('admin-main.js');
const STOREFRONT = read('storefront.js');

/* Comments explain the deletions by NAMING what was deleted, so a bare
   substring search matches the explanation and reports the bug still present.
   Strip comments before asserting absence — on every file, not just the one
   that first caught me out. */
const strip = (src) => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
const code = strip(B);
const SF_CODE = strip(STOREFRONT);

console.log('\nNo control writes a key nothing reads');
{
  for (const dead of ['bar_text', 'bar_mode', 'bar_bg', 'bar_text_color']) {
    ok('the ' + dead + ' field is gone', !code.includes("'" + dead + "'"),
      'it wrote builder_theme.' + dead + '; the live bar reads site_settings.announcement_bar');
  }
  ok('so is the navigation link editor',
    !/saveNav|addNavLink|removeNavLink|updateNavLink|renderNavTab/.test(code),
    'storefront.js deleted the renderer for builder_nav.links and left the editor');
  ok('...and nothing still calls it', !code.includes("curTab==='nav'"),
    'a route to a function that no longer exists throws on arrival');

  /* The reason the editor was dead, kept where it can be read. If this comment
     ever goes, the next person re-adds the editor. */
  ok('the storefront still records why links are not editable here',
    STOREFRONT.includes('owned by nav-menu.js'));

  /* Removing a control while leaving its reader is the same bug backwards: the
     value already saved in builder_theme would keep overriding the theme with
     nothing left anywhere to see or clear it. */
  ok('and the storefront stopped applying the colours too',
    !/bt\.bar_bg|bt\.bar_text_color/.test(SF_CODE),
    'a stale builder_theme.bar_bg would be an override with no control left');
  ok('the theme still owns the bar on every page',
    (read('index.html').match(/--zw-bar-bg/g) || []).length > 0);
  /* Left on purpose, and worth knowing about: three readers, no writer. */
  ok('accent_color is still read, and still has no editor',
    /bt\.accent_color/.test(SF_CODE) && !/'accent_color'/.test(code),
    'dropping it would change the live accent, so it is a decision not a tidy-up');

  ok('the field helpers the bar needed went with it',
    !/const colorF2=|const f2=/.test(code), 'zero call sites once the bar fields left');
}

console.log('\nWhat survived, survived because it works');
{
  ok('the logo is still editable', code.includes('data-k="logo_url"'),
    'it is read as cfg.navSettings.logo_url and nothing else sets it');
  ok('the logo still lands in navSettings, not themeSettings',
    /k==='logo_url'\)\s*navSettings\.logo_url/.test(code),
    'routing it with the rest would save it to a key the storefront never reads');
  ok('the storefront still reads it there', STOREFRONT.includes('cfg.navSettings.logo_url'));
  ok('one save button writes both keys it can touch',
    /await put\('builder_theme'/.test(code) && /await put\('builder_nav'/.test(code),
    'two sub-tabs meant two save buttons, so half a pane saved at a time');
  ok('and only reports success once both land',
    code.indexOf("toast('Design saved'") > code.indexOf("await put('builder_nav'"),
    'a half-save that says it worked is what teaches you not to trust the button');
}

console.log('\nThe pointers out of the builder arrive somewhere');
{
  ok('the Design tab points at the admin page that owns the bar and the nav',
    B.includes('/admin.html#website'));
  ok('the admin resolves a #hash to a page', ADMIN_MAIN.includes('function zwPageFromHash'),
    'the admin had no hash routing at all, so every deep link landed on the dashboard');
  ok('a hash beats the remembered page',
    ADMIN_MAIN.indexOf('const hashPage = zwPageFromHash()') >
    ADMIN_MAIN.indexOf("sessionStorage.getItem('zw_admin_page')"),
    'the remembered page is a default; the hash is an explicit request');
  ok('an unknown hash changes nothing', /ADMIN_PAGES\.some\(p => p\.id === id\)/.test(ADMIN_MAIN));
  ok('the older #fonts link resolves too', /fonts: 'website'/.test(ADMIN_MAIN),
    'builder.html has linked to /admin.html#fonts since before any hash routing existed');
  ok('a second link in the same tab still moves', ADMIN_MAIN.includes("'hashchange'"));
}

console.log('\nOne click-mode, not three booleans');
{
  ok('the three toggles are gone',
    !/function toggleSelectMode|function toggleTextEdit|function toggleMoveMode/.test(code),
    'each owned a boolean and had to remember the other two');
  ok('the monkey-patch that policed them is gone',
    !code.includes('_origToggleSel'),
    'it re-wrapped window.toggleSelectMode to catch what the other two forgot');
  ok('one setter owns all three', /function setCanvasMode\(m,silent\)/.test(code));
  for (const [v, m] of [['selectMode', 'select'], ['textEditMode', 'text'], ['moveMode', 'move']]) {
    /* The setter pads these three assignments so they line up, so match on the
       shape rather than the spacing. */
    ok(v + ' is derived from the mode',
      new RegExp('\\b' + v + '\\s*=\\s*\\(m===.' + m + '.\\)').test(code));
  }
  ok('the iframe is told about the modes that are OFF too',
    /sendSelectMode\(\); sendTextEditMode\(\); sendMoveMode\(\);/.test(code),
    'it keeps no opinion, so an unannounced loser keeps its handlers attached');
  ok('a mode is always on', code.includes("let canvasMode='select'"),
    'all three defaulted to off, so clicking the preview did nothing out of the box');
  ok('it is a radiogroup, and behaves like one',
    code.includes('role="radiogroup"') && code.includes("/^Arrow(Left|Right)$/"));
  ok('boot paints it without announcing it',
    /setCanvasMode\(canvasMode,true\)/.test(code), 'a toast on load reports a choice nobody made');
  /* init()'s try block opens with a synchronous getSb(). If that throws, the
     catch and the tail run during script evaluation — before `let canvasMode`
     exists. This repo has shipped a hotfix branch for that exact shape once. */
  ok('...after the temporal dead zone, not inside it',
    /setTimeout\(\(\)=>setCanvasMode\(canvasMode,true\),0\)/.test(code),
    'a sync throw from getSb() runs the tail while canvasMode is still in TDZ');
}

console.log('\nThe editor does not resize the preview');
{
  ok('the editor is out of flow', /\.ed\{position:absolute/.test(B),
    'as a third flex column it took 300px off the preview whenever it opened');
  ok('it is exactly as wide as the list it covers',
    (B.match(/width:var\(--lp-w\)/g) || []).length >= 2);
  ok('one token sets that width', B.includes('--lp-w:292px'));
  ok('hiding it does not collapse a width', !/\.ed\.hidden\{width:0/.test(B),
    'animating width is what made the preview resize');

  /* The number this protects: the storefront's main breakpoint. A preview
     narrower than this is rendering the mobile layout. */
  const breaks = (read('storefront-cohesion.css').match(/max-width:\s*900px/g) || []).length;
  ok('the 900px breakpoint is still worth protecting (' + breaks + ' rules)', breaks > 5);
}

console.log('\nThe preview reports its width instead of asserting it');
{
  ok('the hard-coded label is gone', !B.includes("desk:'1280px"),
    "desk is width:100% inside whatever space is left — it could not know it was 1280px");
  ok('the frame is measured', /getBoundingClientRect\(\)\.width/.test(code));
  ok('after layout settles', /requestAnimationFrame/.test(code.slice(code.indexOf('function pvMeasure'), code.indexOf('function pvMeasure') + 700)));
  ok('and says so when it is below the breakpoint',
    code.includes('PV_BREAK = 900') && code.includes("'mobile layout'"),
    'a narrow viewport under a label saying "Desktop" is how a preview lies');
  ok('it re-measures when the window changes', /addEventListener\('resize',pvMeasure\)/.test(code));
}

console.log('\nThe tabs are grouped by what they are');
{
  /* End on the markup, not on 'lp-content' — that string is a CSS selector
     28k characters higher up the file, and slicing to it silently returns ''. */
  const barStart = B.indexOf('<div class="lp-tabsec">Page</div>');
  const bar = B.slice(barStart, B.indexOf('id="lpContent"', barStart));
  ok('places in the store sit together',
    ['tab-content', 'tab-pages', 'tab-product', 'tab-collection'].every((t) => bar.includes(t)));
  ok('things that apply to all of them sit together',
    ['tab-design', 'tab-settings', 'tab-history', 'tab-templates'].every((t) => bar.includes(t)));
  ok('the groups are labelled', (bar.match(/lp-tabsec/g) || []).length >= 2,
    'six tabs already wrapped to two rows — the split was drawn, just in the wrong place');
  ok('four across, not three', /\.lp-tabs\{display:grid;grid-template-columns:repeat\(4,1fr\)/.test(B));
  ok('History is a tab, not a menu item', !/more-item[^>]*lpTab\('history'\)/.test(B));
  ok('Templates too', !/more-item[^>]*lpTab\('templates'\)/.test(B));
  ok('Layouts is not in both the toolbar and the menu',
    (B.match(/onclick="openLayouts\(\)"/g) || []).length === 1,
    'count the callers: `function openLayouts(){` contains the call as a substring');
  ok('the builder no longer has a tab called Settings', !/>Settings<\/button>/.test(bar),
    'it edits SEO; the admin has a different page by that name');
  ok('the destructive item is called out', B.includes('Cannot be undone'));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
