/* sanitizePages is the entire security surface of custom permissions —
   everything else about them is interface. So it is tested on its own, hard,
   with the attacks it actually has to survive. */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..') + '/';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  \u2014 ' + extra : '')); }
}

const SRC = fs.readFileSync(ROOT + 'functions/api/_rbac.js', 'utf8');
const { sanitizePages, PAGE_IDS, PAGE_LEVELS } = new Function(
  SRC.replace(/^export\s+/gm, '') + '\n;return { sanitizePages, PAGE_IDS, PAGE_LEVELS };')();

console.log('\n  the allowlist rebuilds rather than trusts');
{
  ok('a known page at a known level survives',
    JSON.stringify(sanitizePages({ orders: 'view' })) === '{"orders":"view"}');
  /* An unknown key cannot survive a copy it was never copied into — the
     function builds from PAGE_IDS rather than editing the input. */
  ok('a page nobody has heard of is dropped',
    sanitizePages({ orders: 'view', __proto__zz: 'edit', secrets: 'edit' }) &&
    !('secrets' in sanitizePages({ orders: 'view', secrets: 'edit' })));
  ok('…and the rebuild is from PAGE_IDS, not from the input keys',
    /for \(const page of PAGE_IDS\)/.test(SRC),
    'iterating the input is how an unknown key gets through');
  /* An invented level must drop the page, never round up to the nearest thing
     it resembles. "admin", "all", "*" are the guesses that would grant. */
  for (const bad of ['admin', 'all', '*', 'write', 'EDITT', 'none', '']) {
    ok('a level of "' + bad + '" grants nothing',
      sanitizePages({ orders: bad }) === null);
  }
  ok('case and whitespace are normalised, not rejected outright',
    JSON.stringify(sanitizePages({ orders: '  EDIT ' })) === '{"orders":"edit"}');
}

console.log('\n  it cannot be tricked into an object it should not build');
{
  ok('null, arrays and strings yield nothing',
    sanitizePages(null) === null && sanitizePages([1, 2]) === null &&
    sanitizePages('orders') === null && sanitizePages(undefined) === null);
  /* Distinguishable on purpose: absent means "follows the role", and {} would
     read as "customised to nothing", which is a different intent. */
  ok('an empty result is null, so "no custom" stays distinct from "custom: none"',
    sanitizePages({}) === null && sanitizePages({ orders: 'bogus' }) === null);
  ok('a nested object as a level does not survive',
    sanitizePages({ orders: { level: 'edit' } }) === null);
  /* 'none' is the ABSENCE of an entry, not a value — so it must not be
     writable, or two spellings of the same state exist. */
  ok('"none" is not a level that can be stored', PAGE_LEVELS.indexOf('none') === -1);
  ok('every level offered is one the evaluator understands',
    PAGE_LEVELS.every((l) => l === 'view' || l === 'edit'));
}

console.log('\n  the invite endpoint uses it');
{
  const INV = fs.readFileSync(ROOT + 'functions/api/invite-admin.js', 'utf8');
  ok('custom pages are sanitised before they are stored',
    /const customPages = sanitizePages\(body\.pages\);/.test(INV));
  /* The raw body must never reach the write. If this ever regresses, an
     attacker chooses their own permission map. */
  ok('the raw request body never reaches admin_permissions',
    !/admin_permissions:\s*\{\s*pages:\s*body\./.test(INV) &&
    /admin_permissions: \{ pages: customPages \}/.test(INV));
  ok('…and nothing is written at all when there are none',
    /\.\.\.\(customPages \? \{ admin_permissions/.test(INV));
  ok('the role is still validated against STAFF_ROLES',
    /STAFF_ROLES\.includes\(adminRole\)/.test(INV));
  /* Only a super admin should reach the sanitiser at all. */
  ok('the endpoint is still gated on role_manage',
    /verifyAdminCan\(env, accessToken, 'role_manage'\)/.test(INV));
  ok('the audit row records what was granted, not just the role name',
    /custom_pages: customPages \|\| null/.test(INV),
    '"who was given what" is what an audit log exists to answer');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
