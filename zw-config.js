/**
 * zw-config.js — the one place this deployment says which project it is.
 *
 * WHY THIS EXISTS. The Supabase project ref `qfgnrsifcwdubkolsgsq` was written
 * out in 51 files: browser scripts, Workers, and a build script. Fine for one
 * store. Fatal for a second one — a copy of this repository deployed as-is
 * produces a storefront that reads the ORIGINAL store's database, a build that
 * fetches the original store's fonts, and an admin migration panel pointed at
 * the original store's schema. Nothing warns you, because everything works.
 *
 * The values here are not secret. An anon key is public by design — it is meant
 * to sit in the browser, and RLS is what actually protects the data. The
 * problem was never exposure, it was that every copy pointed home.
 *
 * ── HOW EACH RUNTIME GETS THESE ──────────────────────────────────────────────
 *
 * Three consumers, three mechanisms, because they genuinely differ:
 *
 *   Workers (functions/api/*.js)
 *     Read `env` first, via _config.js, falling back to these defaults. Real
 *     runtime configuration: a licensee sets SUPABASE_URL in their Pages
 *     dashboard and never edits code.
 *
 *   Build scripts (scripts/*.js)
 *     require() this file, with process.env taking precedence.
 *
 *   Browser (*.js, *.html)
 *     Stamped at build time by scripts/stamp-project-config.js. NOT resolved at
 *     runtime from a global, and that is deliberate: supabase.min.js is injected
 *     lazily here, while announcement-bar.js and others hit the REST API before
 *     any of that has loaded. A config global would have to be fetched and
 *     awaited by every one of them, and the first script to forget would read
 *     `undefined` and fail in a way nobody notices until a page is blank.
 *     Stamping has no ordering to get wrong and costs no request.
 *
 * ── CHANGING THESE ───────────────────────────────────────────────────────────
 *
 * Do not edit the literals below to point at a different project. Set the env
 * vars instead — ZW_SUPABASE_URL, ZW_SUPABASE_ANON_KEY, ZW_SITE_URL — and the
 * build rewrites every shipped file. On Cloudflare the build REFUSES to run
 * without them rather than quietly shipping someone else's database; see
 * scripts/stamp-project-config.js for why that is a hard error and not a
 * warning.
 */

(function (root, factory) {
  const config = factory();
  /* Both shapes on purpose. Node build scripts require() it; the browser gets a
     global for anything that wants to read it at runtime rather than rely on
     the stamp. Neither form is the "real" one. */
  if (typeof module === 'object' && module.exports) module.exports = config;
  if (typeof window !== 'undefined') window.ZW_CONFIG = config;
  return config;
}(typeof self !== 'undefined' ? self : this, function () {
  return {
    /* The Supabase project this deployment talks to. */
    supabaseUrl: 'https://qfgnrsifcwdubkolsgsq.supabase.co',

    /* Public by design: it identifies the project and carries the `anon` role.
       Every row it can reach is reachable because an RLS policy allows it. */
    supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY',

    /* Where this store lives. Used for absolute links in emails and for the
       canonical origin. */
    siteUrl: 'https://zuwera.store',

    /* Shown to customers. Kept here so a fork changes it once. */
    brandName: 'Zuwera',
  };
}));
