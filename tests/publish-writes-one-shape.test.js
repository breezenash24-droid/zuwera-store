/* Publish stopped working, and no regex would have caught it.
 *
 *     {"code":"PGRST102","message":"All object keys must match"}
 *
 * PostgREST turns a JSON array into ONE insert, which has one column list, so
 * every object in the array must carry the same keys. /api/save-page-builder
 * writes a second row when a draft is published — the draft's value copied onto
 * its live key — and updated_at had been stamped onto the first row, where the
 * list was built, rather than onto all of them once it was complete. Two keys on
 * one row, three on another, and the whole write was rejected.
 *
 * Which means it failed for exactly the saves that matter: every Publish of the
 * Product and Collection tabs, page_builder, landing_pages, and the six drafts
 * in DRAFT_TO_LIVE — the nav, the announcement bar, page copy, the header
 * arrangement and the bag panel. A plain Save still worked, because it writes
 * one row and one row is always self-consistent.
 *
 * So this drives the endpoint rather than reading it: stub the network, post a
 * publish for every key that produces more than one row, and look at the body it
 * would have sent. A test that matched source text would have been happy with
 * the broken version.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const ENV = {
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  ZW_SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_URL: 'https://example.supabase.co',
};

/* Everything the handler asks the network for, answered the way a permitted
   admin's request would be — and the one write it makes, captured. */
function stubFetch(captured) {
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) {
      return { ok: true, json: async () => ({ id: 'admin-1' }) };
    }
    if (u.includes('/rest/v1/profiles')) {
      return { ok: true, json: async () => ([{ role: 'admin', admin_role: 'super_admin', admin_permissions: null }]) };
    }
    if (u.includes('/rest/v1/site_settings')) {
      captured.push({ url: u, body: JSON.parse(opts.body) });
      return { ok: true, text: async () => '', json: async () => ({}) };
    }
    return { ok: false, status: 404, text: async () => 'unexpected ' + u, json: async () => ({}) };
  };
}

function post(body) {
  return { request: { json: async () => body }, env: ENV };
}

(async () => {
  const mod = await import('file://' + path.join(ROOT, 'functions/api/save-page-builder.js').replace(/\\/g, '/'));

  console.log('\n  every row of a publish carries the same keys\n');

  /* Read from the module rather than restated here: a draft added to the map
     without being added to this list would go untested, which is the shape of
     the bug this file exists for. */
  const src = require('fs').readFileSync(path.join(ROOT, 'functions/api/save-page-builder.js'), 'utf8');
  const drafts = [...src.matchAll(/^\s{2}(\w+_draft): '/gm)].map((m) => m[1]);
  ok('the draft→live map has entries to test', drafts.length >= 6, drafts.join(', '));

  const cases = drafts.map((k) => [k, { rows: 'draft' }])
    .concat([['page_builder', { sections: [] }], ['landing_pages', { pages: {} }]]);

  for (const [key, value] of cases) {
    const captured = [];
    const realFetch = global.fetch;
    global.fetch = stubFetch(captured);
    let res;
    try {
      res = await mod.onRequestPost(post({ accessToken: 't', key, value, published: true }));
    } finally { global.fetch = realFetch; }

    const wrote = captured[0];
    if (!wrote) {
      ok('  ' + key + ' reaches the write', false, 'status ' + (res && res.status));
      continue;
    }
    const rows = wrote.body;
    const shapes = rows.map((r) => Object.keys(r).sort().join(','));
    const same = shapes.every((s) => s === shapes[0]);
    ok('  ' + key + ' → ' + rows.length + ' row(s), one shape', same,
      'PostgREST rejects the whole write otherwise: ' + shapes.join('  vs  '));
    ok('    ...and every row is stamped', rows.every((r) => typeof r.updated_at === 'string' && r.updated_at),
      'the pre-paint block ranks the cache against the bake by this column');
    ok('    ...with the same instant, because it is one write',
      new Set(rows.map((r) => r.updated_at)).size === 1);
  }

  console.log('\n  a plain save still writes exactly one row');
  {
    const captured = [];
    const realFetch = global.fetch;
    global.fetch = stubFetch(captured);
    try {
      await mod.onRequestPost(post({ accessToken: 't', key: 'header_layout_draft', value: { id: 'classic' }, published: false }));
    } finally { global.fetch = realFetch; }
    ok('the draft key alone', captured[0] && captured[0].body.length === 1
      && captured[0].body[0].key === 'header_layout_draft',
      'Save must not publish; that distinction is the whole point of the draft keys');
    ok('...stamped too, so a draft can be ranked as well',
      captured[0] && typeof captured[0].body[0].updated_at === 'string');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
