# Database & Migrations

Backend is **Supabase Postgres** (project `qfgnrsifcwdubkolsgsq`) with Row Level
Security. Historically, schema changes were applied by pasting SQL into the
Supabase SQL editor. Going forward, treat schema as **versioned migrations**.

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
