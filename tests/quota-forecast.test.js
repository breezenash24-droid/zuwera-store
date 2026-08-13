/* A quota is only useful if it says what happens next.
 *
 * Every card with a limit printed "26 / 30" and stopped — a fact about the
 * past. The question anyone actually has is whether they are going to run out,
 * and roughly when, because that is the point where something CHANGES:
 *
 *   Shippo's free labels running out silently moves label buying to Veeqo,
 *   which is a different account and a different bill.
 *   DeepL's free characters running out starts charging per character.
 *   Cloudinary credits running out makes image transforms fail outright.
 *
 * Straight-line from usage so far this month, and deliberately no cleverer.
 * A 30-label allowance does not contain enough signal for a weighting scheme,
 * and a confident-looking forecast built on eleven data points is worse than an
 * obviously simple one.
 *
 * The behaviour that matters most here is the REFUSAL to guess. A forecast that
 * cries wolf on the 3rd of every month gets ignored by the 4th, and then it is
 * not there when it counts.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SRC = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');
const projectQuota = new Function(
  SRC.slice(SRC.indexOf('function projectQuota'), SRC.indexOf('/* "3 minutes ago"')) + ';return projectQuota;'
)();

const strip = (h) => String(h).replace(/<[^>]+>/g, '').trim();
// January has 31 days, so the arithmetic in these cases is checkable by hand.
const on = (day) => new Date(2026, 0, day, 12, 0).toISOString();
const say = (used, limit, day, opts) => strip(projectQuota(used, limit, Object.assign({ now: on(day) }, opts || {})));

console.log('\n  quota forecast\n');

console.log('  it refuses to guess');
{
  /* Two days in, one label a day is not a trend. */
  ok('too early in the month → nothing', say(4, 30, 2) === '');
  ok('…even on day 1 with heavy use', say(20, 30, 1) === '');
  ok('day 3 is enough to start', say(9, 30, 3) !== '');

  ok('no usage yet → nothing', say(0, 30, 15) === '');
  ok('no limit → nothing', say(5, 0, 15) === '');
  ok('a negative limit → nothing', say(5, -3, 15) === '');
  ok('non-numeric input → nothing', say('lots', 30, 15) === '' && say(5, 'thirty', 15) === '');
  ok('undefined input → nothing', say(undefined, 30, 15) === '' && say(5, undefined, 15) === '');
}

console.log('\n  when it will run out');
{
  /* The live case: 26 of 30 Shippo labels on the 10th. 2.6/day, 4 left, so it
     crosses in a day and a half. */
  const s = say(26, 30, 10);
  ok('a store on track to cross says so', /cross the 30 limit around/.test(s), s);
  ok('…with a date', /Jan 1[12]/.test(s), s);
  ok('…and is styled as a warning', /api-forecast warn/.test(projectQuota(26, 30, { now: on(10) })));
  ok('…and can carry what changes when it happens',
    /Labels then come from Veeqo/.test(say(26, 30, 10, { whenOver: 'Labels then come from Veeqo.' })));
}

console.log('\n  when it will not');
{
  const s = say(5, 30, 10);
  ok('comfortably inside → says the projected total', /about 16 of 30/.test(s), s);
  ok('…as reassurance, not a warning', !/api-forecast warn/.test(projectQuota(5, 30, { now: on(10) })));
  /* "You will not run out" is information too — it stops someone pre-emptively
     paying for a tier they do not need. */
  ok('…and says explicitly that nothing changes', /no change expected/.test(s), s);

  /* The straight line can run past a boundary the quota does not. Crossing on
     Feb 2 means the reset lands first and nothing actually happens. */
  const edge = say(20, 30, 28);
  ok('a crossing that falls after the reset is not a warning',
    !/cross the/.test(edge), edge);
  ok('…and says why it is fine', /reset lands first/.test(edge) || /no change expected/.test(edge), edge);
}

console.log('\n  when it already has');
{
  const s = say(30, 30, 10);
  ok('at the limit → says it is used up', /used up for this month/.test(s), s);
  ok('over the limit → same', /used up for this month/.test(say(44, 30, 10)));
  ok('…styled as done, not as a forecast', /api-forecast over/.test(projectQuota(30, 30, { now: on(10) })));
  ok('…and still says what that means',
    /Labels then come from Veeqo/.test(say(30, 30, 10, { whenOver: 'Labels then come from Veeqo.' })));
}

console.log('\n  the maths is right on a short month');
{
  /* February 2026 has 28 days. A rate that is safe across 31 days can overrun a
     shorter one, and the projection has to use the real length. */
  const feb = (day) => new Date(2026, 1, day, 12, 0).toISOString();
  const s = strip(projectQuota(14, 30, { now: feb(14) }));   // 1/day × 28 = 28 of 30
  ok('a short month uses its own length', /about 28 of 30/.test(s), s);
  const leap = strip(projectQuota(15, 30, { now: new Date(2028, 1, 15, 12, 0).toISOString() })); // 2028 leap: 29 days
  ok('…including a leap February', /about 29 of 30/.test(leap), leap);
}

console.log('\n  it is actually wired to the cards that have limits');
{
  ok('Shippo forecasts its free-tier labels',
    /projectQuota\(s\.freeTier\.used, s\.freeTier\.limit/.test(SRC));
  ok('…naming Veeqo, because crossing silently changes who buys the label',
    /Labels then come from Veeqo/.test(SRC));
  ok('DeepL forecasts its characters',
    /projectQuota\(s\.characterCount, s\.characterLimit/.test(SRC));
  ok('…naming the charge that starts', /charges per character past that/.test(SRC));
  ok('Cloudinary forecasts its credits', /projectQuota\(s\.credits\.usage/.test(SRC));
  /* Cloudinary is the one with no fallback — worth saying, because the other
     two degrade and this one simply stops. */
  ok('…and says transforms fail rather than fall back', /fail rather than falling back/.test(SRC));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
