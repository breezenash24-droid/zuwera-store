/* Does an admin's edit actually reach a shopper?
 *
 * Every other check in this codebase reads the SOURCE. Those all passed while
 * the feature was broken: the wording was saved, the endpoint served it, and
 * nothing on the product page ever asked for it, because delivery was hung off
 * a function only one page happened to call.
 *
 * So this one runs it. A fake /api/stock, the real stock-rules.js, the real
 * customer-messages.js, and the real worker module — then it asks what a
 * shopper would be told. It is the closest thing here to opening the site.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..') + '/';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

/** A browser with a stubbed /api/stock, loaded the way a page loads it. */
function browser(messages, opts = {}) {
  const win = {};
  const calls = { stock: 0 };
  win.fetch = (url) => {
    if (String(url).includes('/api/stock')) {
      calls.stock += 1;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, sizes: [], limitToStock: true, messages }),
      });
    }
    return Promise.reject(new Error('unexpected fetch: ' + url));
  };
  win.localStorage = { length: 0, key: () => null, getItem: () => null };
  win.console = console;

  /* customer-messages.js self-fetches on DOM ready; the pages that carry stock
     rules have it claimed instead. Both paths are exercised below. */
  const listeners = {};
  global.document = {
    readyState: opts.domLoading ? 'loading' : 'complete',
    addEventListener: (ev, fn) => { listeners[ev] = fn; },
  };

  new Function('window', 'fetch', 'document', fs.readFileSync(ROOT + 'customer-messages.js', 'utf8'))
    (win, win.fetch, global.document);
  if (opts.withStockRules) {
    new Function('window', 'fetch', 'document', fs.readFileSync(ROOT + 'stock-rules.js', 'utf8'))
      (win, win.fetch, global.document);
  }
  return { win, calls, fire: (ev) => listeners[ev] && listeners[ev]() };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

(async () => {
  console.log('\n  an edit reaches the pages that carry stock rules');
  {
    const { win, calls } = browser({ soldOut: 'Gone for now' }, { withStockRules: true });
    ok('the shipped copy answers before the network does',
      win.ZWMessages.get('soldOut') === 'Out of stock');
    await settle();
    ok('…and the edit replaces it once it lands',
      win.ZWMessages.get('soldOut') === 'Gone for now', win.ZWMessages.get('soldOut'));
    /* THE bug: nothing asked. stock-rules.js loads on these pages but load()
       was only ever CALLED by the bag. */
    ok('…because something actually asked for it', calls.stock === 1, 'fetches: ' + calls.stock);
  }

  console.log('\n  and the pages that do not');
  {
    /* The login modal is on About, Journal, Policies — pages with no reason to
       load stock rules at all. An edit applying on the shop and not there looks
       like it half-worked, which is worse than not applying. */
    const { win, calls, fire } = browser({ authBadCredentials: 'Wrong, sorry.' }, { domLoading: true });
    fire('DOMContentLoaded');
    await settle();
    ok('the module fetches for itself when nothing else will',
      win.ZWMessages.get('authBadCredentials') === 'Wrong, sorry.');
    ok('…exactly once', calls.stock === 1, 'fetches: ' + calls.stock);
  }

  console.log('\n  one page, one request');
  {
    const { calls, fire } = browser({}, { withStockRules: true, domLoading: true });
    fire('DOMContentLoaded');
    await settle();
    ok('stock-rules.js having claimed it prevents a second fetch',
      calls.stock === 1, 'fetches: ' + calls.stock);
  }

  console.log('\n  a surface is told when the wording changes');
  {
    const { win } = browser({ lowStock: 'Just {count} to go' }, { withStockRules: true });
    let repaints = 0;
    win.ZWMessages.subscribe(() => { repaints += 1; });
    await settle();
    /* Arriving is not enough. The product page has already drawn its stock line
       by now, so it has to be told to draw it again. */
    ok('subscribers hear about it', repaints === 1, 'repaints: ' + repaints);
    ok('…and get the new wording, filled in',
      win.ZWMessages.get('lowStock', { count: 3 }) === 'Just 3 to go');
  }

  console.log('\n  the browser and the payment path agree after an edit');
  {
    /* The one that matters most: a shopper is shown a message on the product
       page and REFUSED with one at checkout. If an edit moved only one of them,
       the store would be back to two answers — which is the entire fault this
       system exists to remove. */
    const edit = { soldOutItem: '{title} in {size} has gone' };
    const { win } = browser(edit, { withStockRules: true });
    await settle();

    const { messagesFrom } = await import(
      require('url').pathToFileURL(ROOT + 'functions/api/_messages.js').href);
    const say = messagesFrom({ customerExperience: { messages: edit } });

    const vars = { title: 'Aero Pro', size: 'M' };
    ok('the browser uses the edit', win.ZWMessages.get('soldOutItem', vars) === 'Aero Pro in M has gone');
    ok('…and so does the server', say('soldOutItem', vars) === 'Aero Pro in M has gone');
    ok('…word for word',
      win.ZWMessages.get('soldOutItem', vars) === say('soldOutItem', vars));

    /* And with NO edit, the two shipped defaults must already match, or the
       first edit would silently "fix" a difference nobody knew was there. */
    const plain = messagesFrom(null);
    const { win: win2 } = browser({}, { withStockRules: true });
    await settle();
    ok('unedited, they already said the same thing',
      win2.ZWMessages.get('soldOutItem', vars) === plain('soldOutItem', vars),
      JSON.stringify(win2.ZWMessages.get('soldOutItem', vars)) + ' vs ' + JSON.stringify(plain('soldOutItem', vars)));
  }

  console.log('\n  nothing an admin can save leaves a shopper with silence');
  {
    const { win } = browser({
      soldOut: '   ',                       // cleared
      lowStock: 'Only {nonsense} left',     // token that cannot be filled
      restockFailed: { text: '', color: 'not-a-colour' },
    }, { withStockRules: true });
    await settle();
    ok('a cleared message falls back to the shipped copy',
      win.ZWMessages.get('soldOut') === 'Out of stock');
    ok('a bad placeholder is refused, not rendered raw',
      win.ZWMessages.get('lowStock', { count: 2 }) === 'Only 2 left in stock');
    ok('a bad colour does not take the message with it',
      win.ZWMessages.get('restockFailed') === 'Could not save that — try again.');

    const say = (await import(
      require('url').pathToFileURL(ROOT + 'functions/api/_messages.js').href))
      .messagesFrom({ customerExperience: { messages: { soldOutItem: '  ' } } });
    ok('and the payment path refuses to be blanked either',
      say('soldOutItem', { title: 'Aero Pro', size: 'M' }) === 'Aero Pro (M) is out of stock');
  }

  console.log('\n  the network failing does not empty the shop');
  {
    const win = {};
    win.localStorage = { length: 0, key: () => null, getItem: () => null };
    win.fetch = () => Promise.reject(new Error('offline'));
    global.document = { readyState: 'complete', addEventListener: () => {} };
    new Function('window', 'fetch', 'document', fs.readFileSync(ROOT + 'customer-messages.js', 'utf8'))
      (win, win.fetch, global.document);
    await settle();
    ok('every message still answers', win.ZWMessages.keys().every((k) => win.ZWMessages.get(k, {
      count: 2, size: 'M', title: 'Aero Pro', label: 'WELCOME',
    }).trim().length > 0));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
