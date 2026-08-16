/* Where the product page's code lives.
 *
 * It used to be one file. product.html carried 240KB of inline <script> — 229KB
 * of it in two blocks — and every test that wanted to ask "does the product page
 * do X?" read product.html and grepped it, which was the same thing.
 *
 * That stopped being true when the two blocks were extracted to product-main.js
 * and product-cart.js. Nothing about the page CHANGED: they are classic scripts
 * at the same position in the document, so execution order and top-level scope
 * are identical, and the only difference is that a browser can now cache them.
 * But thirteen suites went red at once, all of them asking a question that was
 * still true of the page and no longer true of the file.
 *
 * So the question moves here instead of into thirteen copies of a path list.
 * Ask for what you actually mean:
 *
 *   html()  the markup. Tags, attributes, the <script src> references
 *           themselves — things that are about the DOCUMENT.
 *   code()  the JavaScript, from wherever it is served: the blocks still inline
 *           (theme pre-paint, first-paint auth) plus the extracted files.
 *   all()   both, which is what a grep for "does this page do X" wants and what
 *           readFileSync('product.html') used to be.
 *
 * The next extraction is then one line here rather than another red suite.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* Extracted from product.html, in the order the document loads them. Order
   matters for anything reading positions rather than presence — these are
   classic scripts and the page depends on them running in sequence. */
const EXTRACTED = ['product-main.js', 'product-cart.js'];

function read(f) {
  return fs.readFileSync(path.join(ROOT, f), 'utf8');
}

function html() {
  return read('product.html');
}

function code() {
  /* Inline first, then the extracted files, which is document order: the
     pre-paint and first-paint blocks precede both <script src> tags. A test
     asserting that one thing happens before another gets the right answer. */
  const page = html();
  const inline = [...page.matchAll(/<script\b(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]);
  return inline.concat(EXTRACTED.map(read)).join('\n');
}

function all() {
  return html() + '\n' + EXTRACTED.map(read).join('\n');
}

/** The files a "which file implements this?" census should name. */
function files() {
  return ['product.html'].concat(EXTRACTED);
}

module.exports = { html, code, all, files, EXTRACTED, ROOT };
