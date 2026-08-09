# Database & Migrations

Backend is **Supabase Postgres** with Row Level Security.

## How to change the schema

1. Add a file to `migrations/`, named `<version>_<name>.sql` — e.g.
   `0003_add_gift_cards.sql`. Use the next free number.
2. Write it **idempotently** (`if not exists`, `create or replace`, `drop policy
   if exists` before `create policy`). It should survive being run twice.
3. Commit it. `npm run build:migrations` bundles `migrations/*.sql` into
   `functions/api/_migrations.js`; `postinstall` does this on every deploy, so
   the bundle cannot drift from the files.
4. Deploy, then open **Admin → APIs → Database migrations** and press
   **Apply pending**.

That last step is a button rather than a terminal command on purpose. The
failure this system exists to prevent is not "the SQL was wrong" — it is
**nobody ran it**. The live RLS policy had drifted from every `.sql` file in
this repository: `fit_finder` and `integrations` were read by the storefront but
missing from the policy, so Find Your Size quietly answered from built-in
defaults and the integrations module loaded nothing, for weeks, with no error
anywhere. A repository that claims something about production which is not true
is worse than one that claims nothing.

### One-time setup, per project

Run `migrations/0001_migration_tracking.sql` in the Supabase SQL editor **once**.
It creates `schema_migrations` and the `apply_migration()` function, records
itself, and baselines the historical root-level `.sql` files as already applied
so nothing destructive is replayed. Everything after that applies from the admin.

The admin panel will tell you if this hasn't been done — it can detect the
missing table and says exactly which file to run.

### Rules worth knowing

- **Never edit an applied migration.** Checksums are recorded, and the panel
  flags a mismatch loudly: it means the repo and production disagree about what
  that version did. Correct it with a *new* migration.
- **Migrations stop at the first failure.** The ones after it stay pending, and
  the schema is exactly where the failed one left it. Fix and re-apply.
- **`supabase-master-schema.sql` is for new projects only.** It drops every
  table. It now refuses to run if `orders` or `products` contain rows, so a
  paste into the wrong SQL editor fails instead of destroying a live store.

### Why not the Supabase CLI

The CLI is a good tool and this keeps its file layout, so moving to
`supabase db push` later is a rename away. It was not adopted as the primary
path because it needs Docker for a local shadow database and a terminal command
at deploy time — and a step someone has to remember is the step that got skipped
here already.

## Applied baseline (root `.sql` files)
These are the historical, already-applied scripts. Keep them for reference; do
**not** blindly re-run (many are not idempotent).

| File | Purpose |
|------|---------|
| `supabase-master-schema.sql` | Core tables (products, orders, profiles, …) |
| `supabase-setup.sql` | Initial setup |
| `supabase-migration-v2.sql`, `supabase-migration-media.sql` | Earlier schema changes |
| `supabase-security-hardening.sql` | RLS hardening |
| `supabase-rbac.sql`, `supabase-rbac-custom-access.sql` | RBAC: `profiles.admin_role` + `admin_permissions` |
| `supabase-profiles-rls-hardening.sql` | Super-admin-only profile management; block self-role-escalation |
| `supabase-admin-audit-log.sql` | `admin_audit_log` table |

## Going forward: use the Supabase CLI

```bash
npm i -g supabase
supabase login
supabase link --project-ref qfgnrsifcwdubkolsgsq
# author a change:
supabase migration new add_error_log_table   # creates supabase/migrations/<ts>_add_error_log_table.sql
# edit the file, then apply to production:
supabase db push
```

Rules:
- **One migration = one committed file** in `supabase/migrations/`, timestamp-ordered.
- Migrations are **forward-only and idempotent where possible** (`create table if
  not exists`, `alter table … add column if not exists`).
- Never edit an already-applied migration; add a new one.
- Commit the migration in the same PR as the code that needs it, so CI/preview
  and schema move together.

Pending migrations that ship with features live in `supabase/migrations/` (e.g.
the `error_log` table for runtime error tracking). Apply them with `supabase db
push` (or paste into the SQL editor if you're not using the CLI yet).

## Backups & restore  {#restore}
- **Primary:** enable Supabase **Point-in-Time Recovery** (Pro plan) — restore the
  DB to any moment in the retention window. This is the enterprise safety net.
- **Secondary:** the deployed `backup-export` edge function (x-backup-token gated)
  exports to a Google Sheet + a private GitHub repo. Good for portability, not a
  substitute for PITR.
- **Rehearse a restore** at least once so the runbook is real: restore into a
  Supabase **branch**/staging project, confirm row counts and a spot-check query,
  document how long it took. An untested backup is not a backup.
