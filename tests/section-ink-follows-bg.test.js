/* Read the background. Do not predict it.
 *
 * Three separate attempts to work out what colour a section would END UP being,
 * from the value stored for it:
 *
 *   a token          → paired by name
 *   a legacy literal → recognised as standing for a token
 *   anything else    → luminance on the literal
 *
 * Each rule was right about the case it was written for and wrong about one it
 * was not, and when two of them disagreed about the same field the products
 * strip rendered dark ink on a dark band — the names were on the page in the
 * colour of what was behind them.
 *
 * The browser already knows the answer. Once the background is applied,
 * getComputedStyle resolves every var(), token and literal to one rgb() string.
 * Measuring that is not a better guess, it is the end of guessing — and it goes
 * on working for backgrounds nobody has thought of yet.
 *
 * Two things it has to be honest about:
 *
 *   TRANSPARENCY. token:tint is rgb(var(--fg-rgb) / 6%): a wash, not a colour.
 *   What the eye sees is that wash over whatever is behind it. Reading 6% cream
 *   as "cream" would darken text on a page that is still essentially black.
 *
 *   IMAGES. A photograph has no single colour, and choosing one would be
 *   inventing an answer. Nothing is forced, and every element keeps its own
 *   styling — what happened before any of this existed.
 *
 * And the fix has two halves. Only the light one existed, which quietly assumed
 * a section could never be DARKER than the page.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SF  = fs.readFileSync(path.join(ROOT, 'storefront.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'storefront-cohesion.css'), 'utf8');

/* The real function, run against a stack of elements we control. */
const start = SF.indexOf('const INK_DARK  =');
const end = SF.indexOf('\n  function sectionBgTracksTheme');
const src = SF.slice(start, end);

/* Each entry is one element, nearest first; the last is <body>. */
function inkFor(stack) {
  const nodes = stack.map((s, i) => ({
    nodeType: 1,
    _bg: s.bg || 'rgba(0, 0, 0, 0)',
    _img: s.img || 'none',
    get parentElement() { return nodes[i + 1] || null; },
  }));
  const body = { nodeType: 1, _bg: stack.body || 'rgb(9, 9, 11)', _img: 'none' };
  const gcs = (n) => ({ backgroundColor: n._bg, backgroundImage: n._img });
  const fn = new Function('getComputedStyle', 'document', src + ';return zwInkFor;')(
    gcs, { body });
  return fn(nodes[0]);
}

const DARK = '#09090b', LIGHT = '#f4f1eb';

console.log('\n  the ink is measured, not guessed\n');

console.log('  an opaque background answers for itself');
{
  ok('a white band takes dark ink', inkFor([{ bg: 'rgb(255, 255, 255)' }]) === DARK);
  ok('a cream band takes dark ink', inkFor([{ bg: 'rgb(244, 241, 235)' }]) === DARK);
  /* THE CASE FROM THE SCREENSHOT. A saturated blue band is dark enough that
     dark ink on it is unreadable — and dark ink is exactly what the old rule
     produced once the theme resolved that background. */
  ok('a strong blue band takes LIGHT ink', inkFor([{ bg: 'rgb(43, 79, 216)' }]) === LIGHT,
    'this is the band the product names disappeared into');
  ok('a near-black band takes light ink', inkFor([{ bg: 'rgb(9, 9, 11)' }]) === LIGHT);
  ok('the shipped pink accent takes dark ink', inkFor([{ bg: 'rgb(248, 145, 165)' }]) === DARK);
}

console.log('\n  a wash is composited, not read as a colour');
{
  /* token:tint is 6% of the foreground over the page. On a dark page that is
     still a dark surface, and light ink is the only readable answer. */
  ok('6% cream over a black page is still dark',
    inkFor([{ bg: 'rgba(244, 241, 235, 0.06)' }, { bg: 'rgb(9, 9, 11)' }]) === LIGHT,
    'treating the wash as cream would darken text on an almost-black band');
  ok('…and 6% black over a white page is still light',
    inkFor([{ bg: 'rgba(9, 9, 11, 0.06)' }, { bg: 'rgb(255, 255, 255)' }]) === DARK);
  /* Halfway is genuinely halfway, and must resolve rather than throw. */
  ok('a half-opaque white over black lands in between and still decides',
    [DARK, LIGHT].includes(inkFor([{ bg: 'rgba(255,255,255,0.5)' }, { bg: 'rgb(0,0,0)' }])));
}

console.log('\n  it walks up until it finds something solid');
{
  ok('a transparent section takes its answer from the band behind it',
    inkFor([{ bg: 'rgba(0, 0, 0, 0)' }, { bg: 'rgb(255, 255, 255)' }]) === DARK);
  ok('…through more than one transparent layer',
    inkFor([{}, {}, { bg: 'rgb(255, 255, 255)' }]) === DARK);
  /* Nothing opaque anywhere: the page is the floor, and it is whatever the
     theme made it rather than a literal baked in here. */
  ok('with nothing opaque above it, the page decides',
    inkFor([{}, {}]) === LIGHT);
  ok('…and a light page gives dark ink',
    inkFor(Object.assign([{}, {}], { body: 'rgb(255,255,255)' })) === DARK);
}

console.log('\n  a photograph is not a colour');
{
  ok('a background image forces nothing', inkFor([{ img: 'url("hero.jpg")' }]) === '');
  ok('…even with a colour underneath it',
    inkFor([{ bg: 'rgb(255,255,255)', img: 'url("hero.jpg")' }]) === '');
  ok('…and an image on an ANCESTOR counts too',
    inkFor([{}, { img: 'url("hero.jpg")' }]) === '',
    'the section is transparent, so what shows through is the photo');
  ok('none is not an image', inkFor([{ bg: 'rgb(255,255,255)', img: 'none' }]) === DARK);
}

console.log('\n  both directions exist now');
{
  /* Only the light half was ever written, which assumed a section could never
     be darker than the page. */
  ok('the light class is still there', /\.zw-on-light :is\(h1,h2/.test(CSS));
  ok('…and the dark one exists', /\.zw-on-dark :is\(h1,h2/.test(CSS));
  ok('they push opposite colours',
    /\.zw-on-light[\s\S]{0,260}?color:#09090b !important/.test(CSS) &&
    /\.zw-on-dark[\s\S]{0,320}?color:#f4f1eb !important/.test(CSS));
  ok('…and cover the product names', /\.zw-on-dark[\s\S]{0,200}?\.pcard-name/.test(CSS));
  ok('the two are never both on', /classList\.toggle\('zw-on-light', ink === INK_DARK\)/.test(SF) &&
    /classList\.toggle\('zw-on-dark', ink === INK_LIGHT\)/.test(SF));
}

console.log('\n  when it applies, and when it stays out of the way');
{
  ok('only a section that paints its own background is touched',
    /\} else if \(s\.sec_bg\) \{/.test(SF),
    'a section with no background is just the page, and !important colour there overrides styling doing nothing wrong');
  ok('a chosen Text Color still wins outright', /el\.classList\.add\('zw-sec-tc'\)/.test(SF));
  ok('an unmeasurable background clears rather than guesses',
    /el\.classList\.remove\('zw-on-light', 'zw-on-dark', 'zw-sec-tc'\)/.test(SF));
}

console.log('\n  a measurement is only true for the theme it was taken in');
{
  ok('sections that were measured are marked', /setAttribute\('data-zw-ink', '1'\)/.test(SF));
  ok('…and re-measured when the theme changes',
    /addEventListener\('zw-theme-applied'[\s\S]{0,200}?data-zw-ink[\s\S]{0,120}?zwInkFor\(el\)/.test(SF),
    'otherwise light-on-light survives exactly one toggle');
  ok('…and the mark is removed when it no longer applies', /removeAttribute\('data-zw-ink'\)/.test(SF));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
