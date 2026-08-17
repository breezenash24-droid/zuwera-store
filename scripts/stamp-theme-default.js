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
 * `body.light-mode .thing`. theme-engine.js still toggles it for a visitor who
 * picked something else, and toggling a class that is already right is a no-op.
 *
 * THE CLASS IS NOT THE WHOLE FIX, though this file used to say it was, and that
 * sentence is why the bug survived a rewrite. The class selects a BUILT-IN
 * palette. A store whose default is a custom theme — an imported one, or
 * anything edited in the theme editor — has its own colours, type scale,
 * density and motion, and the class carries none of them. Worse, base.css
 * declares those tokens ON the class, so the pre-paint block's attempt to set
 * them on <html> loses the cascade the instant the stylesheet lands. See the
 * long note in scripts/_theme-css.js.
 *
 * So the resolved theme is baked as a real CSS rule too, at a specificity that
 * beats the built-in block. Then first paint is correct with no JavaScript, no
 * localStorage and no network — and theme-engine.js, whose inline styles
 * outrank any selector, is left free to change it later.
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
const { themeCss, themeAttrs } = require('./_theme-css.js');

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

/* The baked stylesheet lives between these, so re-running replaces it instead
   of stacking a second copy — the same reason the class list carries a marker.
   Self-installing: a page without the markers gets them before </head>, so the
   fourteen committed files do not have to carry an empty region for a script
   that only runs on the deploy. */
const CSS_OPEN = '<!-- zw:themevars -->';
const CSS_CLOSE = '<!-- /zw:themevars -->';

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

    /* The theme as CSS, plus the attributes that are shapes rather than values.
       Scoped to the same attribute the pre-paint block removes, so one visitor
       who chose something else switches the whole thing off. */
    const css = themeCss(mode.tokens, 'html[data-zw-theme-stamp]');
    const attrs = themeAttrs(mode.tokens);
    const styleBlock = CSS_OPEN + '<style id="zw-theme-stamp-vars">' + css + '</style>' + CSS_CLOSE;

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
      /* Same for the body attributes: only ones this script wrote are removed,
         so a page that hand-authors data-zw-account keeps it. */
      next = next.replace(/(<body\b[^>]*?)\s*data-zw-account="[^"]*"/i, '$1');
      const bodyAttrs = Object.keys(attrs.body)
        .map((k) => ' ' + k + '="' + attrs.body[k] + '"').join('');
      /* A dark default writes no class — base.css's committed default already
         is dark — but it may still carry attributes, so the rewrite is driven
         by whether there is anything to write, not by the class alone. */
      if (classes || bodyAttrs) {
        const m = /<body\b([^>]*)>/i.exec(next);
        if (!m) { console.log('[stamp-theme-default] no <body> in ' + page + ' — skipped.'); continue; }
        const cls = classes ? ' class="' + MARK_OPEN + ' ' + classes + '"' : '';
        next = next.replace(/<body\b([^>]*)>/i, '<body' + cls + bodyAttrs + '$1>');
      }

      /* AND TELL THE PRE-PAINT BLOCK, which runs in <head> where <body> — and
         therefore the class above — does not exist yet. It used to fall back to
         a hardcoded 'super-light' when the visitor had nothing stored, while
         this script stamped whatever the database actually said. On a dark-
         default store those two answers were opposites, and the pre-paint one
         was written with !important, so the page kept a white ground under the
         dark theme's near-white text. One default, published where both can
         read it. */
      next = next.replace(/<html\b([^>]*)>/i, (tag, a) => {
        let keep = String(a)
          .replace(/\s*data-zw-theme-default="[^"]*"/i, '')
          .replace(/\s*data-zw-theme-stamp="[^"]*"/i, '')
          .replace(/\s*data-zw-iconlabels="[^"]*"/i, '');
        /* The theme's IDENTITY, not just its base. The pre-paint block compares
           it with the id this visitor resolved: same, and the baked stylesheet
           below is exactly right; different, and it removes this attribute,
           which switches the whole block off in one move. Base alone could not
           answer that — two themes can share a base and share nothing else. */
        keep += ' data-zw-theme-default="' + String(mode.base) + '"';
        keep += ' data-zw-theme-stamp="' + String(mode.id) + '"';
        for (const k of Object.keys(attrs.html)) keep += ' ' + k + '="' + attrs.html[k] + '"';
        return '<html' + keep + '>';
      });

      /* The stylesheet. Replaced in place if this script has run before,
         otherwise installed just before </head> — after every <link>, though
         specificity means the order does not actually decide it. */
      if (css) {
        const a = next.indexOf(CSS_OPEN);
        const b = next.indexOf(CSS_CLOSE);
        if (a >= 0 && b > a) {
          next = next.slice(0, a) + styleBlock + next.slice(b + CSS_CLOSE.length);
        } else if (/<\/head>/i.test(next)) {
          next = next.replace(/<\/head>/i, styleBlock + '\n</head>');
        } else {
          console.log('[stamp-theme-default] no </head> in ' + page + ' — theme CSS not baked.');
        }
      }

      /* Never write something that would corrupt the page. */
      if ((next.match(/<body\b/gi) || []).length !== (html.match(/<body\b/gi) || []).length) {
        console.log('[stamp-theme-default] body count changed in ' + page + ' — skipped.');
        continue;
      }
      if ((next.match(/<\/head>/gi) || []).length !== (html.match(/<\/head>/gi) || []).length) {
        console.log('[stamp-theme-default] head count changed in ' + page + ' — skipped.');
        continue;
      }
      if (next !== html) { fs.writeFileSync(file, next); changed++; }
    }

    console.log('[stamp-theme-default] default theme "' + wanted + '" (' + mode.base + ') → '
      + (classes || 'no class') + ' + ' + css.length + ' bytes of baked CSS; '
      + changed + ' page(s) updated.');
  } catch (e) {
    console.log('[stamp-theme-default] skipped (' + (e && e.message) + ') — <body> unchanged.');
  }
})();
