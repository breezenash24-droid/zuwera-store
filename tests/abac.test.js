/* The evaluator, tested on its own before anything consults it. An
   authorization change must not be half-applied, so the decision logic lands
   first where it cannot affect a request. */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..') + '/';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  \u2014 ' + extra : '')); }
}

const SRC = fs.readFileSync(ROOT + 'functions/api/_abac.js', 'utf8');
const { can, checkRule, rulesFor } = new Function(
  SRC.replace(/^export\s+/gm, '') + '\n;return { can, checkRule, rulesFor };')();

const refundUnder100 = {
  id: 'r1', label: 'Refunds under $100', action: 'order.refund',
  attr: 'resource.total', op: 'lt', value: 100,
};
const ctx = (total, role) => ({ subject: { role: role || 'fulfilment' }, action: 'order.refund', resource: { total } });

console.log('\n  a rule can never widen a grant');
{
  /* THE contract. Expressed as control flow rather than as a policy the rules
     are trusted to respect: rbacAllowed is the first argument and short-
     circuits before any rule is read. */
  ok('RBAC saying no is the end of it, whatever the rules say',
    can(false, [refundUnder100], ctx(10)).allow === false);
  ok('…even with no rules at all', can(false, [], ctx(10)).allow === false);
  ok('…and with a rule that would obviously pass',
    can(false, [{ action: 'order.refund', attr: 'resource.total', op: 'lt', value: 1e9 }], ctx(1)).allow === false);
  /* There is no ALLOW rule type, so "grant Bob refunds with a rule" is not
     something anyone can write and get wrong. */
  ok('there is no grant/allow rule type to misuse',
    !/effect|['"]allow['"]\s*:/i.test(SRC.replace(/allow:/g, '')),
    'a rule that can grant is a back door with extra steps');
  ok('rbacAllowed is checked before the rules are even read',
    SRC.indexOf('if (!rbacAllowed)') < SRC.indexOf('for (const rule of list)'));
}

console.log('\n  narrowing works the way it reads');
{
  ok('under the limit passes', can(true, [refundUnder100], ctx(70)).allow === true);
  ok('over the limit is denied', can(true, [refundUnder100], ctx(150)).allow === false);
  ok('exactly the limit is denied, because "under" means under',
    can(true, [refundUnder100], ctx(100)).allow === false);
  /* Absence of a rule is "no extra constraint", never "allowed" — it cannot be
     a grant, because rbacAllowed was already true to reach that line. */
  ok('no rule for an action leaves RBAC alone', can(true, [], ctx(9999)).allow === true);
  ok('a rule for a DIFFERENT action does not apply',
    can(true, [{ ...refundUnder100, action: 'product.publish' }], ctx(9999)).allow === true);
  ok('a disabled rule does not apply',
    can(true, [{ ...refundUnder100, enabled: false }], ctx(9999)).allow === true);
  /* Deny-overrides: one objection is enough, no matter how many rules agree. */
  ok('one failing rule denies even when others pass',
    can(true, [refundUnder100, { ...refundUnder100, id: 'r2', attr: 'resource.total', op: 'lt', value: 5 }], ctx(50)).allow === false);
  ok('a rule scoped to other roles does not apply',
    can(true, [{ ...refundUnder100, roles: ['finance'] }], ctx(9999, 'fulfilment')).allow === true);
  ok('…and does apply to the role it names',
    can(true, [{ ...refundUnder100, roles: ['finance'] }], ctx(9999, 'finance')).allow === false);
}

console.log('\n  it fails closed');
{
  /* A typo that silently stops constraining anything is the failure you notice
     only after it has been exploited. */
  ok('an operator we do not implement denies',
    can(true, [{ ...refundUnder100, op: 'approximately' }], ctx(1)).allow === false);
  ok('an attribute the resource does not carry denies',
    can(true, [{ ...refundUnder100, attr: 'resource.nonexistent' }], ctx(1)).allow === false);
  /* Missing is not the same as falsy: `total` absent means we cannot evaluate
     "under $100", and guessing costs money. */
  ok('…including when the whole resource is missing',
    can(true, [refundUnder100], { subject: { role: 'x' }, action: 'order.refund' }).allow === false);
  ok('a malformed rule denies rather than being skipped',
    can(true, [null], ctx(1)).allow === false && can(true, ['nonsense'], ctx(1)).allow === false);
  ok('a non-numeric value on a numeric operator denies',
    can(true, [{ ...refundUnder100, value: 'lots' }], ctx(1)).allow === false);
  ok('junk in place of the rule list does not throw',
    can(true, null, ctx(1)).allow === true && can(true, 'nope', ctx(1)).allow === true);
  ok('junk in place of the context does not throw',
    can(true, [refundUnder100], null).allow === false);
}

console.log('\n  a decision can be explained');
{
  /* A decision nobody can explain is one nobody trusts, and untrusted rules
     get replaced by handing out super admin. */
  const d = can(true, [refundUnder100], ctx(150));
  ok('a denial names the rule that caused it', d.reason === 'Refunds under $100' && d.rule === 'r1');
  ok('an RBAC denial says so instead of blaming a rule',
    can(false, [refundUnder100], ctx(1)).reason === 'role does not grant this');
  ok('an allow explains itself too', can(true, [], ctx(1)).reason === 'role grants it');
  /* "Who can do X?" stays two lookups rather than a search — the reason for
     layering rather than replacing. */
  ok('the rules narrowing an action can be listed',
    rulesFor([refundUnder100, { ...refundUnder100, action: 'other' }], 'order.refund').length === 1);
}


/* ── it is actually connected ─────────────────────────────────────────────
   This engine was complete, tested, and imported by NOTHING. Every rule a
   store could write was inert, and the passing tests made it look done — which
   is exactly how it stayed unfinished. */
console.log('\n  the engine is wired to something');
{
  const fs2 = require('fs');
  const P = require('path').resolve(__dirname, '..') + '/functions/api/';
  const commerce = fs2.readFileSync(P + '_commerce.js', 'utf8');

  ok('the permission gate imports it', /from '\.\/_abac\.js'/.test(commerce));
  ok('…and calls it', /\bcan\(rbacAllowed, rules/.test(commerce));

  /* One gate, not two. A second authorization path is a second place for a
     bypass, and "who can do X" would stop being one lookup. */
  ok('verifyAdminCan goes through the same decision', /await decide\(env, accessToken, permission, ctx\)/.test(commerce));

  /* Direction. ABAC is handed the RBAC answer and can only take away — a
     mode switch was rejected because turning it off would be a silent
     privilege escalation. */
  ok('RBAC decides first and ABAC receives that answer',
    /const rbacAllowed = permsHave\(admin\.permissions, permission\)/.test(commerce));

  /* The identity cannot be spoofed by the endpoint asking the question. */
  const decide = commerce.slice(commerce.indexOf('export async function decide'));
  ok('the subject comes from the verified session, not the caller',
    decide.indexOf('...ctx') < decide.indexOf('subject:'),
    'ctx spread after subject would let an endpoint claim a different identity');

  /* Adoption has to cost nothing, or nobody turns it on. */
  ok('a store with no rules behaves exactly as before',
    /Array\.isArray\(cfg\) \? cfg/.test(commerce) && /return \[\];/.test(commerce));
  ok('…and unreadable rules do not lock every admin out',
    /rules unreadable, proceeding on RBAC alone/.test(commerce),
    'failing closed here locks the whole panel over a transient read');
}


console.log('\n  and a store owner can write one');
{
  const fs3 = require('fs');
  const R3 = require('path').resolve(__dirname, '..') + '/';
  const adm = fs3.readFileSync(R3 + 'admin-main.js', 'utf8');
  const html = fs3.readFileSync(R3 + 'admin.html', 'utf8');

  ok('there is an editor', /window\.abacSave/.test(adm) && /id="abacRules"/.test(html));
  ok('…that writes where the engine reads', /key: 'abac_rules'/.test(adm),
    'a rule saved anywhere else is a rule nothing enforces');
  ok('…and loads what is already there', /window\.abacLoad/.test(adm));

  /* Choosing a limit has to move action and attribute together. A rule whose
     action says "refund" while its attribute reads a promo percentage never
     fires, and looks enabled the whole time. */
  ok('picking a limit sets its action and attribute together',
    /r\.action = kind\.action; r\.attr = kind\.attr/.test(adm));

  /* The engine denies when an attribute cannot be compared, so an empty value
     does not mean "no limit" — it means "refuse everything of this kind". */
  ok('a limit with no number is refused at save',
    /Every limit needs a number/.test(adm),
    'saving one would quietly deny every action of that kind');

  ok('no roles means every role, not no roles',
    /if \(list\.length\) r\.roles = list; else delete r\.roles/.test(adm));

  /* The copy is the feature here: a rule nobody trusts gets worked around by
     handing out super admin, which is worse than having no rules. */
  ok('the panel says limits can only take permission away',
    /take permission away/.test(html));

  /* The panel and its loader have to be on the SAME page. They were not: the
     markup went on APIs and the loader ran from the Loyalty page's init, so
     the panel rendered empty where it lived and loaded into nothing where it
     did not. */
  const usersInit = adm.slice(adm.indexOf("page === 'users'"), adm.indexOf("page === 'analytics'"));
  ok('the editor loads on the page it is on', /abacLoad\(\)/.test(usersInit),
    'a panel whose loader runs elsewhere is a panel that is always empty');

  /* And it is on the page where the question gets asked. Limits narrow roles;
     somebody deciding what a manager may do is already looking at Users. The
     APIs page is for infrastructure, which is a different question and usually
     a different person. */
  const upto = html.slice(0, html.indexOf('id="abacRules"'));
  const page = (upto.match(/id="([a-zA-Z0-9_-]+)" class="page"/g) || []).pop() || '';
  ok('…which is Users, beside the roles it narrows', /id="users"/.test(page), page);
}


console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
