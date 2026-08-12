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
const RULES = [
  { name: 'ZW_SUPABASE_URL',      from: CANON.supabaseUrl,     env: process.env.ZW_SUPABASE_URL },
  { name: 'ZW_SUPABASE_ANON_KEY', from: CANON.supabaseAnonKey, env: process.env.ZW_SUPABASE_ANON_KEY },
  { name: 'ZW_SITE_URL',          from: CANON.siteUrl,         env: process.env.ZW_SITE_URL },
];

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

const targetUrl = process.env.ZW_SUPABASE_URL || '';

if (onCloudflare && !targetUrl) {
  console.error('');
  console.error('  BUILD STOPPED — ZW_SUPABASE_URL is not set.');
  console.error('');
  console.error('  Without it this build would ship a storefront pointed at the');
  console.error('  project baked into zw-config.js (' + refOf(CANON.supabaseUrl) + '), which is');
  console.error('  almost certainly not yours. It would appear to work.');
  console.error('');
  console.error('  Set these in Cloudflare Pages → Settings → Environment variables:');
  console.error('    ZW_SUPABASE_URL       https://<your-project>.supabase.co');
  console.error('    ZW_SUPABASE_ANON_KEY  <your project\'s anon key>');
  console.error('    ZW_SITE_URL           https://<your-domain>');
  console.error('');
  process.exit(1);
}

/* --check reports what WOULD change, for a test to assert coverage without
   writing anything. */
const files = shippedFiles(ROOT);
let touched = 0, replacements = 0;
const stillReferencing = [];

for (const file of files) {
  let src = fs.readFileSync(file, 'utf8');
  const before = src;
  for (const rule of RULES) {
    if (!rule.from || !rule.env || rule.env === rule.from) continue;
    if (!src.includes(rule.from)) continue;
    replacements += src.split(rule.from).length - 1;
    src = src.split(rule.from).join(rule.env);
  }
  if (src !== before) { touched++; if (!check) fs.writeFileSync(file, src); }

  /* Anything still naming the canonical project after the rewrite is a literal
     this script does not know how to reach — a hostname spelled differently, a
     ref pasted without the scheme. Reported rather than ignored, because a
     single missed one sends real traffic to the wrong database. */
  const ref = refOf(CANON.supabaseUrl);
  const post = check ? before : src;
  if (ref && post.includes(ref)) stillReferencing.push(path.relative(ROOT, file).replace(/\\/g, '/'));
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
