const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dist');

const files = [
  '_headers',
  '_redirects',
  '_routes.json',
  '404.html',
  'account.html',
  'admin.css',
  'admin.html',
  'admin-finance.js',
  'admin-orders.js',
  'admin-receipts.js',
  'admin-returns-ui.js',
  'admin-shipping.js',
  'admin-tax.js',
  'analytics.html',
  'apple-pay-native.js',
  'auth.js',
  'bag.html',
  'base.css',
  'builder.html',
  'cart.css',
  'cart.js',
  'checkout-tax.js',
  'checkout.html',
  'checkout.js',
  'CNAME',
  'commerce-admin.js',
  'commerce-checkout.js',
  'consent.js',
  'confirm.html',
  'customer-hub.js',
  'diagnostic.html',
  'drop001.html',
  'error-reporter.js',
  'favicon-utils.js',
  'favicon.ico',
  'flags.js',
  'google-tag.js',
  'hero.mp4',
  'image-effects.js',
  'image-utils.js',
  'index.html',
  'lang.js',
  'm-bag.html',
  'manifest.json',
  'meta-pixel.js',
  'mobile.html',
  'mobile-checkout.html',
  'mobile-menu.js',
  'modal-lock.js',
  'nav.css',
  'payment.css',
  'policies.html',
  'posthog-init.js',
  'product.css',
  'product.html',
  'products.js',
  'quick-add-modal.css',
  'quick-add-modal.js',
  'reviews-vibe.css',
  'reviews.css',
  'reviews.js',
  'returns.html',
  'robots.txt',
  'site.webmanifest',
  'sitemap.xml',
  'sizeguide.html',
  'storefront-cohesion.css',
  'storefront-mobile-rebuild.css',
  'storefront-theme.js',
  'storefront.js',
  'supabase-client.js',
  'stripe-client-config.js',
  'supabase.min.js',
];

const directories = [
  '.well-known',
  'assets',
  'images',
];

function copyPath(source, destination) {
  if (!fs.existsSync(source)) return;

  const stats = fs.statSync(source);
  if (stats.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyPath(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

fs.mkdirSync(outDir, { recursive: true });

for (const file of files) {
  copyPath(path.join(root, file), path.join(outDir, file));
}

for (const directory of directories) {
  copyPath(path.join(root, directory), path.join(outDir, directory));
}

console.log(`Cloudflare Pages static build complete: ${path.relative(root, outDir)}`);
