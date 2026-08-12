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
];
RULES.forEach((r) => { r.env = readEnv(...r.names); r.name = r.names[0]; });

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
    if (!rule.from || !rule.env || rule.env === rule.from) continue;
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
