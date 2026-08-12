/* The filing-period panel on Admin → Tax.
 *
 * The page already showed "this month" and "last month". No state asks for
 * either — a return covers a filing PERIOD, and Ohio bills this store
 * semi-annually, so the number that actually goes on the form (everything
 * collected between two dates, split by state) could not be produced at all.
 *
 * What is tested here is only the date arithmetic, because that is where the
 * damage is silent. A period whose upper bound is "the last day of the month"
 * rather than "the first instant of the next one" drops every order placed
 * after midnight on that day — a whole day of collected tax missing from a
 * return, with nothing on screen to suggest anything is wrong.
 */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

/* Lift the function out of the admin bundle. It lives inside an IIFE and is not
   exported, and making it exportable purely to test it would mean the thing
   under test is not the thing that runs. */
function extract(name, src) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found in admin-tax.js');
  let depth = 0, i = src.indexOf('{', start);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(start, i + 1);
}

const SRC = fs.readFileSync(ROOT + '/admin-tax.js', 'utf8');
const taxPeriodRange = new Function(extract('taxPeriodRange', SRC) + '; return taxPeriodRange;')();

const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const on = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0);

console.log('\n  tax filing periods\n');

console.log('  half-years — the one Ohio actually bills on');
{
  const h1 = taxPeriodRange('half', on(2026, 3, 15));
  ok('a March date is in Jan–Jun', iso(h1.from) === '2026-01-01' && iso(h1.to) === '2026-07-01', iso(h1.from) + ' → ' + iso(h1.to));
  ok('…and is labelled as such', /Jan–Jun 2026/.test(h1.label), h1.label);

  const h2 = taxPeriodRange('half', on(2026, 8, 11));
  ok('an August date is in Jul–Dec', iso(h2.from) === '2026-07-01' && iso(h2.to) === '2027-01-01', iso(h2.from) + ' → ' + iso(h2.to));

  const lastFromAug = taxPeriodRange('lasthalf', on(2026, 8, 11));
  ok('the previous half from August is Jan–Jun of the same year',
    iso(lastFromAug.from) === '2026-01-01' && iso(lastFromAug.to) === '2026-07-01', lastFromAug.label);

  /* The one that crosses a year boundary, which is where this kind of maths
     usually breaks — and it is the period you file in January. */
  const lastFromFeb = taxPeriodRange('lasthalf', on(2026, 2, 3));
  ok('the previous half from February is Jul–Dec of the PREVIOUS year',
    iso(lastFromFeb.from) === '2025-07-01' && iso(lastFromFeb.to) === '2026-01-01', lastFromFeb.label);
  ok('…and says so in the label', /Jul–Dec 2025/.test(lastFromFeb.label), lastFromFeb.label);
}

console.log('\n  the upper bound excludes, so the last day is not lost');
{
  /* THE assertion. `to` is the first instant of the next period, so an order
     at 23:59 on the final day still falls inside. A bound of "the last day"
     would silently drop it. */
  const q = taxPeriodRange('quarter', on(2026, 8, 11));
  const lastMoment = new Date(2026, 8, 30, 23, 59, 59);   // 30 Sep 2026
  ok('Q3 runs Jul 1 → Oct 1', iso(q.from) === '2026-07-01' && iso(q.to) === '2026-10-01', q.label);
  ok('an order at 23:59 on the last day is inside the period',
    lastMoment >= q.from && lastMoment < q.to);
  const firstOfNext = new Date(2026, 9, 1, 0, 0, 0);
  ok('…and the first instant of the next one is not', !(firstOfNext < q.to));
}

console.log('\n  quarters and months');
{
  const q1 = taxPeriodRange('quarter', on(2026, 1, 5));
  ok('January is Q1', q1.label === 'Q1 2026' && iso(q1.to) === '2026-04-01', q1.label);

  /* Rolling back from Q1 has to land in the previous YEAR. */
  const lq = taxPeriodRange('lastquarter', on(2026, 2, 20));
  ok('the quarter before Q1 2026 is Q4 2025',
    lq.label === 'Q4 2025' && iso(lq.from) === '2025-10-01' && iso(lq.to) === '2026-01-01', lq.label);

  const lm = taxPeriodRange('lastmonth', on(2026, 1, 9));
  ok('the month before January is December of the previous year',
    iso(lm.from) === '2025-12-01' && iso(lm.to) === '2026-01-01', iso(lm.from) + ' → ' + iso(lm.to));

  const t = taxPeriodRange('today', on(2026, 8, 11));
  ok('today is one day wide', iso(t.from) === '2026-08-11' && iso(t.to) === '2026-08-12');

  const yr = taxPeriodRange('year', on(2026, 8, 11));
  ok('the year runs Jan 1 → Jan 1', iso(yr.from) === '2026-01-01' && iso(yr.to) === '2027-01-01');
}

console.log('\n  wiring');
{
  ok('custom ranges fall through to the date inputs', taxPeriodRange('custom') === null);
  ok('an unknown key does too, rather than guessing a period', taxPeriodRange('nonsense') === null);

  /* The panel must read the SAME order list the rest of the page reads. A
     second query would be a second answer to "how much tax did we collect",
     which is the fault this whole area keeps producing. */
  ok('the panel filters the shared order list, not its own query',
    /_taxOrders\.filter\(o => \{[\s\S]{0,200}?created_at/.test(SRC));
  ok('…and is redrawn when that list loads', /try \{ window\.taxPeriodRender\(\); \} catch/.test(SRC));

  const html = fs.readFileSync(ROOT + '/admin.html', 'utf8');
  ok('the period picker exists', /id="tax-period-select"/.test(html));
  ok('…and defaults to the half-year Ohio files on', /value="half" selected/.test(html));
  /* Collected tax is money held for a state, not a business cost. Saying so
     matters: the number looks like an expense and is not one. */
  ok('the panel says whose money this is', /holding for the state/.test(html));
  ok('…and admits partial refunds are not netted off', /Partial refunds are/.test(html));
}

console.log('\n  collected vs expected');
{
  /* The point of this check is catching UNDER-collection, the expensive
     direction: a missing state registration makes a provider return $0.00
     successfully, so nothing looks broken until the state asks. */
  ok('it asks the live engine rather than a table on the page',
    SRC.includes("fetch('/api/tax-quote?state="));
  ok('…once per distinct jurisdiction, not once per order',
    SRC.includes('new Set(orders.map') && SRC.includes('_expectedCache'));
  ok('…and is capped so one click cannot fire hundreds of requests',
    SRC.includes('EXPECTED_MAX_JURISDICTIONS'));
  ok('under and over collection are told apart, not merged into "off"',
    SRC.includes('Under-collected by') && SRC.includes('Over-collected by'));
  /* "Under-collected" sounds smaller than it is: the money is still owed to
     the state, it just was not taken from the customer. Say that. */
  ok('…and under-collection says whose money it now is',
    SRC.includes('money you owe the state but did not take from customers'));
  ok('a rate that moved since the order is not called an error',
    SRC.includes('not necessarily an error'));
}

console.log('\n  orders charged nothing where tax was due');
{
  ok('zero-tax orders in a taxable state are collected',
    SRC.includes('tax < 0.01 && exp >= 0.01'));
  /* A rounded-down zero is not the same as no tax charged, hence a cent of
     tolerance rather than an exact equality test. */
  ok('…with a cent of tolerance rather than an exact zero test',
    !SRC.includes('tax === 0 &&'));
  const html = fs.readFileSync(ROOT + '/admin.html', 'utf8');
  ok('…and the panel says each row is a bug OR an exemption',
    html.includes('legitimate exemption or a bug'));
}

console.log('\n  what is still being held');
{
  ok('filings are recorded per period', SRC.includes('period: range.label'));
  ok('…and outstanding is collected minus filed',
    SRC.includes('const outstanding = total - filed'));
  ok('…never shown negative', SRC.includes('Math.max(0, outstanding)'));
  ok('…and the filing is audit-logged', SRC.includes("logAdminAudit('tax.filed'"));
}

console.log('\n  tax as a share of order value');
{
  /* Share of GROSS — what the customer actually paid — not of subtotal. Tax
     over subtotal is the rate, which the by-state table already shows. The
     useful figure here is the proportion of the total that was never yours. */
  ok('the share is of gross, not of subtotal',
    SRC.includes("gross += parseFloat(o.subtotal || 0) + tax"));
  ok('…bucketed by month', SRC.includes("(o.created_at || '').slice(0, 7)"));
  ok('…and bounded to a readable window', SRC.includes('slice(-12)'));
  ok('an empty store says so rather than dividing by zero', SRC.includes('No orders yet'));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
