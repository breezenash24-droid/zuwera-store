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
  'data-zw-hdr-lines', 'data-zw-iconlabels', 'data-zw-account'];

/* data-zw-account is on <body>, because the rule it answers is written against
   body.zwf-bagpanel-on. stamp-theme-default.js bakes it there from the store's
   default theme; this runs AFTER that (see the postinstall order) and the
   header modal's answer outranks the theme's, so writing it here is what makes
   the modal's choice the one that ships. */
const OURS_BODY = ['data-zw-account'];

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
          const o = raw && typeof raw === 'object' ? raw : {};
          const id = raw && typeof raw === 'object' ? raw.id : raw;
          const at = String(row.updated_at || '');
          const pick = (k, allowed) => (allowed.indexOf(String(o[k] || '')) > -1 ? String(o[k]) : '');
          /* Any one answer alone is worth baking: a store can turn the rule off,
             move the account, or ask for words without ever choosing an
             arrangement. */
          const chosen = {
            id: id ? String(id) : '',
            at: at,
            lines: pick('lines', ['on', 'off']),
            account: pick('account', ['bag', 'header']),
            iconLabels: pick('iconLabels', ['icons', 'mobile', 'always']),
          };
          const any = chosen.id || chosen.lines || chosen.account || chosen.iconLabels;
          resolve(any ? chosen : null);
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
    const lines = (chosen && chosen.lines) || '';
    const account = (chosen && chosen.account) || '';
    const labels = (chosen && chosen.iconLabels) || '';
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
        /* 'icons' is an answer meaning "no words", and the way to bake it is to
           leave the attribute off — which stripping OURS above has already
           done. Only the two scopes the stylesheet knows get written. */
        if (labels === 'mobile' || labels === 'always') keep += ' data-zw-iconlabels="' + labels + '"';
        /* On <html> as well as <body>. The stylesheet reads it from either,
           because the pre-paint block in <head> can only write this one — and
           it is the only writer early enough to beat the header's first paint.
           Both are written so the served document cannot contradict itself. */
        if (account) keep += ' data-zw-account="' + account + '"';
        return '<html' + keep + '>';
      });

      /* <body>, for the one attribute that lives there. Same shape: strip what
         this script wrote, then write the answer — and 'bag' bakes as the
         attribute's ABSENCE, which the strip has already produced. Note this
         overwrites what stamp-theme-default.js baked from the theme, on
         purpose: the header modal outranks the theme, and it runs after. */
      let next2 = next;
      if (account) {
        next2 = next.replace(/<body\b([^>]*)>/i, (tag, a) => {
          let keep = String(a);
          for (const attr of OURS_BODY) {
            keep = keep.replace(new RegExp('\\s*' + attr + '="[^"]*"', 'i'), '');
          }
          if (account === 'header') keep += ' data-zw-account="header"';
          return '<body' + keep + '>';
        });
      }

      // Never write something that would corrupt the page.
      if ((next2.match(/<html\b/gi) || []).length !== (html.match(/<html\b/gi) || []).length
        || (next2.match(/<body\b/gi) || []).length !== (html.match(/<body\b/gi) || []).length) {
        console.log('[stamp-header-layout] tag count changed in ' + page + ' — skipped.');
        continue;
      }
      if (next2 !== html) { fs.writeFileSync(file, next2); changed++; }
    }

    console.log('[stamp-header-layout] '
      + (layout ? 'arrangement "' + layout.id + '" (' + spec.logo + '/' + spec.links + '/' + spec.actions
          + ', row ' + spec.linksRow + ')' : 'no arrangement')
      + (lines ? ', divider lines ' + lines : '')
      + (account ? ', account in the ' + (account === 'header' ? 'header' : 'bag panel') : '')
      + (labels ? ', controls as ' + (labels === 'icons' ? 'icons' : 'words (' + labels + ')') : '')
      + ' baked; ' + changed + ' page(s) updated.');
  } catch (e) {
    console.log('[stamp-header-layout] skipped (' + (e && e.message) + ') — <html> unchanged.');
  }
})();
