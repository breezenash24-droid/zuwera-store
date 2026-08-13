/* The error log had eaten the error log.
 *
 * 28,038 rows, of which 27,993 were CSP reports at roughly 700 a day. The 79
 * real JavaScript errors — the ones a customer actually hit — were underneath
 * them. That is the real cost, more than the storage: a log nobody can read is
 * a log nobody reads, and this one had been telling us something for a month
 * with nobody able to see it.
 *
 * WHAT IT WAS SAYING, once the duplicates collapsed: connect-src allows
 * *.google-analytics.com, and GA4 also posts to analytics.google.com, which
 * that wildcard does not match. ~3,400 reports, still arriving. Harmless today
 * because the policy is Report-ONLY — and precisely the list of things that
 * would break the day anyone enforces it.
 *
 * The duplication was almost all cache-busting junk in the query string:
 * /g/collect?…&gtm=45je6852v9245643753za200… changes every pageview, so ONE
 * misconfigured hostname produced thousands of "distinct" messages.
 *
 * So the fix is three things, and pruning is the least important:
 *   the CSP gap closed, the logging deduplicated, and retention added.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const CSP = fs.readFileSync(path.join(ROOT, 'functions/api/csp-report.js'), 'utf8');
const LOG = fs.readFileSync(path.join(ROOT, 'functions/api/log-error.js'), 'utf8');
const SQL = fs.readFileSync(path.join(ROOT, 'migrations/0016_error_log_retention.sql'), 'utf8');
const HEADERS = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8');

console.log('\n  error log retention\n');

console.log('  the violation that was actually being reported');
{
  /* The point of reading a log. This one was live and nobody had seen it. */
  ok('connect-src allows analytics.google.com', /connect-src[^;]*https:\/\/analytics\.google\.com/.test(HEADERS));
  ok('…as well as the *.google-analytics.com wildcard it is NOT covered by',
    /https:\/\/\*\.google-analytics\.com/.test(HEADERS),
    'they are different hostnames; the wildcard does not match');

  /* Two policies, and the split is why nothing was broken. The ENFORCING one
     carries only directives that cannot break a third party — clickjacking,
     plugins, base tags, http upgrades. Everything that names a host is
     report-only, so a missing entry produces a log line instead of an outage.
     That is the right arrangement and worth pinning: the day a fetch directive
     appears in the enforcing header, every unlisted host in that log stops
     working at once. */
  ok('the host allow-lists are report-only', /Content-Security-Policy-Report-Only:[^\n]*connect-src/.test(HEADERS));
  const enforced = (HEADERS.match(/^\s*Content-Security-Policy:.*$/m) || [''])[0];
  ok('there is an enforcing policy too', /frame-ancestors/.test(enforced), enforced.slice(0, 80));
  ok('…carrying nothing that can block a third party',
    !/(connect-src|script-src|img-src|media-src|style-src|font-src|frame-src|default-src)/.test(enforced),
    'a fetch directive here turns every gap in the report-only list into an outage');
}

console.log('\n  one row per problem, not per pageview');
{
  ok('the query string is stripped before the message is built',
    /blockedRaw\.split\('\?'\)\[0\]/.test(CSP),
    'gtm= changes every pageview, so one host produced thousands of rows');
  ok('…and from the source file too', /src\.split\('\?'\)\[0\]/.test(CSP));
  /* Which page triggered it is not what identifies the problem, and keeping it
     multiplied every violation by the size of the catalogue. */
  ok('the page is not part of the identity', /url: null,/.test(CSP));

  ok('a violation already seen today is not recorded again',
    /created_at=gte\.\$\{encodeURIComponent\(since\)\}/.test(CSP));
  ok('…on a 24-hour window', /Date\.now\(\) - 86400000/.test(CSP));
  /* Losing a report is worse than storing a duplicate. */
  ok('…and a failed dedupe check records the row rather than dropping it',
    /catch \(_\) \{ \/\* fall through and record it \*\//.test(CSP));
}

console.log('\n  retention that does not depend on anyone remembering');
{
  ok('there is a prune function', /create or replace function public\.prune_error_log/.test(SQL));
  /* CSP reports are only useful while the violation is live — and if it is
     live, a new one is being written right now. */
  ok('CSP reports keep 14 days', /source = 'csp' and created_at < now\(\) - interval '14 days'/.test(SQL));
  ok('real errors keep 90', /source <> 'csp' and created_at < now\(\) - interval '90 days'/.test(SQL));
  ok('…so a real error is never dropped on a CSP schedule',
    SQL.indexOf("source <> 'csp'") > 0 && /90 days/.test(SQL));

  /* A cleanup job somebody has to set up is how the table reached 28,000 rows. */
  ok('it runs from the write path, not a scheduler', /rpc\/prune_error_log/.test(LOG));
  ok('…on a small fraction of writes', /Math\.random\(\) < 0\.02/.test(LOG));
  ok('…and never fails a log write', /\.catch\(\(\) => \{\}\)/.test(LOG));
  ok('…including before the migration has been applied',
    /absent until 0016 runs/.test(LOG));

  ok('the backlog is cleared', /delete from public\.error_log/.test(SQL));
  /* Deleting every CSP row would throw away the record of what had been
     happening. One of each keeps the history and drops the repeats. */
  ok('…keeping one example of each distinct violation',
    /max\(created_at\) as keep_at/.test(SQL) && /e\.created_at < g\.keep_at/.test(SQL));
  /* THE detail. Grouping on the raw message removes 10,575 of 27,993 rows,
     because the duplication is INSIDE the message — the gtm= token changes on
     every pageview, so nearly every row is technically distinct. Stripping the
     query first turns 27,993 rows into 76 actual problems. */
  ok('…grouped on the message WITHOUT its query string',
    /group by split_part\(message, '\?', 1\)/.test(SQL),
    'grouping on the raw message barely dents it');
  ok('…the same normalising new rows get, so history matches what follows',
    /split_part\(message, '\?', 1\)/.test(SQL) && /blockedRaw\.split\('\?'\)\[0\]/.test(CSP));

  /* The first version of this migration was cancelled by the statement timeout
     and applied nothing. Unbounded deletes over 28,000 rows are the reason. */
  ok('deletes are bounded, so the migration cannot be cancelled mid-way',
    /limit 3000/.test(SQL) && /limit v_batch/.test(SQL));
  ok('…with a loop guard rather than an open-ended one', /v_guard > 15/.test(SQL));
  ok('the index is created BEFORE the delete that needs it',
    SQL.indexOf('error_log_source_time_idx') < SQL.indexOf('delete from public.error_log'),
    'index after delete is what made the first attempt a sequential scan');

  ok('and it is indexed for how it is read', /error_log_source_time_idx/.test(SQL));
  ok('the prune is not callable by the public', /revoke all on function public\.prune_error_log\(integer\) from public, anon/.test(SQL));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
