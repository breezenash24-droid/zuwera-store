const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const checks = [];

function check(name, pass, detail = '') {
  checks.push({ name, pass: Boolean(pass), detail });
}

const index = read('index.html');
const bag = read('bag.html');
const product = read('product.html');
const checkout = read('commerce-checkout.js');
const account = read('account.html');
const redirects = read('_redirects');
const sw = read('sw.js');

check(
  'Desktop bag navigation uses the dedicated bag page',
  /location\.assign\('\/bag\.html'\)/.test(index) && /window\.location\.assign\('\/bag\.html'\)/.test(product)
);

check(
  'Mobile quick add bypasses modal and goes to product page',
  /shouldBypassQuickAddModal/.test(index)
    && /quickAddGoToProduct\(payload\)/.test(index)
    && /pcard-add-mobile-label">View Product/.test(index)
);

check(
  'Bag quantity minus removes item at zero',
  /if \(cart\[idx\]\.quantity <= 0\) cart\.splice\(idx, 1\)/.test(bag)
);

check(
  'Promo code UI renders a visible discount row before total',
  /discountRow\.id\s*=\s*['"]zw-promo-row['"]/.test(checkout)
    && /summary\?\.querySelector\(['"]\.stotal, \.summary-row\.total, \.total['"]\)/.test(checkout)
    && /host\.appendChild\(discountRow\)/.test(checkout)
);

check(
  'Legacy mobile routes redirect to current storefront pages',
  /\/mobile\.html\s+\/index\.html\s+301/.test(redirects)
    && /\/m-bag\.html\s+\/bag\.html\s+301/.test(redirects)
    && !/\/mobile\.html/.test(sw)
    && !/\/m-bag\.html/.test(sw)
);

check(
  'Product page no longer ships the old cart modal',
  !/id="cart-modal"/.test(product)
    && !/id="cart-close"/.test(product)
    && !/id="cart-items-list"/.test(product)
    && !/document\.getElementById\(['"]cart-modal['"]\)/.test(product)
    && !/renderProductCartItems|updateCartQuantity|removeCartItem/.test(product)
);

check(
  'Account page exposes customer order timeline',
  /function orderTimelineHtml/.test(account)
    && /Return Requested/.test(account)
    && /order-timeline/.test(account)
);

const failed = checks.filter(item => !item.pass);
for (const item of checks) {
  console.log(`${item.pass ? 'PASS' : 'FAIL'} ${item.name}`);
  if (!item.pass && item.detail) console.log(`  ${item.detail}`);
}

if (failed.length) {
  console.error(`\n${failed.length} checkout/cart smoke check(s) failed.`);
  process.exit(1);
}

console.log('\nCheckout/cart smoke checks passed.');
