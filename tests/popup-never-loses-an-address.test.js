/* The one thing this popup exists to do.
 *
 * It asked for an email address, POSTed it once, and if that POST failed the
 * address was gone. Only ever in the input box — so a dropped connection, a
 * 502, or the shopper closing the tab on the error message lost it for good.
 * And there is no second chance: the popup will not ask this browser again, and
 * the person has already done the one thing we wanted them to do.
 *
 * So: written to storage BEFORE the request goes out, retried with backoff,
 * flushed on the next page load and on coming back online, beaconed on the way
 * out of the tab, and cleared only on a confirmed ok.
 *
 * RETRYING IS ONLY ALLOWED BECAUSE THE ENDPOINT IS IDEMPOTENT, which is a
 * property of /api/popup-claim rather than a hope about it: an address already
 * on the list counts as success, a shared promo is created only if absent, and
 * a unique code is a hash of the address. Without that a retry would mint a
 * second coupon, and none of this could exist. That is asserted here too,
 * against the endpoint, because it is the assumption the whole design rests on.
 *
 * The queue functions are lifted out of the module and RUN. Asserting on the
 * source text would pass on code that never worked.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SRC = fs.readFileSync(path.join(ROOT, 'email-popup.js'), 'utf8');

/* The real block, from the queue key to the end of the beacon. */
const START = SRC.indexOf("var QUEUE_KEY = 'zw_popup_pending';");
const END = SRC.indexOf('  try {\n    flushQueue();');
if (START < 0 || END < START) { console.log('  ✗ could not find the queue block in email-popup.js'); process.exit(1); }
const BLOCK = SRC.slice(START, END);

/** A browser with storage, a scriptable fetch, and no real timers. */
function harness({ responses }) {
  const store = {};
  const calls = [];
  let beacons = [];
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const fetchStub = (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body.email);
    const next = responses.shift();
    if (!next) return Promise.reject(new Error('offline'));
    if (next.throw) return Promise.reject(new Error('offline'));
    return Promise.resolve({
      status: next.status || 200,
      json: () => Promise.resolve(next.body || { ok: true }),
    });
  };
  const api = new Function('localStorage', 'fetch', 'navigator', 'setTimeout', 'Promise', 'Blob', 'JSON', 'Date', 'pageKey', `
    ${BLOCK}
    return { readQueue, queueClaim, unqueueClaim, claimOnce, flushQueue, beaconQueue };
  `)(localStorage, fetchStub, { sendBeacon: (u, b) => { beacons.push(String(b)); return true; } },
     (fn) => fn(), Promise, function (parts) { return parts.join(''); }, JSON, Date, () => 'home');

  return { api, store, calls, beacons: () => beacons };
}

console.log('\n  an address typed is an address kept\n');

console.log('  it is written down before it is sent');
{
  const h = harness({ responses: [] });
  h.api.queueClaim('a@b.com');
  const q = h.api.readQueue();
  ok('queueing survives in storage', q.length === 1 && q[0].email === 'a@b.com');
  ok('…with the source, so the admin can see where it came from', q[0].source === 'popup:home');
  ok('…and nothing was sent to do it', h.calls.length === 0,
    'persisting must not depend on the network — that is the whole point');
}

console.log('\n  a failure keeps it, a success releases it');
{
  const h = harness({ responses: [{ throw: true }, { throw: true }, { throw: true }] });
  h.api.queueClaim('lost@b.com');
  return h.api.claimOnce('lost@b.com').then(
    () => { ok('a total outage rejects', false, 'it resolved when every attempt failed'); },
    () => {
      ok('a total outage rejects rather than pretending', true);
      ok('…and the address is still queued', h.api.readQueue().length === 1,
        'this is the case that used to lose it');
      ok('…after three attempts, not one', h.calls.length === 3);
      return rest();
    }
  );
}

function rest() {
  return Promise.resolve()
    .then(() => {
      const h = harness({ responses: [{ throw: true }, { status: 200, body: { ok: true, code: 'X' } }] });
      h.api.queueClaim('flaky@b.com');
      return h.api.claimOnce('flaky@b.com').then((data) => {
        ok('a blip retries and succeeds', data && data.ok === true);
        ok('…in two attempts', h.calls.length === 2);
      });
    })
    .then(() => {
      /* A 4xx is an ANSWER. A malformed address does not become valid by being
         asked about again, and retrying it is three times the load for the same
         refusal. */
      const h = harness({ responses: [{ status: 400, body: { ok: false, error: 'bad' } }] });
      return h.api.claimOnce('nope').then((data) => {
        ok('a 4xx is taken as an answer, not retried', h.calls.length === 1);
        ok('…and reports what the server said', data && data.ok === false);
      });
    })
    .then(() => {
      const h = harness({ responses: [{ status: 502 }, { status: 502 }, { status: 200, body: { ok: true } }] });
      return h.api.claimOnce('five@b.com').then((data) => {
        ok('a 5xx IS retried', h.calls.length === 3 && data && data.ok === true,
          '502 is the shape the server returns when it could not save the address');
      });
    })
    .then(() => {
      const h = harness({ responses: [{ status: 200, body: { ok: true } }] });
      h.api.queueClaim('later@b.com');
      return h.api.flushQueue() || new Promise((r) => setTimeout(r, 0)).then(() => {
        ok('a queued address is sent on the next load', h.calls[0] === 'later@b.com');
        ok('…and cleared once the server confirms it', h.api.readQueue().length === 0);
      });
    })
    .then(() => {
      /* The beacon cannot read a response, so it cannot confirm anything —
         which is exactly why it must NOT clear the queue. The entry is retried
         on the next visit; the endpoint's idempotence makes that a duplicate
         request rather than a duplicate signup. */
      const h = harness({ responses: [] });
      h.api.queueClaim('bye@b.com');
      h.api.beaconQueue();
      ok('leaving the tab beacons what is queued', h.beacons().length === 1);
      ok('…and does NOT clear it, because a beacon confirms nothing',
        h.api.readQueue().length === 1);
    })
    .then(() => {
      const h = harness({ responses: [] });
      for (let i = 0; i < 9; i++) h.api.queueClaim('a' + i + '@b.com');
      ok('the queue is capped', h.api.readQueue().length === 5,
        'a browser that can never reach the server must not grow storage without bound');
      ok('…keeping the newest', h.api.readQueue()[4].email === 'a8@b.com');
    })
    .then(() => {
      console.log('\n  retrying is safe because the endpoint says so');
      const api = fs.readFileSync(path.join(ROOT, 'functions', 'api', 'popup-claim.js'), 'utf8');
      ok('an address already on the list is a success',
        /return true;\s*\/\/ already subscribed/.test(api),
        'if a repeat counted as failure the retry would report an error forever');
      ok('a duplicate insert is a success too', /duplicate\|unique/.test(api));
      ok('a shared promo is only created when absent',
        /if \(!promos\.some\(\(p\) => String\(\(p && p\.code\)/.test(api),
        'otherwise a retry rewrites terms an admin set');
      ok('a unique code is derived from the address, not random',
        /crypto\.subtle\.digest\('SHA-256'/.test(api),
        'a random code would mint a second coupon on every retry — this is the load-bearing one');
      ok('…and it checks before pushing', /already theirs/.test(api));
    })
    .then(() => {
      console.log('\n  submit() actually uses it');
      /* THE MUTATION THAT SURVIVED. Commenting out the queueClaim call in
         submit() left every assertion above green, because they exercise the
         queue directly. A queue nothing enqueues to is an elaborate no-op, and
         it is exactly the wiring that would be dropped in a future edit. */
      /* Comments stripped first. The mutation I used to check this was
         `// queueClaim(email);`, and indexOf found it inside the comment and
         reported the wiring present — the same read-prose-as-code mistake this
         codebase keeps paying for, this time in the test written to catch it. */
      const body = SRC.slice(SRC.indexOf('function submit(e)'), SRC.indexOf('function showDoneOn'))
        .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*$/gm, ' ');
      const enqueue = body.indexOf('queueClaim(email);');
      const send = body.indexOf('claimOnce(email)');
      ok('submit queues the address', enqueue > 0);
      ok('…BEFORE it sends it', enqueue > 0 && send > 0 && enqueue < send,
        'queuing after the request loses the address in exactly the case this exists for');
      ok('…and releases it only on a confirmed ok',
        /!data\.ok\) throw[\s\S]{0,220}?unqueueClaim\(email\);/.test(body),
        'clearing before the check would drop it on a server-side refusal');

      console.log('\n  the shopper is told the truth');
      ok('the error says the address is saved, not lost',
        /Your email is saved and we will finish signing you up/.test(SRC),
        'an error that implies they must retype it invites them to give up');
      ok('the flush runs on load and on coming back online',
        /window\.addEventListener\('online', flushQueue\)/.test(SRC) && /\n    flushQueue\(\);/.test(SRC));
      ok('…and pagehide is used, not unload',
        /addEventListener\('pagehide', beaconQueue\)/.test(SRC) && !/addEventListener\('unload'/.test(SRC),
        'unload does not fire on mobile Safari, where a tab is most likely to be closed mid-request');
    })
    .then(() => {
      console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
      process.exit(fail ? 1 : 0);
    });
}
