/* The one quota question a backup can actually answer.
 *
 * Every other card on the API page forecasts running out: usage so far this
 * month, extended in a straight line, with a date attached. Brevo cannot be
 * asked that and it took a while to see why. Brevo is failover — it sends
 * nothing while Resend is healthy. Its usage is zero on almost every day, so
 * a rate extrapolated from it is zero, and a forecast built on zero is noise
 * with a percentage sign on it. Printing "on track for 0 of 9,000" would be
 * technically true and completely useless.
 *
 * The question that matters about a backup is not how much of it you have
 * spent. It is whether it could carry the traffic if it were ever called on —
 * and the usual way of discovering the answer is during the outage, which is
 * the worst possible time.
 *
 * So this compares Brevo's daily allowance against the busiest day this store
 * has actually had, taken from email_log rather than estimated. If Resend dies
 * on a day like that one, either the backup covers it or some customers do not
 * get their order confirmation.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const ADMIN = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');
const API   = fs.readFileSync(path.join(ROOT, 'functions/api/api-status.js'), 'utf8');

/* The real renderer, lifted out and run. */
const fnStart = ADMIN.indexOf('function brevoCover(peak, dailyLimit)');
const fnEnd = ADMIN.indexOf('\n        }', ADMIN.indexOf('covers that with', fnStart)) + 10;
const brevoCover = new Function(ADMIN.slice(fnStart, fnEnd) + ';return brevoCover;')();
const strip = (h) => String(h).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const say = (peak, limit) => strip(brevoCover(peak, limit || 300));

const day = (date, n, capped) => ({ peak: n, peakDate: date, daysWithSends: 5, capped: !!capped });

(async () => {
  const S = await import(pathToFileURL(ROOT + '/functions/api/api-status.js').href);

  console.log('\n  can the backup carry the load\n');

  console.log('  it refuses to invent an answer');
  {
    /* Same ethic as projectQuota: a missing number beats a made-up one. */
    ok('no data at all says nothing', say(null) === '');
    ok('a store that has never sent says nothing', say(day('2026-08-01', 0)) === '');
    ok('a nonsense count says nothing', say({ peak: 'lots', peakDate: '2026-08-01' }) === '');
    ok('a negative count says nothing', say(day('2026-08-01', -4)) === '');

    /* And the fetch side refuses too, rather than reporting zero. */
    ok('no service key means no answer', (await S.emailPeakDay({})) === null);
    ok('…and no Supabase url either', (await S.emailPeakDay({ SUPABASE_SERVICE_ROLE_KEY: 'x' })) === null);
  }

  console.log('\n  when the backup would cope');
  {
    const out = say(day('2026-08-04', 42));
    ok('it names the busiest day', /42 emails/.test(out) && /Aug 4/.test(out), out);
    ok('…and says the allowance covers it', /covers that/.test(out), out);
    /* Comfort is information: it stops someone paying for a tier they do not
       need, which is the same reason projectQuota reports "no change expected". */
    ok('…with the headroom quantified', /86% to spare/.test(out), out);
    ok('it does not warn', !/warn/.test(brevoCover(day('2026-08-04', 42), 300)));
  }

  console.log('\n  when it would not');
  {
    const out = say(day('2026-08-04', 480));
    ok('it says so plainly', /not.*have covered it/.test(out), out);
    ok('…and by how much', /about 180 would have gone unsent/.test(out), out);
    ok('…and what to do before it matters', /paid tier before it is needed/.test(out), out);
    ok('it warns', /api-forecast warn/.test(brevoCover(day('2026-08-04', 480), 300)));

    /* Exactly at the limit is covered, not short — an off-by-one here reads as
       a warning about a day that would have been fine. */
    ok('exactly at the limit counts as covered', /covers that/.test(say(day('2026-08-04', 300))));
    ok('one over does not', /not/.test(say(day('2026-08-04', 301))));
  }

  console.log('\n  a capped scan is not reported as a fact');
  {
    /* The scan reads the newest rows up to a limit, so a full page means the
       real peak can only be higher. Presenting a floor as the answer is how a
       card tells you you are fine when you are not. */
    ok('a capped read says "at least"', /at least 900/.test(say(day('2026-08-04', 900, true))));
    ok('…and an uncapped one does not hedge', !/at least/.test(say(day('2026-08-04', 900))));
    ok('the fetch reports whether it capped', /capped: rows\.length >= PEAK_SCAN_LIMIT/.test(API));
  }

  console.log('\n  what it asks the database');
  {
    ok('only sends that actually went out', /status=eq\.sent/.test(API),
      'counting failures would overstate the load the backup must carry');
    ok('a 30-day window', /30 \* 86400000/.test(API));
    ok('…bounded, because this runs inside a status check', /PEAK_SCAN_LIMIT = \d+/.test(API));
    ok('grouped by calendar day', /String\(r\.created_at \|\| ''\)\.slice\(0, 10\)/.test(API));
    ok('it never throws into the status check', /catch \(_\) \{ return null; \}/.test(API));

    /* Only when there is a backup to ask about — this is a database round trip
       attached to a page that must stay fast. */
    ok('it is skipped when Brevo is not configured',
      /if \(out\.brevo && out\.brevo\.configured\) \{[\s\S]{0,120}?emailPeakDay\(env\)/.test(API));
  }

  console.log('\n  the limit comes from the check, not the card');
  {
    /* The card used to print "300 emails" as a literal beside a number the API
       returns. Two sources for one figure is how they end up disagreeing. */
    ok('the daily limit is read from the service', /s\.freePlan && s\.freePlan\.dailyLimit/.test(ADMIN));
    ok('…with the free-plan default behind it', /\|\| 300;/.test(ADMIN));
    ok('the check supplies it', /freePlan: \{ dailyLimit: 300 \}/.test(API));
    /* A paid Brevo plan has a different allowance, and the cover line has to
       move with it rather than keep quoting the free one. */
    const paid = say(day('2026-08-04', 480), 20000);
    ok('a larger allowance changes the verdict', /covers that/.test(paid), paid);
  }

  console.log('\n  and the neighbour bug it sat next to');
  {
    /* webhook_events has received_at and no created_at, so lastUsed() was
       handing sinceWords() undefined — the Stripe card said "last used at an
       unknown time" while holding the row that carried the timestamp. */
    ok('the webhook time is read from the column that exists',
      /at: rows\[0\]\.received_at/.test(API));
    ok('…which is the column it selected', /webhook_events\?select=received_at/.test(API));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✗ suite crashed: ' + e.stack); process.exit(1); });
