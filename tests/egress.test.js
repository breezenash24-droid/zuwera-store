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

/* ── what gets uploaded is what gets paid for ──────────────────────────────
   The storage plan has no image transformations, so nothing downsizes a file
   after the fact: a 4MB photo off a phone stays 4MB and is served at 4MB
   forever. The only place that can be fixed is before it leaves the browser. */
console.log('\n  uploads are shrunk before they are stored');
{
  const admin = fs.readFileSync(R + 'admin-main.js', 'utf8');
  ok('there is a downscale step', /function zwDownscaleImage/.test(admin));
  ok('…and the upload path actually uses it',
    /zwDownscaleImage\(file\)/.test(admin), 'defined but never called');

  /* Each of these is a way a naive resize quietly ruins a file. */
  ok('animations are left alone', /gif\|svg/.test(admin),
    'a canvas keeps only the first frame of a GIF');
  ok('vectors are left alone', /svg/.test(admin),
    'rasterising an SVG throws away the one thing it is good at');
  ok('a re-encode that grew the file is discarded',
    /blob\.size >= file\.size/.test(admin),
    'already-optimised files usually get bigger, not smaller');
  ok('a failed optimisation still uploads the original',
    /catch \(_\) \{ resolve\(file\); \}/.test(admin),
    'a failed optimisation must never become a failed upload');
  ok('non-images pass straight through', admin.includes('^image'),
    'a video or PDF must not be handed to a canvas');
}

console.log('\n  the legacy bucket can be measured');
{
  /* "Migrate the legacy images" was impossible to scope without knowing how
     many there are, how big, and whether anything still points at them. */
  const admin = fs.readFileSync(R + 'admin-main.js', 'utf8');
  ok('there is a report for what is still on Supabase', /zwLegacyImageReport/.test(admin));
  ok('…which separates files still in use from orphans', /referenced/.test(admin),
    'an orphan costs storage but no egress — they are not the same problem');
  ok('…and reads, never writes', !/zwLegacyImageReport[\s\S]{0,3000}\.remove\(/.test(admin),
    'a reporting tool must not be able to delete anything');
}


/* ── moving media, which is the dangerous one ─────────────────────────────
   Three tools with very different risk. Surveying is free. Deleting is
   irreversible but only touches files nothing points at. MOVING rewrites the
   references that make the homepage render, and a half-finished move is a
   broken store. */
console.log('\n  the media tools cannot quietly break the store');
{
  const a = fs.readFileSync(R + 'admin-main.js', 'utf8');
  ok('there is one scan behind all of them', /async function zwMediaScan/.test(a),
    'a panel and an action that disagree would act on something you did not see');

  /* A source that failed to load must stop everything. Reporting a file as
     unused when we simply could not check is how you delete a homepage. */
  ok('a move refuses to run on an incomplete scan',
    a.includes("Not moving anything."));
  ok('…and so does a delete',
    a.includes("Not deleting anything."));

  ok('both preview before they act', a.includes('const confirmed = !!(opts && opts.confirm)'));
  ok('…and only a deliberate flag carries them out',
    (a.match(/if \(!confirmed\)/g) || []).length >= 2);

  /* Order is the whole safety story: upload first, rewrite after the new URL
     exists, verify the rewrite, leave the original alone. */
  ok('a move verifies the rewrite landed before believing it',
    a.includes('old URL still referenced after rewrite'),
    'a rewrite that silently failed would leave the page pointing at a file about to look deletable');
  ok('…and never deletes the original in the same pass',
    a.includes('The originals are still on Supabase'));
  ok('…and does not downscale on the way, which would ruin a video',
    a.includes('would re-encode a video and silently'));
}


console.log('\n  and they are buttons, not console commands');
{
  const a = fs.readFileSync(R + 'admin-main.js', 'utf8');
  const h = fs.readFileSync(R + 'admin.html', 'utf8');
  ok('the panel has real action buttons', /zwMediaAction\('migrate'\)/.test(h) && /zwMediaAction\('delete'\)/.test(h));
  ok('…that name the files before doing anything', /_zwMediaPending = kind/.test(a),
    'a one-click destructive action is not a question anyone answers');
  ok('…and take a second, separate confirmation', /window\.zwMediaConfirm/.test(a));
  ok('…which can be cancelled', /window\.zwMediaCancel/.test(a));
  ok('…and refuses outright on an incomplete scan',
    a.includes('so nothing here is safe to act on'));
  ok('after a move it says to check the site before deleting',
    a.includes('check the video still plays'),
    'the originals are the safety net, and only work if somebody looks');
}


/* ── the migration has to be able to carry video ──────────────────────────
   Its first real run moved nothing. The R2 endpoint accepted four image types
   and refused everything else, so both videos came back 400 — which is also why
   they were on Supabase to begin with: refused here, they went there instead,
   where every play is billed.

   The failure was reported as "Moved 0 file(s)" with the reason in a console
   nobody had open. Both halves are fixed: video is allowed, and a per-file
   refusal is shown on the page. */
console.log('\n  video can reach R2, and a refusal says why');
{
  const up = fs.readFileSync(R + 'functions/api/upload-product-image.js', 'utf8');
  ok('the upload endpoint accepts video', /ALLOWED_VIDEO_TYPES/.test(up));
  ok('…mp4, webm and mov', ['video/mp4', 'video/webm', 'video/quicktime'].every((t) => up.includes(t)));
  ok('…with a cap of its own, since a hero clip is legitimately large',
    /MAX_VIDEO_BYTES/.test(up) && /MAX_IMAGE_BYTES/.test(up),
    'one cap for both means either images go unchecked or video is refused');
  ok('…and images stay capped tight', up.includes('6 * 1024 * 1024'));
  ok('a refusal names the type it got', up.includes('Got: '),
    '"not allowed" without saying what arrived is a dead end');

  const a = fs.readFileSync(R + 'admin-main.js', 'utf8');
  ok('a failed file is returned, not only logged', /done\.failed = failed/.test(a));
  ok('…and shown on the page with its reason', /could not be moved/.test(a));
  ok('…while saying the file itself is untouched', /nothing about them changed/.test(a));
}


/* ── one destination, not two ─────────────────────────────────────────────
   Two upload routes existed: products went to R2 (free egress), builder media
   went to Supabase Storage (billed). Every hero image and video the page
   builder placed landed in the expensive one — which is where the entire
   cached-egress bill came from, and it would have rebuilt itself after any
   cleanup for as long as the second route existed. */
console.log('\n  uploads have one destination');
{
  const b = fs.readFileSync(R + 'functions/api/upload-image.js', 'utf8');
  ok('builder media goes to R2', /putR2Object/.test(b));
  ok('…through the same helpers the product uploader uses',
    /from '\.\/upload-product-image\.js'/.test(b),
    'a second R2 path is a second thing to drift');
  ok('…and no longer writes to Supabase Storage',
    !/storage\/v1\/object\/[^p]/.test(b) && !/x-upsert/.test(b));
  ok('…with a cap that fits a hero video', /100 \* 1024 \* 1024/.test(b));

  /* Falling back to Supabase on an R2 failure would silently restore exactly
     the behaviour this removed, and stay invisible until the next bill. */
  ok('a failure is reported rather than falling back to the billed store',
    b.includes('Upload failed: ') && !/SUPABASE_SERVICE_ROLE_KEY/.test(b));

  ok('the session check is unchanged', /auth\/v1\/user/.test(b) && /Invalid or expired session/.test(b),
    'moving where bytes land must not move who may put them there');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
