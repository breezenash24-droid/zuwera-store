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
/* The page plus the two script files extracted out of it — product-main.js and
   product-cart.js are classic scripts at the same position in the document, so
   every check below is asking the same question of the same code. Inline JS
   cannot carry an ETag, which is why 229KB of it moved out. */
const product = read('product.html')
  + '\n' + read('product-main.js')
  + '\n' + read('product-cart.js');
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

/* The card field straddles an origin boundary, and the two sides have opposite
   rules about colour.
 *
 *   #stripe-card-element is OUR div. Our stylesheet reaches it, so it should be
 *   themed like everything else — var(--paper), a rung off the ladder — and it
 *   then follows any theme the store is put in.
 *
 *   What Stripe mounts INSIDE it is a cross-origin iframe. It cannot see our
 *   document, our stylesheet or our custom properties. Its colours arrive as
 *   literal strings in the style object handed to elements.create(), and they
 *   have to be recomputed and pushed again whenever the theme changes, which is
 *   what the update() call on zw-theme-applied is for.
 *
 * This check used to pin the exact SPELLING of the two container rules, down to
 * `rgba(9,9,11,.36)` and the spaces around the braces. That is not the property
 * anyone cares about, and it failed the moment those rules were tokenised —
 * reporting a regression for a change that made the container theme-aware for
 * the first time. So: assert the boundary, not the characters. The literals are
 * still required where they are genuinely load-bearing, in the JS. */
const cardContainerThemed = (src) =>
  /body\.light-mode #stripe-card-element\s*\{[^}]*background:[^;}]+/.test(src)
  && /body\.light-mode #stripe-card-element\s*\{[^}]*border-color:[^;}]+/.test(src)
  /* A container whose light-mode colours are literals is pinned to one palette;
     a var() or a ladder rung follows whatever theme is applied. */
  && /body\.light-mode #stripe-card-element\s*\{[^}]*var\(--/.test(src);

check(
  'Stripe card field uses readable light-mode colors',
  /function getStripeCardStyle/.test(checkoutPage)
    /* Literal, and it must stay literal: the iframe cannot resolve var(). */
    && /text: isLight \? '#09090b'/.test(checkoutPage)
    && /fontWeight: '500'/.test(checkoutPage)
    /* …and pushed again when the theme moves, since nothing else can reach in. */
    && /cardElement\.update\(\{ style: getStripeCardStyle\(\) \}\)/.test(checkoutPage)
    && /zw-theme-applied/.test(checkoutPage)
    && /function getCheckoutCardStyle/.test(index)
    && /refreshCheckoutCardTheme/.test(index)
    && cardContainerThemed(index)
    && cardContainerThemed(bag)
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
