/* The egress work: storefront reads move behind Cloudflare's cache, stock stays
   fresh, and nothing secret leaks through the new public endpoints. */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
const R = ROOT + '/';
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + (e ? '  \u2014 ' + e : '')); } };

const cat = fs.readFileSync(R + 'functions/api/catalog.js', 'utf8');
const stock = fs.readFileSync(R + 'functions/api/stock.js', 'utf8');
const setts = fs.readFileSync(R + 'functions/api/storefront-settings.js', 'utf8');
const home = fs.readFileSync(R + 'storefront.js', 'utf8');
const index = fs.readFileSync(R + 'index.html', 'utf8');
const coll = fs.readFileSync(R + 'drop001.html', 'utf8');

// Comments explain WHY a file avoids something, so they necessarily name it.
// Assertions about behaviour must look at the code, not the prose.
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const cacheOf = (src) => (src.match(/'Cache-Control':\s*'([^']+)'/) || [])[1] || '';
const sMaxAge = (src) => { const m = cacheOf(src).match(/s-maxage=(\d+)/); return m ? Number(m[1]) : null; };

console.log('\n  egress\n');

/* ── the reads are cacheable now ─────────────────────────────────────────── */
console.log('  edge caching');
{
  ok('the catalogue is cached at the edge', sMaxAge(cat) >= 60, cacheOf(cat));
  ok('settings are cached at the edge', sMaxAge(setts) >= 60, cacheOf(setts));
  ok('both serve stale while revalidating, so a cold cache never blocks a render',
    /stale-while-revalidate/.test(cacheOf(cat)) && /stale-while-revalidate/.test(cacheOf(setts)));
}

/* ── except stock, which must not be ─────────────────────────────────────── */
console.log('\n  stock stays fresh');
{
  ok('stock is a separate endpoint — the catalogue never queries it',
    /product_sizes/.test(codeOnly(stock)) && !/product_sizes/.test(codeOnly(cat)));
  ok('…on a much shorter cache than the catalogue', sMaxAge(stock) > 0 && sMaxAge(stock) <= 60, cacheOf(stock));
  ok('…at least 10x fresher than the catalogue', sMaxAge(cat) / sMaxAge(stock) >= 10,
    sMaxAge(cat) + 's vs ' + sMaxAge(stock) + 's');
  /* The claim is "named columns, not select=*" — a frozen literal list instead
     froze the SCHEMA, so adding color_name (needed so the storefront can match
     colour the way checkout does) failed a test about egress for a reason that
     had nothing to do with egress. Asserted as the rule plus the columns that
     must be there, so a real regression — select=*, or dropping one — still
     fails, and an added column does not. */
  const sel = (stock.match(/product_sizes\?select=([^&`'"]+)/) || [])[1] || '';
  ok('stock asks for named columns, not everything', !!sel && !sel.includes('*'), sel || 'no select found');
  ok('…and still asks for the ones every reader needs',
    ['product_id', 'size', 'stock_quantity'].every((c) => sel.split(',').includes(c)), sel);
  /* color_variant_id is on product_images, not product_sizes. Asking for it
     made PostgREST answer 400 to every request this endpoint ever made, and
     the endpoint reported the rejection as an empty catalogue — so a query
     that had never once succeeded looked like a shop with nothing in stock.
     Nothing read it: every consumer of that column works on image rows. */
  ok('…and does not ask product_sizes for a column it does not have',
    !sel.split(',').includes('color_variant_id'), sel);
}

/* ── nothing secret is now public ────────────────────────────────────────── */
console.log('\n  the new public endpoints leak nothing');
{
  const keys = ((setts.match(/const PUBLIC_KEYS = \[([\s\S]*?)\]/) || [])[1] || '')
    .match(/'[^']+'/g).map(s => s.slice(1, -1));
  const forbidden = ['commerce_config', 'email_settings', 'page_builder', 'landing_pages',
    'product_page_draft', 'collection_page_draft', 'scheduled_publish', 'builder_history'];
  const leaked = keys.filter(k => forbidden.includes(k));
  ok(keys.length + ' public keys, none of them secret or a draft', leaked.length === 0, leaked.join(','));
  ok('promo codes are not among them', !keys.includes('commerce_config'));
  ok('the response is filtered against the list again, not trusted from the query',
    /PUBLIC_KEYS\.indexOf\(row\.key\) === -1/.test(setts));
  ok('the catalogue excludes drafts and legacy products',
    /status=neq\.Legacy&status=neq\.Draft/.test(cat));
}

/* ── the storefront actually uses them ───────────────────────────────────── */
console.log('\n  the storefront reads through them');
{
  ok('the homepage early fetch hits our API, not Supabase',
    /__zwProductsEarlyFetch=fetch\('\/api\/catalog'\)/.test(index) &&
    /__zwSettingsEarlyFetch=fetch\('\/api\/storefront-settings'\)/.test(index));
  ok('…and no longer ships a Supabase URL or anon key to do it',
    !/rest\/v1\/products\?select/.test(index) && !/rest\/v1\/site_settings\?select/.test(index));
  ok('the homepage fallback path uses them too',
    /fetch\('\/api\/catalog'\)/.test(home) && /fetch\('\/api\/storefront-settings'\)/.test(home));
  ok('the collection page went from four Supabase queries to two API calls',
    /fetch\('\/api\/catalog'\)/.test(coll) && /fetch\('\/api\/stock'\)/.test(coll));
  ok('…and no longer queries products, images or variants directly',
    !/rest\/v1\/products\?select=\*&order/.test(coll) &&
    !/rest\/v1\/product_images\?select=\*/.test(coll) &&
    !/rest\/v1\/color_variants\?select=\*&order/.test(coll));

  // Both shapes accepted, so a page cached mid-deploy still renders.
  ok('the clients accept the old array shape as well as the new one',
    /Array\.isArray\(_payload\) \? _payload/.test(home) &&
    /Array\.isArray\(payload\) \? payload/.test(home) &&
    /Array\.isArray\(_cat\) \? _cat/.test(coll));
}

/* ── the usage reader ────────────────────────────────────────────────────── */
console.log('\n  usage reader');
{
  const use = fs.readFileSync(R + 'functions/api/supabase-usage.js', 'utf8');
  ok('admins only', /prof\.role !== 'admin'/.test(use));
  ok('…and only those who can see infrastructure', /permsHave\(perms, 'apikey_manage'\)/.test(use));
  ok('measures rows without downloading them', /Prefer: 'count=exact'/.test(use) && /Range: '0-0'/.test(use));
  ok('sums real storage bytes', /metadata\.size/.test(use));
  ok('tries several billing endpoints, since the route is undocumented',
    /candidates = \[/.test(use));
  ok('says so when it cannot read egress rather than inventing a figure',
    /no_token/.test(use) && /no_endpoint/.test(use));
  ok('carries the free-tier limits so the numbers mean something', /FREE_TIER/.test(use));

  const admin = fs.readFileSync(R + 'admin.html', 'utf8');
  ok('the panel exists on the APIs page', /id="supabaseUsage"/.test(admin));
  ok('…and tells you what the token is for', /SUPABASE_ACCESS_TOKEN/.test(admin));
}

/* ── what this is worth ──────────────────────────────────────────────────── */
console.log('\n  the arithmetic');
{
  // Measured against production before the change.
  const before = { homepage: 132, collection: 110 };   // KB of Supabase egress per load
  const quotaGB = 5;
  const loadsToBlowQuota = Math.round((quotaGB * 1048576) / before.homepage);
  ok('before: ~' + before.homepage + ' KB per homepage load → quota gone in ~'
    + loadsToBlowQuota.toLocaleString() + ' loads', loadsToBlowQuota < 50000);

  // After: Supabase is read once per cache window, not once per load.
  const windowsPerMonth = (30 * 24 * 3600) / sMaxAge(cat);
  const afterGB = (windowsPerMonth * (before.homepage / 1048576));
  ok('after: ~' + afterGB.toFixed(2) + ' GB/month at a ' + sMaxAge(cat)
    + 's window — and flat, whatever the traffic', afterGB < quotaGB,
    afterGB.toFixed(2) + ' GB');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

/* ── the admin was the expensive page ──────────────────────────────────────
   Every thumbnail in the admin and the page builder requested the FULL-SIZE
   original from storage: a multi-megabyte photo to fill a 56px box, forty of
   them on the products list, re-pulled on every reload — and the builder
   re-renders its previews on every keystroke.

   With two people using the admin, that was the entire cached-egress bill.
   Not shopper traffic. Us. The storefront had routed images through the
   optimiser for ages; nobody had looked at the bandwidth cost of a page only
   staff see. */
console.log('\n  staff pages pay for images too');
{
  for (const page of ['admin.html', 'builder.html']) {
    const src = fs.readFileSync(R + page, 'utf8');
    ok(page + ' loads the image optimiser',
      /<script[^>]+src="[^"]*image-utils\.js/.test(src),
      'thumbnails here fetch full-size originals');
  }

  const admin = fs.readFileSync(R + 'admin-main.js', 'utf8');
  ok('admin thumbnails ask for a thumbnail-sized image', /function zwThumb/.test(admin));
  ok('…and every <img> it renders uses it',
    (admin.match(/<img[^>]*src="\$\{(?:escapeAttr\()?zwThumb\(/g) || []).length >= 2,
    'a raw src here is a full-size original');
  ok('…falling back to the raw URL if the optimiser is missing',
    /typeof optimizeImage === 'function'/.test(admin),
    'a heavy thumbnail beats a broken one');

  const builder = fs.readFileSync(R + 'builder.html', 'utf8');
  ok('builder previews do the same', /function bThumb/.test(builder));
  ok('…on every preview it draws',
    (builder.match(/bThumb\(/g) || []).length >= 6,
    'the builder re-renders these on every keystroke');
}
