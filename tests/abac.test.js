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

  /* Enough limits to be worth having. Three covered money and nothing else —
     no destructive actions, no scoping, no ceiling on who may promote whom. */
  const limits = (adm.match(/\{ id: '[a-z_]+', action:/g) || []).length;
  ok('there are limits worth choosing between', limits >= 10, limits + ' defined');

  const block = adm.slice(adm.indexOf('const ABAC_LIMITS'), adm.indexOf('let _abacState'));
  ok('…covering destructive actions, not just money',
    /product_delete/.test(block) && /customer_export/.test(block) && /bulk_edit/.test(block));
  ok('…and who may grant which role', /role_manage/.test(block),
    'without this an admin can promote themselves past their own level');
  ok('…every one using an operator the engine has',
    (block.match(/op: '([a-z]+)'/g) || []).every((o) => /'(lt|lte|gt|gte|eq|neq|in|nin)'/.test(o)));

  /* A limit is a different question depending on its kind, and one number box
     answers "only these regions" badly. */
  ok('…and a value control that fits the question',
    /kind\.kind === 'list'/.test(adm) && /kind\.kind === 'number'/.test(adm));
  ok('an empty list is refused at save', /would refuse everything/.test(adm),
    'a list matching nothing refuses every action of that kind');

  /* This assertion was guarding the wrong sentence. It checked for "Not
     enforced yet — … or it will refuse every X", which reasons from the
     engine's fail-closed rule: deny what you cannot evaluate. True of the
     engine, but not of the situation — an unwired action never reaches the
     engine at all, because no endpoint calls decide() for it. The rule is not
     consulted, and switching it on does nothing.
     Both readings tell you to leave it off, so the bug was invisible. It
     matters anyway: one says "this is dangerous", the other says "this is not
     protecting you", and only the second is true today. */
  ok('a limit that cannot be enforced says it does nothing', /This does nothing yet/.test(adm),
    'an unwired action never reaches the engine, so the rule is never consulted');
  ok('…and readiness is recorded per limit', /ready: (true|false)/.test(block));
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
    /needs a number/.test(adm),
    'saving one would quietly deny every action of that kind');

  /* The invariant moved when the text boxes became pickers, so this moved with
     it rather than staying pointed at code nothing calls. Same rule either
     way: the engine reads an ABSENT list as "everyone this rule already
     covers" and an EMPTY one as "nobody matches", so removing the last chip
     has to delete the key. Leaving [] behind switches the limit off while it
     still renders as on. */
  ok('removing the last one deletes the key rather than leaving []',
    /if \(!r\[field\]\.length\) delete r\[field\]/.test(adm),
    'an empty array matches nobody, so the limit would silently stop applying');

  /* The whole reason for the directory. A typed role or email that matches
     nothing does not error — it scopes the limit to no one, and the rule sits
     there looking configured. */
  ok('roles and people are chosen from a list, not typed',
    /function abacPicker\(/.test(adm) && /window\.abacPick =/.test(adm)
      && !/placeholder="everyone — or: manager, support"/.test(adm),
    'the free-text boxes are gone');

  ok('an entry matching nobody is shown, not dropped',
    /matches nobody/.test(adm),
    'silently discarding it would hide the failure this replaced');

  /* Read from the list the Users table already loaded. Two lists of "who is an
     admin" on one page eventually disagree, and the one in the authorization
     editor is the worse of the two to be wrong. */
  ok('the directory is the profiles the page already has',
    /_zwProfilesById/.test(adm.slice(adm.indexOf('async function abacDirectory'),
                                     adm.indexOf('function abacPicker'))));

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

  /* The warning on a not-ready limit said the wrong thing, and the wrong thing
     was the safer-sounding of the two. It read "leave it off or it will refuse
     every X" — describing a hazard that cannot happen yet, and hiding the one
     that is happening: nothing calls the engine for these actions, so the rule
     is never consulted. Ticked on, it protects nothing.
     Believing a limit works when it does not is the failure that goes
     unnoticed, so that is the sentence the panel has to lead with. */
  ok('a limit that cannot bite says it does nothing, not that it refuses everything',
    /This does nothing yet/.test(adm) && !/it will refuse every/.test(adm),
    'the old wording described a future hazard and hid the present one');

  ok('…and says so next to the switch, not only in the small print',
    /not working yet/.test(adm));

  /* Switching a rule from Refunds to Discount codes left the old sentence
     behind, so the refused person was told about a limit unrelated to what
     they tried. One author for that sentence, and it follows the kind unless
     somebody wrote their own. */
  ok('the refusal message follows the limit it belongs to',
    /function abacDefaultLabel\(/.test(adm)
      && /r\.label === abacDefaultLabel\(prev\)/.test(adm),
    'a hand-written message is kept; a default is not left pointing at the wrong limit');
}


console.log('\n  who did what');
{
  const adm = fs.readFileSync(ROOT + 'admin-main.js', 'utf8');
  const html = fs.readFileSync(ROOT + 'admin.html', 'utf8');

  /* Every refund attempt was already being recorded, with the admin who was
     signed in — and nothing ever displayed it, so "who did what refund" looked
     like a missing feature rather than an unopened drawer. */
  ok('the refund log is shown somewhere', /window\.zwRefundLog =/.test(adm) && /id="zwRefundLogBody"/.test(html));

  const upto = html.slice(0, html.indexOf('id="zwRefundLogBody"'));
  const page = (upto.match(/id="([a-zA-Z0-9_-]+)" class="page"/g) || []).pop() || '';
  ok('…on Users, with the people it names', /id="users"/.test(page), page);

  const usersInit = adm.slice(adm.indexOf("page === 'users'"), adm.indexOf("page === 'analytics'"));
  ok('and its loader runs on that page', /zwRefundLog\(\)/.test(usersInit));

  /* A failed attempt has to say WHY. Without the note, a mistyped
     authorization code and a limit refusing look identical in the log, and
     they call for completely different responses. */
  ok('a refusal shows its reason, not just that it failed', /e\.note/.test(adm));

  /* The endpoint unshifts, so the array is newest-first today. Depending on
     that means the day it changes, the panel shows the oldest attempts and
     looks fine doing it. */
  ok('sorted rather than trusted to arrive in order', /\.sort\(\(a, b\) => String\(\(b && b\.at\)/.test(adm));
}



console.log('\n  a limit can name people, not just roles');
{
  const base = { action: 'refund', attr: 'resource.amount', op: 'lte', value: 100 };
  const ctxFor = (id, email, role) => ({ action: 'refund', resource: { amount: 500 },
    subject: { id: id, email: email, role: role } });

  /* Roles are the blunt instrument. There is always somebody who needs a
     different number, and doing it with roles alone means inventing a role per
     exception — which is how role lists stop being readable. */
  const byEmail = Object.assign({ users: ['sam@shop.com'] }, base);
  ok('a rule scoped to one person applies to them',
    can(true, [byEmail], ctxFor('u1', 'sam@shop.com', 'manager')).allow === false);
  ok('…and not to anybody else',
    can(true, [byEmail], ctxFor('u2', 'alex@shop.com', 'manager')).allow === true);

  ok('a person can be named by id as well as email',
    can(true, [Object.assign({ users: ['u9'] }, base)], ctxFor('u9', 'x@shop.com', 'manager')).allow === false);
  ok('…matched case-insensitively, since an admin panel and a session disagree on case',
    can(true, [Object.assign({ users: ['SAM@shop.com'] }, base)], ctxFor('u1', 'sam@shop.com', 'manager')).allow === false);

  ok('naming nobody still means everyone', can(true, [base], ctxFor('u1', 'a@b.c', 'manager')).allow === false);

  /* Both scopes have to agree, or "managers named sam" would apply to every
     manager. */
  const both = Object.assign({ roles: ['manager'], users: ['sam@shop.com'] }, base);
  ok('roles and people narrow together, not separately',
    can(true, [both], ctxFor('u1', 'sam@shop.com', 'support')).allow === true);
}

console.log('\n  a refusal says whether it is worth asking about');
{
  /* "Your role cannot do this" and "your role can, but a limit stopped this
     case" are different sentences leading to different actions. Only the second
     is worth asking somebody to approve. */
  const rule = { action: 'refund', attr: 'resource.amount', op: 'lte', value: 100 };
  const ctx = { action: 'refund', resource: { amount: 500 }, subject: { role: 'manager' } };

  const byLimit = can(true, [rule], ctx);
  ok('a limit refusal is marked as one', byLimit.allow === false && byLimit.limited === true);

  const byRole = can(false, [rule], ctx);
  ok('…and a role refusal is not', byRole.allow === false && !byRole.limited,
    'an Ask button on this would offer to request something nobody can grant');

  ok('an allow carries no such flag', can(true, [], ctx).limited === undefined);
}


console.log('\n  a limit marked ready really is');
{
  const fs4 = require('fs');
  const R4 = require('path').resolve(__dirname, '..') + '/';
  const adm4 = fs4.readFileSync(R4 + 'admin-main.js', 'utf8');
  const block4 = adm4.slice(adm4.indexOf('const ABAC_LIMITS'), adm4.indexOf('let _abacState'));

  /* `ready` tells an owner it is safe to switch a limit on. If it lies, the
     first person to enable one takes that action offline for everybody — the
     engine denies what it cannot evaluate. So the claim is checked against the
     endpoints rather than trusted. */
  const WIRED = {
    refund: 'functions/api/admin-refund.js',
    role_manage: 'functions/api/set-admin-role.js',
  };

  const entries = [...block4.matchAll(/\{ id: '([a-z_]+)', action: '([a-z_]+)'[\s\S]*?ready: (true|false)/g)]
    .map((m) => ({ id: m[1], action: m[2], ready: m[3] === 'true' }));
  ok('the limits parse', entries.length >= 10, entries.length + ' found');

  const lying = entries.filter((e) => {
    if (!e.ready) return false;
    const file = WIRED[e.action];
    if (!file) return true;                       // claims ready, no endpoint known
    const src = fs4.readFileSync(R4 + file, 'utf8');
    return !/await decide\(/.test(src);
  });
  ok('nothing claims to be enforced that is not', lying.length === 0,
    lying.map((e) => e.id).join(', ') + ' — marked ready but the endpoint does not call decide()');

  /* And the reverse: an endpoint that DOES pass context while its limit still
     says "not enforced yet" tells an owner to leave off a limit that works. */
  const silent = Object.entries(WIRED).filter(([action, file]) => {
    const src = fs4.readFileSync(R4 + file, 'utf8');
    return /await decide\(/.test(src) && entries.some((e) => e.action === action && !e.ready);
  });
  ok('…and nothing enforced is still labelled unenforced', silent.length === 0,
    silent.map(([a]) => a).join(', '));

  /* The unit trap. The panel asks for dollars; Stripe deals in cents. A limit
     written as "$500" compared against 50000 refuses every refund over five
     dollars — and looks exactly like the limit working. */
  const refund = fs4.readFileSync(R4 + WIRED.refund, 'utf8');
  ok('the refund amount is converted to the unit the panel asks for',
    /amountCents\) \/ 100/.test(refund),
    'passing cents against a dollar limit refuses almost everything, and looks correct');

  ok('a refusal by limit is audited like any other block',
    /blocked by limit/.test(refund));

  /* The limit that matters most. Without it, anyone who can manage roles can
     grant a role above their own — including to themselves — and every other
     limit becomes advisory, since they can simply promote past it. */
  const roles = fs4.readFileSync(R4 + WIRED.role_manage, 'utf8');
  ok('granting a role is checked against the limits', /await decide\(/.test(roles));
  ok('…on the role being GRANTED, which is the thing to constrain',
    /resource: \{ role: String\(nextRole/.test(roles),
    'checking the granter own role would let them grant anything to anyone else');

  /* Everything else in the list has no Worker endpoint to gate — those writes
     go straight from the browser to the database. Recorded so the gap is a
     known shape rather than an oversight. */
  const adminWrites = (adm4.match(/sb\.from\('(products|orders|product_sizes|promotions)'\)/g) || []).length;
  ok('the unwired limits are unwired for a reason, and it is written down',
    adminWrites > 0,
    'admin writes go direct to Supabase, so there is no server-side chokepoint to gate');
  ok('…and tells the panel it is worth asking about',
    /limited: !!verdict\.limited/.test(refund));
}


console.log('\n  forgetting the refund code is not a lockout');
{
  const fs5 = require('fs');
  const R5 = require('path').resolve(__dirname, '..') + '/';
  const rec = fs5.readFileSync(R5 + 'admin-receipts.js', 'utf8');
  const api = fs5.readFileSync(R5 + 'functions/api/admin-refund.js', 'utf8');

  ok('the modal explains where the code lives', /Forgotten the code\?/.test(rec));
  ok('…and that a new one can be set without the old one',
    /You are not locked out/.test(rec),
    'the recovery IS setting a new value; nothing said so');
  ok('…naming the variable and where to change it',
    /REFUND_SECRET/.test(rec) && /Workers &amp; Pages/.test(rec));

  /* The reason there is no reset button, held as a test because it is the kind
     of thing a later "convenience" change removes without noticing. */
  ok('the code is read from the environment, not the database',
    /env\.REFUND_SECRET/.test(api) && !/site_settings[^\n]*REFUND_SECRET/.test(api),
    'in settings it would be readable by any admin session and ride along in backups');
  ok('…and nothing offers to reset it from the panel',
    !/reset[^\n]{0,40}REFUND_SECRET/i.test(rec),
    'a reset button hands the second factor to whoever got into the panel');
}


console.log('\n  the refused person is told something useful');
{
  const fs6 = require('fs');
  const R6 = require('path').resolve(__dirname, '..') + '/';
  const adm6 = fs6.readFileSync(R6 + 'admin-main.js', 'utf8');

  /* The message was the rule's internal label — "Refunds limit" — which tells
     somebody nothing about what to do next. A refusal nobody can act on gets
     escalated to whoever can switch the limit off, which is how limits stop
     being used at all. */
  ok('the message shown on refusal is editable', /They will see/.test(adm6));
  ok('…and it is the field the engine actually reports',
    adm6.includes("',\\'label\\',this.value)"),
    'can() returns rule.label as the reason, so anything else would not reach the person');
  ok('…with a default that says what to do next',
    /ask an admin to approve it/.test(adm6),
    '"Refunds limit" states that a rule exists, not what happens now');
}


console.log('\n  the owner is not automatically exempt');
{
  const base = { action: 'refund', attr: 'resource.amount', op: 'lte', value: 100 };
  const c = (role) => ({ action: 'refund', resource: { amount: 500 }, subject: { role: role } });

  /* Three settings, because "does this bind the owner" has three honest answers
     and a checkbox offers two. */
  ok('by default a limit binds the super admin like anyone else',
    can(true, [base], c('super_admin')).allow === false,
    'most stores have one admin who IS the owner — exempting them makes every limit decorative');

  ok('bypass really does exempt them',
    can(true, [Object.assign({ superAdmin: 'bypass' }, base)], c('super_admin')).allow === true);
  ok('…and only them', 
    can(true, [Object.assign({ superAdmin: 'bypass' }, base)], c('manager')).allow === false);

  /* The middle setting: bound, but told they can change it. Never locked out of
     their own store, and still made to decide deliberately. */
  const notify = can(true, [Object.assign({ superAdmin: 'notify' }, base)], c('super_admin'));
  ok('notify still refuses', notify.allow === false);
  ok('…while saying the owner may change the limit', notify.ownerMayOverride === true);
  ok('…and says no such thing to anybody else',
    !can(true, [Object.assign({ superAdmin: 'notify' }, base)], c('manager')).ownerMayOverride);
}

console.log('\n  how many items, not just how much');
{
  const byCount = { action: 'refund', attr: 'resource.itemCount', op: 'lte', value: 5 };
  const c = (n) => ({ action: 'refund', resource: { itemCount: n, amount: 10 }, subject: { role: 'manager' } });
  ok('a refund covering too many items is refused', can(true, [byCount], c(9)).allow === false);
  ok('…and a small one is not', can(true, [byCount], c(3)).allow === true);

  const fs7 = require('fs');
  const R7 = require('path').resolve(__dirname, '..') + '/';
  const ref = fs7.readFileSync(R7 + 'functions/api/admin-refund.js', 'utf8');
  ok('the refund endpoint sends the item count', /itemCount: Array\.isArray\(order\.items\)/.test(ref));

  /* It reads `order`, so it has to run after the order loads. Written earlier
     it was a temporal dead zone error — every refund would have thrown, not
     just limited ones. */
  ok('…after the order it reads is loaded',
    ref.indexOf('const order  = orders') < ref.indexOf('await decide(env'),
    'referencing order before its declaration throws on every refund');
}

console.log('\n  a limit the person it binds can edit is not a limit');
{
  const adm = fs.readFileSync(ROOT + 'admin-main.js', 'utf8');
  const html = fs.readFileSync(ROOT + 'admin.html', 'utf8');
  const sql = fs.readFileSync(ROOT + 'migrations/0008_authz_keys_super_admin_only.sql', 'utf8');

  /* Found by signing in as a Manager and saving the limits panel. It worked.
     site_settings has one admin policy and it asks `role = 'admin'`, not which
     kind — so anyone with the panel open could raise their own refund cap. */
  ok('the three keys an admin must not write are named',
    /'abac_rules', 'refund_audit_log', 'refund_rate_limit'/.test(sql));

  /* RESTRICTIVE, so it ANDs with "Admin full access" instead of replacing it.
     A second permissive policy would OR, and grant rather than restrict. */
  ok('…by a restrictive policy, not another permissive one',
    (sql.match(/AS RESTRICTIVE/g) || []).length === 3,
    'a permissive policy ORs with the existing one and would widen access');

  /* All three write verbs. The panel calls .upsert(), so protecting INSERT
     without UPDATE would be one conflict away from meaningless. */
  ['INSERT', 'UPDATE', 'DELETE'].forEach((verb) => {
    ok('…covering ' + verb, new RegExp('FOR ' + verb + ' TO authenticated').test(sql));
  });

  /* And SELECT deliberately left alone. Somebody refused should be able to
     read the rule that refused them — hiding it produces a person asking for
     super admin so they can find out why. */
  ok('reading stays open to any admin', !/FOR SELECT/.test(sql),
    'a manager should be able to see the limits that bind them');

  ok('super admin is a distinct check from admin',
    /current_user_is_super_admin/.test(sql) && /coalesce\(admin_role, 'super_admin'\)/.test(sql),
    'null admin_role means super admin everywhere else, and must here too');

  /* The panel and the save both gate too. Neither is the fix — the database
     is — but a button that only fails at the last moment is its own bug. */
  ok('the editor is read-only for anyone who cannot change roles',
    /const mayEdit = typeof can === 'function' \? can\('role_manage'\)/.test(adm));
  ok('…and the save refuses as well', /Only a super admin can change these limits/.test(adm));
  ok('…and the buttons are hidden rather than left to fail', /id="abacActions"/.test(html)
    && /actions\.style\.display = mayEdit/.test(adm));
}


console.log('\n  a rule reads as a sentence');
{
  const adm = fs.readFileSync(ROOT + 'admin-main.js', 'utf8');
  const block = adm.slice(adm.indexOf('const ABAC_LIMITS'), adm.indexOf('let _abacState'));

  /* Five stacked controls do not add up to a sentence in anybody's head, and
     permissions are exactly where somebody needs to check what they built
     against what they meant. */
  ok('every limit can say itself in words',
    (block.match(/id: '/g) || []).length === (block.match(/\bsay: /g) || []).length,
    'a limit with no sentence would render a blank line where the summary goes');
  ok('…and the panel shows it above the controls', /abacSentence\(r, kind, roleCat, peopleCat\)/.test(adm));

  /* Nine of twelve kinds did nothing, and listing them at equal weight made
     the feature look three times its real size — each one then needing a red
     warning to undo the impression the dropdown had just made. */
  ok('only limits that work are offered',
    /ABAC_LIMITS\.filter\(\(k\) => k\.ready \|\| k\.id === kind\.id\)/.test(adm));
  ok('…keeping the row\'s own kind listed, so reopening one cannot change it',
    /k\.id === kind\.id/.test(adm));
  ok('…and the rest are named rather than hidden', /planned, but not built yet/.test(adm));
}

console.log('\n  asking, when a limit says no');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const rule = { id: 'refund_max', action: 'refund', attr: 'resource.amount', op: 'lte', value: 100,
                 label: 'Above your refunds limit.' };
  const ctx = (over, extra) => Object.assign({
    action: 'refund',
    resource: { amount: over, orderId: 'ord_1' },
    subject: { id: 'u1', email: 'nash@shop.com', role: 'manager' },
    now: NOW,
  }, extra || {});
  const grant = (over) => Object.assign({
    id: 'w1', status: 'approved', action: 'refund', ruleId: 'refund_max',
    resourceId: 'ord_1', forId: 'u1', amount: 600,
    expiresAt: new Date(NOW + 3600e3).toISOString(),
  }, over || {});

  ok('without a waiver the limit still refuses', can(true, [rule], ctx(600)).allow === false);
  ok('a granted waiver lets that one through', can(true, [rule], ctx(600, { waivers: [grant()] })).allow === true);
  ok('…and says so, so the log does not read like the limit never applied',
    can(true, [rule], ctx(600, { waivers: [grant()] })).reason === 'a limit was waived for this one');
  ok('…and names the one to spend',
    can(true, [rule], ctx(600, { waivers: [grant()] })).usedWaiver === 'w1');

  /* Each of these is a way the waiver could have become a standing
     exemption. Every field has to match, and a missing one is a no-match
     rather than a wildcard. */
  ok('a pending request is not an approval',
    can(true, [rule], ctx(600, { waivers: [grant({ status: 'pending' })] })).allow === false);
  ok('a declined one is not either',
    can(true, [rule], ctx(600, { waivers: [grant({ status: 'declined' })] })).allow === false);
  ok('a spent waiver does not work twice',
    can(true, [rule], ctx(600, { waivers: [grant({ usedAt: '2026-08-11T11:00:00Z' })] })).allow === false);
  ok('an expired one stops working',
    can(true, [rule], ctx(600, { waivers: [grant({ expiresAt: new Date(NOW - 1).toISOString() })] })).allow === false);
  ok('one with no expiry at all is not immortal by omission',
    can(true, [rule], ctx(600, { waivers: [grant({ expiresAt: undefined })] })).allow === true,
    'an absent expiry is allowed — the endpoint always sets one — but it must be a deliberate read');
  ok('somebody else cannot use your approval',
    can(true, [rule], ctx(600, { waivers: [grant({ forId: 'u2' })] })).allow === false);
  ok('it does not carry to another order',
    can(true, [rule], ctx(600, { waivers: [grant({ resourceId: 'ord_9' })] })).allow === false);
  ok('it does not carry to another limit',
    can(true, [rule], ctx(600, { waivers: [grant({ ruleId: 'refund_items_max' })] })).allow === false);

  /* The one that turns "approve $600" into "approve this order". */
  ok('approving an amount does not approve a bigger one',
    can(true, [rule], ctx(6000, { waivers: [grant({ amount: 600 })] })).allow === false);

  /* Two limits refusing is two decisions. A yes to one is not a yes to all. */
  const second = { id: 'refund_items_max', action: 'refund', attr: 'resource.itemCount', op: 'lte', value: 2,
                   label: 'Too many items.' };
  const both = ctx(600, { waivers: [grant()] });
  both.resource.itemCount = 9;
  ok('waiving one limit does not waive another',
    can(true, [rule, second], both).allow === false,
    'the loop must carry on rather than returning allow on the first waiver');

  /* THE contract. A waiver is read only after rbacAllowed was true, so the
     most it can restore is what the role already granted. */
  ok('a waiver cannot grant what the role never had',
    can(false, [rule], ctx(600, { waivers: [grant()] })).allow === false,
    'if this ever passes, an approval has become a way to hand out permissions');

  const fs8 = require('fs');
  const R8 = require('path').resolve(__dirname, '..') + '/';
  const com = fs8.readFileSync(R8 + 'functions/api/_commerce.js', 'utf8');
  const req = fs8.readFileSync(R8 + 'functions/api/abac-request.js', 'utf8');

  /* Spent BEFORE the action it permits. A refund that fails partway would
     otherwise leave the waiver live, and "approved once" would quietly mean
     "approved until it works". */
  ok('the waiver is spent inside the decision, not by the caller',
    /if \(verdict\.allow && verdict\.usedWaiver\)/.test(com));
  ok('…and failing to spend it refuses rather than proceeding',
    /Could not record the approval being used/.test(com),
    'an unburnable waiver is an approval that never runs out');

  /* Scoped to the function body. Matching the whole file found the word in a
     comment thirty lines above and passed for the wrong reason — which is the
     same class of mistake as the assertion it is making. */
  const decideBody = com.slice(com.indexOf('export async function decide'),
                               com.indexOf('export async function verifyAdminCan'));
  ok('an endpoint cannot pass its own waivers',
    decideBody.indexOf('...ctx') < decideBody.indexOf('\n    waivers,'),
    'spread after ctx, like subject, or a caller could waive anything');

  /* The requester builds none of the record that matters. */
  ok('a request is always created pending', /status: 'pending',/.test(req));
  ok('only a super admin answers one', /permsHave\(admin\.permissions, 'role_manage'\)/.test(req));
  ok('nobody answers their own', /You cannot approve your own request/.test(req));
  ok('asking twice is one ask', /r\.status === 'pending'/.test(req) && /dupe !== -1/.test(req));
  ok('an approval expires', /WAIVER_TTL_MS/.test(req) && /expiresAt: approve \?/.test(req));

  /* Requests and approvals are one list. Two would eventually disagree about
     whether something was approved, with the authorization system reading
     one of them. */
  ok('requests and approvals are the same record',
    /ABAC_REQUESTS_KEY/.test(req) && /ABAC_REQUESTS_KEY/.test(com));
}

console.log('\n  the export goes somewhere that can refuse it');
{
  const adm = fs.readFileSync(ROOT + 'admin-main.js', 'utf8');
  const exp = fs.readFileSync(ROOT + 'functions/api/admin-export.js', 'utf8');

  /* It never left the browser: exportUsersCSV read the profiles already on the
     page and built the file. Nothing was asked, so nothing could say no, which
     is why the limit could not be made to work without an endpoint. */
  ok('the export asks a server', /fetch\('\/api\/admin-export'/.test(adm));
  ok('…and no longer builds the file from what the page already has',
    !/const all = Object\.values\(window\._zwProfilesById \|\| \{\}\);/.test(adm));
  ok('…so the limit can now bite', /label: 'Exporting customers'[\s\S]{0,80}ready: true/.test(adm));

  /* Counting after reading would mean the rows were already out, at which
     point refusing is a gesture. */
  ok('rows are counted before the decision, not after',
    exp.indexOf("Prefer: 'count=exact'") < exp.indexOf("decide(env, accessToken, 'customer_export'"));
  ok('…and the decision happens before they are read',
    exp.indexOf("decide(env, accessToken, 'customer_export'") < exp.indexOf('order=created_at.desc'));

  /* "We could not work out how many" is not a smaller number. Running anyway
     would make the limit skippable by whatever broke the count. */
  ok('an uncountable export is refused rather than run',
    /if \(total === null\)/.test(exp) && /so it was not run/.test(exp));

  /* A control believed to be stronger than it is is worse than none. */
  ok('the endpoint is honest about what it does not stop',
    /can read profiles can\s*\n? \* always read profiles|always read profiles/.test(exp),
    'this bounds the one-click path, it is not a wall around the data');
}

console.log('\n  the asking is reachable');
{
  const adm = fs.readFileSync(ROOT + 'admin-main.js', 'utf8');
  const html = fs.readFileSync(ROOT + 'admin.html', 'utf8');
  const rec = fs.readFileSync(ROOT + 'admin-receipts.js', 'utf8');
  const ref = fs.readFileSync(ROOT + 'functions/api/admin-refund.js', 'utf8');

  /* The button, on the refusal it is about. A limit refusal used to arrive as
     a bare message like any other failure, leaving deleting the limit as the
     only available response. */
  ok('a limit refusal offers to ask', /Ask an admin/.test(rec));
  ok('…only for refusals somebody can grant', /if \(!resp\.ok && data\.limited\)/.test(rec),
    '"your role cannot do this" is not worth asking about');

  /* The owner is told to change their own rule instead. Approving your own
     request reads in the log exactly like somebody else approving it. */
  ok('…and the owner is sent to the limit, not to a request',
    /data\.ownerMayOverride/.test(rec) && /Change the limit/.test(rec));

  /* A request that does not name its rule cannot become a waiver — the engine
     matches on ruleId, and a yes to one limit is not a yes to all. */
  ok('the refusal says which limit it was', /rule: verdict\.rule/.test(ref));
  ok('…and the request carries it', /ruleId: data\.rule/.test(rec));

  ok('there is somewhere to answer them', /window\.zwAbacQueue =/.test(adm) && /id="abacQueue"/.test(html));
  const usersInit = adm.slice(adm.indexOf("page === 'users'"), adm.indexOf("page === 'analytics'"));
  ok('…that loads on the page it is on', /zwAbacQueue\(\)/.test(usersInit));

  /* Shown to the requester too. Otherwise they ask again, or decide nothing
     happened and go looking for someone to switch the limit off. */
  ok('a requester can see their own ask', /Waiting for a super admin/.test(adm));

  /* Approving a name and a number is not deciding anything. */
  ok('the refusal is quoted where it is answered', /Stopped by: /.test(adm));

  /* An empty panel on every visit trains people to scroll past the place
     answers appear. */
  ok('the queue hides itself when empty',
    /if \(!pending\.length && !recent\.length\) \{ wrap\.style\.display = 'none'; return; \}/.test(adm));

  ok('approving says what it granted, which is once',
    /Approved — good for that one order, once\./.test(adm));
}

console.log('\n  a role that was replaced does not still claim to apply');
{
  const adm = fs.readFileSync(ROOT + 'admin-main.js', 'utf8');
  const rbac = fs.readFileSync(ROOT + 'functions/api/_rbac.js', 'utf8');

  /* The behaviour the badge was describing wrongly: levelMapFor RETURNS the
     override, so a custom map replaces the preset rather than adjusting it. */
  ok('a custom map replaces the preset rather than layering on it',
    /if \(override && typeof override === 'object'\) return override;/.test(rbac),
    'if this ever merges instead, the badge below has to change with it');

  ok('so the badge stops naming the preset that no longer applies',
    /'Custom access' : roleName/.test(adm));
  ok('…while still showing the role, which decides which limits reach them',
    /for limits only/.test(adm));

  /* Super admin is the exception and runs the other way — resolvePerms
     returns '*' before the map is read, so the role wins there. */
  ok('…except for a super admin, where the role wins',
    /cur !== 'super_admin'/.test(adm) && /if \(role === 'super_admin'\) return \['\*'\];/.test(rbac));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
