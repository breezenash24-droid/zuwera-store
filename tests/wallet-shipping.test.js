/* What the wallet sheet says, and what the card is actually charged.

   These have to be the same number. A wallet confirms against the
   PaymentIntent, not against what the sheet displayed — so if the two
   disagree, the customer is charged an amount they never agreed to and
   nothing anywhere reports a problem. That is what was happening on the main
   checkout: the sheet hardcoded "Free Shipping" at $0 while resolveShipping()
   charged the quoted rate on every order under the free-shipping threshold.

   The rule being mirrored, from resolveShipping in create-payment-intent:
     free when the PRE-discount subtotal clears the threshold,
     otherwise the quoted rate,
     falling back to the standard rate when no quote came back. */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
const R = ROOT + '/';
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const src = fs.readFileSync(R + 'checkout.js', 'utf8');

/* Load walletShipping() on its own, with the globals it closes over injected —
   the file as a whole touches the DOM at parse time and cannot be required. */
function loadWalletShipping(policy, items, rate) {
  const a = src.indexOf('function walletShipping()');
  const b = src.indexOf('function initPaymentRequest');
  return new Function('window', 'cartItems', 'selectedShippingRate',
    src.slice(a, b) + '; return walletShipping;')({ _shippingPolicy: policy }, items, rate);
}

// The server's rule, written out independently so this is a comparison rather
// than the same expression checked against itself.
function serverCents(items, rate, policy) {
  const sub = items.reduce((s, i) => s + parseFloat(i.price) * i.quantity, 0);
  if (policy.enabled && sub >= policy.threshold) return 0;
  return rate ? Math.round(parseFloat(rate.amount) * 100) : Math.round(policy.standardRate * 100);
}

console.log('\n  the sheet total matches the charge\n');
{
  const policy = { enabled: true, threshold: 100, standardRate: 8 };
  const cases = [
    ['under the threshold, a rate was quoted', [{ price: '70', quantity: 1 }], { amount: '7.45', servicelevel: 'USPS Ground Advantage' }],
    ['under the threshold, no rate came back', [{ price: '40', quantity: 1 }], null],
    ['over the threshold', [{ price: '70', quantity: 2 }], { amount: '9.10', servicelevel: 'USPS Priority' }],
    ['exactly at the threshold', [{ price: '100', quantity: 1 }], { amount: '6.00', servicelevel: 'USPS' }],
    ['several items under the threshold', [{ price: '30', quantity: 2 }], { amount: '5.25', servicelevel: 'USPS' }],
  ];
  for (const [name, items, rate] of cases) {
    const client = loadWalletShipping(policy, items, rate)().cents;
    const server = serverCents(items, rate, policy);
    ok(name, client === server, 'sheet ' + client + 'c vs server ' + server + 'c');
  }

  // Free shipping switched off entirely: nothing qualifies, everyone pays.
  const off = { enabled: false, threshold: 100, standardRate: 8 };
  const bigOrder = [{ price: '500', quantity: 1 }];
  ok('a disabled free-shipping policy still charges on a large order',
    loadWalletShipping(off, bigOrder, { amount: '12.00', servicelevel: 'UPS' })().cents === 1200);
}

console.log('\n  the label follows the amount');
{
  const policy = { enabled: true, threshold: 100, standardRate: 8 };
  const paid = loadWalletShipping(policy, [{ price: '20', quantity: 1 }], { amount: '7.45', servicelevel: 'USPS Ground Advantage' })();
  ok('a charged rate is named, not called free', paid.cents > 0 && /USPS/.test(paid.label));
  const free = loadWalletShipping(policy, [{ price: '200', quantity: 1 }], { amount: '7.45', servicelevel: 'USPS' })();
  ok('a genuinely free order says Free Shipping', free.cents === 0 && /Free/.test(free.label));
}

console.log('\n  and the sheet actually uses it');
{
  ok('the shipping option carries the real amount, not a hardcoded zero',
    /shippingOptions: \[\{[\s\S]{0,220}amount: ship\.cents/.test(src));
  ok('the total includes shipping', /amount: prSubtotalCents \+ prTaxCents \+ ship\.cents/.test(src));
  ok('changing the option keeps it included', /amount: prSubtotalCents \+ prTaxCents \+ prShipCents/.test(src));
  ok('the old hardcoded free option is gone',
    !/id: 'free', label: 'Free Shipping', detail: 'Standard delivery', amount: 0/.test(src));
  ok('…and the comment claiming shipping is always free is gone',
    !/Shipping is always free/.test(src));

  /* The three paths that were already right. If one of them regresses to a
     hardcoded zero, that is the same bug in a different place. */
  for (const f of ['product.html', 'storefront.js', 'mobile-checkout.html']) {
    const other = fs.readFileSync(R + f, 'utf8');
    ok(f + ' still computes its own shipping',
      /qualifiesFree|activeTotals\.shippingCents/.test(other));
  }
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
