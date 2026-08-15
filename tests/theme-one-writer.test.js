/* The classes and the colours always come from the same theme.
 *
 * "The header on the first load is still messed up." Then: "the footer
 * completely disappeared."
 *
 * ── WHAT THE PAGE ACTUALLY REPORTED ─────────────────────────────────────────
 *
 *   classes: 'light-mode super-light-mode'      <- the LIGHT theme
 *   --fg-rgb: '244 241 235'                     <- the DARK theme
 *   --ink:    '#09090b'                         <- the DARK theme
 *
 * A body wearing light-mode while holding dark tokens. Every rule written as
 * `body.light-mode .thing { color: #09090b }` then painted near-black text onto
 * a near-black ground: the footer vanished outright, and the header came out
 * white with unreadable links on it.
 *
 * ── WHY IT WAS POSSIBLE ─────────────────────────────────────────────────────
 *
 * theme-engine.js writes its tokens INLINE ON <body>, and an inline declaration
 * beats `body.light-mode { --fg-rgb: … }`. So whoever writes the classes has to
 * write the tokens in the same breath, or the two can disagree.
 *
 * FOUR THINGS WROTE THOSE TWO CLASSES and only one of them wrote tokens:
 *
 *   theme-engine.js       classes AND tokens        (correct)
 *   storefront.js boot    classes only, additive    (could not even correct)
 *   applyBuilderConfig    classes only, async       <- landed last on the homepage
 *   loadSiteSettings      classes only              (admin Appearance)
 *
 * The engine ran, then the builder's saved `theme: 'super-light'` re-added the
 * light classes over the dark tokens a moment later. Two writers, one question,
 * and whichever ran last won half of it.
 *
 * The fix is not a better ordering — orderings drift. It is that storefront.js
 * no longer writes the classes at all. It routes every opinion through
 * ZWTheme.apply(), which is the same call the engine makes for itself, so the
 * tokens and the classes cannot come apart.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const STORE  = fs.readFileSync(path.join(ROOT, 'storefront.js'), 'utf8');
const ENGINE = fs.readFileSync(path.join(ROOT, 'theme-engine.js'), 'utf8');

console.log('\n  the classes and the colours come from one place\n');

console.log('  storefront.js no longer writes the theme classes');
{
  /* Comments in this file discuss `body.light-mode` at length, so the source
     has to be stripped of them before asking whether the CODE still writes the
     classes — a check over raw text would pass on the prose alone. This exact
     trap has caught this session four times. */
  const code = STORE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const writes = code.match(/classList\.(add|remove|toggle)\(\s*'(?:super-)?light-mode'/g) || [];
  ok('no add / remove / toggle of light-mode anywhere in the code',
    writes.length === 0, 'still writing: ' + writes.join(', '));

  ok('…and reading them is still fine', /classList\.contains\('super-light-mode'\)/.test(code),
    'syncThemeColor asks what the theme is; asking is not writing');
}

console.log('\n  every opinion goes through the engine');
{
  const code = STORE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('there is one door', /window\.__zwSetPageTheme = function \(id\)/.test(code));
  ok('…and it calls the engine', /T\.apply\(_pageTheme, false\);/.test(code));
  ok('…without persisting it as the visitor\'s own choice',
    /T\.apply\(_pageTheme, false\)/.test(code),
    'a per-page theme written to zw_theme_mode would follow the shopper to every other page');

  ok('the builder uses it', /_pageTheme = \(cfg\.theme === 'light'/.test(code));
  ok('the admin Appearance setting uses it', /window\.__zwSetPageTheme\(mode\)/.test(code));
}

console.log('\n  a page theme survives the engine\'s late re-apply');
{
  const code = STORE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* The engine applies twice: once from cache, once when its fetch lands. The
     second one would otherwise replace the page's own theme with the store
     default, silently, a second after the page settled. */
  ok('it re-asserts on zw-theme-applied',
    /addEventListener\('zw-theme-applied', applyPageTheme\)/.test(code));
  ok('…and the engine really does announce every apply',
    /dispatchEvent\(new CustomEvent\('zw-theme-applied'/.test(ENGINE));
  ok('…without looping', /T\.current\(\) === _pageTheme\) return;/.test(code),
    'apply dispatches the event that calls back into here — the guard is what ends it');
  ok('blank still means the engine owns the theme',
    /if \(!_pageTheme\) return;/.test(code),
    '"no opinion" must not be spelled the same way as "dark", which is what the old else branch did');
}

console.log('\n  the engine writes tokens where they beat the class rules');
{
  ok('tokens go on <body>', /var el = document\.body \|\| root;/.test(ENGINE),
    'this is WHY a class-only writer is unsafe: inline on body outranks body.light-mode');
  ok('…and the classes are set in the same call',
    /classList\.toggle\('light-mode', theme\.base !== 'dark'\)/.test(ENGINE)
    && /set\('--fg-rgb', t\.fg\);/.test(ENGINE),
    'one function, both halves — which is the property every other writer now borrows');
}

console.log('\n  and the boot block that started this is gone');
{
  const code = STORE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('it no longer reads a theme id to add classes from',
    !/_m === 'super-light'/.test(code) && !/_m === 'light'/.test(code),
    'additive, and comparing against built-in ids so it did nothing once anybody made a theme');
  ok('…and syncThemeColor is kept', /syncThemeColor\(\);/.test(code),
    'the status-bar colour still has to follow the theme');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
