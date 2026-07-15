/**
 * Minifies the root-level .js and .css files IN PLACE.
 *
 * Why in place: Cloudflare Pages serves this repository's ROOT directory (not
 * dist/) — verified by the live site serving files that aren't in the dist
 * allowlist. So the only way to ship minified assets is to shrink the root
 * files during the build. Cloudflare does a fresh checkout every deploy, so
 * this never gets committed back.
 *
 * Safety:
 *   - Runs ONLY when process.env.CF_PAGES is set (Cloudflare Pages sets it), so
 *     a local `npm install` / `npm run bump-cache` never rewrites your source.
 *     Use `--force` to write locally anyway, or `--dry-run` to preview savings.
 *   - Root level only (like bump-cache-version.js) — never recurses into
 *     functions/ (server code), scripts/, or node_modules/.
 *   - Skips *.min.js / *.min.css (already-minified vendor files).
 *   - terser top-level mangle/drop is OFF by default, so global functions called
 *     from inline HTML on* handlers (loadProducts(), etc.) are preserved.
 *   - Every file is processed in its own try/catch: a file the minifier can't
 *     handle simply ships as-is instead of failing the build.
 *
 * Wired into postinstall BEFORE bump-cache-version.js. It used to run after, so
 * the ?v= hash was taken from the readable source and this script then rewrote
 * the file — the hash identified bytes that never shipped. Since npm can run
 * postinstall more than once per build, the stamped hash came from an
 * intermediate file state that depended on build history rather than content,
 * so the same ?v= could survive a content change. With _headers serving JS as
 * `immutable, max-age=31536000`, that pins returning browsers to old code for a
 * year: a fresh curl saw the new file while real visitors kept running the old
 * one. The hash must be taken from the bytes that actually ship, so this runs
 * first and bump-cache-version.js always stamps last.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');

if (!process.env.CF_PAGES && !force && !dryRun) {
  console.log('[minify-inplace] skipped — not on Cloudflare Pages. Use --dry-run to preview or --force to write locally.');
  return;
}

let terser = null;
let CleanCSS = null;
try { terser = require('terser'); } catch (_) {}
try { CleanCSS = require('clean-css'); } catch (_) {}
if (!terser && !CleanCSS) {
  console.log('[minify-inplace] terser/clean-css not installed — shipping unminified.');
  return;
}
const cssMinifier = CleanCSS ? new CleanCSS({ level: 1, returnPromise: false }) : null;

const jsFiles = [];
const cssFiles = [];
for (const entry of fs.readdirSync(root)) {
  if (!fs.statSync(path.join(root, entry)).isFile()) continue;   // root level only
  if (/\.min\.(js|css)$/i.test(entry)) continue;                 // already minified
  if (terser && /\.js$/i.test(entry)) jsFiles.push(entry);
  else if (cssMinifier && /\.css$/i.test(entry)) cssFiles.push(entry);
}

(async function run() {
  let before = 0, after = 0, ok = 0, skipped = 0;

  for (const name of cssFiles) {
    const file = path.join(root, name);
    try {
      const src = fs.readFileSync(file, 'utf8');
      const out = cssMinifier.minify(src);
      if (out.errors && out.errors.length) { skipped++; continue; }
      if (out.styles && out.styles.length < src.length) {
        before += Buffer.byteLength(src); after += Buffer.byteLength(out.styles);
        if (!dryRun) fs.writeFileSync(file, out.styles);
        ok++;
      } else { skipped++; }
    } catch (_) { skipped++; }
  }

  await Promise.all(jsFiles.map(async (name) => {
    const file = path.join(root, name);
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
        if (!dryRun) fs.writeFileSync(file, res.code);
        ok++;
      } else { skipped++; }
    } catch (_) { skipped++; }
  }));

  const pct = before ? ((1 - after / before) * 100).toFixed(1) : '0';
  const mode = dryRun ? 'DRY-RUN — would minify' : 'minified';
  console.log(`[minify-inplace] ${mode} ${ok} files (${skipped} left as-is): ${(before/1024).toFixed(0)}KB → ${(after/1024).toFixed(0)}KB (-${pct}% pre-brotli).`);
})();
