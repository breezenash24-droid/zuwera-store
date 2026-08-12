/**
 * _config.js — which project this Worker talks to.
 *
 * Twelve Workers each wrote out the Supabase URL, and several the anon key too.
 * The worst of them was migrate.js, which applies database migrations: a copy of
 * this repository deployed by somebody else would have had its migration panel
 * pointed at the ORIGINAL project's schema. Not a data leak — it would fail for
 * want of a service key — but a licensee pressing "apply" and watching nothing
 * happen, with no clue why.
 *
 * ENV FIRST, ALWAYS. Cloudflare already sets SUPABASE_URL for these Workers, so
 * this is genuine runtime configuration rather than a build-time trick: a
 * licensee sets their own value in the Pages dashboard and never edits code. The
 * literal in zw-config.js is only the fallback for the deployment that has not
 * set one, which today is nobody in production and everybody in local dev.
 *
 * WHY THE DEFAULTS ARE COPIED HERE rather than imported. zw-config.js is a UMD
 * script — it assigns to `window` and to `module.exports`, neither of which
 * exists in a Worker, and it is not an ES module. Importing it here would mean
 * shipping a shim for the two environments that do not apply. So the values are
 * duplicated, ONCE, and tests/project-config.test.js fails if the two copies
 * ever disagree. A checked copy is not a second source of truth; an unchecked
 * one would be.
 */

const DEFAULTS = {
  supabaseUrl: 'https://qfgnrsifcwdubkolsgsq.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY',
  siteUrl: 'https://zuwera.store',
  brandName: 'Zuwera',
};

const pick = (env, ...names) => {
  for (const n of names) {
    const v = env && env[n];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
};

/** The project's REST/auth origin, without a trailing slash.
 *
 * SUPABASE_PROJECT_URL is here because product/[slug].js already accepted it
 * and nothing else did — an alias SETUP.md documents but only one route
 * honoured. A deployment configured with that name would have had exactly one
 * working route and no clue why the rest were pointed elsewhere. */
export function supabaseUrl(env) {
  return (pick(env, 'SUPABASE_URL', 'SUPABASE_PROJECT_URL', 'ZW_SUPABASE_URL') || DEFAULTS.supabaseUrl)
    .replace(/\/$/, '');
}

/** The public anon key. Not a secret — RLS is the control. */
export function supabaseAnonKey(env) {
  return pick(env, 'SUPABASE_ANON_KEY', 'ZW_SUPABASE_ANON_KEY') || DEFAULTS.supabaseAnonKey;
}

/**
 * Where this store lives, without a trailing slash.
 *
 * SITE_URL was already read in a few places and hardcoded in more, so the same
 * question had two answers depending on which file you were in.
 */
export function siteUrl(env) {
  return (pick(env, 'SITE_URL', 'ZW_SITE_URL') || DEFAULTS.siteUrl).replace(/\/$/, '');
}

/** The customer-facing name. */
export function brandName(env) {
  return pick(env, 'BRAND_NAME', 'ZW_BRAND_NAME') || DEFAULTS.brandName;
}

export { DEFAULTS };
