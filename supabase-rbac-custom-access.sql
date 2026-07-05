-- Zuwera RBAC v2 — per-employee custom access. RUN AFTER supabase-rbac.sql.
-- Safe / additive. Adds a jsonb column holding an optional per-section override:
--   { "pages": { "products":"edit", "finance":"view", ... }, "color": "#F891A5" }
-- When NULL, the person's access falls back to their admin_role preset, so
-- everyone currently set up keeps working unchanged.

alter table public.profiles
  add column if not exists admin_permissions jsonb;

comment on column public.profiles.admin_permissions is
  'Optional per-section access override for admin RBAC: {pages:{<page>:"view"|"edit"}, color:"#hex"}. NULL = use admin_role preset.';
