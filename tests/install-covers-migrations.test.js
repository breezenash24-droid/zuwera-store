/* The install file has to keep up with the migrations.
 *
 * A generated snapshot rots the moment someone lands a migration and does not
 * regenerate it. That is not hypothetical — it is precisely what happened to the
 * 32 root supabase-*.sql files. They were the install path, they drifted from
 * production, and the drift was invisible until someone tried to stand up a
 * database from them and found nine tables missing.
 *
 * The rot is silent in the worst possible way: install.sql still RUNS, still
 * creates a database, and the store still starts. What is missing is whatever
 * the un-regenerated migration added — a column, a policy — so a licensee gets
 * a database that looks fine and behaves differently. That is strictly worse
 * than one that fails to install.
 *
 * So: every migration in migrations/ must be recorded as applied by install.sql.
 * Landing 0018 without regenerating fails here, with the command to fix it.
 *
 * This is a coverage check, not a correctness one. It cannot tell whether the
 * SQL above those rows actually contains 0018's column — only a diff against
 * production can do that, and that needs a database. What it CAN do is make
 * "somebody forgot" impossible, which is the failure that actually happens.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const INSTALL = path.join(ROOT, 'supabase', 'install.sql');
const MIG_DIR = path.join(ROOT, 'migrations');

const migrations = fs.readdirSync(MIG_DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

console.log('\n  install.sql keeps up with migrations/\n');

if (!fs.existsSync(INSTALL)) {
  /* Not a failure yet. The file needs a production schema dump to generate, and
     until someone runs that command there is nothing to check. Said clearly
     rather than passing in silence, because a green run that checked nothing is
     how this gets forgotten. */
  console.log('  ⚠ supabase/install.sql does not exist yet — nothing to check.');
  console.log('');
  console.log('    A new Supabase project cannot currently be stood up from this repo:');
  console.log('    migrations/0001 marks version 0000 as applied, which is honest here and');
  console.log('    a lie on an empty database, so 0002+ then run against nothing.');
  console.log('');
  console.log('    To generate it:');
  console.log('      pg_dump --schema-only --no-owner --no-privileges "<connection-string>" > schema.sql');
  console.log('      node scripts/build-install-sql.js schema.sql');
  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(0);
}

const sql = fs.readFileSync(INSTALL, 'utf8');

console.log('  every migration is recorded as applied');
{
  const claims = (v) => new RegExp("\\('" + v + "'\\s*,").test(sql);
  const missing = migrations.filter((f) => !claims(f.slice(0, 4)));

  /* NOT a failure, and working out why took getting it wrong first.
     A migration install.sql does not record is SAFE: a new project runs
     install.sql, the runner then sees that version as pending, and applies it.
     The result is correct and self-healing.
     It is also unavoidable in normal work — a migration is written before it is
     applied to production, and install.sql cannot contain effects that do not
     exist yet. Failing here would make every new migration turn CI red until
     somebody ran a manual step, which is how a gate gets routed around. */
  if (missing.length) {
    console.log('  · ' + missing.length + ' migration(s) newer than the snapshot: ' + missing.map((f) => f.slice(0, 4)).join(', '));
    console.log('    Not a fault — the runner will apply them on a new project. Regenerate');
    console.log('    install.sql once they are live, so new stores skip straight to current.');
  } else {
    ok('all ' + migrations.length + ' migrations are recorded', true);
  }

  /* THE DIRECTION THAT IS NOT SAFE. install.sql claiming a version means the
     runner will never apply it — so a claim about a migration that does not
     exist in this repo is a store that will silently never get it. */
  const versions = new Set(migrations.map((f) => f.slice(0, 4)));
  const claimed = [...sql.matchAll(/\('(\d{4})'\s*,/g)].map((m) => m[1]);
  const phantom = claimed.filter((v) => v !== '0000' && !versions.has(v));
  ok('it claims nothing that does not exist', phantom.length === 0,
    phantom.length ? 'claims ' + phantom.join(', ') + ' — the runner would skip a migration this repo does not have' : '');

  /* The baseline row too: without it the runner treats the pre-migration
     history as pending and replays 32 hand-written scripts, several of which
     drop tables. */
  ok('…and the 0000 baseline', /\('0000'\s*,/.test(sql),
    'the runner would try to replay the pre-migration root scripts');
}

console.log('\n  it refuses to run on a database that is in use');
{
  /* install.sql creates a schema from scratch. Pasted into the wrong SQL editor
     it must fail rather than succeed. */
  ok('it checks orders before doing anything', /REFUSING TO RUN[\s\S]{0,200}orders/.test(sql));
  ok('…and products', /REFUSING TO RUN[\s\S]{0,400}products/.test(sql));
  ok('the guard is before the schema, not after it',
    sql.indexOf('REFUSING TO RUN') < sql.indexOf('insert into public.schema_migrations'),
    'a guard that runs last has already done the damage');
}

console.log('\n  it is complete on its own');
{
  /* The whole argument for a snapshot over a replay is that there is no
     ordering rule for anyone to get wrong. That only holds if install.sql
     carries the tracking table and the applier itself. */
  ok('it brings the migration tracking table', /create table[^;]*schema_migrations/i.test(sql),
    'without it the insert at the end has nowhere to go');
  ok('…and the applier the panel calls', /apply_migration/i.test(sql),
    'Admin → APIs → Database migrations would have nothing to call');
  ok('it says not to also run 0001', /DO NOT ALSO RUN migrations\/0001/.test(sql),
    'running both is the ordering trap this design exists to remove');
}

console.log('\n  it is generated, and says so');
{
  ok('marked generated', /GENERATED\. Do not edit by hand/.test(sql));
  ok('…naming the command that regenerates it', /build-install-sql\.js/.test(sql));
  /* A snapshot with no date is one nobody can reason about. */
  ok('…and when it was taken', /Generated \d{4}-\d{2}-\d{2}/.test(sql));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
