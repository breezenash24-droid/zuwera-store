/**
 * /api/product-feed — Cloudflare Pages Function
 *
 * Outputs a Google Shopping (RSS 2.0 + Google namespace) product feed built
 * live from the Supabase `products` table. The same format is accepted by:
 *   - Google Merchant Center  (submit this URL as a scheduled fetch feed)
 *   - Meta Commerce Manager    (Instagram/Facebook Shopping catalog feed)
 *
 * No external account is needed to serve the feed — you simply paste
 *   https://zuwera.store/api/product-feed
 * into Google Merchant Center → Products → Feeds → "Scheduled fetch".
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)
 * from the environment, same as the other admin functions.
 */

const SITE = 'https://zuwera.store';

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Map the store's product.status to a Google availability value.
function availabilityFor(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'sold out') return 'out_of_stock';
  if (s === 'coming soon') return 'preorder';
  return 'in_stock'; // 'live' and anything else default to in stock
}

// Map gender column to Google's accepted values.
function genderFor(g) {
  const v = String(g || '').toLowerCase();
  if (v === 'men' || v === 'male') return 'male';
  if (v === 'women' || v === 'female') return 'female';
  return 'unisex';
}

function productUrl(p) {
  return `${SITE}/product.html?id=${encodeURIComponent(p.id || '')}`;
}

function bestImage(p) {
  if (Array.isArray(p.product_images) && p.product_images.length) {
    const sorted = [...p.product_images].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const first = sorted.find(i => i.image_url) || sorted[0];
    if (first && first.image_url) return first.image_url;
  }
  return p.image_url || '';
}

function extraImages(p, primary) {
  if (!Array.isArray(p.product_images)) return [];
  return [...p.product_images]
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    .map(i => i.image_url)
    .filter(u => u && u !== primary)
    .slice(0, 10); // Google allows up to 10 additional images
}

function itemXml(p) {
  const id      = p.sku || p.id;
  const title   = p.title || p.name || 'Zuwera Product';
  const desc    = p.description || `${title} — Zuwera athletic sportswear.`;
  const link    = productUrl(p);
  const image   = bestImage(p);
  if (!image) return ''; // Google requires an image_link; skip imageless products

  const current = Number(p.current_price) || 0;
  const msrp    = Number(p.msrp) || 0;
  const onSale  = msrp > 0 && current > 0 && current < msrp;
  const listPrice = (onSale ? msrp : (current || msrp)).toFixed(2);
  const avail   = availabilityFor(p.status);

  let item = '  <item>\n';
  item += `    <g:id>${xmlEscape(id)}</g:id>\n`;
  item += `    <g:title>${xmlEscape(title)}</g:title>\n`;
  item += `    <g:description>${xmlEscape(desc)}</g:description>\n`;
  item += `    <g:link>${xmlEscape(link)}</g:link>\n`;
  item += `    <g:image_link>${xmlEscape(image)}</g:image_link>\n`;
  for (const extra of extraImages(p, image)) {
    item += `    <g:additional_image_link>${xmlEscape(extra)}</g:additional_image_link>\n`;
  }
  item += `    <g:availability>${avail}</g:availability>\n`;
  item += `    <g:price>${listPrice} USD</g:price>\n`;
  if (onSale) item += `    <g:sale_price>${current.toFixed(2)} USD</g:sale_price>\n`;
  item += `    <g:brand>Zuwera</g:brand>\n`;
  item += `    <g:condition>new</g:condition>\n`;
  item += `    <g:gender>${genderFor(p.gender)}</g:gender>\n`;
  item += `    <g:age_group>adult</g:age_group>\n`;
  item += `    <g:google_product_category>Apparel &amp; Accessories &gt; Clothing</g:google_product_category>\n`;
  item += `    <g:identifier_exists>${p.sku ? 'yes' : 'no'}</g:identifier_exists>\n`;
  if (p.sku) item += `    <g:mpn>${xmlEscape(p.sku)}</g:mpn>\n`;
  item += '  </item>\n';
  return item;
}

export async function onRequestGet({ env }) {
  const url = (env.SUPABASE_URL || env.SUPABASE_PROJECT_URL || '').trim();
  const sk  = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();

  const headers = {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'public, max-age=1800', // 30 min — feeds don't need to be real-time
    'Access-Control-Allow-Origin': '*',
  };

  if (!url || !sk) {
    return new Response(
      '<?xml version="1.0"?><error>Feed not configured — missing SUPABASE_URL or service key.</error>',
      { status: 500, headers }
    );
  }

  let products = [];
  try {
    // Pull live-ish products with their images in one nested select.
    const resp = await fetch(
      `${url}/rest/v1/products?select=*,product_images(image_url,sort_order)&status=neq.Legacy&status=neq.Draft&order=sort_order.asc`,
      { headers: { apikey: sk, Authorization: `Bearer ${sk}` } }
    );
    if (resp.ok) products = await resp.json();
  } catch (_) { /* fall through to empty feed */ }

  const items = products.map(itemXml).join('');

  const xml =
`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
  <title>Zuwera — Product Feed</title>
  <link>${SITE}</link>
  <description>Zuwera athletic sportswear product catalog.</description>
${items}</channel>
</rss>`;

  return new Response(xml, { status: 200, headers });
}
