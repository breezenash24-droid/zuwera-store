#!/usr/bin/env node
/**
 * dump-schema.js — write the public schema out as SQL, using only Node.
 *
 * ── WHY NOT pg_dump ─────────────────────────────────────────────────────────
 *
 * pg_dump is the right tool and this is not trying to replace it. It is here
 * because getting it onto this machine turned into a yak shave:
 *
 *   `supabase db dump` runs pg_dump INSIDE A DOCKER CONTAINER, so it fails with
 *   "Docker Desktop is unable to start" on a machine with no working Docker.
 *   Installing PostgreSQL just for one binary is a heavy answer to a small
 *   question, and Docker Desktop is heavier still.
 *
 * Node is already here. `pg` is 14 packages. So this asks Postgres to describe
 * itself and writes the answer down.
 *
 * ── HOW IT STAYS HONEST ─────────────────────────────────────────────────────
 *
 * Almost nothing here is hand-written SQL generation. Postgres can already
 * render canonical definitions for most objects — pg_get_constraintdef,
 * pg_get_indexdef, pg_get_functiondef, pg_get_triggerdef, pg_get_viewdef — so
 * those are asked for verbatim rather than reconstructed. The only thing this
 * file really composes is CREATE TABLE column lists, and it reads types through
 * format_type(), which is the same function pg_dump uses.
 *
 * What that leaves is a COMPLETENESS risk rather than a correctness one: an
 * object kind nobody thought of is silently absent. So it prints a census of
 * everything it wrote, and refuses to produce a file if the counts look wrong.
 * Check the census against the Supabase dashboard before trusting the result.
 *
 * Ordering matters and is deliberate: extensions and enums exist before the
 * tables that use them, tables exist before the foreign keys that reference
 * them, and every table exists before any policy names it.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *
 *   PowerShell:
 *     $env:SUPABASE_DB_URL="postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres"
 *     node scripts/dump-schema.js
 *
 * Use the SESSION POOLER string from Supabase → Project Settings → Database.
 * Direct connections (db.<ref>.supabase.co) are IPv6-only on the free tier, and
 * most home networks cannot reach them — that failure looks like a hang.
 *
 * The URL is read from the environment rather than argv so the password does
 * not end up in shell history.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const OUT = path.resolve(__dirname, '..', 'schema.sql');
let url = process.env.SUPABASE_DB_URL || process.argv[2];

/* Let the password be supplied separately, and prefer it when it is.
   A Postgres URL is a URL: a password containing @ / : ? # % or a space has to
   be percent-encoded inside one, and the failure when it is not is not
   "wrong password" — it is a parse error naming a host you have never heard of,
   because everything after the stray @ was read as the hostname. Supabase
   generates passwords with symbols in them, so this is the common case, not the
   exotic one. */
if (url && process.env.SUPABASE_DB_PASSWORD) {
  const pw = encodeURIComponent(process.env.SUPABASE_DB_PASSWORD);
  url = url.replace(/^(postgres(?:ql)?:\/\/[^:/@]+):[^@]*@/, '$1:' + pw + '@');
}
/* The placeholder left in as-is. Better to say so than to try connecting with
   the literal string "[YOUR-PASSWORD]" and report an authentication failure. */
if (url && /\[YOUR-PASSWORD\]|\[your-password\]/i.test(url)) {
  console.error('\n  The connection string still contains [YOUR-PASSWORD].\n');
  console.error('  Replace that whole placeholder, brackets included, with your database password —');
  console.error('  or leave it there and set the password separately instead:\n');
  console.error('    $env:SUPABASE_DB_PASSWORD="your password"\n');
  process.exit(1);
}

if (!url) {
  console.error('\n  Set SUPABASE_DB_URL first.\n');
  console.error('  PowerShell:');
  console.error('    $env:SUPABASE_DB_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"');
  console.error('    node scripts/dump-schema.js\n');
  console.error('  Get it from Supabase -> Project Settings -> Database -> Connection string -> Session pooler.\n');
  process.exit(1);
}

/* No bind parameters anywhere in this file, on purpose. node-postgres sends
   parameterised queries over the extended protocol, which Supabase's TRANSACTION
   pooler (port 6543) does not support — the failure is an opaque "prepared
   statement does not exist" partway through. Session mode is the right choice
   and the instructions say so, but there is no reason to make this file break on
   the wrong one when every value it interpolates comes from pg_catalog and is
   quoted below. */
const q = (client, sql) => client.query(sql).then((r) => r.rows);
const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

(async () => {
  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },   // Supabase terminates TLS with its own chain
    statement_timeout: 60000,
  });

  try {
    await client.connect();
  } catch (e) {
    console.error('\n  Could not connect: ' + e.message + '\n');
    if (/ENOTFOUND|EHOSTUNREACH|ENETUNREACH|timeout/i.test(e.message)) {
      console.error('  If the host is db.<ref>.supabase.co, that is IPv6-only on the free tier.');
      console.error('  Use the SESSION POOLER string instead (aws-0-<region>.pooler.supabase.com).\n');
    }
    if (/password|authentication/i.test(e.message)) {
      console.error('  That is the DATABASE password, not your Supabase account password.');
      console.error('  Reset it at Project Settings -> Database if needed; it does not affect the API keys.\n');
    }
    process.exit(1);
  }

  const out = [];
  const census = {};
  const say = (s) => out.push(s);

  say('--\n-- Zuwera public schema. Generated by scripts/dump-schema.js on '
    + new Date().toISOString().slice(0, 10) + '.\n--\n');

  /* ── extensions ── before anything that might call into them ── */
  const exts = await q(client, `
    select e.extname, n.nspname
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where e.extname not in ('plpgsql')
    order by e.extname`);
  census.extensions = exts.length;
  if (exts.length) {
    say('-- extensions');
    for (const e of exts) say(`create extension if not exists ${ident(e.extname)} with schema ${ident(e.nspname)};`);
    say('');
  }

  /* ── enums / composite types ── before the columns that use them ── */
  const enums = await q(client, `
    select t.typname,
           array_agg(e.enumlabel order by e.enumsortorder) as labels
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
    group by t.typname order by t.typname`);
  census.enums = enums.length;
  if (enums.length) {
    say('-- enum types');
    for (const t of enums) {
      say(`create type public.${ident(t.typname)} as enum (`
        + t.labels.map((l) => "'" + String(l).replace(/'/g, "''") + "'").join(', ') + ');');
    }
    say('');
  }

  /* ── sequences owned by nothing (serial columns bring their own) ── */
  const seqs = await q(client, `
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'S' and n.nspname = 'public'
      and not exists (
        select 1 from pg_depend d
        where d.objid = c.oid and d.deptype = 'a')
    order by c.relname`);
  census.sequences = seqs.length;
  if (seqs.length) {
    say('-- sequences');
    for (const s of seqs) say(`create sequence if not exists public.${ident(s.relname)};`);
    say('');
  }

  /* ── tables ──
     Columns via format_type(), which is what pg_dump uses, so a citext or a
     numeric(10,2) comes back spelled the way Postgres spells it. */
  const tables = await q(client, `
    select c.relname, c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r' and n.nspname = 'public'
    order by c.relname`);
  census.tables = tables.length;

  say('-- tables');
  for (const t of tables) {
    const cols = await q(client, `
      select a.attname,
             format_type(a.atttypid, a.atttypmod) as coltype,
             a.attnotnull,
             pg_get_expr(d.adbin, d.adrelid) as coldefault,
             a.attidentity
      from pg_attribute a
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = ('public.' || quote_ident(${lit(t.relname)}))::regclass
        and a.attnum > 0 and not a.attisdropped
      order by a.attnum`);

    const lines = cols.map((c) => {
      let s = '  ' + ident(c.attname) + ' ' + c.coltype;
      if (c.attidentity === 'a') s += ' generated always as identity';
      else if (c.attidentity === 'd') s += ' generated by default as identity';
      else if (c.coldefault) s += ' default ' + c.coldefault;
      if (c.attnotnull) s += ' not null';
      return s;
    });
    say(`create table if not exists public.${ident(t.relname)} (\n${lines.join(',\n')}\n);`);
  }
  say('');

  /* ── constraints ──
     Primary keys, unique and check first; foreign keys last, so every table a
     key points at already exists. pg_get_constraintdef renders each one. */
  const cons = await q(client, `
    select c.conname, c.contype, rel.relname as tablename,
           pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public'
    order by case c.contype when 'p' then 0 when 'u' then 1 when 'c' then 2 else 3 end,
             rel.relname, c.conname`);
  census.constraints = cons.length;
  if (cons.length) {
    say('-- constraints');
    for (const c of cons) {
      say(`alter table public.${ident(c.tablename)} add constraint ${ident(c.conname)} ${c.def};`);
    }
    say('');
  }

  /* ── indexes ── skipping those a constraint already created ── */
  const idx = await q(client, `
    select i.indexname, i.indexdef
    from pg_indexes i
    where i.schemaname = 'public'
      and not exists (
        select 1 from pg_constraint c
        where c.conname = i.indexname
          and c.connamespace = 'public'::regnamespace)
    order by i.indexname`);
  census.indexes = idx.length;
  if (idx.length) {
    say('-- indexes');
    for (const i of idx) say(i.indexdef.replace(/^CREATE (UNIQUE )?INDEX /i, (m) => m.toLowerCase()) + ';');
    say('');
  }

  /* ── functions ── verbatim from Postgres ── */
  const fns = await q(client, `
    select pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind in ('f','p')
    order by p.proname`);
  census.functions = fns.length;
  if (fns.length) {
    say('-- functions');
    for (const f of fns) say(f.def + ';\n');
    say('');
  }

  /* ── views ── */
  const views = await q(client, `
    select table_name, view_definition from information_schema.views
    where table_schema = 'public' order by table_name`);
  census.views = views.length;
  if (views.length) {
    say('-- views');
    for (const v of views) say(`create or replace view public.${ident(v.table_name)} as\n${v.view_definition}`);
    say('');
  }

  /* ── triggers ── after the functions they call ── */
  const trgs = await q(client, `
    select pg_get_triggerdef(t.oid) as def
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
    order by t.tgname`);
  census.triggers = trgs.length;
  if (trgs.length) {
    say('-- triggers');
    for (const t of trgs) say(t.def + ';');
    say('');
  }

  /* ── row level security ──
     This is the half that decides who can read what. A dump that quietly
     omitted it would produce a database that WORKS and is wide open, which is
     the worst possible way to be wrong. */
  const rlsOn = tables.filter((t) => t.relrowsecurity);
  census.rls_enabled_tables = rlsOn.length;
  if (rlsOn.length) {
    say('-- row level security');
    for (const t of rlsOn) say(`alter table public.${ident(t.relname)} enable row level security;`);
    say('');
  }

  const pols = await q(client, `
    select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
    from pg_policies where schemaname = 'public'
    order by tablename, policyname`);
  census.policies = pols.length;
  if (pols.length) {
    say('-- policies');
    for (const p of pols) {
      let s = `create policy ${ident(p.policyname)} on public.${ident(p.tablename)}`;
      if (p.permissive && p.permissive.toUpperCase() === 'RESTRICTIVE') s += ' as restrictive';
      s += ` for ${String(p.cmd || 'ALL').toLowerCase()}`;
      const roles = Array.isArray(p.roles) ? p.roles : String(p.roles || '').replace(/[{}]/g, '').split(',').filter(Boolean);
      if (roles.length && roles.join(',') !== 'public') s += ' to ' + roles.map(ident).join(', ');
      if (p.qual) s += ` using (${p.qual})`;
      if (p.with_check) s += ` with check (${p.with_check})`;
      say(s + ';');
    }
    say('');
  }

  /* ── grants ── what anon and authenticated may touch at all ── */
  const grants = await q(client, `
    select grantee, table_name, string_agg(privilege_type, ', ' order by privilege_type) as privs
    from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon','authenticated','service_role')
    group by grantee, table_name order by table_name, grantee`);
  census.grants = grants.length;
  if (grants.length) {
    say('-- grants');
    for (const g of grants) {
      say(`grant ${g.privs.toLowerCase()} on public.${ident(g.table_name)} to ${ident(g.grantee)};`);
    }
    say('');
  }

  await client.end();

  /* A dump missing the tables this store cannot run without is not a dump.
     Failing here beats writing a file that installs a database with no orders
     table and lets somebody find out later. */
  const required = ['orders', 'products', 'profiles', 'site_settings', 'product_sizes'];
  const got = new Set(tables.map((t) => t.relname));
  const missing = required.filter((t) => !got.has(t));
  if (missing.length) {
    console.error('\n  Refusing to write: core tables missing from the dump — ' + missing.join(', '));
    console.error('  Connected to the wrong project, or the role cannot see public.\n');
    process.exit(1);
  }

  fs.writeFileSync(OUT, out.join('\n'), 'utf8');

  console.log('\n  wrote schema.sql  (' + (out.join('\n').length / 1024).toFixed(0) + ' KB)\n');
  for (const k of Object.keys(census)) {
    console.log('    ' + String(census[k]).padStart(4) + '  ' + k.replace(/_/g, ' '));
  }
  console.log('\n  Check those counts look right, then:');
  console.log('    node scripts/build-install-sql.js schema.sql\n');
})().catch((e) => {
  console.error('\n  dump failed: ' + (e && e.message) + '\n');
  process.exit(1);
});
