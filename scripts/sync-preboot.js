/**
 * Inline scripts/theme-preboot.head.js into every storefront page's <head>.
 *
 * The pre-paint theme block cannot be a <script src> — it has to run before the
 * first frame, and a blocking request in <head> costs every visitor a round trip
 * to save a kilobyte. So it is inlined, fourteen times.
 *
 * Fourteen hand-maintained copies is how the store ended up with five different
 * versions of the same thirty lines, one of which painted a white background
 * without the class that makes the text dark. This script is what makes the
 * copies copies: one source, mechanically stamped, with
 * tests/theme-preboot.test.js failing the build on any drift.
 *
 * Runs in postinstall BEFORE minify and cache-hashing, and unlike
 * stamp-theme-default.js it runs LOCALLY too — the inlined result is committed,
 * so what is in the repo is what ships and a reviewer can read it.
 *
 * Idempotent. Re-running writes the same bytes.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(__dirname, 'theme-preboot.head.js');

/* Every page that paints a theme before its stylesheets load. A page missing
   from this list keeps whatever stale copy it has, which is the failure mode
   this file exists to end — so an unmarked page is an ERROR, not a skip. */
const PAGES = ['404.html', 'about.html', 'account.html', 'bag.html', 'checkout.html',
  'confirm.html', 'drop001.html', 'index.html', 'journal.html', 'landing.html',
  'policies.html', 'product.html', 'returns.html', 'sizeguide.html'];

const OPEN = '/* zw:preboot */';
const CLOSE = '/* /zw:preboot */';

const POINTER = '/* Generated from scripts/theme-preboot.head.js — edit there, not here.\n'
  + '   The reasoning lives in that file; it is stripped on the way in because this\n'
  + '   block is inline on the render-blocking path of fourteen pages. */';

/**
 * Drop comments, keep code.
 *
 * The source is heavily commented on purpose — it is the only record of why the
 * pre-paint block is shaped the way it is. None of that should travel to a
 * shopper: this runs inline, in <head>, before the first frame, on every page.
 * Four kilobytes of explanation there is four kilobytes in front of the paint.
 *
 * String-aware, so a comment marker inside a colour or a selector survives.
 * NOT regex-literal-aware — a `/…/` literal in the source would be misread as a
 * comment start. sync() re-parses the result and refuses to write if it broke,
 * which is the backstop; the source has no regex literals and should not grow
 * one.
 */
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      out += c; i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i];
        if (src[i] === c) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
      continue;
    }
    out += c; i++;
  }
  return out
    .split('\n').map((l) => l.replace(/\s+$/, ''))
    .join('\n').replace(/\n{2,}/g, '\n').replace(/^\n+|\n+$/g, '');
}

/** The exact block that belongs between the markers, markers included. */
function block() {
  const code = stripComments(fs.readFileSync(SRC, 'utf8'));
  /* If stripping broke the code, shipping it would break every page at once.
     Better to fail the build here than to find out in a browser. */
  new Function(code);   // throws on a syntax error
  return OPEN + '\n' + POINTER + '\n' + code + '\n' + CLOSE;
}

function sync({ quiet } = {}) {
  const want = block();
  const changed = [];
  const missing = [];

  for (const page of PAGES) {
    const file = path.join(ROOT, page);
    let html;
    try { html = fs.readFileSync(file, 'utf8'); } catch (_) { missing.push(page + ' (unreadable)'); continue; }

    const a = html.indexOf(OPEN);
    const b = html.indexOf(CLOSE);
    if (a < 0 || b < a) { missing.push(page + ' (no zw:preboot markers)'); continue; }
    /* One region per page. Two would mean two answers again, which is the
       entire thing being prevented here. */
    if (html.indexOf(OPEN, a + 1) >= 0) { missing.push(page + ' (duplicate markers)'); continue; }

    /* Match the page's own line endings.
       The source file is LF; a page that has been through `git checkout` on
       Windows comes back CRLF. Writing LF into it changed every byte of the
       region, so this reported ten pages "updated" on every run and the drift
       test could fail for a reason that has nothing to do with the code. Git
       normalises to LF in the blob either way, so this only ever mattered
       locally — which is exactly where a spurious failure wastes the most
       time. */
    const crlf = (html.match(/\r\n/g) || []).length > (html.split('\n').length / 2);
    const shaped = crlf ? want.replace(/\r?\n/g, '\r\n') : want.replace(/\r\n/g, '\n');

    const next = html.slice(0, a) + shaped + html.slice(b + CLOSE.length);
    if (next !== html) { fs.writeFileSync(file, next); changed.push(page); }
  }

  if (missing.length) {
    console.error('[sync-preboot] cannot sync: ' + missing.join(', '));
    return { changed, missing };
  }
  if (!quiet) {
    console.log('[sync-preboot] ' + PAGES.length + ' page(s) in sync'
      + (changed.length ? '; updated ' + changed.join(', ') : '; no changes'));
  }
  return { changed, missing };
}

module.exports = { sync, block, PAGES, OPEN, CLOSE, SRC };

if (require.main === module) {
  const { missing } = sync();
  process.exit(missing.length ? 1 : 0);
}
