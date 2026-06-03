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
const checkoutPage = read('checkout.js');
const account = read('account.html');
const cohesion = read('storefront-cohesion.css');
const redirects = read('_redirects');
let sw = '';
try { sw = read('sw.js'); } catch(e) {}

check(
  'Desktop bag navigation uses the dedicated bag page',
  /location\.assign\('\/bag\.html'\)/.test(index) && /window\.location\.assign\('\/bag\.html'\)/.test(product)
);

check(
  'Mobile product cards rely on card tap instead of a View Product button',
  /shouldBypassQuickAddModal/.test(index)
    && /quickAddGoToProduct\(payload\)/.test(index)
    && /window\.location\.href='\$\{productHref\(p\)\}'/.test(index)
    && /@media\(max-width:900px\)\{\s*\.pcard-add-btn\{display:none\}/.test(index)
    && !/pcard-add-mobile-label/.test(index)
    && !/class="pcard-add-btn"[^`]*View Product/.test(index)
);

check(
  'Mobile storefront styling reconciles to desktop base',
  /Final desktop-base mobile reconciliation/.test(cohesion)
    && /ZUWERA technical mobile hamburger menu/.test(cohesion)
    && /#mobile-menu \.zw-mobile-primary-link\{[\s\S]*font-family:var\(--zw-font-head/.test(cohesion)
    && /#mobile-menu \.zw-mobile-secondary-link/.test(cohesion)
    && /:is\(\.pgrid,\.products-grid,\.products-grid\.two-items\)\{[\s\S]*display:grid !important;[\s\S]*scroll-snap-type:none !important/.test(cohesion)
    && /:is\(\.pcard-info,\.product-info\)\{[\s\S]*padding:1\.4rem 1\.5rem !important/.test(cohesion)
);

check(
  'Bag quantity minus removes item at zero',
  /if \(item\.quantity <= 0\) cart\.splice\(idx, 1\)/.test(bag)
);

check(
  'Promo code UI renders a visible discount row before total',
  /discountRow\.id\s*=\s*['"]zw-promo-row['"]/.test(checkout)
    && /summary\?\.querySelector\(['"]\.stotal, \.summary-row\.total, \.total['"]\)/.test(checkout)
    && /host\.appendChild\(discountRow\)/.test(checkout)
);

check(
  'Stripe card field uses readable light-mode colors',
  /function getStripeCardStyle/.test(checkoutPage)
    && /text: isLight \? '#09090b'/.test(checkoutPage)
    && /fontWeight: '500'/.test(checkoutPage)
    && /cardElement\.update\(\{ style: getStripeCardStyle\(\) \}\)/.test(checkoutPage)
    && /zw-theme-applied/.test(checkoutPage)
    && /function getCheckoutCardStyle/.test(index)
    && /refreshCheckoutCardTheme/.test(index)
    && /body\.light-mode #stripe-card-element\{background:var\(--paper\);border-color:rgba\(9,9,11,.36\)\}/.test(index)
    && /body\.light-mode #stripe-card-element \{ background:#f4f1eb; border-color:rgba\(9,9,11,\.36\); \}/.test(bag)
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
