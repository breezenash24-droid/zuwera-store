const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dist');

const files = [
  '_headers',
  '_redirects',
  '_routes.json',
  '404.html',
  'admin.html',
  'analytics.html',
  'apple-pay-native.js',
  'auth.js',
  'base.css',
  'cart.css',
  'cart.js',
  'checkout-tax.js',
  'checkout.js',
  'CNAME',
  'confirm.html',
  'drop001.html',
  'hero.mp4',
  'index.html',
  'lang.js',
  'layout.css',
  'manifest.json',
  'mobile-checkout.html',
  'mobile-menu.js',
  'modal-lock.js',
  'nav.css',
  'payment.css',
  'policies.html',
  'product.css',
  'product.html',
  'products.js',
  'reviews-vibe.css',
  'reviews.css',
  'reviews.js',
  'robots.txt',
  'sitemap.xml',
  'sizeguide.html',
  'stripe-client-config.js',
  'storefront-cohesion.css',
  'supabase.min.js',
  'sw.js',
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
