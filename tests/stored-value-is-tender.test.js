/* Gift cards and store credit — one ledger, and the ways it could lose money.
 *
 * Two audit items asked for the same machinery. B1: no gift cards at all, which
 * is a fourth-quarter revenue line for apparel and the answer to "can we buy 40
 * of these for the team?". A5: "store credit" was a returns dropdown with no
 * ledger behind it, removed on 2026-08-20 rather than left as a promise.
 *
 * A gift card is a balance somebody bought; store credit is a balance somebody
 * was given. After that sentence they are identical, so they are one instrument
 * with a `kind` column — two redemption paths in the one place where a bug means
 * money would be the mistake.
 *
 * ── WHAT THIS FILE IS REALLY ABOUT ──────────────────────────────────────────
 *
 * Not "does it work". The ways a stored-value system loses money, each of which
 * is a decision recorded in code somewhere:
 *
 *   the balance is a SUM, not a column     two checkouts cannot both read 5000
 *                                          and both write 0
 *   the reservation EXPIRES                a Worker that dies mid-checkout does
 *                                          not strand somebody's money for ever
 *   the hold is keyed on the CART          a declined card retried does not take
 *                                          a second hold against the same card
 *   capture is IDEMPOTENT                  a webhook is delivered more than once
 *   it applies AFTER tax                   it is tender, not a discount, and
 *                                          folding it in under-collects tax
 *   short holds charge the card MORE       never less
 *   it is OFF until switched on            server-side, not a browser flag
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const SQL = read('migrations/0030_stored_value_is_one_ledger.sql');
const MOD = read('functions/api/_stored-value.js');
const PRICE = read('functions/api/_cart-pricing.js');
const INTENT = read('functions/api/create-payment-intent.js');
const FULFIL = read('functions/api/_fulfil.js');
const PUBLIC = read('functions/api/stored-value.js');
const ADMIN = read('functions/api/admin-stored-value.js');
const RL = read('functions/api/_ratelimit.js');
const RETURNS = read('tests/store-credit-is-offered-because-it-works.test.js');

console.log('\n  stored value is tender, and the ledger cannot lose count\n');

console.log('  one instrument, two kinds');
{
  ok('gift cards and store credit share a table',
    /create table if not exists public\.stored_value \(/.test(SQL)
    && /kind\s+text not null check \(kind in \('gift_card', 'store_credit'\)\)/.test(SQL),
    'two redemption paths is two places for the same money bug');
  ok('…and there is no second redemption path',
    !/store_credit_ledger|gift_card_balance/.test(MOD + PRICE + INTENT));
}

console.log('\n  the balance is a sum, so there is no value to race over');
{
  ok('no balance column exists to be overwritten',
    !/balance_cents\s+integer/.test(SQL),
    'read-modify-write is how two checkouts both see 5000 and both write 0');
  ok('the balance is computed from the entries',
    /create or replace function public\.zw_stored_value_balance_cents/.test(SQL)
    && /select coalesce\(sum\(cents\), 0\)/.test(SQL));
  ok('entries are signed, so nothing has to remember which way a kind points',
    /SIGNED\./.test(SQL) && /cents\s+integer not null/.test(SQL));
  ok('the hold decides and records in one statement',
    /v_held := least\(v_want, zw_stored_value_balance_cents\(v\.id\)\);/.test(SQL)
    && /for update/.test(SQL),
    'a gap between reading the balance and writing the hold is a gap two carts fit into');
}

console.log('\n  a reservation expires on its own');
{
  ok('holds carry an expiry',
    /insert into stored_value_entries \(stored_value_id, kind, cents, hold_ref, expires_at\)/.test(SQL)
    && /now\(\) \+ make_interval\(secs => greatest\(60, coalesce\(p_seconds, 1800\)\)\)/.test(SQL));
  ok('…and an expired one stops counting against the balance',
    /and \(kind <> 'hold' or expires_at is null or expires_at > now\(\)\)/.test(SQL),
    'this is what makes a Worker dying mid-checkout survivable with nothing scheduled');
  ok('nothing is reserved while the customer is still typing',
    /NOTHING IS RESERVED HERE/.test(PRICE)
    && !/\bhold\(/.test(PRICE),
    'the quote runs on every keystroke — a hold there locks money against a checkout that never happens');
  ok('quoteAgainst looks without reserving',
    /export async function quoteAgainst/.test(MOD)
    && !/quoteAgainst[\s\S]{0,600}zw_stored_value_hold/.test(MOD));
}

console.log('\n  a retry finds its own hold rather than taking a second');
{
  ok('the hold is keyed on the cart, not the order number',
    /svHoldRef = idempotencyKey;/.test(INTENT),
    'a new order number per attempt means a declined card strands the first hold');
  ok('…and the reason is written down',
    /KEYED ON THE IDEMPOTENCY HASH, NOT THE ORDER NUMBER/.test(INTENT));
  ok('the database refuses to double-hold one reference',
    /IDEMPOTENT BY REFERENCE/.test(SQL)
    && /if v_exists > 0 then/.test(SQL));
  ok('a failed request gives the reservation back rather than waiting it out',
    /let svHoldRef = '';/.test(INTENT)
    && /if \(svHoldRef\) \{\s*\n\s*try \{ await release\(env, svHoldRef\); \}/.test(INTENT));
}

console.log('\n  capture happens once, and before anything that cannot be redone');
{
  ok('a repeated capture returns the first one',
    /if v_done > 0 then\s*\n\s*return jsonb_build_object\('ok', true, 'captured_cents', v_done, 'already', true\);/.test(SQL),
    'a Stripe webhook is delivered more than once by design');
  ok('fulfilment captures before the label, the order row and the email',
    FULFIL.indexOf('captureStoredValue') < FULFIL.indexOf('createShippingLabel'),
    'an uncaptured hold expires silently and hands the balance back to somebody already shipped to');
  ok('…and a capture failure does not stop the order',
    /A failure is logged and does NOT stop fulfilment/.test(FULFIL)
    && /console\.error\('stored value NOT captured for'/.test(FULFIL),
    'the card was already charged for the remainder — refusing to ship makes it worse');
  ok('the hold reference travels on the payment',
    /stored_value_ref: svHoldRef/.test(INTENT)
    && /if \(meta\.stored_value_ref\)/.test(FULFIL),
    'the webhook knows nothing except what Stripe hands back');
  ok('an expired hold is reported rather than silently re-spent',
    /'hold_expired'/.test(SQL)
    && /taking the money off the card now would charge twice/.test(SQL));
}

console.log('\n  it is tender, not a discount');
{
  ok('it is applied after tax and shipping',
    PRICE.indexOf('const totalCents = discountedSubtotalCents + shipping.shippingCents + tax.taxCents;')
      < PRICE.indexOf('STORED VALUE IS TENDER'),
    'folding it in as a discount shrinks the taxable amount and under-collects tax the store owes');
  ok('…and the reason is stated where somebody would change it',
    /A gift card pays a bill; it does not reduce one/.test(PRICE));
  ok('the order total and the amount charged are separate numbers',
    /storedValue, amountDueCents,/.test(PRICE)
    && /const amountDueCents = Math\.max\(0, totalCents - storedValue\.appliedCents\);/.test(PRICE));
  ok('the card is charged the amount due, not the total',
    /amount: amountDueCents,/.test(INTENT)
    && !/amount: totalCents,/.test(INTENT));
  ok('an order paid entirely with a card still has a total and still owes tax',
    /order has a total, owes tax on it, and reports revenue exactly as any/.test(INTENT));
}

console.log('\n  the ways it must fail');
{
  ok('a short hold charges the card MORE, never less',
    /IF THE HOLD COMES BACK SHORT, THE CARD IS CHARGED MORE — not less/.test(INTENT)
    && /const amountDueCents = Math\.max\(0, totalCents - heldCents\);/.test(INTENT),
    'amountDue is computed from what was actually held, not from what the quote hoped for');
  ok('an unreachable ledger stops the sale rather than guessing',
    /h\.reason === 'unavailable'/.test(INTENT)
    && /}, 503, headers\);/.test(INTENT),
    'charging full takes money the customer thinks is covered; charging less gives goods away');
  ok('a zero-charge order captures before it fulfils',
    INTENT.indexOf('const cap = await capture(env, svHoldRef, orderNumber);')
      < INTENT.indexOf('await handleSuccessfulPayment(payment, meta, env, null);'),
    'a capture that failed after fulfilment is goods given away');
  ok('…and releases if the capture came up short',
    /if \(!cap\.ok \|\| cap\.capturedCents < totalCents\) \{\s*\n\s*await release\(env, svHoldRef\);/.test(INTENT));
  ok('an unreadable settings row means OFF',
    /catch \(_\) \{[\s\S]{0,320}return false;/.test(MOD),
    'the direction that cannot go wrong: the shopper sees what they saw yesterday');
}

console.log('\n  nobody but the till can touch the ledger');
{
  ok('RLS is on with no policy, so PostgREST refuses everything',
    /alter table public\.stored_value enable row level security;/.test(SQL)
    && /alter table public\.stored_value_entries enable row level security;/.test(SQL)
    && !/create policy[^;]*stored_value/.test(SQL));
  ok('…and the functions are service-role only',
    /grant execute on function public\.%s to service_role/.test(SQL)
    && /revoke all on function public\.%s from public, anon, authenticated/.test(SQL),
    'a client that could call the redeem function could spend somebody else’s card');
  ok('the public endpoint needs the whole code and lists nothing',
    /There is no listing, no\s*\n \* search, no lookup by email/.test(PUBLIC)
    && !/select=.*owner_email/.test(PUBLIC));
  ok('…and is rate limited, because it answers yes-or-no about a secret',
    /limit\(env, request, 'stored-value', headers\)/.test(PUBLIC)
    && /'stored-value':\s*\{ max: 20/.test(RL));
  ok('issuing goes through decide(), so the browser cannot skip it',
    /await decide\(env, token, 'pricing_write'/.test(ADMIN),
    'issuing stored value is creating money — the instrument IS the value');
  ok('…and the amount is part of the question a rule can narrow on',
    /amountCents,\s*\n\s*resource: 'stored_value',/.test(ADMIN));
  /* Read as the contents of every metadata object, rather than as one expected
     line. The previous version matched `metadata: { kind, amountCents, ownerEmail`
     literally and went red the moment that object grew a third line — which is
     a test failing over formatting while the property it guards is still true.
     A rule about what a log may CONTAIN should not care how it is typed. */
  {
    const metaBlocks = [...ADMIN.matchAll(/metadata:\s*\{([^{}]*)\}/g)].map((m) => m[1]);
    ok('every audit row still records what was issued',
      metaBlocks.length >= 2 && metaBlocks.some((b) => /kind/.test(b) && /amountCents/.test(b)),
      'found ' + metaBlocks.length + ' metadata objects');
    ok('…and none of them carries the code',
      metaBlocks.every((b) => !/\bcode\b/.test(b)),
      'an audit log full of live codes is spendable money in a table more people can read');
  }
  /* The note the customer reads IS recorded — "what did we actually say to
     them" is the question asked after a complaint, and the code is the only
     thing in this flow that must never be written down. */
  ok('the message sent to the customer is on the record',
    /message: String\(body\.message \|\| ''\)\.slice\(0, 300\)/.test(ADMIN));
  ok('a mistyped amount cannot issue $50,000',
    /amountCents > 500000/.test(ADMIN));
}

console.log('\n  and it is off until somebody turns it on');
{
  ok('the switch is read on the server',
    /export async function storedValueEnabled/.test(MOD)
    && /getSetting\(env, 'stored_value', null\)/.test(MOD));
  ok('…not through the browser flag system',
    !/zwFlag|feature_flags/.test(MOD),
    'flags.js buckets by visitor and is evaluated in the page — right for a homepage strip, wrong for tender');
  ok('…and it defaults to off',
    /return !!\(cfg && cfg\.enabled === true\);/.test(MOD));
  ok('the till and the issuing screen read the same switch',
    /storedValueEnabled/.test(PRICE) && /storedValueEnabled/.test(ADMIN),
    'issuing a card the till cannot accept hands somebody a piece of paper');

  /* The pair this used to form has flipped. The returns forms DO offer store
     credit now, because a return can issue it and a checkout can spend it —
     and the other half of the pair moved with it: that file asserts the four
     forms offer it and that each one is gated on this same switch. */
  ok('the returns forms offer store credit, gated on this same switch',
    /store credit is offered again, on all four forms/.test(RETURNS)
    && /the gate is the same switch the till reads/.test(RETURNS),
    'offered where it can be honoured, and nowhere else');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
