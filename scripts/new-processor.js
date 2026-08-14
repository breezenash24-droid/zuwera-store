#!/usr/bin/env node
/**
 * new-processor.js — scaffold a payment processor.
 *
 *   node scripts/new-processor.js square "Square"
 *
 * Writes the adapter, the two routes and a test stub, then tells you the three
 * things it deliberately did NOT do. It is a dev-time tool: it produces files
 * you read, edit and commit.
 *
 * ── WHY THERE IS NO TOKEN ON THIS ───────────────────────────────────────────
 *
 * The obvious instinct is to gate it, and it is the wrong instinct: the danger
 * is the code that ends up in the repository, not the act of writing it. A
 * token here would protect a template from being copied while doing nothing
 * about what the template becomes.
 *
 * The thing that DOES need gating is switching a processor on for real
 * shoppers, and that is already gated — commerce_config.payments.<id>.enabled,
 * behind an authenticated admin. See functions/api/payment-methods.js.
 *
 * ── AND WHY A PROCESSOR CANNOT BE DEFINED AT RUNTIME ────────────────────────
 *
 * A tempting version of "make it easy" is a settings screen where somebody
 * types an API base URL and some field names and a new processor exists. Do not
 * build that. It means the endpoint a REFUND is sent to lives in a database row
 * that an admin session can edit — so anyone who reaches the panel can point
 * your refunds at a server they own, and the money leaves looking exactly like
 * a normal refund.
 *
 * The split this repo uses instead:
 *   CODE   how to talk to a processor          reviewed, committed, deployed
 *   CONFIG whether it is on, and its keys      runtime, gated, no protocol in it
 *
 * This script makes the code half cheap. It does not make it runtime.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const id = String(process.argv[2] || '').trim().toLowerCase();
const label = String(process.argv[3] || '').trim() || (id ? id[0].toUpperCase() + id.slice(1) : '');

if (!/^[a-z][a-z0-9_]{1,20}$/.test(id)) {
  console.error('\n  usage: node scripts/new-processor.js <id> ["Label"]');
  console.error('  id must be lowercase letters, digits and underscores — it is stored in orders.processor.\n');
  process.exit(1);
}

const UPPER = id.toUpperCase();
const files = [];
const skipped = [];

function write(rel, contents) {
  const full = path.join(ROOT, rel);
  if (fs.existsSync(full)) { skipped.push(rel); return; }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents, 'utf8');
  files.push(rel);
}

/* ── The adapter ─────────────────────────────────────────────────────────── */
write(`functions/api/_${id}.js`, `/**
 * _${id}.js — talking to ${label}, and nothing else.
 *
 * Credentials live in the environment, never in site_settings. A settings row
 * is readable by anything holding an admin session and rides in database
 * backups; a client secret in one is a credential in the database. The admin
 * panel gets to choose WHETHER ${label} is offered. It never gets to hold the key.
 *
 * Env: ${UPPER}_CLIENT_ID, ${UPPER}_CLIENT_SECRET, ${UPPER}_ENV
 *
 * ${UPPER}_ENV must default to the SANDBOX. A variable that is missing,
 * misspelled, or dropped during a migration must not silently start taking real
 * money — see _paypal.js, which is the worked example for all of this.
 */

const HOSTS = {
  sandbox: 'https://sandbox.example.${id}.com',   // TODO: real sandbox host
  live:    'https://api.example.${id}.com',       // TODO: real live host
};

export function ${id}Config(env) {
  const mode = String(env.${UPPER}_ENV || '').trim().toLowerCase() === 'live' ? 'live' : 'sandbox';
  const clientId = String(env.${UPPER}_CLIENT_ID || '').trim();
  const secret = String(env.${UPPER}_CLIENT_SECRET || '').trim();
  return { mode, clientId, secret, host: HOSTS[mode], configured: Boolean(clientId && secret) };
}

/**
 * TODO: authenticate and call ${label}.
 *
 * Return { ok, status, data } rather than throwing on a 4xx — the error BODY is
 * the useful part, and a declined card and a malformed request arrive as the
 * same status class with only the body to separate them.
 */
export async function ${id}Fetch(env, path, { method = 'GET', body, requestId } = {}) {
  throw new Error('${id}Fetch is not implemented yet.');
}

/* Money is held in cents everywhere else in this codebase. Convert ONCE, at the
   boundary, or a rounding error becomes a rejected order nobody can trace. */
export function centsToAmount(cents) {
  return (Math.round(Number(cents) || 0) / 100).toFixed(2);
}
`);

/* ── The registry entry ──────────────────────────────────────────────────── */
write(`functions/api/_processor-${id}.js`, `/**
 * _processor-${id}.js — the refund half of ${label}.
 *
 * Implements the interface documented at the top of _processors.js. Register it
 * there; nothing else should ever need to know the name "${id}".
 *
 * READ _processors.js FIRST. Two rules in it are not obvious and both cost
 * money when broken:
 *
 *   known:false means "cannot establish", and it must NEVER be spelled as a
 *   zero. A zero reads as "nothing refunded yet" and permits a second refund on
 *   top of a first.
 *
 *   amountCents 0 or absent means refund everything, and it should be expressed
 *   as "no amount" to the processor where that is supported — sending your own
 *   total invites a cent of disagreement on the one refund that must be exact.
 */

import { ${id}Config, ${id}Fetch, centsToAmount } from './_${id}.js';

export const ${id}Processor = {
  id: '${id}',
  label: '${label}',
  available: (env) => ${id}Config(env).configured,

  /* The order column is called stripe_payment_intent_id and holds every
     processor's reference — see migration 0018. Say how to read yours. If you
     store it prefixed (PayPal uses paypal_<id> so it is never mistaken for a
     Stripe one), strip the prefix here. */
  reference: (order) => String((order && order.stripe_payment_intent_id) || ''),

  /**
   * How much has already gone back.
   *
   * ledgerCents / ledgerCount are what THIS panel recorded for the order. Use
   * them if ${label} cannot tell you exactly — reconcilePayPalRefunds in
   * _paypal.js is the worked example of combining the two without trusting
   * either alone.
   */
  async refundedSoFar({ env, reference, ledgerCents, ledgerCount }) {
    // TODO. Until implemented, refuse to claim anything.
    return { refundedCents: 0, chargedCents: 0, count: 0, known: false };
  },

  /** Send money back. Returns { ok, id, amountCents } or { ok:false, error }. */
  async refund({ env, reference, amountCents, reason, idempotencyKey }) {
    return { ok: false, error: '${label} refunds are not implemented yet.' };
  },

  /* Only if this processor predates orders.tax_txn (0019). A new one does not,
     so returning '' is correct and complete. */
  async legacyTaxTransactionId() { return ''; },
};
`);

/* ── The two routes ──────────────────────────────────────────────────────── */
write(`functions/api/${id}-create-order.js`, `/**
 * Cloudflare Pages Function: /api/${id}-create-order
 *
 * THIS ENDPOINT MOVES NO MONEY. It creates something the buyer can approve;
 * capture is a separate file, deliberately, so the half that can charge
 * somebody is reviewed on its own.
 *
 * The browser sends the cart. What it COSTS is settled here by quoteCart(),
 * the same call every other processor makes — that is the whole reason a second
 * processor did not need its own pricing, and why none of them can drift into
 * charging a different number.
 */

import { json } from './_commerce.js';
import { generateOrderNumber, quoteCart, sha256Base64Url } from './_cart-pricing.js';
import { ${id}Config, centsToAmount } from './_${id}.js';

const CORS = (env) => ({
  'Access-Control-Allow-Origin': env.SITE_URL || 'https://zuwera.store',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
});

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: CORS(env) });
}

export async function onRequestPost({ request, env, waitUntil }) {
  const headers = CORS(env);
  try {
    const cfg = ${id}Config(env);
    /* 503, not 500: being switched off is a true statement about what this
       store offers, not a fault. */
    if (!cfg.configured) return json({ error: '${label} is not available.' }, 503, headers);

    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'Invalid request body.' }, 400, headers);

    const { items, address = {}, shippingRate, promoCode = '', deliveryMethod = '' } = body;
    if (!items?.length || !address?.email) {
      return json({ error: 'Missing required fields: items and address.email' }, 400, headers);
    }

    const quote = await quoteCart({
      waitUntil, items, address, shippingRate, promoCode, deliveryMethod,
      accessToken: body.accessToken || request.headers.get('Authorization')?.replace(/^Bearer\\s+/i, ''),
      env, request,
    });
    if (quote.totalCents <= 0) return json({ error: 'Invalid payment amount.' }, 400, headers);

    const orderNumber = generateOrderNumber();

    // TODO: create the order with ${label} and return its id.
    return json({ error: '${label} is not implemented yet.' }, 501, headers);
  } catch (e) {
    /* Only a status this file deliberately attached is trusted. A sold-out size
       stays 409; anything unpredicted stays 500 rather than being dressed up as
       the shopper's fault. */
    const status = Number.isInteger(e?.zwStatus) ? e.zwStatus : 500;
    console.error('${id}-create-order error (' + status + '):', e);
    return json({ error: e.message || 'Could not start that payment.' }, status, headers);
  }
}
`);

write(`functions/api/${id}-capture.js`, `/**
 * Cloudflare Pages Function: /api/${id}-capture
 *
 * The half that moves money. Read paypal-capture.js before writing this — it is
 * the worked example and every guard in it exists because of a specific way
 * this goes wrong.
 *
 * THE FOUR THINGS THIS FILE MUST DO:
 *
 *  1. Re-price the cart from the catalog. The browser's numbers are ignored.
 *  2. Compare that total against what the processor is holding an approval for,
 *     and REFUSE if they differ. Capturing first and reconciling after means a
 *     customer paid an amount nobody intended, and the fix is a refund they did
 *     not ask for.
 *  3. Claim the payment before fulfilling it — processed_events keyed on the
 *     processor's id, so two racing requests cannot both fulfil. The primary key
 *     IS the claim. Release the claim if no money moved, or a retry with a
 *     working card is refused as a duplicate.
 *  4. Set meta.payment_provider = '${id}' so the order records who took it
 *     (0018) and a refund can find its way back.
 *
 * Nothing may throw its way out AFTER money has moved. An order that is paid
 * for and not recorded is the worst state available, so fulfilment failures are
 * logged loudly and the buyer is still told they succeeded.
 */

import { json } from './_commerce.js';
import { buildOrderMetadata, cartError, quoteCart, sha256Base64Url } from './_cart-pricing.js';
import { ${id}Config } from './_${id}.js';
import { handleSuccessfulPayment, getSupabaseServiceKey } from './_fulfil.js';

const CORS = (env) => ({
  'Access-Control-Allow-Origin': env.SITE_URL || 'https://zuwera.store',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
});

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: CORS(env) });
}

export async function onRequestPost({ request, env, waitUntil }) {
  const headers = CORS(env);
  try {
    const cfg = ${id}Config(env);
    if (!cfg.configured) return json({ error: '${label} is not available.' }, 503, headers);

    // TODO: see the four steps above. Do not ship this returning 501.
    return json({ error: '${label} capture is not implemented yet.' }, 501, headers);
  } catch (e) {
    const status = Number.isInteger(e?.zwStatus) ? e.zwStatus : 500;
    console.error('${id}-capture error (' + status + '):', e);
    return json({ error: e.message || 'Could not complete that payment.' }, status, headers);
  }
}

export { cartError };
`);

/* ── The test ────────────────────────────────────────────────────────────── */
write(`tests/${id}-processor.test.js`, `/* ${label}, before it can take a single order.
 *
 * Generated by scripts/new-processor.js. The checks below are the ones that
 * apply to ANY processor — every one of them exists because of a specific way
 * this has gone wrong here before. Add behaviour tests as you implement, and
 * read tests/paypal-refund.test.js for what those should look like: RUN the
 * decisions, do not regex the source. A regex over money code passed here once
 * with the guard deleted.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

(async () => {
  const CFG = await import(pathToFileURL(ROOT + '/functions/api/_${id}.js').href);
  const P = await import(pathToFileURL(ROOT + '/functions/api/_processor-${id}.js').href);
  const REG = fs.readFileSync(path.join(ROOT, 'functions/api/_processors.js'), 'utf8');

  console.log('\\n  ${label}\\n');

  console.log('  sandbox is the default, and stays it');
  {
    /* A variable that is missing, misspelled or lost in a migration must not
       silently start taking real money. */
    ok('nothing set → sandbox', CFG.${id}Config({}).mode === 'sandbox');
    ok('anything that is not exactly "live" → sandbox',
      CFG.${id}Config({ ${UPPER}_ENV: 'production' }).mode === 'sandbox');
    ok('"live" is honoured, trimmed and lowercased',
      CFG.${id}Config({ ${UPPER}_ENV: ' LIVE ' }).mode === 'live');
    ok('an id without a secret is not configured',
      CFG.${id}Config({ ${UPPER}_CLIENT_ID: 'x' }).configured === false);
  }

  console.log('\\n  it refuses rather than guesses');
  {
    const p = P.${id}Processor;
    const state = await p.refundedSoFar({ env: {}, reference: 'x', ledgerCents: 0, ledgerCount: 0 });
    /* THE RULE THAT COSTS MONEY WHEN BROKEN. An unimplemented or failed read
       must report known:false. A zero reads as "nothing refunded yet" and
       permits a second refund on top of a first. */
    ok('an unestablished refund history is known:false', state.known === false,
      'a zero here permits a double refund');
    const r = await p.refund({ env: {}, reference: 'x', amountCents: 100 });
    ok('an unimplemented refund fails loudly', r.ok === false && !!r.error);
  }

  console.log('\\n  registered');
  {
    ok('it is in the registry', new RegExp("${id}: ").test(REG),
      'add ${id}Processor to PROCESSORS in _processors.js');
    ok('the id matches orders.processor', P.${id}Processor.id === '${id}');
    ok('it has a human label', typeof P.${id}Processor.label === 'string' && P.${id}Processor.label.length > 0);
  }

  console.log('\\n  ' + pass + ' passed, ' + fail + ' failed\\n');
  process.exit(fail ? 1 : 0);
})();
`);

console.log('\n  scaffolded ' + label + ' (' + id + ')\n');
files.forEach((f) => console.log('    + ' + f));
skipped.forEach((f) => console.log('    · ' + f + '  (exists — left alone)'));

console.log(`
  THREE THINGS THIS DID NOT DO, on purpose:

  1. Register it. Add to functions/api/_processors.js:

         import { ${id}Processor } from './_processor-${id}.js';
         export const PROCESSORS = { stripe: …, paypal: …, ${id}: ${id}Processor };

     Left to you because importing a half-written adapter into the table that
     admin-refund reads is how an unfinished processor starts being offered.

  2. Enable it. That is runtime config, not code:
     commerce_config.payments.${id}.enabled, behind an authenticated admin.
     Credentials go in Cloudflare as ${UPPER}_CLIENT_ID / ${UPPER}_CLIENT_SECRET —
     never in site_settings, which any admin session can read and which rides in
     database backups.

  3. Implement anything. Every TODO returns 501 or known:false, so a
     half-finished processor refuses rather than half-works.

  Read functions/api/paypal-capture.js before writing the capture route. Its
  guards are not ceremony — each one is a specific way this goes wrong.
`);
