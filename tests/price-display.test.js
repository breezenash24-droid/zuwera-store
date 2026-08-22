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

const PROD  = require('./_product-source').all()  /* product.html + its extracted scripts — see _product-source.js */;
const CSS   = fs.readFileSync(path.join(ROOT, 'product.css'), 'utf8');
const ENG   = fs.readFileSync(path.join(ROOT, 'theme-engine.js'), 'utf8');
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin-themes.js'), 'utf8');
const STAMP = fs.readFileSync(path.join(ROOT, 'scripts/stamp-theme-default.js'), 'utf8');
const PKG   = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/* Run the real renderPrice against a DOM small enough to read back.
   `known` is whether the server has answered for this product yet — the page
   prints no figure at all until it has. Default true, because almost every case
   below is about what a settled price LOOKS like. */
function render(prices, member, known, look, gift) {
  const els = {};
  const doc = { getElementById: (id) => (els[id] = els[id] || { id, innerHTML: '' }) };
  const src = PROD.slice(PROD.indexOf('function renderPrice() {'));
  const body = src.slice(0, src.indexOf('\n}') + 2);
  const asked = [];
  const win = { ZWVariantPrice: { known: () => known !== false, ask: (id) => asked.push(id) } };
  /* Builder → Product → Price. Defaults are what the page does with nobody
     having opened that tab, so most cases below pass nothing. */
  const LOOK = Object.assign({ member_position: 'inline', member_style: 'pill', member_label: '' }, look || {});
  /* `gift` is {card:true, chosenCents:N} for the gift-card cases. Everything
     else passes nothing and gets a product that is not one. */
  const G = gift || {};
  new Function('resolvedPrices', 'currentProduct', 'document', 'syncProductSaveButton', 'isMemberSignedIn', 'window',
    'PRICE_LOOK', 'PRICE_LOOK_READY', 'isGiftCardProduct', 'gcChosenCents',
    body + '\nrenderPrice();')(
    () => prices, { id: 'p-1' }, doc, () => {}, () => !!member, win, LOOK, known !== false,
    () => !!G.card, () => Number(G.chosenCents) || 0);
  return {
    now: (els.priceDisplay || {}).innerHTML || '',
    was: (els.msrpDisplay || {}).innerHTML || '',
    member: (els.memberPrice || {}).innerHTML || '',
    asked,
  };
}

console.log('\n  what a price looks like\n');

console.log('  a gift card is worth what the buyer chose');
{
  /* THE BUG, EXACTLY AS IT WAS REPORTED: "if you put in a different amount it
     should show the different amount you put instead of just whatever the face
     value is of the card". It did not, and not because of the arithmetic —
     paintGiftCardAmount() wrote to #productPrice, an element this page does not
     have. getElementById answered null, the assignment did nothing, and the
     page went on showing $50 above a button reading $300.00. Writing to nothing
     is not an error, so nothing anywhere said so.

     There is one writer for the price element now, and this is it. */
  const r = render({ priceCents: 5000, regularCents: 5000, memberCents: 0, msrpCents: 0, usingMember: false, source: 'catalog' },
    false, true, null, { card: true, chosenCents: 30000 });
  ok('the page shows the amount that was chosen', /\$300\.00/.test(r.now),
    'got ' + r.now + ' — a shopper reading $50 under a $300 button has been told two prices');
  ok('…and not the listed face value', !/\$50\.00/.test(r.now));
}

{
  /* A gift card is excluded from promotions and member pricing at the till, so
     a struck-through figure or a Member badge on this page advertises a
     discount checkout will refuse to give. Suppressed on the product BEING a
     card, not on an amount having been chosen — the claim was wrong either way. */
  const r = render({ priceCents: 5000, regularCents: 6500, memberCents: 5000, msrpCents: 6500, usingMember: true, source: 'catalog' },
    true, true, null, { card: true });
  ok('no struck-through figure on a gift card', r.was === '',
    'got ' + r.was + ' — the till gives no discount on a card, so the page must not advertise one');
  ok('and no member badge either', !/zw-price-member-tag/.test(r.now + r.member));
  ok('the listed price still shows when nothing was chosen', /\$50\.00/.test(r.now));
}

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
  /* THE LABEL MOVED, on purpose. It used to be its own line under the struck
     figure, which read as a footnote arriving after the fact — and when the
     member price is the ONLY price shown, a trailing "Member price" looks like
     it is describing something further down the page. Beside the number it is
     what it actually is: the name of the figure it sits on. */
  ok('…and the label sits on the price it names', /Member price/.test(r.now),
    'got: ' + r.now);
  ok('…rather than trailing underneath it', r.member === '',
    'saying it twice is what made it look like an afterthought');
}

console.log('\n  the member badge is arranged in the builder');
{
  const MEMBER = { priceCents: 2200, regularCents: 4000, memberCents: 2200, msrpCents: 4000, usingMember: true, source: 'list' };

  const inline = render(MEMBER, true, true, { member_position: 'inline' });
  ok('beside the price by default', /zw-price-member-tag/.test(inline.now) && inline.member === '',
    'the default is what the page already did, so upgrading redesigns nobody');

  const below = render(MEMBER, true, true, { member_position: 'below' });
  ok('…or on its own line', /zw-price-member-tag/.test(below.member),
    'a long price and a badge on one line is what makes it look cramped');
  ok('…and then NOT beside it as well', !/zw-price-member-tag/.test(below.now),
    'printed in both places is the duplicate that made it read as an afterthought');

  const hidden = render(MEMBER, true, true, { member_position: 'hidden' });
  ok('…or not at all', !/zw-price-member-tag/.test(hidden.now) && hidden.member === '');
  ok('…without hiding the price itself', /\$22\.00/.test(hidden.now),
    'hiding the badge must never hide the figure it labels');
  ok('…or the saving', /45% off/.test(hidden.was));

  ok('the shape is a class, not a hard-coded look',
    /zw-mtag-pill/.test(render(MEMBER, true, true, { member_style: 'pill' }).now)
    && /zw-mtag-plain/.test(render(MEMBER, true, true, { member_style: 'plain' }).now)
    && /zw-mtag-solid/.test(render(MEMBER, true, true, { member_style: 'solid' }).now));
  ok('…and every one of them is styled',
    ['pill', 'plain', 'solid'].every((s) => new RegExp('\\.zw-mtag-' + s + '\\s*\\{').test(CSS)),
    'a class no stylesheet answers to is a badge with no shape at all');

  const worded = render(MEMBER, true, true, { member_label: 'Crew price' });
  ok('the wording is the merchant\'s', /Crew price/.test(worded.now));
  ok('…and empty falls back to ours', /Member price/.test(render(MEMBER, true, true, { member_label: '' }).now),
    'a cleared box means "I did not choose one", not "show an empty badge"');

  /* Merchant-typed free text on a public page. Sanitised where it is stored AND
     escaped where it is inserted; this checks the second, which is the one that
     actually protects the page. */
  const nasty = render(MEMBER, true, true, { member_label: 'a"b&c' });
  ok('it is escaped on the way in', /a&quot;b&amp;c/.test(nasty.now), 'got: ' + nasty.now);

  /* The badge names a price somebody is GETTING. A shopper who is not signed in
     is being made an offer, which is a different sentence in a different place. */
  const guest = render({ priceCents: 4000, regularCents: 4000, memberCents: 2200, msrpCents: 0, usingMember: false, source: 'product' }, false, true, { member_position: 'below' });
  ok('a guest still gets the offer, not the badge',
    /Members pay \$22\.00/.test(guest.member) && !/zw-price-member-tag/.test(guest.member));
}

console.log('\n  no price is printed before the server has answered');
{
  /* "It still loads the old price first when you reload."
     Removing the cache would not have fixed it — with nothing cached the page
     drew the CATALOGUE price, which on a discounted product is just as wrong.
     The fix is not a better fallback, it is not printing a figure until one is
     known. Same rule the tax total follows in checkout. */
  const r = render({ priceCents: 4000, regularCents: 4000, memberCents: 0, msrpCents: 0, usingMember: false, source: 'product' }, false, false);
  ok('no figure at all', !/\$/.test(r.now), 'got: ' + r.now);
  ok('a placeholder holds the space instead', /zw-price-pending/.test(r.now),
    'a price area that collapses and reopens is its own flash');
  ok('nothing is struck through either', r.was === '');
  ok('and no member line is guessed at', r.member === '');
  ok('…while the request is made from here too', r.asked.length === 1,
    'a placeholder waiting on a request nobody sent would be permanent');

  const settled = render({ priceCents: 4000, regularCents: 4000, memberCents: 0, msrpCents: 0, usingMember: false, source: 'product' }, false, true);
  ok('and the figure appears once it is known', /\$40\.00/.test(settled.now));
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
  ok('the member label and the placeholder are styled, not bare markup',
    /\.zw-price-member-tag\s*\{/.test(CSS) && /\.zw-price-pending\s*\{/.test(CSS));
  ok('…the label takes the same token as the member line',
    /\.zw-price-member-tag[^}]*var\(--zw-price-member\)/.test(CSS),
    'a store that recolours member pricing should not have to find two places');
  ok('…and the placeholder holds the line height so nothing reflows',
    /\.zw-price-pending[^}]*height:\s*1em/.test(CSS));
  ok('…and stops moving for anyone who asked it to',
    /prefers-reduced-motion[^}]*\}\s*[^@]*\.zw-price-pending\s*\{\s*animation:\s*none/.test(CSS)
    || /@media \(prefers-reduced-motion: reduce\) \{\s*\.zw-price-pending \{ animation: none; \}/.test(CSS));
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
