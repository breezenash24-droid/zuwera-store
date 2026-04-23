-- =============================================
-- ZUWERA: Products Table Setup
-- Run this in Supabase SQL Editor (one time)
-- =============================================

-- 1. Create the products table
CREATE TABLE public.products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Jackets',
  price TEXT NOT NULL DEFAULT 'Price TBA',
  drop_number TEXT NOT NULL DEFAULT '001',
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'coming_soon',
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Enable Row Level Security
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

-- 3. Allow anyone to read products (public storefront)
CREATE POLICY "Products are viewable by everyone"
  ON public.products FOR SELECT
  USING (true);

-- 4. Only exact owner emails can insert/update/delete (for admin page)
CREATE POLICY "Owner admins can insert products"
  ON public.products FOR INSERT
  TO authenticated
  WITH CHECK (lower(coalesce(auth.jwt() ->> 'email', '')) IN ('breezenash24@gmail.com', 'nasirubreeze@zuwera.store'));

CREATE POLICY "Owner admins can update products"
  ON public.products FOR UPDATE
  TO authenticated
  USING (lower(coalesce(auth.jwt() ->> 'email', '')) IN ('breezenash24@gmail.com', 'nasirubreeze@zuwera.store'))
  WITH CHECK (lower(coalesce(auth.jwt() ->> 'email', '')) IN ('breezenash24@gmail.com', 'nasirubreeze@zuwera.store'));

CREATE POLICY "Owner admins can delete products"
  ON public.products FOR DELETE
  TO authenticated
  USING (lower(coalesce(auth.jwt() ->> 'email', '')) IN ('breezenash24@gmail.com', 'nasirubreeze@zuwera.store'));

-- 5. Seed with existing 3 jackets
INSERT INTO public.products (id, name, category, price, drop_number, status, sort_order)
VALUES
  ('jacket-001', 'Zuwera Jacket 001', 'Jackets', 'Price TBA', '001', 'coming_soon', 1),
  ('jacket-002', 'Zuwera Jacket 002', 'Jackets', 'Price TBA', '001', 'coming_soon', 2),
  ('jacket-003', 'Zuwera Jacket 003', 'Jackets', 'Price TBA', '001', 'coming_soon', 3);
