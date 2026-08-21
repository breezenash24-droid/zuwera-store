/* Cloudinary was not the only identifier a fork could not change.
   ═══════════════════════════════════════════════════════════════════════════

   Five more were baked in, and they fail worse than Cloudinary did. That one
   only spent the original store's image credits. These send a licensee's
   pageviews to THIS GA4 property, its conversions to THIS Ads account, its
   customers' Purchase events — value, order id, contents — to THIS Meta pixel,
   its funnel to THIS PostHog project, and ask THIS Turnstile site key to vouch
   for its visitors.

   Every one of them is silent. The shop works. The original store's reporting
   quietly fills with someone else's traffic and cannot be unmixed afterwards.

   ── TWO OF THEM DO NOT EVEN FAIL QUIETLY ────────────────────────────────────

   A Turnstile site key is bound to a hostname list. A fork keeping this one
   does not merely report to the wrong account — the challenge FAILS on a domain
   it was never issued for, every time. auth.js line ~395 blocks sign-in without
   a token, and admin-main.js renders the same key on the admin login. So the
   inherited captcha locks a licensee's customers out of the newsletter and its
   administrator out of the panel.

   And the R2 host reaches the CSP, which scripts/stamp-project-config.js could
   not see: _headers is neither .js nor .html, so shippedFiles() never walked
   it. A fork would repoint its image host everywhere except the one place that
   decides whether the browser may load from it — and img-src allows `https:`
   wholesale, so only VIDEO breaks. Images keep working, which is what makes it
   hard to find.

   ── "OFF" HAD TO BECOME A REAL ANSWER ───────────────────────────────────────

   The stamp could only SUBSTITUTE. A fork with no Meta advertising had no way
   to say so, and an unset variable left the literal standing — which is exactly
   the bug. Optional rules now accept off/none/false/0/- and stamp an empty
   string, and every consumer treats empty as "this store does not use that
   service". Three states where there were two: unset, substituted, erased.

   ── AND ONE TRAP WORTH THE WHOLE FILE ───────────────────────────────────────

   The admin media census asked `(r.image_url||'').includes(HOST)` in three
   places. EVERY STRING CONTAINS THE EMPTY STRING. A fork that turned R2 off
   would not have counted zero R2 files — it would have counted every file as
   R2-hosted and reported a storage bill for images it does not store. A
   substring test against configuration that may legitimately be empty is a
   trap, so there is one zwIsOwnImageHost() and the three call sites use it. */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const CANON = require(path.join(ROOT, 'zw-config.js'));
const STAMP = read('scripts/stamp-project-config.js');
const HEADERS = read('_headers');

console.log('\n  a fork reports into its own accounts\n');

/* ── The values zw-config.js is supposed to govern ──────────────────────────
   Keyed by the config field, with the files each literal actually lives in.
   A new consumer of one of these has to be added here, which is the point. */
const GOVERNED = [
  { field: 'gaMeasurementId',  env: 'ZW_GA_MEASUREMENT_ID',   files: ['google-tag.js'] },
  { field: 'googleAdsId',      env: 'ZW_GOOGLE_ADS_ID',       files: ['google-tag.js'] },
  { field: 'metaPixelId',      env: 'ZW_META_PIXEL_ID',       files: ['meta-pixel.js'] },
  { field: 'posthogKey',       env: 'ZW_POSTHOG_KEY',         files: ['posthog-init.js'] },
  { field: 'turnstileSiteKey', env: 'ZW_TURNSTILE_SITE_KEY',  files: ['zw-turnstile.js', 'auth.js', 'admin-main.js'] },
  { field: 'imageHost',        env: 'ZW_IMAGE_HOST',          files: ['admin-main.js'] },
];

console.log('  every account is named in one place');
{
  for (const g of GOVERNED) {
    ok('zw-config.js declares ' + g.field,
      typeof CANON[g.field] === 'string' && CANON[g.field].length > 0,
      'a value the stamp cannot read is a value a fork cannot change');
    ok('…and the stamp has a rule for it',
      STAMP.includes("'" + g.env + "'") && STAMP.includes('CANON.' + g.field),
      'declared but unstamped is worse than undeclared — it looks handled');
  }
}

console.log('\n  and every file that carries one is reachable by the stamp');
{
  /* SKIP_DIRS in the stamp excludes functions/ (Workers read env at runtime),
     tests/ (this file quotes the literals on purpose) and dist/ (rebuilt). */
  for (const g of GOVERNED) {
    for (const f of g.files) {
      ok(f + ' carries ' + g.field + ' as a plain literal',
        read(f).includes(CANON[g.field]),
        'if the spelling drifts, the stamp silently misses it');
    }
  }
}

console.log('\n  nothing new has crept in');
{
  /* A scan for things SHAPED like account identifiers. The point is not to
     re-list what GOVERNED already covers — it is to fail when a sixth vendor
     arrives and nobody adds it here. */
  const SHAPES = [
    { what: 'a GA4 measurement id', re: /\bG-[A-Z0-9]{8,12}\b/g },
    { what: 'a Google Ads id',      re: /\bAW-\d{9,}\b/g },
    { what: 'a PostHog project key', re: /\bphc_[A-Za-z0-9]{30,}\b/g },
    { what: 'a Turnstile site key', re: /\b0x4[A-Za-z0-9]{15,}\b/g },
  ];
  const SKIP_DIRS = new Set(['node_modules', 'dist', '.wrangler', '.git', 'tests', 'backup-tools', 'migrations']);
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); }
      else if (/\.(js|html)$/.test(e.name) && e.name !== 'supabase.min.js') out.push(path.join(dir, e.name));
    }
    return out;
  };
  const known = new Set(GOVERNED.map((g) => CANON[g.field]));
  const strays = [];
  for (const file of walk(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const s of SHAPES) {
      const found = src.match(s.re) || [];
      for (const v of found) {
        if (!known.has(v)) strays.push(path.relative(ROOT, file).replace(/\\/g, '/') + ' → ' + s.what + ' ' + v);
      }
    }
  }
  ok('no account identifier exists that zw-config.js does not govern',
    strays.length === 0,
    strays.join('; '));
}

console.log('\n  off is a real answer, and only where it makes sense');
{
  ok('the stamp knows an erase vocabulary',
    /const ERASE = \/\^\(off\|none\|false\|0\|-\|null\|disabled\)\$\/i;/.test(STAMP));
  ok('…honoured only for optional rules',
    /r\.erased = r\.declared && !!r\.optional && ERASE\.test\(raw\);/.test(STAMP),
    'ZW_SUPABASE_URL=off is a typo, not an instruction — an empty database URL breaks every page');
  ok('…and the three required values are NOT optional',
    !/CANON\.supabaseUrl,\s*optional/.test(STAMP)
    && !/CANON\.supabaseAnonKey,\s*optional/.test(STAMP)
    && !/CANON\.siteUrl,\s*optional/.test(STAMP));
  /* The bug this replaced: the loop tested `rule.env`, so an erased rule — whose
     env is deliberately '' — was skipped, and "off" could never take effect. */
  ok('the rewrite tests `declared`, not truthiness',
    /if \(!rule\.from \|\| !rule\.declared \|\| rule\.env === rule\.from\) continue;/.test(STAMP),
    'testing rule.env is what made "off" unreachable');
  ok('…with three states spelled out, not two',
    /r\.declared = !!raw;/.test(STAMP) && /r\.env = r\.erased \? '' : raw;/.test(STAMP));
}

console.log('\n  every consumer survives its vendor being absent');
{
  const GT = read('google-tag.js');
  ok('google-tag loads nothing when both ids are gone', /if \(!LIB\) return;/.test(GT));
  ok('…and the two destinations are independent',
    /if \(GA4\) gtag\('config', GA4\);/.test(GT) && /if \(ADS\) gtag\('config', ADS\);/.test(GT),
    'a store can run GA4 with no ads account');
  ok('…the library id falls back to whichever survives',
    /var LIB = GA4 \|\| ADS;/.test(GT) && /gtag\/js\?id=' \+ LIB/.test(GT),
    'building the src from GA4 would 404 for an ads-only store');

  const MP = read('meta-pixel.js');
  ok('meta-pixel starts neither the pixel nor the relay', /function start\(\) \{\n    if \(!PIXEL_ID\) return;/.test(MP),
    'the /api/c relay carries the same order data — stopping only fbq would still leak it');
  ok('…and the no-op zwPixel is declared before that guard',
    MP.indexOf('window.zwPixel = window.zwPixel ||') < MP.indexOf('var PIXEL_ID'),
    'every call site must keep working without knowing');
  /* zwWhenIdle lives in this file and google-tag.js / posthog-init.js use it,
     so the guard must not sit above its definition. */
  ok('…and zwWhenIdle is still defined for the other two modules',
    MP.indexOf('window.zwWhenIdle = window.zwWhenIdle ||') < MP.indexOf('function start()'),
    'guarding the whole module would take the shared idle helper with it');

  const PH = read('posthog-init.js');
  ok('posthog no-ops zwTrack rather than queueing forever',
    /if \(!KEY\) \{ window\.zwTrack = function \(\) \{\}; return; \}/.test(PH),
    'a queue nothing will drain grows with every event on a long session');

  const TS = read('zw-turnstile.js');
  ok('zwHumanToken resolves empty with no site key',
    /if \(!SITEKEY\) return Promise\.resolve\(''\);/.test(TS),
    'the same answer it already gives for a blocked script — the server decides');

  const AU = read('auth.js');
  ok('auth.js requires the key as well as the script',
    /const ZW_TS_ENABLED = !!ZW_TS_KEY && !!document\.querySelector/.test(AU),
    'a dead captcha that blocks sign-in is worse than no captcha');
  ok('…and will not render a widget without one',
    /if \(!ZW_TS_KEY \|\| !el \|\| !window\.turnstile/.test(AU),
    'window.turnstile can be present because another module loaded the SDK');

  const AD = read('admin-main.js');
  ok('the admin login widget is guarded too',
    /if \(!ADMIN_TS_KEY \|\| !el \|\| !window\.turnstile/.test(AD),
    'this one locks the administrator out of their own panel');
  ok('…without burning the 2.5s poll on every sign-in',
    /if \(!ADMIN_TS_KEY\) return Promise\.resolve\(false\);/.test(AD));
}

console.log('\n  the empty-string substring trap');
{
  const AD = read('admin-main.js');
  ok('the host list drops an empty entry',
    /const R2_PUBLIC_IMAGE_HOSTS = \['images\.zuwera\.store'\]\.filter\(Boolean\);/.test(AD),
    "an array holding '' is not an empty array");
  ok('there is one function that decides', /function zwIsOwnImageHost\(url\) \{/.test(AD));
  ok('…and it refuses before testing, not after',
    /if \(!R2_PUBLIC_IMAGE_HOSTS\.length\) return false;/.test(AD),
    'every string contains the empty string — this is the whole bug');
  ok('no census line still does its own substring test',
    !/\(r\.image_url\|\|''\)\.includes\('images\.zuwera\.store'\)/.test(AD)
    && (AD.match(/zwIsOwnImageHost\(r\.image_url\)/g) || []).length === 3,
    'all three call sites, or the one that was missed reports a bill for images it does not store');
}

console.log('\n  the CSP the stamp could not see');
{
  ok('_headers still names a media host',
    /media-src [^;\n]*zuwera\.store/.test(HEADERS),
    "'self' does not cover a subdomain and media-src has no bare https:");
  ok('the stamp now rewrites _headers', /const headersPath = path\.join\(ROOT, '_headers'\);/.test(STAMP));
  ok('…driven by the image-host rule', /RULES\.find\(\(r\) => r\.name === 'ZW_IMAGE_HOST'\)/.test(STAMP));
  ok('…leaving comment lines alone',
    /if \(\/\^\\s\*#\/\.test\(line\) \|\| !line\.includes\(token\)\) return line;/.test(STAMP),
    'those comments explain why the host is listed — rewriting them hands a fork a history that is not its own');
  ok('…and collapsing the gap when the token is dropped',
    /\.replace\(\/  \+\/g, ' '\)\.replace\(\/ ;\/g, ';'\)/.test(STAMP),
    'a directive with an empty source can invalidate the whole policy');
  /* _headers is not .js/.html, so shippedFiles() genuinely cannot reach it —
     if that ever changes, the separate pass becomes a double rewrite. */
  ok('_headers is still outside shippedFiles()',
    /\/\\\.\(js\|html\)\$\/\.test\(e\.name\)/.test(STAMP),
    'widening that filter would make the dedicated pass run twice');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
