#!/usr/bin/env node
/**
 * build-install-sql.js — turn a production schema dump into supabase/install.sql
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * You cannot currently create a working Zuwera database from this repository.
 *
 * migrations/0001 ends by inserting a row marking version '0000' as applied,
 * meaning "the schema is whatever it is today". On THIS database that is honest:
 * 32 root supabase-*.sql files were applied by hand in an order nobody recorded,
 * several are destructive, and marking them applied stops the runner replaying
 * them. On an EMPTY project it is a lie — it claims a baseline that does not
 * exist, and then 0002–0017 run against nothing: ALTER TABLE orders, CREATE
 * POLICY ON products, on tables nothing ever created.
 *
 * The obvious fixes are both worse than this one:
 *
 *   "Run 0000 first, then 0001" adds a second hand-run file and an ordering
 *   rule, to a system whose entire thesis is that a step someone has to
 *   remember is the step that gets skipped. 0001 says so in its own header.
 *
 *   "Make 0001 baseline only when tables exist" keeps new projects replaying
 *   0002–0017 against an empty database — a sequence that has never once been
 *   run that way and is tested by nothing. That is where ordering bugs live:
 *   0004 assuming something 0011 later changed, working only because production
 *   was not empty when it ran.
 *
 * So a new project is INSTALLED, not migrated. install.sql is a snapshot of the
 * current schema plus rows marking every migration through HEAD as already
 * applied — because the snapshot already contains their effects. Nothing
 * replays. 0001 is untouched, no probe, no conditional, and this database is
 * not involved.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *
 *   pg_dump --schema-only --no-owner --no-privileges \
 *     "postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres" \
 *     > schema.sql
 *   node scripts/build-install-sql.js schema.sql
 *
 * Supabase → Project Settings → Database has the connection string. Read-only:
 * this reads the dump and writes one file. It never touches a database.
 *
 * Regenerate whenever a migration lands. tests/install-covers-migrations.test.js
 * fails if you forget, which is the only thing that stops this rotting the way
 * the 32 root files did.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'supabase', 'install.sql');
const MIGRATIONS = path.join(ROOT, 'migrations');

const src = process.argv[2];
if (!src) {
  console.error('\nusage: node scripts/build-install-sql.js <schema-dump.sql>\n');
  console.error('  pg_dump --schema-only --no-owner --no-privileges "<connection-string>" > schema.sql\n');
  process.exit(1);
}
if (!fs.existsSync(src)) { console.error('No such file: ' + src); process.exit(1); }

const dump = fs.readFileSync(src, 'utf8');

/* A dump that does not mention the core tables is not a dump of this database —
   an empty file, the wrong project, or pg_dump erroring into stdout. Writing it
   out would produce an install file that silently creates nothing. */
for (const t of ['orders', 'products', 'profiles', 'site_settings']) {
  if (!new RegExp('CREATE TABLE[^;]*\\b' + t + '\\b', 'i').test(dump)) {
    console.error('\nRefusing to build: the dump has no CREATE TABLE for `' + t + '`.');
    console.error('That is not a schema dump of this project.\n');
    process.exit(1);
  }
}

const versions = fs.readdirSync(MIGRATIONS)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort()
  .map((f) => ({ version: f.slice(0, 4), name: f.slice(5, -4), file: f }));

if (!versions.length) { console.error('No migrations found in migrations/'); process.exit(1); }

const rows = [["'0000'", "'baseline_pre_migration_system'"]]
  .concat(versions.map((m) => ["'" + m.version + "'", "'" + m.name.replace(/'/g, "''") + "'"]))
  .map(([v, n]) => '  (' + v + ', ' + n + ", 'installed', 'install.sql')")
  .join(',\n');

const header = `-- ============================================================================
-- install.sql — stand up a NEW Zuwera database.
--
-- GENERATED. Do not edit by hand: run
--     node scripts/build-install-sql.js <schema-dump.sql>
-- and commit the result. Hand edits are lost on the next regeneration and,
-- worse, make this file disagree with production — which is exactly how the 32
-- root supabase-*.sql files stopped being able to rebuild anything.
--
-- WHAT THIS IS FOR
--   A new project: a licensee, a second store, a restore into a fresh Supabase
--   project. Run this ONCE, in the SQL editor. It is the ONLY thing you run —
--   do not also run migrations/0001, which is for databases that predate the
--   migration system. Everything 0001 creates is already in here.
--
-- WHAT THIS IS NOT FOR
--   An existing database. To change one, add a file to migrations/ and apply it
--   from Admin → APIs → Database migrations. The guard below refuses to run if
--   any core table already holds rows, so a paste into the wrong SQL editor
--   fails loudly instead of succeeding catastrophically.
--
-- WHY A SNAPSHOT RATHER THAN REPLAYING THE MIGRATIONS
--   The migration chain only ever ran on top of a schema that already existed.
--   Replaying it against an empty database is a sequence nobody has executed and
--   nothing tests. This file is the finished state, and it ends by recording
--   every migration through HEAD as applied — so the runner has nothing pending
--   and never replays history it was not written for.
--
-- Generated ${new Date().toISOString().slice(0, 10)} from a production schema dump.
-- ============================================================================

do $$
declare
  n bigint;
begin
  if to_regclass('public.orders') is not null then
    execute 'select count(*) from public.orders' into n;
    if n > 0 then
      raise exception using
        message = 'REFUSING TO RUN: public.orders already contains ' || n || ' row(s).',
        hint    = 'install.sql is for a NEW project. To change an existing database, add a file to migrations/ and apply it from Admin -> APIs -> Database migrations.';
    end if;
  end if;

  if to_regclass('public.products') is not null then
    execute 'select count(*) from public.products' into n;
    if n > 0 then
      raise exception using
        message = 'REFUSING TO RUN: public.products already contains ' || n || ' row(s).',
        hint    = 'install.sql is for a NEW project. Use migrations/ for changes to an existing database.';
    end if;
  end if;
end
$$;

`;

const footer = `

-- ============================================================================
-- Record what this snapshot already contains.
--
-- Every migration through HEAD is marked applied because their effects are in
-- the schema above. Without this the runner would try to replay them against a
-- database that already has them — the ALTERs would fail, and a half-applied
-- chain is harder to diagnose than a failed one.
--
-- checksum is 'installed' rather than the file's real hash on purpose: this
-- database did not run that file, it was born with the result. A fabricated
-- checksum would make the migrations panel claim a history that did not happen,
-- which is the same dishonesty the 0000 baseline row was careful to avoid.
--
-- DO NOT ALSO RUN migrations/0001. schema_migrations and apply_migration() are
-- both in the snapshot above — they exist in production, so pg_dump brought
-- them along. This file is complete on its own, and that is the point: one
-- file, run once, with no ordering rule for anyone to get wrong.
-- ============================================================================

insert into public.schema_migrations (version, name, checksum, applied_by)
values
${rows}
on conflict (version) do nothing;
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, header + dump.trim() + footer, 'utf8');

console.log('\n  wrote supabase/install.sql');
console.log('  schema:     ' + (dump.length / 1024).toFixed(0) + ' KB from ' + path.basename(src));
console.log('  recorded:   0000 baseline + ' + versions.length + ' migrations (through ' + versions[versions.length - 1].version + ')');
console.log('\n  New project: run supabase/install.sql in the SQL editor. That is all —');
console.log('  it already contains everything migrations/0001 would have created.\n');
