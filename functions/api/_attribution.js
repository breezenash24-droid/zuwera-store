/**
 * _attribution.js — where an order came from, carried from the landing page to
 * the order row without anything in between deciding it knows better.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Nothing recorded it. `utm_*` and `gclid` appeared nowhere in the codebase;
 * `fbclid` appeared once, in meta-pixel.js, read to build the pixel's `_fbc`
 * cookie and then dropped. So every order was anonymous as to which ad, email
 * or post produced it — and unlike almost every other gap in this system, that
 * one cannot be repaired later. A click id exists for the length of one page
 * load. There is no backfill, no export, no support ticket that recovers it.
 * The same argument as `delivered_at` in 0015, which cost 61 orders.
 *
 * It is not only about reports. `_capi.js buildUserData()` already accepts
 * `fbp` and `fbc` and passes them to Meta raw — but `_fulfil.js` was calling it
 * with hashed PII only, so the server-side Purchase built specifically to land
 * when the browser blocked the pixel was matching on email alone. The click ids
 * this file carries are the same ids that event wants, so capturing them once
 * serves both.
 *
 * ── WHAT IS AND IS NOT TRUSTED ──────────────────────────────────────────────
 *
 * All of this is client-reported and none of it is verifiable. That is fine,
 * and it is worth being explicit about why: attribution is not money. Nothing
 * downstream prices, discounts, ships or refunds based on a value in here. The
 * worst a forged `utm_source` achieves is a wrong row in a report.
 *
 * So the sanitising below is not a trust boundary — it is a SIZE and SHAPE
 * boundary, and it has three real jobs:
 *
 *   1. Stripe caps a metadata value at 500 characters and rejects the whole
 *      PaymentIntent over one long one. An unbounded field here would fail the
 *      payment, which turns a reporting nicety into a checkout outage.
 *   2. These strings reach a jsonb column and, from there, admin screens.
 *      Control characters and unbounded length are how a reporting field
 *      becomes a rendering bug.
 *   3. An unknown key is dropped rather than stored. A visitor appending
 *      `?anything=…` should not be able to grow the row.
 *
 * ── COMPACT ON THE WIRE, READABLE IN THE DATABASE ───────────────────────────
 *
 * Two representations, and the pair of functions that convert between them:
 *
 *   toMeta()    → short keys, one string, ≤480 chars, for Stripe metadata.
 *   fromMeta()  → full keys, nested object, for the jsonb column.
 *
 * The short keys exist only because of Stripe's cap. Storing them in Postgres
 * would mean every future query reading `attribution->'first'->>'so'`, and a
 * column nobody can read without a decoder ring stops being used. They are
 * inverses, which is a property a test can hold them to rather than take on
 * trust.
 */

/* Ordered by what gets dropped LAST when the compact form will not fit. The
   click ids and the three core utm fields survive longest because they are the
   ones that identify a campaign; term/content refine a campaign already
   identified, and referrer/landing are context. */
const FIELDS = [
  ['utm_source',   'so', 120],
  ['utm_medium',   'me', 120],
  ['utm_campaign', 'ca', 120],
  ['gclid',        'gc', 200],
  ['fbclid',       'fc', 200],
  ['msclkid',      'mc', 200],
  ['ttclid',       'tc', 200],
  ['utm_term',     'te', 120],
  ['utm_content',  'co', 120],
  ['referrer',     'rf', 120],
  ['landing',      'lp', 120],
];

/* Dropped in this order when over budget, least valuable first. `ts` is not in
   FIELDS because it is a number and never truncated — it is dropped whole. */
const TRIM_ORDER = ['landing', 'referrer', 'utm_content', 'utm_term'];

/* Stripe's limit is 500. The margin covers the key name and the surrounding
   object, and leaves room for a field being added here without this becoming a
   payment failure discovered in production. */
export const META_BUDGET = 480;

const SHORT_OF = new Map(FIELDS.map(([full, short]) => [full, short]));
const FULL_OF  = new Map(FIELDS.map(([full, short]) => [short, full]));
const CAP_OF   = new Map(FIELDS.map(([full, , cap]) => [full, cap]));

/** One string, trimmed, control characters removed, capped. '' for anything unusable. */
function clean(value, cap) {
  if (value == null) return '';
  if (typeof value === 'object') return '';
  // eslint-disable-next-line no-control-regex
  return String(value).replace(new RegExp("[\\u0000-\\u001f\\u007f]", "g"), ' ').trim().slice(0, cap);
}

/**
 * One touch (first or last) → a clean object with FULL key names, or null when
 * nothing survived. Unknown keys are dropped, never stored.
 */
export function sanitizeTouch(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const [full] of FIELDS) {
    const v = clean(input[full], CAP_OF.get(full));
    if (v) out[full] = v;
  }
  const ts = Number(input.ts);
  /* A timestamp is only kept when it is plausible. A browser with a wrong clock
     — or a hand-written value — would otherwise put an order's first touch in
     1970 or 2087 and quietly ruin any cohort built on it. */
  if (Number.isFinite(ts) && ts > 1577836800000 && ts < Date.now() + 86400000) out.ts = Math.round(ts);

  return Object.keys(out).length ? out : null;
}

/**
 * The whole thing the browser sent → { first, last } with full key names, or
 * null. `last` is omitted when it is identical to `first`, which is the common
 * case (one visit, one campaign) and is where most of the size saving comes
 * from.
 */
export function sanitizeAttribution(input) {
  if (!input || typeof input !== 'object') return null;
  const first = sanitizeTouch(input.first);
  const last  = sanitizeTouch(input.last);
  if (!first && !last) return null;

  const out = {};
  if (first) out.first = first;
  if (last && (!first || !sameTouch(first, last))) out.last = last;
  return Object.keys(out).length ? out : null;
}

function sameTouch(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete('ts');                       // a second visit to the same ad is the same touch
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * → the string that goes in Stripe metadata. '' when there is nothing to say,
 * so the caller can leave the key out entirely rather than store "null".
 *
 * Over budget, fields are dropped in TRIM_ORDER from `last` before `first`:
 * losing detail about the visit that closed is preferable to losing the visit
 * that started it, because first touch is the one no other system records.
 */
export function attributionToMeta(attr) {
  const clean = sanitizeAttribution(attr);
  if (!clean) return '';

  const build = (dropFromLast, dropFromFirst, dropTs, omitLast) => {
    const pack = (touch, drop) => {
      if (!touch) return null;
      const o = {};
      for (const [full, short] of FIELDS) {
        if (drop.includes(full)) continue;
        if (touch[full]) o[short] = touch[full];
      }
      if (!dropTs && touch.ts) o.ts = touch.ts;
      return Object.keys(o).length ? o : null;
    };
    const body = { v: 1 };
    const f = pack(clean.first, dropFromFirst);
    const l = omitLast ? null : pack(clean.last, dropFromLast);
    if (f) body.f = f;
    if (l) body.l = l;
    if (!body.f && !body.l) return '';
    /* Says "last touch was dropped for size", so fromMeta() does not fall back
       to copying first into it. Only set when a `last` genuinely existed. */
    if (omitLast && clean.last && f) body.t = 1;
    return JSON.stringify(body);
  };

  let s = build([], [], false, false);
  for (let i = 1; i <= TRIM_ORDER.length && s.length > META_BUDGET; i++) {
    s = build(TRIM_ORDER.slice(0, i), [], false, false);
  }
  for (let i = 1; i <= TRIM_ORDER.length && s.length > META_BUDGET; i++) {
    s = build(TRIM_ORDER, TRIM_ORDER.slice(0, i), false, false);
  }
  if (s.length > META_BUDGET) s = build(TRIM_ORDER, TRIM_ORDER, true, false);

  /* Both touches stripped to their campaign fields and STILL over. That takes
     two long click ids and a long campaign name at once — unusual, but the
     handling matters because the alternative is returning nothing and losing an
     attributed order entirely.

     Keep FIRST touch, drop last, and mark it: `t:1` says "last was omitted for
     size", so fromMeta() does not do its usual thing of reconstructing last
     from first. That reconstruction is right when the two were identical and a
     lie here — it would claim the sale was closed by the channel that opened
     it, which is precisely the misattribution storing both touches exists to
     avoid. A gap is recoverable by whoever reads the report; a confident wrong
     answer is not. */
  if (s.length > META_BUDGET) s = build(TRIM_ORDER, [], false, true);
  if (s.length > META_BUDGET) s = build(TRIM_ORDER, TRIM_ORDER, true, true);

  /* Nothing fits at all. Empty loses the attribution on this order; a 600-char
     value loses the ORDER, because Stripe rejects the whole PaymentIntent. */
  return s.length > META_BUDGET ? '' : s;
}

/**
 * Stripe metadata string → the readable object for the jsonb column. Returns
 * null for anything it cannot parse, so a malformed value writes nothing rather
 * than writing junk.
 */
export function attributionFromMeta(value) {
  if (!value || typeof value !== 'string') return null;
  let parsed;
  try { parsed = JSON.parse(value); } catch (_) { return null; }
  if (!parsed || typeof parsed !== 'object') return null;

  const unpack = (o) => {
    if (!o || typeof o !== 'object') return null;
    const out = {};
    for (const [short, v] of Object.entries(o)) {
      if (short === 'ts') { const n = Number(v); if (Number.isFinite(n)) out.ts = n; continue; }
      const full = FULL_OF.get(short);
      if (full && v) out[full] = String(v);
    }
    return Object.keys(out).length ? out : null;
  };

  const first = unpack(parsed.f);
  const last  = unpack(parsed.l);
  const out = {};
  if (first) out.first = first;
  if (last) out.last = last;
  /* `l` absent normally means last touch WAS first touch — that is what let it
     be omitted on the way in — so rebuilding it keeps the database honest: a
     report reading `attribution->'last'` should not find a hole where a
     single-visit order should be.
     UNLESS `t:1`, which says last was dropped for size and really was
     different. Copying first into it there would claim the sale was closed by
     the channel that opened it. */
  else if (first && parsed.t !== 1) out.last = first;
  if (parsed.t === 1) out.truncated = true;
  return Object.keys(out).length ? out : null;
}

/**
 * The Meta match keys, which travel beside the attribution rather than inside
 * it. They are not campaign data — they identify the BROWSER to Meta, are
 * useless to anyone else, and go straight into `user_data` on the Conversions
 * API rather than into a report. Kept out of the jsonb column for that reason.
 */
export function sanitizeMatchKeys(input) {
  if (!input || typeof input !== 'object') return { fbp: '', fbc: '' };
  return { fbp: clean(input.fbp, 120), fbc: clean(input.fbc, 200) };
}
