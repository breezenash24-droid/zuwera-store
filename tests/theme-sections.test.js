/* A section is declared in four places. They have to agree.
 *
 * To exist, a section needs an entry in TYPES (so the picker offers it),
 * defaults in SECT_DEFS (so it renders with something), a case in buildForm
 * (so it can be configured) and a renderer on the storefront (so it appears).
 * Four edits, four chances to forget one — and each omission fails in its own
 * quiet way:
 *
 *   in TYPES, no defaults    the picker offers it and it lands blank
 *   defaults, not in TYPES   dead code nobody can add
 *   in TYPES, no form        it can be added and never configured
 *   in TYPES, no renderer    it saves, and the page shows nothing
 *
 * None of those throws. A merchant just finds a section that does not work.
 *
 * They agree today — this was audited before the file was written and all four
 * lists held 28. That is the reason to write it down now, while it is true:
 * this is a theme meant to be extended by people who did not build it, and
 * "remember to edit four places" is not something you can ship to a licensee.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..') + '/';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

const B = fs.readFileSync(ROOT + 'builder.html', 'utf8');
const slice = (start, end) => {
  const a = B.indexOf(start); if (a === -1) return '';
  const b = B.indexOf(end, a); return B.slice(a, b === -1 ? undefined : b);
};

const TYPES_SRC = slice('const TYPES={', '\nconst SECT_DEFS');
const DEFS_SRC = slice('const SECT_DEFS={', '\nconst DEFAULT_SECTIONS');

const types = [...TYPES_SRC.matchAll(/^\s{2}([a-z_]+):\{icon:/gm)].map((m) => m[1]);
const defs = [...DEFS_SRC.matchAll(/^\s{2}([a-z_]+):\{/gm)].map((m) => m[1]);
const forms = new Set([...B.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]));

const rendered = new Set();
for (const f of ['storefront.js', 'landing-sections.js']) {
  let s; try { s = fs.readFileSync(ROOT + f, 'utf8'); } catch (_) { continue; }
  for (const m of s.matchAll(/case\s*'([a-z_]+)'/g)) rendered.add(m[1]);
  for (const m of s.matchAll(/type\s*===\s*'([a-z_]+)'/g)) rendered.add(m[1]);
}

console.log('\n  every section exists in all four places');

ok('the picker has sections to offer', types.length > 0, String(types.length));
ok('…and no duplicates in it', new Set(types).size === types.length);

const missingDefaults = types.filter((t) => !defs.includes(t));
ok('every section the picker offers has defaults', missingDefaults.length === 0,
  missingDefaults.join(', ') + ' — would be added and render blank');

const orphanDefaults = defs.filter((d) => !types.includes(d));
ok('…and no defaults belong to a section nobody can add', orphanDefaults.length === 0,
  orphanDefaults.join(', ') + ' — dead code');

const missingForms = types.filter((t) => !forms.has(t));
ok('every section can be configured', missingForms.length === 0,
  missingForms.join(', ') + ' — addable but has no editor form');

const missingRender = types.filter((t) => !rendered.has(t));
ok('every section actually renders on the storefront', missingRender.length === 0,
  missingRender.join(', ') + ' — saves fine, shows nothing');

console.log('\n  the picker can describe what it is offering');
{
  /* A section with no description is one a merchant has to add to find out what
     it does. Cheap to require, and it is the difference between a theme that
     explains itself and one that needs a manual. */
  const entries = [...TYPES_SRC.matchAll(/^\s{2}([a-z_]+):\{icon:'([^']*)',cat:'([^']*)',desc:'((?:[^'\\]|\\.)*)'/gm)];
  ok('every section is fully described', entries.length === types.length,
    entries.length + ' of ' + types.length + ' have icon, category and description');

  const thin = entries.filter((m) => m[4].length < 12).map((m) => m[1]);
  ok('…in more than a couple of words', thin.length === 0, thin.join(', '));

  /* Categories group the picker. A typo makes a section vanish into a group
     nobody looks in, which reads as "the section is missing". */
  const CATS = ['store', 'marketing', 'layout'];
  const strayCat = entries.filter((m) => !CATS.includes(m[3])).map((m) => m[1] + ':' + m[3]);
  ok('…and filed under a category the picker shows', strayCat.length === 0, strayCat.join(', '));
}

console.log('\n  a new store starts with sections that exist');
{
  /* DEFAULT_SECTIONS is what every fresh install renders. A type renamed
     without updating it means the first thing a licensee sees is an empty
     page — the worst possible first impression, and silent. */
  const line = B.slice(B.indexOf('const DEFAULT_SECTIONS='));
  const listed = [...line.slice(0, line.indexOf(']')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  ok('the starting layout names real sections',
    listed.length > 0 && listed.every((t) => types.includes(t)),
    listed.filter((t) => !types.includes(t)).join(', '));
}

console.log('\n  the universal section controls really are universal');
{
  /* Padding is offered on every section by the shared Section Style block. One
     that has no pad_top/pad_bot in its defaults silently ignores it, so the
     control is there and does nothing — worse than absent, because the merchant
     concludes the builder is broken rather than that this section is different.
     `spacer` is exempt: it IS space, its height is the whole setting. */
    const EXEMPT = ['spacer'];
  const noPad = defs.filter((d) => {
    if (EXEMPT.includes(d)) return false;
    const m = DEFS_SRC.match(new RegExp('^\\s{2}' + d + ':\\{([\\s\\S]*?)\\},?$', 'm'));
    return m ? !/pad_top/.test(m[1]) : false;
  });
  ok('every section honours the shared padding control', noPad.length === 0,
    noPad.join(', ') + ' — the control shows but does nothing');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
