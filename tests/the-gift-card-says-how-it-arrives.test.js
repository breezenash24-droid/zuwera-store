/* A gift card page that stopped talking about shipping, and started looking
 * like the rest of the site.
 *
 * ── THE SECTION ─────────────────────────────────────────────────────────────
 *
 * "Free standard shipping on orders $100+" and "60-day returns for members"
 * stood on a product that is emailed. The page type could only ever REMOVE
 * things — data-zw-garment hides garment furniture — so the shipping section
 * kept standing with garment copy in it, because there was no way to say "and
 * this goes here instead". data-zw-giftcard is the other half of that pair.
 *
 * Swapped in CSS rather than by rewriting the paragraphs, and that is the whole
 * design: loadSiteSettings() writes shippingPolicyText1/2 from site_settings
 * whenever that row lands, so a race between "make this say Delivery" and "make
 * this say the shipping policy" is one the network wins at random. Hidden text
 * can be overwritten all day and stay hidden.
 *
 * ── THE WORDS ───────────────────────────────────────────────────────────────
 *
 * The sentence is an admin's to write. It appears in two places on one page —
 * beside the price and in the Delivery section — from ONE key, because a store
 * that edited one and not the other would be contradicting itself on a single
 * screen.
 *
 * ── AND THE MODAL ───────────────────────────────────────────────────────────
 *
 * "This modal does not fit the rest of the website." It did not, and not by a
 * shade of grey: it was a private overlay, so it opted out of the scrim and its
 * blur, the panel surface, the accent border, the radius, the open/close
 * motion, the light and super-light repaints and the mobile bottom sheet — all
 * at once, all of which live on the class names .modal and .mbox.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const HTML = read('product.html');
const PM = read('product-main.js');

global.window = {};
require(path.join(ROOT, 'customer-messages.js'));
const M = global.window.ZWMessages;

console.log('\n  the words are the store\'s\n');

const SHIPPED = M.get('giftCardDelivery');

ok('there is a message for how a gift card is delivered',
  typeof SHIPPED === 'string' && SHIPPED.length > 40,
  'got: ' + SHIPPED);

ok('it is on the product page surface, so an admin can find it',
  M.surfaces().some((s) => s.name === 'Product page'
    && [...s.keys, ...s.rare].includes('giftCardDelivery')),
  'a message nobody can reach from the editor is a hardcoded paragraph with extra steps');

{
  /* The markup ships the sentence so a failed settings load still explains how
     the card arrives. A fallback that has quietly drifted from the default is
     worse than no fallback: it is a second answer nobody knows exists. */
  const m = /<p id="giftCardDeliveryNote">([^<]*)<\/p>/.exec(HTML);
  ok('the page ships the sentence as its no-JS fallback', !!m);
  ok('…and the fallback is the shipped default, character for character',
    !!m && m[1] === SHIPPED,
    m ? 'markup:  ' + m[1] + '\n       default: ' + SHIPPED : '');
}

{
  const fn = PM.slice(PM.indexOf('function paintGiftCardDelivery()'));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);
  ok('one function writes both places',
    /giftCardDeliveryNote/.test(body) && /giftCardDeliveryText/.test(body),
    'two writers is how the note beside the price and the Delivery section come '
    + 'to say different things about the same card');
  ok('…from one key', (body.match(/giftCardDelivery'/g) || []).length === 1);
  ok('…and an empty answer leaves the markup standing',
    /if \(!text\) return;/.test(body),
    'blanking the line on a failed load is worse than yesterday\'s wording');
  ok('it repaints when an admin\'s edit lands',
    /ZWMessages\.subscribe\(function \(\) \{[\s\S]{0,400}paintGiftCardDelivery\(\)/.test(PM),
    'the wording arrives over the network, after this page has already drawn');
}

console.log('\n  shipping copy does not stand on a product that is emailed');

ok('the shipping paragraphs are marked as garment furniture',
  /<p id="shippingPolicyText1" data-zw-garment>/.test(HTML)
  && /<p id="shippingPolicyText2" data-zw-garment>/.test(HTML));

ok('so is the "Shipping & Returns" heading',
  /<span data-zw-garment>Shipping & Returns<\/span>/.test(HTML));

ok('and "Delivery" stands in its place',
  /<span data-zw-giftcard>Delivery<\/span>/.test(HTML)
  && /<p id="giftCardDeliveryText" data-zw-giftcard><\/p>/.test(HTML));

{
  /* The pair. One half without the other is a page type that can only subtract. */
  ok('data-zw-garment hides on a gift card',
    /body\[data-zw-product="gift-card"\] \[data-zw-garment\] \{ display: none !important; \}/.test(HTML));
  ok('…and data-zw-giftcard is the half that adds',
    /\[data-zw-giftcard\] \{ display: none; \}/.test(HTML)
    && /body\[data-zw-product="gift-card"\] \[data-zw-giftcard\] \{ display: revert; \}/.test(HTML));
}

{
  /* The race this design exists to avoid. If somebody ever "simplifies" the
     swap into a textContent assignment, site_settings will win it at random. */
  ok('the shipping policy loader still writes the shipping paragraphs',
    /shippingPolicyText1/.test(PM) && /shippingPolicyText2/.test(PM),
    'hidden text being overwritten is fine and is the point — a swap done by '
    + 'rewriting these would race loadSiteSettings() and lose at random');
  const swap = PM.indexOf('applyGiftCardPageType');
  const body = PM.slice(swap, PM.indexOf('\n}', swap));
  ok('…and the page type never touches them',
    !/shippingPolicyText/.test(body),
    'that is the race, written down');
}

console.log('\n  the amount picker belongs to this website');

ok('the dialog is the site\'s own .modal',
  /<div class="modal" id="giftCardAmountModal"/.test(HTML),
  'a private overlay opts out of the scrim, the blur, the panel, the motion, '
  + 'the light themes and the mobile sheet, all at once');
ok('…with the site\'s own .mbox panel inside it',
  /<div class="mbox fs-box gc-amount-box">/.test(HTML),
  'fs-box as well as mbox: Find My Size is the dialog this one is modelled on, '
  + 'and .fs-box is what carries its padding and its shadow');
ok('…and the same intro block Find My Size uses',
  /<p class="review-modal-eyebrow">Gift Card<\/p>/.test(HTML)
  && /<h2 class="review-modal-title" id="gcAmountTitle">/.test(HTML)
  && /<p class="review-modal-copy" id="gcAmountCopy">/.test(HTML));
ok('…with one full-width .fs-submit rather than a pair of small buttons',
  /<button type="button" class="fs-submit gc-amount-ok"/.test(HTML)
  && !/gc-amount-cancel/.test(HTML),
  'Find My Size has one action and a close cross; two right-aligned buttons '
  + 'was the shape of a dialog from somewhere else');
ok('…and it opens by the class the rest of the site opens by',
  /modal\.classList\.add\('open'\)/.test(PM) && /modal\.classList\.remove\('open'\)/.test(PM),
  'toggling `hidden` skips every rule keyed on .open, including the scroll lock');
ok('the private overlay is gone, not merely unused',
  !/\.gc-modal\b/.test(HTML),
  'a second modal system left in the stylesheet is the one the next person copies');

ok('the dialog collects a number and lets the module judge it',
  /_gcCommit\(Math\.round\(/.test(PM) && /onCustom: openGiftCardAmount/.test(PM),
  'a host that both collected the figure and applied the bounds would be the '
  + 'second implementation the module exists to prevent');

/* ── THE CHIPS LEFT .size-btn, AND THAT WAS THE RIGHT CALL ─────────────────
   They were .size-btn, the product page's own control, which inherited light
   mode, super-light, hover and selected for nothing. Then the same block had to
   appear inside the quick-add panel — which shows up on four pages that never
   load product.css — and an inherited class is worth nothing on a page that
   does not have it. The module paints them itself, from currentColor, so the
   filled state inverts correctly on any ground without a per-theme branch. */
{
  const MOD = read('gift-card-buy.js');
  ok('the amount chips are the module\'s, so they look the same in all three places',
    /class="zwgc-amt"/.test(MOD) && /\.zwgc-amt\.is-on\{background:currentColor/.test(MOD));
  ok('…and the product page no longer draws its own',
    !/className = 'size-btn gc-amt'/.test(PM),
    'two implementations of one control is what this module exists to end');
}

ok('tapping the scrim closes it, the way every other dialog here behaves',
  /if \(e\.target === modal\) window\.closeGiftCardAmount\(\)/.test(PM));
ok('and Escape does too',
  /e\.key === 'Escape'/.test(PM));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
