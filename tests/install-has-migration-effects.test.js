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

let checkable = 0, skipped = [], notClaimed = [];
for (const f of files) {
  /* Only migrations install.sql SAYS it contains. One it does not claim is
     pending as far as the runner is concerned, so it will be applied on a new
     project and its absence from the snapshot is correct rather than a fault —
     which is exactly the state every migration is in between being written and
     being applied to production.

     The contradiction worth catching is the other way round: a version claimed
     as applied whose objects are nowhere in the schema. The runner skips those
     for ever, so the store is silently missing the change. */
  if (!new RegExp("\\('" + f.slice(0, 4) + "'\\s*,").test(install)) { notClaimed.push(f.slice(0, 4)); continue; }
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
/* MEASURED AGAINST WHAT THE SNAPSHOT CLAIMS, not against every migration ever
   written. This counted `checkable >= half of ALL files`, so each new migration
   moved the bar up while leaving the numerator alone — the ratio fell for a
   reason that has nothing to do with this check's strength, and it went red on
   the migration that happened to cross the halfway line rather than on anything
   being wrong. Two different facts were sharing one number.
   How far behind the snapshot is, is the DRIFT_BUDGET's question, and it is
   asked properly below. What belongs here is the one this assertion is named
   after: of the migrations install.sql actually claims to contain, did we
   verify a real share of them, or is this passing on three files out of
   seventeen? */
const claimed = files.length - notClaimed.length;
ok('most of what the snapshot claims was actually checkable',
  checkable >= Math.ceil(claimed / 2),
  'only ' + checkable + ' of the ' + claimed + ' migrations install.sql claims had a creatable '
  + 'signature — this check is weaker than it looks');

if (skipped.length) {
  console.log('      (' + skipped.length + ' skipped, no created objects to look for: ' + skipped.join(', ') + ')');
}
if (notClaimed.length) {
  console.log('      (' + notClaimed.length + ' newer than the snapshot, so not claimed by it: ' + notClaimed.join(', ') + ')');
  console.log('       The runner applies those on a new project. Regenerate install.sql once they are live.');
}

/* ── AND THE DRIFT IS BUDGETED, not merely mentioned ────────────────────────
 *
 * The line above has been printing for weeks and everything stayed green, so
 * it said the true thing and changed nothing. Five migrations post-dating the
 * snapshot is survivable — the runner applies them on a new project, which is
 * why this is a budget and not a failure. Fifteen is a snapshot nobody trusts,
 * and the way you get there is one at a time with a passing test each time.
 *
 * So the count may not GROW. Add a migration and this fails until install.sql
 * is regenerated, which is the only moment anybody is thinking about it.
 *
 * REGENERATING NEEDS A LIVE DATABASE and cannot be done from the repo:
 *
 *     SUPABASE_DB_URL=... SUPABASE_DB_PASSWORD=... node scripts/dump-schema.js
 *     node scripts/build-install-sql.js schema.sql
 *
 * `supabase db dump` needs Docker, which is why dump-schema.js exists at all.
 * schema.sql is gitignored: it is the input, not the artifact.
 *
 * Lower this number when you regenerate. It only ever goes down. */
/* 6 → 7 for migration 0024 (wholesale), 7 → 8 for 0025 (price list rules),
   8 → 9 for 0026 (text_overrides on the public-read allow-list).
   This is the budget WORKING, not failing: it made the cost of adding a
   migration visible at the moment of adding one, which is the only moment
   anybody is thinking about install.sql. The rule stays 'it only goes down' —
   these are the documented exceptions, and the way to honour it is to
   regenerate the snapshot and drop this to 0.

   Regenerating needs a pg_dump of the live database, which needs the database
   password — so it cannot be done from here and is not something a build step
   can quietly fix. It is one command, recorded in scripts/build-install-sql.js,
   and every migration past 0017 is a thing a NEW project does not get until
   somebody runs it. That is the real cost this number is counting. */
const DRIFT_BUDGET = 9;
ok('install.sql has not fallen further behind', notClaimed.length <= DRIFT_BUDGET,
  notClaimed.length + ' migrations post-date the snapshot (budget ' + DRIFT_BUDGET + ') — '
  + 'regenerate it, then lower DRIFT_BUDGET to ' + notClaimed.length);

/* The other half, and the one nobody can automate from in here: coverage
   proves each migration is RECORDED, never that the SQL beside it is current.
   A column added by hand in the dashboard, a policy edited in the UI, a type
   changed during an incident — none of that is a migration, and none of it
   shows up above. Only a diff of a fresh install against production finds it,
   and that needs two live databases. Stated here so the gap is a known shape
   rather than a thing the green tick implies is covered. */
console.log('\n      What this still cannot tell you: whether the SQL matches production.');
console.log('      Coverage proves the migrations are recorded. Only a diff of a fresh');
console.log('      install against the live database proves the schema is current, and');
console.log('      that needs two databases this test does not have.');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
