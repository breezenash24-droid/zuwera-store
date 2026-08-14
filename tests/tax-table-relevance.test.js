/* Sections that stopped being true when the engine changed.
 *
 * The Tax page grew up around the built-in rate table, so three of its cards
 * describe that table and only that table: the rate lookup ("exactly what rate
 * your checkout applies"), the rate reference ("the rates your server charges
 * from"), and the rate editor ("these are the figures customers are actually
 * charged"). Every one of those sentences is a claim about what the store
 * charges, and every one of them stopped being true the moment Stripe Tax was
 * put in charge — while the cards carried on rendering, confidently, in the
 * same place, with the same headings.
 *
 * That is worse than clutter. A wrong number nobody labelled as wrong is
 * indistinguishable from a right one, and this particular wrong number is the
 * one an admin would reach for when a customer queries their tax.
 *
 * Deleting the cards outright would have been the other kind of wrong, and it
 * is the reason this is three states rather than a boolean: resolveTax() falls
 * back to the built-in table when the provider cannot be reached, so with the
 * fallback on these rates really do price real orders — rarely, and exactly
 * when nobody is looking. They are backup rates then, not dead ones. Only when
 * nothing can reach them at all — fallback off, or no tax collected — is
 * hiding them the honest answer.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const TAXJS = fs.readFileSync(path.join(ROOT, 'admin-tax.js'), 'utf8');
const HTML  = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const CSS   = fs.readFileSync(path.join(ROOT, 'admin.css'), 'utf8');

/* ── A DOM small enough to reason about ──────────────────────────────────────
   Only what the two functions touch. Every element records the class and style
   operations performed on it so the assertions can be about what an admin
   would see rather than about which lines of code ran. */
function el(id) {
  const classes = new Set();
  return {
    id, innerHTML: '', textContent: '',
    style: { display: '' },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); return classes.has(c); },
    },
    _classes: classes,
  };
}

const IDS = ['tax-engine-select', 'tax-engine-fallback', 'tax-engine-note', 'tax-lookup-desc',
  'tax-lkp-result', 'tax-rateref-card', 'tax-rateref-title', 'tax-rateref-desc',
  'tax-rateref-demote', 'tax-rtabs', 'tax-rate-content', 'tax-rateeditor-card',
  'tax-rateeditor-title', 'tax-rateeditor-desc', 'tax-rateeditor-demote', 'tax-re-actions', 'tax-engine-intro',
  'tax-re-msg', 'tax-re-tabs', 'tax-re-content', 'tax-oh-rate-th'];

/* The real source of both functions, lifted out and run. A copy retyped here
   would pass forever while the page did something else. */
/* From escH, which both this block and the health banner now use. It is
   declared once above them; slicing below it leaves an undefined name and the
   harness throws at call time instead of failing a check. */
const SRC = TAXJS.slice(TAXJS.indexOf('function escH('),
                       TAXJS.indexOf('async function taxEngineLoad'));

function build() {
  const nodes = {};
  IDS.forEach((i) => { nodes[i] = el(i); });
  nodes['tax-engine-select'].value = 'builtin';
  nodes['tax-engine-fallback'].checked = true;
  /* The rows this page lays out with inline display:flex. */
  ['tax-rtabs', 'tax-re-tabs', 'tax-re-actions'].forEach((i) => { nodes[i].style.display = 'flex'; });

  let ohRenders = 0;
  const document = { getElementById: (i) => nodes[i] || null };
  const window = {
    TAX_ENGINE_META: {
      builtin:    { icon: '📋', name: 'Built-in table' },
      stripe_tax: { icon: '💳', name: 'Stripe Tax' },
      none:       { icon: '🚫', name: 'Collect no tax' },
    },
  };
  const _expectedCache = {};
  const api = new Function('document', 'window', '_expectedCache', 'renderOhioCounties', 'countOh', `
    ${SRC}
    return { taxTableRole, taxTableRelevance, expand: window.taxTableExpand };
  `)(document, window, _expectedCache, () => { ohRenders++; }, null);

  return { nodes, api, window, _expectedCache, oh: () => ohRenders };
}

/* Drives the page the way taxEngineOnChange does: it writes the engine note
   first, then hands over. Skipping that would let an append-only assertion
   pass on stale text. */
function apply(h, engine, fallback) {
  h.nodes['tax-engine-select'].value = engine;
  h.nodes['tax-engine-fallback'].checked = fallback;
  h.nodes['tax-engine-note'].innerHTML = 'ENGINE NOTE';
  h.api.taxTableRelevance();
}

const hidden = (h, id) => h.nodes[id]._classes.has('zw-off');

console.log('\n  tax sections follow the engine\n');

console.log('  three states, because there really are three');
{
  const h = build();
  ok('the table in charge is primary', (apply(h, 'builtin', true), h.api.taxTableRole() === 'primary'));
  ok('a provider with the fallback on makes it a backup',
    (apply(h, 'stripe_tax', true), h.api.taxTableRole() === 'backup'));
  /* THE DISTINCTION THAT MATTERS. Fallback on, the table still prices orders
     when Stripe is unreachable — so it is not gone, it is demoted. */
  ok('…and with the fallback off it is unused',
    (apply(h, 'stripe_tax', false), h.api.taxTableRole() === 'unused'));
  ok('collecting no tax leaves nothing for it to back up',
    (apply(h, 'none', true), h.api.taxTableRole() === 'unused'),
    'the fallback checkbox must not resurrect the table when no tax is charged');
}

console.log('\n  what an admin sees with the built-in table');
{
  const h = build();
  apply(h, 'builtin', true);
  ok('the reference card is shown', !hidden(h, 'tax-rateref-card'));
  ok('the editor card is shown', !hidden(h, 'tax-rateeditor-card'));
  ok('nothing is collapsed', !hidden(h, 'tax-rtabs') && !hidden(h, 'tax-re-tabs') && !hidden(h, 'tax-re-actions'));
  ok('the headings are the originals',
    h.nodes['tax-rateref-title'].textContent === 'Configured Rate Reference' &&
    h.nodes['tax-rateeditor-title'].textContent === 'Rate Editor');
  ok('the editor still claims these are the real figures',
    /actually charged/.test(h.nodes['tax-rateeditor-desc'].innerHTML));
  ok('there is no show/hide control to need', h.nodes['tax-rateref-demote'].style.display === 'none');
  ok('the lookup asks about your checkout, not a provider',
    /exactly what rate your checkout applies/.test(h.nodes['tax-lookup-desc'].innerHTML));
}

console.log('\n  what an admin sees with Stripe Tax pricing');
{
  const h = build();
  apply(h, 'stripe_tax', true);

  /* The claim that had to go: it was the page's own words, under a heading,
     next to a number that no customer was being charged. */
  ok('the editor no longer claims these are what customers pay',
    !/actually charged/.test(h.nodes['tax-rateeditor-desc'].innerHTML));
  ok('…it names what IS pricing orders', /Stripe Tax/.test(h.nodes['tax-rateeditor-desc'].innerHTML));
  ok('…and says the one condition under which they apply',
    /cannot be reached/.test(h.nodes['tax-rateeditor-desc'].innerHTML));
  ok('both headings say backup',
    /Backup/.test(h.nodes['tax-rateref-title'].textContent) &&
    /Backup/.test(h.nodes['tax-rateeditor-title'].textContent));

  ok('the reference contents are collapsed', hidden(h, 'tax-rtabs') && hidden(h, 'tax-rate-content'));
  ok('the editor contents are collapsed',
    hidden(h, 'tax-re-tabs') && hidden(h, 'tax-re-content') && hidden(h, 'tax-re-actions'));
  ok('the save button is out of reach until you ask for it', hidden(h, 'tax-re-actions'));
  ok('the cards themselves are still there', !hidden(h, 'tax-rateref-card') && !hidden(h, 'tax-rateeditor-card'));
  ok('with a way to open each', /taxTableExpand/.test(h.nodes['tax-rateref-demote'].innerHTML) &&
    /taxTableExpand/.test(h.nodes['tax-rateeditor-demote'].innerHTML));

  ok('the lookup says it will ask Stripe Tax', /Stripe Tax/.test(h.nodes['tax-lookup-desc'].innerHTML));

  /* The paragraph at the top of the card. It described the built-in table
     permanently — sitting directly above a label naming the real engine, and
     above the banner reporting on that engine's behaviour. Three statements
     about the same thing, one of them wrong, and the wrong one first. */
  ok('the intro no longer claims the table is what runs',
    !/built-in table is what runs unless/.test(h.nodes['tax-engine-intro'].innerHTML),
    'this sat directly above a label saying Stripe Tax');
  ok('…it names what actually prices orders', /Stripe Tax<\/b> prices every order/.test(h.nodes['tax-engine-intro'].innerHTML));
  ok('…and says the table is only a backup', /kept as a backup/.test(h.nodes['tax-engine-intro'].innerHTML));
  /* A rate quoted by the previous engine must not sit under the new one's
     name. */
  ok('…and any answer from the old engine is cleared', h.nodes['tax-lkp-result'].innerHTML === '');
}

console.log('\n  opening a backup section');
{
  const h = build();
  apply(h, 'stripe_tax', true);
  h.api.expand('rateeditor');
  ok('the editor opens', !hidden(h, 'tax-re-tabs') && !hidden(h, 'tax-re-content'));
  ok('…and the reference stays shut', hidden(h, 'tax-rtabs'), 'each card is its own decision');
  ok('the heading still says backup', /Backup/.test(h.nodes['tax-rateeditor-title'].textContent));

  /* THE BUG THIS AVOIDS. These rows are laid out with inline display:flex.
     Hiding with style.display='none' and re-showing with style.display=''
     removes the flex along with the none, so the buttons reflow into a
     stacked column that never comes back. */
  ok('re-opening does not destroy the flex layout',
    h.nodes['tax-re-actions'].style.display === 'flex',
    'style.display was cleared instead of using a class');
  ok('…which is why hiding goes through a class', /\.zw-off\s*\{\s*display:\s*none\s*!important/.test(CSS));

  h.api.expand('rateeditor');
  ok('it closes again', hidden(h, 'tax-re-tabs'));
}

console.log('\n  when the table cannot run at all');
{
  const h = build();
  apply(h, 'stripe_tax', false);
  ok('the reference card is gone', hidden(h, 'tax-rateref-card'));
  ok('the editor card is gone', hidden(h, 'tax-rateeditor-card'));
  /* A card that vanishes with no explanation is its own confusion. */
  ok('the page says where they went', /rate editor are hidden/.test(h.nodes['tax-engine-note'].innerHTML));
  ok('…and why', /fallback is off/.test(h.nodes['tax-engine-note'].innerHTML));
  ok('the engine note itself survives', /ENGINE NOTE/.test(h.nodes['tax-engine-note'].innerHTML));

  const n = build();
  apply(n, 'none', true);
  ok('collecting no tax hides them too', hidden(n, 'tax-rateref-card') && hidden(n, 'tax-rateeditor-card'));
  ok('…with the reason that actually applies',
    !/fallback is off/.test(n.nodes['tax-engine-note'].innerHTML),
    'the fallback is irrelevant when no tax is collected');

  /* Coming back must restore, not leave a blank page. */
  apply(h, 'builtin', true);
  ok('switching back brings them back', !hidden(h, 'tax-rateref-card') && !hidden(h, 'tax-rateeditor-card'));
  ok('…fully expanded, not collapsed', !hidden(h, 'tax-rtabs') && !hidden(h, 'tax-re-tabs'));
}

console.log('\n  quotes belong to the engine that gave them');
{
  const h = build();
  apply(h, 'stripe_tax', true);
  h._expectedCache['OH|45202'] = 0.078;
  apply(h, 'stripe_tax', true);
  ok('an unchanged engine keeps its cached quotes', h._expectedCache['OH|45202'] === 0.078,
    'clearing on every redraw would refire a call per jurisdiction');
  apply(h, 'builtin', true);
  ok('changing the engine drops them', !('OH|45202' in h._expectedCache),
    'the lookup would report the old engine’s rate under the new engine’s name');
}

console.log('\n  the Ohio column means different things');
{
  const h = build();
  const before = h.oh();
  apply(h, 'stripe_tax', true);
  ok('the county table is redrawn when the engine changes', h.oh() > before,
    'a column headed "Configured Rate" would keep showing table rates nothing charges');

  /* The header and the cells have to agree, so both read the same function
     at render time rather than one being set once at load. */
  ok('the header is decided by the same role check',
    /taxTableRole\(\) === 'primary'/.test(TAXJS.slice(TAXJS.indexOf('function renderOhioCounties'))));
  ok('…and the cells by the same variable',
    /const shown = configured \? fmtPct\(d\.rate\)/.test(TAXJS));
  ok('a county with no revenue shows no rate rather than zero',
    /d\.subtotal > 0 \? fmtPct\(d\.tax \/ d\.subtotal\) : '—'/.test(TAXJS));
}

console.log('\n  the lookup asks whoever is charging');
{
  /* It used to read the tables on this page and present the result as what
     checkout applies. /api/tax-quote runs the same resolveTax() the payment
     path runs, so there is one answerer instead of two. */
  ok('a non-builtin engine routes through the live quote',
    /if \(taxTableRole\(\) !== 'primary'\)[\s\S]{0,600}?await expectedRate\(state, zip\)/.test(TAXJS));
  ok('…and an unanswered quote is not shown as a rate of zero',
    /did not answer/.test(TAXJS));
  ok('the lookup is async now', /window\.taxDoLookup = async function/.test(TAXJS));
}

console.log('\n  wired up in the page');
{
  for (const id of ['tax-lookup-desc', 'tax-rateref-card', 'tax-rateref-title', 'tax-rateref-desc',
                    'tax-rateref-demote', 'tax-rtabs', 'tax-rateeditor-card', 'tax-rateeditor-title',
                    'tax-rateeditor-desc', 'tax-rateeditor-demote', 'tax-re-actions', 'tax-engine-intro', 'tax-re-tabs',
                    'tax-oh-rate-th']) {
    ok(id + ' exists in admin.html', new RegExp('id="' + id + '"').test(HTML));
  }
  ok('taxEngineOnChange hands over to it', /if \(cur\) cur\.textContent[\s\S]{0,120}?taxTableRelevance\(\);/.test(TAXJS));
  /* The fallback checkbox decides whether the table can ever price an order,
     so the sections describing it have to follow it and not just the engine. */
  ok('the fallback checkbox re-runs the decision',
    /id="tax-engine-fallback"[^>]*onchange="window\.taxEngineOnChange/.test(HTML));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
