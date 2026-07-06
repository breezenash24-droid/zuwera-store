# Supabase migrations

Versioned, forward-only schema changes. See [../../docs/DATABASE.md](../../docs/DATABASE.md)
for the full workflow and the applied baseline (the root `supabase-*.sql` files).

## Apply

With the Supabase CLI (recommended):
```bash
supabase link --project-ref qfgnrsifcwdubkolsgsq
supabase db push
```

Or, without the CLI: paste each unapplied file (in filename order) into the
Supabase SQL editor and run it.

## Conventions
- Filename: `<UTC timestamp>_<snake_case_description>.sql` (timestamp = ordering).
- Idempotent where possible (`create table if not exists`, `add column if not exists`).
- One logical change per file. Never edit an applied migration — add a new one.
- Commit the migration in the same PR as the feature that needs it.

## Pending
| File | Adds |
|------|------|
| `20260703000000_add_error_log_table.sql` | `error_log` table for self-hosted runtime error tracking (used by `/api/log-error`) |
