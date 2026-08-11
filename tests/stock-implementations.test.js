/* How many places answer "how many of this size, in this colour, are there?"
 *
 * Eight did, and they had drifted. A customer met the drift as "Only 1 left in
 * stock" on the product page followed by "is out of stock" at checkout, because
 * one matched colour case-sensitively and another did not.
 *
 * Fixing the two that collided does not stop the next pair colliding. This does:
 * it is a BUDGET, not a pass/fail on correctness. A file that starts answering
 * this question and is not on the list fails immediately, on the day it is
 * written, instead of years later in someone's bag.
 *
 * The list is allowed to shrink and never to grow. Removing an entry means the
 * file now defers to the shared rules — which is the goal — and the test makes
 * you delete the line to prove it, so the list cannot quietly describe a past
 * that stopped being true.
 *
 * The same shape produced the cropped quick-view images: two modals, one wrong
 * object-fit rule, fixed twice. "One question, many answerers" is the recurring
 * fault in this codebase, and stock is only where it cost the most.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

/* The two that are supposed to answer it. Kept in parity by
   tests/stock-parity.test.js, which runs both over one table of cases. */
const CANONICAL = [
  'stock-rules.js',                    // the browser's copy
  'functions/api/_cart-pricing.js',    // the server's, and the one that takes money
];

/* Files that still carry their own copy. Every line here is a known place the
   next drift can start. Delete lines; never add them.
   To remove one: make the file use ZWStock (browser) or import the matcher
   (worker), then drop it from this list and watch this test still pass. */
const GRANDFATHERED = [
  'product.html',                      // sizeStockForColor + canonicalizeProductSizeToken
  'drop001.html',                      // collection grid availability
  'quick-add-modal.js',                // the quick-add size buttons
  'functions/api/notify-restock.js',   // its own SIZE_ALIASES + colour normaliser
  /* Found by this test rather than by me: I had written storefront.js here from
     memory and missed the feed entirely. storefront.js reads colour and stock
     but never matches one against the other, so it is not an answerer; the
     merchant feed decides in-stock/out-of-stock per variant, so it is. The
     detector was right and the hand-written list was wrong, which is the whole
     argument for having the detector. */
  'functions/api/product-feed.js',     // availability per variant in the merchant feed
];

/* Files that hold a stock figure next to a colour without DECIDING anything
   from it. Listed by name with a reason, rather than loosened out of the rule,
   so the exemption is a claim someone can check instead of a gap in a regex. */
const NOT_ANSWERERS = {
  'functions/api/stock.js':        'the data SOURCE — it selects the rows the answerers read, and matches nothing itself',
  'functions/api/_migrations.js':  'generated: the SQL of every migration bundled verbatim, including 0007',
  'admin-main.js':                 'admin CRUD — sets per-colour stock, never reads it to decide a sale',
  'admin-returns-ui.js':           'admin CRUD — restocks a returned line, never gates a purchase',
};

const SKIP_DIRS = ['/dist/', '/node_modules/', '/.wrangler/', '/tests/', '/.git/'];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = '/' + path.relative(ROOT, full).split(path.sep).join('/') + '/';
    if (SKIP_DIRS.some((d) => rel.includes(d))) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/* The idiom, not the column. Plenty of files legitimately read or write
   stock_quantity — the catalogue selects it, admin edits it, the feed prints
   it. What makes a file an ANSWERER is deciding availability by matching a
   stock row on colour, which means all three of these together. */
/* Proximity, not mere presence. admin-main.js is half a megabyte and mentions
   both of these — it edits inventory — but it never reads a stock figure off a
   row it picked by colour, and flagging it would train everyone to ignore this
   test.

   Measured in LINES, and only after normalising line endings. The first version
   counted CHARACTERS, which made the answer depend on whether the checkout had
   CRLF or LF: the same file passed on Windows and failed on Linux, because CRLF
   made the gap wider than the window. A test whose verdict depends on git's
   autocrlf setting is worse than no test — it fails in CI for a reason nobody
   can reproduce locally, which is exactly what it did.

   Ten lines is the working distance of one function. storefront.js reads a
   stock figure and a colour name twenty-two lines apart, in unrelated code, and
   is correctly NOT an answerer. */
const WINDOW_LINES = 10;

function answersTheQuestion(src) {
  const lines = src
    .replace(/\r\n/g, '\n')                       // CRLF must not change the verdict
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    if (!/color_name/.test(lines[i])) continue;
    const near = lines.slice(Math.max(0, i - WINDOW_LINES), i + WINDOW_LINES + 1).join('\n');
    if (/stock_quantity/.test(near)) return true;
  }
  return false;
}

console.log('\n  one question, and who answers it');

const found = walk(ROOT)
  .map((f) => ({ rel: path.relative(ROOT, f).split(path.sep).join('/'), src: fs.readFileSync(f, 'utf8') }))
  .filter((f) => answersTheQuestion(f.src))
  .map((f) => f.rel);

{
  const known = new Set([...CANONICAL, ...GRANDFATHERED, ...Object.keys(NOT_ANSWERERS)]);
  const strangers = found.filter((f) => !known.has(f));
  ok('no file answers it that is not on the list', strangers.length === 0,
    strangers.length ? 'new implementation(s): ' + strangers.join(', ')
      + ' — use ZWStock (browser) or the shared matcher (worker) instead of writing another one'
      : '');

  /* Both directions. A canonical file that stopped answering means the shared
     implementation was gutted and everything now silently relies on the copies. */
  const missingCanonical = CANONICAL.filter((f) => !found.includes(f));
  ok('both canonical implementations are still there', missingCanonical.length === 0,
    missingCanonical.join(', '));

  /* Keeps the list honest. If a file was converted, this fails until the line
     is deleted — so the budget reflects the code rather than the intention. */
  const stale = GRANDFATHERED.filter((f) => !found.includes(f));
  ok('the list describes the code as it is now', stale.length === 0,
    stale.length ? 'no longer duplicates, remove from GRANDFATHERED: ' + stale.join(', ') : '');

  const budget = GRANDFATHERED.length;
  ok('the copies to be collapsed: ' + budget + ' (was 5) — this number may only go down',
    budget <= 5, String(budget));
}

/* ── The one that is not JavaScript ─────────────────────────────────────────
   decrement_stock is a Postgres function, so it cannot share the matcher and
   cannot be checked from here. It is also the code that actually TAKES stock
   off the shelf: if its matching differs from the availability check, the
   storefront says yes and the decrement takes from the wrong row. Recorded so
   the residual risk is written down somewhere that runs, rather than only in a
   commit message nobody re-reads. */
console.log('\n  the copy that cannot be tested from here');
{
  const sql = fs.existsSync(ROOT + '/supabase-decrement-stock-fix.sql');
  ok('the decrement RPC is still shipped as SQL, and still unverified against the JS', sql,
    'expected supabase-decrement-stock-fix.sql');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
