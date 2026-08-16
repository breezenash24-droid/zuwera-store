/* A theme token the engine reads and the panel cannot set.
 *
 * theme-engine.js reads `theme.tokens.<name>` and turns each one into a CSS
 * property or a data attribute. admin-themes.js is the only thing that writes
 * them. Those are two lists that have to agree, and nothing made them:
 *
 *   read, never settable   the feature works and is unreachable. It ships,
 *                          it is documented in the engine, and no store can
 *                          turn it on — which looks from the outside exactly
 *                          like a feature that was never built.
 *   settable, never read   the panel offers a control that changes nothing.
 *                          Worse than the first, because somebody sets it and
 *                          believes it.
 *
 * This file exists because I spent a session about to rebuild the header
 * controls — icons-as-words, per-control ordering and hiding — on the strength
 * of a backlog note. All of it was already there: the CSS, the engine, and a
 * considered admin UI. What was missing was any way to see that from either
 * end, so the note stayed stale and nearly cost a duplicate implementation of
 * a finished feature.
 *
 * THE EXTRACTOR IS THE HARD PART, and getting it wrong here is worse than not
 * having the test. A first pass looked only for `themeSetToken(i,'name',…)`
 * and reported 24 unreachable tokens — every colour, which is set through
 * themeSetColor against a FIELDS list, and iconLabels/labelFont, whose quotes
 * are BACKSLASH-ESCAPED because the call is built inside a JS string. A
 * checker that cries wolf about working code is how the real finding gets
 * waved through, so every writing path is enumerated below and the count of
 * them is asserted.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*$/gm, ' ');
const ENGINE = strip(fs.readFileSync(path.join(ROOT, 'theme-engine.js'), 'utf8'));
const ADMIN = strip(fs.readFileSync(path.join(ROOT, 'admin-themes.js'), 'utf8'));

/** Tokens the engine reads off `t`, which is `theme.tokens`. */
function readByEngine() {
  return new Set([...ENGINE.matchAll(/\bt\.([A-Za-z_]\w*)/g)].map((m) => m[1]));
}

/** Every path by which the admin writes one. Four, and all four are needed. */
function settableInAdmin() {
  const out = new Set();
  const paths = [];

  /* 1. The field table the colour/shape pickers iterate — themeSetColor and
        themeSetHex both write m.tokens[field.key]. */
  const fields = [...ADMIN.matchAll(/key:\s*'([A-Za-z_]\w*)'/g)].map((m) => m[1]);
  fields.forEach((k) => out.add(k));
  paths.push(['field table', fields.length]);

  /* 2. themeSetToken('name', …) written plainly. */
  const plain = [...ADMIN.matchAll(/themeSetToken\([^,]+,\s*'([A-Za-z_]\w*)'/g)].map((m) => m[1]);
  plain.forEach((k) => out.add(k));
  paths.push(['themeSetToken', plain.length]);

  /* 3. …and the same call built INSIDE a JS string, where the quotes arrive
        backslash-escaped. This is how iconLabels and labelFont are written,
        and missing it is what produced the false alarm described above. */
  const escaped = [...ADMIN.matchAll(/themeSetToken\([^,]+,\\'([A-Za-z_]\w*)\\'/g)].map((m) => m[1]);
  escaped.forEach((k) => out.add(k));
  paths.push(['escaped themeSetToken', escaped.length]);

  /* 4. Direct assignment, for the ones with bespoke editors — header, icons. */
  const direct = [...ADMIN.matchAll(/m\.tokens\.([A-Za-z_]\w*)\s*=/g)].map((m) => m[1]);
  direct.forEach((k) => out.add(k));
  /* `delete m.tokens.x` is a write too: clearing a token is how "unset" is
     expressed, and a token only ever deleted is still reachable. */
  const cleared = [...ADMIN.matchAll(/delete m\.tokens\.([A-Za-z_]\w*)/g)].map((m) => m[1]);
  cleared.forEach((k) => out.add(k));
  paths.push(['direct assignment', direct.length + cleared.length]);

  return { out, paths };
}

const READ = readByEngine();
const { out: SET, paths } = settableInAdmin();

console.log('\n  every theme token has a way in and a way out\n');
console.log('  ' + READ.size + ' read by the engine, ' + SET.size + ' settable in the panel');
paths.forEach(([n, c]) => console.log('    via ' + n + ': ' + c));
console.log('');

console.log('  the extractor sees every writing path');
{
  /* If a path silently stops matching, this test starts reporting working
     tokens as unreachable — the failure mode that makes a checker worthless.
     Each path is asserted to find something, so a broken pattern fails as
     itself rather than as a false accusation about the code. */
  /* The UNION, not each path. Asserting every pattern matches something failed
     on the plain themeSetToken form, which is legitimately unused — every call
     in this file is built inside a JS string and arrives escaped. A path that
     finds nothing is only a bug if nothing else covers its tokens. */
  const live = paths.filter(([, c]) => c > 0);
  ok('at least three writing paths are in use', live.length >= 3,
    paths.map(([n, c]) => n + '=' + c).join(', '));
  ok('…and between them they reach most of what the engine reads',
    SET.size >= READ.size - 4, SET.size + ' settable vs ' + READ.size + ' read');
}

console.log('\n  nothing the engine reads is unreachable');
{
  /* Tokens the engine reads that are not tokens at all. `t.icons` and
     `t.header` are objects with their own editors, already counted by direct
     assignment; anything else here would be a genuine hole. */
  const orphans = [...READ].filter((k) => !SET.has(k)).sort();
  ok('every token the engine reads can be set', orphans.length === 0,
    orphans.join(', ') + ' — the feature works and no store can turn it on');
}

console.log('\n  nothing the panel sets is ignored');
{
  /* The worse direction. A control that changes nothing is not a gap, it is a
     lie the panel tells — somebody sets it and believes it. `theme` is the
     record itself rather than a token, so it is excluded by name. */
  /* Settings ROW keys, not theme tokens. They match the field-table pattern
     because `key:` is how both are spelled, and calling them dead controls
     would be an accusation about code that is doing its job. */
  const NOT_A_TOKEN = new Set(['theme', 'theme_modes']);
  const dead = [...SET].filter((k) => !READ.has(k) && !NOT_A_TOKEN.has(k)).sort();
  ok('every token the panel sets is read', dead.length === 0,
    dead.join(', ') + ' — the control exists and does nothing');
}

console.log('\n  the header controls specifically');
{
  /* Named, because these are the four features a backlog note said were
     unbuilt and this file exists to stop that happening again. Each is checked
     at all three layers — the stylesheet that implements it, the engine that
     drives it, the panel that sets it — since any one missing makes it
     invisible from the other two. */
  /* Both places a stylesheet can live. data-zw-account is read only from the
     CSS storefront-features.js injects at runtime, so a scan of the .css files
     alone reported a working feature as having no stylesheet — the same blind
     spot that hid 65 rules from three colour-tokenisation passes. */
  const CSS = fs.readFileSync(path.join(ROOT, 'storefront-cohesion.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(ROOT, 'storefront-features.js'), 'utf8');
  const FEATURES = [
    ['icons as words', /data-zw-iconlabels/, /iconLabels/, /iconLabels/],
    ['label font', /--zw-label-font/, /--zw-label-font/, /labelFont/],
    ['control order', /--zw-ord-/, /--zw-ord-/, /icons/],
    ['control hiding', /data-zw-hide~=/, /data-zw-hide/, /icons/],
    ['account in the header', /data-zw-account/, /accountIn/, /accountIn/],
  ];
  for (const [name, css, eng, adm] of FEATURES) {
    ok(name + ' — stylesheet', css.test(CSS));
    ok('…engine', eng.test(ENGINE));
    ok('…panel', adm.test(ADMIN));
  }

  /* The one deliberate exception, asserted so it stays deliberate: the menu
     cannot be hidden. On a phone the hamburger is the only route into the
     categories, and a theme that hid it would strand every collection page
     behind a control that is no longer there. */
  ok('the menu is not hideable, on purpose',
    /k !== 'menu'/.test(ENGINE),
    'hiding it strands the categories on a phone');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
