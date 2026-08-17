/* The legacy theme row must never become the visitor's choice.
 *
 * site_settings.theme.mode predates the theme engine. It is also what the ADMIN
 * panel's own light/dark chrome toggle used to write, which is how a store ends
 * up with theme.mode = "dark" while theme_modes.default names a super-light
 * theme — switching the admin's chrome was quietly re-theming the shop.
 *
 * ── What was actually happening ──────────────────────────────────────────────
 *
 * Seven files read that row. storefront-theme.js deferred to the engine and
 * passed remember:false. The other six called:
 *
 *     if (window.__zwApplyAdminTheme) window.__zwApplyAdminTheme(mode);
 *
 * One argument. So `remember` defaulted to TRUE and ZWTheme.apply wrote the
 * value into zw_theme_mode — and from then on chosenId() returns it on every
 * page, outranking the store's configured default permanently. One visit to the
 * privacy policy page pinned the entire storefront to the wrong theme, and
 * changing the default in the Themes panel could not take it back.
 *
 * Traced in a real browser against the live site: policies.html painted the
 * store's theme correctly on the first frame, then
 *
 *     +619ms ZWTheme.apply(dark, true)  configured=false   <- loadPolicies
 *
 * and every later load started from that written-down "choice".
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * There is ONE entry point for this row, it defers to the engine, and it never
 * remembers. A page that reads the row asks for it by name.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* Comments out. The assertions below check that a call SHAPE is gone, and the
   comment explaining why it went quotes it verbatim. */
const THEME = strip(read('storefront-theme.js'));

/* Every file that reads the legacy row. */
const READERS = ['about.html', 'drop001.html', 'journal.html', 'policies.html',
                 'sizeguide.html', 'product-main.js', 'storefront.js'];

console.log('\n  the legacy theme row defers, and is never remembered\n');

console.log('  there is exactly one entry point');
{
  ok('__zwApplyLegacyTheme is defined', /window\.__zwApplyLegacyTheme\s*=\s*function/.test(THEME));

  const a = THEME.indexOf('window.__zwApplyLegacyTheme');
  const b = THEME.indexOf('\n  };', a);
  /* Both landmarks proved present before anything is measured between them —
     indexOf returns -1 when absent and -1 slices from the END of the string,
     which is how a suite ends up asserting against one stray character. */
  ok('…and could be bounded', a >= 0 && b > a, 'a=' + a + ' b=' + b);
  const FN = a >= 0 && b > a ? THEME.slice(a, b) : '';

  ok('it stands down when the engine has the store’s themes',
    /ZWTheme\.configured\(\)\)\s*return/.test(FN),
    'this row is the fallback for when the engine knows nothing, not an override');
  ok('it applies for this page view only',
    /applyThemeMode\(mode,\s*false\)/.test(FN),
    'remember:true is what turned a stale admin setting into the visitor’s permanent choice');
  ok('…and the deference comes BEFORE the apply',
    FN.indexOf('configured()') >= 0 && FN.indexOf('applyThemeMode(mode, false)') >= 0
      && FN.indexOf('configured()') < FN.indexOf('applyThemeMode(mode, false)'));
  ok('an empty mode is a no-op', /if\s*\(!mode\)\s*return/.test(FN));
}

console.log('\n  every reader goes through it');
{
  for (const f of READERS) {
    const src = strip(read(f));
    ok(f + ' asks for the legacy entry point', /__zwApplyLegacyTheme\(mode\)/.test(src));
    /* The exact shape that omitted `remember`. A page may still call
       __zwApplyAdminTheme for a PERSON picking a theme — that is what it is
       for — but not for this row. */
    ok('…and no longer calls __zwApplyAdminTheme(mode) for the row',
      !/__zwApplyAdminTheme\(mode\)/.test(src),
      'one argument means remember defaults to true');
  }
}

console.log('\n  the guard is not duplicated back into the callers');
{
  /* If a caller grows its own copy of the configured() check, there are two
     answers again and they will drift — which is the whole shape of this bug. */
  const dupes = READERS.filter((f) => /ZWTheme\.configured\(\)/.test(strip(read(f))));
  ok('no reader carries its own copy of the deference', dupes.length === 0, dupes.join(', '));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
