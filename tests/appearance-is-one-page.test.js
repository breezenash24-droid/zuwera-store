/* The storefront's looks, on one page, with something that proves them.
 *
 * Announcement Bar, Header Scroll Behavior, Product Cards and Navigation Menu
 * were on SETTINGS while the hero, the theme and the typography were on
 * APPEARANCE. Both answer 'how does the storefront look?' and nothing said which
 * page owned which surface — you had to know.
 *
 * The rule that decides it: if a live preview can prove the change, it belongs
 * with the preview. That is why email theming stays put despite being visual (a
 * storefront preview cannot render a receipt) and why the FAQ copy stays on
 * Settings.
 *
 * ── ?builder=1 is a safety property, not routing ────────────────────────────
 *
 * The preview iframe shares an origin, and therefore localStorage, with the real
 * storefront. builder=1 sets __ZW_BUILDER_PREVIEW__ in the pre-paint block, which
 * is what makes storefront-theme.js pass remember:false. Without it, opening the
 * panel would write zw_theme_mode and pin every visitor to whatever was being
 * previewed. That bug has already happened in this codebase once.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + (e ? '  - ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const HTML = read('admin.html');
const MAIN = read('admin-main.js');

const pages = [];
{
  const re = /<div id=\"([a-zA-Z0-9_-]+)\" class=\"page[^\"]*\"[^>]*>/g;
  let m; while ((m = re.exec(HTML))) pages.push({ id: m[1], at: m.index });
}
const pageOf = (needle) => {
  const i = HTML.indexOf(needle);
  if (i < 0) return '(not found)';
  let owner = '(before any page)';
  for (const p of pages) if (p.at < i) owner = p.id;
  return owner;
};

console.log('\n  the storefront looks live on one page\n');

console.log('  the chrome panels moved');
{
  ['set-jump-chrome', 'Announcement Bar', 'Header Scroll Behavior', 'Navigation Menu'].forEach((n) => {
    ok(n + ' is on Appearance', pageOf(n) === 'website', 'found on #' + pageOf(n));
  });
  /* The move must not have swallowed the section after it. */
  ok('Store rules stayed on Settings', pageOf('set-jump-rules') === 'settings');
  ok('Early Access stayed on Settings', pageOf('Early Access') === 'settings');
  ok('Settings says where they went', HTML.includes('open Appearance'));
}

console.log('\n  and they are populated there');
{
  /* loadSettings() filled them and only ran on a Settings click. After the move
     that leaves four panels rendering empty, which reads as settings never made
     rather than as settings not loaded. */
  ok('Appearance loads the settings row too',
    MAIN.includes(String.raw`[data-page="website"]`) && MAIN.includes("setTimeout(loadSettings, 100)"),
    'otherwise the moved panels are blank unless you open Settings first');
  /* The admin search is a SECOND record of where a thing lives. */
  ok('admin search points at the new page',
    !MAIN.includes("sub:'Settings \u00b7 Storefront chrome'")
      && MAIN.includes("page:'website',el:'settAnnouncementBarMessage'"),
    'search would still send people to Settings');
}

console.log('\n  the preview previews and never remembers');
{
  ok('there is a storefront preview on Appearance', pageOf('zw-sf-preview') === 'website',
    'found on #' + pageOf('zw-sf-preview'));
  ok('every load carries builder=1', MAIN.includes("'builder=1&pv='"),
    'without it the iframe writes zw_theme_mode into the real storefront');
  ok('...and the pre-paint block reads that flag',
    read('scripts/theme-preboot.head.js').includes('builder=1'));
  /* Opening a real tab is the one case where you want it exactly as a visitor
     gets it, so that link deliberately does NOT carry the flag. */
  ok('Open in a tab is the un-flagged storefront',
    MAIN.includes("window.open((sel && sel.value) || '/', '_blank', 'noopener')"));
}

console.log('\n  it is worth having open');
{
  ok('the page under test is selectable', HTML.includes('id="pvPage"'));
  ok('...at several widths', HTML.includes('data-w="390"') && HTML.includes('data-w="1280"'));
  ok('...named by width, not by device', HTML.includes('>390<') && !HTML.includes('>iPhone<'),
    'a device name is a guess about a population; a number is checkable');
  ok('saving refreshes it', (MAIN.match(/zwPreviewRefresh/g) || []).length >= 4,
    'a preview that shows the previous save is worse than none, because you trust it');
  ok('...and that can be switched off', HTML.includes('id="pvAuto"'));
  ok('it loads with the page, not with the admin',
    MAIN.includes('window.zwPreviewOpen'),
    'an iframe of the storefront on every login is a page load nobody asked for');
  ok('binding twice does not stack listeners', MAIN.includes('root.dataset.bound'));
  ok('the panel says it changes nothing', HTML.includes('never changes what a visitor sees'));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);