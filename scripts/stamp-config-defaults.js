/**
 * Keep the storefront's FIRST-PAINT font/heading defaults in sync with the live admin
 * config (site_settings.fonts) — automatically, at every deploy, with no code edit.
 *
 * Why: storefront-theme.js applies the admin fonts ~0.5s after load. Before that, an
 * uncached first load paints whatever storefront-cohesion.css :root hardcodes. If those
 * hardcoded defaults don't match the admin fonts, the header (and all text) renders in
 * the old font and then swaps — the "old header words on first load" flash. This stamps
 * the CURRENT admin fonts into those :root defaults so the first frame already matches.
 *
 * How: the target :root lines carry `/* zw:font-head *\/`-style markers; we replace only
 * the value between the property and the marker. Runs on the Cloudflare build (CF_PAGES)
 * before minify + cache-hashing, so the change ships and browsers refetch. Locally it's a
 * no-op (pass --local to run it by hand). If ANYTHING goes wrong — no network, bad JSON,
 * a marker that stopped matching, a result that fails validation — the CSS is left exactly
 * as committed. It must never break the build.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

// Local runs would rewrite the committed CSS on every `npm install` and create churn, so
// only run on the Cloudflare build (or when explicitly asked with --local for testing).
if (!process.env.CF_PAGES && !process.argv.includes('--local')) {
  process.exit(0);
}

const SUPABASE_URL = 'https://qfgnrsifcwdubkolsgsq.supabase.co/rest/v1/site_settings?key=eq.fonts&select=value';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';

function fetchFonts() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = https.get(SUPABASE_URL, { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON }, timeout: 8000 }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return finish(null); }
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { try { finish(JSON.parse(data)[0].value); } catch (_) { finish(null); } });
      });
      req.on('error', () => finish(null));
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} finish(null); });
    } catch (_) { finish(null); }
  });
}

// A CSS font-family value can only be a few quoted names + generic keywords + commas.
// Reject anything else so a malformed/hostile config value can never be injected.
function safeFontStack(v) {
  return typeof v === 'string' && v.length <= 200 && /^[\w\s,"'\-]+$/.test(v) ? v.trim() : null;
}
function safeKeyword(v, allowed) {
  return typeof v === 'string' && allowed.indexOf(v) !== -1 ? v : null;
}

(async () => {
  try {
    const cfg = await fetchFonts();
    if (!cfg || typeof cfg !== 'object') {
      console.log('[stamp-config-defaults] no config fetched — leaving :root defaults as committed.');
      return;
    }
    const roles = cfg.roles || {};
    // Each target: the :root property, the /* zw:<marker> */ tag on its line, and the
    // validated value to stamp. (Property name and marker differ, e.g. --zw-font-head
    // carries the tag `zw:font-head`.)
    const targets = [
      { prop: '--zw-font-head',     marker: 'font-head',     value: safeFontStack((roles.head && roles.head.stack) || cfg.head) },
      { prop: '--zw-font-body',     marker: 'font-body',     value: safeFontStack((roles.body && roles.body.stack) || cfg.body) },
      { prop: '--zw-font-mono',     marker: 'font-mono',     value: safeFontStack((roles.mono && roles.mono.stack) || cfg.mono) },
      { prop: '--zw-fst-head',      marker: 'fst-head',      value: safeKeyword(cfg.headingStyle, ['normal', 'italic']) },
      { prop: '--zw-head-tracking', marker: 'head-tracking', value: safeFontStack(cfg.headingTracking) }, // "normal" or an em value
      { prop: '--zw-head-case',     marker: 'head-case',     value: safeKeyword(cfg.headingCase, ['none', 'uppercase', 'lowercase', 'capitalize']) },
    ];

    const file = path.resolve(__dirname, '..', 'storefront-cohesion.css');
    const original = fs.readFileSync(file, 'utf8');
    let css = original;
    let n = 0;

    targets.forEach((t) => {
      if (t.value == null) return;
      const re = new RegExp('(' + t.prop + ':)[^;]*(;\\s*/\\* zw:' + t.marker + ' \\*/)');
      if (re.test(css)) { css = css.replace(re, '$1' + t.value + '$2'); n++; }
    });

    // Validation: never write something that would corrupt the stylesheet.
    const braceOk = (css.match(/{/g) || []).length === (css.match(/}/g) || []).length;
    const varsOk = /--zw-font-mono:[^;]+;\s*\/\* zw:font-mono \*\//.test(css);
    if (!braceOk || !varsOk) {
      console.log('[stamp-config-defaults] validation failed — leaving :root defaults as committed.');
      return;
    }
    if (css !== original) {
      fs.writeFileSync(file, css);
      console.log('[stamp-config-defaults] cohesion :root synced to live admin fonts (' + n + ' var(s)).');
    } else {
      console.log('[stamp-config-defaults] :root defaults already match the admin config.');
    }
  } catch (e) {
    console.log('[stamp-config-defaults] skipped (' + (e && e.message) + ') — defaults unchanged.');
  }
})();
