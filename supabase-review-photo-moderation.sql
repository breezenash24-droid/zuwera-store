-- ============================================================================
-- Review photo moderation — approval gate for review photos.
--
-- Adds reviews.photos_approved (default false). The storefront shows a review's
-- photos only once they're approved (when review_settings.photoApproval is on,
-- which is the default). Admins approve/remove photos in Admin → Reviews.
--
-- A guard trigger forces photos_approved back to false for any non-admin insert
-- or update, so shoppers can't self-approve their own photos.
--
-- NOTE: applied live via the Supabase connector; this file is the record.
-- ============================================================================

alter table public.reviews
  add column if not exists photos_approved boolean not null default false;

create or replace function public.reviews_guard_photo_approval()
returns trigger language plpgsql security definer as $$
begin
  if not public.current_user_is_admin() then
    new.photos_approved := false;
  end if;
  return new;
end $$;

drop trigger if exists reviews_photo_approval_guard on public.reviews;
create trigger reviews_photo_approval_guard
  before insert or update on public.reviews
  for each row execute function public.reviews_guard_photo_approval();
