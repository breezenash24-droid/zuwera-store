/* The return window had everything except a number.
 *
 * returnEligibility() enforces a window. The refusal message is editable. Both
 * callers — customer-hub.js and guest-return.js — pass returnWindowFrom(config).
 * tests/return-window.test.js covers the date cases: delivered_at present, only
 * created_at, neither, and the boundary.
 *
 * And it never once ran. returnWindowFrom() defaults windowDays to 0, the guard
 * is `Number.isFinite(windowDays) && windowDays > 0`, and there was nowhere in
 * the admin to type a number. So every order confirmation promised 30-day
 * returns while an order from three years ago was still returnable — the exact
 * state the whole feature was built to end, sitting behind a missing input box.
 *
 * The same shape as the PayPal endpoints and the tax-relevance work: complete,
 * correct, unreachable. Which is why this file tests the WIRING rather than the
 * rule — the rule already has its own tests, and the rule was never the problem.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const HTML = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const UI   = fs.readFileSync(path.join(ROOT, 'admin-returns-ui.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');

(async () => {
  const R = await import(pathToFileURL(ROOT + '/functions/api/_returns.js').href);

  console.log('\n  the return window can be set\n');

  console.log('  the number reaches the rule');
  {
    /* The admin writes commerce_config.returns; returnWindowFrom reads
       cfg.returns. If those two names ever drift, the box saves and the rule
       stays off — silently, which is how this feature spent its whole life. */
    const w = R.returnWindowFrom({ returns: { windowDays: 30, transitAllowanceDays: 5 } });
    ok('a saved window is read back', w.windowDays === 30);
    ok('…and the delivery allowance with it', w.transitDays === 5);

    ok('the admin writes the key the rule reads', /cfg\.returns = Object\.assign/.test(UI),
      'a different key here means the box saves and nothing changes');
    ok('…using the same field names', /windowDays: d/.test(UI) && /transitAllowanceDays: t/.test(UI));
  }

  console.log('\n  nothing set means nothing changes');
  {
    /* An existing store must behave exactly as before until somebody chooses a
       number. Turning a window on by default would refuse returns nobody was
       warned about. */
    ok('no config at all → no limit', R.returnWindowFrom({}).windowDays === 0);
    ok('an empty returns object → no limit', R.returnWindowFrom({ returns: {} }).windowDays === 0);
    ok('a blank box saves 0 rather than a default', /rawDays === '' \? 0 :/.test(UI),
      'defaulting a blank field to 30 would silently start refusing returns');
    ok('…while a blank allowance keeps the 7-day fallback', /rawTransit === '' \? 7 :/.test(UI));
  }

  console.log('\n  the values are bounded before they are stored');
  {
    /* returnWindowFrom clamps, which protects the rule but not the shop owner:
       type 4000, be given 3650, and believe your policy says something it does
       not. Refused at the input instead. */
    ok('the rule still clamps as a backstop', R.returnWindowFrom({ returns: { windowDays: 99999 } }).windowDays === 3650);
    ok('…but the admin refuses out-of-range rather than clamping quietly',
      /d < 0 \|\| d > 3650/.test(UI) && /t < 0 \|\| t > 60/.test(UI),
      'silently changing what someone typed is telling them their policy is something it is not');

    ok('a negative window is not a window', R.returnWindowFrom({ returns: { windowDays: -5 } }).windowDays === 0);
    ok('garbage is not a window', R.returnWindowFrom({ returns: { windowDays: 'soon' } }).windowDays === 0);
  }

  console.log('\n  it is actually on the page');
  {
    ok('the card exists', /id="ret-window-card"/.test(HTML));
    ok('…with both inputs', /id="ret-window-days"/.test(HTML) && /id="ret-window-transit"/.test(HTML));
    ok('…and a save button wired to the handler', /onclick="saveReturnWindow\(\)"/.test(HTML));
    ok('the loader is published', /window\.loadReturnWindowCard =/.test(UI));
    ok('the saver is published', /window\.saveReturnWindow =/.test(UI));
    /* THE LINE THAT MAKES IT REACHABLE. Everything else about this feature was
       already correct and nothing called it. */
    ok('opening the Returns page loads it',
      /loadReturnWindowCard === 'function'\) loadReturnWindowCard\(\)/.test(MAIN),
      'the card would render empty and never populate');
  }

  console.log('\n  the page says what the store actually does');
  {
    /* "No limit" is the honest description of a blank field, and it is the
       state this store has been in the entire time while its emails said
       otherwise. Saying it in warning colour rather than leaving it blank. */
    ok('an unset window is described as no limit', /No limit — every order is returnable for ever/.test(UI));
    ok('…and flagged rather than stated neutrally', /var\(--warning\)/.test(UI.slice(UI.indexOf('loadReturnWindowCard'))));
    ok('a set window says when returns close', /Returns close <b>' \+ d \+ ' days<\/b> after delivery/.test(UI));

    ok('the help text explains counting from delivery', /from delivery/.test(HTML));
    ok('…and that 0 means no limit', /0 means no limit/i.test(HTML));
    ok('…and that an unknown date allows the return',
      /allowed/.test(HTML.slice(HTML.indexOf('ret-window-card'), HTML.indexOf('Return Address Setup'))),
      'the fail-open behaviour is surprising unless it is stated');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
