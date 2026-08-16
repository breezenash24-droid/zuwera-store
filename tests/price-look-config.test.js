/* The member badge is arranged in the builder, and the two ends agree.
 *
 * "Member pricing looks odd there — can you let me change the structure/look of
 *  it in the page builder."
 *
 * Position, shape and wording, stored in site_settings.product_page beside the
 * gallery arrangement that already lives there. Three things have to hold:
 *
 * 1. THE DEFAULT IS WHAT THE PAGE ALREADY DID. A store that never opens the
 *    tab must not be redesigned by upgrading, so every option list starts with
 *    the current behaviour and an absent config resolves to it.
 *
 * 2. THE BUILDER AND THE API AGREE ON THE OPTIONS. The builder keeps its own
 *    copy of the lists so it can validate before writing — which is right, and
 *    is also two tables that can drift. A value the builder offers and the API
 *    rejects is a setting that saves, reloads as the default, and looks like it
 *    did not save at all.
 *
 * 3. THE WORDING IS MERCHANT-TYPED FREE TEXT ON A PUBLIC PAGE. Sanitised where
 *    it is stored and escaped where it is inserted. The escaping is what
 *    protects the page; the sanitising stops a value that looks like markup
 *    from ever existing.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const BUILDER = fs.readFileSync(path.join(ROOT, 'builder.html'), 'utf8');
const API_SRC = fs.readFileSync(path.join(ROOT, 'functions/api/product-page-config.js'), 'utf8');
const PAGE    = require('./_product-source').all()  /* product.html + its extracted scripts — see _product-source.js */;

/* Pull an option table out of source as DATA. Comparing two literal lists is
   what a regex is actually good for — unlike asserting that logic exists. */
function optionLists(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const block = src.slice(start, src.indexOf('};', start));
  const out = {};
  const re = /(\w+)\s*:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(block))) {
    out[m[1]] = m[2].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  return out;
}

(async () => {
  const API = await import(pathToFileURL(path.join(ROOT, 'functions/api/product-page-config.js')).href);

  console.log('\n  the member badge is arranged in the builder\n');

  console.log('  a store that never opens the tab is unchanged');
  {
    const d = API.parsePriceConfig(undefined);
    ok('the badge sits beside the price', d.member_position === 'inline');
    ok('…as an outlined pill', d.member_style === 'pill');
    ok('…with no wording of its own', d.member_label === '',
      'empty means "use what we ship", which renderPrice turns into "Member price"');

    const whole = API.parsePdpConfig(null);
    ok('and it arrives with the rest of the layout', whole.price && whole.price.member_position === 'inline',
      'a caller reading cfg.price on a store with no saved layout must not get undefined');
    ok('…alongside a saved one too',
      API.parsePdpConfig({ sections: [{ id: 'qa', on: true }] }).price.member_style === 'pill');
  }

  console.log('\n  a value that is not on the list is not honoured');
  {
    ok('an invented position falls back', API.parsePriceConfig({ member_position: 'floating' }).member_position === 'inline',
      'these land in a CSS class name; an unrecognised one is a badge no stylesheet answers to');
    ok('an invented style falls back', API.parsePriceConfig({ member_style: 'neon' }).member_style === 'pill');
    ok('a non-string falls back', API.parsePriceConfig({ member_position: 42 }).member_position === 'inline');
    ok('…and the real ones are kept',
      API.parsePriceConfig({ member_position: 'below', member_style: 'solid' }).member_position === 'below'
      && API.parsePriceConfig({ member_position: 'below', member_style: 'solid' }).member_style === 'solid');
  }

  console.log('\n  the wording is cleaned before it is stored');
  {
    ok('markup cannot be stored', API.sanitizePriceLabel('<b>Crew</b>') === 'bCrew/b',
      'the page escapes on the way out too — this stops the value existing in the first place');
    ok('control characters are stripped',
      API.sanitizePriceLabel('Crew' + String.fromCharCode(0, 31) + 'price') === 'Crewprice',
      'built rather than typed: a raw control byte in a source file is what this whole idiom exists to avoid');
    ok('it is trimmed', API.sanitizePriceLabel('  Crew price  ') === 'Crew price');
    ok('and capped', API.sanitizePriceLabel('x'.repeat(200)).length === 24,
      'an unbounded label is a badge that pushes the price off the line');
    ok('a non-string is empty, not "undefined"', API.sanitizePriceLabel(undefined) === ''
      && API.sanitizePriceLabel(null) === '' && API.sanitizePriceLabel(7) === '',
      'String(undefined) on a badge prints the word undefined to a shopper');
    ok('an ordinary label survives intact', API.sanitizePriceLabel('Crew price') === 'Crew price');
  }

  console.log('\n  the builder offers exactly what the API accepts');
  {
    /* Two copies of one table. The builder validates before writing so a value
       the API would reject cannot be written — which only works while the two
       lists say the same thing. */
    const fromApi = optionLists(API_SRC, 'const PRICE_OPTS = {');
    const fromBuilder = optionLists(BUILDER, 'const PDP_PRICE_OPTS = {');
    ok('both tables were found', !!fromApi && !!fromBuilder);
    ok('the same settings', JSON.stringify(Object.keys(fromApi || {}).sort())
      === JSON.stringify(Object.keys(fromBuilder || {}).sort()),
      'api: ' + Object.keys(fromApi || {}) + ' / builder: ' + Object.keys(fromBuilder || {}));
    for (const key of Object.keys(fromApi || {})) {
      ok('…and the same values for ' + key,
        JSON.stringify(fromApi[key]) === JSON.stringify((fromBuilder || {})[key]),
        'api: ' + JSON.stringify(fromApi[key]) + ' / builder: ' + JSON.stringify((fromBuilder || {})[key]));
    }
    ok('the first entry is the default in both',
      Object.keys(fromApi || {}).every((k) => fromApi[k][0] === fromBuilder[k][0]),
      'both sides take allowed[0] as the fallback, so a reordered list silently changes what a store gets');
  }

  console.log('\n  the builder saves it, and reads it back');
  {
    ok('it is written with the layout', /value:\{sections:pdpCfg,gallery:pdpGallery,price:pdpPrice\}/.test(BUILDER),
      'saved separately it would be lost the next time the block list was saved');
    ok('…and loaded with it', /pdpPrice = pdpPriceNormalize\(v && v\.price\);/.test(BUILDER));
    ok('…including when the read fails', /pdpPrice = pdpPriceNormalize\(null\)/.test(BUILDER),
      'left null, painting the tab throws and it sits on "Loading…" forever — which this file has done before');
    ok('the controls are in the Product tab', /pdpPriceFieldsHtml\(\)/.test(BUILDER) && /id="pdpPriceFields"/.test(BUILDER));
    ok('…and greying follows the choice rather than the page load',
      /P\.member_position==='hidden'/.test(BUILDER),
      'a Style control sitting live beside a hidden badge is the trap the Arrows setting already fell into');
    ok('…repainting only the price fields',
      /const host=document\.getElementById\('pdpPriceFields'\);/.test(BUILDER),
      'repainting the whole tab collapses the block list and loses the scroll position mid-edit');
  }

  console.log('\n  the page waits for the arrangement as well as the price');
  {
    ok('both, before anything is printed',
      /const settled = pricesKnown && PRICE_LOOK_READY;/.test(PAGE),
      'the figure and the badge come from two requests; painting on the first leaves the badge changing under it');
    ok('the layout read settles however it goes',
      /setTimeout\(settle, 4000\);/.test(PAGE) && /\.catch\(\(\) => \{\}\)\s*\n\s*\.then\(settle\);/.test(PAGE),
      'a layout read that hangs must leave the shipped arrangement standing, not hold the price behind a placeholder');
    ok('…and it is cached for the next load',
      /localStorage\.setItem\('zw_pdp_price_v1'/.test(PAGE) && /localStorage\.getItem\('zw_pdp_price_v1'/.test(PAGE));
    ok('the cached value is clamped too',
      /function normalisePriceLook\(raw\)/.test(PAGE) && /PRICE_LOOK_ALLOWED\[key\]\.includes\(raw\[key\]\)/.test(PAGE),
      'a value cached before an option was renamed would otherwise reach a class name nothing styles');
    /* Built from a string, not typed as a literal character class, and written
       the same way as the three other files that do this. Typing it by hand put
       RAW control bytes into the page — the editor wrote the characters, not
       the escapes — and [ -<>] is one keystroke away, which is a RANGE that
       strips every printable character from space to "<". */
    ok('…and the label class is built, not typed',
      PAGE.includes("new RegExp('[\\\\u0000-\\\\u001f\\\\u007f<>]', 'g')"),
      'a literal class here is one keystroke from a range that strips every printable character');
    ok('…written the same way as everywhere else that does it',
      ['functions/api/product-page-config.js', 'functions/api/_attribution.js', 'builder.html']
        .every((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('\\\\u0000-\\\\u001f\\\\u007f')),
      'four copies of one idiom, so a reader comparing them sees one thing');
    /* Constructed, for the same reason. Writing this class as a literal is
       what put control bytes in product.html twice already. */
    ok('and the page carries no raw control bytes',
      !new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]').test(PAGE),
      'that is what writing the characters instead of the escapes actually produces');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
