# Image Storage Checklist

Use this before launch and after large product upload sessions.

## Current Setup

- Admin uploads product originals to Supabase Storage bucket `product-images`.
- Storefront image delivery is optimized through Cloudinary fetch URLs.
- Cloudflare Pages only hosts the website code and small static assets.

## Before Launch

- Check Supabase Storage usage for `product-images`.
- Check Cloudinary usage for credits, bandwidth, transformations, and managed storage.
- Delete test products from admin if they are no longer needed.
- Replace extra-large product images with optimized uploads from the admin panel.
- Confirm product images are 3:4 portrait where possible, ideally at least 900x1200.

## Supabase SQL Checks

Database size:

```sql
select
  pg_size_pretty(sum(pg_database_size(pg_database.datname))) as total_database_size
from pg_database;
```

Storage used by bucket:

```sql
select
  bucket_id,
  count(*) as file_count,
  (sum((metadata->>'size')::bigint) / 1048576.0)::numeric(10, 2) as total_size_mb
from storage.objects
group by bucket_id
order by total_size_mb desc;
```

Largest product images:

```sql
select
  bucket_id,
  name,
  ((metadata->>'size')::bigint / 1048576.0)::numeric(10, 2) as size_mb,
  created_at
from storage.objects
where bucket_id = 'product-images'
order by (metadata->>'size')::bigint desc
limit 50;
```

Possible orphaned Supabase product image files:

```sql
select
  o.name,
  ((o.metadata->>'size')::bigint / 1048576.0)::numeric(10, 2) as size_mb,
  o.created_at
from storage.objects o
where o.bucket_id = 'product-images'
  and not exists (
    select 1
    from public.product_images pi
    where pi.image_url like '%' || o.name
  )
  and not exists (
    select 1
    from public.products p
    where p.image_url like '%' || o.name
  )
order by o.created_at desc;
```

## Best Free Storage Option To Consider

Cloudflare R2 is the best next storage target for this Cloudflare-based site:

- 10 GB-month free storage on Standard storage.
- 1 million free write/list operations per month.
- 10 million free read operations per month.
- Free egress to the Internet.

R2 does not resize images by itself, so the best long-term setup would be:

- Store originals in Cloudflare R2.
- Serve public image URLs from R2.
- Keep Cloudinary or Cloudflare Images transformations for optimized sizes.
- Store only image URLs in Supabase product rows.

This avoids using Supabase's smaller 1 GB free Storage quota for product images.
