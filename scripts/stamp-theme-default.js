/**
 * Bake the store's DEFAULT theme onto <body> at build time.
 *
 * Why: a visitor with no localStorage — every first-ever visitor, every
 * incognito window, everyone who cleared their browser — has nothing for the
 * pre-paint snippet in <head> to read. So the page paints base.css's committed
 * default (dark), and theme-engine.js corrects it after it loads. On a light
 * store that is a full second of the wrong site, and it is the one case the
 * cache cannot help with, because the whole problem is that there is no cache.
 *
 * The fix is the same one stamp-config-defaults.js applies to fonts, for the
 * same reason and with the same safety rules: put the live answer into what
 * ships, so the FIRST frame is already right.
 *
 * base.css defines the complete token set under `body.light-mode` — colours,
 * aliases, surfaces — and hundreds of structural rules are written as
 * `body.light-mode .thing`. So the class is the whole fix: with it baked in,
 * first paint is correct without a single byte of JavaScript. theme-engine.js
 * still toggles it for a visitor who picked something else, and toggling a
 * class that is already right is a no-op.
 *
 * Runs on the Cloudflare build only (CF_PAGES), before minify and cache
 * hashing. Locally it would rewrite committed HTML on every `npm install` and
 * create churn; pass --local to run it by hand.
 *
 * IT MUST NEVER BREAK THE BUILD. No network, bad JSON, an unexpected <body>,
 * anything at all — the HTML is left exactly as committed and the old
 * behaviour (a corrected flash) is what ships.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

if (!process.env.CF_PAGES && !process.argv.includes('--local')) process.exit(0);

const ROOT = path.resolve(__dirname, '..');

/* Same pages that carry the pre-paint snippet. A page left out is the same
   flash on one URL, which is how "some pages dark, some light" started. */
const PAGES = ['404.html', 'about.html', 'account.html', 'bag.html', 'checkout.html',
  'confirm.html', 'drop001.html', 'index.html', 'journal.html', 'landing.html',
  'policies.html', 'product.html', 'returns.html', 'sizeguide.html'];

/* The marker makes this idempotent and reversible: the script only ever
   rewrites a class list it wrote itself, so a hand-authored class on <body>
   cannot be clobbered and re-running cannot compound. */
const MARK_OPEN = 'zw-theme-stamp';

/* The canonical project, read rather than restated. This script fetching the
   ORIGINAL store's theme while the rest of the build points somewhere else is
   exactly the bug zw-config.js exists to prevent, and it would ship as a
   white-label store wearing somebody else's colours. */
const CANON = require(path.join(__dirname, '..', 'zw-config.js'));

const PROJECT = (process.env.ZW_SUPABASE_URL || process.env.SUPABASE_URL || CANON.supabaseUrl).replace(/\/$/, '');
const ANON = process.env.ZW_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || CANON.supabaseAnonKey;

function fetchThemeModes() {
  return new Promise((resolve) => {
    if (!PROJECT || !ANON) return resolve(null);
    const url = PROJECT + '/rest/v1/site_settings?select=value&key=eq.theme_modes';
    https.get(url, { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const rows = JSON.parse(body);
          let raw = rows && rows[0] && rows[0].value;
          if (typeof raw === 'string') raw = JSON.parse(raw);
          resolve(raw && typeof raw === 'object' ? raw : null);
        } catch (_) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

/* Only the three shapes base.css actually has rules for. An unrecognised base
   stamps nothing rather than inventing a class no stylesheet answers to. */
function classesFor(base) {
  if (base === 'super-light') return 'light-mode super-light-mode';
  if (base === 'light') return 'light-mode';
  if (base === 'dark') return '';
  return null;
}

(async () => {
  try {
    const cfg = await fetchThemeModes();
    if (!cfg) {
      console.log('[stamp-theme-default] no theme config fetched — <body> left as committed.');
      return;
    }
    const modes = Array.isArray(cfg.modes) ? cfg.modes : [];
    const wanted = String(cfg.default || 'dark');
    const mode = modes.filter((m) => m && m.id === wanted)[0];
    /* A default naming a theme that no longer exists is a config problem, not
       something to guess around. */
    if (!mode) {
      console.log('[stamp-theme-default] default theme "' + wanted + '" not found — <body> left as committed.');
      return;
    }
    const classes = classesFor(String(mode.base || ''));
    if (classes === null) {
      console.log('[stamp-theme-default] unrecognised base "' + mode.base + '" — <body> left as committed.');
      return;
    }

    let changed = 0;
    for (const page of PAGES) {
      const file = path.join(ROOT, page);
      let html;
      try { html = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }

      /* Strip any class list this script previously wrote, then add the new one.
         Matching on our own marker is what keeps a hand-written class safe. */
      let next = html.replace(
        new RegExp('(<body\\b[^>]*?)\\s*class="' + MARK_OPEN + '[^"]*"', 'i'),
        '$1'
      );
      if (classes) {
        const m = /<body\b([^>]*)>/i.exec(next);
        if (!m) { console.log('[stamp-theme-default] no <body> in ' + page + ' — skipped.'); continue; }
        next = next.replace(/<body\b([^>]*)>/i,
          '<body class="' + MARK_OPEN + ' ' + classes + '"$1>');
      }

      /* AND TELL THE PRE-PAINT BLOCK, which runs in <head> where <body> — and
         therefore the class above — does not exist yet. It used to fall back to
         a hardcoded 'super-light' when the visitor had nothing stored, while
         this script stamped whatever the database actually said. On a dark-
         default store those two answers were opposites, and the pre-paint one
         was written with !important, so the page kept a white ground under the
         dark theme's near-white text. One default, published where both can
         read it. */
      next = next.replace(/<html\b([^>]*)>/i, (tag, attrs) =>
        '<html' + String(attrs).replace(/\s*data-zw-theme-default="[^"]*"/i, '')
          + ' data-zw-theme-default="' + String(mode.base) + '">');

      /* Never write something that would corrupt the page. */
      if ((next.match(/<body\b/gi) || []).length !== (html.match(/<body\b/gi) || []).length) {
        console.log('[stamp-theme-default] body count changed in ' + page + ' — skipped.');
        continue;
      }
      if (next !== html) { fs.writeFileSync(file, next); changed++; }
    }

    console.log('[stamp-theme-default] default theme "' + wanted + '" (' + mode.base + ') → '
      + (classes || 'no class') + '; ' + changed + ' page(s) updated.');
  } catch (e) {
    console.log('[stamp-theme-default] skipped (' + (e && e.message) + ') — <body> unchanged.');
  }
})();
