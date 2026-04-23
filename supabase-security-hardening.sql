-- ZUWERA security hardening migration
-- Run this once in the Supabase SQL Editor for an existing database.

CREATE OR REPLACE FUNCTION public.current_user_is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.prevent_profile_role_self_change()
RETURNS TRIGGER AS $$
BEGIN
  IF auth.uid() = NEW.id
     AND NEW.role IS DISTINCT FROM OLD.role
     AND NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'Only admins can change profile roles';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS protect_profile_role_self_change ON public.profiles;
CREATE TRIGGER protect_profile_role_self_change
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.prevent_profile_role_self_change();

-- Undo the old "everyone is admin" migration by restoring non-owner accounts.
UPDATE public.profiles
SET role = 'customer'
WHERE lower(coalesce(email, '')) NOT IN ('breezenash24@gmail.com', 'nasirubreeze@zuwera.store')
  AND role = 'admin';

-- Promote only exact owner emails.
INSERT INTO public.profiles (id, email, role)
SELECT id, email, 'admin'
FROM auth.users
WHERE lower(email) IN ('breezenash24@gmail.com', 'nasirubreeze@zuwera.store')
ON CONFLICT (id) DO UPDATE SET email = excluded.email, role = 'admin';

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.color_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_sizes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.size_charts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read profiles" ON public.profiles;
DROP POLICY IF EXISTS "Users read own profile" ON public.profiles;
DROP POLICY IF EXISTS "Admins read profiles" ON public.profiles;
DROP POLICY IF EXISTS "Users update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Admins manage profiles" ON public.profiles;

CREATE POLICY "Users read own profile" ON public.profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Admins read profiles" ON public.profiles
  FOR SELECT TO authenticated
  USING (public.current_user_is_admin());

CREATE POLICY "Users update own profile" ON public.profiles
  FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Admins manage profiles" ON public.profiles
  FOR ALL TO authenticated
  USING (public.current_user_is_admin())
  WITH CHECK (public.current_user_is_admin());

DROP POLICY IF EXISTS "Authenticated users can insert products" ON public.products;
DROP POLICY IF EXISTS "Authenticated users can update products" ON public.products;
DROP POLICY IF EXISTS "Authenticated users can delete products" ON public.products;
DROP POLICY IF EXISTS "Owner admins can insert products" ON public.products;
DROP POLICY IF EXISTS "Owner admins can update products" ON public.products;
DROP POLICY IF EXISTS "Owner admins can delete products" ON public.products;
DROP POLICY IF EXISTS "Admin full access" ON public.products;

CREATE POLICY "Admin full access" ON public.products
  FOR ALL TO authenticated
  USING (public.current_user_is_admin())
  WITH CHECK (public.current_user_is_admin());

DROP POLICY IF EXISTS "Admin full access" ON public.product_images;
DROP POLICY IF EXISTS "Admin full access" ON public.color_variants;
DROP POLICY IF EXISTS "Admin full access" ON public.product_sizes;
DROP POLICY IF EXISTS "Admin full access" ON public.size_charts;
DROP POLICY IF EXISTS "Admin full access" ON public.site_settings;
DROP POLICY IF EXISTS "Admin full access" ON public.reviews;
DROP POLICY IF EXISTS "Admin full access" ON public.favorites;
DROP POLICY IF EXISTS "Admin full access" ON public.orders;

DROP POLICY IF EXISTS "Public read product images" ON public.product_images;
DROP POLICY IF EXISTS "Public read color variants" ON public.color_variants;
DROP POLICY IF EXISTS "Public read product sizes" ON public.product_sizes;
DROP POLICY IF EXISTS "Public read size charts" ON public.size_charts;

CREATE POLICY "Public read product images" ON public.product_images
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "Public read color variants" ON public.color_variants
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "Public read product sizes" ON public.product_sizes
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "Public read size charts" ON public.size_charts
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "Admin full access" ON public.product_images FOR ALL TO authenticated USING (public.current_user_is_admin()) WITH CHECK (public.current_user_is_admin());
CREATE POLICY "Admin full access" ON public.color_variants FOR ALL TO authenticated USING (public.current_user_is_admin()) WITH CHECK (public.current_user_is_admin());
CREATE POLICY "Admin full access" ON public.product_sizes FOR ALL TO authenticated USING (public.current_user_is_admin()) WITH CHECK (public.current_user_is_admin());
CREATE POLICY "Admin full access" ON public.size_charts FOR ALL TO authenticated USING (public.current_user_is_admin()) WITH CHECK (public.current_user_is_admin());
CREATE POLICY "Admin full access" ON public.site_settings FOR ALL TO authenticated USING (public.current_user_is_admin()) WITH CHECK (public.current_user_is_admin());
CREATE POLICY "Admin full access" ON public.reviews FOR ALL TO authenticated USING (public.current_user_is_admin()) WITH CHECK (public.current_user_is_admin());
CREATE POLICY "Admin full access" ON public.favorites FOR ALL TO authenticated USING (public.current_user_is_admin()) WITH CHECK (public.current_user_is_admin());
CREATE POLICY "Admin full access" ON public.orders FOR ALL TO authenticated USING (public.current_user_is_admin()) WITH CHECK (public.current_user_is_admin());

DROP POLICY IF EXISTS "Admins view waitlist" ON public.waitlist;
CREATE POLICY "Admins view waitlist" ON public.waitlist
  FOR SELECT TO authenticated
  USING (public.current_user_is_admin());

-- Admin-only RPC used by admin.html to delete users safely.
-- It preserves order/review history by clearing user_id before deleting the auth user.
CREATE OR REPLACE FUNCTION public.delete_user(target_user_id uuid)
RETURNS void AS $$
BEGIN
  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'target_user_id is required';
  END IF;

  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'Only admins can delete users';
  END IF;

  IF auth.uid() = target_user_id THEN
    RAISE EXCEPTION 'Admins cannot delete their own account from the admin panel';
  END IF;

  DELETE FROM public.favorites WHERE user_id = target_user_id;
  UPDATE public.reviews SET user_id = NULL WHERE user_id = target_user_id;
  UPDATE public.orders SET user_id = NULL WHERE user_id = target_user_id;
  DELETE FROM public.profiles WHERE id = target_user_id;
  DELETE FROM auth.users WHERE id = target_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.delete_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_user(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_user(uuid) TO authenticated;

-- Supabase Storage bucket/policies for admin product image uploads.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-images',
  'product-images',
  true,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE
SET public = true,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Product images are public" ON storage.objects;
DROP POLICY IF EXISTS "Admins can upload product images" ON storage.objects;
DROP POLICY IF EXISTS "Admins can update product images" ON storage.objects;
DROP POLICY IF EXISTS "Admins can delete product images" ON storage.objects;

CREATE POLICY "Product images are public" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'product-images');

CREATE POLICY "Admins can upload product images" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'product-images' AND public.current_user_is_admin());

CREATE POLICY "Admins can update product images" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'product-images' AND public.current_user_is_admin())
  WITH CHECK (bucket_id = 'product-images' AND public.current_user_is_admin());

CREATE POLICY "Admins can delete product images" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'product-images' AND public.current_user_is_admin());
