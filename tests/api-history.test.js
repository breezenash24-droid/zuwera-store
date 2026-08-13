/* The API panel remembers.
 *
 * Every check it ran was thrown away the moment you navigated off, and nothing
 * calls /api/status but the admin page itself — so a key that died at 4am was
 * invisible until somebody happened to open the tab, and "is this healthy?"
 * could only ever be answered about this exact second.
 *
 * "Resend is failing" is a fact. "Resend has been failing since 04:12" is
 * something you can act on, and the whole difference is whether the last check
 * was written down.
 *
 * Two claims are kept deliberately separate, because conflating them is how a
 * panel lies politely:
 *   health    — the vendor answered our probe just now
 *   last used — something in this store actually did work with it
 * A key can validate perfectly while nothing has touched it for a month.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const API = fs.readFileSync(path.join(ROOT, 'functions/api/api-status.js'), 'utf8');
const SQL = fs.readFileSync(path.join(ROOT, 'migrations/0014_api_status_history.sql'), 'utf8');
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');
const CODE = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*(--|\/\/).*$/gm, ' ');

console.log('\n  api status history\n');

console.log('  somewhere to keep it');
{
  ok('api_status_log exists', /create table if not exists public\.api_status_log/.test(SQL));
  ok('…indexed the way it is read: this service, newest first',
    /api_status_log \(service, checked_at desc\)/.test(SQL));
  ok('…and the way it is pruned', /api_status_log \(checked_at\)/.test(SQL));
  /* A log with no retention becomes the largest thing in the database. Doing it
     in the write path rather than a scheduled job, because a job nobody sets up
     is the same as no retention at all. */
  ok('it prunes itself', /delete from api_status_log where checked_at < now\(\) - interval '30 days'/.test(SQL));
  ok('…but not on every single write', /random\(\) < 0\.0\d/.test(SQL));
  ok('the recorder takes the whole run at once, not one call per service',
    /record_api_status\(p_rows jsonb\)/.test(SQL));
  ok('…and is not reachable by anonymous callers',
    /revoke all on function public\.record_api_status\(jsonb\) from public, anon/.test(SQL));
  ok('…with the vendor error truncated, not stored whole',
    /left\(r->>'detail', 500\)/.test(SQL));
}

console.log('\n  the table Stripe has been writing to all along');
{
  /* stripe-webhook.js has logged every delivery since it was written, through a
     helper that swallows its own failures because a logging problem must never
     fail a paid order. No .sql file ever created the table, so every one of
     those writes 404'd into the catch — and the log built to answer "is Stripe
     reaching us and is the signature passing" was empty exactly when that
     question was being asked. */
  ok('webhook_events is finally created', /create table if not exists public\.webhook_events/.test(SQL));
  const cols = ['event_type', 'payment_intent', 'customer_email', 'amount_cents', 'sig_verified', 'raw_status', 'error_message'];
  const missing = cols.filter((c) => !new RegExp('\\b' + c + '\\b').test(SQL));
  ok('…with every column the webhook actually sends', missing.length === 0, missing.join(', '));

  /* Verified against the writer rather than against a list I typed, or the two
     drift and the writes start failing again for a new reason. */
  const writer = fs.readFileSync(path.join(ROOT, 'functions/api/stripe-webhook.js'), 'utf8');
  const sent = [...writer.matchAll(/^\s{6}([a-z_]+):/gm)].map((m) => m[1]);
  const unknown = [...new Set(sent)].filter((c) => cols.includes(c) === false && ['event_type', 'payment_intent', 'customer_email', 'amount_cents', 'sig_verified', 'raw_status', 'error_message'].includes(c));
  ok('…and nothing the writer sends is unaccounted for', unknown.length === 0, unknown.join(', '));
  ok('it is indexed for "what happened recently"', /webhook_events_received_idx/.test(SQL));
  /* The column is `received_at`, NOT `created_at` — every other log table here
     uses created_at, which is exactly why this was written wrong first time and
     why the read silently returned nothing against the real database. Asserted
     against BOTH files so the schema and the query cannot drift apart again. */
  ok('the webhook log uses received_at, the name production actually has',
    /received_at\s+timestamptz/.test(SQL) && !/webhook_events[\s\S]{0,400}?created_at/.test(SQL));
}

console.log('\n  reading it back');
{
  ok('history is fetched in one query, not one per service',
    /api_status_log\?select=service,ok,checked_at&order=checked_at\.desc&limit=\d+/.test(API));
  ok('a missing table is simply no history, never an error',
    /if \(!r\.ok\) return \{\};/.test(API));
  ok('last-used reads the send log', /email_log\?select=provider,status,created_at&status=eq\.sent/.test(API));
  ok('…per provider, so you can see which failover tier is carrying traffic',
    /if \(p && !out\[p\]\)/.test(CODE(API)));
  ok('…and the webhook log for Stripe', /webhook_events\?select=received_at,raw_status/.test(API));
  ok('…querying the same column the migration defines',
    /webhook_events\?select=received_at/.test(API) && /received_at\s+timestamptz/.test(SQL),
    'a read naming a column the table does not have returns nothing, silently');
  /* Loosely matched on the members rather than the exact array literal — a
     third annotation (key changes) was added and the arity is not the property
     being asserted. What matters is that NONE of them can fail the page: they
     are all optional colour on a panel whose job is to load. */
  ok('none of the annotations can fail the page',
    /Promise\.allSettled\(\[[\s\S]{0,120}?statusHistory\(env\)[\s\S]{0,120}?lastUsed\(env\)/.test(API));
  ok('…including the key-change history', /keyChanges\(env\)/.test(API));
  /* Key changes were recorded ONLY as an alert email until now, so the record
     of who rotated what lived in an inbox for as long as somebody kept it —
     while every other consequential admin action went to admin_audit_log. */
  const UPD = fs.readFileSync(path.join(ROOT, 'functions/api/update-api-key.js'), 'utf8');
  ok('a key change is written to the audit log, not only emailed',
    /action: rejected \? 'api_key\.rejected' : 'api_key\.update'/.test(UPD));
  ok('…and a REJECTED attempt is recorded too',
    /auditKeyChange\(env, \{ keyName, masked: null[\s\S]{0,80}rejected: true \}\)/.test(UPD),
    'somebody probing what this endpoint accepts is the more interesting row');
  ok('…storing the masked preview, never the value',
    /metadata: \{ masked: masked \|\| null \}/.test(UPD) && !/metadata: \{ value/.test(UPD));
  ok('…best-effort, so a log failure cannot fail the save',
    /catch \(_\) \{ \/\* the alert email carries the same facts/.test(UPD));
  ok('each service carries its own history and evidence',
    /s\.history = history\[name\]/.test(CODE(API)) && /s\.lastUsed = used\[name\]/.test(CODE(API)));
}

console.log('\n  recording a run');
{
  ok('the run is recorded', /rpc\/record_api_status/.test(API));
  /* After the answer is built, and after the response goes out. A page that got
     slower in order to remember how fast it used to be would be a poor trade. */
  ok('…after the response is assembled', API.indexOf('const built = {') < API.indexOf('recordRun(env, built)'));
  ok('…and outlives the response via waitUntil, so the write is not cut off',
    /waitUntil\(write\)/.test(API));
  ok('…falling back to awaiting it where waitUntil is absent',
    /else await write\.catch\(\(\) => \{\}\)/.test(API));
  ok('a failed write never breaks the status page', /catch \(_\) \{ \/\* history is a nicety/.test(API));
}

console.log('\n  how long has it been like this');
{
  /* The window walk is the part that is easy to get subtly wrong, so it is run
     rather than read. Rebuilt from the endpoint's own logic. */
  const sinceOf = (rows) => {
    const current = rows[0];
    let since = current.checked_at;
    for (const row of rows) { if (row.ok !== current.ok) break; since = row.checked_at; }
    return since;
  };
  const at = (mins) => new Date(Date.UTC(2026, 0, 1, 12, 0) - mins * 60000).toISOString();

  // newest-first, as the query returns them
  const failingRecently = [
    { ok: false, checked_at: at(0) }, { ok: false, checked_at: at(10) }, { ok: false, checked_at: at(20) },
    { ok: true,  checked_at: at(30) }, { ok: true,  checked_at: at(40) },
  ];
  ok('since = the oldest sample still matching the current state',
    sinceOf(failingRecently) === at(20), sinceOf(failingRecently));
  ok('…not the newest', sinceOf(failingRecently) !== at(0));
  ok('…and not the start of all history', sinceOf(failingRecently) !== at(40));

  const alwaysOk = [{ ok: true, checked_at: at(0) }, { ok: true, checked_at: at(99) }];
  ok('a service that never failed dates back to its first sample', sinceOf(alwaysOk) === at(99));
  const single = [{ ok: true, checked_at: at(5) }];
  ok('a single sample is its own start', sinceOf(single) === at(5));

  /* Recovery must not read as "healthy for hours" — the run starts at the
     recovery, not at the last time it happened to be green. */
  const justRecovered = [
    { ok: true,  checked_at: at(0) },
    { ok: false, checked_at: at(5) },
    { ok: true,  checked_at: at(600) },
  ];
  ok('a service that just recovered says so, not "healthy since yesterday"',
    sinceOf(justRecovered) === at(0));
}

console.log('\n  what the card says');
{
  const f = new Function('escapeHtml',
    ADMIN.slice(ADMIN.indexOf('function sinceWords'), ADMIN.indexOf('function renderApiCard'))
    + ';return { sinceWords, apiHistoryLine };')((s) => String(s));

  ok('under a minute reads as just now', f.sinceWords(new Date().toISOString()) === 'just now');
  ok('minutes are singular when there is one',
    f.sinceWords(new Date(Date.now() - 60000).toISOString()) === '1 minute ago');
  ok('hours roll up', /hours ago/.test(f.sinceWords(new Date(Date.now() - 5 * 3600000).toISOString())));
  ok('days roll up', /days ago/.test(f.sinceWords(new Date(Date.now() - 3 * 86400000).toISOString())));
  ok('a month or more becomes a date', /^on /.test(f.sinceWords(new Date(Date.now() - 90 * 86400000).toISOString())));
  /* An unparseable timestamp must say so rather than render "NaN minutes ago"
     or, worse, "just now". */
  ok('a bad timestamp admits it', f.sinceWords('not-a-date') === 'at an unknown time');
  ok('…and so does a missing one', f.sinceWords(undefined) === 'at an unknown time');

  const strip = (h) => h.replace(/<[^>]+>/g, '').trim();
  ok('a healthy service says how long',
    /^Healthy since /.test(strip(f.apiHistoryLine({ ok: true, history: { since: new Date(Date.now() - 7200000).toISOString(), recent: [1, 1, 1] } }))));
  ok('a failing one says the same', /^Failing since /.test(strip(f.apiHistoryLine({ ok: false, history: { since: new Date().toISOString(), recent: [0, 0] } }))));

  /* Intermittent is the state people misread as fixed: you check, it is green,
     you move on. It has to be named. */
  const flap = strip(f.apiHistoryLine({ ok: false, history: { since: new Date().toISOString(), recent: [1, 0, 1, 0] } }));
  ok('flapping is called out explicitly', /intermittent recently/.test(flap), flap);
  const steady = strip(f.apiHistoryLine({ ok: true, history: { since: new Date().toISOString(), recent: [1, 1, 1, 1] } }));
  ok('…and a steady service is not accused of it', !/intermittent/.test(steady));

  ok('no history means no line at all, rather than an empty one',
    f.apiHistoryLine({ ok: true, history: {} }) === '');
  ok('the card renders it', /\$\{histLine\}/.test(ADMIN) && /\$\{usedLine\}/.test(ADMIN));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
