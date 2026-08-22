/* The card goes to the person it was bought for.
 *
 * ── WHAT IT USED TO DO ──────────────────────────────────────────────────────
 *
 * _fulfil.js carried this note where the delivery email is built:
 *
 *     "Sent to the buyer, because nothing on a gift-card line says who it is
 *      for. Adding a recipient field to the cart is the obvious next step and a
 *      bigger one: it needs a place to type it, validation, and a decision
 *      about what happens when it bounces."
 *
 * This is that step. Three things about it are worth holding down.
 *
 * ── THE FORM CAN EMAIL STRANGERS ────────────────────────────────────────────
 *
 * A box where anyone types an address and 250 characters, and this store sends
 * it, is a spam relay in every other context. Three things make it not one:
 * it is capped server-side where the caller cannot argue, it is escaped where
 * it is rendered, and NOTHING IS SENT UNTIL A PAYMENT SUCCEEDS. That last one
 * is the real control — every message has a card paid for behind it.
 *
 * ── A GIFT DOES NOT BELONG TO WHOEVER PAID FOR IT ───────────────────────────
 *
 * owner_user_id is where a balance is LISTED — the wallet on the account page.
 * Leaving the buyer's id on a card bought for somebody else puts the present in
 * the giver's wallet and leaves the recipient holding a code the store thinks
 * is not theirs.
 *
 * ── AND ONE ORDER CAN HOLD CARDS FOR SEVERAL PEOPLE ─────────────────────────
 *
 * One email per card puts three messages in one inbox. One email to everybody
 * shows each recipient the others' codes, which is spendable money belonging to
 * strangers. Grouped by address is the only arrangement that is neither.
 */
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

(async () => {
  const CP = await import(pathToFileURL(path.join(ROOT, 'functions/api/_cart-pricing.js')).href);
  const { normalizeGiftRecipient: norm } = CP;

  console.log('\n  what the server will accept as a recipient\n');

  {
    const to = norm({ first: '  Ada  ', last: 'Lovelace', email: '  ADA@Example.COM ', message: 'Happy birthday' });
    ok('it is trimmed', to && to.first === 'Ada' && to.last === 'Lovelace');
    ok('…and the address is lowercased', to && to.email === 'ada@example.com',
      'two spellings of one address are two recipients everywhere downstream');
    ok('…and the note survives', to && to.message === 'Happy birthday');
  }

  {
    ok('no address is no recipient', norm({ first: 'Ada' }) === null,
      'a half-filled recipient would send the card nowhere and say it had');
    ok('nor is a thing that is not an address', norm({ first: 'Ada', email: 'ada@example' }) === null);
    ok('nor is an address with no name', norm({ email: 'ada@example.com' }) === null);
    ok('and nothing at all is null', norm(null) === null && norm('ada@example.com') === null);
  }

  {
    const to = norm({
      first: 'A'.repeat(400), last: 'B'.repeat(400),
      email: 'ada@example.com', message: 'm'.repeat(4000),
    });
    ok('every field is capped where the caller cannot argue',
      to.first.length === 50 && to.last.length === 50 && to.message.length === 250,
      'first ' + to.first.length + ', last ' + to.last.length + ', message ' + to.message.length);
  }

  {
    /* A note laid out in lines should arrive in lines. The other fields have
       their whitespace collapsed; this one deliberately does not. */
    const to = norm({ first: 'Ada', email: 'ada@example.com', message: 'One\nTwo' });
    ok('the note keeps its line breaks', to.message === 'One\nTwo',
      '_gift-card-emails.js escapes it and turns them into <br>');
  }

  console.log('\n  and how it travels');

  {
    const quote = {
      attributedUser: null, lineItems: [], inventoryItems: [], subtotalCents: 5000,
      shipping: {}, giftCardLines: [[5000, 1], [2500, 1]],
      giftCardRecipients: [
        { first: 'Ada', last: 'Lovelace', email: 'ada@example.com', message: 'Happy birthday' },
        null,
      ],
      normalizedPromoCode: '', discountCents: 0, tax: {}, taxStateCode: '', taxRate: 0,
      taxCents: 0, totalCents: 7500,
    };
    const meta = CP.buildOrderMetadata({ orderNumber: 'ZW-1', address: { email: 'buyer@example.com' }, quote });

    ok('the named line gets its own metadata key', typeof meta.gc_to_0 === 'string' && meta.gc_to_0.length > 0);
    ok('…index-matched to gift_cards', JSON.parse(meta.gift_cards)[0][0] === 5000,
      'the recipient of line 0 must be the recipient of the amount at index 0');
    ok('…and the unnamed line gets none', meta.gc_to_1 === undefined,
      'an empty key is a key spent on nothing, and Stripe allows fifty');

    const packed = JSON.parse(meta.gc_to_0);
    ok('the packed form carries name, address and note',
      packed.e === 'ada@example.com' && packed.n === 'Ada Lovelace' && packed.m === 'Happy birthday');
    ok('…and fits inside Stripe\'s per-value cap', meta.gc_to_0.length <= 500,
      'got ' + meta.gc_to_0.length + ' — a truncated recipient is a card emailed to half an address');
  }

  {
    /* The cap. Past it the cards go to the buyer to forward, which is what
       every gift card did before recipients existed — a smaller failure than
       a silently truncated address, and it is logged rather than swallowed. */
    const many = Array.from({ length: 12 }, (_, i) => ({
      first: 'P' + i, last: '', email: 'p' + i + '@example.com', message: '',
    }));
    const quote = {
      attributedUser: null, lineItems: [], inventoryItems: [], subtotalCents: 0,
      shipping: {}, giftCardLines: many.map(() => [2500, 1]), giftCardRecipients: many,
      normalizedPromoCode: '', discountCents: 0, tax: {}, taxStateCode: '', taxRate: 0,
      taxCents: 0, totalCents: 0,
    };
    const warned = [];
    const realWarn = console.warn;
    console.warn = (...a) => warned.push(a.join(' '));
    let meta;
    try { meta = CP.buildOrderMetadata({ orderNumber: 'ZW-2', address: {}, quote }); }
    finally { console.warn = realWarn; }

    const keys = Object.keys(meta).filter((k) => k.startsWith('gc_to_'));
    ok('no more than eight recipient keys are written', keys.length === 8, 'got ' + keys.length);
    ok('…and the overflow is said out loud, not swallowed',
      warned.some((w) => /recipient/i.test(w) && /cap/i.test(w)),
      'silence here is a shopper whose friend never hears about their card');
  }

  console.log('\n  the card is minted for them, not for whoever paid');

  {
    const fulfil = read('functions/api/_fulfil.js');
    ok('a gifted card is nobody\'s wallet until it is claimed',
      /ownerUserId: to \? null : \(meta\.user_id \|\| null\)/.test(fulfil),
      'the buyer\'s id here puts the present in the giver\'s wallet');
    ok('…and is listed against the recipient\'s address',
      /ownerEmail: to \? to\.email : \(meta\.customer_email \|\| ''\)/.test(fulfil));
    ok('the recipient is read per LINE, index-matched to the amounts',
      /readGiftRecipient\(meta\['gc_to_' \+ i\]\)/.test(fulfil),
      'one recipient for the whole order sends every card to whoever was typed first');
    ok('…and an unreadable one falls back to the buyer rather than throwing',
      /catch \(_\) \{ return null; \}/.test(fulfil),
      'a card that issued but could not be addressed still exists and is still on the receipt');
  }

  {
    const fulfil = read('functions/api/_fulfil.js');
    const fn = fulfil.slice(fulfil.indexOf('async function sendGiftCardDeliveredEmail'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    ok('the delivery email groups by address',
      /groups\.set\(key/.test(body) && /for \(const g of groups\.values\(\)\)/.test(body),
      'one email per card floods an inbox; one email to everybody shows each '
      + 'recipient the others\' codes, which is other people\'s money');
    ok('…and one bad address does not silence the rest',
      /Promise\.allSettled\(sends\)/.test(body));
    ok('…and the buyer still gets anything nobody was named for',
      /const key = \(c\.to && c\.to\.email\) \? c\.to\.email : '';/.test(body),
      'every gift card sold before this existed has no recipient at all');
  }

  console.log('\n  and the bag can tell two gifts apart');

  {
    const pm = read('product-main.js');
    ok('the merge key includes who it is for',
      /JSON\.stringify\(item\.giftCardTo \|\| null\) === JSON\.stringify\(cartItem\.giftCardTo \|\| null\)/.test(pm),
      'two $50 cards for two different people are not two of one card — merging '
      + 'them sends both to whoever was typed first');
    ok('the line carries the recipient', /giftCardTo: _gcTo/.test(pm));
    ok('…and Add to Bag refuses a card with nowhere to go',
      /const problem = gcRecipientProblem\(_gcTo\);/.test(pm));
  }

  console.log('\n  a gift card has no shelf to be empty');

  {
    const plp = read('drop001.html');
    ok('the collection grid does not infer a sell-out from having no stock rows',
      /totalStock: Number\(product\.gift_card_cents\) > 0\s*\n\s*\? null/.test(plp),
      'the sum of no stock rows is zero, and zero read as "the last one sold" — '
      + 'SOLD OUT on a product that is minted when somebody pays for it');
  }

  {
    const admin = read('admin-main.js');
    ok('MSRP, member price and Klarna are hidden on a gift card',
      /'msrp', 'memberPrice', 'installmentDisplay',/.test(admin),
      'a compare-at price advertises a saving the till refuses to give, and a '
      + 'member price on a card is a control that does nothing');
    ok('…and a member price is never SAVED on one',
      /function _memberPriceFromForm\(\)/.test(admin)
      && /member_price: _memberPriceFromForm\(\)/.test(admin),
      'a hidden field still submits');
    ok('the face value is filled in from the first amount rather than asked for twice',
      /valEl\.value = \(list\[0\] \/ 100\)\.toFixed\(2\)/.test(admin));
  }

  console.log('\n  every surface that shows a bag says who the card is for');

  {
    /* One implementation. Two renderers draw a bag line — bag.html and
       checkout.html — and a rule about gift cards living in both is the shape
       of every drift this codebase has had to fix twice. */
    global.window = global.window || {};
    require(path.join(ROOT, 'zw-data.js'));
    const GC = global.window.ZWGiftCard;

    ok('a gifted line names its recipient',
      GC.recipientLine({ giftCardTo: { first: 'Ada', last: 'Lovelace', email: 'ada@example.com' } })
        === 'To Ada Lovelace (ada@example.com)');
    ok('…with the address in full, so a typo can still be caught',
      /ada@example\.com/.test(GC.recipientLine({ giftCardTo: { first: 'Ada', email: 'ada@example.com' } })),
      'the bag is the LAST place a mistyped address is visible — after this the '
      + 'only feedback is the card arriving, or not, at whatever was typed');
    ok('an ordinary line says nothing', GC.recipientLine({ title: 'Tee' }) === '');
    ok('…and neither does a card nobody was named for', GC.recipientLine({ giftCardTo: {} }) === '');

    const bag = read('bag.html');
    const checkout = read('checkout.html');
    ok('the bag reads it from the shared helper', /ZWGiftCard\.recipientLine\(item\)/.test(bag));
    ok('…and so does the checkout summary', /ZWGiftCard\.recipientLine\(item\)/.test(checkout));

    /* A gift card has no size, so this line printed "Standard / " with nothing
       after the slash. checkout.html already filtered its empty parts; the bag
       concatenated them unconditionally. */
    ok('the bag drops an empty size instead of printing a bare slash',
      /\[esc\(item\.colorName\), esc\(item\.size\)\]\.filter\(Boolean\)\.join\(' \/ '\)/.test(bag),
      'a gift card read "Standard / " with nothing after it');
  }

  console.log('\n  a gift card cannot be quick-added');

  {
    /* The panel asks colour and size. A gift card has neither, and needs two
       things it cannot ask for: an amount, and somebody to send it to. Adding
       one anyway produced a line with no face value, no chosen amount, no
       recipient and a made-up half pound of shipping weight — so the bag quoted
       a real USPS rate against a code in an email. Same class as the size
       picker inventing seven sizes for a $50 card, still reachable from the
       collection grid, the homepage grid and saved items. */
    const qa = read('quick-add-modal.js');
    ok('the panel asks whether the product is one',
      /products\?select=gift_card_cents&id=eq\./.test(qa),
      'the three grids that open this panel do not all carry the flag, and the '
      + 'saved-items path carries almost nothing');
    ok('…and sends it to the product page instead of adding it',
      /Number\(prodRows\[0\]\.gift_card_cents\) > 0\) \{[\s\S]{0,400}window\.location\.assign\(qaProductHref/.test(qa));
    ok('…checked in ONE place rather than at each grid',
      (qa.match(/gift_card_cents/g) || []).length <= 2,
      'a rule about gift cards enforced in three grids is one that will be '
      + 'enforced in two of them by whoever adds a fourth');
    ok('…using the URL the panel already builds for "Full Product Page"',
      /qaProductHref\(modalItem\)/.test(qa),
      'a second URL shape is a second thing that can drift from the first');
  }

  console.log('\n  seven phantom sizes, and the sell-out they caused');

  {
    /* THE ACTUAL CAUSE, found by asking the live API rather than reading code:
       /api/stock returned SEVEN rows for the gift card — XS, S, M, L, XL, 2XL,
       3XL, every one at zero stock.

       Hiding the Variants & Stock tab did nothing to stop them. The stock
       matrix was still in the DOM holding the seven default sizes, and the save
       read it and inserted them, on every save. Seven zeroes sum to zero, and
       zero is indistinguishable from "the last one sold" — so a live gift card
       read SOLD OUT on the collection card, and the quick-add panel drew seven
       struck-through sizes and disabled Add to Bag.

       The same trap as the hidden `required` field that killed Publish and the
       hidden member price that saved anyway: a control nobody can see is still
       a control that submits. */
    const admin = read('admin-main.js');
    ok('a gift card writes no size rows at all',
      /const stockEntries = _isGiftCardChecked\(\) \? \[\] : getStockMatrixEntries\(\);/.test(admin),
      'hiding the tab left the matrix in the DOM, and the save read it anyway');

    /* The delete runs unconditionally just above, so saving a card that already
       carries rows is also what clears them. */
    const del = admin.indexOf("from('product_sizes').delete()");
    const write = admin.indexOf('const stockEntries = _isGiftCardChecked()');
    ok('…and the existing ones are cleared by the same save',
      del > -1 && write > -1 && del < write,
      'otherwise a card already carrying seven rows keeps them forever');
  }

  {
    /* Belt and braces: rows that DO exist must not be able to matter. The whole
       product page branches on inventory.length — with rows it draws a size
       picker, computes availability for a size nobody chose, and refuses to
       add; with none it takes the "no stock data, allow adding" path, which is
       correct for something minted when somebody pays for it. */
    const pm = read('product-main.js');
    ok('the product page gives a gift card no inventory, whatever the table says',
      /function giftCardInventory\(product, rows, productId\)/.test(pm)
      && /if \(Number\(product && product\.gift_card_cents\) > 0\) return \[\];/.test(pm));
    ok('…through BOTH writers, not just the first',
      (pm.match(/giftCardInventory\(/g) || []).length === 3,
      'there is a render and a later no-store refresh — a rule applied to one '
      + 'holds until the second request lands a moment later');
  }

  {
    /* And the grids navigate rather than opening a panel that cannot ask what a
       card needs. Gated at the CLICK, because the panel's own check runs after
       its fetch resolves — which would show the broken panel for a moment. */
    const plp = read('drop001.html');
    const home = read('storefront.js');
    ok('the collection grid carries the flag on its quick-add payload',
      /giftCardCents: Number\(p\.gift_card_cents\) \|\| 0/.test(plp));
    ok('…and so does the homepage grid',
      /giftCardCents: Number\(p\.gift_card_cents\) \|\| 0/.test(home));
    ok('the collection click goes straight to the product page',
      /if \(Number\(payload\.giftCardCents\) > 0\) \{/.test(plp));
    ok('…and the homepage click rides the same branch as the mobile bypass',
      /Number\(payload\.giftCardCents\) > 0 \|\| shouldBypassQuickAddModal\(\)/.test(home),
      'one branch, so a card and a phone reach the product page the same way');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✗ suite crashed: ' + e.stack); process.exit(1); });
