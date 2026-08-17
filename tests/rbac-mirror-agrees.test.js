/* The two RBAC tables say the same thing.
 *
 * functions/api/_rbac.js is the security boundary. admin.html carries a client
 * MIRROR of it — ZW_RBAC and ZW_ROLE_PRESET_LEVELS — which decides what a staff
 * member can see in the nav. The header on that block says "KEEP THE TWO IN
 * SYNC", and nothing checked that anybody did.
 *
 * They had already come apart. The server granted `pricing` to manager and
 * finance; the client mirror had never heard of it, so both roles were served a
 * Pricing page the nav refused to show them. Not a security hole — the server
 * re-checks every action, which is why this is a usability failure rather than
 * an exposure — but a permission that exists and cannot be reached is
 * indistinguishable from one that was never granted, and the person it happens
 * to has no way to tell which.
 *
 * The direction that WOULD be a hole is the other one: a page in the client
 * mirror that the server has never heard of. That is a nav entry leading to an
 * endpoint with no permission mapped to it, and it is asserted separately and
 * more strictly below.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const RBAC_SRC = fs.readFileSync(path.join(ROOT, 'functions', 'api', '_rbac.js'), 'utf8');
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');

/* The server tables, evaluated rather than parsed out with a regex — a regex
   that silently matches nothing produces an empty table and a suite that
   compares two empty things and passes. */
const server = new Function(
  RBAC_SRC.replace(/^export\s+/gm, '')
  + '\n;return { PAGE_IDS, PAGE_WRITE_PERM, ROLE_PRESET_LEVELS };')();

/* The client tables, lifted from the <script> in admin.html the same way. */
function clientTable(name) {
  const at = ADMIN.indexOf('const ' + name + ' =');
  if (at < 0) throw new Error('no ' + name + ' in admin.html');
  /* From the `=` to the line that closes the object literal at the same indent.
     Bounded by a brace scan rather than a lazy match, because a lazy [\s\S]*?
     runs past the first nested close and swallows whatever follows — the exact
     failure that has bitten scanners in this repo before. */
  const start = ADMIN.indexOf('{', at);
  let depth = 0, end = -1;
  for (let i = start; i < ADMIN.length; i++) {
    if (ADMIN[i] === '{') depth++;
    else if (ADMIN[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error('unbalanced braces reading ' + name);
  return new Function('return ' + ADMIN.slice(start, end))();
}

const ZW_RBAC = clientTable('ZW_RBAC');
const ZW_PRESETS = clientTable('ZW_ROLE_PRESET_LEVELS');

console.log('\n  the RBAC mirror agrees with the server\n');

console.log('  the tables were actually read');
{
  ok('server PAGE_IDS is populated', server.PAGE_IDS.length > 20, String(server.PAGE_IDS.length));
  ok('client ZW_RBAC has every role', Object.keys(ZW_RBAC).length >= 6, Object.keys(ZW_RBAC).join(','));
  ok('client presets were parsed', Object.keys(ZW_PRESETS).length >= 4, Object.keys(ZW_PRESETS).join(','));
}

console.log('\n  no nav entry without a server permission');
{
  /* The dangerous direction. Everything in a client role list is either a page
     id the server knows or a capability name; anything else is a nav entry
     pointing at a page the server has no mapping for. */
  const known = new Set(server.PAGE_IDS);
  const caps = new Set(Object.values(server.PAGE_WRITE_PERM));
  /* Capabilities the client grants that are not page-write perms — these are
     real, named in _rbac.js, and used for action buttons. */
  for (const extra of ['refund', 'return_process', 'product_write', 'order_write',
    'user_manage', 'builder_edit', 'bulk_actions', 'export', 'pricing_write']) caps.add(extra);

  const orphans = [];
  for (const [role, entries] of Object.entries(ZW_RBAC)) {
    if (entries[0] === '*') continue;
    for (const e of entries) {
      if (!known.has(e) && !caps.has(e)) orphans.push(role + ':' + e);
    }
  }
  ok('every client entry is a known page or capability', orphans.length === 0,
    'unknown: ' + orphans.join(', '));
}

console.log('\n  a granted page is a reachable page');
{
  /* For every role the server gives a page to, the client mirror has to list
     it — otherwise the permission exists and the nav hides it. */
  const missing = [];
  for (const [role, levels] of Object.entries(server.ROLE_PRESET_LEVELS)) {
    if (role === 'viewer') continue;   // built from PAGE_IDS, checked below
    const client = ZW_RBAC[role];
    if (!client) { missing.push(role + ' (absent from ZW_RBAC)'); continue; }
    for (const page of Object.keys(levels)) {
      if (!client.includes(page)) missing.push(role + ':' + page);
    }
  }
  ok('no role is granted a page the nav hides', missing.length === 0,
    'granted but hidden: ' + missing.join(', '));

  /* viewer is defined server-side as every page at view.
   *
   * A client mirror that is STRICTER than the server is not a hole — the server
   * re-checks, so hiding a page the server would have allowed only costs the
   * person a page. It is still drift, and drift nobody wrote down is
   * indistinguishable from a mistake, which is how `loyalty` and `pricing` came
   * to be missing here with nothing recording whether that was on purpose.
   *
   * So: one deliberate exception, named and reasoned. Everything else must
   * match, and a new omission fails.
   */
  const STRICTER_ON_PURPOSE = {
    /* The API keys page lists which integrations hold credentials and lets them
       be rotated. Read-only access to the rest of the store does not imply
       needing to see that inventory, and it is the one page where "view" is
       still worth withholding. */
    apis: 'credentials are not a read-only concern',
  };
  const viewerMissing = server.PAGE_IDS
    .filter((p) => !(ZW_RBAC.viewer || []).includes(p))
    .filter((p) => !STRICTER_ON_PURPOSE[p]);
  ok('viewer sees every page the server lists, bar the documented exception',
    viewerMissing.length === 0, 'missing for viewer: ' + viewerMissing.join(', '));

  /* And the exception has to still BE one — an entry left here after the page
     was added back is a note that has stopped describing the code. */
  const staleExceptions = Object.keys(STRICTER_ON_PURPOSE)
    .filter((p) => (ZW_RBAC.viewer || []).includes(p));
  ok('no exception is recorded for a page that is not actually withheld',
    staleExceptions.length === 0, 'stale: ' + staleExceptions.join(', '));
}

console.log('\n  the preset matrix matches too');
{
  const wrong = [];
  for (const [role, levels] of Object.entries(server.ROLE_PRESET_LEVELS)) {
    if (role === 'viewer') continue;
    const client = ZW_PRESETS[role];
    if (!client) { wrong.push(role + ' (absent)'); continue; }
    for (const [page, level] of Object.entries(levels)) {
      if (client[page] !== level) wrong.push(role + ':' + page + ' server=' + level + ' client=' + (client[page] || 'absent'));
    }
  }
  ok('every preset level agrees', wrong.length === 0, wrong.join('; '));
}

console.log('\n  wholesale is wired end to end');
{
  ok('the page id is registered on the server', server.PAGE_IDS.includes('wholesale'));
  ok('…and mapped to a write capability',
    server.PAGE_WRITE_PERM.wholesale === 'pricing_write',
    'got ' + server.PAGE_WRITE_PERM.wholesale);

  /* A page with no nav entry, no container or no activation hook is a page
     nobody can open — each of these has been the whole bug before. */
  ok('the nav lists it', /id:'wholesale'/.test(ADMIN));
  ok('the page container exists', /id="wholesale" class="page"/.test(ADMIN));
  ok('the module is loaded', /admin-wholesale\.js/.test(ADMIN));

  const MAIN = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');
  ok('opening the page loads its data',
    /page === 'wholesale'/.test(MAIN) && /wholesaleLoadData/.test(MAIN),
    'the container renders empty without this');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
