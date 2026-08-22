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
      /window\.ZWGiftCard && window\.ZWGiftCard\.is\(product\)/.test(plp)
      && /\? null/.test(plp.slice(plp.indexOf('totalStock:'), plp.indexOf('totalStock:') + 600)),
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

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✗ suite crashed: ' + e.stack); process.exit(1); });
