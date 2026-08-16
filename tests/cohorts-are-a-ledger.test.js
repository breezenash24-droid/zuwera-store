/* Cohorts, and why this is the retention analysis a 61-order store may have.
 *
 * Every retention number in the dashboard before this was one figure over all
 * of time: average LTV, repeat rate, new-vs-returning revenue. Each is true and
 * none can answer the question a store actually has — are the people who bought
 * this month worth more or less than the people who bought in March?
 *
 * A cohort table answers it and stays honest at any volume, because it is a
 * LEDGER. Every cell is money that was really taken from people who really did
 * place a first order in that month. Nothing is fitted, predicted or scored.
 * RFM buckets and predicted LTV are the opposite: they need enough repeat
 * customers to fit against, and with 61 orders they would be numbers invented
 * from a shape, sitting next to numbers that are real.
 *
 * The function is LIFTED OUT OF THE PAGE AND RUN against a stub DOM. Asserting
 * on the source text would pass on code that never worked, and the failure
 * modes here are arithmetic — an off-by-one in the month offset puts a
 * customer's second order in the wrong column and nobody would ever notice.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SRC = fs.readFileSync(path.join(ROOT, 'analytics.html'), 'utf8');
const START = SRC.indexOf('const renderCohorts = () => {');
const END = SRC.indexOf('// Merchandising — avg units/order');
if (START < 0 || END < START) { console.log('  ✗ could not find renderCohorts in analytics.html'); process.exit(1); }
const BLOCK = SRC.slice(START, END);

/** Enough DOM for the function to write into, and enough to read back. */
function run(orders, now) {
  const nodes = {};
  const make = () => {
    const el = {
      textContent: '', innerHTML: '', style: {},
      setAttribute() {}, getAttribute: () => null,
      querySelectorAll(sel) {
        /* The shading pass reads back the cells it just wrote. Parsing the
           generated HTML is the only way to exercise it for real. */
        if (!/data-per/.test(sel)) return [];
        return [...String(el.innerHTML).matchAll(/data-per="([\d.]+)"/g)]
          .map((m) => ({ _per: Number(m[1]), style: {}, getAttribute: () => m[1] }));
      },
    };
    return el;
  };
  for (const id of ['cohortTable', 'cohortSub', 'cohortNote']) nodes[id] = make();

  const fn = new Function('allOrders', 'document', 'orderTotal', 'fmtMoney0', 'setText', 'Date', `
    ${BLOCK}
    renderCohorts();
  `);
  fn(
    orders,
    { getElementById: (id) => nodes[id] || null },
    (o) => Number(o && o.total) || 0,
    (n) => '$' + Math.round(Number(n) || 0),
    (id, v) => { if (nodes[id]) nodes[id].textContent = v; },
    class extends Date { constructor(...a) { if (!a.length) super(now); else super(...a); } },
  );
  return nodes;
}

const order = (email, iso, total) => ({ email, created_at: iso, total });
const NOW = '2026-04-15T00:00:00Z';

console.log('\n  cohorts are a ledger, not a forecast\n');

console.log('  a customer belongs to the month of their first order, and stays there');
{
  const n = run([
    order('a@x.com', '2026-01-10T00:00:00Z', 100),
    order('a@x.com', '2026-03-10T00:00:00Z', 50),   // same customer, later month
    order('b@x.com', '2026-03-05T00:00:00Z', 200),
  ], NOW);
  const html = n.cohortTable.innerHTML;
  ok('two cohorts, by first order', /2026-01/.test(html) && /2026-03/.test(html));
  ok('…and the repeat buyer is NOT counted in March',
    /2026-03[\s\S]*?<td style="text-align:right[^>]*>1</.test(html.replace(/\n/g, '')),
    'a customer who returns must not appear as a new customer in the month they returned');

  /* The arithmetic that matters: a's second order is 2 months after their
     first, so it belongs in the +2 column of the JANUARY row. Put it in
     March's row and the January cohort looks worthless while March looks
     twice as good as it is. */
  const jan = /<tr[^>]*>[\s\S]*?2026-01[\s\S]*?<\/tr>/.exec(html.replace(/\n/g, ''));
  const cells = jan ? [...jan[0].matchAll(/data-per="([\d.]+)"/g)].map((m) => Number(m[1])) : [];
  ok('january cohort starts at 100', cells[0] === 100, JSON.stringify(cells));
  ok('…is still 100 one month later, having bought nothing', cells[1] === 100);
  ok('…and rises to 150 at +2, where the second order actually happened', cells[2] === 150);
}

console.log('\n  cumulative, so a row can only rise');
{
  const n = run([
    order('a@x.com', '2026-01-05T00:00:00Z', 100),
    order('a@x.com', '2026-02-05T00:00:00Z', 40),
    order('a@x.com', '2026-03-05T00:00:00Z', 10),
  ], NOW);
  const cells = [...n.cohortTable.innerHTML.matchAll(/data-per="([\d.]+)"/g)].map((m) => Number(m[1]));
  ok('each cell includes everything before it', JSON.stringify(cells.slice(0, 4)) === JSON.stringify([100, 140, 150, 150]),
    JSON.stringify(cells));
  ok('…and never falls', cells.every((v, i) => i === 0 || v >= cells[i - 1]));
}

console.log('\n  a month that has not happened is blank, not zero');
{
  /* THE MOST COMMON WAY A COHORT TABLE LIES. A cohort two months old has two
     months of evidence. Filling the rest with $0 reads as "these customers
     stopped buying" when it means "this month has not happened yet", and it
     drags every average down for exactly the newest cohorts a store is most
     interested in. */
  /* Two cohorts of DIFFERENT ages, which is the only way the shape appears.
     The table is as wide as the OLDEST cohort, so a single young cohort on its
     own is correctly a narrow table with no gaps — the first version of this
     asserted blanks against exactly that and failed a function that was
     right. The triangle only exists when something older sets the width. */
  const n = run([
    order('old@x.com', '2026-01-01T00:00:00Z', 100),
    order('new@x.com', '2026-03-01T00:00:00Z', 100),
  ], NOW);
  const html = n.cohortTable.innerHTML.replace(/\n/g, '');
  /* Split on the row boundary rather than matching `<tr>…2026-03…</tr>`. That
     pattern is lazy at both ends but anchors on the FIRST <tr in the string,
     so it happily spanned the January row as well and counted six cells for a
     row that has two. Same unbounded-lazy mistake as the last two scanners —
     bound the search to the thing being searched. */
  const rowFor = (key) => html.split('<tr').find((r) => r.includes(key)) || '';
  const jan = rowFor('2026-01');
  const mar = rowFor('2026-03');
  const filled = (r) => [...r.matchAll(/data-per=/g)].length;
  const blanks = (r) => [...r.matchAll(/<td style="padding:\.45rem \.6rem;"><\/td>/g)].length;
  ok('the three-month-old cohort fills every column', filled(jan) === 4, String(filled(jan)));
  ok('…and the one-month-old cohort stops after two', filled(mar) === 2, String(filled(mar)));
  ok('…leaving the rest empty rather than $0', blanks(mar) === 2, String(blanks(mar)));
}

console.log('\n  what it refuses to count');
{
  const n = run([
    order('', '2026-02-01T00:00:00Z', 500),          // guest, no email
    order('a@x.com', '2026-02-02T00:00:00Z', 100),
  ], NOW);
  const cells = [...n.cohortTable.innerHTML.matchAll(/data-per="([\d.]+)"/g)].map((m) => Number(m[1]));
  ok('an order with no email is excluded, not bundled into "new"',
    cells[0] === 100, JSON.stringify(cells) + ' — $500 with nobody attached would inflate every first cell');
  ok('…and the exclusion is disclosed, not silent',
    /1 order had no email address/.test(n.cohortNote.textContent), n.cohortNote.textContent);
}

console.log('\n  small cohorts are shown, and marked');
{
  /* Hiding them would make the table look more even than the business is.
     Showing them unmarked invites reading one large order as a trend. */
  const n = run([order('a@x.com', '2026-02-01T00:00:00Z', 900)], NOW);
  ok('a cohort under 5 customers is flagged', /·<\/span>|·/.test(n.cohortTable.innerHTML));
  ok('…and the note says what the mark means',
    /fewer than 5 customers/.test(n.cohortNote.textContent));
}

console.log('\n  nothing here is predicted');
{
  /* The guard on the honest-at-this-volume claim. If a future edit adds a
     projection, a fitted curve or an RFM score to this block, it stops being a
     ledger and this file's whole argument stops holding. */
  for (const word of ['predict', 'forecast', 'projected', 'rfm', 'churnProbability', 'expectedLtv']) {
    ok('no ' + word + ' in the cohort block', !new RegExp(word, 'i').test(BLOCK),
      'a modelled number next to measured ones reads as measured');
  }
  ok('the table is capped at 12 months so it cannot imply a longer history',
    /Math\.min\(12,/.test(BLOCK));
}

console.log('\n  it survives an empty store');
{
  const n = run([], NOW);
  ok('no orders renders a sentence, not a crash', /No orders with an email/.test(n.cohortTable.innerHTML));
  const g = run([order('', '2026-02-01T00:00:00Z', 10)], NOW);
  ok('…and so does a store with only guest orders', /No orders with an email/.test(g.cohortTable.innerHTML));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
