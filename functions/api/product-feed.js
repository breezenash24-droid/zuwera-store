/**
 * /api/product-feed — Cloudflare Pages Function
 *
 * Outputs a Google Shopping (RSS 2.0 + Google namespace) product feed built
 * live from Supabase. The same format is accepted by:
 *   - Meta Commerce Manager  (Instagram/Facebook catalog → Data feed → scheduled)
 *   - Google Merchant Center  (Products → Feeds → Scheduled fetch)
 *
 * One <item> per VARIANT (product × color × size), grouped with g:item_group_id
 * so Meta/Google treat them as one product with selectable size/color and
 * per-variant availability — the correct shape for apparel.
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY).
 * Paste https://zuwera.store/api/product-feed as a scheduled feed.
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

// Underscore forms are accepted by BOTH Meta and Google.
function availabilityForStock(qty) {
  return Number(qty) > 0 ? 'in_stock' : 'out_of_stock';
}

function genderFor(g) {
  const v = String(g || '').toLowerCase();
  if (v === 'men' || v === 'male') return 'male';
  if (v === 'women' || v === 'female') return 'female';
  return 'unisex';
}

// subtitle holds the human category ("Jackets"); products.category is an
// internal code ("MOT") — map subtitle to a real taxonomy node.
function googleCategoryFor(subtitle) {
  const s = String(subtitle || '').toLowerCase();
  if (s.includes('jacket') || s.includes('outerwear') || s.includes('coat'))
    return 'Apparel & Accessories > Clothing > Outerwear > Coats & Jackets';
  if (s.includes('shirt') || s.includes('tee') || s.includes('top'))
    return 'Apparel & Accessories > Clothing > Shirts & Tops';
  if (s.includes('sweatpant') || s.includes('pant') || s.includes('trouser') || s.includes('jogger'))
    return 'Apparel & Accessories > Clothing > Pants';
  if (s.includes('sock'))
    return 'Apparel & Accessories > Clothing > Underwear & Socks > Socks';
  if (s.includes('short'))
    return 'Apparel & Accessories > Clothing > Shorts';
  return 'Apparel & Accessories > Clothing';
}

function productSlug(title) {
  return String(title || 'product')
    .replace(/^zuwera\s+/i, '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'product';
}

function productUrl(p) {
  // Canonical pretty URL (matches the sitemap / product SEO function).
  return `${SITE}/product/${productSlug(p.title)}?id=${encodeURIComponent(p.id || '')}`;
}

function cleanId(...parts) {
  return parts.filter(Boolean).join('-').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 90);
}

function describe(p, title) {
  const sub = String(p.subtitle || '').trim();
  const bits = [sub
    ? `${title} — ${sub} from ZUWERA's Release 001.`
    : `${title} — bold athletic sportswear from ZUWERA.`];
  if (p.material_composition) bits.push(String(p.material_composition).trim());
  if (p.fabric_technology) bits.push(String(p.fabric_technology).trim());
  return bits.join(' ').replace(/\s+/g, ' ').trim().slice(0, 4900);
}

// Resolve the best image for a given colour: prefer images tagged with that
// colour variant, else a colour-agnostic image, else the product fallback.
function imagePickerFor(p) {
  const imgs = (Array.isArray(p.product_images) ? [...p.product_images] : [])
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const idByColor = {};
  (Array.isArray(p.color_variants) ? p.color_variants : []).forEach(cv => {
    if (cv && cv.color_name) idByColor[String(cv.color_name).toLowerCase()] = cv.id;
  });
  const shared = imgs.find(i => i.image_url && !i.color_variant_id) || imgs.find(i => i.image_url);
  const fallback = (shared && shared.image_url) || p.image_url || '';
  return function (colorName) {
    if (colorName) {
      const cid = idByColor[String(colorName).toLowerCase()];
      if (cid) {
        const m = imgs.find(i => i.color_variant_id === cid && i.image_url);
        if (m) return m.image_url;
      }
    }
    return fallback;
  };
}

function variantXml(p, variant, opts) {
  const { color, size, stock } = variant;
  const title = String(p.title || 'Zuwera Product').trim();
  const baseId = p.sku || p.id;
  const image = opts.imageFor(color);
  if (!image) return ''; // image_link is required

  const price = (Number(p.current_price) || Number(p.msrp) || 0).toFixed(2);
  const avail = opts.preLaunch ? 'preorder' : availabilityForStock(stock);

  let x = '  <item>\n';
  x += `    <g:id>${xmlEscape(cleanId(baseId, color, size))}</g:id>\n`;
  x += `    <g:item_group_id>${xmlEscape(p.id || baseId)}</g:item_group_id>\n`;
  x += `    <g:title>${xmlEscape(color ? `${title} — ${color}` : title)}</g:title>\n`;
  x += `    <g:description>${xmlEscape(opts.description)}</g:description>\n`;
  x += `    <g:link>${xmlEscape(opts.link)}</g:link>\n`;
  x += `    <g:image_link>${xmlEscape(image)}</g:image_link>\n`;
  x += `    <g:availability>${avail}</g:availability>\n`;
  // preorder/backorder require an availability_date or the catalog shows
  // availability as "Missing" and the variant can't be used in ads.
  if (avail === 'preorder' && opts.availabilityDate) {
    x += `    <g:availability_date>${opts.availabilityDate}</g:availability_date>\n`;
  }
  x += `    <g:price>${price} USD</g:price>\n`;
  x += `    <g:brand>ZUWERA</g:brand>\n`;
  x += `    <g:condition>new</g:condition>\n`;
  if (color) x += `    <g:color>${xmlEscape(color)}</g:color>\n`;
  if (size)  x += `    <g:size>${xmlEscape(size)}</g:size>\n`;
  x += `    <g:gender>${genderFor(p.gender)}</g:gender>\n`;
  x += `    <g:age_group>adult</g:age_group>\n`;
  x += `    <g:google_product_category>${xmlEscape(opts.gpc)}</g:google_product_category>\n`;
  // Own brand, no manufacturer barcode → declare no GTIN to suppress identifier
  // warnings on both platforms; MPN carries the SKU for reference.
  if (p.sku) x += `    <g:mpn>${xmlEscape(p.sku)}</g:mpn>\n`;
  x += `    <g:identifier_exists>no</g:identifier_exists>\n`;
  x += '  </item>\n';
  return x;
}

function productItems(p, preLaunch, availabilityDate) {
  const title = String(p.title || 'Zuwera Product').trim();
  const opts = {
    preLaunch,
    availabilityDate,
    description: describe(p, title),
    link: productUrl(p),
    gpc: googleCategoryFor(p.subtitle),
    imageFor: imagePickerFor(p),
  };

  // Collapse product_sizes into unique (color, size) variants, summing stock.
  const rows = Array.isArray(p.product_sizes) ? p.product_sizes : [];
  if (!rows.length) {
    // No size data — emit a single base item so the product still lists.
    return variantXml(p, { color: '', size: '', stock: 1 }, opts);
  }
  const byKey = new Map();
  for (const r of rows) {
    const size = String(r.size || '').trim();
    if (!size) continue;
    const color = String(r.color_name || '').trim();
    const key = `${color.toLowerCase()}|${size.toLowerCase()}`;
    const prev = byKey.get(key);
    const stock = Number(r.stock_quantity) || 0;
    if (prev) prev.stock += stock;
    else byKey.set(key, { color, size, stock });
  }
  let out = '';
  for (const v of byKey.values()) out += variantXml(p, v, opts);
  return out;
}

// Pull the published launch date from the page builder so the whole catalog
// reports `preorder` until the drop goes live (Meta Commerce policy).
async function fetchLaunchTs(url, sk) {
  try {
    const r = await fetch(
      `${url}/rest/v1/site_settings?key=eq.page_builder_published&select=value&limit=1`,
      { headers: { apikey: sk, Authorization: `Bearer ${sk}` } }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    const sections = rows && rows[0] && rows[0].value && rows[0].value.sections;
    if (!Array.isArray(sections)) return null;
    const rel = sections.find(s => s && s.type === 'release');
    const d = rel && rel.settings && rel.settings.launch_date;
    const ts = d ? Date.parse(d) : NaN;
    return Number.isNaN(ts) ? null : ts;
  } catch (_) {
    return null;
  }
}

export async function onRequestGet({ env }) {
  const url = (env.SUPABASE_URL || env.SUPABASE_PROJECT_URL || '').trim();
  const sk  = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();

  const headers = {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'public, max-age=1800',
    'Access-Control-Allow-Origin': '*',
  };

  if (!url || !sk) {
    return new Response(
      '<?xml version="1.0"?><error>Feed not configured — missing SUPABASE_URL or service key.</error>',
      { status: 500, headers }
    );
  }

  let products = [];
  let launchTs = null;
  try {
    const [resp, lts] = await Promise.all([
      fetch(
        `${url}/rest/v1/products?select=id,sku,title,subtitle,category,gender,current_price,msrp,status,image_url,material_composition,fabric_technology,product_images(image_url,sort_order,color_variant_id),product_sizes(size,color_name,stock_quantity),color_variants(id,color_name)&status=neq.Legacy&status=neq.Draft&order=sort_order.asc`,
        { headers: { apikey: sk, Authorization: `Bearer ${sk}` } }
      ),
      fetchLaunchTs(url, sk),
    ]);
    if (resp.ok) products = await resp.json();
    launchTs = lts;
  } catch (_) { /* empty feed */ }

  const preLaunch = launchTs != null && Date.now() < launchTs;
  // preorder availability requires a date; use the published launch date (ISO 8601).
  const availabilityDate = preLaunch
    ? new Date(launchTs).toISOString().replace(/\.\d{3}Z$/, '+00:00')
    : null;
  const items = products.map(p => productItems(p, preLaunch, availabilityDate)).join('');
  const variantCount = (items.match(/<item>/g) || []).length;

  const xml =
`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
  <title>ZUWERA — Product Feed</title>
  <link>${SITE}</link>
  <description>ZUWERA athletic sportswear product catalog.</description>
  <!-- ${products.length} products, ${variantCount} variants${preLaunch ? ', pre-launch (preorder)' : ''} -->
${items}</channel>
</rss>`;

  return new Response(xml, { status: 200, headers });
}
