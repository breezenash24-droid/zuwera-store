/* Run the modules nobody is waiting for after the page has painted.
   ═══════════════════════════════════════════════════════════════════════════

   The homepage loads 44 scripts. An audit of every one of them found that
   almost none can be deferred: nearly all are either called synchronously by
   another module while the page settles, or do work at load time that the
   page's appearance depends on. storefront.js and storefront-features.js —
   144 KB and 60 KB minified, the two biggest by a distance — are each called
   into by half a dozen others, so neither can move at all.

   ── THE SET IS ONE MODULE, AND THAT IS THE FINDING ──────────────────────────

   email-popup.js looked like the obvious candidate: 17,089 bytes minified, a
   timed popup, and a grep of the storefront turned up no callers. The coupling
   check at the bottom of this file disagreed on the first run —

       storefront-features.js:1148   window.ZWEmailPopup.markKnown()
       checkout.js:1302              window.ZWEmailPopup.markKnown()

   — both recording that this visitor's email is already known. Deferred, those
   calls find nothing and are skipped, and the popup then asks a known customer
   for an address it already has. So it stays eager. The earlier grep had missed
   them by looking for the wrong casing, which is precisely why the check asks
   the question from the module's own exports instead of from a list.

   What is left is integrations.js — 3,709 bytes, against a 961-byte loader. A
   small number, honestly reported: the ceiling here is how tightly this
   codebase is coupled, not the mechanism. The two durable outputs are the
   loader, which makes the next lazy module cost nothing to add, and the check,
   which stopped the first one that should not have been.

   Its real value is also larger than its own size, on a store that uses it:
   integrations.js is what injects Crisp, Tawk and Pinterest, so deferring it
   defers whatever those pull from other origins. The live store has no
   integrations row at all today, so right now it fetches, finds nothing and
   does nothing — later than it used to.

   ── HOW A DECLARATION WORKS ─────────────────────────────────────────────────

       <script type="text/zw-lazy" src="/email-popup.js?v=abc123"></script>

   A <script> with a type the browser does not recognise is neither executed nor
   fetched. Measured in Chrome: the module had not run when the next inline
   script parsed, had not run at DOMContentLoaded, had run by four seconds, and
   exactly one real <script> was injected for it.

   Keeping a REAL `src` is the whole reason for that shape rather than a
   data-src: scripts/bump-cache-version.js rewrites `src="/name.js?v=…"` and
   nothing else, and _headers serves JS as immutable for a year. A lazy module
   declared any other way would ship with a stale hash forever. */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const LZ = read('zw-lazy.js');
const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));

console.log('\n  the lazy modules are actually lazy\n');

console.log('  the loader');
{
  ok('it owns the shared idle scheduler',
    /window\.zwWhenIdle = window\.zwWhenIdle \|\| function \(cb\) \{/.test(LZ),
    'it used to live in meta-pixel.js, which google-tag.js and posthog-init.js both reached into');
  ok('…firing on interaction as well as idle',
    /\['pointerdown', 'keydown', 'scroll', 'touchstart', 'visibilitychange'\]/.test(LZ),
    'requestIdleCallback never fires at all on a page that stays busy');
  ok('…with a timeout so it always fires', /timeout: 3000/.test(LZ) && /setTimeout\(run, 2500\)/.test(LZ));
  ok('meta-pixel.js keeps its own guarded copy',
    /window\.zwWhenIdle = window\.zwWhenIdle \|\|/.test(read('meta-pixel.js')),
    'a page that loads it without the loader must be unaffected');

  ok('one load per url', /if \(inflight\[url\]\) return inflight\[url\];/.test(LZ));
  /* A lazy module is by definition one the page works without, so a failure to
     load is not a page error and must not be reported as one. */
  ok('a failed load resolves rather than rejecting',
    /s\.onerror = function \(\) \{ resolve\(false\); \};/.test(LZ),
    'an unhandled rejection in a loader reads as a page error it is not');
  ok('…and declaration order is preserved', /s\.async = false;/.test(LZ));
  ok('it waits for the document before looking for tags',
    /if \(document\.readyState === 'loading'\) \{\n    document\.addEventListener\('DOMContentLoaded', schedule, \{ once: true \}\);/.test(LZ),
    'the same readyState trap an async module here fell into once already');
  ok('…and finds them by the inert type', /script\[type="text\/zw-lazy"\]\[src\]/.test(LZ));
}

console.log('\n  the declarations');
{
  let declaring = 0;
  const problems = [];
  for (const page of pages) {
    const html = read(page);
    const lazy = [...html.matchAll(/<script type="text\/zw-lazy"[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    if (!lazy.length) continue;
    declaring++;

    /* The loader has to be there, and BEFORE them — it reads the tags out of
       the document, so a declaration it never sees is a module that never runs
       at all. */
    const iLoader = html.indexOf('src="/zw-lazy.js');
    const iFirst = html.indexOf('<script type="text/zw-lazy"');
    if (iLoader === -1) problems.push(page + ': declares lazy modules with no loader');
    else if (iLoader > iFirst) problems.push(page + ': loader comes after the declarations');

    for (const src of lazy) {
      if (!/\?v=[A-Za-z0-9_-]+$/.test(src)) problems.push(page + ': ' + src + ' has no cache-busting hash');
    }
  }
  ok(declaring + ' pages declare something lazy', declaring >= 10, String(declaring));
  ok('every one has the loader, ahead of them, and every url is hashed',
    problems.length === 0, problems.join(' | '));

  ok('admin.html is left alone',
    !/text\/zw-lazy/.test(read('admin.html')) && /src="\/?email-popup\.js/.test(read('admin.html')),
    'its settings screen reads window.ZWEmailPopup directly');

  /* Named explicitly as well as caught generically. The coupling check below
     would catch this again, but it reads as an accident when it fires; this
     says the decision was made and why. */
  ok('email-popup.js is not lazy anywhere, on purpose',
    !pages.some((f) => /<script type="text\/zw-lazy"[^>]*email-popup/.test(read(f))),
    'storefront-features.js and checkout.js call markKnown() on it while the page settles');
}

console.log('\n  and nothing coupled has been declared lazy');
{
  /* THE GUARD THAT MATTERS. The loader has no stub and cannot replay a call it
     was not there for, so a module another one calls synchronously must never
     appear in a declaration. This asks the question directly rather than
     trusting the list: for every lazy module on a page, does any EAGER script
     on that same page name one of the globals it defines? */
  const globalsOf = (src) => {
    const out = new Set();
    for (const m of src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) out.add(m[1]);
    return [...out];
  };
  const problems = [];
  for (const page of pages) {
    const html = read(page);
    const lazy = [...html.matchAll(/<script type="text\/zw-lazy"[^>]*src="([^"]+)"/g)]
      .map((m) => m[1].split('?')[0].replace(/^\//, ''));
    if (!lazy.length) continue;
    const eager = [...html.matchAll(/<script(?![^>]*type="text\/zw-lazy")[^>]*src="([^"]+)"/g)]
      .map((m) => m[1].split('?')[0].replace(/^\//, ''))
      .filter((f) => f !== 'zw-lazy.js');

    for (const mod of lazy) {
      let src;
      try { src = read(mod); } catch (_) { problems.push(page + ': ' + mod + ' does not exist'); continue; }
      for (const g of globalsOf(src)) {
        /* Vendor globals a third-party script sets on itself are not a coupling
           to this page's code. */
        if (/^(\$crisp|CRISP_WEBSITE_ID|Tawk_API|Tawk_LoadStart|pintrk|dataLayer|fbq|_fbq)$/.test(g)) continue;
        const re = new RegExp('\\b' + g.replace(/\$/g, '\\$') + '\\b');
        for (const other of eager) {
          let os;
          try { os = read(other); } catch (_) { continue; }
          if (re.test(os)) problems.push(page + ': ' + other + ' calls ' + g + ' from lazy ' + mod);
        }
      }
    }
  }
  ok('no eager module calls into a lazy one',
    problems.length === 0,
    problems.slice(0, 4).join(' | '));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
