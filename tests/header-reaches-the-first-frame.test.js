/* The header arrangement has to be in the HTML when it arrives.
 *
 * Three answers already deliver it and each has a window where it is wrong:
 * the build's bake is right until the next publish; the browser cache is right
 * from a visitor's SECOND load after a change; the runtime fetch is always
 * right and always after the first frame. Between a publish and the next deploy
 * a visitor sees the old header and watches it change.
 *
 * functions/_middleware.js closes that by stamping the current arrangement into
 * the document as it is served. Which puts a piece of code in front of every
 * page on the site — so what this file mostly checks is that it CANNOT BREAK
 * ONE. Every failure path has to return the page untouched, because the page
 * untouched is still a working page that corrects itself.
 *
 * There is no Workers runtime here, so onRequest is driven against stubs. That
 * is enough for what is actually at risk: the branches, not HTMLRewriter.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  - ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const SRC = read('functions/_middleware.js');

/* ── Stubs ──────────────────────────────────────────────────────────────────
   A recording HTMLRewriter: it never parses anything, it just hands the
   handler an element that remembers what was set on it. */
let lastStamped = null;
global.HTMLRewriter = class {
  on(sel, handler) { this.sel = sel; this.handler = handler; return this; }
  transform(res) {
    const el = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
    this.handler.element(el);
    lastStamped = { selector: this.sel, attrs: el.attrs };
    return { ...res, __rewritten: true };
  }
};

const htmlRes = () => ({ headers: { get: () => 'text/html; charset=utf-8' }, body: 'page' });
const jsonRes = () => ({ headers: { get: () => 'application/json' }, body: '{}' });

function ctx(url, opts = {}) {
  return {
    request: { url, method: opts.method || 'GET' },
    env: {},
    next: async () => (opts.res || htmlRes()),
  };
}

let fetchCalls = 0;
function stubFetch(value, { ok: isOk = true, throws = false } = {}) {
  fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls++;
    if (throws) throw new Error('network');
    return { ok: isOk, json: async () => (value === undefined ? [] : [{ value }]) };
  };
}

(async () => {
  const mod = await import('../functions/_middleware.js');
  const { onRequest, attrsFrom } = mod;

  const GOOD = { id: 'logo-center', lines: 'off',
    spec: { logo: 'center', links: 'left', actions: 'right', linksRow: 1 } };

  console.log('\nThe arrangement is written into the document');
  {
    stubFetch(GOOD);
    lastStamped = null;
    const res = await onRequest(ctx('https://zuwera.store/'));
    ok('a page gets the attributes stamped on <html>',
      !!res.__rewritten && lastStamped && lastStamped.selector === 'html');
    ok('...with the placement the store published',
      lastStamped.attrs['data-zw-hdr-logo'] === 'center'
      && lastStamped.attrs['data-zw-hdr-links'] === 'left'
      && lastStamped.attrs['data-zw-hdr-actions'] === 'right'
      && lastStamped.attrs['data-zw-hdr-linksrow'] === '1');
    ok('...and the divider choice', lastStamped.attrs['data-zw-hdr-lines'] === 'off');
    ok('the settings read is cached at the edge', /cacheTtl: TTL/.test(SRC),
      'one origin read per location per TTL, not one per visitor');
    ok('...and starts before the page is fetched, not after',
      SRC.indexOf('const pending = skip ? null : headerAttrs') < SRC.indexOf('await context.next()'),
      'in sequence it would add its latency to every page load');
  }

  console.log('\nIt resolves nothing, because the table it would need is browser code');
  {
    /* header-layouts.js owns names → placements. It cannot be imported into a
       Worker, and a second copy at the edge is the duplication this feature has
       already been bitten by. So the builder writes the resolved values. */
    const L = require('../scripts/stamp-header-layout.js').loadLayouts();
    ok('no layout name appears in the middleware',
      !L.list.some((l) => SRC.includes("'" + l.id + "'")),
      'a copy of the layout table at the edge is a second thing to keep in step');
    ok('a row with no resolved placement stamps no placement',
      attrsFrom({ id: 'logo-center' }) === null,
      'and so falls back to the baked answer, which is still correct');
    ok('...but its divider choice is still honoured',
      JSON.stringify(attrsFrom({ id: 'x', lines: 'off' })) === '{"data-zw-hdr-lines":"off"}',
      'the two are independent everywhere else too');
    ok('the builder writes the resolved placement when it saves',
      /if \(l\) out\.spec = l\.spec;/.test(read('builder.html')));
  }

  console.log('\nA value it does not understand is not written through');
  {
    ok('an unknown spot is refused',
      attrsFrom({ spec: { logo: 'middle', links: 'left', actions: 'right', linksRow: 1 } }) === null,
      'an attribute the stylesheet has no rule for still reads as placed, and blanks the header');
    ok('"none" is allowed for the categories only',
      !!attrsFrom({ spec: { logo: 'left', links: 'none', actions: 'right', linksRow: 1 } })
      && attrsFrom({ spec: { logo: 'none', links: 'left', actions: 'right', linksRow: 1 } }) === null);
    ok('a junk linksRow falls back rather than being written',
      attrsFrom({ spec: { logo: 'left', links: 'left', actions: 'right', linksRow: 9 } })['data-zw-hdr-linksrow'] === '1');
    ok('a junk divider value is dropped',
      attrsFrom({ id: 'x', lines: 'maybe' }) === null);
    ok('nothing at all is null, not an empty stamp', attrsFrom(null) === null && attrsFrom('x') === null);
  }

  console.log('\nIt can only ever fall back');
  {
    stubFetch(GOOD);
    const api = await onRequest(ctx('https://zuwera.store/api/tax-quote', { res: jsonRes() }));
    ok('an API route is left alone, and costs no settings read',
      !api.__rewritten && fetchCalls === 0);

    stubFetch(GOOD);
    const post = await onRequest(ctx('https://zuwera.store/', { method: 'POST' }));
    ok('a non-GET is left alone', !post.__rewritten && fetchCalls === 0);

    stubFetch(GOOD);
    const prev = await onRequest(ctx('https://zuwera.store/?builder=1'));
    ok('a builder preview is left alone', !prev.__rewritten && fetchCalls === 0,
      'stamping the PUBLISHED arrangement over a draft preview is the one actively misleading case');

    stubFetch(GOOD);
    const asset = await onRequest(ctx('https://zuwera.store/', { res: jsonRes() }));
    ok('anything that is not HTML is left alone', !asset.__rewritten);

    stubFetch(undefined);
    ok('no row means the page is served as it was',
      !(await onRequest(ctx('https://zuwera.store/'))).__rewritten);

    stubFetch(GOOD, { ok: false });
    ok('a failed settings read means the page is served as it was',
      !(await onRequest(ctx('https://zuwera.store/'))).__rewritten);

    stubFetch(GOOD, { throws: true });
    ok('a settings read that THROWS does not take the page down',
      !(await onRequest(ctx('https://zuwera.store/'))).__rewritten,
      'an unhandled rejection here would 500 every page on the site');

    stubFetch(GOOD);
    const saved = global.HTMLRewriter;
    global.HTMLRewriter = class { on() { return this; } transform() { throw new Error('boom'); } };
    ok('a rewrite that throws still returns the page',
      !!(await onRequest(ctx('https://zuwera.store/'))).body);
    global.HTMLRewriter = saved;

    ok('and the whole rewrite sits inside a catch', /\} catch \(_\) \{\s*return res;/.test(SRC));
  }

  console.log('\nEvery page that pre-paints is routed through it');
  {
    const routes = JSON.parse(read('_routes.json'));
    /* A page carrying the pre-paint block but missing from the routes is a page
       that silently keeps the stale answer — the exact failure this replaces,
       on one URL instead of all of them. */
    const PAGES = require('../scripts/stamp-header-layout.js').PAGES;
    const clean = (p) => (p === 'index.html' ? '/' : '/' + p.replace(/\.html$/, ''));
    const missing = PAGES.map(clean)
      /* Two that are not plain clean URLs and are already routed:
         404 is served for any unmatched path and has no route of its own, and
         product.html is served under /product/<slug> by its own Function, which
         the list covers with a wildcard. */
      .filter((p) => p !== '/404' && p !== '/product')
      .filter((p) => !routes.include.includes(p));
    ok('the route list covers every pre-painting page', missing.length === 0, 'missing: ' + missing.join(', '));
    ok('...and still routes the API and product pages', routes.include.includes('/api/*')
      && routes.include.includes('/product/*'),
      'dropping these would take the whole API offline');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
