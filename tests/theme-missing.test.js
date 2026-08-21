/* Asking for a theme that no longer exists.
 *
 * This is not hypothetical and it is not rare. A theme import once replaced the
 * whole list rather than merging into it, so a store that hit that has no theme
 * called 'dark' any more — while the visitor's stored choice still says 'dark',
 * and the admin's switcher still offers it. Deleting a theme somebody already
 * picked does exactly the same thing.
 *
 * What used to happen next was the worst available answer, and it is worth
 * being precise about why. Two things decide how a page looks:
 *
 *   theme-engine.js  resolves the request — falling back to the store's default
 *                    when the id is unknown — and paints that theme's tokens as
 *                    INLINE STYLE on <body>, plus the matching body class.
 *   applyThemeMode() the older switcher, which set the body class from the
 *                    string it was handed.
 *
 * When the id was unknown the second one ran anyway. So the page wore one
 * theme's colours under another theme's structural rules, and inline styles
 * outrank a class, so neither side simply won. A near-black page whose text
 * colour was computed from a white theme's foreground. Cream panels beside
 * white ones. Nav icons the same colour as the bar they sit on. Every page
 * slightly differently, depending on which token each element happened to read.
 *
 * "Half the page did not get the theme" is far harder to diagnose than "that
 * theme is gone" — the first reads as the CSS being broken everywhere, which is
 * where the hunt then goes. So there is one answerer now: if the engine is on
 * the page, the engine decides, including when it has to fall back.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SRC = fs.readFileSync(path.join(ROOT, 'storefront-theme.js'), 'utf8');
const ENG = fs.readFileSync(path.join(ROOT, 'theme-engine.js'), 'utf8');
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin-themes.js'), 'utf8');

/* The real function, lifted out and run against a body whose class changes we
   can watch. Sliced to its own closing brace. */
/* Matched on the NAME, not the full argument list. This read
   `'function applyThemeMode(mode)'`, so adding a second parameter made indexOf
   return -1, slice(-1, …) lifted one character, and the suite CRASHED with
   "applyThemeMode is not defined" — a lift that found nothing, which is the
   failure this repo keeps re-learning. Guarded as well as loosened: a bad lift
   should say so here rather than throw thirty lines later. */
const fnStart = SRC.indexOf('function applyThemeMode(');
const evAt = SRC.indexOf("dispatchEvent(new CustomEvent('zw-theme-applied'", fnStart);
const fnEnd = evAt < 0 ? -1 : SRC.indexOf('\n  }', evAt) + 4;
if (fnStart < 0 || fnEnd <= fnStart) {
  throw new Error('could not lift applyThemeMode from storefront-theme.js — start='
    + fnStart + ' end=' + fnEnd + '; it has been renamed or reshaped');
}
const FN = SRC.slice(fnStart, fnEnd);

function harness({ engine }) {
  const classes = new Set();
  const stored = {};
  const applied = [];
  const body = {
    classList: {
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
  };
  const win = {
    dispatchEvent: () => {},
    CustomEvent: function (n, d) { return { n, d }; },
  };
  if (engine) {
    win.ZWTheme = {
      /* The engine's real contract: false when the id is not in the list. */
      apply: (id) => { if (!engine.ids.includes(id)) return false; applied.push(id); return true; },
      get: (id) => (engine.ids.includes(id) ? { id } : null),
      current: () => engine.current,
    };
  }
  const doc = {
    body,
    querySelector: () => null,
    documentElement: { style: { setProperty: () => {}, backgroundColor: '' } },
  };
  const fn = new Function('window', 'document', 'localStorage', 'CustomEvent', `
    ${FN}
    return applyThemeMode;`)(win, doc, {
      getItem: (k) => stored[k] || null, setItem: (k, v) => { stored[k] = v; },
    }, win.CustomEvent);
  return { fn, classes, stored, applied, win };
}

console.log('\n  a theme that is not there\n');

console.log('  the engine decides when the engine is present');
{
  /* The store in the screenshots: two imported themes, no built-ins, default
     is a super-light one. The visitor's stored choice is still 'dark'. */
  const h = harness({ engine: { ids: ['imported-a', 'imported-b'], current: 'imported-b' } });
  h.classes.add('light-mode');
  h.classes.add('super-light-mode');   // what the engine painted for its default

  h.fn('dark');

  /* THE BUG. This used to strip both classes — leaving the page structurally
     dark while the engine's inline tokens were still the light theme's. */
  ok('a missing theme does not strip the classes the engine set',
    h.classes.has('light-mode') && h.classes.has('super-light-mode'),
    'body classes from the request, tokens from the default — the half-and-half page');
  ok('…and nothing else was applied either', h.applied.length === 0);

  /* The choice is kept on purpose: restoring the built-ins should bring
     somebody's Dark back exactly as they left it. */
  ok('the request is not overwritten', h.stored['zw_theme_mode'] === undefined,
    'clearing it would quietly lose the choice a restore is meant to honour');
}

console.log('\n  a theme that IS there still works');
{
  const h = harness({ engine: { ids: ['dark', 'light'], current: 'light' } });
  h.fn('dark');
  ok('it goes through the engine', h.applied[0] === 'dark');
  ok('…and the legacy branch does not also run', !h.classes.size,
    'two answerers is what produced the hybrid in the first place');
}

console.log('\n  a page without the engine is unchanged');
{
  /* Not every page loads theme-engine.js, and those must still theme. */
  const d = harness({ engine: null }); d.fn('dark');
  ok('dark clears both classes', !d.classes.has('light-mode') && !d.classes.has('super-light-mode'));
  const l = harness({ engine: null }); l.fn('light');
  ok('light sets light only', l.classes.has('light-mode') && !l.classes.has('super-light-mode'));
  const s = harness({ engine: null }); s.fn('super-light');
  ok('super-light sets both', s.classes.has('light-mode') && s.classes.has('super-light-mode'));
  ok('…and the choice is remembered', s.stored['zw_theme_mode'] === 'super-light');
  /* An unknown name here is coerced, which is right without an engine to ask:
     three classes is all this path can express. */
  const u = harness({ engine: null }); u.fn('imported-b');
  ok('an unknown name falls to light rather than nothing', u.classes.has('light-mode'));
}

console.log('\n  reading the mode back off the body is lossy');
{
  /* Every custom theme collapses to one of three names on the way out, so
     feeding that name back in asks for a theme that may not exist — which is
     how a page could re-enter the broken state on its own. */
  ok('the colour sync asks the engine which theme is applied',
    /* The `, false` is new and deliberate: re-applying what is already on is not
       a choice, and with the flag omitted this line wrote the current theme into
       zw_theme_mode where it outranked the store's default on every later load.
       Matched loosely on the remember flag so that fix does not read as a
       regression in the thing this assertion is actually about. */
    /if \(window\.ZWTheme\) \{ applyThemeMode\(window\.ZWTheme\.current\(\)[^)]*\); return; \}/.test(SRC));
  ok('…and still reads the classes when there is no engine',
    /classList\.contains\('super-light-mode'\) \? 'super-light'/.test(SRC));
}

console.log('\n  the engine really is coherent on its own');
{
  /* The whole fix rests on this: the engine sets the body class from the theme
     it actually applied, so leaving it alone leaves a matched pair. */
  ok('it sets the class from the applied theme’s base',
    /classList\.toggle\('light-mode', theme\.base !== 'dark'\)/.test(ENG) &&
    /classList\.toggle\('super-light-mode', theme\.base === 'super-light'\)/.test(ENG));
  ok('…and refuses an id it does not have', /apply: function \(id, remember\) \{[\s\S]{0,120}?if \(!theme\) return false;/.test(ENG));
  ok('…having already resolved the request to something real',
    /function resolveTheme\(\)[\s\S]{0,200}?byId\(chosenId\(\)\)[\s\S]{0,900}?byId\(config\.default\)[\s\S]{0,900}?config\.modes\[0\]/.test(ENG));
}

console.log('\n  and the way out is visible');
{
  /* Rendering coherently in the wrong theme is better than rendering half a
     theme, but it is still the wrong theme — so the place that can fix it has
     to say so without being hunted for. */
  ok('the admin says when built-ins are missing',
    /absent\.length\s*\?/.test(ADMIN) && /built-in theme/.test(ADMIN) && /missing/.test(ADMIN));
  ok('…names which ones', /absent\.map\(function \(m\) \{ return m\.label; \}\)\.join\(', '\)/.test(ADMIN));
  ok('…says how it happened', /overwritten by a theme import/.test(ADMIN));
  ok('…and restoring leaves everything else alone',
    /state\.modes = state\.modes\.concat/.test(ADMIN) && /missing = DEFAULT_MODES\.filter/.test(ADMIN));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
