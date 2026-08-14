/* install.sql must contain what the migrations DID, not just their names.
 *
 * tests/install-covers-migrations.test.js checks that every file in migrations/
 * has a row in install.sql saying it was applied. That is necessary and it is
 * not sufficient, because those rows are generated from the DIRECTORY LISTING —
 * they are true by construction and prove nothing about the SQL above them.
 *
 * The gap that leaves is the dangerous one. install.sql is a dump of
 * production. Take that dump from a database that has not yet run 0018 and you
 * get the OLD schema alongside a row swearing 0018 is in it. A new store then
 * comes up missing the change while believing it has it, and nothing
 * downstream can tell. scripts/dump-schema.js now refuses to dump a database
 * that is behind, but that guard runs at generation time on the author's
 * machine; this one runs in CI, on the committed artifact, for everyone.
 *
 * So: read what each migration CREATES — functions, policies, triggers, tables,
 * indexes — and check those names actually appear in install.sql. Not a full
 * schema diff, which needs a live database, but it catches the failure that
 * actually happens: a snapshot taken too early.
 *
 * Migrations that only drop, alter or insert have no creatable signature and
 * are skipped rather than guessed at. The count of those is printed, because a
 * check that silently examines three files out of seventeen is worse than no
 * check at all.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const INSTALL_PATH = path.join(ROOT, 'supabase', 'install.sql');
const MIG_DIR = path.join(ROOT, 'migrations');

console.log('\n  install.sql contains what the migrations did\n');

if (!fs.existsSync(INSTALL_PATH)) {
  console.log('  ⚠ supabase/install.sql does not exist yet — nothing to check.');
  console.log('    Generate it: node scripts/dump-schema.js && node scripts/build-install-sql.js schema.sql\n');
  console.log('  0 passed, 0 failed\n');
  process.exit(0);
}

const install = fs.readFileSync(INSTALL_PATH, 'utf8');

/* Object names a migration brings into existence. Deliberately conservative:
   only forms whose name survives verbatim into a schema dump. */
function signatures(rawSql) {
  /* Comments first, and this is not fussiness. These migrations carry long
     explanations that QUOTE the SQL they are arguing about — 0010 opens by
     showing the policy it exists to replace:

         --     CREATE POLICY "Admins manage profiles" ON profiles
         --       FOR ALL TO authenticated USING (current_user_is_admin());

     Read naively, that is a policy 0010 creates, and its absence from the
     snapshot reads as "production never applied 0010" — a false alarm about
     the exact thing this file is meant to detect, which would teach everyone
     to ignore it. */
  const sql = rawSql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*--.*$/gm, ' ');

  const out = new Set();
  const add = (v) => { if (v) out.add(v.trim()); };

  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)/gi)) add(m[1]);
  for (const m of sql.matchAll(/create\s+trigger\s+([a-z0-9_]+)/gi)) add(m[1]);
  for (const m of sql.matchAll(/create\s+policy\s+"([^"]+)"/gi)) add(m[1]);
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)/gi)) add(m[1]);
  for (const m of sql.matchAll(/create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi)) add(m[1]);

  /* `create index if not exists` without a name, and anything else the regexes
     above would mangle, simply does not contribute a signature. */
  out.delete('if');
  out.delete('not');
  return [...out];
}

const files = fs.readdirSync(MIG_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

let checkable = 0, skipped = [];
for (const f of files) {
  /* 0001 creates the tracking table itself and is a special case: install.sql
     carries it because production has it, but it is not "a migration's effect"
     in the sense this test is about. Checked anyway — it must be there. */
  const sql = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
  const sigs = signatures(sql);
  if (!sigs.length) { skipped.push(f.slice(0, 4)); continue; }
  checkable++;

  /* Whole word, not substring. indexOf() said `current_user_can_page` was
     present in a file that only contained `current_user_can_page_REMOVED`,
     which meant a renamed or truncated object read as a healthy one — the
     mutation test caught this test failing to catch anything.
     Policy names carry spaces and punctuation, so those are matched literally;
     identifiers get boundaries. */
  const present = (s) => (/^[a-z0-9_]+$/i.test(s)
    ? new RegExp('(^|[^a-z0-9_])' + s + '($|[^a-z0-9_])', 'i').test(install)
    : install.indexOf(s) !== -1);
  const missing = sigs.filter((s) => !present(s));
  ok(f.slice(0, 4) + ' — ' + sigs.length + ' object' + (sigs.length === 1 ? '' : 's') + ' present in the snapshot',
    missing.length === 0,
    missing.length
      ? 'missing: ' + missing.join(', ') + '  → install.sql was dumped from a database that had not applied ' + f.slice(0, 4)
      : '');
}

console.log('');
ok('most migrations were actually checkable', checkable >= Math.ceil(files.length / 2),
  'only ' + checkable + ' of ' + files.length + ' had a creatable signature — this check is weaker than it looks');

if (skipped.length) {
  console.log('      (' + skipped.length + ' skipped, no created objects to look for: ' + skipped.join(', ') + ')');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
