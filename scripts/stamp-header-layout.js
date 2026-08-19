/**
 * Bake the store's header arrangement onto <html> at build time.
 *
 * Why: the pre-paint block in <head> can only read what a visitor's browser
 * already has. Every first-ever visitor, every incognito window and everyone
 * who cleared their browser has nothing — so the header painted in whatever
 * arrangement the MARKUP is in (logo left, categories centred) and jumped to
 * the real one once header-layouts.js had loaded and asked the server. On a
 * store whose logo is centred, that is every new visitor's first impression.
 *
 * A cache cannot fix the case whose whole problem is that there is no cache.
 * So the answer is the one stamp-theme-default.js already uses for colours:
 * put the live answer into what ships, and the first frame is right with no
 * JavaScript, no localStorage and no network.
 *
 * The header is the easiest thing in the store to bake, because its
 * arrangement IS four attributes on <html> — storefront-cohesion.css does the
 * rest with `order` and one auto margin. There is no markup to generate and no
 * stylesheet to synthesise; the build writes exactly what theme-engine.js
 * would have written later.
 *
 * ── THE LAYOUT TABLE IS READ, NOT RESTATED ──────────────────────────────────
 *
 * Resolving "logo-center" to its four values is done by loading
 * header-layouts.js and asking it, not by keeping a copy of the table here. A
 * second copy is how the tile in the picker and the arrangement on the page
 * would start disagreeing — which is the exact fault this feature already had
 * once, in a different form.
 *
 * ── FRESHNESS, STATED RATHER THAN ASSUMED ───────────────────────────────────
 *
 * The stamp is only as new as the last deploy. A visitor whose browser cached a
 * NEWER arrangement should keep it, and one whose cache is older should not
 * drag the page back. So the row's updated_at is stamped alongside, and the
 * pre-paint block compares the two rather than guessing which source is more
 * likely to be right. Without that, publishing without deploying and deploying
 * without publishing break in opposite directions and neither is detectable
 * from inside the browser.
 *
 * Runs on the Cloudflare build only (CF_PAGES), before minify and cache
 * hashing. Locally it would rewrite committed HTML on every `npm install` and
 * create churn; pass --local to run it by hand.
 *
 * IT MUST NEVER BREAK THE BUILD. No network, bad JSON, an unknown layout id,
 * an unexpected <html> — the HTML is left exactly as committed and the old
 * behaviour (a corrected flash) is what ships.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* The same pages that carry the pre-paint block. A page left out is the same
   flash on one URL, which is how "some pages centred, some not" would start. */
const PAGES = ['404.html', 'about.html', 'account.html', 'bag.html', 'checkout.html',
  'confirm.html', 'drop001.html', 'index.html', 'journal.html', 'landing.html',
  'policies.html', 'product.html', 'returns.html', 'sizeguide.html'];

/* Only attributes this script wrote are ever removed, so anything hand-authored
   on <html> survives and re-running cannot compound. */
const OURS = ['data-zw-hdr', 'data-zw-hdr-logo', 'data-zw-hdr-links',
  'data-zw-hdr-actions', 'data-zw-hdr-linksrow', 'data-zw-hdr-at',
  'data-zw-hdr-lines'];

/* The canonical project, read rather than restated — stamping the ORIGINAL
   store's header onto a white-label build is the bug zw-config.js exists to
   prevent. */
const CANON = require(path.join(ROOT, 'zw-config.js'));
const PROJECT = (process.env.ZW_SUPABASE_URL || process.env.SUPABASE_URL || CANON.supabaseUrl).replace(/\/$/, '');
const ANON = process.env.ZW_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || CANON.supabaseAnonKey;

function fetchLayout() {
  return new Promise((resolve) => {
    if (!PROJECT || !ANON) return resolve(null);
    const url = PROJECT + '/rest/v1/site_settings?select=value,updated_at&key=eq.header_layout';
    https.get(url, { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const rows = JSON.parse(body);
          const row = rows && rows[0];
          if (!row) return resolve(null);
          let raw = row.value;
          if (typeof raw === 'string') raw = JSON.parse(raw);
          const id = raw && typeof raw === 'object' ? raw.id : raw;
          const lines = raw && typeof raw === 'object' ? String(raw.lines || '') : '';
          const at = String(row.updated_at || '');
          /* Either answer alone is worth baking: a store can turn the rule off
             without ever choosing an arrangement. */
          resolve(id || lines ? { id: id ? String(id) : '', at: at, lines: lines } : null);
        } catch (_) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

/* header-layouts.js is a browser file: an IIFE that hangs its table on `window`
   and then boots the storefront half. Given a document with no header, that
   half returns immediately — which is the same path the builder takes when it
   loads this file purely for its definitions. */
function loadLayouts() {
  const src = fs.readFileSync(path.join(ROOT, 'header-layouts.js'), 'utf8');
  const box = {
    document: {
      readyState: 'complete',
      querySelector: () => null,
      addEventListener: () => {},
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
      head: { appendChild() {} },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: () => Promise.resolve({ ok: false }),
    setTimeout, clearTimeout, console,
  };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(src, box);
  return box.ZWHeaderLayouts;
}

/* Exported so a test can prove the load above still works. It is the part most
   likely to rot silently: header-layouts.js is browser code, and the day it
   touches a DOM API the stub here does not have, this script starts reporting
   "layout table unavailable", stamps nothing, and pre-paint quietly goes back
   to being broken — on the deploy only, where nobody is watching the log. */
module.exports = { loadLayouts, PAGES, OURS };

if (require.main !== module) return;
if (!process.env.CF_PAGES && !process.argv.includes('--local')) process.exit(0);

(async () => {
  try {
    const L = loadLayouts();
    if (!L || !Array.isArray(L.list)) {
      console.log('[stamp-header-layout] layout table unavailable — <html> left as committed.');
      return;
    }

    const chosen = await fetchLayout();
    /* No row, or an id no layout answers to, means the store has not chosen an
       arrangement — which is a real answer, not a missing one. The attributes
       are stripped so the pages go back to the header they ship with, rather
       than keeping whatever the previous build baked in forever. */
    const layout = chosen && chosen.id ? L.byId(chosen.id) : null;
    const lines = chosen && (chosen.lines === 'on' || chosen.lines === 'off') ? chosen.lines : '';
    if (chosen && chosen.id && !layout) {
      console.log('[stamp-header-layout] unknown layout "' + chosen.id + '" — placement cleared.');
    }
    const spec = layout ? layout.spec : null;

    let changed = 0;
    for (const page of PAGES) {
      const file = path.join(ROOT, page);
      let html;
      try { html = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
      if (!/<html\b[^>]*>/i.test(html)) {
        console.log('[stamp-header-layout] no <html> in ' + page + ' — skipped.');
        continue;
      }

      const next = html.replace(/<html\b([^>]*)>/i, (tag, a) => {
        let keep = String(a);
        for (const attr of OURS) {
          keep = keep.replace(new RegExp('\\s*' + attr + '="[^"]*"', 'i'), '');
        }
        if (spec) {
          keep += ' data-zw-hdr="1"';
          keep += ' data-zw-hdr-logo="' + spec.logo + '"';
          keep += ' data-zw-hdr-links="' + spec.links + '"';
          keep += ' data-zw-hdr-actions="' + spec.actions + '"';
          keep += ' data-zw-hdr-linksrow="' + (String(spec.linksRow) === '2' ? '2' : '1') + '"';
          /* Not decoration: this is what lets the pre-paint block decide
             between a baked answer and a cached one without guessing. */
          keep += ' data-zw-hdr-at="' + chosen.at + '"';
        }
        if (lines) keep += ' data-zw-hdr-lines="' + lines + '"';
        return '<html' + keep + '>';
      });

      // Never write something that would corrupt the page.
      if ((next.match(/<html\b/gi) || []).length !== (html.match(/<html\b/gi) || []).length) {
        console.log('[stamp-header-layout] html count changed in ' + page + ' — skipped.');
        continue;
      }
      if (next !== html) { fs.writeFileSync(file, next); changed++; }
    }

    console.log('[stamp-header-layout] '
      + (layout ? 'arrangement "' + layout.id + '" (' + spec.logo + '/' + spec.links + '/' + spec.actions
          + ', row ' + spec.linksRow + ')' : 'no arrangement')
      + (lines ? ', divider lines ' + lines : '')
      + ' baked; ' + changed + ' page(s) updated.');
  } catch (e) {
    console.log('[stamp-header-layout] skipped (' + (e && e.message) + ') — <html> unchanged.');
  }
})();
