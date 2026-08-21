/* The page used to paint from memory, then correct itself in front of you.
   ═══════════════════════════════════════════════════════════════════════════

   Every setting that decides what the top of the page LOOKS like reached the
   browser the same way: paint from localStorage, then fetch, then repaint. That
   is a memory, not a fact, and it is wrong in exactly the two cases that matter
   most —

       a first-ever visitor      has nothing cached, so they watch the shipped
                                 defaults become the real store.
       the visit after a change  has the OLD value cached, so they watch last
                                 week's store become this week's.

   The live homepage showed it plainly. Its top section is a hero_carousel and
   it has no static hero and no marquee, so a first visit painted the shipped
   hero AND the marquee, then removed both and drew a carousel over the space.
   The document knew none of that. The edge did.

   ── WHAT IS STAMPED, MEASURED AGAINST THE LIVE SETTINGS ─────────────────────

   <html>   class="zw-hide-static-hero zw-hs-marquee"   data-zw-pb="1"
            data-zw-theme-default="light"               + the header attributes
   <head>   <script type="application/json" id="zw-first-paint">
            14 keys, 5,026 bytes, 1,780 gzipped

   Not all of them. page_builder_published alone is 12,180 bytes and
   legal_policies another 6,623, and neither decides what you see before you
   scroll.

   ── AND THE BAKED THEME, WHICH NOTHING COULD CHALLENGE ──────────────────────

   stamp-theme-default.js bakes the default theme's real palette into every page
   as a stylesheet rule. That is the whole answer for a visitor with nothing
   stored — until the shop changes its default, at which point it is a confident
   wrong answer: the pre-paint block drops the bake by comparing it against the
   id it read from localStorage, and a first-ever visitor has none.

   The edge has both halves, so it does that comparison itself. Driven against
   the live settings with a page built under a different default:

       built with   data-zw-theme-stamp="two-tone"  data-zw-theme-default="dark"
       served with  (stamp removed)                 data-zw-theme-default="light"

   The pre-paint block needed no new code for this, which matters: it is inlined
   into fourteen pages and reading the settings JSON there ran 243 bytes over
   the budget in tests/product-page-is-cacheable.test.js. */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const MW = read('functions/_middleware.js');
const IDX = read('index.html');
const ZD = read('zw-data.js');

let els = {};
global.HTMLRewriter = class {
  constructor() { this.h = []; }
  on(sel, handler) { this.h.push({ sel, handler }); return this; }
  transform(res) {
    for (const { sel, handler } of this.h) {
      if (!els[sel]) {
        els[sel] = {
          attrs: sel === 'html' ? Object.assign({}, els.__seed || {}) : {},
          removed: [], prepended: [],
          setAttribute(k, v) { this.attrs[k] = v; },
          removeAttribute(k) { delete this.attrs[k]; this.removed.push(k); },
          getAttribute(k) {
            return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
          },
          prepend(html) { this.prepended.push(html); },
        };
      }
      handler.element(els[sel]);
    }
    return Object.assign({}, res, { __rewritten: true });
  }
};

const rowsOf = (obj) => Object.keys(obj).map((k) => ({
  key: k, value: obj[k], updated_at: '2026-08-20T12:00:00+00:00',
}));

function run(settings, seed) {
  els = { __seed: seed || {} };
  global.fetch = async () => ({ ok: true, json: async () => rowsOf(settings) });
  return { html: () => els.html || { attrs: {}, removed: [] }, head: () => els.head || { prepended: [] } };
}

const ctx = () => ({
  request: { url: 'https://zuwera.store/', method: 'GET' },
  env: {},
  next: async () => ({ headers: { get: () => 'text/html; charset=utf-8' } }),
});

(async () => {
  const mod = await import('../functions/_middleware.js');
  const { onRequest, layoutClasses, themeAttrs } = mod;

  console.log('\n  the first frame stops guessing\n');

  console.log('  only the settings the first frame is made of');
  {
    const list = (MW.match(/const FIRST_PAINT_KEYS = \[([\s\S]*?)\];/) || [])[1] || '';
    const keys = (list.match(/'[a-z_]+'/g) || []).map((s) => s.slice(1, -1));
    ok('fourteen keys are named', keys.length === 14, keys.length + ': ' + keys.join(','));
    for (const k of ['theme', 'theme_modes', 'announcement_bar', 'nav_menu', 'icons', 'text_overrides', 'fonts', 'header_layout']) {
      ok('…including ' + k, keys.includes(k));
    }
    /* The two biggest rows on the live store, and neither changes what you see
       before you scroll. Stamping them would triple the cost for nothing. */
    ok('and NOT page_builder_published', !keys.includes('page_builder_published'),
      '12,180 bytes on the live store');
    ok('…nor legal_policies', !keys.includes('legal_policies'), '6,623 bytes');
    ok('one request for all of it, not one per key', /key=in\.\(/.test(MW));
    ok('…read by key, so the rows have to carry one', /select=key,value,updated_at/.test(MW));
    ok('…and still cached at the edge', /cf: \{ cacheTtl: TTL, cacheEverything: true \}/.test(MW));
  }

  console.log('\n  what the layout actually contains, instead of what was remembered');
  {
    const withHero = { sections: [{ type: 'hero', order: 0 }, { type: 'about', order: 1 }] };
    const carousel = { sections: [{ type: 'hero_carousel', order: 0 }, { type: 'products', order: 1 }] };
    ok('a layout with a static hero hides nothing of it',
      !layoutClasses(withHero).classes.includes('zw-hide-static-hero')
      && layoutClasses(withHero).hasStaticHero === true);
    ok('a carousel-led layout hides the baked hero',
      layoutClasses(carousel).classes.includes('zw-hide-static-hero'));
    ok('…and every default section the layout does not have',
      JSON.stringify(layoutClasses(carousel).classes.slice().sort())
        === JSON.stringify(['zw-hide-static-hero', 'zw-hs-about', 'zw-hs-marquee', 'zw-hs-release'].sort()),
      JSON.stringify(layoutClasses(carousel).classes));
    ok('an invisible section does not count as present',
      layoutClasses({ sections: [{ type: 'hero', visible: false }, { type: 'about' }] })
        .classes.includes('zw-hide-static-hero'));
    /* The worst possible failure for this feature would be blanking a page. */
    ok('an empty published layout decides nothing',
      layoutClasses({ sections: [] }) === null
      && layoutClasses({ sections: [{ type: 'x', visible: false }] }) === null,
      '"nothing is configured" is not "hide everything"');
    ok('…and neither does a row it cannot read',
      layoutClasses(null) === null && layoutClasses({}) === null && layoutClasses('x') === null);
  }

  console.log('\n  the classes are merged onto <html>, never assigned');
  {
    const r = run({
      page_builder_published: { sections: [{ type: 'hero_carousel' }] },
    }, { class: 'zw-existing another' });
    await onRequest(ctx());
    const cls = String(r.html().attrs.class || '').split(' ');
    ok('what was already there survives',
      cls.includes('zw-existing') && cls.includes('another'),
      'setAttribute REPLACES — assigning would clear the theme stamp and the preboot classes');
    ok('…and the new ones are added', cls.includes('zw-hide-static-hero'));
    ok('…without duplicating one that was already applied',
      cls.filter((c) => c === 'zw-hide-static-hero').length === 1);
    ok('the marker says the edge answered', r.html().attrs['data-zw-pb'] === '1');
  }

  console.log('\n  …and the marker is written even when nothing needs hiding');
  {
    /* "This layout has every default section" is an answer. Writing the marker
       only when something is hidden would leave the preboot guessing in the one
       case where its guess is most likely to be the wrong one. */
    const r = run({
      page_builder_published: { sections: ['hero', 'marquee', 'about', 'release', 'products'].map((t) => ({ type: t })) },
    });
    await onRequest(ctx());
    ok('the marker is still there', r.html().attrs['data-zw-pb'] === '1');
    ok('…and no hide class is', !/zw-h/.test(String(r.html().attrs.class || '')));
  }

  console.log('\n  the baked theme is corrected on the way out');
  {
    ok('themeAttrs reads the default id', themeAttrs({ default: 'x', modes: [{ id: 'x', base: 'light' }] }).id === 'x');
    ok('…and its base', themeAttrs({ default: 'x', modes: [{ id: 'x', base: 'light' }] }).base === 'light');
    /* An unrecognised base is worse than none: the pre-paint block treats it as
       a learned answer and paints a ground for a theme that does not exist. */
    ok('a base the stylesheet has no tokens for is dropped',
      themeAttrs({ default: 'x', modes: [{ id: 'x', base: 'neon' }] }).base === '');
    ok('…and so is a row with no default', themeAttrs({ modes: [] }) === null && themeAttrs(null) === null);

    const r = run({ theme_modes: { default: 'imported-a', modes: [{ id: 'imported-a', base: 'light' }] } },
      { 'data-zw-theme-stamp': 'two-tone', 'data-zw-theme-default': 'dark' });
    await onRequest(ctx());
    ok('a bake from a different default is removed',
      r.html().removed.includes('data-zw-theme-stamp'),
      'nothing in the page could challenge it for a visitor with nothing stored');
    ok('…and the base is corrected', r.html().attrs['data-zw-theme-default'] === 'light');
  }
  {
    const r = run({ theme_modes: { default: 'two-tone', modes: [{ id: 'two-tone', base: 'light' }] } },
      { 'data-zw-theme-stamp': 'two-tone' });
    await onRequest(ctx());
    ok('a bake that is STILL the default is kept',
      !r.html().removed.includes('data-zw-theme-stamp'),
      'removing it would throw away a correct palette and repaint for nothing');
  }

  console.log('\n  the settings arrive in the document');
  {
    const r = run({ theme: { a: 1 }, nav_menu: { b: 2 }, page_builder_published: { sections: [{ type: 'hero' }] } });
    await onRequest(ctx());
    const tag = r.head().prepended[0] || '';
    ok('a JSON block is prepended to <head>',
      /^<script type="application\/json" id="zw-first-paint">/.test(tag),
      'prepended so it is parsed before the stylesheets and before any script exists to look for it');
    const payload = JSON.parse(tag.replace(/^[^>]*>/, '').replace(/<\/script>$/, '').replace(/<\\\/script/g, '</script'));
    ok('…carrying the keys that were found', payload.settings.theme.a === 1 && payload.settings.nav_menu.b === 2);
    ok('…and not the ones that were not', !('icons' in payload.settings),
      'a key with no row is not the same as a key whose value is null');
    ok('…with the timestamps beside them', !!payload.updatedAt.theme);
    ok('it is not executable', /type="application\/json"/.test(MW),
      'the browser will not run it and the CSP does not have to allow it');
  }
  {
    /* The only sequence that can end the block early. */
    const r = run({ theme: { evil: '</script><img src=x onerror=alert(1)>' } });
    await onRequest(ctx());
    const tag = r.head().prepended[0] || '';
    ok('a closing script tag inside a value cannot end the block',
      !tag.includes('</script><img') && /<\\\/script/.test(tag),
      tag.slice(0, 120));
    ok('…and the JSON still parses back to the original string',
      JSON.parse(tag.replace(/^[^>]*>/, '').replace(/<\/script>$/, '').replace(/<\\\/script/g, '</script'))
        .settings.theme.evil === '</script><img src=x onerror=alert(1)>');
  }

  console.log('\n  it can still only ever fall back');
  {
    els = { __seed: {} };
    global.fetch = async () => { throw new Error('network'); };
    const res = await onRequest(ctx());
    ok('a failed read leaves the page alone', !res.__rewritten,
      'the baked answer, the visitor cache and the runtime fetch all still apply');
    ok('a timeout does too', /if \(!attrs\) return res;/.test(MW));
    ok('…and so does a read that found nothing',
      /if \(!attrs\.html && !attrs\.body && !hasSettings && !readLayout && !attrs\.theme && !attrs\.nav\) return res;/.test(MW));
  }
  {
    els = { __seed: {} };
    global.fetch = async () => ({ ok: false, json: async () => [] });
    const res = await onRequest(ctx());
    ok('a non-ok response leaves the page alone', !res.__rewritten);
  }

  console.log('\n  and the page stops guessing when it has been told');
  {
    ok('the hidden-sections preboot defers to the stamp',
      /if\(h\.hasAttribute\('data-zw-pb'\)\) return;/.test(IDX),
      "last visit's note can name a section this layout HAS — applying it would remove something real");
    ok('the static-hero preboot reads the class rather than the memory',
      /_h\.hasAttribute\('data-zw-pb'\)\s*\n\s*\? _h\.classList\.contains\('zw-hide-static-hero'\)\s*\n\s*: \(localStorage\.getItem\('zw_hide_static_hero'\) === '1'\)/.test(IDX));
    ok('…and still preloads the carousel poster either way',
      /if \(_noStaticHero\) \{/.test(IDX),
      'that branch does more than hide — it is where the LCP preload lives');
  }

  console.log('\n  the broker reads it instead of asking for it');
  {
    ok('zw-data.js looks for the stamp', /document\.getElementById\('zw-first-paint'\)/.test(ZD));
    ok('a stamped key resolves without a request',
      /if \(isStamped\(key\)\) return Promise\.resolve\(stamped\.settings\[key\]\);/.test(ZD));
    ok('…and getWithMeta too', /if \(isStamped\(key\)\) \{\n      return Promise\.resolve\(\{/.test(ZD));
    /* The distinction the whole thing turns on: the edge omits a key that has no
       row, so "stamped as null" and "not stamped" are different questions. */
    ok('"stamped as null" is not "not stamped"',
      /return !!stamped && Object\.prototype\.hasOwnProperty\.call\(stamped\.settings, key\);/.test(ZD),
      'a !== undefined test would turn a missing key into a stamped null it never re-fetches');
    ok('there is a synchronous read for the pre-paint callers', /peek: peek,/.test(ZD));
    ok('…which answers undefined when a key was not stamped',
      /return isStamped\(key\) \? stamped\.settings\[key\] : undefined;/.test(ZD));
    ok('…and a way to ask whether this document was stamped at all',
      /stamped: function \(\) \{ return !!stamped; \}/.test(ZD));
    ok('a malformed stamp is ignored rather than thrown',
      /\} catch \(_\) \{ return null; \}\n  \}\(\)\);/.test(ZD));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
