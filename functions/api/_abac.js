/* ────────────────────────────────────────────────────────────────────────────
   _abac.js — attribute rules that NARROW what RBAC already granted.

   Deliberately wired to nothing yet. An authorization change is the one kind
   that must not be half-applied, so the decision logic and its tests land
   first, on their own, where they cannot affect a single request. Wiring is a
   separate, reviewable step.

   THE CONTRACT, and everything here exists to keep it true:

       a rule can never widen a grant.

   `can()` takes RBAC's answer as its FIRST argument and returns false whenever
   that answer was false, before it has even looked at the rules. Not a policy
   the rules are trusted to respect — a shape they cannot express. There is no
   ALLOW rule type, so "grant Bob refunds via a rule" is not a thing anyone can
   write and get wrong.

   WHY LAYERED RATHER THAN A MODE. Pure ABAC turns "who can refund?" into a
   search, which is the usual reason it gets abandoned. Here RBAC still gives
   the candidate set by role and the rules only trim it, so the question stays
   two lookups. And a mode switch would be worse than either: flipping ABAC off
   does not fall back to something stricter, it deletes every constraint at
   once, so the "off" position grants more than "on" does.

   FAIL CLOSED. An operator we do not implement, an attribute the resource does
   not carry, a malformed rule — all deny. The alternative is that a typo in a
   rule silently stops constraining anything, which is the failure you notice
   only after it has been exploited.
   ──────────────────────────────────────────────────────────────────────────── */

/* Comparisons are a fixed set, not an expression language. Anything richer is
   a thing to sandbox, and this decides who can refund money. */
const OPS = {
  lt:  (a, b) => num(a) !== null && num(b) !== null && num(a) < num(b),
  lte: (a, b) => num(a) !== null && num(b) !== null && num(a) <= num(b),
  gt:  (a, b) => num(a) !== null && num(b) !== null && num(a) > num(b),
  gte: (a, b) => num(a) !== null && num(b) !== null && num(a) >= num(b),
  eq:  (a, b) => String(a) === String(b),
  neq: (a, b) => String(a) !== String(b),
  in:  (a, b) => Array.isArray(b) && b.map(String).indexOf(String(a)) !== -1,
  nin: (a, b) => Array.isArray(b) && b.map(String).indexOf(String(a)) === -1,
};

function num(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
  return null;
}

/* Attributes are read one level deep by an explicit path, and a MISSING one is
   not the same as a falsy one. `order.total` absent means we cannot evaluate
   "under $100", and guessing costs money — so it denies rather than passing. */
function attr(ctx, path) {
  const parts = String(path || '').split('.');
  let cur = ctx;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Does one rule apply to this action, and does it hold?
 * Returns 'pass' | 'fail' | 'n/a'.
 */
export function checkRule(rule, ctx) {
  if (!rule || typeof rule !== 'object') return 'fail';        // malformed → deny
  if (rule.enabled === false) return 'n/a';
  if (String(rule.action || '') !== String(ctx.action || '')) return 'n/a';
  /* A rule may be scoped to roles. Scoped to none means it applies to every
     role that got this far, which is the safer reading of "unspecified". */
  const roles = Array.isArray(rule.roles) ? rule.roles.map(String) : null;
  if (roles && roles.indexOf(String(attr(ctx, 'subject.role'))) === -1) return 'n/a';

  /* A rule may also name PEOPLE. Roles are the blunt instrument — "managers may
     refund up to $500" — and there is always somebody who needs a different
     number: a new hire on a tighter leash, one person trusted with more. Doing
     that with roles alone means inventing a role per exception, which is how
     role lists become unreadable.

     Matched on id or email, because an admin panel knows people by email and
     the session knows them by id, and requiring the right one would be a
     silent no-match. Same "unspecified means everyone" reading as roles. */
  /* Super admin. Three settings rather than two, because "does this apply to
     the owner" has three honest answers and a checkbox only offers two:
       'apply'  — it binds them like anyone else. The default, because a limit
                  the owner is exempt from is a limit that stops being tested,
                  and because most stores have exactly one admin who IS the
                  owner: exempting them would make every limit decorative.
       'notify' — it binds them, and the refusal says they may proceed by
                  changing the limit. They are never locked out of their own
                  store, but they have to make the decision deliberately
                  instead of not noticing the rule.
       'bypass' — it never applies to them.
     Bypass is offered because it is what people want, and refused as a default
     because a role that silently skips every rule turns "who can do X" back
     into a guess. */
  const sa = String(rule.superAdmin || 'apply');
  if (sa === 'bypass' && String(attr(ctx, 'subject.role')) === 'super_admin') return 'n/a';

  const users = Array.isArray(rule.users) ? rule.users.map((u) => String(u).toLowerCase()) : null;
  if (users) {
    const id = String(attr(ctx, 'subject.id') || '').toLowerCase();
    const email = String(attr(ctx, 'subject.email') || '').toLowerCase();
    if (users.indexOf(id) === -1 && users.indexOf(email) === -1) return 'n/a';
  }

  const op = OPS[String(rule.op || '')];
  if (!op) return 'fail';                                       // unknown operator → deny
  const left = attr(ctx, rule.attr);
  if (left === undefined) return 'fail';                        // unknown attribute → deny
  return op(left, rule.value) ? 'pass' : 'fail';
}

/**
 * The whole decision.
 *
 * @param rbacAllowed  what RBAC already decided. FIRST, and load-bearing.
 * @param rules        the rule list (any shape; junk is ignored or denies)
 * @param ctx          { subject:{role,…}, action, resource:{…} }
 * @returns { allow, reason, rule }  reason is for the audit trail and the
 *          admin's "why?" box — a decision nobody can explain is one nobody
 *          trusts, and untrusted rules get replaced by handing out super admin.
 */
export function can(rbacAllowed, rules, ctx) {
  // Before anything else. This is the contract, expressed as control flow.
  if (!rbacAllowed) return { allow: false, reason: 'role does not grant this' };
  const list = Array.isArray(rules) ? rules : [];
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  /* No action means no rule can match, which without this line would sail
     through as "nothing objected" — a caller that forgot its context would be
     granted rather than refused. Fail closed applies to the CALL as much as to
     the rules. */
  if (!c.action) return { allow: false, reason: 'no action given to check' };
  for (const rule of list) {
    const r = checkRule(rule, c);
    if (r === 'fail') {
      return {
        allow: false,
        reason: rule && rule.label ? String(rule.label) : 'a rule denied it',
        rule: rule && rule.id ? String(rule.id) : undefined,
        /* The distinction the UI needs. "Your role cannot do this" and "your
           role can, but a limit stopped this case" are different sentences and
           lead to different actions — the second one is worth asking somebody
           about, the first is not. Without this flag an Ask button would appear
           on refusals nobody can grant. */
        limited: true,
        /* Told to the caller so a super admin sees "you can change this limit"
           rather than a flat refusal — they have the power, they just have not
           used it yet. Anyone else gets the plain message. */
        ownerMayOverride: String((rule && rule.superAdmin) || 'apply') === 'notify'
          && String(attr(ctx, 'subject.role')) === 'super_admin',
      };
    }
  }
  // No rule objected. Absence of a rule is "no extra constraint", never a grant
  // — which it cannot be, because rbacAllowed was true to reach this line.
  return { allow: true, reason: list.length ? 'role grants it, no rule objects' : 'role grants it' };
}

/* "Who can do X?" stays answerable: the roles RBAC grants it to, minus the
   rules that narrow it. Two lookups rather than a solver, and keeping that
   property is the reason for the layering. */
export function rulesFor(rules, action) {
  return (Array.isArray(rules) ? rules : [])
    .filter((r) => r && r.enabled !== false && String(r.action || '') === String(action || ''));
}

export const __test = { OPS, attr, num };
