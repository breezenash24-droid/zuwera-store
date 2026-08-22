/* A gift card generates two emails, and the second one has a rule.
 *
 * ── WHAT WAS MISSING ────────────────────────────────────────────────────────
 *
 * The codes rode on the order confirmation and nowhere else. That is fine as a
 * record and poor as a gift: the receipt cannot be forwarded to the person the
 * card is FOR without also forwarding what was paid and where it ships to, and
 * six months later it is findable only by remembering which order it was on.
 *
 * ── AND THE RULE ────────────────────────────────────────────────────────────
 *
 * "Tell me when the card I bought gets used" is a reasonable thing to want and
 * an unreasonable thing to send unconditionally, because most gift cards are
 * bought by the person who then spends them. Emailing somebody about their own
 * purchase — seconds after the receipt that already carries the gift-card line
 * — is the kind of noise that teaches people to ignore an address.
 *
 * So it is sent only when the spender is NOT the purchaser, which takes two
 * reads: the card carries source_ref = 'order:X' from when it was issued, and
 * that order carries an email.
 *
 * ── AND WHAT IT MUST NEVER SAY ──────────────────────────────────────────────
 *
 * Not what was bought. Not where it shipped. A gift card is frequently given to
 * somebody whose shopping is not the buyer's business, and an email reporting it
 * would turn a present into a tracking device. Two numbers: how much came off,
 * how much is left.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const A = {
  text: '#fff', muted: '#999', border: '#333', accent: '#e00', bg: '#000', panel: '#111',
  light: false, brand: 'Zuwera',
  fontBody: 'sans-serif', fontMono: 'monospace', fontHead: 'sans-serif',
};

(async () => {
  const G = await import(pathToFileURL(path.join(ROOT, 'functions/api/_gift-card-emails.js')).href);
  const T = await import(pathToFileURL(path.join(ROOT, 'functions/api/_email-theme.js')).href);

  const content = (type) => T.getEmailContent({}, type, null);

  console.log('\n  the card’s own email\n');

  {
    const html = G.buildGiftCardDelivered({
      appearance: A, content: content('gift_card_delivered'), toName: 'Alex',
      cards: [{ code: 'ZW-4KTM-8PQR-C7WJ-2NHD', cents: 5000 }],
      shopUrl: 'https://zuwera.store',
    });

    /* The one thing it MUST carry. An email about a gift card that hides the
       number is a locked box with no key. */
    ok('it carries the full code', html.includes('ZW-4KTM-8PQR-C7WJ-2NHD'));
    ok('…and what the card is worth', html.includes('$50.00'));
    ok('…and says the code is the card, in as many words',
      /the code IS the card/i.test(html),
      'somebody who has never been sent one has no reason to guess that forwarding it gives it away');

    ok('one card does not get a “1 card · $50.00” total line',
      !/1 cards? ·/.test(html),
      'a total under a box that already shows the same number is a line that exists to be ignored');
  }

  {
    const html = G.buildGiftCardDelivered({
      appearance: A, content: content('gift_card_delivered'), toName: 'Alex',
      cards: [{ code: 'ZW-AAAA-BBBB-CCCC-DDDD', cents: 5000 }, { code: 'ZW-EEEE-FFFF-GGGG-HHHH', cents: 2500 }],
    });
    ok('two cards each get their own code', html.includes('ZW-AAAA-BBBB-CCCC-DDDD') && html.includes('ZW-EEEE-FFFF-GGGG-HHHH'));
    ok('…and a total that adds them up', /2 cards · \$75\.00/.test(html));
  }

  console.log('\n  the email to whoever bought it');

  {
    const html = G.buildGiftCardSpent({
      appearance: A, content: content('gift_card_spent'), toName: 'Alex',
      code: 'ZW-4KTM-8PQR-C7WJ-2NHD', spentCents: 3200, remainingCents: 1800,
    });

    ok('the code is masked', html.includes('••••2NHD'));
    ok('…and the full code never appears',
      !html.includes('ZW-4KTM-8PQR-C7WJ-2NHD'),
      'this goes to somebody who may have given the card away — a full code here hands it back');

    ok('it says how much came off', html.includes('−$32.00') || html.includes('$32.00'));
    ok('…and how much is left', html.includes('$18.00'));

    /* The privacy property, asserted as an absence. */
    const LEAKS = ['Ships to', 'SKU', 'Aero Pro', 'tracking', 'Tracking'];
    ok('it says nothing about what was bought or where it went',
      LEAKS.every((w) => !html.includes(w)),
      'a gift card is often given to somebody whose shopping is not the buyer’s business');
  }

  {
    const html = G.buildGiftCardSpent({
      appearance: A, content: content('gift_card_spent'), toName: 'Alex',
      code: 'ZW-4KTM-8PQR-C7WJ-2NHD', spentCents: 5000, remainingCents: 0,
    });
    ok('an emptied card says so, rather than showing $0.00 and stopping',
      /now empty/i.test(html),
      '"$0.00 left" is a number; "nothing else will come off it" is an answer');
  }

  console.log('\n  and the rule about when the second one is sent');

  {
    const F = read('functions/api/_fulfil.js');

    ok('the purchaser is found through the card’s origin order',
      /if \(!sourceRef\.startsWith\('order:'\)\) return null;/.test(F),
      'a card issued by hand from the Coupons page has no purchaser to tell');

    ok('…and nothing is sent when the spender IS the purchaser',
      /if \(buyerEmail\.toLowerCase\(\) === spenderEmail\.toLowerCase\(\)\) return null;/.test(F),
      'they are holding the receipt that already carries the gift-card line');

    ok('the remaining balance is read after the capture, not before',
      F.indexOf('await captureStoredValue') < F.indexOf('await lookupStoredValue'),
      'read first and it reports the balance the card had before this order');

    ok('both emails are on the non-fatal path',
      /sendGiftCardDeliveredEmail\(meta, env, emailKeyCache, giftCardCodes\),/.test(F)
      && /sendGiftCardSpentNotice\(meta, env, emailKeyCache\),/.test(F)
      && /giftDeliveredResult\.status === 'rejected'/.test(F),
      'the card has been paid for; an email provider outage must not fail the order');
  }

  console.log('\n  they are editable and previewable like every other email');

  {
    const html = read('admin.html');
    const admin = read('admin-main.js');
    const theme = read('functions/api/_email-theme.js');
    const preview = read('functions/api/email-preview.js');

    for (const type of ['gift_card_delivered', 'gift_card_spent']) {
      ok('  ' + type + ' — has built-in wording to fall back to',
        new RegExp(type + ':\\s*\\{ subject:').test(theme));
      ok('  ' + type + ' — is in the copy editor',
        new RegExp('<option value="' + type + '">').test(html));
      ok('  ' + type + ' — has warm / minimal / playful presets',
        new RegExp(type + ': \\{[\\s\\S]{0,80}?warm:[\\s\\S]{0,900}?minimal:[\\s\\S]{0,900}?playful:').test(admin));
      ok('  ' + type + ' — renders in the preview pane',
        new RegExp("case '" + type + "':").test(preview)
        && new RegExp("'" + type + "'").test(preview));
    }

    /* Two lists that have to stay in step: the copy editor lets you write
       wording for a type, and the preview pane is the only way to see it. A
       type in one and not the other is copy you can edit and never look at, or
       a preview of wording you cannot change. */
    const opts = (id) => {
      const start = html.indexOf('id="' + id + '"');
      const block = html.slice(start, html.indexOf('</select>', start));
      return [...block.matchAll(/<option value="([a-z_]+)"/g)].map((m) => m[1]);
    };
    const editable = opts('em-type');
    const previewable = opts('em-preview-type');
    const missing = editable.filter((t) => !previewable.includes(t));
    ok('every editable email can be previewed',
      missing.length === 0,
      'editable with no preview: ' + missing.join(', '));

    /* Every previewable type must actually be listed as previewable on the
       server, or the pane renders the "no preview available" placeholder. */
    const declared = preview.slice(preview.indexOf('PREVIEWABLE_TYPES = ['), preview.indexOf('];', preview.indexOf('PREVIEWABLE_TYPES = [')));
    const undeclared = previewable.filter((t) => !declared.includes("'" + t + "'"));
    ok('…and the server agrees it can',
      undeclared.length === 0,
      'offered in the picker but not in PREVIEWABLE_TYPES: ' + undeclared.join(', '));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✗ suite crashed: ' + e.stack); process.exit(1); });
