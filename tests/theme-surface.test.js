/* The one colour in the palette that never moved.
 *
 * `surface` — "panels and strips that sit just off the page colour" — shipped as
 * #F0EEE9 in all four built-in themes. The CSS variable behind it was called
 * --surface-light, and that name is the whole story: it predates themes, from
 * when there was one palette and "the light surface" was a fine name for a
 * constant. When the theme editor started writing a `surface` token into it,
 * the name stopped describing a constant and started describing a bug.
 *
 * It was wrong in every theme, in opposite directions:
 *
 *   Light         #F0EEE9 IS the page colour. Choosing "surface" did nothing.
 *   Super Light   #F0EEE9 on #FFFFFF — faintly right, by accident.
 *   Dark          a cream slab on the black page, carrying the dark theme's
 *                 cream text onto itself. Cream on cream, and a bright block
 *                 where a panel should have been.
 *
 * The safety net could not catch it either. storefront.js darkens the text of a
 * section whose background is light, but it measures the STORED value, and the
 * stored value is the string 'token:surface' — no colour to measure, so it
 * answers false and does nothing. It could not have answered anything else: a
 * token is a var() until the browser resolves it, long after that code has run.
 * Tokens have to be paired by name, not by measurement.
 *
 * And fixing the four definitions is not enough on its own. The theme editor
 * writes all seven fields on every save, so any store that has opened one has
 * the old value in its settings row, where it beats the built-in.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const R = ROOT + '/';
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const base = fs.readFileSync(R + 'base.css', 'utf8');
const eng  = fs.readFileSync(R + 'theme-engine.js', 'utf8');
const sf   = fs.readFileSync(R + 'storefront.js', 'utf8');
const ls   = fs.readFileSync(R + 'landing-sections.js', 'utf8');

/* Perceived luminance, the same weighting storefront.js uses. */
function lum(hex) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c) : h.match(/../g);
  const [r, g, b] = n.map((x) => parseInt(x, 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/* Pull the four built-in tables out of the three files that hold one. */
function tablesFrom(src, startMark) {
  const chunk = src.slice(src.indexOf(startMark));
  const out = {};
  for (const m of chunk.matchAll(/id:\s*'([a-z-]+)'[\s\S]{0,400}?tokens:\s*\{([^}]*)\}/g)) {
    const t = {};
    for (const kv of m[2].matchAll(/(\w+):\s*'([^']*)'/g)) t[kv[1]] = kv[2];
    if (!out[m[1]]) out[m[1]] = t;
  }
  return out;
}
const ENGINE  = tablesFrom(eng, 'var BUILTINS = [');
const ADMIN   = tablesFrom(fs.readFileSync(R + 'admin-themes.js', 'utf8'), 'var DEFAULT_MODES');
const BUILDER = tablesFrom(fs.readFileSync(R + 'builder.html', 'utf8'), 'const THEME_BUILTINS=');

console.log('\n  the theme surface\n');

console.log('  a surface sits just off its own page, in every theme');
{
  for (const id of ['dark', 'light', 'super-light', 'two-tone']) {
    const t = ENGINE[id];
    ok(id + ' has a surface', !!(t && t.surface), JSON.stringify(t));
    if (!t || !t.surface) continue;

    /* bg is a bare triplet; surface is hex. Compare them as luminance. */
    const [r, g, b] = t.bg.split(/\s+/).map(Number);
    const pageLum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const sLum = lum(t.surface);

    /* THE BUG. A cream surface on a black page is not a panel, it is a hole. */
    ok('…on the same side of the line as its page', Math.abs(sLum - pageLum) < 0.35,
      id + ': page ' + pageLum.toFixed(2) + ' vs surface ' + sLum.toFixed(2)
      + ' — a surface that inverts the page takes the page’s text with it');

    /* …and it still has to be visible AS a panel. */
    ok('…and far enough off it to read as one', Math.abs(sLum - pageLum) > 0.01,
      id + ': surface is the page colour exactly, so choosing it does nothing');
  }
}

console.log('\n  the name no longer says one theme’s answer');
{
  ok('the variable is named for the job', /--zw-theme-surface:/.test(base));
  ok('…and the old name is gone from the code', !/var\(--surface-light\)/.test(base + eng + sf));
  ok('the engine writes the theme’s value into it', /set\('--zw-theme-surface', t\.surface\)/.test(eng));
  ok('sections resolve through it', /surface:\s*'var\(--zw-theme-surface\)'/.test(sf));
}

console.log('\n  it moves with the mode, like every other colour');
{
  /* base.css is what renders before any theme is applied, and what renders for
     a store with no custom theme at all. It has to carry the same three
     answers the built-ins do. */
  const rootBlock  = base.slice(0, base.indexOf('body.light-mode'));
  const lightBlock = base.slice(base.indexOf('body.light-mode'), base.indexOf('body.super-light-mode'));
  const superBlock = base.slice(base.indexOf('body.super-light-mode'));

  const pick = (b) => (b.match(/--zw-theme-surface:\s*(#[0-9A-Fa-f]{6})/) || [])[1];
  const d = pick(rootBlock), l = pick(lightBlock), s = pick(superBlock);

  ok('dark defines one', !!d, String(d));
  ok('light overrides it', !!l, String(l));
  ok('super light overrides it again', !!s, String(s));
  ok('…and the three are not the same colour', new Set([d, l, s]).size === 3, [d, l, s].join(' '));
  ok('the dark one is dark', d && lum(d) < 0.3, d + ' → ' + (d && lum(d).toFixed(2)));
  ok('the light ones are light', l && s && lum(l) > 0.7 && lum(s) > 0.7);
  /* Super light's page is already white, so its surface has to go the other
     way or there is nothing to see. */
  ok('super light’s surface is not white', s && s.toUpperCase() !== '#FFFFFF', s);
}

console.log('\n  the three copies of the table agree');
{
  /* The engine renders it, Appearance → Themes edits it, and the builder
     previews it. Three tables, and a colour that differs between them shows as
     a preview that does not match the site. */
  for (const id of ['dark', 'light', 'super-light', 'two-tone']) {
    ok(id + ' matches across engine, admin and builder',
      ENGINE[id] && ADMIN[id] && BUILDER[id] &&
      ENGINE[id].surface === ADMIN[id].surface && ENGINE[id].surface === BUILDER[id].surface,
      [ENGINE[id] && ENGINE[id].surface, ADMIN[id] && ADMIN[id].surface, BUILDER[id] && BUILDER[id].surface].join(' / '));
  }
}

console.log('\n  a store that already saved the broken value');
{
  /* Run the real merge. Fixing the built-in cannot help a store whose settings
     row carries the old colour — and every store that has opened the theme
     editor has one, because it writes all seven fields on save. */
  const src = eng.slice(eng.indexOf('var BUILTINS = ['), eng.indexOf('// ── Normalising'));
  const merge = eng.slice(eng.indexOf('function mergeTokens'), eng.indexOf('  // ── Normalising'));
  const M = new Function(src + merge + ';return { BUILTINS: BUILTINS, mergeTokens: mergeTokens };')();
  const dark = M.BUILTINS.find((b) => b.id === 'dark');

  const stale = M.mergeTokens(dark, { fg: '244 241 235', bg: '9 9 11', surface: '#F0EEE9' });
  ok('the old default is read as never-chosen', stale.surface === dark.tokens.surface, stale.surface);
  ok('…case-insensitively, because the editor writes it lowercase',
    M.mergeTokens(dark, { surface: '#f0eee9' }).surface === dark.tokens.surface);

  /* Everything else the store set is still theirs. */
  const custom = M.mergeTokens(dark, { surface: '#223344', accent: '#00FF00' });
  ok('a surface they actually picked survives', custom.surface === '#223344');
  ok('…and so does everything else in the row', custom.accent === '#00FF00');
  ok('unset fields still fall back to the built-in', custom.paper === dark.tokens.paper);

  /* A custom theme has no built-in to compare against, so there is no old
     default to recognise and nothing may be second-guessed. */
  ok('a custom theme is never rewritten',
    M.mergeTokens(null, { surface: '#F0EEE9' }).surface === '#F0EEE9',
    'without a built-in there is no default to call it, so it is a choice');
}

console.log('\n  a token background brings its own text');
{
  /* ink and paper are an inverted pair — the builder's cta and banner set both
     together for exactly this reason. Set one as a background alone and the
     section paints itself the colour of its own text. */
  const map = (sf.match(/const SECTION_FG_FOR_BG = \{([^}]*)\}/) || [, ''])[1];
  ok('ink pairs with paper', /ink:\s*'var\(--paper\)'/.test(map));
  ok('paper pairs with ink', /paper:\s*'var\(--ink\)'/.test(map));

  /* Run the picker. Tokens that track the page are deliberately absent — the
     page's own text reads on them, and forcing a colour would override a
     legitimate inherit. */
  /* The map and the picker, lifted from the file and run. Sliced to the
     function's own closing brace — cutting at the next mention of a name lands
     mid-body and the Function then declares nothing. */
  const fgStart = sf.indexOf('const SECTION_FG_FOR_BG');
  const fnStart = sf.indexOf('function sectionFgForToken');
  const fnEnd = sf.indexOf('\n  }', sf.indexOf("return '';", fnStart)) + 4;
  const chunk = sf.slice(fgStart, sf.indexOf('\n', fgStart)) + '\n' + sf.slice(fnStart, fnEnd);
  const mk = (accent) => new Function('getComputedStyle', '_zwIsLightColor', `
    ${chunk}
    return sectionFgForToken;`)(
      () => ({ getPropertyValue: () => accent }),
      (c) => { const h = c.replace('#', ''); const [r, g, b] = h.match(/../g).map((x) => parseInt(x, 16));
               return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6; });

  const pick = mk('#F891A5');
  ok('surface is left to inherit', pick(null, 'surface') === '');
  ok('page is left to inherit', pick(null, 'page') === '');
  ok('tint is left to inherit', pick(null, 'tint') === '');

  /* THE ONE THAT ONLY A MEASUREMENT CAN ANSWER. The shipped pink is light, so
     the text on it must be dark — in the dark theme too, where the page's own
     cream text would be barely a contrast at all. */
  ok('the shipped pink accent takes dark text', pick({}, 'accent') === '#09090b');
  ok('…and a dark custom accent takes light text', mk('#101820')({}, 'accent') === '#f4f1eb');
  ok('…measured, not assumed from the theme', /getPropertyValue\('--accent'\)/.test(sf));
  ok('an unreadable accent falls back to inheriting', mk('')({}, 'accent') === '');
}

console.log('\n  landing pages share the decision');
{
  /* A landing section set to token:paper is the same invisible band as a
     homepage one. A second copy of the pairing is a second place to be wrong. */
  ok('the pairing is exported', /window\.zwSectionFgForBg = sectionFgForToken;/.test(sf));
  ok('…and landing pages use it rather than their own', /window\.zwSectionFgForBg\(el, String\(s\.sec_bg\)\.slice\(6\)\)/.test(ls));
  ok('…still preferring a chosen Text Color', /zwResolveSectionBg \|\| String\)\(s\.text_color\)\s*\n?\s*\|\|/.test(ls));
  ok('…and not defining a second table', !/SECTION_FG_FOR_BG/.test(ls));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
