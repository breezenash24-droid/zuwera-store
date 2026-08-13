/* The Tax page could not tell you which engine was in charge.
 *
 * Reported as "when I change it, it just goes back to what it was". It was not
 * failing to save. The engine really was stripe_tax in the database and
 * /api/tax-quote really was answering with it — every order was being priced by
 * the engine that had been picked. The page simply never read it back.
 *
 * admin-tax.js is loaded from inside the Tax page's markup, about a third of
 * the way down admin.html. admin-main.js — which creates `sb` — is the last
 * script on the page. So taxEngineLoad() ran with no Supabase client, hit
 * `if (!window.sb) return;`, and was never called again. _taxEngineCfg kept its
 * declared default of 'builtin', which is what the modal and the label beside
 * it both read.
 *
 * Nothing errored. The page said "Built-in table — in use now" with total
 * confidence, which is indistinguishable from a setting that will not save, and
 * sends you looking at the save path — where nothing is wrong.
 *
 * The same question had a second wrong answer. The integrations panel asks
 * /api/tax-config which engine is selected, and that endpoint never returned
 * one: it read tax_rate_overrides and nothing else. So the Stripe Tax card
 * reported "not selected as this store's engine" while Stripe Tax was pricing
 * every order — a card whose entire job is to say whether something is on,
 * confidently saying no.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const TAXJS = fs.readFileSync(path.join(ROOT, 'admin-tax.js'), 'utf8');
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');
const HTML  = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const CFG   = fs.readFileSync(path.join(ROOT, 'functions/api/tax-config.js'), 'utf8');

console.log('\n  which engine the Tax page thinks is in charge\n');

console.log('  the ordering that caused it is real, and still true');
{
  /* Not a hypothesis — the fix depends on this staying the shape it is. If
     admin-main.js ever moves above admin-tax.js the wait becomes unnecessary,
     but it must never be REMOVED on the assumption that it already did. */
  const tax = HTML.indexOf('src="admin-tax.js');
  const main = HTML.indexOf('src="admin-main.js');
  ok('admin-tax.js is loaded before admin-main.js', tax > 0 && main > 0 && tax < main,
    'tax at ' + tax + ', main at ' + main);
  ok('…and admin-main.js is what creates the client', /const sb = |var sb = |window\.sb\s*=/.test(ADMIN));
}

console.log('\n  it waits for the client instead of giving up');
{
  ok('a missing client schedules a retry', /if \(!window\.sb\) \{ whenSupabaseReady\(taxEngineLoad\); return; \}/.test(TAXJS),
    'returning here is what left _taxEngineCfg on its declared default forever');
  ok('the waiter exists', /function whenSupabaseReady\(fn, tries\)/.test(TAXJS));
  ok('…and is bounded', /tries \|\| 0\) >= 100/.test(TAXJS),
    'a timer with no stop condition is its own bug');

  /* Run it. A client that appears late must still be picked up, and one that
     never appears must not spin forever. */
  const src = TAXJS.slice(TAXJS.indexOf('function whenSupabaseReady'),
                          TAXJS.indexOf('async function taxEngineLoad'));
  let now = 0;
  const timers = [];
  const win = {};
  const run = new Function('window', 'setTimeout', src + ';return whenSupabaseReady;')(
    win, (fn) => { timers.push(fn); });

  let ran = 0;
  run(() => { ran++; });
  ok('it does not fire while the client is absent', ran === 0);
  /* Drain a few ticks with no client, then supply one. */
  for (let i = 0; i < 5 && timers.length; i++) timers.shift()();
  ok('…and keeps waiting', ran === 0, String(ran));
  win.sb = {};
  while (timers.length) timers.shift()();
  ok('the moment the client exists, it loads', ran === 1, String(ran));

  /* And it stops. */
  const win2 = {}; const t2 = [];
  const run2 = new Function('window', 'setTimeout', src + ';return whenSupabaseReady;')(win2, (fn) => { t2.push(fn); });
  let ran2 = 0, ticks = 0;
  run2(() => { ran2++; });
  while (t2.length && ticks < 500) { t2.shift()(); ticks++; }
  ok('a client that never arrives stops being waited for', t2.length === 0 && ran2 === 0,
    ticks + ' ticks, ' + t2.length + ' still queued');
  ok('…after a bounded number of tries', ticks <= 101, String(ticks));
}

console.log('\n  and it is re-read whenever the page is opened');
{
  /* Loading once is not enough even after the wait: the engine changes from
     the modal, and from other tabs. */
  ok('the loader is reachable from outside its closure', /window\.taxEngineLoad = taxEngineLoad;/.test(TAXJS));

  /* Slice the branch itself rather than counting characters from the brace —
     a comment added inside it should not fail this. */
  const branch = ADMIN.slice(ADMIN.indexOf("page === 'tax')"), ADMIN.indexOf("page === 'shipping')"));
  ok('the tax branch was found', branch.length > 0 && branch.length < 2000, String(branch.length));
  ok('opening the Tax page re-reads the engine', /window\.taxEngineLoad\(\)/.test(branch));
  ok('…alongside the data it already reloaded', /window\.taxLoadData\(\)/.test(branch));
}

console.log('\n  the endpoint answers the question it is asked');
{
  ok('/api/tax-config returns the engine', /engine: cfg\.engine/.test(CFG));
  ok('…read through the same loader the payment path uses', /getTaxEngineConfig/.test(CFG),
    'a second reader is a second answer');
  ok('…and whether the built-in table can still price an order', /fallback: cfg\.fallback !== false/.test(CFG));
}

console.log('\n  the integrations card stops guessing');
{
  /* `effective` is the rate TABLE. Reading it for an engine name is what made
     this always fall through to '', and '' is worse than nothing here. */
  ok('it no longer reads the engine out of the rate table',
    !/j\.effective && j\.effective\.engine/.test(ADMIN));
  ok('it takes the engine the endpoint now sends', /typeof j\.engine === 'string' && j\.engine/.test(ADMIN));

  /* THE DISTINCTION THAT MATTERS. The detectors treat undefined as "could not
     check" and anything else as an answer, so a response with no engine in it
     must leave the signal unset rather than assert "none selected". */
  const detect = ADMIN.slice(ADMIN.indexOf("key:'stripe_tax'"), ADMIN.indexOf("key:'apple_pay'"));
  ok('an unreadable engine still reports unknown', /sig\.taxEngine === undefined\) return \{ state: 'unknown'/.test(detect));
  ok('…so the loader must not coerce a miss to empty string', !/sig\.taxEngine = .*\|\| '';/.test(ADMIN),
    "'' reads as an answer — the card would say “not selected” without having checked");
}

console.log('\n  the page below follows the same value');
{
  /* The rate reference and rate editor are shown or demoted by the engine, so
     an engine stuck on 'builtin' also meant those cards claimed to be what
     prices orders. Same root cause, second symptom. */
  ok('the relevance check reads the select the loader fills',
    /function taxTableRole\(\)[\s\S]{0,200}?getElementById\('tax-engine-select'\)/.test(TAXJS));
  ok('…and the loader is what sets that select', /if \(sel\) sel\.value = _taxEngineCfg\.engine;/.test(TAXJS));
  ok('…then tells the page to redraw', /window\.taxEngineOnChange\(\);/.test(TAXJS));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
