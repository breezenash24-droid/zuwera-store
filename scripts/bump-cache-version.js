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

// Every .html file in the repo root. Previously this was a hardcoded list that
// silently missed pages (landing.html, journal.html, about.html) — those stayed
// pinned to stale asset hashes, so browsers kept serving cached old JS/CSS on
// them. Globbing the root means new pages are always covered.
const htmlFiles = fs
  .readdirSync(root)
  .filter((f) => f.endsWith('.html') && fs.statSync(path.join(root, f)).isFile())
  .sort();

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

// Match a local asset reference in src="" / href="", WITH OR WITHOUT an existing
// ?v=. The `?v=` used to be mandatory, which quietly created permanent staleness:
// seven pages referenced `src="/storefront-features.js"` with no query at all, so
// this never matched them, nothing ever stamped them — and _headers serves JS as
// `immutable, max-age=31536000`. Those pages pinned a year-old copy of the file
// and could never be updated: the bag and returns pages were still running a build
// old enough to have the removed search Close button. A missing ?v= must be added,
// not skipped.
//
// Anchoring on src="/href=" keeps external URLs out (https:// can't match the name
// group), and hashes[name] means only files we actually ship from root are touched.
const assetRef = /((?:src|href)=")(\/?)([\w.-]+\.(?:js|css))(?:\?v=[A-Za-z0-9_-]+)?(")/g;

let changedFiles = 0;
for (const file of htmlFiles) {
  const fp = path.join(root, file);
  if (!fs.existsSync(fp)) continue;

  const original = fs.readFileSync(fp, 'utf8');
  const updated = original.replace(assetRef, (match, attr, slash, name, close) => {
    return hashes[name] ? `${attr}${slash}${name}?v=${hashes[name]}${close}` : match;
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
