/* The Content-Security-Policy is enforced, and its list is complete.
 *
 * ── WHY THE POLICY WAS ADVISORY ─────────────────────────────────────────────
 *
 * _headers carried a long, carefully built policy on the Report-Only header and
 * four directives on the enforcing one: frame-ancestors, object-src, base-uri,
 * upgrade-insecure-requests. None of those constrain scripts. So nothing at all
 * stopped a script injected into checkout.html loading from an attacker's host,
 * reading the page around the card frame, and posting it elsewhere. That is the
 * exact control a PCI SAQ-A-EP questionnaire asks about.
 *
 * ── WHY IT COULD NOT SIMPLY BE PROMOTED ─────────────────────────────────────
 *
 * Because the list was wrong, and nothing had ever caught it — a report-only
 * policy is never wrong in a way anybody notices. Walking every browser-side
 * file for both `<script src>` AND dynamically assigned `.src` (which is where
 * every third-party SDK in this codebase lives — a scan that only reads HTML
 * misses all of them) found three hosts the site loads scripts from that the
 * policy did not name:
 *
 *     www.paypal.com      paypal-button.js   — PayPal checkout would have died
 *     cdn.jsdelivr.net    admin-finance.js (Chart.js), builder.html (QRious)
 *     unpkg.com           analytics.html (React UMD)
 *
 * ── WHAT THIS FILE HOLDS ────────────────────────────────────────────────────
 *
 * The old assertion in error-log-retention.test.js said the enforcing header
 * must name no hosts at all, on the grounds that a gap in the list becomes an
 * outage. The grounds were right; the conclusion has moved. The rule is now
 * "name every host you use", and unlike the old rule that is something a test
 * can verify rather than a policy of avoidance. This walks the shipped code and
 * fails if a host it loads from is missing from the enforced policy — so the
 * next SDK somebody adds fails here, in CI, and not on the checkout page.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const HEADERS = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8').replace(/\r\n/g, '\n');
const enforced = (HEADERS.match(/^\s*Content-Security-Policy:(.*)$/m) || ['', ''])[1];

function directive(policy, name) {
  const m = policy.match(new RegExp('(?:^|;)\\s*' + name + '\\s+([^;]+)'));
  return m ? m[1].trim().split(/\s+/) : [];
}

/* 'https://*.paypal.com' covers www.paypal.com; 'https://js.stripe.com' covers
   only itself. A wildcard matches ONE label or more, but never the bare
   registrable domain — which is CSP's own rule and the reason *.stripe.com and
   js.stripe.com are both listed in a correct policy. */
function covered(sources, host) {
  return sources.some((src) => {
    const s = src.replace(/^https:\/\//, '').replace(/\/$/, '');
    if (s === host) return true;
    if (s.startsWith('*.')) {
      const suffix = s.slice(1);           // '.paypal.com'
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return false;
  });
}

/* Browser-side only. functions/ is Workers — a Worker's fetch is not subject to
   any page's CSP, and listing its hosts would bloat the policy with entries
   that protect nothing. */
function browserFiles() {
  const out = [];
  for (const f of fs.readdirSync(ROOT)) {
    if (/\.(html|js)$/.test(f) && !/^supabase\.min\.js$/.test(f)) out.push(f);
  }
  return out;
}

const found = { script: new Map(), frame: new Map(), connect: new Map() };
function note(kind, url, file) {
  let host;
  try { host = new URL(url).host; } catch (_) { return; }
  if (!host || host === 'zuwera.store') return;
  if (!found[kind].has(host)) found[kind].set(host, file);
}

for (const file of browserFiles()) {
  const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const m of s.matchAll(/<script[^>]+src=["'](https:\/\/[^"']+)/gi)) note('script', m[1], file);
  for (const m of s.matchAll(/\.src\s*=\s*[`"'](https:\/\/[^`"']+)/g)) note('script', m[1], file);
  for (const m of s.matchAll(/<iframe[^>]+src=["'](https:\/\/[^"']+)/gi)) note('frame', m[1], file);
  for (const m of s.matchAll(/fetch\(\s*[`"'](https:\/\/[^`"']+)/g)) note('connect', m[1], file);
}

console.log('\n  the CSP is enforced, and its allow-list matches the code\n');

console.log('  it is on the enforcing header');
{
  ok('there is an enforcing Content-Security-Policy', !!enforced.trim());
  ok('…with a script-src', directive(enforced, 'script-src').length > 0,
    'without this, a script can be loaded onto the checkout page from anywhere');
  ok('…a connect-src', directive(enforced, 'connect-src').length > 0);
  ok('…a frame-src', directive(enforced, 'frame-src').length > 0);
  ok('…and form-action, so an injected form cannot post the page elsewhere',
    directive(enforced, 'form-action').length > 0);
  ok('object-src stays none and base-uri stays self',
    /object-src 'none'/.test(enforced) && /base-uri 'self'/.test(enforced));
  ok('frame-ancestors still allows same-origin embedding',
    /frame-ancestors 'self'/.test(enforced),
    'the builder, size guide and analytics iframes are same-origin embeds');
}

console.log('\n  every host the shipped code loads from is named');
{
  const scriptSrc = directive(enforced, 'script-src');
  const frameSrc = directive(enforced, 'frame-src');
  const connectSrc = directive(enforced, 'connect-src');

  ok('the scan found the script hosts at all', found.script.size >= 5,
    'if this drops to nothing the scan has broken, not the policy');

  for (const [host, file] of [...found.script].sort()) {
    ok('  script-src covers ' + host, covered(scriptSrc, host), 'loaded by ' + file);
  }
  for (const [host, file] of [...found.frame].sort()) {
    ok('  frame-src covers ' + host, covered(frameSrc, host), 'framed by ' + file);
  }
  for (const [host, file] of [...found.connect].sort()) {
    ok('  connect-src covers ' + host, covered(connectSrc, host), 'fetched by ' + file);
  }

  /* The three that were missing when the policy was promoted. Named
     individually because a regression here is silent until a customer tries to
     pay, and "PayPal is in the list" is a cheaper thing to check than "PayPal
     works". */
  ok('PayPal’s SDK host is allowed', covered(scriptSrc, 'www.paypal.com'),
    'paypal-button.js loads https://www.paypal.com/sdk/js — omitting it kills PayPal checkout');
  ok('…and PayPal can open its own frames', covered(frameSrc, 'www.paypal.com'));
  ok('jsDelivr is allowed', covered(scriptSrc, 'cdn.jsdelivr.net'), 'Chart.js in Finance, QRious in the builder');
  ok('unpkg is allowed', covered(scriptSrc, 'unpkg.com'), 'React UMD in analytics.html');
  ok('Stripe is allowed on both', covered(scriptSrc, 'js.stripe.com') && covered(frameSrc, 'js.stripe.com'));
}

console.log('\n  and the inline allowance is admitted rather than hidden');
{
  /* Keeping 'unsafe-inline' means the policy stops a script being LOADED from
     an unlisted host and does not yet stop one being INJECTED inline. That is a
     real improvement and a partial one. It is pinned here so the partiality is
     a recorded fact rather than something a reader has to notice. */
  ok('script-src still allows inline, because every page has inline handlers',
    directive(enforced, 'script-src').includes("'unsafe-inline'"),
    'removing it needs a hash or nonce on every inline block — its own change');
  ok('_headers says so out loud',
    /WHAT IS STILL LOOSE, DELIBERATELY/.test(HEADERS),
    'a partial control that reads as complete is the thing being fixed');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
