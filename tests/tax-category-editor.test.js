/* A column the checkout reads and nothing could write.
 *
 * products.tax_category has existed since migration 0011. _cart-pricing.js
 * reads it onto every line, _tax.js prefers it over the store-wide default, and
 * every engine adapter maps it to that provider's own code. The whole chain was
 * built. There was no way to set it — the admin's own troubleshooting entry
 * said so out loud: "There is no editor for it yet — it is a database field
 * today."
 *
 * So the only answer the catalogue could give was the store-wide one, which for
 * a clothing shop means "everything is clothing". That is right until the first
 * water bottle or gift card, and then it is silently wrong in the expensive
 * direction: clothing is exempt in PA, NJ and MN and exempt under $110 an item
 * in New York, and a bottle is none of those things.
 *
 * The categories are NEUTRAL on purpose. Stripe writes txcd_…, TaxJar writes a
 * number, Avalara writes something else — tagging a catalogue in one provider's
 * vocabulary is what makes that provider hard to leave, so the product carries
 * the meaning and Admin → Tax carries the translation.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const HTML  = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');
const CART  = fs.readFileSync(path.join(ROOT, 'functions/api/_cart-pricing.js'), 'utf8');
const TAXJS = fs.readFileSync(path.join(ROOT, 'admin-tax.js'), 'utf8');

(async () => {
  const T = await import(pathToFileURL(ROOT + '/functions/api/_tax.js').href);

  console.log('\n  setting what a product is, for tax\n');

  console.log('  the editor exists');
  {
    ok('there is a field', /id="taxCategory"/.test(HTML));
    ok('…and it is a select, not free text', /<select id="taxCategory"/.test(HTML),
      'a typo in a tax category is a compliance error that looks like a working checkout');
    ok('…inside the product form', HTML.indexOf('id="taxCategory"') > HTML.indexOf('id="productForm"'));

    /* Extract the options and compare them against what the SERVER accepts. A
       category the engine has never heard of maps to no code at all. */
    const block = HTML.slice(HTML.indexOf('<select id="taxCategory"'), HTML.indexOf('</select>', HTML.indexOf('<select id="taxCategory"')));
    const values = [...block.matchAll(/value="([a-z]*)"/g)].map((m) => m[1]);
    const server = Object.keys(T.TAX_CATEGORIES);
    ok('every server category is offered', server.every((c) => values.includes(c)),
      'missing: ' + server.filter((c) => !values.includes(c)).join(', '));
    ok('…and nothing is offered that the server does not know',
      values.filter(Boolean).every((v) => server.includes(v)),
      'extra: ' + values.filter((v) => v && !server.includes(v)).join(', '));
    ok('…plus a blank for the store default', values.includes(''));
    ok('the blank is first, so a new product inherits rather than guesses',
      values[0] === '', 'form.reset() selects the first option');
  }

  console.log('\n  it saves and loads');
  {
    /* This read the inline expression until gift cards arrived. The value now
       comes from _taxCategoryFromForm(), because a gift card must save as
       'exempt' whatever the select says — migration 0032 has a check constraint
       refusing a taxable gift card, and an admin should meet that as a sentence
       rather than as a Postgres violation. The ordinary path is unchanged, which
       is what the second half asserts. */
    ok('it is written on save',
      /tax_category: _taxCategoryFromForm\(\)/.test(ADMIN)
      && /return document\.getElementById\('taxCategory'\)\.value \|\| null;/.test(ADMIN));
    ok('…and a gift card overrides it, because the database refuses anything else',
      /if \(_isGiftCardChecked\(\)\) return 'exempt';/.test(ADMIN),
      'tax on a gift card is charged twice: once at purchase and again on whatever it buys');
    /* NULL, not ''. The column's own comment says NULL means "fall back to the
       store-wide default"; an empty string is a value that matches no category
       and would send no code where the default was wanted. */
    ok('…as NULL rather than an empty string', /\.value \|\| null,/.test(ADMIN));
    ok('it is read back when editing', /getElementById\('taxCategory'\)\.value = product\.tax_category \|\| ''/.test(ADMIN));
  }

  console.log('\n  the chain it feeds was already there');
  {
    ok('the cart carries it per line', /taxCategory: String\(product\.tax_category \|\| ''\)\.trim\(\)/.test(CART));
    ok('…and the engine prefers it over the store default',
      /taxCodeFor\(engine, item\.taxCategory \|\| config\.defaultCategory, config\)/.test(
        fs.readFileSync(path.join(ROOT, 'functions/api/_tax.js'), 'utf8')));

    /* Run it. A product's own category must win; a product without one must
       fall back; neither may invent a code. */
    const cfg = { taxCodes: { stripe_tax: { clothing: 'txcd_CLOTH', general: 'txcd_GEN' } } };
    ok('a tagged product uses its own code', T.taxCodeFor('stripe_tax', 'clothing', cfg) === 'txcd_CLOTH');
    ok('an untagged one uses the store default', T.taxCodeFor('stripe_tax', 'general', cfg) === 'txcd_GEN');
    /* Blank is a real answer and the shipped one: send nothing and the provider
       applies the default set in its own dashboard. */
    ok('a category with no code configured sends nothing',
      T.taxCodeFor('stripe_tax', 'footwear', cfg) === '');
    ok('…and so does an engine that has no codes at all',
      T.taxCodeFor('builtin', 'clothing', cfg) === '');
  }

  console.log('\n  the two halves are named the same way');
  {
    /* The product editor and the Admin → Tax code table are two lists of the
       same categories. If they drift, a category is taggable and untranslatable
       or the reverse. */
    const labels = TAXJS.slice(TAXJS.indexOf('const TAX_CATEGORY_LABELS = {'),
                               TAXJS.indexOf('};', TAXJS.indexOf('const TAX_CATEGORY_LABELS = {')));
    const adminKeys = [...labels.matchAll(/(\w+):\s*'/g)].map((m) => m[1]);
    const server = Object.keys(T.TAX_CATEGORIES);
    ok('Admin → Tax lists exactly the server categories',
      server.every((c) => adminKeys.includes(c)) && adminKeys.every((c) => server.includes(c)),
      adminKeys.join(', ') + ' vs ' + server.join(', '));
  }

  console.log('\n  and the panel stops saying there is no editor');
  {
    ok('the troubleshooting entry points at the field', /Products → edit → beside the prices/.test(ADMIN));
    ok('…and no longer calls it a database-only field',
      !/There is no editor for it yet/.test(ADMIN));
    /* Tagging alone changes nothing if the provider code is blank — which is
       how it ships, deliberately. Saying so is the difference between a fix and
       a half-fix somebody thinks is done. */
    ok('…and says tagging alone is not enough', /a category with no code still sends nothing/.test(ADMIN));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✗ suite crashed: ' + e.stack); process.exit(1); });
