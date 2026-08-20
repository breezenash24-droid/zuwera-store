-- ============================================================================
-- 0028 — site_settings.updated_at starts telling the truth
--
-- The column was declared as
--
--     updated_at TIMESTAMPTZ DEFAULT now()
--
-- and a DEFAULT applies on INSERT and never again. site_settings is written by
-- upsert everywhere — the page builder, every admin panel, the Stripe webhook's
-- promo counter — and none of them set the column, so it has recorded the
-- moment each key was FIRST created and has not moved since.
--
-- A column named updated_at that does not track updates is not a cosmetic
-- problem, because something depends on it.
--
-- ── WHAT IT BROKE ───────────────────────────────────────────────────────────
--
-- The header's arrangement reaches the first frame from two places, and they
-- can each be the stale one:
--
--   BAKED   scripts/stamp-header-layout.js writes it into the HTML at deploy
--           time, which is the only thing that can help a first-ever visitor.
--   CACHED  what this browser last heard the server say.
--
-- Publishing without deploying leaves the bake stale; a visitor who has not
-- been back since a change has a stale cache. Neither is reliably fresher, so
-- both carry the row's updated_at and the pre-paint block in <head> ranks them
-- rather than picking a favourite:
--
--     if (!_hb || (_hc[4] || '') > _hb) { …apply the cache… }
--
-- Strictly greater, because equal means "the same answer" and there is nothing
-- to do. With the column frozen, the cache and the bake ALWAYS carried the same
-- string, so that test was always false and the cache could never win. The
-- pre-paint block kept stamping the deployed arrangement before every paint,
-- and the correction only arrived from the runtime fetch — after the frame.
--
-- Observed on the live shop: site_settings.header_layout read back as
-- "logo-center" with order "search account bag", an hour after the same row had
-- read "all-left" with order "bag search account", both stamped
--
--     updated_at = 2026-08-19T03:19:38.942998+00:00
--
-- The value moved twice; the timestamp did not move at all. So every reload
-- showed the OLD arrangement and the OLD icon order for a moment before the
-- fetch corrected it, and reloading again did not help — the ranking that
-- exists to make the second reload clean was comparing a string with itself.
--
-- ── WHY A TRIGGER AND NOT A FIX IN THE WRITERS ──────────────────────────────
--
-- There are more than thirty upserts against this table across admin-main.js,
-- the page-builder endpoint and the edge functions. Teaching each of them to
-- stamp the column would mean the next one written is wrong again, and the
-- column would be accurate only for the callers somebody remembered. What
-- updated_at MEANS belongs to the table, so it is maintained by the table.
--
-- functions/api/save-page-builder.js also sets it explicitly, so the builder is
-- correct on a shop that has not run this migration yet. The two do not fight:
-- the trigger runs last and wins, with the same value to within a round trip.
--
-- Idempotent, and safe to re-run.
-- ============================================================================

create or replace function public.zw_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists zw_site_settings_touch_updated_at on public.site_settings;

create trigger zw_site_settings_touch_updated_at
  before insert or update on public.site_settings
  for each row
  execute function public.zw_touch_updated_at();

-- The rows that already exist carry a creation date, not a modification date,
-- and there is no way to recover when each was last written. Left alone rather
-- than stamped with now(): pretending every setting changed at the moment this
-- migration ran would tell every cached browser that its copy is stale and make
-- the whole shop re-read settings it already has. The first write after this
-- point is what makes each row honest, and for the header that is the next
-- Publish.
