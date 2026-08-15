/* What a price looks like, and the theme being right for a visitor with no cache.
 *
 * TWO THINGS, one cause each.
 *
 * 1. "MSRP doesn't sound right." It did not. The product page showed one of two
 *    labelled lines — "MSRP: $230" or "Regular: $40.00" — and neither word means
 *    anything to a shopper. MSRP is a trade term; "Regular" invites "compared to
 *    what?". Every store that sells at a discount shows the same three things
 *    instead: what you pay, what it was, and how much less that is. The numbers
 *    carry the meaning, so the labels go.
 *
 * 2. "When you open the store it still looks like this on the first load." The
 *    pre-paint snippet fixed this for anyone with a cached theme. A first-ever
 *    visitor — and every incognito window — has no cache, so there is nothing to
 *    paint from and the page shows base.css's committed default until
 *    theme-engine.js corrects it. The only fix is to put the answer in what
 *    ships, which is what stamp-theme-default.js does at build time.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const PROD  = fs.readFileSync(path.join(ROOT, 'product.html'), 'utf8');
const CSS   = fs.readFileSync(path.join(ROOT, 'product.css'), 'utf8');
const ENG   = fs.readFileSync(path.join(ROOT, 'theme-engine.js'), 'utf8');
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin-themes.js'), 'utf8');
const STAMP = fs.readFileSync(path.join(ROOT, 'scripts/stamp-theme-default.js'), 'utf8');
const PKG   = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/* Run the real renderPrice against a DOM small enough to read back. */
function render(prices, member) {
  const els = {};
  const doc = { getElementById: (id) => (els[id] = els[id] || { id, innerHTML: '' }) };
  const src = PROD.slice(PROD.indexOf('function renderPrice() {'));
  const body = src.slice(0, src.indexOf('\n}') + 2);
  new Function('resolvedPrices', 'currentProduct', 'document', 'syncProductSaveButton', 'isMemberSignedIn',
    body + '\nrenderPrice();')(
    () => prices, {}, doc, () => {}, () => !!member);
  return {
    now: (els.priceDisplay || {}).innerHTML || '',
    was: (els.msrpDisplay || {}).innerHTML || '',
    member: (els.memberPrice || {}).innerHTML || '',
  };
}

console.log('\n  what a price looks like\n');

console.log('  a discounted price, the way every store shows one');
{
  const r = render({ priceCents: 16697, regularCents: 23000, memberCents: 0, msrpCents: 23000, usingMember: false, source: 'list' });
  ok('the price you pay', /\$166\.97/.test(r.now));
  ok('the price it was, struck through', /zw-price-was/.test(r.was) && /\$230\.00/.test(r.was));
  ok('and how much less that is', /27% off/.test(r.was),
    'a struck figure with no percentage makes the shopper do the arithmetic');
  ok('no trade jargon anywhere', !/MSRP/i.test(r.was) && !/Regular:/i.test(r.was),
    'MSRP is a term from the trade and "Regular" invites "compared to what?"');
}

console.log('\n  nothing is struck through when nothing was discounted');
{
  const r = render({ priceCents: 4000, regularCents: 4000, memberCents: 0, msrpCents: 0, usingMember: false, source: 'product' });
  ok('no was-price', r.was === '');
  ok('no saving badge', !/% off/.test(r.was));
  ok('no member line', r.member === '');
}

console.log('\n  a rounding artefact is not a sale');
{
  /* 0.4% off. An unrounded calculation prints "0% off", which is worse than no
     badge: it claims a discount and then denies it in the same breath. */
  const r = render({ priceCents: 3985, regularCents: 4000, memberCents: 0, msrpCents: 4000, usingMember: false, source: 'product' });
  ok('under 1% shows nothing at all', r.was === '', 'got: ' + r.was);
}

console.log('\n  a member price is a discount too, and reads the same way');
{
  const r = render({ priceCents: 3500, regularCents: 4000, memberCents: 3500, msrpCents: 0, usingMember: true, source: 'product' }, true);
  ok('the member price is what is charged', /\$35\.00/.test(r.now));
  ok('…struck against what they would otherwise pay', /\$40\.00/.test(r.was),
    'one rule — the higher of compare-at and the price this shopper avoided — covers both cases');
  ok('…with the saving shown', /12% off/.test(r.was));
  ok('…and the line says it plainly', /Member price/.test(r.member));
}

console.log('\n  and it does not claim a member saving that is not one');
{
  /* THE OLD BUG: "Member savings applied" printed whenever the catalogue rule
     picked a member price, so it appeared beside a price-list figure that had
     discounted nothing. */
  const r = render({ priceCents: 3000, regularCents: 3000, memberCents: 0, msrpCents: 4000, usingMember: false, source: 'list' }, true);
  ok('a list price is not dressed up as a member saving', !/Member/i.test(r.member),
    'got: ' + r.member);
  ok('…but the discount is still shown', /25% off/.test(r.was));
}

console.log('\n  a member who is not signed in is told what they would save');
{
  const r = render({ priceCents: 4000, regularCents: 4000, memberCents: 3500, msrpCents: 0, usingMember: false, source: 'product' });
  ok('the member figure is offered', /Members pay \$35\.00/.test(r.member));
}

console.log('\n  the colours are a store\'s to choose');
{
  ok('each part is a token, not a literal',
    /--zw-price-now/.test(CSS) && /--zw-price-was/.test(CSS)
    && /--zw-price-off/.test(CSS) && /--zw-price-member/.test(CSS));
  ok('the theme can set them', /set\('--zw-price-off', t\.priceOff\)/.test(ENG));
  ok('…and the admin exposes all four',
    ['priceOff', 'priceWas', 'priceNow', 'priceMember'].every((k) => ADMIN.includes("key: '" + k + "'")));
  ok('…as optional, so a store that ignores them still looks considered',
    /key: 'priceOff'[^}]*optional: true/.test(ADMIN));
  /* The default treatment is a decision, not an absence: one coloured element. */
  ok('by default only the saving is coloured',
    /--zw-price-now: var\(--text-primary/.test(CSS) && /--zw-price-off: #22c55e/.test(CSS),
    'a price that fights the theme is worse than one that matches it');
}

console.log('\n  the first-EVER load, where there is no cache to read');
{
  ok('the default theme is stamped at build time', /stamp-theme-default/.test(PKG.scripts.postinstall),
    'nothing else can help a visitor whose browser has never seen this site');
  ok('…before minify and cache hashing',
    PKG.scripts.postinstall.indexOf('stamp-theme-default') < PKG.scripts.postinstall.indexOf('bump-cache-version'),
    'stamping after the hash means the change ships without a new URL and nobody refetches');
  ok('…on the Cloudflare build only',
    /if \(!process\.env\.CF_PAGES && !process\.argv\.includes\('--local'\)\) process\.exit\(0\);/.test(STAMP),
    'a local run rewrites committed HTML on every npm install');

  ok('super-light gets BOTH classes', /light-mode super-light-mode/.test(STAMP),
    'super-light is a narrowing of light, not a separate branch');
  ok('dark gets none, rather than a class no stylesheet answers to', /if \(base === 'dark'\) return '';/.test(STAMP));
  ok('an unknown base stamps nothing', /return null;/.test(STAMP) && /unrecognised base/.test(STAMP));

  ok('it only ever rewrites its own marker', /MARK_OPEN = 'zw-theme-stamp'/.test(STAMP),
    'without a marker a hand-written class on <body> gets clobbered and reruns compound');
  ok('a failed fetch leaves the HTML as committed', /<body> left as committed/.test(STAMP));
  ok('…as does a default naming a theme that no longer exists', /not found — <body> left as committed/.test(STAMP));
  ok('and it reads the canonical project rather than restating it',
    /require\(path\.join\(__dirname, '\.\.', 'zw-config\.js'\)\)/.test(STAMP),
    'a fork stamping the ORIGINAL store\'s theme is the bug zw-config.js exists to prevent');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
