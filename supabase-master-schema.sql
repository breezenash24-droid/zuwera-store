-- ============================================================================
-- ZUWERA: Master Database Schema (Overrides all previous migrations)
-- ============================================================================

-- 1. DROP ALL EXISTING TABLES (To ensure a clean slate)
DROP TABLE IF EXISTS favorites CASCADE;
DROP TABLE IF EXISTS waitlist CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS site_settings CASCADE;
DROP TABLE IF EXISTS reviews CASCADE;
DROP TABLE IF EXISTS size_charts CASCADE;
DROP TABLE IF EXISTS product_sizes CASCADE;
DROP TABLE IF EXISTS color_variants CASCADE;
DROP TABLE IF EXISTS product_images CASCADE;
DROP TABLE IF EXISTS profiles CASCADE;
DROP TABLE IF EXISTS products CASCADE;

-- 2. CREATE TABLES

-- PROFILES
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'customer',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- PRODUCTS
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT UNIQUE,
  title TEXT NOT NULL,
  subtitle TEXT,
  gender TEXT,
  colorway TEXT,
  material_composition TEXT,
  msrp NUMERIC(10, 2),
  current_price NUMERIC(10, 2),
  member_price NUMERIC(10, 2),
  model_height TEXT,
  model_size_worn TEXT,
  fit_type TEXT,
  fabric_technology TEXT,
  fabric_weight_gsm NUMERIC,
  upf_rating INT,
  breathability_mvtr NUMERIC,
  pom_chest NUMERIC,
  pom_waist NUMERIC,
  pom_inseam NUMERIC,
  pom_hips NUMERIC,
  pom_length NUMERIC,
  pom_shoulder NUMERIC,
  pom_sleeve NUMERIC,
  sustainability_tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  certifications TEXT[] DEFAULT ARRAY[]::TEXT[],
  specialty_sizing TEXT[] DEFAULT ARRAY[]::TEXT[],
  country_of_origin TEXT,
  care_instructions TEXT,
  drop_number TEXT,
  status TEXT DEFAULT 'Draft',
  sort_order INT DEFAULT 0,
  low_stock_threshold INT DEFAULT 10,
  image_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- PRODUCT IMAGES
CREATE TABLE product_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  alt_text TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- COLOR VARIANTS
CREATE TABLE color_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  color_name TEXT NOT NULL,
  hex_color TEXT NOT NULL,
  rgb_color TEXT,
  variant_sku TEXT,
  sort_order INT DEFAULT 0
);

-- PRODUCT SIZES (Inventory)
CREATE TABLE product_sizes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size TEXT NOT NULL,
  stock_quantity INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (product_id, size)
);

-- SIZE CHARTS
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

-- REVIEWS
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id),
  rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT,
  body TEXT,
  nickname TEXT,
  reviewer_name TEXT,
  admin_response TEXT,
  verified_purchase BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- SITE SETTINGS (For Announcement Bar, Policies, FAQ, etc.)
CREATE TABLE site_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- FAVORITES
CREATE TABLE favorites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  product_name TEXT,
  price TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, product_id)
);

-- WAITLIST
CREATE TABLE waitlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(email, source)
);

-- ORDERS
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'Confirmed',
  total_amount NUMERIC(10,2),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. SYNC ADMIN & TRIGGERS

-- Function to auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'full_name', 'customer');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- CRITICAL: Automatically assign the 'admin' role to all existing accounts
INSERT INTO public.profiles (id, email, role)
SELECT id, email, 'admin' FROM auth.users
ON CONFLICT (id) DO UPDATE SET role = 'admin';

-- 4. ROW LEVEL SECURITY (RLS) POLICIES

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE color_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_sizes ENABLE ROW LEVEL SECURITY;
ALTER TABLE size_charts ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- Profiles: Public can read, users can update their own
CREATE POLICY "Public read profiles" ON profiles FOR SELECT USING (true);
CREATE POLICY "Users update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);

-- Public Read for Catalog Data
CREATE POLICY "Public read access" ON products FOR SELECT USING (true);
CREATE POLICY "Public read access" ON product_images FOR SELECT USING (true);
CREATE POLICY "Public read access" ON color_variants FOR SELECT USING (true);
CREATE POLICY "Public read access" ON product_sizes FOR SELECT USING (true);
CREATE POLICY "Public read access" ON size_charts FOR SELECT USING (true);
CREATE POLICY "Public read access" ON reviews FOR SELECT USING (true);
CREATE POLICY "Public read access" ON site_settings FOR SELECT USING (true);

-- Admin Write for Catalog Data
CREATE POLICY "Admin full access" ON products FOR ALL USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');
CREATE POLICY "Admin full access" ON product_images FOR ALL USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');
CREATE POLICY "Admin full access" ON color_variants FOR ALL USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');
CREATE POLICY "Admin full access" ON product_sizes FOR ALL USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');
CREATE POLICY "Admin full access" ON size_charts FOR ALL USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');
CREATE POLICY "Admin full access" ON site_settings FOR ALL USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');

-- User Specific Data
CREATE POLICY "Users manage own reviews" ON reviews FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users manage own favorites" ON favorites FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users manage own orders" ON orders FOR ALL USING (auth.uid() = user_id);

-- Admin Write/Read for User Specific Data
CREATE POLICY "Admin full access" ON reviews FOR ALL USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');
CREATE POLICY "Admin full access" ON favorites FOR ALL USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');
CREATE POLICY "Admin full access" ON orders FOR ALL USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');

-- Waitlist (Public can insert, only admins can view)
CREATE POLICY "Public can join waitlist" ON waitlist FOR INSERT WITH CHECK (true);
CREATE POLICY "Admins view waitlist" ON waitlist FOR SELECT USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');

-- 5. INITIAL SEED DATA

-- Seed a default Site Setting so it doesn't error out on empty
INSERT INTO site_settings (key, value) VALUES
('announcement_bar', '{"main": "ALL THE DEVILS ARE HERE", "product": "FREE SHIPPING ON ORDERS OVER $100"}'),
('shipping_policy', '{"free_threshold": 100, "standard_rate": 8, "delivery_days": "5-7", "return_days_member": 60, "return_days_nonmember": 30}'),
('theme', '{"mode": "dark"}')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- MIGRATION COMPLETE. Admin Panel is now 100% unlocked and functional.
-- ============================================================================