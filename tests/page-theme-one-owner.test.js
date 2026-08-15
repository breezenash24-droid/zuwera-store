/* Who decides what theme the homepage is in.
 *
 * Two writers set body.light-mode / body.super-light-mode:
 *
 *   theme-engine.js:327   from the theme the visitor is actually on
 *   storefront.js         from cfg.theme in the saved builder config
 *
 * And the second one spoke on every call, including when it had nothing to
 * say — no cfg.theme fell into an else that force-REMOVED both classes, which
 * is not "no opinion", it is "dark". So whichever ran last won.
 *
 * In the Page Builder that was every keystroke: the preview posts the whole
 * config on each edit and applyBuilderConfig re-runs. This store had
 * page_builder.theme = "super-light" saved while Appearance said dark, so the
 * builder rendered a light page over and over while the toolbar and the rest of
 * the site said dark. The reported symptom was "it thinks it's still light
 * mode", and it was right.
 *
 * Two things were missing rather than broken:
 *
 *   A way to say "follow the site". The toggle offered Dark / Light / White and
 *   nothing else, so every homepage was pinned to something. The Pages tab has
 *   had "Site theme (Appearance)" for landing pages all along.
 *
 *   An honest label. It was headed "Preview theme", but pvTheme is written to
 *   page_builder, goes out with Publish, and reaches every visitor.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SF = fs.readFileSync(path.join(ROOT, 'storefront.js'), 'utf8');
const BL = fs.readFileSync(path.join(ROOT, 'builder.html'), 'utf8');

/* The real block, lifted and run against a body whose classes we can inspect.
   The whole point is which classes survive, so asserting on the source text
   would miss the case that matters — the one where nothing should happen. */
const START = SF.indexOf('    _pageTheme = (cfg.theme');
const END   = SF.indexOf('// Re-sync the status bar');
if (START < 0 || END < START) { console.log('  ✗ could not find the theme block in storefront.js'); process.exit(1); }
const SRC = SF.slice(START, END);

/* The block no longer touches classes itself — it hands an id to
   ZWTheme.apply(), which is the same call theme-engine.js makes for itself, so
   the tokens travel with the classes. The stand-in below therefore does what
   the real engine does: sets BOTH from the theme's base. That is the property
   under test, and a stand-in that only moved classes would let the bug back. */
function applyTheme(theme, startingClasses) {
  const set = new Set(startingClasses || []);
  const tokens = {};
  const engine = {
    _current: null,
    current: () => engine._current,
    apply: (id) => {
      engine._current = id;
      if (id === 'dark') { set.delete('light-mode'); set.delete('super-light-mode'); }
      else if (id === 'light') { set.add('light-mode'); set.delete('super-light-mode'); }
      else if (id === 'super-light') { set.add('light-mode'); set.add('super-light-mode'); }
      tokens['--fg-rgb'] = id === 'dark' ? '244 241 235' : '10 10 10';
      return true;
    },
  };
  /* The lifted block ASSIGNS to _pageTheme and then calls applyPageTheme(), so
     both have to be declared in the same scope as the code under test. Passing
     them as parameters would not do: assigning to a parameter rebinds a local
     and the helper would never see it. Declaring them in the generated body is
     the honest way to run the real lines unmodified — the alternative was
     rewriting SRC with regexes, which tests the rewrite rather than the code. */
  const run = new Function('cfg', 'engine', `
    let _pageTheme = null;
    function applyPageTheme() {
      if (!_pageTheme) return;
      if (engine.current() === _pageTheme) return;
      engine.apply(_pageTheme, false);
    }
${SRC}
    return _pageTheme;
  `);
  run(theme === undefined ? {} : { theme }, engine);
  return Object.assign(set, { tokens });
}

const LIGHT = ['light-mode'], SUPER = ['light-mode', 'super-light-mode'];

console.log('\n  who owns the homepage theme\n');

console.log('  an explicit choice is still applied');
{
  const l = applyTheme('light', []);
  ok('light adds light-mode only', l.has('light-mode') && !l.has('super-light-mode'));
  const s = applyTheme('super-light', []);
  ok('super-light adds both', s.has('light-mode') && s.has('super-light-mode'));
  const d = applyTheme('dark', SUPER);
  ok('dark clears both', !d.has('light-mode') && !d.has('super-light-mode'),
    'someone who deliberately pins dark must still get dark');
  /* Switching between pins has to actually switch, not accumulate. */
  const back = applyTheme('light', SUPER);
  ok('super-light → light drops the super class', back.has('light-mode') && !back.has('super-light-mode'));
}

console.log('\n  blank means "not mine to answer"');
{
  /* THE FIX. A theme engine that has already put the visitor in super-light
     must not be overruled by a builder config that never expressed a
     preference — which is what the old else branch did, silently, as "dark". */
  const kept = applyTheme('', SUPER);
  ok('an empty theme leaves the engine’s classes alone',
    kept.has('light-mode') && kept.has('super-light-mode'),
    'this is the whole bug: blank used to mean dark and stamped on the real theme');

  const keptLight = applyTheme('', LIGHT);
  ok('…in light too', keptLight.has('light-mode') && !keptLight.has('super-light-mode'));

  const keptDark = applyTheme('', []);
  ok('…and it does not invent classes on a dark page', keptDark.size === 0);

  ok('a missing key behaves the same as blank', applyTheme(undefined, SUPER).size === 2,
    'a config saved before this option existed must not be read as a pin');

  /* Anything unrecognised is also not an instruction. */
  ok('an unknown value is ignored rather than guessed', applyTheme('midnight', SUPER).size === 2);
}

console.log('\n  the builder can say "follow the site"');
{
  ok('the toggle offers it', /data-t="" onclick="setTheme\(''\)"/.test(BL),
    'without this every homepage is pinned to one of three schemes');
  ok('…as the first option', BL.indexOf('data-t=""') < BL.indexOf('data-t="dark"'));
  ok('…and the other three are still there',
    ['dark', 'light', 'super-light'].every((t) => new RegExp('data-t="' + t + '"').test(BL)));

  /* '' is a real saved value and falsy, so presence is what must be tested.
     Reading it with `activeData?.theme` sends it down the fallback and re-pins
     the page on every load — the bug this option exists to remove. */
  ok('loading tests for the key rather than its truthiness',
    /if\(activeData && 'theme' in activeData\)/.test(BL),
    "`activeData?.theme` is falsy for '' and would fall through to a pin");
  ok('…and an absent key defaults to following the site',
    /\} else \{\s*setTheme\(''\);\s*\}/.test(BL));
  ok('the builder starts unpinned', /pvTheme='',/.test(BL),
    'starting at dark meant a failed load still saved a pin on the next Save Draft');
}

console.log('\n  the label tells the truth');
{
  /* It is saved, published, and applied to the live homepage. Calling it a
     preview setting is how a store gets pinned to a scheme nobody remembers
     choosing. */
  ok('it is not called a preview setting', !/more-sec">Preview theme/.test(BL));
  ok('…and says it is saved and published', /Homepage theme[\s\S]{0,120}saved/.test(BL));
  ok('pvTheme really does get published',
    /snapshot=\{sections:clone\(sections\),theme:pvTheme/.test(BL),
    'if this ever stops being true the label should change back');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
