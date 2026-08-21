/**
 * Point this deployment at ITS OWN project, at build time.
 *
 * THE PROBLEM. The Supabase project ref was written out in 51 files. Workers now
 * resolve it through functions/api/_config.js, but browser code cannot: this
 * site injects supabase.min.js lazily, while announcement-bar.js and others hit
 * the REST API long before that has loaded. Resolving from a config global would
 * mean every one of them awaiting it, and the first script to forget reads
 * `undefined` and fails somewhere nobody looks.
 *
 * So the browser files keep a literal, and this rewrites it at build time. No
 * ordering to get wrong, no extra request, and it matches how this repo already
 * handles first-paint fonts (stamp-config-defaults.js) and cache busting
 * (bump-cache-version.js).
 *
 * ── WHY A MISSING VALUE IS A HARD ERROR ──────────────────────────────────────
 *
 * On Cloudflare, a build with no ZW_SUPABASE_URL fails. Not a warning.
 *
 * The alternative is shipping a store wired to somebody else's database — and
 * it would WORK. Products would load, the storefront would render, an admin
 * would sign in against the wrong project. Every symptom of success, with a
 * licensee's customers reading and writing the original store's data. That is
 * not a class of bug worth being relaxed about, and it is exactly the sort of
 * failure this codebase has already been bitten by: the one that looks fine.
 *
 * The original store is not exempt. It sets ZW_SUPABASE_URL to its own project
 * like everybody else, so there is one rule and no special case that could rot.
 *
 * Local builds skip entirely — no env, no rewrite, committed defaults stand.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CANON = require(path.join(ROOT, 'zw-config.js'));

/* Everything that ships to a browser. Workers are excluded: they import
   _config.js and resolve from `env` at runtime, which is strictly better and
   needs no build step. Generated and vendored trees are excluded because
   rewriting them achieves nothing — dist/ is rebuilt, and supabase.min.js is
   third-party. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.wrangler', '.git', 'functions', 'migrations', 'tests', 'backup-tools']);
const SKIP_FILES = new Set(['zw-config.js', 'supabase.min.js']);

function shippedFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) shippedFiles(path.join(dir, e.name), out);
    } else if (/\.(js|html)$/.test(e.name) && !SKIP_FILES.has(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/* What gets replaced, and with what. Keyed on the CANONICAL value rather than
   on a marker comment: the literals are already identical everywhere, and a
   marker is one more thing that can be forgotten on the next file added. */
/* Either name. ZW_* is the one documented for a fork, but a deployment that
   already runs this store has SUPABASE_URL and SITE_URL configured, and asking
   for a second variable holding the identical value is a way to get them out of
   step. The Workers accept both names for the same reason. */
const readEnv = (...names) => {
  for (const n of names) {
    const v = process.env[n];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
};

const RULES = [
  { names: ['ZW_SUPABASE_URL', 'SUPABASE_URL'],           from: CANON.supabaseUrl },
  { names: ['ZW_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY'], from: CANON.supabaseAnonKey },
  { names: ['ZW_SITE_URL', 'SITE_URL'],                   from: CANON.siteUrl },
  /* The Cloudinary account, which was the one identifier a fork could not
     change. It is a literal in image-utils.js (as the fallback when no config
     is found) and three times in index.html's <head>, where it reads no
     configuration at all because it runs before image-utils.js is fetched.

     So a fork resized every image through the ORIGINAL store's account, on the
     original's 25 monthly credits, and nothing said so -- the images loaded.
     Same failure this whole file exists to prevent, one vendor over. */
  { names: ['ZW_CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_CLOUD_NAME'], from: CANON.cloudinaryCloudName },

  /* ── The five accounts a fork would otherwise report into ───────────────────
     Same class of bug as Cloudinary, worse consequences. A licensee left with
     these literals sends its pageviews, conversions, Purchase events and funnel
     to the ORIGINAL store's properties, and asks the original store's Turnstile
     site key to vouch for its visitors. All of it silent; the shop works.

     `optional: true` is what separates these from the three above. A store must
     have a database, so an unset SUPABASE_URL can only mean "not configured".
     A store need not have Meta advertising — so these accept off/none/false/0/-
     and stamp an empty string, and every consumer treats empty as "this store
     does not use that service". See ERASE below. */
  { names: ['ZW_GA_MEASUREMENT_ID', 'GA_MEASUREMENT_ID'], from: CANON.gaMeasurementId,   optional: true },
  { names: ['ZW_GOOGLE_ADS_ID', 'GOOGLE_ADS_ID'],         from: CANON.googleAdsId,       optional: true },
  { names: ['ZW_META_PIXEL_ID', 'META_PIXEL_ID'],         from: CANON.metaPixelId,       optional: true },
  { names: ['ZW_POSTHOG_KEY', 'POSTHOG_KEY'],             from: CANON.posthogKey,        optional: true },
  { names: ['ZW_TURNSTILE_SITE_KEY', 'TURNSTILE_SITE_KEY'], from: CANON.turnstileSiteKey, optional: true },
  /* The R2 public hostname. Also appears in _headers' media-src, which this
     script does rewrite — _headers is not .js/.html, so it is NOT in
     shippedFiles() and a fork's video would be blocked by its own CSP. Handled
     separately below rather than by widening the file filter, because _headers
     is a deployment artifact with its own syntax and blanket string replacement
     across it is how a policy ends up malformed. */
  { names: ['ZW_IMAGE_HOST', 'IMAGE_HOST'],               from: CANON.imageHost,         optional: true },
];

/* Values that mean "this store does not use that service". Only honoured for
   `optional` rules — `ZW_SUPABASE_URL=off` is a typo, not an instruction, and
   stamping an empty database URL would produce a storefront that fails on every
   page rather than one that quietly points home. */
const ERASE = /^(off|none|false|0|-|null|disabled)$/i;

RULES.forEach((r) => {
  r.name = r.names[0];
  const raw = readEnv(...r.names);
  /* Three states, not two: unset (leave the literal alone), set to a value
     (substitute), set to off (erase). The old code collapsed the first and
     third, which is precisely why a fork could not remove a vendor. */
  r.declared = !!raw;
  r.erased = r.declared && !!r.optional && ERASE.test(raw);
  r.env = r.erased ? '' : raw;
});

/* The project ref on its own, so a URL assembled from pieces — or a storage
   hostname — is caught as well as the full origin. */
const refOf = (url) => {
  const m = String(url || '').match(/https:\/\/([a-z0-9]+)\.supabase\.co/i);
  return m ? m[1] : '';
};

const onCloudflare = !!process.env.CF_PAGES;
const explicitLocal = process.argv.includes('--local');
const check = process.argv.includes('--check');

if (!onCloudflare && !explicitLocal && !check) process.exit(0);

const targetUrl = readEnv('ZW_SUPABASE_URL', 'SUPABASE_URL');

/* ── Loud, not fatal ─────────────────────────────────────────────────────────
 *
 * This stopped the build when no project was named. The reasoning was that an
 * unconfigured fork ships against the original store's database and every
 * symptom looks like success, so a warning would be read as noise and ignored.
 *
 * That reasoning is still right, and enforcing it here was still wrong. The
 * risk is a FORK's, in a future that has not happened; the cost landed on a
 * live store that could not deploy — three times, for a safety property
 * protecting nobody yet. A guard whose failure mode is "the shop cannot ship"
 * has to be worth more than the thing it prevents, and this one was not, yet.
 *
 * So it warns by default and stops only when told to. Handing this repository
 * to somebody else means setting ZW_ENFORCE_PROJECT_CONFIG=1 in their build,
 * which is one line in the handover checklist and turns the warning back into
 * the wall it should be for them. The person who has never seen this code is
 * the one who needs stopping; the person who wrote it does not.
 */
const enforce = /^(1|true|yes)$/i.test(String(process.env.ZW_ENFORCE_PROJECT_CONFIG || '').trim());

if (onCloudflare && !targetUrl) {
  const say = enforce ? console.error : console.warn;
  say('');
  say(enforce
    ? '  BUILD STOPPED — this build does not know which project it is for.'
    : '  WARNING — this build does not know which project it is for.');
  say('');
  say('  It will use the project baked into zw-config.js (' + refOf(CANON.supabaseUrl) + ').');
  say('  Correct for the original store. For anyone else it means shipping a');
  say('  storefront wired to someone else\'s database, which would appear to work.');
  say('');
  say('  Set as BUILD variables:');
  say('    ZW_SUPABASE_URL       https://<your-project>.supabase.co');
  say('    ZW_SUPABASE_ANON_KEY  <your project\'s anon key>');
  say('    ZW_SITE_URL           https://<your-domain>');
  say('  (SUPABASE_URL / SUPABASE_ANON_KEY / SITE_URL are accepted too.)');
  say('');
  say('  And, so that images resize through your own Cloudinary account rather');
  say('  than the original store\'s 25 monthly credits:');
  say('    ZW_CLOUDINARY_CLOUD_NAME   <your cloud name>');
  say('');
  /* The distinction that costs a deploy cycle otherwise. Cloudflare keeps
     runtime variables and BUILD variables in two different places, and this
     runs in postinstall — it can only see the build ones. Variables set for the
     Workers are invisible here, and the dashboard gives no hint of that. */
  say('  Cloudflare Pages keeps these in TWO places, and only one reaches a build:');
  say('    Settings → Variables and Secrets   → runtime only. NOT visible here.');
  say('    Settings → Build → Build variables → what this script can read.');
  say('  Set them in the BUILD section, for Production AND Preview.');
  say('');
  /* Names only — never values. A build log is not a place to print anything
     that might be a key. */
  const seen = Object.keys(process.env)
    .filter((k) => /^(ZW_|SUPABASE_|SITE_URL|STRIPE_|RESEND_|CF_)/.test(k))
    .sort();
  say('  Relevant variables this build CAN see: '
    + (seen.length ? seen.join(', ') : '(none — the build section is empty)'));
  say('');
  if (enforce) process.exit(1);
  say('  Continuing with the committed defaults. Set ZW_ENFORCE_PROJECT_CONFIG=1');
  say('  to make this a hard failure — do that before handing the repo to anyone.');
  say('');
}

/* Is this build pointing somewhere new, or confirming where it already points?
   Both are valid — what is NOT valid is not saying. */
const repointing = !!targetUrl && targetUrl.replace(/\/$/, '') !== CANON.supabaseUrl;

/* --check reports what WOULD change, for a test to assert coverage without
   writing anything. */
const files = shippedFiles(ROOT);
let touched = 0, replacements = 0;
const stillReferencing = [];

for (const file of files) {
  let src = fs.readFileSync(file, 'utf8');
  const before = src;
  for (const rule of RULES) {
    /* `declared`, not `env` — an erased optional rule has an EMPTY env and must
       still rewrite. Testing truthiness here was what made "off" unreachable. */
    if (!rule.from || !rule.declared || rule.env === rule.from) continue;
    if (!src.includes(rule.from)) continue;
    replacements += src.split(rule.from).length - 1;
    src = src.split(rule.from).join(rule.env);
  }
  if (src !== before) { touched++; if (!check) fs.writeFileSync(file, src); }

  /* Anything still naming the canonical project AFTER a rewrite is a literal
     this script could not reach — a hostname spelled differently, a ref pasted
     without the scheme. Worth failing over, because a single missed one sends
     real traffic to the wrong database.
     Only when actually repointing, though. The original store sets
     ZW_SUPABASE_URL to its own project, so nothing is rewritten and every file
     still names it — correctly. Treating that as unreachable would fail the one
     build that is already right, which is exactly what it did. */
  const ref = refOf(CANON.supabaseUrl);
  const post = check ? before : src;
  /* --check is a COVERAGE report, not a failure: it answers "which files would
     a repoint have to reach", which is what the test needs to know and is the
     same question whether or not this particular build is repointing. */
  if ((repointing || check) && ref && post.includes(ref)) {
    stillReferencing.push(path.relative(ROOT, file).replace(/\\/g, '/'));
  }
}

/* ── _headers, which shippedFiles() cannot see ───────────────────────────────
 *
 * The CSP names the R2 host so product video can play — media-src carries
 * `*.zuwera.store`, because 'self' does not cover a subdomain and media-src has
 * no bare `https:` to fall back on. That was found the hard way once already
 * (see the comment block in _headers itself).
 *
 * _headers is not .js or .html, so it is not in shippedFiles() and no rule above
 * ever reached it. A fork therefore rewrote its image host everywhere EXCEPT the
 * one place that decides whether the browser will load from it, and the failure
 * arrives as a silent CSP block on video only — the images still work, because
 * img-src allows `https:` wholesale.
 *
 * Rewritten as a single token rather than by blanket string replacement: this
 * file is a deployment artifact with its own syntax, and a policy that parses
 * wrong is a policy the browser discards entirely.
 */
const headersPath = path.join(ROOT, '_headers');
const hostRule = RULES.find((r) => r.name === 'ZW_IMAGE_HOST');
if (!check && hostRule && hostRule.declared && hostRule.env !== hostRule.from && fs.existsSync(headersPath)) {
  const apex = String(hostRule.from).split('.').slice(-2).join('.');   // zuwera.store
  const token = '*.' + apex;
  const lines = fs.readFileSync(headersPath, 'utf8').split('\n');
  let hits = 0;
  const out = lines.map((line) => {
    /* Comments carry the same string and explain WHY the host is listed. They
       are documentation of this store's history, not configuration, and
       rewriting them would leave a fork reading an account of a bug that never
       happened to it. */
    if (/^\s*#/.test(line) || !line.includes(token)) return line;
    hits += line.split(token).length - 1;
    /* Erased: the fork serves no media from a bucket of its own, so the token
       is dropped rather than replaced with something that matches nothing.
       Collapse the double space it leaves, or the directive gains an empty
       source which some parsers treat as the whole policy being malformed. */
    return hostRule.erased
      ? line.split(token).join('').replace(/  +/g, ' ').replace(/ ;/g, ';')
      : line.split(token).join(hostRule.env);
  });
  if (hits) {
    fs.writeFileSync(headersPath, out.join('\n'));
    replacements += hits;
    touched++;
    console.log(`[project-config] _headers: ${hits} CSP host token(s) ${hostRule.erased ? 'removed' : 'repointed'}`);
  }
}

if (check) {
  console.log(JSON.stringify({ files: files.length, stillReferencing }, null, 2));
  process.exit(0);
}

console.log(`[project-config] ${replacements} value(s) rewritten across ${touched} file(s)`);
if (stillReferencing.length) {
  console.error('[project-config] STILL naming ' + refOf(CANON.supabaseUrl) + ' after rewrite:');
  stillReferencing.forEach((f) => console.error('    ' + f));
  console.error('[project-config] These would talk to the wrong project. Failing the build.');
  process.exit(1);
}
