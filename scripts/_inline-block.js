/**
 * Inlining one generated block into many pages, done once.
 *
 * Some scripts cannot be a <script src>. A pre-paint block has to run before
 * the first frame, and a blocking request in <head> costs every visitor a
 * round trip to save a kilobyte — so it gets inlined into every page instead,
 * fourteen times, and fourteen hand-maintained copies is how this store ended
 * up with five different versions of the same thirty lines.
 *
 * sync-preboot.js solved that for the THEME block. This file is that solution
 * with the theme taken out of it, because there is now a second block with the
 * same problem: the header feature pre-paint, which exists inline on two pages
 * and nowhere else. Copying sync-preboot.js to make a second copy of the
 * machinery would have been the same mistake one level up.
 *
 * Everything specific to a block — its source file, its markers, which pages
 * carry it — is an argument. Nothing here knows what the code does.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Drop comments, keep code.
 *
 * The sources are heavily commented on purpose — they are the only record of
 * why these blocks are shaped the way they are. None of it should travel to a
 * shopper: this runs inline, in <head>, before the first frame, on every page.
 * Four kilobytes of explanation there is four kilobytes in front of the paint.
 *
 * String-aware, so a comment marker inside a colour or a selector survives.
 * NOT regex-literal-aware — a `/…/` in the source would be misread as a comment
 * start. The callers re-parse the result and refuse to write if it broke, which
 * is the backstop; neither source has a regex literal and neither should grow
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

/** The exact text that belongs between the markers, markers included. */
function buildBlock({ src, open, close, pointer }) {
  const code = stripComments(fs.readFileSync(src, 'utf8'));
  /* If stripping broke the code, shipping it would break every page at once.
     Better to fail the build here than to find out in a browser. */
  new Function(code);   // throws on a syntax error
  return open + '\n' + pointer + '\n' + code + '\n' + close;
}

/**
 * Write that block into every page that carries the markers.
 *
 * A page missing from the list keeps whatever stale copy it has, which is the
 * failure this exists to end — so an unmarked page is an ERROR, not a skip.
 */
function syncBlock({ src, open, close, pointer, pages, label, quiet }) {
  const want = buildBlock({ src, open, close, pointer });
  const changed = [];
  const missing = [];

  for (const page of pages) {
    const file = path.join(ROOT, page);
    let html;
    try { html = fs.readFileSync(file, 'utf8'); } catch (_) { missing.push(page + ' (unreadable)'); continue; }

    const a = html.indexOf(open);
    const b = html.indexOf(close);
    if (a < 0 || b < a) { missing.push(page + ' (no ' + label + ' markers)'); continue; }
    /* One region per page. Two would mean two answers again, which is the
       entire thing being prevented here. */
    if (html.indexOf(open, a + 1) >= 0) { missing.push(page + ' (duplicate markers)'); continue; }

    /* Match the page's own line endings.
       The source files are LF; a page that has been through `git checkout` on
       Windows comes back CRLF. Writing LF into it changed every byte of the
       region, so this reported ten pages "updated" on every run and the drift
       test could fail for a reason that has nothing to do with the code. Git
       normalises to LF in the blob either way, so this only ever mattered
       locally — which is exactly where a spurious failure wastes the most
       time. */
    const crlf = (html.match(/\r\n/g) || []).length > (html.split('\n').length / 2);
    const shaped = crlf ? want.replace(/\r?\n/g, '\r\n') : want.replace(/\r\n/g, '\n');

    const next = html.slice(0, a) + shaped + html.slice(b + close.length);
    if (next !== html) { fs.writeFileSync(file, next); changed.push(page); }
  }

  if (missing.length) {
    console.error('[' + label + '] cannot sync: ' + missing.join(', '));
    return { changed, missing };
  }
  if (!quiet) {
    console.log('[' + label + '] ' + pages.length + ' page(s) in sync'
      + (changed.length ? '; updated ' + changed.join(', ') : '; no changes'));
  }
  return { changed, missing };
}

module.exports = { ROOT, stripComments, buildBlock, syncBlock };
