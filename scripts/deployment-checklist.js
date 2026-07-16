const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

const files = {
  index: read('index.html'),
  product: read('product.html'),
  drop: read('drop001.html'),
  account: read('account.html'),
  bag: read('bag.html'),
  returns: read('returns.html'),
  notFound: read('404.html'),
  admin: read('admin.html'),
  cohesion: read('storefront-cohesion.css'),
  mobileMenu: read('mobile-menu.js'),
  storefrontTheme: read('storefront-theme.js'),
  lang: read('lang.js'),
  imageUtils: read('image-utils.js'),
  imageConfig: read('functions/api/image-config.js'),
  uploadProductImage: read('functions/api/upload-product-image.js'),
  deleteProductImages: read('functions/api/delete-product-images.js'),
  checkout: read('checkout.js'),
  cart: read('cart.js'),
  auth: read('auth.js'),
  sizeguide: read('sizeguide.html'),
};

const htmlFiles = {
  'index.html': files.index,
  'product.html': files.product,
  'drop001.html': files.drop,
  'account.html': files.account,
  'bag.html': files.bag,
  'returns.html': files.returns,
  '404.html': files.notFound,
  'sizeguide.html': files.sizeguide,
};

function hasDuplicateIds(html) {
  const seen = new Set();
  const dupes = new Set();
  for (const match of html.matchAll(/\bid=["']([^"']+)["']/g)) {
    if (seen.has(match[1])) dupes.add(match[1]);
    seen.add(match[1]);
  }
  return dupes.size > 0;
}

const checks = [
  {
    name: 'Mobile hamburger menu opens as full-screen overlay',
    pass: () => /#mobile-menu\s*\{[\s\S]*height:100dvh/.test(files.cohesion)
      && /ZUWERA technical mobile hamburger menu/.test(files.cohesion)
      && /#mobile-menu\.zw-mobile-menu/.test(files.cohesion)
      && /zw-mobile-primary-link/.test(files.index + files.product + files.drop)
      && /zw-mobile-secondary-link/.test(files.index + files.product + files.drop)
      && /zw-mobile-bag-count/.test(files.index + files.product + files.drop)
      && /#mobile-menu\.zw-mobile-menu\{[\s\S]*background:var\(--zw-ink/.test(files.cohesion)
      && /#mobile-menu\.zw-mobile-menu > \.zw-mobile-menu-panel\{[\s\S]*background:var\(--zw-ink/.test(files.cohesion)
      && /body\.light-mode #mobile-menu\.zw-mobile-menu > \.zw-mobile-menu-panel\{[\s\S]*background:var\(--zw-paper/.test(files.cohesion)
      && /#mobile-menu \.zw-mobile-menu-close\{[\s\S]*position:fixed/.test(files.cohesion)
      && /zw-mobile-menu-open/.test(files.mobileMenu)
      && /cartCount\(\)/.test(files.mobileMenu)
      && /\.modal:not\(#cart-modal\):not\(#mobile-menu\)/.test(files.cohesion)
      && /openMobileMenu/.test(files.mobileMenu)
      && /closeMobileMenu/.test(files.mobileMenu),
  },
  {
    name: 'Collection page has the same mobile menu wiring',
    pass: () => /id="mobile-menu"/.test(files.drop)
      && /id="mobile-menu-btn"/.test(files.drop)
      && /mobile-menu\.js\?v=/.test(files.drop),
  },
  {
    name: 'Customer-facing pages share the mobile hamburger menu',
    pass: () => [files.index, files.drop, files.product, files.sizeguide, files.account, files.bag, files.returns, files.notFound]
      .every(file => /id="mobile-menu"/.test(file)
        && /id="mobile-menu-btn"/.test(file)
        && /mobile-menu\.js\?v=/.test(file)),
  },
  {
    name: 'Customer-facing pages do not ship duplicate element IDs',
    pass: () => Object.values(htmlFiles).every(file => !hasDuplicateIds(file)),
  },
  {
    name: 'Homepage footer Size Guide goes to dedicated page',
    pass: () => /<a(?=[^>]*id="footer-size-guide-link")(?=[^>]*href="\/sizeguide\.html")[^>]*>Size Guide<\/a>/.test(files.index)
      && !/id="footer-size-guide-link"[^>]*openSizeGuideModal/.test(files.index),
  },
  {
    // The Typography panel's selectors live twice: admin.html's SECTION_DEFS (drives
    // the admin preview) and storefront-theme.js's SECTION_SELECTORS (the only one
    // that reaches the page). They drifted silently — 'nav' listed .nav-link in the
    // admin and not on the storefront, so styling the header categories saved a
    // setting that did nothing. Nobody could see that by reading either file alone.
    // _headers serves .js/.css as `immutable, max-age=31536000`, so a reference with
    // no ?v= can never be updated — the browser keeps its copy for a year. Seven
    // pages shipped `src="/storefront-features.js"` bare and were pinned to a build
    // old enough to still have the removed search Close button. bump-cache-version
    // now stamps unversioned refs too; this fails the build if one ever ships that
    // the stamper wouldn't catch.
    name: 'Every local js/css reference is cache-bustable (has ?v=)',
    pass: () => {
      const fs2 = require('fs');
      const root2 = path.resolve(__dirname, '..');
      const pages = fs2.readdirSync(root2).filter((f) => f.endsWith('.html'));
      return pages.every((f) => {
        const s = fs2.readFileSync(path.join(root2, f), 'utf8');
        const bare = [...s.matchAll(/(?:src|href)="(\/?[\w.-]+\.(?:js|css))"/gi)]
          .map((m) => m[1].replace(/^\//, ''))
          .filter((u) => !/^https?:/.test(u) && fs2.existsSync(path.join(root2, u)));
        return bare.length === 0;
      });
    },
  },
  {
    name: 'Typography selector maps agree (admin SECTION_DEFS === storefront SECTION_SELECTORS)',
    pass: () => {
      const store = {};
      const block = (files.storefrontTheme.match(/var SECTION_SELECTORS = \{([\s\S]*?)\};/) || [])[1];
      if (!block) return false;
      block.replace(/'([a-z-]+)':\s*'([^']*)'/g, (m, k, v) => { store[k] = v.replace(/\s+/g, ' ').trim(); return ''; });
      const admin = {};
      files.admin.replace(/id:\s*'([a-z-]+)',[^}]*?cssSel:\s*'([^']*)'/g, (m, k, v) => { admin[k] = v.replace(/\s+/g, ' ').trim(); return ''; });
      const ids = Object.keys(store);
      if (!ids.length) return false;
      return ids.every((id) => admin[id] === store[id]);
    },
  },
  {
    name: 'Product page Size Guide opens modal',
    // The Select Size row used to carry a second link to the same modal; it was
    // removed as a duplicate. The guard stands — the surviving entry point must
    // still open the modal rather than navigating away to sizeguide.html.
    pass: () => /id="viewSizeGuideBtn"[^>]*openSizeGuideModal/.test(files.product),
  },
  {
    name: 'Product controls render before media and reviews finish loading',
    pass: () => /const imagesPromise = fetch/.test(files.product)
      && /const reviewsPromise = fetch/.test(files.product)
      && /const \[colorsResp, sizesResp\] = await Promise\.all/.test(files.product)
      && /currentProduct\.images\s*=\s*ensureProductImageFallback/.test(files.product)
      && /imagesPromise\.then/.test(files.product)
      && /currentProduct\.reviews\s*=\s*\[\]/.test(files.product)
      && /reviewsPromise\.then/.test(files.product),
  },
  {
    name: 'Mobile hamburger menu has stable footer utilities',
    pass: () => /#mobile-menu\.zw-mobile-menu\.open\{[\s\S]*animation:none/.test(files.cohesion)
      && /#mobile-menu \.zw-mobile-primary-link:hover[\s\S]*padding-left:0/.test(files.cohesion)
      && /#mobile-menu\.zw-mobile-menu\{[\s\S]*width:100dvw/.test(files.cohesion)
      && /#mobile-menu\.zw-mobile-menu\{[\s\S]*overscroll-behavior:none/.test(files.cohesion)
      && /#mobile-menu\.zw-mobile-menu > \.zw-mobile-menu-panel\{[\s\S]*overflow-x:hidden/.test(files.cohesion)
      && /document\.body\.style\.position = 'fixed'/.test(files.mobileMenu)
      && /window\.scrollTo\(0, lockedScrollY/.test(files.mobileMenu)
      && /injectMobileMenuLanguageButtons/.test(files.lang)
      && /zw-mobile-lang-trigger/.test(files.lang)
      && /querySelectorAll\('footer, \.cart-shell-footer'\)/.test(files.lang)
      && /\.fright, \.zw-footer-right, \.cart-shell-footer-nav/.test(files.lang)
      && /!node\.classList\.contains\('zw-mobile-menu-footer'\)/.test(files.lang),
  },
  {
    name: 'Mobile announcement bar uses CSS safe-area positioning',
    // Accept both the literal calc() and the current --zw-bar-top var (which
    // keeps the same safe-area calc as its first-paint fallback).
    pass: () => /@media\(max-width:900px\)\{[\s\S]*#bar\{[\s\S]*top:(?:var\(--zw-bar-top,\s*)?calc\(\.75rem \+ env\(safe-area-inset-top,0px\) \+ 36px \+ \.85rem\)/.test(files.index)
      && !/bar\.style\.top\s*=\s*nav\.offsetHeight/.test(files.index)
      && !/barEl\.style\.top\s*=\s*navEl\.offsetHeight/.test(files.index)
      && !/barEl\.style\.top\s*=\s*\(navEl \? navEl\.offsetHeight/.test(files.index),
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
      && /Checking product images/.test(files.admin)
      && /900x1200/.test(files.admin),
  },
  {
    name: 'Shared image optimization and R2 storage cleanup are wired',
    pass: () => /window\.optimizeImage/.test(files.imageUtils)
      && /image-utils\.js\?v=/.test(files.index + files.product + files.drop)
      && /prepareProductImageFile/.test(files.admin)
      && /uploadProductImageToR2/.test(files.admin)
      && /removeUnusedR2ProductImages/.test(files.admin)
      && /PRODUCT_IMAGES_BUCKET/.test(files.uploadProductImage + files.deleteProductImages)
      && /R2_PUBLIC_BASE_URL/.test(files.uploadProductImage + files.deleteProductImages),
  },
  {
    name: 'Cloudinary storefront config comes from admin-managed settings',
    pass: () => /fetch\('\/api\/image-config'/.test(files.imageUtils)
      && /setCloudinaryCloudName/.test(files.imageUtils)
      && /fetchSiteSettings\(\['CLOUDINARY_CLOUD_NAME'\]/.test(files.imageConfig)
      && /resolveSetting\('CLOUDINARY_CLOUD_NAME'/.test(files.imageConfig)
      && /CLOUDINARY_CLOUD_NAME/.test(files.admin),
  },
  {
    name: 'Checkout test-mode banner is wired',
    pass: () => /data-stripe-test-banner/.test(files.index)
      && /data-stripe-test-banner/.test(files.product)
      && /__ZW_STRIPE_MODE__/.test(read('stripe-client-config.js')),
  },
  {
    name: 'Deployment version marker is present',
    pass: () => /name="zuwera-deployment"/.test(files.index)
      && /name="zuwera-deployment"/.test(files.product)
      && /name="zuwera-deployment"/.test(files.drop),
  },
  {
    name: 'Cache bump script is available',
    pass: () => /"bump-cache": "node scripts\/bump-cache-version\.js"/.test(read('package.json'))
      && fs.existsSync(path.join(root, 'scripts', 'bump-cache-version.js')),
  },
  {
    name: 'Checkout/cart smoke tests pass',
    pass: () => {
      const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'checkout-cart-smoke.js')], {
        cwd: root,
        encoding: 'utf8',
      });
      if (result.status !== 0) {
        process.stdout.write(result.stdout || '');
        process.stderr.write(result.stderr || '');
      }
      return result.status === 0;
    },
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
