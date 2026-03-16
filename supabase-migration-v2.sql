-- ============================================================================
-- Supabase Migration v2: Nike-Style Product Management System
-- ============================================================================
-- This migration replaces the simple products table with a comprehensive
-- product management system including variants, inventory, profiles, and reviews.
--
-- Changes:
-- - DROP and recreate products table with extended schema
-- - ADD new tables: product_images, color_variants, product_sizes, profiles, size_charts, reviews
-- - ADD RLS policies for RBAC
-- - ADD triggers for auto-updated_at and profile creation
-- - SEED size_charts table with comprehensive measurements
--
-- ============================================================================

-- ============================================================================
-- 1. PRODUCTS TABLE - DROP OLD AND RECREATE WITH EXTENDED SCHEMA
-- ============================================================================
-- The existing products table is being completely replaced with a Nike-style
-- schema supporting SKUs, detailed specifications, sustainability, and pricing tiers.

DROP TABLE IF EXISTS products CASCADE;

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL,
  gender TEXT NOT NULL CHECK (gender IN ('men', 'women', 'unisex', 'kids')),
  colorway TEXT NOT NULL,
  material_composition TEXT NOT NULL,

  -- Pricing
  msrp NUMERIC(10, 2) NOT NULL,
  current_price NUMERIC(10, 2) NOT NULL,
  member_price NUMERIC(10, 2),

  -- Model/Fit Information
  model_height TEXT,
  model_size_worn TEXT,
  fit_type TEXT CHECK (fit_type IN ('tight', 'slim', 'standard', 'loose', 'oversized')),

  -- Fabric Specifications
  fabric_technology TEXT,
  fabric_weight_gsm INT,
  upf_rating INT,
  breathability_mvtr INT,

  -- Sustainability & Certifications
  sustainability_tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  certifications TEXT[] DEFAULT ARRAY[]::TEXT[],
  country_of_origin TEXT,
  care_instructions TEXT,

  -- Special Sizing Options
  specialty_sizing TEXT[] DEFAULT ARRAY[]::TEXT[],

  -- Point of Measure (POM) - chest, waist, inseam
  pom_chest TEXT,
  pom_waist TEXT,
  pom_inseam TEXT,

  -- Product Status
  drop_number TEXT NOT NULL DEFAULT '001',
  status TEXT NOT NULL DEFAULT 'coming_soon' CHECK (status IN ('draft', 'coming_soon', 'live', 'sold_out')),
  sort_order INT NOT NULL DEFAULT 0,
  low_stock_threshold INT NOT NULL DEFAULT 10,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_products_gender ON products(gender);
CREATE INDEX idx_products_drop_number ON products(drop_number);

-- ============================================================================
-- 2. PRODUCT IMAGES TABLE - NEW
-- ============================================================================
-- Store multiple images per product with sorting and alt text for accessibility

CREATE TABLE product_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  alt_text TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_product_images_product_id ON product_images(product_id);
CREATE INDEX idx_product_images_sort_order ON product_images(product_id, sort_order);

-- ============================================================================
-- 3. COLOR VARIANTS TABLE - NEW
-- ============================================================================
-- Support multiple color options per product with hex and RGB values

CREATE TABLE color_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  color_name TEXT NOT NULL,
  hex_color TEXT NOT NULL,
  rgb_color TEXT,
  variant_sku TEXT UNIQUE,
  sort_order INT DEFAULT 0
);

CREATE INDEX idx_color_variants_product_id ON color_variants(product_id);
CREATE INDEX idx_color_variants_variant_sku ON color_variants(variant_sku);

-- ============================================================================
-- 4. PRODUCT SIZES/INVENTORY TABLE - NEW
-- ============================================================================
-- Track inventory quantities by size for each product

CREATE TABLE product_sizes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size TEXT NOT NULL,
  stock_quantity INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (product_id, size)
);

CREATE INDEX idx_product_sizes_product_id ON product_sizes(product_id);
CREATE INDEX idx_product_sizes_stock ON product_sizes(stock_quantity);

-- ============================================================================
-- 5. PROFILES TABLE - NEW
-- ============================================================================
-- User profiles with role-based access control (RBAC)
-- Links to Supabase auth.users table

CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('admin', 'customer')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_profiles_email ON profiles(email);
CREATE INDEX idx_profiles_role ON profiles(role);

-- ============================================================================
-- 6. SIZE CHARTS TABLE - NEW
-- ============================================================================
-- Comprehensive size measurement charts for different product categories

CREATE TABLE size_charts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,
  size_label TEXT NOT NULL,
  us_size TEXT,
  numeric_size TEXT,
  height_in TEXT,
  chest_in TEXT,
  waist_in TEXT,
  hips_in TEXT,
  bust_in TEXT,
  head_circ_in TEXT,
  head_circ_cm TEXT,
  band_size TEXT,
  cup_size TEXT
);

CREATE INDEX idx_size_charts_category ON size_charts(category);

-- ============================================================================
-- 7. REVIEWS TABLE - NEW
-- ============================================================================
-- Product reviews with verification and moderation support

CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id),
  rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT,
  body TEXT,
  nickname TEXT,
  verified_purchase BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_reviews_product_id ON reviews(product_id);
CREATE INDEX idx_reviews_user_id ON reviews(user_id);
CREATE INDEX idx_reviews_rating ON reviews(rating);

-- ============================================================================
-- 8. TRIGGERS - AUTO UPDATE TIMESTAMPS
-- ============================================================================
-- Automatically update the updated_at timestamp when records are modified

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_updated_at_trigger
BEFORE UPDATE ON products
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER profiles_updated_at_trigger
BEFORE UPDATE ON profiles
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 9. TRIGGER - AUTO CREATE PROFILE ON USER SIGNUP
-- ============================================================================
-- When a new user is created in auth.users, automatically create their profile

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name',
    'customer'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- 10. ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================
-- Enable RLS on all new tables

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE color_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_sizes ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE size_charts ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- PRODUCTS TABLE - RLS POLICIES
-- ============================================================================
-- Anyone can view products (SELECT)
-- Only admins can insert, update, delete

CREATE POLICY "Products are public" ON products
  FOR SELECT USING (true);

CREATE POLICY "Only admins can insert products" ON products
  FOR INSERT WITH CHECK (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  );

CREATE POLICY "Only admins can update products" ON products
  FOR UPDATE USING (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  )
  WITH CHECK (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  );

CREATE POLICY "Only admins can delete products" ON products
  FOR DELETE USING (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  );

-- ============================================================================
-- PRODUCT IMAGES TABLE - RLS POLICIES
-- ============================================================================
-- Same as products: public read, admin write

CREATE POLICY "Product images are public" ON product_images
  FOR SELECT USING (true);

CREATE POLICY "Only admins can insert product images" ON product_images
  FOR INSERT WITH CHECK (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  );

CREATE POLICY "Only admins can update product images" ON product_images
  FOR UPDATE USING (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  )
  WITH CHECK (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  );

CREATE POLICY "Only admins can delete product images" ON product_images
  FOR DELETE USING (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  );

-- ============================================================================
-- COLOR VARIANTS TABLE - RLS POLICIES
-- ============================================================================

CREATE POLICY "Color variants are public" ON color_variants
  FOR SELECT USING (true);

CREATE POLICY "Only admins can insert color variants" ON color_variants
  FOR INSERT WITH CHECK (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  );

CREATE POLICY "Only admins can update color variants" ON color_variants
  FOR UPDATE USING (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  )
  WITH CHECK (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  );

CREATE POLICY "Only admins can delete color variants" ON color_variants
  FOR DELETE USING (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  );

-- ============================================================================
-- PRODUCT SIZES TABLE - RLS POLICIES
-- ============================================================================
-- Public read access, admin write access

CREATE POLICY "Product sizes are public" ON product_sizes
  FOR SELECT USING (true);

CREATE POLICY "Only admins can insert product sizes" ON product_sizes
  FOR INSERT WITH CHECK (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  );

CREATE POLICY "Only admins can update product sizes" ON product_sizes
  FOR UPDATE USING (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  )
  WITH CHECK (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  );

CREATE POLICY "Only admins can delete product sizes" ON product_sizes
  FOR DELETE USING (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  );

-- ============================================================================
-- PROFILES TABLE - RLS POLICIES
-- ============================================================================
-- Users can read their own profile, admins can read all

CREATE POLICY "Users can read their own profile" ON profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Admins can read all profiles" ON profiles
  FOR SELECT USING (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  );

CREATE POLICY "Admins can update profiles" ON profiles
  FOR UPDATE USING (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  )
  WITH CHECK (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  );

-- ============================================================================
-- SIZE CHARTS TABLE - RLS POLICIES
-- ============================================================================
-- Public read access, admin write access

CREATE POLICY "Size charts are public" ON size_charts
  FOR SELECT USING (true);

CREATE POLICY "Only admins can insert size charts" ON size_charts
  FOR INSERT WITH CHECK (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  );

CREATE POLICY "Only admins can update size charts" ON size_charts
  FOR UPDATE USING (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  )
  WITH CHECK (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  );

CREATE POLICY "Only admins can delete size charts" ON size_charts
  FOR DELETE USING (
    auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  );

-- ============================================================================
-- REVIEWS TABLE - RLS POLICIES
-- ============================================================================
-- Public read, authenticated users can insert, users can update/delete own, admins can manage all

CREATE POLICY "Reviews are public" ON reviews
  FOR SELECT USING (true);

CREATE POLICY "Authenticated users can insert reviews" ON reviews
  FOR INSERT WITH CHECK (
    auth.role() = 'authenticated'
  );

CREATE POLICY "Users can update their own reviews" ON reviews
  FOR UPDATE USING (
    auth.uid() = user_id OR auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  )
  WITH CHECK (
    auth.uid() = user_id OR auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  );

CREATE POLICY "Users can delete their own reviews" ON reviews
  FOR DELETE USING (
    auth.uid() = user_id OR auth.uid() IN (
      SELECT id FROM profiles WHERE role = 'admin'
    )
  );

-- ============================================================================
-- 11. SEED DATA - SIZE CHARTS
-- ============================================================================
-- Comprehensive sizing data for men's, women's, kids apparel, sports bras, and hats

-- Men's Apparel Sizes
INSERT INTO size_charts (category, size_label, chest_in, waist_in, hips_in)
VALUES
  ('men_tops', 'XS', '31.5-35', '26-29', '32.5-35'),
  ('men_tops', 'S', '35-37.5', '29-32', '35-37.5'),
  ('men_tops', 'M', '37.5-41', '32-35', '37.5-41'),
  ('men_tops', 'L', '41-44', '35-38', '41-44'),
  ('men_tops', 'XL', '44-48.5', '38-43', '44-47'),
  ('men_tops', '2XL', '48.5-53.5', '43-47.5', '47-50.5'),
  ('men_tops', '3XL', '53.5-58', '47.5-52.5', '50.5-53.5');

-- Women's Apparel Sizes
INSERT INTO size_charts (category, size_label, us_size, bust_in, waist_in, hips_in)
VALUES
  ('women_tops', 'XXS', '00', '27.5-29.5', '21.5-23.5', '30.5-33'),
  ('women_tops', 'XS', '0-2', '29.5-32.5', '23.5-26', '33-35.5'),
  ('women_tops', 'S', '4-6', '32.5-35.5', '26-29', '35.5-38.5'),
  ('women_tops', 'M', '8-10', '35.5-38', '29-31.5', '38.5-41'),
  ('women_tops', 'L', '12-14', '38-41', '31.5-34.5', '41-44'),
  ('women_tops', 'XL', '16-18', '41-44.5', '34.5-38.5', '44-47'),
  ('women_tops', '2XL', '20-22', '44.5-48.5', '38.5-42.5', '47-50');

-- Kids Apparel Sizes (7-15)
INSERT INTO size_charts (category, size_label, numeric_size, height_in, chest_in, waist_in, hips_in)
VALUES
  ('kids', 'XS', '6-7', '48-50', '25.5-26', '23.5-24', '27-28'),
  ('kids', 'S', '8-9', '50-54', '26-27', '24-25.5', '28-31'),
  ('kids', 'M', '10-12', '54-58', '27-29.5', '25.5-27', '31-34'),
  ('kids', 'L', '14-16', '58-62', '29.5-32', '27-28.5', '34-37'),
  ('kids', 'XL', '18-20', '62-67', '32-35', '28.5-29.5', '37-40');

-- Sports Bras (band_size and cup_size)
INSERT INTO size_charts (category, size_label, band_size, cup_size)
VALUES
  ('sports_bras', 'XS', '30', 'A-B'),
  ('sports_bras', 'XS', '32', 'A-B'),
  ('sports_bras', 'S', '30', 'C-D'),
  ('sports_bras', 'S', '32', 'C-D'),
  ('sports_bras', 'S', '34', 'A-B'),
  ('sports_bras', 'S', '36', 'A-B'),
  ('sports_bras', 'M', '30', 'E'),
  ('sports_bras', 'M', '32', 'E'),
  ('sports_bras', 'M', '34', 'C-D'),
  ('sports_bras', 'M', '36', 'C-D'),
  ('sports_bras', 'M', '38', 'A-B'),
  ('sports_bras', 'M', '40', 'A-B'),
  ('sports_bras', 'L', '34', 'E'),
  ('sports_bras', 'L', '36', 'E'),
  ('sports_bras', 'L', '38', 'C-D'),
  ('sports_bras', 'L', '40', 'C-D'),
  ('sports_bras', 'XL', '38', 'E'),
  ('sports_bras', 'XL', '40', 'E');

-- Hats (head circumference)
INSERT INTO size_charts (category, size_label, head_circ_in, head_circ_cm)
VALUES
  ('hats', 'S/M', '21.25-22.5', '54-57'),
  ('hats', 'M/L', '22.5-23.5', '57-60'),
  ('hats', 'L/XL', '23.5-24.75', '60-63'),
  ('hats', 'One Size', '21.25-24', '54-61');

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
-- All tables created with proper indexing, constraints, RLS policies, and seed data.
-- The system is now ready for a Nike-style product management workflow.
-- ============================================================================
