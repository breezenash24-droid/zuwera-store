/* Nothing may write down a theme choice on the visitor's behalf.
 *
 * zw_theme_mode means "this person picked this". It is read FIRST — by the
 * pre-paint block in <head> and by theme-engine.js's chosenId() — so once a
 * value is in it, it outranks the store's configured default on every page,
 * forever. The Themes panel then appears to do nothing.
 *
 * ZWTheme.apply(id, remember) writes it whenever `remember` is not false, and
 * applyThemeMode(mode, remember) defaults `remember` to TRUE, because most of
 * its callers ARE a person picking a theme. That default is right for the theme
 * switcher and wrong for everything that merely re-derives the current state,
 * and the difference is one omitted argument.
 *
 * Found by rendering the live site and reading the choice back:
 *
 *     ZWTheme.apply('dark', true)  configured=false   <- the legacy settings row
 *
 * ── The three that were inventing one ───────────────────────────────────────
 *
 *   · the legacy site_settings.theme row, on six of the seven pages that read
 *     it (covered by legacy-theme-row-defers.test.js)
 *   · __zwSyncThemeColor, whose entire job is to re-apply what is already on
 *   · the pageshow/bfcache handler — and note its read ends in
 *     `|| 'super-light'`, so pressing Back recorded a pick for somebody who had
 *     never made one
 *
 * ── And the class toggle that outlived the answer ───────────────────────────
 *
 * The pre-paint block registered its body-class toggle with { once: false }.
 * readystatechange fires at 'interactive' AND at 'complete', and deferred
 * scripts run before either — so theme-engine.js had already applied a theme
 * and set its tokens inline on <body> when this ran again and put a stale class
 * back. The class pins the bar to a literal through an !important rule while
 * --fg-rgb still belongs to the other theme: white bar, near-white links.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const THEME = strip(read('storefront-theme.js'));
const PREBOOT = strip(read('scripts/theme-preboot.head.js'));

/* Every call to `name(...)`, with its argument list read by counting brackets.
   A plain /name\([^)]*\)/ stops at the first ')' — which for
   `applyThemeMode(window.ZWTheme.current(), false)` is the one closing
   current(), so the call reads as single-argument and the check fires on
   correct code. Nested parentheses are the normal case here, not the edge. */
function callsTo(src, name) {
  const out = [];
  let i = 0;
  for (;;) {
    i = src.indexOf(name + '(', i);
    if (i < 0) break;
    let d = 0, j = i + name.length;
    for (; j < src.length; j++) {
      if (src[j] === '(') d++;
      else if (src[j] === ')') { d--; if (!d) break; }
    }
    out.push(src.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

/* Top-level commas only — the separator between arguments, not one inside a
   nested call. */
function argCount(call) {
  const inner = call.slice(call.indexOf('(') + 1, call.length - 1).trim();
  if (!inner) return 0;
  let d = 0, n = 1;
  for (const ch of inner) {
    if (ch === '(' || ch === '[') d++;
    else if (ch === ')' || ch === ']') d--;
    else if (ch === ',' && d === 0) n++;
  }
  return n;
}

console.log('\n  nothing invents a theme choice\n');

console.log('  storefront-theme.js: only a real pick is remembered');
{
  /* applyThemeMode's default must STAY true — the switcher and the size guide
     are choices and have to persist. What is asserted is that no call inside
     this file relies on the default. */
  ok('the default is still "remember" for a real choice',
    /remember === undefined\) \? !window\.__ZW_BUILDER_PREVIEW__/.test(THEME),
    'the theme switcher must keep persisting');

  /* The declaration itself is `applyThemeMode(mode, remember)`; skip it. */
  const calls = callsTo(THEME, 'applyThemeMode')
    .filter((c) => c !== 'applyThemeMode(mode, remember)');
  const oneArg = calls.filter((c) => argCount(c) < 2);
  ok('no call in this file omits the remember flag', oneArg.length === 0,
    'omitting it defaults to true: ' + oneArg.join('  '));
  ok('…and there were calls to check', calls.length >= 3, 'found ' + calls.length);
}

console.log('\n  re-deriving the current theme is not a choice');
{
  const a = THEME.indexOf('window.__zwSyncThemeColor');
  const b = THEME.indexOf('\n  };', a);
  ok('__zwSyncThemeColor was bounded', a >= 0 && b > a);
  const FN = a >= 0 && b > a ? THEME.slice(a, b) : '';
  const inner = callsTo(FN, 'applyThemeMode');
  ok('it re-applies without remembering',
    inner.length === 2 && inner.every((c) => /,\s*false\)$/.test(c)),
    'both the engine path and the class-read fallback: ' + inner.join('  '));
}

console.log('\n  a back button is not a choice');
{
  const a = THEME.indexOf("addEventListener('pageshow'");
  const b = a >= 0 ? THEME.indexOf('\n  });', a) : -1;
  ok('the pageshow handler was bounded', a >= 0 && b > a);
  const FN = a >= 0 && b > a ? THEME.slice(a, b) : '';
  ok('restoring from bfcache does not persist',
    /applyThemeMode\(mode,\s*false\)/.test(FN),
    "its read ends in `|| 'super-light'`, so Back invented a pick for anyone who had none");
}

console.log('\n  the pre-paint class toggle runs once');
{
  ok('the listener is no longer { once: false }',
    !/once:\s*false/.test(PREBOOT),
    'readystatechange fires at interactive AND complete');
  ok('…and detaches itself on the first successful run',
    /removeEventListener\('readystatechange', go\)/.test(PREBOOT));
  ok('…and stands down once the engine has applied a theme',
    /hasAttribute\('data-zw-theme'\)/.test(PREBOOT),
    'a stale class on a body whose tokens have moved on is the white-bar bug');

  /* theme-engine.js has to actually set the marker being read, or the guard
     above is a check against something that never appears. */
  const ENGINE = strip(read('theme-engine.js'));
  ok('theme-engine.js sets that marker',
    /setAttribute\('data-zw-theme',\s*theme\.id\)/.test(ENGINE));
  /* …and sets it in the same function that toggles the classes, so the marker
     cannot appear before the classes it is standing in for. */
  const ap = ENGINE.indexOf('function apply(theme)');
  const cls = ENGINE.indexOf("classList.toggle('light-mode'", ap);
  const mark = ENGINE.indexOf("setAttribute('data-zw-theme'", ap);
  ok('…in the same apply() that toggles the classes',
    ap >= 0 && cls > ap && mark > ap, 'apply=' + ap + ' toggle=' + cls + ' marker=' + mark);
}

console.log('\n  every page carries the same pre-paint block');
{
  const PAGES = fs.readdirSync(ROOT).filter((f) => /\.html$/.test(f))
    .filter((f) => read(f).indexOf('zw:preboot') >= 0);
  ok('pages with the block were found', PAGES.length >= 14, String(PAGES.length));
  const stale = PAGES.filter((f) => /once:\s*false/.test(read(f)));
  ok('none still registers a repeating listener', stale.length === 0, stale.join(', '));
  const missing = PAGES.filter((f) => read(f).indexOf("hasAttribute('data-zw-theme')") < 0);
  ok('all of them stand down for the engine', missing.length === 0, missing.join(', '));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
