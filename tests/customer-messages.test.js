/* The words the shopper reads, and who is allowed to write them.
 *
 * There were five ways to say "only N left" and three copies of every
 * back-in-stock line, spread over product.html, bag.html, quick-add-modal.js
 * and stock-rules.js. Nobody could change the wording without finding all of
 * them, and nobody ever found all of them.
 *
 * customer-messages.js is now the only place any of it is written. This file
 * holds that: the defaults, the placeholder rules, the colour handling, and —
 * the part that actually stops the regression — that no storefront file has
 * quietly grown its own copy of a sentence again.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const w = {};
new Function('window', read('customer-messages.js'))(w);
const M = w.ZWMessages;

console.log('\n  the shipped copy answers before anything has loaded');
{
  /* Every one of these is read by a click handler or a render pass that cannot
     wait for a fetch, so the defaults have to be usable with no settings at
     all. A store that never opens the editor still has to read correctly. */
  ok('a message resolves with no overrides', M.get('soldOut') === 'Out of stock');
  ok('placeholders fill in', M.get('lowStock', { count: 3 }) === 'Only 3 left in stock');
  ok('every key has shipped text',
    M.keys().every((k) => typeof M.DEFAULTS[k].text === 'string' && M.DEFAULTS[k].text.trim()));
  ok('every key has a colour decision recorded',
    M.keys().every((k) => typeof M.DEFAULTS[k].color === 'string'));
  ok('an unknown key is empty rather than "undefined"', M.get('nope') === '');
}

console.log('\n  placeholders are checked, not trusted');
{
  ok('a placeholder the message can use is accepted', M.validate('lowStock', 'Just {count} left!') === null);
  ok('one it cannot is refused', typeof M.validate('lowStock', 'Only {title} left') === 'string');
  ok('…and the refusal says what IS available',
    /\{count\}/.test(M.validate('lowStock', 'Only {title} left')));
  ok('a message that takes none refuses all of them',
    /takes no placeholders/.test(M.validate('soldOut', 'Gone {count}')));
  ok('plain text is always fine', M.validate('soldOut', 'All gone') === null);
  ok('empty reports as Empty, which means "use the default"', M.validate('soldOut', '  ') === 'Empty');

  /* The rule that matters: a bad override must not reach a shopper. */
  M.setOverrides({ lowStock: 'Only {title} left' });
  ok('a refused override leaves the default standing',
    M.get('lowStock', { count: 2 }) === 'Only 2 left in stock');
  M.setOverrides({});
}

console.log('\n  overrides');
{
  M.setOverrides({ soldOut: 'All gone', lowStock: { text: 'Just {count} left!', color: '#ff8800' } });
  ok('a plain string still works, since that shape shipped first', M.get('soldOut') === 'All gone');
  ok('text and colour can both be set', M.get('lowStock', { count: 2 }) === 'Just 2 left!');
  ok('…and the colour comes back', M.color('lowStock') === '#ff8800');
  ok('an untouched message keeps its shipped colour',
    M.color('restockSuccess') === M.DEFAULTS.restockSuccess.color);

  /* One bad field must not cost the store the other twelve — an admin who
     fat-fingers a colour should not silently lose their wording too. */
  const rejected = M.setOverrides({ soldOut: { text: 'All gone', color: 'red; drop shadow' } });
  ok('a bad colour is rejected', rejected.some((r) => /colour/i.test(r.key)));
  ok('…while the good text on the same message survives', M.get('soldOut') === 'All gone');
  ok('…and the colour falls back to the shipped one',
    M.color('soldOut') === M.DEFAULTS.soldOut.color);

  M.setOverrides({ soldOut: { text: 'All gone', color: '' } });
  ok('an explicitly empty colour means inherit, not "use the default"', M.color('soldOut') === '');

  M.setOverrides({ soldOut: '   ' });
  ok('clearing a box restores the shipped wording', M.get('soldOut') === 'Out of stock');

  M.setOverrides({ notAMessage: 'hello' });
  ok('an unknown key cannot be introduced from settings', M.get('notAMessage') === '');
  M.setOverrides(null);
  ok('a missing settings blob is survivable', M.get('soldOut') === 'Out of stock');
}

console.log('\n  colours are colours');
{
  ok('hex is fine', M.validateColor('#dc2626') === null);
  ok('rgba is fine', M.validateColor('rgba(110,210,130,.95)') === null);
  ok('a CSS variable is fine, since the shipped defaults use them',
    M.validateColor('var(--red,#dc2626)') === null);
  ok('a named colour is fine', M.validateColor('inherit') === null);
  ok('anything with a semicolon is not', typeof M.validateColor('red;background:url(x)') === 'string');
  ok('nor is a brace', typeof M.validateColor('red}') === 'string');
}

console.log('\n  a token with no value degrades to a sentence, not to debris');
{
  /* The bag knows the size; the product page's toast may not know the title.
     A half-supplied message has to still read like English. */
  ok('a missing token leaves no gap',
    M.get('soldOutItem', { size: 'M' }) === '(M) is out of stock');
  ok('…and empty brackets are not left behind',
    M.get('soldOutItem', { title: 'Aero Pro' }) === 'Aero Pro is out of stock');
  ok('nothing supplied still reads', M.get('soldOutItem') === 'is out of stock');
}

console.log('\n  text and colour are written together');
{
  const el = { textContent: '', style: {} };
  M.setOverrides({});
  M.apply(el, 'restockSuccess', { size: 'L' });
  ok('apply() sets the text', /L is back/.test(el.textContent));
  ok('…and the colour in the same call', el.style.color === M.DEFAULTS.restockSuccess.color);

  /* The bug this shape prevents: "you're already on the list" was reworded into
     good news and went on being painted in the error colour, because the two
     were set by different lines in different files. */
  M.apply(el, 'restockAlready');
  ok('a message that is not a failure is not coloured like one',
    el.style.color !== M.DEFAULTS.restockFailed.color);
  ok('…and the shipped "already on the list" is deliberately not red',
    M.DEFAULTS.restockAlready.color !== M.DEFAULTS.restockFailed.color);
}

console.log('\n  the storefront asks rather than answering');
{
  /* The guard-rail. Fixing the four files that carried copies does not stop the
     fifth being written, so any storefront file holding one of these sentences
     as a literal fails here — on the day it is written, not years later in
     someone's bag. */
  const SURFACES = ['product.html', 'bag.html', 'quick-add-modal.js', 'stock-rules.js'];
  const SENTENCES = [
    /Out of stock/,
    /Only \$?\{?\w*\}? ?left/,
    /in your bag/,
    /already on the list/,
    /We'?.?ll email you when/,
    /get notified when it/,
    /* Two that slipped through the first pass: the bag's form heading and the
       product page's sold-out aria-label. Both were shopper-facing copy that
       simply did not match the sentences this list happened to name, which is
       the weakness of a hand-written list — so it grows when one is found. */
    /Email me when it/,
    /sold out\. Get notified/,
  ];
  const offenders = [];
  for (const file of SURFACES) {
    const src = strip(read(file));
    for (const re of SENTENCES) {
      if (re.test(src)) offenders.push(file + ' :: ' + re);
    }
  }
  ok('no surface still carries the wording as a literal', offenders.length === 0,
    offenders.join(', ') + ' — use ZWMessages.get()/apply() instead');

  for (const file of SURFACES) {
    const src = strip(read(file));
    ok(file + ' goes through the shared messages', /ZWMessages|ZWStock\.(msg|applyMsg)|quickAddMsg|quickAddApplyMsg/.test(src));
  }
}

console.log('\n  the file is actually loaded where it is used');
{
  /* ZWStock.msg() swallows a missing ZWMessages and returns '' — an absent
     sentence beats a wrong one — which also means a forgotten script tag would
     show up as blank labels rather than as an error. This is what catches it. */
  const PAGES = ['product.html', 'bag.html', 'index.html', 'checkout.html', 'account.html', 'admin.html'];
  for (const page of PAGES) {
    const src = read(page);
    ok(page + ' loads customer-messages.js',
      /<script[^>]+src="[^"]*customer-messages\.js/.test(src), 'no script tag');
  }

  /* Order matters on the pages that render during parse, for the same reason
     it did for stock-rules.js: the answer has to exist before it is asked for. */
  for (const page of ['product.html', 'bag.html', 'index.html', 'checkout.html']) {
    const src = read(page);
    const messages = src.search(/<script[^>]+src="[^"]*customer-messages\.js/);
    const rules = src.search(/<script[^>]+src="[^"]*stock-rules\.js/);
    ok(page + ' loads it before stock-rules.js', messages !== -1 && rules !== -1 && messages < rules,
      'messages at ' + messages + ', rules at ' + rules);
  }
}

console.log('\n  the overrides actually reach the page');
{
  /* THE BUG. Message delivery was attached to ZWStock.load(), and load() was
     only ever CALLED by bag.html — so on the product page and the homepage the
     fetch never happened and the admin's wording never arrived. The editor
     saved settings that no shopper ever saw.

     I had concluded those pages fetched because they LOAD stock-rules.js.
     Loading a module and calling it are different things, and only the second
     one sends a request. */
  const rules = strip(read('stock-rules.js'));
  ok('stock-rules.js starts the fetch itself rather than waiting to be asked',
    /setTimeout\([\s\S]{0,80}load\(\)/.test(rules),
    'nothing calls load(), so pages that never call it get no overrides');
  ok('…and still hands what it gets to the message module',
    /ZWMessages[\s\S]{0,60}setOverrides/.test(rules));

  /* Arriving is not enough — the product page has already drawn its stock line
     by then, so it has to be told to paint it again. */
  ok('customer-messages.js can tell surfaces the wording changed',
    typeof M.subscribe === 'function');
  let fired = 0;
  const stop = M.subscribe(() => { fired += 1; });
  M.setOverrides({ soldOut: 'Gone' });
  ok('…and does so when overrides land', fired === 1);
  stop();
  M.setOverrides({});
  ok('…and unsubscribing works', fired === 1);

  const product = strip(read('product.html'));
  ok('the product page repaints when the wording lands',
    /ZWMessages[\s\S]{0,120}subscribe/.test(product), 'it renders once and never updates');
  ok('…and subscribes late enough that the module exists',
    /DOMContentLoaded[\s\S]{0,80}attach|attach[\s\S]{0,120}DOMContentLoaded/.test(product),
    'customer-messages.js is deferred on this page, so a parse-time subscribe finds nothing');
}

console.log('\n  the editor describes each message in words, and inserts the values for you');
{
  ok('every message has an admin-facing name',
    M.keys().every((k) => typeof M.DEFAULTS[k].label === 'string' && M.DEFAULTS[k].label.trim()),
    'a message would show up in admin labelled with its raw default');
  ok('…and the names live with the messages, not in the editor',
    !/A size is sold out/.test(strip(read('admin-main.js'))),
    'admin-main.js carries its own copy of a label');

  const admin = strip(read('admin-main.js'));
  ok('placeholders are inserted by clicking, not typed', /cm-token/.test(admin));
  ok('…at the cursor, so the position is chosen', /setSelectionRange/.test(admin));
  ok('…and an untouched message keeps its sentence when one is inserted',
    /if \(!textEl\.value\)[\s\S]{0,120}def\.text/.test(admin),
    'inserting into an empty box would replace the whole message with a bare token');
  ok('each message saves on its own', /customerMessagesSaveOne/.test(admin));
  ok('…without discarding the others', /Object\.assign\(\{\}, cx\.messages\)/.test(admin));
  ok('the colour box says what it accepts',
    /rgb\(220,38,38\)/.test(read('admin.html')), 'no format hint for the colour field');
}

console.log('\n  a message has to stop being shown when it stops being true');
{
  /* "Size M is sold out — get notified when it's back" stayed on screen
     regardless. The panel is opened by clicking a sold-out size, and
     renderSizes() — which re-runs whenever the COLOUR changes — never closed
     it. Switch to a colourway where M is in stock and the page said one thing
     above the sizes and the opposite below them.

     quick-add-modal.js has always reset its own panel on every render. The
     product page is the copy that did not, which is the same shape as every
     other bug in this area: two implementations, one of them missing a rule. */
  const src = strip(read('product.html'));
  const render = src.slice(src.indexOf('function renderSizes()'));
  const body = render.slice(0, render.indexOf('sizes.forEach'));
  ok('re-rendering the sizes closes a stale back-in-stock panel',
    /hideRestockPanel\(\)/.test(body),
    'a panel opened for one colourway survives into the next');

  const quick = strip(read('quick-add-modal.js'));
  ok('…the quick-add panel still does the same', /quickAddHideRestock\(\)/.test(quick));
}

console.log('\n  a message needs somewhere to appear');
{
  /* Delivering the right words into a box that cannot hold them is not
     delivering them. The bag's rows were sized to the product image with a
     FIXED height, and bag.html appends the stock note and the back-in-stock
     form into that row after /api/stock answers — so the moment a message
     actually showed up, it ran past the bottom of the row and overlapped the
     one below.

     Anything a row can have appended to it has to be able to grow. */
  const css = read('cart.css');
  const rule = (name) => {
    const m = css.match(new RegExp('\\.' + name + '\\s*\\{([^}]*)\\}'));
    return m ? m[1] : '';
  };
  for (const name of ['cart-item-details', 'cart-item-right']) {
    const body = rule(name);
    ok('.' + name + ' can grow with what is appended to it',
      /min-height:/.test(body) && !/(^|[^-])\bheight:\s*\d/.test(body),
      'a fixed height clips the stock note and the restock form');
  }
  ok('the row aligns to the top, so a taller column does not drag the rest down',
    /align-items:\s*flex-start/.test(rule('cart-item-card')));
}

console.log('\n  card declines');
{
  /* Keyed by Stripe's own decline code, so the lookup is `decline:` + whatever
     Stripe sent. A translation table in between is one more thing to fall out
     of step with the codes Stripe actually uses. */
  const co = strip(read('checkout.js'));
  ok('checkout.js no longer carries its own copy', !/DECLINE_COPY/.test(co));
  ok('…and looks the wording up by Stripe\'s code',
    /'decline:'\s*\+\s*code|decline:.\s*\+/.test(co));

  ok('the common codes all have copy',
    ['insufficient_funds', 'incorrect_cvc', 'expired_card', 'generic_decline', 'do_not_honor']
      .every((c) => M.has('decline:' + c)));
  ok('…and each is coloured as a failure, which this one genuinely is',
    M.DEFAULTS['decline:expired_card'].color === M.DEFAULTS.restockFailed.color);

  /* The shopper must never be refused without an explanation, so there is a
     catch-all AND a hardcoded last resort in checkout.js for the case where
     the module did not load at all. */
  ok('there is copy for a code we do not recognise', M.has('decline:unknown'));
  ok('…and checkout.js still answers if the module is missing entirely',
    /could not be completed/.test(co), 'a missing module would refuse in silence');
  ok('…and that fallback is word-for-word the shipped catch-all',
    co.includes(M.DEFAULTS['decline:unknown'].text),
    'the hardcoded fallback says something different from the editable copy');

  /* Neutral copy for lost/stolen is a deliberate decision, not an oversight:
     the person at the checkout may not be the cardholder. */
  ok('lost and stolen share neutral wording',
    M.get('decline:lost_card') === M.get('decline:stolen_card'));
  ok('…which says nothing about the card being reported',
    !/stolen|lost|report/i.test(M.get('decline:stolen_card')));
}

console.log('\n  the editor stays usable as the list grows');
{
  ok('the module decides the grouping', typeof M.groups === 'function');
  const grouped = M.groups().reduce((n, g) => n + g.keys.length, 0);
  ok('every message lands in exactly one group', grouped === M.keys().length,
    grouped + ' grouped vs ' + M.keys().length + ' messages');

  const admin = strip(read('admin-main.js'));
  ok('the editor reads the grouping rather than keeping its own',
    /M\.groups\(\)/.test(admin));
  ok('…and groups collapse, since the decline list alone is twenty-odd rows',
    /details class="cm-group"/.test(admin));
}

console.log('\n  the admin editor and the storefront cannot describe different messages');
{
  /* The editor builds its fields from ZWMessages.keys() and validates with
     ZWMessages.validate(), rather than from a list typed out in admin-main.js.
     A hand-kept copy would drift within a release — which is the whole reason
     this module exists. */
  const admin = strip(read('admin-main.js'));
  /* Either accessor is fine; what matters is that the list of messages comes
     from the module rather than being typed out again here. */
  ok('the editor reads its message list from the shared module',
    /M\.(keys|groups)\(\)|ZWMessages\.(keys|groups)\(\)/.test(admin));
  ok('…and validates with the storefront\'s own rules', /\.validate\(/.test(admin) && /\.validateColor\(/.test(admin));
  ok('…and does not hardcode the shipped wording',
    !/Only \{count\} left in stock/.test(admin), 'admin-main.js carries its own copy of a default');
}

console.log('\n  the popup validation copy is editable and no longer written twice');
{
  /* The reported one: "Pop your email in above and the code is yours." was
     hardcoded, and hardcoded TWICE in the same file — once for the live popup
     and once for the admin preview, so the preview could show copy the shopper
     would never see. */
  const src = strip(read('email-popup.js'));
  /* The whole sentence, not the shared opening words: 'Pop your email in
     above' legitimately begins two different defaults (discount and signup). */
  const literal = (src.match(/Pop your email in above and the code is yours/g) || []).length;
  ok('the copy appears once, as a default', literal === 1, 'found ' + literal + ' copies');
  ok('…and both the live popup and the preview read it from config',
    (src.match(/showErr\(/g) || []).length >= 6, 'one of the two paths still writes its own');
  ok('…and it is normalised like the rest of the settings', /errors:\s*\{/.test(src));
  ok('…and carries a colour, so a nudge need not look like an error',
    /msgField\(/.test(src));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
