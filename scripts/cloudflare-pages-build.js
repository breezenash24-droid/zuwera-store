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
  'admin-analytics.js',
  'admin-finance.js',
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
  'google-tag.js',
  'hero.mp4',
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

// ── Minify JS/CSS in the output only ──────────────────────────────────────────
// Source files stay readable/debuggable; we only shrink the deployed copies in
// dist/. Cache-busting still works: ?v= hashes come from source content (see
// bump-cache-version.js), and minification is deterministic, so a given source
// version always maps to the same minified bytes.
//
// Safety: terser's top-level mangling/dropping is OFF by default, so global
// functions referenced from inline HTML on* handlers (loadProducts(), etc.) are
// preserved. Every file is minified in its own try/catch — a file terser or
// clean-css can't handle simply ships as-is rather than failing the build.
async function minifyOutput() {
  let terser = null;
  let CleanCSS = null;
  try { terser = require('terser'); } catch (_) {}
  try { CleanCSS = require('clean-css'); } catch (_) {}
  if (!terser && !CleanCSS) {
    console.log('[minify] terser/clean-css not installed — shipping unminified.');
    return;
  }
  const cssMinifier = CleanCSS ? new CleanCSS({ level: 1, returnPromise: false }) : null;

  const jsFiles = [];
  const cssFiles = [];
  (function collect(dir) {
    for (const entry of fs.readdirSync(dir)) {
      const p = path.join(dir, entry);
      if (fs.statSync(p).isDirectory()) { collect(p); continue; }
      if (/\.min\.(js|css)$/i.test(entry)) continue;      // already minified (vendor)
      if (terser && /\.js$/i.test(entry)) jsFiles.push(p);
      else if (cssMinifier && /\.css$/i.test(entry)) cssFiles.push(p);
    }
  })(outDir);

  let before = 0, after = 0, ok = 0, skipped = 0;

  for (const file of cssFiles) {
    try {
      const src = fs.readFileSync(file, 'utf8');
      const out = cssMinifier.minify(src);
      if (out.errors && out.errors.length) { skipped++; continue; }
      if (out.styles && out.styles.length < src.length) {
        before += Buffer.byteLength(src); after += Buffer.byteLength(out.styles);
        fs.writeFileSync(file, out.styles); ok++;
      }
    } catch (_) { skipped++; }
  }

  await Promise.all(jsFiles.map(async (file) => {
    try {
      const src = fs.readFileSync(file, 'utf8');
      const res = await terser.minify(src, {
        ecma: 2020,
        compress: { defaults: true },  // compress.toplevel defaults false → keep globals
        mangle: true,                  // mangle.toplevel defaults false → keep global names
        format: { comments: false },
      });
      if (res && res.code && res.code.length < src.length) {
        before += Buffer.byteLength(src); after += Buffer.byteLength(res.code);
        fs.writeFileSync(file, res.code); ok++;
      } else { skipped++; }
    } catch (_) { skipped++; }
  }));

  const pct = before ? ((1 - after / before) * 100).toFixed(1) : '0';
  console.log(`[minify] ${ok} files minified, ${skipped} left as-is — ${(before/1024).toFixed(0)}KB → ${(after/1024).toFixed(0)}KB (-${pct}% pre-brotli).`);
}

minifyOutput()
  .catch((e) => console.warn('[minify] pass failed (shipping unminified):', e && e.message))
  .finally(() => {
    console.log(`Cloudflare Pages static build complete: ${path.relative(root, outDir)}`);
  });
