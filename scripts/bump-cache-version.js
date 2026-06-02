/**
 * Asset version stamper — run automatically via `npm install` (postinstall).
 * Computes a content-hash for every .js and .css file in the repo root,
 * then rewrites every `filename.js?v=xxx` / `filename.css?v=xxx` reference
 * in all HTML files to use the new hash.
 *
 * Because the hash is derived from the file's content, the URL only changes
 * when the file changes — so browsers and CDNs cache assets for up to a year
 * and only fetch a new copy when something actually changed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');

const htmlFiles = [
  '404.html',
  'account.html',
  'admin.html',
  'analytics.html',
  'bag.html',
  'confirm.html',
  'drop001.html',
  'index.html',
  'mobile-checkout.html',
  'policies.html',
  'product.html',
  'returns.html',
  'sizeguide.html',
];

function contentHash(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
  } catch (_) {
    return null;
  }
}

// Build filename → 8-char hash map for every .js and .css in repo root.
const hashes = {};
for (const entry of fs.readdirSync(root)) {
  if (/\.(js|css)$/.test(entry) && fs.statSync(path.join(root, entry)).isFile()) {
    const h = contentHash(path.join(root, entry));
    if (h) hashes[entry] = h;
  }
}

// Match any `filename.js?v=anything` or `filename.css?v=anything` reference.
const assetRef = /([\w.-]+\.(?:js|css))\?v=[A-Za-z0-9_-]+/g;

let changedFiles = 0;
for (const file of htmlFiles) {
  const fp = path.join(root, file);
  if (!fs.existsSync(fp)) continue;

  const original = fs.readFileSync(fp, 'utf8');
  const updated = original.replace(assetRef, (match, name) => {
    return hashes[name] ? `${name}?v=${hashes[name]}` : match;
  });

  if (updated !== original) {
    fs.writeFileSync(fp, updated);
    changedFiles++;
    console.log(`  updated: ${file}`);
  }
}

const summary = Object.entries(hashes)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([f, h]) => `  ${h}  ${f}`)
  .join('\n');

console.log(`\n[asset-versions] ${changedFiles} HTML file(s) updated.\n${summary}\n`);
