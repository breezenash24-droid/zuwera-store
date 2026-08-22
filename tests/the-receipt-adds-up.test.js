/* The row labelled "Total" has to be the total.
 *
 * ── WHAT THE CUSTOMER WAS SENT ──────────────────────────────────────────────
 *
 *     Subtotal                          $234.00
 *     Shipping                             Free
 *     Tax                                 $0.00
 *     ─────────────────────────────────────────
 *     Total                             $184.00
 *
 * Fifty dollars leaves between the third line and the fourth with nothing to
 * account for it. That is a real receipt, sent by the live store.
 *
 * The cause is one line: `const totalDollars = (pi.amount / 100).toFixed(2)`.
 * pi.amount is what the CARD was charged. On an order that used a gift card
 * those are two different numbers, and the receipt printed the smaller one
 * under the larger word.
 *
 * ── WHY IT IS NOT FIXED BY ADDING A DISCOUNT ROW ────────────────────────────
 *
 * Because a gift card is not a discount, and the distinction is not pedantry —
 * it is the reason the till applies stored value AFTER tax. A discount changes
 * what the order is worth, and therefore what tax is owed on it. A gift card
 * pays a bill that is already settled at its full value. Folding $50 of gift
 * card into the discount line would shrink the taxable base by $50 of somebody
 * else's money and under-collect tax on goods really sold at full price.
 *
 * So the tender lines go BELOW the total:
 *
 *     Total                             $234.00
 *     Gift card ••••NPQR                −$50.00
 *     Charged                           $184.00
 *
 * ── AND ORDINARY ORDERS MUST NOT MOVE ───────────────────────────────────────
 *
 * The overwhelming majority of receipts have no stored value on them and were
 * always correct. A fix that reassembles the total from components is a fix
 * that can be wrong in a new way when a metadata field is missing — so it falls
 * back to the value that was printed before rather than printing a total built
 * out of pieces that do not agree with each other.
 */
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

/** Read the money out of a rendered table row, by its label. */
function rowAmount(html, label) {
  /* The label and its amount are two <td>s in one <tr>. Non-greedy across the
     row only, so a later row carrying the same word cannot be matched into. */
  const re = new RegExp('<td[^>]*>' + label + '[^<]*(?:<span[\\s\\S]*?<\\/span>)?[^<]*<\\/td>\\s*<td[^>]*>([^<]*)<\\/td>', 'i');
  const m = re.exec(html);
  return m ? m[1].trim() : null;
}

const BASE = {
  appearance: {
    text: '#fff', muted: '#999', border: '#333', accent: '#e00', bg: '#000',
    panel: '#111', light: false, fontBody: 'sans-serif', fontMono: 'monospace',
    fontHead: 'sans-serif',
  },
  content: {},
  orderId: 'ZW-TEST',
  toName: 'Nash',
  itemsHtml: '',
  addressHtml: '',
  carrierHtml: '',
  userId: null,
  orderNumber: 'ZWTEST123',
  token: '',
};

(async () => {
  const F = await import(pathToFileURL(path.join(ROOT, 'functions/api/_fulfil.js')).href);

  console.log('\n  the receipt from the screenshot, rendered\n');

  {
    /* $234 of goods, free shipping, no tax, $50 gift card, $184 to the card. */
    const html = F.buildOrderConfirmation({
      ...BASE,
      subtotalCents: 23400,
      discountRow: '',
      shippingDisplay: 'Free',
      taxCents: 0,
      totalDollars: '234.00',
      tenderRows: `
          <tr>
            <td style="color:#999;">Gift card <span style="font-family:monospace;">••••NPQR</span></td>
            <td style="text-align:right;color:#86c98e;">−$50.00</td>
          </tr>
          <tr>
            <td style="font-weight:700;">Charged</td>
            <td style="text-align:right;font-weight:700;">$184.00</td>
          </tr>`,
    });

    ok('Total is the order total', rowAmount(html, 'Total') === '$234.00',
      'got ' + rowAmount(html, 'Total'));
    ok('the gift card is a line of its own', rowAmount(html, 'Gift card') === '−$50.00',
      'got ' + rowAmount(html, 'Gift card'));
    ok('and the money that moved is named separately', rowAmount(html, 'Charged') === '$184.00',
      'got ' + rowAmount(html, 'Charged'));

    ok('the tender lines sit BELOW the total, not among the components',
      html.indexOf('Gift card') > html.indexOf('>Total<'),
      'above the line they would be reducing what the order is worth, which is what tax is charged on');

    ok('…and below tax, which they must never change',
      html.indexOf('Gift card') > html.indexOf('>Tax<'));

    /* Subtotal − discount + shipping + tax = Total, on the page, in front of
       the customer. If those four do not add up the receipt is arguing with
       itself whatever any one row says. */
    const shown = ['Subtotal', 'Tax'].map((l) => Number(String(rowAmount(html, l) || '').replace(/[^0-9.]/g, '')));
    ok('the numbers printed above the line add up to the line',
      shown[0] + shown[1] === 234.00,
      shown.join(' + ') + ' ≠ 234.00');
  }

  console.log('\n  an ordinary order is untouched');

  {
    const html = F.buildOrderConfirmation({
      ...BASE, subtotalCents: 23400, discountRow: '', shippingDisplay: 'Free',
      taxCents: 0, totalDollars: '234.00',
    });
    ok('no tender rows appear when nothing but money was used',
      !/Charged|Gift card|Store credit/.test(html));
    ok('…and Total still renders', rowAmount(html, 'Total') === '$234.00');
  }

  console.log('\n  the source of the number');

  {
    const src = fs.readFileSync(path.join(ROOT, 'functions/api/_fulfil.js'), 'utf8').replace(/\r\n/g, '\n');

    ok('the total is no longer taken from the amount charged',
      !/const totalDollars = \(pi\.amount \/ 100\)\.toFixed\(2\);/.test(src),
      'pi.amount is what the card paid, which is a different number');

    ok('…it is assembled from the rows the customer can see',
      /const partsCents = subtotalCents - discountCents \+ shippingCents \+ taxCents;/.test(src),
      'the same sum _cart-pricing.js calls totalCents');

    /* The guard. Without it, an order whose subtotal metadata went missing
       would print a total of zero-plus-shipping instead of falling back to a
       figure that was right. */
    ok('…and only when those rows reconcile with what the card was asked for',
      /const usedStoredValue = svCents > 0 && partsCents >= svCents;/.test(src)
      && /const orderTotalCents = usedStoredValue \? partsCents : pi\.amount;/.test(src),
      'a metadata gap must not turn a correct receipt into a wrong one');

    ok('the code is masked to its last four characters',
      /const maskSv = \(c\) => '••••' \+ String\(c\)\.toUpperCase\(\)\.replace\(\/\[\^A-Z0-9\]\/g, ''\)\.slice\(-4\);/.test(src),
      'receipts get forwarded, and a full code in a forwarded receipt is spendable');

    ok('…by a whitelist, so the mask cannot carry markup',
      /\[\^A-Z0-9\]/.test(src),
      'what survives is A–Z and 0–9, which is why it needs no escaping');

    ok('store credit is called store credit',
      /svKind === 'store_credit' \? 'Store credit' : 'Gift card'/.test(src),
      'somebody given credit after a return did not receive a gift card');
  }

  console.log('\n  and the kind reaches the receipt at all');

  {
    const cpi = fs.readFileSync(path.join(ROOT, 'functions/api/create-payment-intent.js'), 'utf8').replace(/\r\n/g, '\n');
    /* Two writers: the paid-in-full path, where the card covers everything and
       Stripe is never called, and the ordinary partial path. One of them
       forgetting is how the receipt ends up guessing. */
    ok('the paid-in-full path records which instrument paid',
      /meta\.stored_value_kind = storedValue\.kind \|\| '';/.test(cpi));
    ok('…and so does the partial path',
      /stored_value_kind: storedValue\.kind \|\| '',/.test(cpi));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
