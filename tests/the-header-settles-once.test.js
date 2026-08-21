/* The account header arrived in three instalments.
   ═══════════════════════════════════════════════════════════════════════════

   Reported as: clicking the account button goes to the account page, but the
   header "shows search before it shows sign out". Two separate late arrivals,
   landing one after the other:

       first paint   [ACCOUNT] [BAG]
       + magnifier   [SEARCH] [ACCOUNT] [BAG]        header pre-paint, or the
                                                     module on a cold cache
       + sign out    [SIGN OUT] [SEARCH] [ACCOUNT] [BAG]

   Sign Out is a <button> in account.html's nav carrying an inline
   display:none, revealed only once the async getSession() resolved. It sits
   BEFORE the action group, so appearing pushed the whole group sideways — after
   the magnifier had already settled. Hence "search, then sign out".

   ── WHY THE PAGE ALREADY KNEW ───────────────────────────────────────────────

   account.html has had an auth pre-paint since before this: it decodes the
   Supabase session out of localStorage in <head> and reveals #acct-content or
   #auth-wall before first paint. It simply did not cover the nav button. One
   declaration added to the style element it already writes. !important because
   an inline style cannot be beaten any other way.

   ── AND THE HALF THAT WAS MISSING ───────────────────────────────────────────

   theme-preboot.head.js adds `zw-authed` from the same read, and auth.js owns
   taking it back when the server disagrees — but AUTH.JS IS NOT LOADED ON
   account.html. So a token the server rejects left the header showing somebody's
   name and a Sign Out button over an auth wall, with nothing on the page able to
   correct it. The no-session branch now drops both, which is the rule auth.js
   states in its own words: a guess this file never corrects is worse than no
   guess.

   ── THE MAGNIFIER, ON A FIRST-EVER VISIT ────────────────────────────────────

   The header pre-paint draws it from zw_srch — what storefront-features.js
   wrote LAST visit. A first-ever visitor has nothing, so it pops in. The edge
   reads feature_flags and stamps data-zw-search only when the answer is the
   same for everybody:

       enabled: false                 -> '0'
       enabled: true, rollout >= 100  -> '1'    (the live store: rollout 100)
       enabled: true, rollout 1..99   -> not stamped

   A partial rollout depends on a sticky per-visitor bucket flags.js keeps in
   the browser and the edge cannot see. Guessing there would show the magnifier
   to somebody the rollout excludes and then take it away, which is worse than
   the flicker being fixed. */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const ACC = read('account.html');
const HDR = read('scripts/header-preboot.head.js');
const MW = read('functions/_middleware.js');

(async () => {
  const { searchAttr } = await import('../functions/_middleware.js');

  console.log('\n  the header settles once\n');

  console.log('  sign out is decided before the first frame');
  {
    ok('the auth pre-paint covers the nav button',
      /#nav-signout-btn\{display:inline-block!important\}/.test(ACC),
      'it was revealed only after getSession() resolved, which is why it arrived last');
    ok('…in the same style element the page already wrote',
      /st\.textContent=_ok\?'#acct-content\{display:block!important\}#nav-signout-btn/.test(ACC),
      'a second mechanism is a second thing to keep in step');
    ok('…and only on the signed-in branch',
      /:'#auth-wall\{display:block!important\}'/.test(ACC),
      'a signed-out visitor must not be shown a Sign Out button');
    /* The markup keeps its inline display:none so the button is hidden with no
       JavaScript at all when the guess says signed out. */
    ok('the button still ships hidden',
      /id="nav-signout-btn"[^>]*style="display:none"/.test(ACC),
      'without it a signed-out first frame shows Sign Out');
    ok('…which is why the rule needs !important',
      /!important because\n     an inline style cannot be beaten any other way/.test(ACC));
  }

  console.log('\n  and the guess is taken back when the server disagrees');
  {
    ok('the no-session branch drops zw-authed',
      /document\.documentElement\.classList\.remove\('zw-authed'\);/.test(ACC),
      'auth.js owns this everywhere else and is not loaded on this page');
    ok('…and the name with it',
      /document\.documentElement\.style\.removeProperty\('--zw-acct-name'\);/.test(ACC),
      'the header went on showing somebody\'s first name over an auth wall');
    ok('…beside the existing pre-paint undo, not instead of it',
      ACC.indexOf("getElementById('zw-acct-prepaint')?.remove()")
        < ACC.indexOf("classList.remove('zw-authed')"));
    /* If auth.js is ever added to this page, both would run and agree — but the
       reason this is here at all is that it is not. */
    ok('auth.js really is absent from this page', !/src="[^"]*auth\.js/.test(ACC),
      'if that changes, this branch becomes belt-and-braces rather than the only correction');
  }

  console.log('\n  the magnifier stops waiting for last visit');
  {
    ok('the header pre-paint prefers the stamped answer',
      /var _sa = document\.documentElement\.getAttribute\('data-zw-search'\);/.test(HDR));
    /* Null-checked, not truthiness: '0' is an ANSWER — "this store has search
       switched off" — and a truthiness test would fall through to the cache and
       draw a magnifier the store does not want. */
    ok('…distinguishing "off" from "not stamped"',
      /if \(_sa !== null \? _sa !== '1' : localStorage\.getItem\('zw_srch'\) !== '1'\) return;/.test(HDR),
      "'0' is an answer; a truthiness test would read it as absent and use the cache");
    ok('…and still falls back to the cache when nothing is stamped',
      /localStorage\.getItem\('zw_srch'\) !== '1'/.test(HDR));
  }

  console.log('\n  the edge only answers when the answer is the same for everybody');
  {
    ok('a full rollout is on', searchAttr({ feature_search: { enabled: true, rollout: 100 } }) === '1');
    ok('…as is one with no rollout named at all',
      searchAttr({ feature_search: { enabled: true } }) === '1',
      'a flag row that predates rollouts means everybody');
    ok('disabled is off', searchAttr({ feature_search: { enabled: false, rollout: 100 } }) === '0');
    ok('…and a zero rollout is off too', searchAttr({ feature_search: { enabled: true, rollout: 0 } }) === '0');
    /* THE ONE THAT MATTERS. Who is in a partial rollout depends on a sticky
       bucket in the browser. Stamping either way shows the magnifier to the
       wrong half and then takes it back. */
    ok('a partial rollout is left to the browser',
      searchAttr({ feature_search: { enabled: true, rollout: 50 } }) === ''
      && searchAttr({ feature_search: { enabled: true, rollout: 1 } }) === ''
      && searchAttr({ feature_search: { enabled: true, rollout: 99 } }) === '',
      'the edge cannot see the sticky bucket flags.js keeps');
    ok('a bare boolean still works', searchAttr({ feature_search: true }) === '1'
      && searchAttr({ feature_search: false }) === '0');
    ok('a nested flags object is read too',
      searchAttr({ flags: { feature_search: { enabled: true, rollout: 100 } } }) === '1');
    ok('nothing configured says nothing',
      searchAttr(null) === '' && searchAttr({}) === '' && searchAttr({ feature_search: null }) === ''
      && searchAttr({ feature_search: { rollout: 100 } }) === '',
      'enabled must be true, not merely not-false');
    ok('rubbish says nothing', searchAttr('x') === '' && searchAttr({ feature_search: 'yes' }) === ''
      && searchAttr({ feature_search: { enabled: true, rollout: 'lots' } }) === '');
  }

  console.log('\n  and it is wired without widening what gets stamped');
  {
    ok('feature_flags is fetched', /FIRST_PAINT_KEYS\.concat\(\['feature_flags'\]\)/.test(MW));
    ok('…but not stamped into the settings block',
      !/'feature_flags',/.test((MW.match(/const FIRST_PAINT_KEYS = \[[\s\S]*?\];/) || [''])[0]),
      '2,970 bytes on every HTML response for one derived attribute');
    ok('the attribute is written to <html>',
      /if \(attrs\.search\) rw = rw\.on\('html', new Stamp\(\{ 'data-zw-search': attrs\.search \}\)\);/.test(MW));
    ok('…and skipped when there is nothing certain to say',
      /if \(attrs\.search\)/.test(MW) && /!attrs\.search\) return res;/.test(MW));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
