const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

const files = {
  index: read('index.html'),
  product: read('product.html'),
  admin: read('admin.html'),
  cohesion: read('storefront-cohesion.css'),
  checkout: read('checkout.js'),
  cart: read('cart.js'),
  auth: read('auth.js'),
  sizeguide: read('sizeguide.html'),
};

const checks = [
  {
    name: 'Mobile hamburger menu opens as full-screen overlay',
    pass: () => /#mobile-menu\s*\{[\s\S]*height:100dvh/.test(files.cohesion)
      && /\.modal:not\(#cart-modal\):not\(#mobile-menu\)/.test(files.cohesion),
  },
  {
    name: 'Homepage footer Size Guide goes to dedicated page',
    pass: () => /<a(?=[^>]*id="footer-size-guide-link")(?=[^>]*href="\/sizeguide\.html")[^>]*>Size Guide<\/a>/.test(files.index)
      && !/id="footer-size-guide-link"[^>]*openSizeGuideModal/.test(files.index),
  },
  {
    name: 'Product page Size Guide opens modal',
    pass: () => /id="sizeGuideLink"[^>]*openSizeGuideModal/.test(files.product)
      && /id="viewSizeGuideBtn"[^>]*openSizeGuideModal/.test(files.product),
  },
  {
    name: 'Cart shell and empty-bag button are wired',
    pass: () => /id="cart-modal"/.test(files.index)
      && /id="cart-btn"/.test(files.index)
      && /renderCart|cartItems|cart-count/.test(files.cart + files.index),
  },
  {
    name: 'Storefront login modal is wired to separated customer auth storage',
    pass: () => /id="auth-modal"/.test(files.index)
      && /storageKey:\s*'zuwera-auth'/.test(files.auth),
  },
  {
    name: 'Checkout payment modal and tax helper are present',
    pass: () => /id="payment-modal"/.test(files.index + files.product)
      && /ZWCheckoutTax/.test(files.checkout + read('checkout-tax.js')),
  },
  {
    name: 'Modal scroll lock helper is loaded',
    pass: () => /modal-lock\.js/.test(files.index)
      && /modal-lock\.js/.test(files.product),
  },
  {
    name: 'Dedicated size guide page supports embedded product modal mode',
    pass: () => /__ZW_SIZEGUIDE_EMBED__/.test(files.sizeguide)
      && /__ZW_SIZEGUIDE_PARAMS__/.test(files.sizeguide),
  },
  {
    name: 'Admin login uses isolated session storage',
    pass: () => /ADMIN_AUTH_STORAGE_KEY/.test(files.admin)
      && /sessionStorage/.test(files.admin)
      && /storage:\s*adminAuthStorage/.test(files.admin),
  },
  {
    name: 'Admin audit log hooks are present',
    pass: () => /admin_audit_log/.test(files.admin)
      && /logAdminAudit/.test(files.admin)
      && /id="audit"/.test(files.admin),
  },
  {
    name: 'Admin product image validation is active',
    pass: () => /validateProductImageUrls/.test(files.admin)
      && /Checking product images/.test(files.admin),
  },
];

let failed = 0;
for (const check of checks) {
  const ok = Boolean(check.pass());
  console.log(`${ok ? 'PASS' : 'FAIL'} ${check.name}`);
  if (!ok) failed += 1;
}

if (failed) {
  console.error(`\n${failed} deployment checklist item(s) failed.`);
  process.exit(1);
}

console.log('\nDeployment checklist passed.');
