-- Migration: add video support and per-color media to product_images
-- Run this in Supabase SQL editor

ALTER TABLE product_images
  ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT 'image'
    CHECK (media_type IN ('image', 'video')),
  ADD COLUMN IF NOT EXISTS color_variant_id UUID
    REFERENCES color_variants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_product_images_color ON product_images(color_variant_id);

COMMENT ON COLUMN product_images.media_type IS 'image or video';
COMMENT ON COLUMN product_images.color_variant_id IS 'null = shown for all colors; set = shown only when that color is selected';
