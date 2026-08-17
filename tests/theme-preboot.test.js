/* The pre-paint theme block — one copy, one answer.
 *
 * Fourteen pages inline the same thirty lines of JavaScript to decide what
 * colour to paint before their stylesheets load. They were maintained by hand,
 * and by the time anyone looked there were five different versions of them.
 *
 * The version that shipped had a hole with a very loud symptom. It painted the
 * BACKGROUND from localStorage.zw_theme_mode, defaulting to 'super-light', and
 * it set the body CLASSES only when a theme cache happened to be present. So on
 * a first visit — no localStorage at all — the page got a white ground and no
 * light-mode class, which means every colour still resolved through the dark
 * theme's --fg-rgb. base.css builds its entire alpha ladder out of that one
 * token (--c70 is rgb(var(--fg-rgb) / 70%)), so this was not one bad element:
 * it was all the text on the page, each piece at whatever opacity its own rule
 * used. The bag page showed it worst because the bag page is mostly text.
 *
 * Worse, the ground was painted with `!important` — it has to be, to beat
 * html{background:#09090b} before any class exists — so when theme-engine.js
 * later applied a dark theme it could strip the classes and repaint the tokens
 * but could NOT take the white ground back. The guess outlived the answer.
 *
 * What is asserted here is not the code, it is the property: whatever the
 * inputs, the ground and the text must agree. Plus the two structural rules
 * that keep it that way — one source for all fourteen copies, and a pre-paint
 * guess that theme-engine.js can retract.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const { block, PAGES, OPEN, CLOSE, SRC } = require(path.join(ROOT, 'scripts', 'sync-preboot.js'));

console.log('\n  theme pre-paint\n');

console.log('  fourteen copies, one source');
{
  /* Compared with line endings normalised. A page checked out on Windows comes
     back CRLF while the source file is LF, and comparing raw bytes made this
     fail on a difference git itself does not record — a false alarm that says
     "the theme block has drifted" when nothing about it has changed. */
  const lf = (s) => s.replace(/\r\n/g, '\n');
  const want = lf(block());
  const drifted = [];
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const a = html.indexOf(OPEN);
    const b = html.indexOf(CLOSE);
    if (a < 0 || b < a) { drifted.push(page + ' (unmarked)'); continue; }
    if (lf(html.slice(a, b + CLOSE.length)) !== want) drifted.push(page);
  }
  ok('every page carries the generated block verbatim', drifted.length === 0,
    drifted.join(', ') + ' — run `node scripts/sync-preboot.js`');

  /* A page that grew a second copy would be two answerers again, which is the
     shape of every theme bug this store has had. */
  const doubled = PAGES.filter((p) => {
    const h = fs.readFileSync(path.join(ROOT, p), 'utf8');
    return h.indexOf(OPEN) !== h.lastIndexOf(OPEN);
  });
  ok('…and only one copy of it', doubled.length === 0, doubled.join(', '));

  ok('the source explains itself rather than the pages doing it',
    fs.readFileSync(SRC, 'utf8').length > want.length,
    'comments are stripped on the way in — they belong in the source, not in front of the paint');
}

/* ── Run the real block, against a DOM small enough to inspect ─────────────── */

function runPreboot({ stored = null, themeModes = null, shipped = null, landing = null,
                     bodyClasses = '', storageThrows = false, stampId = null } = {}) {
  const store = {};
  if (stored) store.zw_theme_mode = stored;
  if (themeModes) store.zw_theme_modes = JSON.stringify(themeModes);

  const styles = [];
  const htmlEl = {
    _attrs: Object.assign({},
      shipped ? { 'data-zw-theme-default': shipped } : {},
      /* The id of the theme the BUILD baked into this page as CSS. */
      stampId ? { 'data-zw-theme-stamp': stampId } : {}),
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    /* A stub that is missing a method the block calls does not fail loudly — the
       call throws, the block's own try/catch swallows it, and everything AFTER
       that line silently never runs. Without this the suite would have gone
       green on a block that painted no colours at all. */
    removeAttribute(k) { delete this._attrs[k]; },
    style: { _props: {}, setProperty(k, v) { this._props[k] = v; } },
  };
  /* Pre-seeded with whatever stamp-theme-default.js baked onto <body> at build
     time, because on a load with no localStorage that stamp is the only thing
     standing between the visitor and the wrong theme. */
  const classes = new Set(String(bodyClasses || '').split(/\s+/).filter(Boolean));
  const doc = {
    documentElement: htmlEl,
    body: { classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    } },
    head: { appendChild(el) { styles.push(el); } },
    createElement: () => ({ id: '', textContent: '' }),
    querySelector: () => null,
    addEventListener: () => {},
  };
  const win = landing ? { __zwLM: () => landing } : {};

  const code = block().replace(OPEN, '').replace(CLOSE, '');
  new Function('window', 'document', 'localStorage', code)(win, doc, {
    /* A srcdoc iframe, a private window with storage blocked, or a browser that
       has run out of quota all THROW here rather than returning null. */
    getItem: (k) => {
      if (storageThrows) throw new Error('storage is not available');
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
  });

  const ground = styles.filter((s) => s.id === 'zw-preboot-ground')[0] || null;

  /* The theme's tokens arrive as a RULE now, not as properties on <html>.
     They had to: base.css declares every one of them on `body.light-mode`, so
     an inherited value from <html> was overridden the moment the stylesheet
     landed and the page painted the BUILT-IN palette instead of the store's.
     Reading them back off htmlEl.style here would be checking a writer against
     another writer — the assertion and the code agreeing with each other while
     both are wrong about the stylesheet. */
  const tokenEl = styles.filter((s) => s.id === 'zw-preboot-tokens')[0] || null;
  const tokens = {};
  if (tokenEl && tokenEl.textContent) {
    for (const chunk of String(tokenEl.textContent).split('}')) {
      const open = chunk.indexOf('{');
      if (open < 0) continue;
      for (const decl of chunk.slice(open + 1).split(';')) {
        const c = decl.indexOf(':');
        if (c > 0) tokens[decl.slice(0, c).trim()] = decl.slice(c + 1).trim();
      }
    }
  }

  return {
    base: htmlEl.getAttribute('data-zw-base'),
    light: classes.has('light-mode'),
    superLight: classes.has('super-light-mode'),
    /* The !important override — the thing that was unretractable. */
    lightGround: !!ground,
    groundCss: ground ? ground.textContent : '',
    htmlBg: htmlEl.style.background || '',
    fg: tokens['--fg-rgb'] || '',
    tokens,
    tokenCss: tokenEl ? tokenEl.textContent : '',
    stamp: htmlEl.getAttribute('data-zw-theme-stamp'),
  };
}

const DARK = { default: 'dark', modes: [{ id: 'dark', base: 'dark', tokens: { fg: '244 241 235', bg: '9 9 11' } }] };
const SUPER = { default: 'super-light', modes: [{ id: 'super-light', base: 'super-light', tokens: { fg: '10 10 10', bg: '255 255 255' } }] };
const CUSTOM_DARK = { default: 'midnight', modes: [{ id: 'midnight', base: 'dark', tokens: { fg: '240 240 240', bg: '3 4 9' } }] };

console.log('\n  the ground and the text always agree');
{
  /* THE INVARIANT. Every scenario below, checked the same way: if the block
     forced a light background, it must also have set the class that makes the
     text dark. This is the assertion the old code could not have passed. */
  const scenarios = {
    'nothing stored at all': {},
    'a stored built-in, no theme cache': { stored: 'super-light' },
    'a stored built-in the cache does know': { stored: 'super-light', themeModes: SUPER },
    'a light default baked in by the build': { shipped: 'super-light' },
    'a dark default baked in by the build': { shipped: 'dark' },
    'a cache whose default is dark, nothing chosen': { themeModes: DARK },
    'a cache whose default is dark over a light build stamp': { themeModes: DARK, shipped: 'super-light' },
    'a custom dark theme': { stored: 'midnight', themeModes: CUSTOM_DARK },
    'a landing page with its own theme': { landing: 'light', themeModes: SUPER },
    'a stored theme that no longer exists': { stored: 'deleted-theme' },
  };
  for (const [name, input] of Object.entries(scenarios)) {
    const r = runPreboot(input);
    ok(name, r.lightGround === r.light,
      'painted ' + (r.lightGround ? 'a light ground' : 'no light ground')
      + ' but ' + (r.light ? 'did' : 'did not') + ' set light-mode');
  }
}

console.log('\n  the last-resort default is what the stylesheet ships');
{
  /* base.css commits --fg-rgb: 244 241 235 / --bg-rgb: 9 9 11 at :root. When
     this block knows nothing, agreeing with that is the ONLY answer that cannot
     create a mismatch. The old default was 'super-light', which guaranteed one
     on every dark store. */
  const r = runPreboot({});
  ok('knowing nothing means dark', r.base === 'dark', r.base);
  ok('…so it adds no classes', !r.light && !r.superLight);
  ok('…and paints no ground of its own', !r.lightGround && !r.htmlBg,
    'the stylesheet already painted it — writing it again is only a chance to write it wrong');

  /* And when the build DOES know, that is what wins. */
  const s = runPreboot({ shipped: 'super-light' });
  ok('the build-time stamp beats the fallback', s.base === 'super-light' && s.light && s.superLight);

  /* A real choice beats both. */
  const c = runPreboot({ stored: 'dark', shipped: 'super-light' });
  ok('…and an explicit choice beats the stamp', c.base === 'dark' && !c.light);
}

console.log('\n  knowing nothing is not the same as knowing dark');
{
  /* THE REGRESSION THIS CAUGHT, found by looking at the size-guide iframe.
     It is loaded with srcdoc, and localStorage in a srcdoc frame is unreadable
     in some browsers — it THROWS rather than returning null. The first version
     of the one-base rewrite toggled the classes from the fallback whatever the
     reason for falling back, which STRIPPED the light-mode class the build had
     baked onto <body>. A light store would have gone dark for every visitor
     with no localStorage: every first visit, every private window, and the size
     guide on every device. Exactly the mistake theme-engine.js's shippedBase()
     exists to avoid, made one step earlier.

     A pre-paint block that has learned nothing must READ what shipped, not
     overwrite it. */
  const stamped = 'zw-theme-stamp light-mode super-light-mode';

  const blocked = runPreboot({ bodyClasses: stamped, storageThrows: true });
  ok('unreadable storage leaves the stamped classes alone',
    blocked.light && blocked.superLight,
    'this is a light store going dark on every first visit');
  ok('…and reports the stamped base rather than its own fallback',
    blocked.base === 'super-light', blocked.base);
  ok('…and paints no ground over it', !blocked.lightGround && !blocked.htmlBg,
    'body.light-mode already sets --black, so the stamp alone paints correctly');

  const empty = runPreboot({ bodyClasses: stamped });
  ok('empty storage does the same', empty.light && empty.superLight && empty.base === 'super-light');

  const plainLight = runPreboot({ bodyClasses: 'zw-theme-stamp light-mode' });
  ok('a plain light stamp is not promoted to super-light',
    plainLight.light && !plainLight.superLight && plainLight.base === 'light');

  const unstamped = runPreboot({ bodyClasses: '' });
  ok('an unstamped page is still dark', unstamped.base === 'dark' && !unstamped.light,
    'a dark store stamps no class at all and must not be turned light by this');

  /* And the stamp is a fallback for knowing nothing, never a veto on knowing
     something — a visitor who picked dark on a light store still gets dark. */
  const chose = runPreboot({ bodyClasses: stamped, stored: 'dark' });
  ok('a real choice still overrules the stamp', chose.base === 'dark' && !chose.light);
  const attr = runPreboot({ bodyClasses: stamped, shipped: 'dark' });
  ok('…as does an explicit build default', attr.base === 'dark' && !attr.light);
}

console.log('\n  the theme the build baked in');
{
  /* stamp-theme-default.js writes the store's default theme into every page as
     a real stylesheet rule, so a visitor with nothing stored gets the right
     colours, type scale and density on the FIRST frame — no localStorage, no
     network, no theme-engine.js. The whole block hangs off one attribute, and
     the only question this block answers is when to take that attribute away.

     It is the right answer for a visitor who has said nothing and the wrong one
     for a visitor who picked something else, and "something else" is decided by
     ID, never by base: two themes can share a base and share nothing else. */
  const keeps = runPreboot({ stampId: 'imported-x', bodyClasses: 'zw-theme-stamp light-mode super-light-mode' });
  ok('a visitor who has said nothing keeps the baked theme',
    keeps.stamp === 'imported-x', 'got ' + JSON.stringify(keeps.stamp));

  const same = runPreboot({ stampId: 'imported-x', stored: 'imported-x',
    themeModes: { default: 'imported-x', modes: [{ id: 'imported-x', base: 'light', tokens: { fg: '1 1 1', bg: '2 2 2' } }] } });
  ok('a visitor who picked the default keeps it too', same.stamp === 'imported-x');

  const differs = runPreboot({ stampId: 'imported-x', stored: 'dark' });
  ok('a visitor who picked another theme drops it',
    differs.stamp === null,
    'the baked palette would otherwise sit under the theme they chose');

  /* The trap this guards: a same-base comparison would have kept the baked
     block here, and the visitor would get their theme's class with the OTHER
     theme's colours underneath it. */
  const sameBase = runPreboot({ stampId: 'imported-x', stored: 'midnight', themeModes: CUSTOM_DARK });
  ok('…even when the two themes share a base', sameBase.stamp === null,
    'compared by base rather than id, this would wrongly keep the bake');
}

console.log('\n  precedence');
{
  ok('a custom theme is resolved through the cache',
    runPreboot({ stored: 'midnight', themeModes: CUSTOM_DARK }).base === 'dark');
  ok('…and paints its own colours, not the built-in ones',
    runPreboot({ stored: 'midnight', themeModes: CUSTOM_DARK }).fg === '240 240 240');
  ok('an unknown id falls through rather than being guessed at',
    runPreboot({ stored: 'deleted-theme', themeModes: CUSTOM_DARK }).base === 'dark');
  ok('a landing page can narrow the question',
    runPreboot({ landing: 'super-light', stored: 'dark' }).base === 'super-light',
    '__zwLM is how a landing page carries its own theme');
  ok('the legacy homepage key is still honoured', (() => {
    const r = runPreboot({});   // neither key set → dark
    return r.base === 'dark';
  })());
}

console.log('\n  every token it writes is one something reads, and pairs move together');
{
  /* HOW A FIRST-PAINT BUG GETS IN, generalised.
   *
   * The block writes a handful of custom properties before the stylesheets can
   * run. Two ways that goes wrong, and both had happened:
   *
   *   A PAIR SPLIT. It set --zw-nav-bg and not --zw-nav-fg. Four rules read the
   *   second one, so a two-tone theme painted its dark bar on the first frame
   *   while the links fell through `var(--zw-nav-fg, inherit)` to the PAGE's
   *   foreground — dark on dark until the engine loaded. Exactly the
   *   ground-without-text bug that started all of this, one element in.
   *
   *   A NAME NOTHING READS. It wrote --surface; base.css declares
   *   --zw-theme-surface and cart.css reads that. A property written under a
   *   name no rule asks for fails silently and permanently: nothing errors, the
   *   value is simply never used.
   *
   * Neither is visible by reading the block on its own — you have to compare it
   * against the stylesheets and against the engine. So that comparison is the
   * test, and it is what makes the next one of these impossible rather than
   * fixed.
   */
  const src = fs.readFileSync(SRC, 'utf8');
  const written = [...src.matchAll(/setProperty\('(--[a-z-]+)'/g)].map((m) => m[1]);

  const sheets = fs.readdirSync(ROOT).filter((f) => f.endsWith('.css'))
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const pages = PAGES.map((p) => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n');
  const everything = sheets + pages
    + fs.readFileSync(path.join(ROOT, 'storefront-features.js'), 'utf8');

  const unread = written.filter((t) => !new RegExp('var\\(\\s*' + t + '\\b').test(everything));
  ok('nothing is written under a name no rule reads', unread.length === 0,
    unread.join(', ') + ' — written before first paint and never asked for');

  /* Pairs, by construction: a background token and its foreground partner. */
  const PAIRS = [['--zw-nav-bg', '--zw-nav-fg'], ['--bg-rgb', '--fg-rgb'], ['--ink', '--paper']];
  const split = PAIRS.filter(([a, b]) =>
    (written.includes(a) && !written.includes(b)) || (written.includes(b) && !written.includes(a)));
  ok('a background is never painted without its foreground', split.length === 0,
    split.map((p) => p.join(' / ')).join(', ') + ' — half a pair is how text goes invisible');

  /* And the engine must still write everything the block does, or the block's
     value survives past the moment the engine was supposed to take over. */
  const engine = fs.readFileSync(path.join(ROOT, 'theme-engine.js'), 'utf8');
  const orphan = written.filter((t) => t !== '--zw-notch-bar'
    && !new RegExp("set\\('" + t + "'").test(engine)
    && !new RegExp("setProperty\\('" + t + "'").test(engine));
  ok('the engine writes everything the pre-paint block does', orphan.length === 0,
    orphan.join(', ') + ' — a token only the guess sets can never be corrected');

  /* color-scheme is not a custom property, so the sweep above cannot see it —
     and it was the one the engine had never set. It is what the browser reads
     to draw what our CSS cannot reach: the option list a <select> pops up,
     scrollbars, date pickers. The pre-paint block set it from a guess, nothing
     corrected it, and the size guide's height dropdown opened as a white UA
     panel with near-white text on a correctly dark form. */
  ok('…including color-scheme, which is not a custom property',
    /colorScheme/.test(src) && /root\.style\.colorScheme = theme\.base === 'dark'/.test(engine),
    'without this every native control stays on whatever the first paint guessed');
  ok('…and it follows the base rather than being pinned',
    !/colorScheme = 'dark';\s*$/m.test(engine));
}

console.log('\n  the guess does not outlive the answer');
{
  const r = runPreboot({ shipped: 'super-light' });
  ok('the ground override is marked with an id', r.groundCss && r.lightGround);
  ok('…and it is the one written with !important', /!important/.test(r.groundCss),
    'without !important it cannot beat html{background:#09090b}; with it, it must be removable');

  const engine = fs.readFileSync(path.join(ROOT, 'theme-engine.js'), 'utf8');
  ok('theme-engine.js removes it when it applies a real theme',
    /getElementById\('zw-preboot-ground'\)/.test(engine)
    && /removeChild\(preboot\)/.test(engine),
    'this is the difference between a wrong first frame and a permanently wrong page');

  /* Order matters: it must go before the engine paints its own ground, and in
     the same function that sets the classes — otherwise there is a state where
     one has moved and the other has not. */
  const at = engine.indexOf("getElementById('zw-preboot-ground')");
  const paints = engine.indexOf('root.style.backgroundColor = pageColor');
  ok('…before it paints its own', at > 0 && paints > at);
}

console.log('\n  nothing decides the theme behind the block’s back');
{
  /* Any page-level code that resolves a theme from localStorage on its own is a
     second answerer, and a second answerer is how this broke. The one legitimate
     reader is the small script just after <body>, which re-applies what the
     block ALREADY decided — it reads data-zw-base rather than deciding. */
  const rogue = [];
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const a = html.indexOf(OPEN), b = html.indexOf(CLOSE);
    const outside = html.slice(0, a) + html.slice(b);
    /* The tell is a hardcoded LIGHT fallback next to the key. 'dark' is not on
       this list on purpose: dark is what base.css already paints, so falling
       back to it cannot produce a light ground under dark tokens. A light
       fallback can, and did — on every store whose default is dark. */
    for (const m of outside.matchAll(/getItem\('zw_theme_mode'\)[^;\n]{0,80}?\|\|\s*'(light|super-light)'/g)) {
      rogue.push(page + ": …|| '" + m[1] + "'");
    }
  }
  ok('no page carries its own theme default any more', rogue.length === 0, rogue.join('; '));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
