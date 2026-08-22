/**
 * _money-secret.js — the factor that admin access alone does not give you.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Refunding money has required REFUND_SECRET — a Cloudflare environment
 * variable, deliberately not a database row and deliberately with no reset
 * button in the panel — for as long as refunds have existed. Issuing a gift
 * card creates the same money out of nothing and required only a permission.
 *
 * So the asymmetry was backwards. Taking money OUT of the store was guarded
 * five ways; putting spendable money INTO the world was guarded two. A refund
 * at least has an order behind it that somebody can point at. A freshly issued
 * code has nothing behind it at all — and the audit log records the amount, not
 * the code, so a stolen session can write itself five thousand dollars and the
 * record of it cannot even say which card to cancel.
 *
 * ── THE SAME SECRET, NOT A SECOND ONE ───────────────────────────────────────
 *
 * A new ISSUE_SECRET would be one more thing to set, and an unset one either
 * fails closed (breaking issuing on every store that upgrades) or fails open
 * (which is the hole again, wearing a config file). REFUND_SECRET already means
 * exactly the right thing: this action moves money and being an admin is not
 * enough. One secret, two doors.
 *
 * ── AND IT FAILS CLOSED ─────────────────────────────────────────────────────
 *
 * No secret configured means no issuing. That is a deliberate outage rather
 * than a quiet downgrade: a store that has not set it has not decided anything
 * about who may mint money, and the safe reading of "undecided" is "nobody".
 *
 * ── ADOPTION ────────────────────────────────────────────────────────────────
 *
 * admin-refund.js still carries its own copy of this logic and is NOT yet
 * changed to call here. That is a sequencing decision, not an oversight: it is
 * the most sensitive endpoint in the codebase, its version works, and rewriting
 * its authentication path without being able to exercise a real refund would be
 * trading a known-good implementation for an untested one. This module is
 * written to be adopted — same settings keys, same lockout arithmetic, same
 * audit shape — and the next person to touch that file with a way to test it
 * should collapse the two.
 */

import { getSetting, setSetting } from './_commerce.js';

const MAX_BAD = 5;
const WINDOW_MS = 10 * 60 * 1000;
const LOCKOUT_MS = 60 * 60 * 1000;

/**
 * Check the shared secret, metered.
 *
 * Returns `{ ok: true }`, or `{ ok: false, status, error }` ready to answer
 * with. Never throws: a settings read that fails must not become a 500 on the
 * one endpoint somebody is using to sort out a customer's money.
 *
 * @param {string} key the key the caller supplied
 * @param {string} rateLimitKey which settings row counts the attempts
 */
export async function checkMoneySecret(env, { key, adminId, rateLimitKey }) {
  const expected = env.REFUND_SECRET;
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: 'This action needs REFUND_SECRET set in your Cloudflare environment variables. '
        + 'It is the factor that admin access alone does not give you, and issuing money is not allowed without it.',
    };
  }

  const who = String(adminId || 'unknown');
  let all = {};
  try { all = await getSetting(env, rateLimitKey, {}) || {}; } catch (_) { all = {}; }
  const entry = all[who] || { attempts: 0, windowStart: 0, lockedUntil: 0 };
  const now = Date.now();

  if (entry.lockedUntil && now < entry.lockedUntil) {
    const mins = Math.ceil((entry.lockedUntil - now) / 60000);
    return {
      ok: false, status: 429, locked: true,
      error: `Too many failed attempts. This is locked for ${mins} more minute${mins !== 1 ? 's' : ''}.`,
    };
  }

  /* Length-independent compare. Not a password — a shared secret in an env var
     — but an early return that leaks the length is free to avoid. */
  const given = String(key || '');
  let same = given.length === expected.length;
  for (let i = 0; i < Math.max(given.length, expected.length); i += 1) {
    if (given.charCodeAt(i) !== expected.charCodeAt(i)) same = false;
  }

  if (!same) {
    const inWindow = now - (entry.windowStart || 0) < WINDOW_MS;
    const attempts = inWindow ? (entry.attempts || 0) + 1 : 1;
    const windowStart = inWindow ? (entry.windowStart || now) : now;
    const justLocked = attempts >= MAX_BAD;
    try {
      await setSetting(env, rateLimitKey, {
        ...all,
        [who]: { attempts, windowStart, lockedUntil: justLocked ? now + LOCKOUT_MS : (entry.lockedUntil || 0) },
      });
    } catch (_) { /* a counter that cannot be written must not open the door */ }
    const left = MAX_BAD - attempts;
    return {
      ok: false, status: 403, justLocked,
      error: left <= 0
        ? 'Incorrect code. This is locked for 1 hour.'
        : `Incorrect authorization code. ${left} attempt${left !== 1 ? 's' : ''} remaining before lockout.`,
    };
  }

  if ((entry.attempts || 0) > 0) {
    try {
      await setSetting(env, rateLimitKey, { ...all, [who]: { attempts: 0, windowStart: 0, lockedUntil: 0 } });
    } catch (_) { /* cosmetic */ }
  }
  return { ok: true };
}

/**
 * How much this admin has already issued today, and whether one more is allowed.
 *
 * ── WHY AN AGGREGATE AND NOT JUST A PER-CALL CAP ────────────────────────────
 *
 * The per-call cap is $5,000, and it stops a mistyped amount. It does nothing
 * about a hundred calls of $4,999, because nothing was counting them. A ceiling
 * that resets on every request is not a ceiling.
 *
 * Per admin, per UTC day. Not per store: the point is to bound what ONE
 * compromised session can do before anybody notices, and a shared budget lets
 * the busiest person's ordinary work mask somebody else's theft.
 *
 * Read-modify-write through mutateSetting so two issues at once cannot both see
 * the same total and both be allowed — the same lost-update race this codebase
 * has now fixed in promo counts, stock, and the stored-value balance itself.
 */
export const ISSUE_LEDGER_KEY = 'stored_value_issue_ledger';
export const DEFAULT_DAILY_CAP_CENTS = 200000;   // $2,000

export function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function dailyCapCents(cfg) {
  const n = Math.round(Number(cfg && cfg.dailyIssueCapCents));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_CAP_CENTS;
}

/** Trim anything not from today. The ledger is a guard rail, not a record. */
export function pruneLedger(ledger, day) {
  const out = {};
  for (const [k, v] of Object.entries(ledger || {})) {
    if (v && v.day === day) out[k] = v;
  }
  return out;
}
