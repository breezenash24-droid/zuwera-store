/* ────────────────────────────────────────────────────────────────────────────
   _ratelimit.js — one limiter, for the endpoints anybody can call.

   WHAT WAS THERE. Application-level limiting existed in 5 of 117 endpoint
   files, and none of the five was public. The eleven endpoints a stranger can
   POST to had no limiter, no bot check and no 429 path at all:

       validate-promo   subscribe        popup-claim      product-questions
       guest-return     referral         notify-restock   translate
       log-error        upload-review-photo   create-payment-intent

   That is promo-code enumeration, list bombing, storage and DeepL spend, and an
   unmetered door for card testing. Radar scores the charges that land, but a
   testing run costs per attempt before Radar ever sees it.

   ── TWO LAYERS, BECAUSE THEY FAIL DIFFERENTLY ───────────────────────────────

   MEMORY   A counter in the isolate. Costs nothing, needs no migration, and
            catches the common case — a loop from one address hitting one colo.
            It is not shared between isolates and it is lost when one is
            recycled, so on its own it is a speed bump, not a limit.

   DATABASE An atomic counter behind the `zw_rate_limit` RPC (migration 0029).
            Shared across every colo, survives restarts, and is the one that
            actually holds a distributed or slow-drip abuser.

   Memory is checked first because it is free and rejects the loudest traffic
   without a round trip. The database is asked only for requests that get past
   it, which keeps the added latency off the ordinary path.

   ── FAIL OPEN, BUT NEVER QUIETLY ────────────────────────────────────────────

   If the RPC is missing — the migration has not been run — this allows the
   request and records that it is degraded. Failing closed would mean an
   un-run migration takes the storefront down, and a limiter that can break
   checkout is worse than the abuse it prevents.

   But "fail open" is exactly how a control ends up reporting protection it is
   not providing, so the degraded state is not swallowed: `limiterHealth()`
   reports it and /api/health surfaces it, which is the difference between a
   fallback and a lie. The in-memory layer keeps working either way.

   ── WHAT AN IDENTITY IS ─────────────────────────────────────────────────────

   CF-Connecting-IP, which Cloudflare sets and a client cannot forge — unlike
   X-Forwarded-For, which anybody can send. Where a request carries something
   more specific and more expensive to obtain (an email, an order id), the
   caller passes it as `subject` and it is used instead, so one address cannot
   burn a shared allowance for everybody behind a corporate NAT.
   ──────────────────────────────────────────────────────────────────────────── */

/* Isolate-local counters. Bounded so a hostile spread of keys cannot grow this
   without limit — at the cap the oldest window is dropped, which costs
   precision under attack and never memory. */
const MEM = new Map();
const MEM_MAX = 5000;

let _dbState = 'unknown';   // 'ok' | 'missing' | 'error' | 'unknown'
let _dbDetail = '';

export function limiterHealth() {
  return {
    memory: true,
    database: _dbState,
    detail: _dbDetail,
    /* Said plainly, because "the limiter is on" and "the limiter is durable"
       are different claims and only one of them survives a restart. */
    durable: _dbState === 'ok',
  };
}

function clientIp(request) {
  const h = request && request.headers;
  if (!h) return 'unknown';
  /* CF-Connecting-IP only. X-Real-IP was here as a fallback and is worse than
     nothing: Cloudflare does not set it, so the only way it arrives is from the
     client — and a limiter keyed on a header the abuser chooses gives every
     request its own private allowance. Behind Cloudflare the connecting IP is
     always present; 'unknown' is a real shared bucket, which is the correct
     conservative answer when it is not. */
  return h.get('CF-Connecting-IP') || 'unknown';
}

function memoryCheck(bucket, max, windowSec) {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  let entry = MEM.get(bucket);
  if (!entry || now - entry.start >= windowMs) {
    entry = { start: now, count: 0 };
    if (MEM.size >= MEM_MAX) {
      const oldest = MEM.keys().next();
      if (!oldest.done) MEM.delete(oldest.value);
    }
  }
  entry.count += 1;
  MEM.set(bucket, entry);
  const retryAfter = Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000));
  return { allowed: entry.count <= max, retryAfter, count: entry.count };
}

async function databaseCheck(env, bucket, max, windowSec) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
  if (!env.SUPABASE_URL || !key) {
    _dbState = 'missing';
    _dbDetail = 'Supabase service credentials are not configured';
    return null;
  }
  try {
    const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/zw_rate_limit`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_bucket: bucket, p_max: max, p_window_seconds: windowSec }),
    });
    if (resp.status === 404) {
      _dbState = 'missing';
      _dbDetail = 'zw_rate_limit RPC not found — run migration 0029';
      return null;
    }
    if (!resp.ok) {
      _dbState = 'error';
      _dbDetail = 'HTTP ' + resp.status;
      return null;
    }
    const out = await resp.json().catch(() => null);
    if (!out || typeof out.allowed !== 'boolean') {
      _dbState = 'error';
      _dbDetail = 'unexpected RPC response';
      return null;
    }
    _dbState = 'ok';
    _dbDetail = '';
    return { allowed: out.allowed, retryAfter: Math.max(1, Number(out.retry_after) || windowSec) };
  } catch (e) {
    _dbState = 'error';
    _dbDetail = (e && e.message) || 'network error';
    return null;
  }
}

function tooMany(retryAfter, headers, message) {
  return new Response(JSON.stringify({
    error: message || 'Too many requests. Please wait a moment and try again.',
    retryAfter,
  }), {
    status: 429,
    headers: {
      ...(headers || {}),
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfter),
    },
  });
}

/**
 * Check one request against one allowance.
 *
 * Returns `null` when the request may proceed, or a ready-made 429 Response
 * when it may not — so a handler reads:
 *
 *     const limited = await enforce(env, request, { name: 'subscribe', max: 5, windowSec: 600 }, headers);
 *     if (limited) return limited;
 *
 * A caller that forgets the `if` gets no protection, which is why this returns
 * a response to send rather than a boolean to interpret: the shape makes the
 * omission visible in review.
 */
export async function enforce(env, request, opts = {}, headers = null) {
  const name = String(opts.name || 'unnamed');
  const max = Math.max(1, Number(opts.max) || 30);
  const windowSec = Math.max(1, Number(opts.windowSec) || 60);
  const subject = String(opts.subject || clientIp(request)).slice(0, 120);
  const bucket = `${name}:${subject}`;

  const mem = memoryCheck(bucket, max, windowSec);
  if (!mem.allowed) return tooMany(mem.retryAfter, headers, opts.message);

  const db = await databaseCheck(env, bucket, max, windowSec);
  if (db && !db.allowed) return tooMany(db.retryAfter, headers, opts.message);

  return null;
}

/* Named allowances, in one place, so a limit can be reasoned about next to its
   neighbours rather than found eleven times. The numbers are set to be
   invisible to a person and obstructive to a script: nobody subscribes to a
   newsletter five times in ten minutes, and nobody legitimately tries forty
   promo codes in an hour.

   create-payment-intent is the loosest on purpose — a real shopper can
   reasonably retry checkout several times after a declined card, and blocking
   that costs a sale. It is still a hundred times tighter than nothing. */
export const LIMITS = {
  'validate-promo':       { max: 40, windowSec: 3600, message: 'Too many code attempts. Please wait a few minutes.' },
  'subscribe':            { max: 5,  windowSec: 600 },
  'popup-claim':          { max: 5,  windowSec: 600 },
  'product-questions':    { max: 10, windowSec: 3600 },
  'guest-return':         { max: 12, windowSec: 3600 },
  'referral':             { max: 30, windowSec: 3600 },
  'notify-restock':       { max: 10, windowSec: 3600 },
  'translate':            { max: 60, windowSec: 3600 },
  'log-error':            { max: 60, windowSec: 600 },
  'upload-review-photo':  { max: 12, windowSec: 3600 },
  'create-payment-intent':{ max: 20, windowSec: 900,  message: 'Too many checkout attempts. Please wait a moment and try again.' },

  /* Three more that were not in the finding and belong here for the same
     reason. Each is a public write whose cost lands somewhere other than this
     server, which is the kind that goes unnoticed longest.

       shippo-rates   a live carrier quote against a metered free tier
       capi-relay     fabricated conversions poison Meta's optimisation
       csp-report     about to receive far more traffic, because the
                      report-only policy now points at every inline block */
  'shippo-rates':         { max: 40, windowSec: 3600 },
  'capi-relay':           { max: 120, windowSec: 3600 },
  'csp-report':           { max: 60, windowSec: 600 },
};

/** enforce() with the allowance looked up by name. */
export async function limit(env, request, name, headers = null, subject = '') {
  const cfg = LIMITS[name];
  if (!cfg) return null;
  return enforce(env, request, { name, ...cfg, subject }, headers);
}
