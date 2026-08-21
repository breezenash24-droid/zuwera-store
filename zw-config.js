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

    /* ── The Cloudinary account every image is resized through ──────────────
       This was a literal in image-utils.js and three times in index.html's
       <head>, and NOT among the things this file governed — which made it the
       one identifier a fork could not change.

       image-utils.js keeps it as the fallback when no configuration is found,
       and setCloudinaryCloudName() rejects an empty value rather than clearing
       it, so a fork that never set CLOUDINARY_CLOUD_NAME served every one of
       its own images through the original store's account. On the original's
       25 monthly credits, and invisibly: the images would load.

       Worse, the three in <head> read no configuration at all — they run
       before image-utils.js is even fetched, so even a fork that HAD
       configured Cloudinary properly still sent its hero preload here.

       Stamped at build time like the rest, so ZW_CLOUDINARY_CLOUD_NAME (or
       CLOUDINARY_CLOUD_NAME) rewrites all four. */
    cloudinaryCloudName: 'dubg4loah',

    /* ── The five accounts a fork would otherwise report into ────────────────
       Cloudinary was the first identifier found that a fork could not change.
       These are the rest of them, and they fail in a nastier way, because the
       Cloudinary one at least only spent the original store's credits.

       Left as literals, a licensee's storefront sends its pageviews to THIS
       GA4 property, its conversions to THIS Ads account, its Purchase events
       to THIS pixel, its funnel to THIS PostHog project — and asks THIS
       Turnstile site key to vouch for its visitors. Nothing errors. The
       licensee sees a working shop; the original store sees a competitor's
       traffic mixed into its own reporting and cannot unmix it after the fact.
       The captcha is worse than useless: a site key is bound to a hostname
       list, so a fork's widget fails the check on a domain it was never issued
       for, and the form it guards stops working for real customers.

       ── "OFF" IS A REAL ANSWER HERE, UNLIKE ABOVE ────────────────────────────

       A store must have a database, so a missing ZW_SUPABASE_URL can only mean
       "not configured yet". A store need not have Meta advertising. So the
       build accepts off / none / false / 0 / - for any value below and stamps
       an EMPTY string, and every consumer treats empty as "this store does not
       use that service" and loads nothing at all. Substituting an id is one
       valid answer; removing the vendor entirely is the other, and a fork that
       can only substitute is a fork that has to keep somebody's pixel.

       Each consumer already had to survive its vendor being blocked by an ad
       blocker, so "absent" was a state they mostly handled. The guards below
       make it the SAME state rather than a second one. */

    /* Google tag — analytics and conversion tracking. Two destinations on one
       gtag.js load, independently removable: a store can run GA4 with no ads. */
    gaMeasurementId: 'G-DCVWDZ8ZBC',
    googleAdsId: 'AW-18239653983',

    /* Meta Pixel. Also reaches functions/api/_capi.js, which posts the
       server-side half of the same events — but that one reads `env` already,
       so a fork sets META_PIXEL_ID there and only the browser half was stuck. */
    metaPixelId: '1695269795093400',

    /* PostHog project key. Public — it is write-only ingestion. */
    posthogKey: 'phc_mCL2GmGPncq5Twg7vK6FesuQHQZVTojTxHTpc4Bwp9yT',

    /* Turnstile SITE key, the public half. The secret is a Cloudflare
       environment variable the browser never sees, and stays that way.
       In THREE browser files — zw-turnstile.js, auth.js and admin-main.js —
       because the admin login widget renders before the storefront helper
       could exist. All three are stamped from here. */
    turnstileSiteKey: '0x4AAAAAADRcULYsa0xJEyZH',

    /* The R2 bucket's public hostname. Product video is served from it, so it
       is named in the CSP's media-src as well as in the admin's media census.
       CAREFUL: the census asks `url.includes(host)`, and every string contains
       the empty string — so an unset host must never reach a substring test.
       zwIsOwnImageHost() in admin-main.js is the one place that decides. */
    imageHost: 'images.zuwera.store',
  };
}));
