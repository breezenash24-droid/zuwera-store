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
  const SURFACES = ['product.html', 'bag.html', 'quick-add-modal.js', 'stock-rules.js', 'drop001.html'];
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
    /* The collection grid and the quick-add size buttons each had their own
       "Sold Out" and "Low Stock". Short forms, but still shopper-facing copy
       and still two copies of it. */
    />Sold Out</,
    /' - Sold Out'/,
    />Low Stock</,
    /Invalid promo code/,
    /Enter a promo code/,
    /Could not validate code/,
    /' applied!'/,
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
  const PAGES = ['product.html', 'bag.html', 'index.html', 'checkout.html', 'account.html', 'admin.html', 'drop001.html'];
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
  /* The box used to be EMPTY with the shipped sentence shown as a placeholder.
     That looks identical to filled-in text and is not: clicking in and editing
     it did nothing, because there was nothing there. */
  ok('the text box carries the real sentence, not a placeholder of it',
    /const text = saved_ \|\| def\.text/.test(admin),
    'an empty box with a placeholder cannot be edited in place');
  ok('…but wording identical to the default is still stored as no override',
    /text !== def\.text/.test(admin),
    'settings would fill with copies of the defaults and freeze them against later changes');

  /* Rare messages are behind a toggle rather than absent: a message you cannot
     find is a message you cannot edit. */
  ok('the panel leads with the common messages', /\(main \|\| keys\)/.test(admin));
  ok('…and the rest are one click away, not gone', /less common message/.test(admin));
  ok('a message added later shows by default rather than hiding',
    /var SECONDARY/.test(read('customer-messages.js')),
    'an opt-IN list would bury anything new behind a toggle nobody opens');

  /* Checking a wording change used to mean deploying it, then opening a console
     or putting a declined card through a real checkout. */
  ok('the editor shows the finished sentence as it is typed', /cm-preview/.test(admin));
  ok('…filled in by the same code the storefront uses', /M\.render\(/.test(admin),
    'a preview with its own substitution routine is a preview that can lie');
  ok('…and coloured the way the shopper will see it',
    /preview\.style\.color/.test(admin));
  ok('render() and get() share one substitution',
    M.render('Only {count} left in stock') === M.get('lowStock', M.SAMPLE));

  /* Colour is offered as named MEANINGS, so a store picking "Alert" gets this
     theme's alert red everywhere rather than three hand-typed reds. */
  ok('the palette is named for meaning, not for hue',
    M.PALETTE.every((p) => /^[A-Z]/.test(p.name) && typeof p.value === 'string'));
  ok('every message recommends a colour from that palette',
    M.keys().every((k) => M.paletteName(M.recommendedColor(k)) !== null),
    'a message ships a colour nobody can pick from the editor');
  ok('the recommendation is the shipped colour',
    M.recommendedColor('soldOutInBag') === M.DEFAULTS.soldOutInBag.color);
  ok('…and reads as Alert for the one that blocks checkout',
    M.paletteName(M.recommendedColor('soldOutInBag')) === 'Alert');
  ok('…and as Positive for good news',
    M.paletteName(M.recommendedColor('restockSuccess')) === 'Positive');
  ok('a custom colour is still allowed', M.validateColor('#ff8800') === null);

  ok('the editor marks the recommended one', /recommended/.test(admin));
  ok('…and offers the palette rather than a blank box', /cm-swatch-btn/.test(admin));
  ok('…while keeping free text for a brand colour', /or any CSS colour/.test(admin));

  ok('the colour box says what it accepts',
    /rgb\(220,38,38\)/.test(read('admin.html')), 'no format hint for the colour field');
}

console.log('\n  the payment path says the same things, from the same settings');
{
  /* customer-messages.js is a classic browser script; functions/api/_messages.js
     is an ES module in a Worker. Neither can import the other, so the defaults
     for shared keys are written twice — and this is what stops the second copy
     drifting. Same arrangement as the other "two lists must stay identical"
     invariants here; the duplication is deliberate and checked. */
  const server = read('functions/api/_messages.js');
  const serverDefaults = {};
  const block = server.slice(server.indexOf('export const DEFAULTS = {'));
  block.slice(0, block.indexOf('};')).replace(
    /^\s*([a-zA-Z]+):\s*'((?:[^'\\]|\\.)*)',/gm,
    (_, k, v) => { serverDefaults[k] = v.replace(/\\'/g, "'"); return ''; });

  ok('the worker\'s message list parses', Object.keys(serverDefaults).length >= 6,
    Object.keys(serverDefaults).length + ' found');

  /* THE point of this section: sold-out is ONE sentence now. It had five
     wordings across the storefront and a sixth on the payment path, which is
     how a shopper could read "Only 1 left" on one screen and a differently
     phrased refusal on the next. */
  ok('checkout uses the same sold-out message the storefront does',
    serverDefaults.soldOutItem !== undefined,
    'the payment path has invented its own wording again');
  ok('…character for character',
    serverDefaults.soldOutItem === M.DEFAULTS.soldOutItem.text,
    JSON.stringify(serverDefaults.soldOutItem) + ' vs ' + JSON.stringify(M.DEFAULTS.soldOutItem.text));

  /* Every key the two sides share has to agree, not just that one. */
  const shared = Object.keys(serverDefaults).filter((k) => M.has(k));
  const drifted = shared.filter((k) => serverDefaults[k] !== M.DEFAULTS[k].text);
  ok('no shared message has drifted between browser and worker', drifted.length === 0,
    drifted.join(', '));

  /* And an admin edit has to reach the payment path, or the two agree only
     until somebody changes one of them. */
  const co = read('functions/api/_cart-pricing.js');
  ok('the worker reads the admin\'s overrides', /messagesFrom\(cfg\)/.test(co));
  ok('…from the same settings read as the stock rule, not a second one',
    /limitToStock, say/.test(co), 'two reads let the rule and its wording arrive out of step');
  ok('…and falls back to the shipped copy when settings are unreadable',
    /say: shippedMessages/.test(co), 'a refusal with no reason is the one thing it must not be');

  ok('the refusals no longer carry their wording inline',
    !/is out of stock\.`/.test(co) && !/Only \$\{available\} left/.test(co));
}

console.log('\n  signing in');
{
  const z = strip(read('zw-login.js'));
  ok('the login copy comes from the shared messages', /authMsg\(/.test(z));
  ok('…and none of it is written inline any more',
    !/Enter your email and password|Password must be at least|Connection unavailable|Something went wrong/.test(z));

  /* The auth service's own message is usually the most useful thing available,
     so it passes through — except for the two cases a shopper actually meets,
     which were reaching the screen verbatim from Supabase and could not be
     changed by anyone. */
  ok('a wrong password maps onto an editable message', /invalid login credentials/i.test(z));
  ok('an address that already has an account does too', /already registered/i.test(z));
  ok('…and anything else the service says still passes through',
    /return raw \|\|/.test(z), 'a specific reason would be replaced by a generic one');

  /* The login modal appears on pages with no reason to load stock rules, so the
     wording has to reach them too. An edit that applies on some pages and not
     others looks like it half-worked, which is worse than not applying. */
  const pages = ['about.html', 'journal.html', 'policies.html', 'returns.html', 'sizeguide.html', 'landing.html'];
  for (const page of pages) {
    const src = read(page);
    if (!/zw-login\.js/.test(src)) continue;
    ok(page + ' has the wording the login modal needs',
      /<script[^>]+src="[^"]*customer-messages\.js/.test(src));
  }
  ok('…and the module fetches for itself when nothing else will',
    /function selfFetch/.test(read('customer-messages.js')));
  ok('…without a second request where stock-rules.js is already fetching',
    /ZWMessages\.claim/.test(read('stock-rules.js')));
}

console.log('\n  a coupon can still speak for itself');
{
  /* validate-promo returns a per-code message where one is set in admin —
     "expired on 1 June" is more use to a shopper than a generic refusal. The
     shared message is the fallback and the COLOUR, not a replacement for it. */
  const bag = strip(read('bag.html'));
  ok('the promo replies come from the shared messages', /'promoInvalid'/.test(bag) && /'promoApplied'/.test(bag));
  ok('…and a code\'s own message still wins where it has one',
    /data\.message/.test(bag) && /promo\.message/.test(bag),
    'a per-coupon explanation would be thrown away');
  ok('a working code reads as good news', M.paletteName(M.recommendedColor('promoApplied')) === 'Positive');
  ok('…and a refused one as a problem', M.paletteName(M.recommendedColor('promoInvalid')) === 'Alert');
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
  ok('…and maps Stripe\'s code through the shared table',
    /declineKey\(/.test(co), 'checkout.js is grouping codes with a table of its own');

  /* Nine messages, not one per Stripe code. Twenty-odd codes collapse into far
     fewer things a shopper can DO about it, and a box per code made the editor
     unusable without helping anyone. */
  const declineKeys = M.keys().filter((k) => k.indexOf('decline') === 0);
  ok('the decline messages stay a short list', declineKeys.length <= 10,
    declineKeys.length + ' — one box per Stripe code is what this replaced');

  ok('every Stripe code lands on a real message',
    ['insufficient_funds', 'incorrect_cvc', 'invalid_cvc', 'incorrect_number', 'invalid_number',
     'expired_card', 'invalid_expiry_month', 'invalid_expiry_year', 'incorrect_zip',
     'card_not_supported', 'currency_not_supported', 'call_issuer', 'lost_card', 'stolen_card',
     'pickup_card', 'fraudulent', 'merchant_blacklist', 'do_not_honor', 'generic_decline',
     'processing_error', 'try_again_later'].every((c) => M.has(M.declineKey(c))));
  ok('…and so does a code nobody has seen before', M.has(M.declineKey('invented_in_2099')));
  ok('…landing on the catch-all rather than on silence',
    M.declineKey('invented_in_2099') === 'declined');

  /* What survived the collapse is a distinct ACTION. If these ever read the
     same, the separate copy has stopped earning its place. */
  const distinct = ['declineFunds', 'declineCvc', 'declineExpired', 'declined'].map((k) => M.get(k));
  ok('the advice still differs where the action differs',
    new Set(distinct).size === 4, distinct.join(' | '));

  ok('every decline is coloured as a failure, which these genuinely are',
    declineKeys.every((k) => M.DEFAULTS[k].color === M.DEFAULTS.restockFailed.color));

  /* The shopper must never be refused without an explanation, so there is a
     catch-all AND a hardcoded last resort in checkout.js for the case where the
     module did not load at all. */
  ok('checkout.js still answers if the module is missing entirely',
    /was declined/.test(co), 'a missing module would refuse in silence');
  ok('…and that fallback is word-for-word the shipped catch-all',
    co.includes(M.DEFAULTS.declined.text),
    'the hardcoded fallback says something different from the editable copy');

  /* Lost, stolen, fraud and pickup all land on the neutral catch-all. Telling
     someone their card is reported stolen is a message for the CARDHOLDER, and
     the person at the checkout may not be them. */
  ok('lost, stolen, fraud and pickup all read the same',
    new Set(['lost_card', 'stolen_card', 'fraudulent', 'pickup_card'].map((c) => M.declineKey(c))).size === 1);
  ok('…and say nothing about the card being reported',
    !/stolen|lost|fraud|report/i.test(M.get('declined')));
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
