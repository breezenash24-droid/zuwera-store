// Serve product.html for /product/:slug URLs, with server-side SEO injection.
//
// The page updates title/meta/JSON-LD at runtime too, but social crawlers
// (Facebook, X, iMessage, Slack…) don't execute JS — without this, every
// shared product link rendered the generic "Product — ZUWERA" card, and
// Google could read the pre-JS canonical pointing all products at
// /product.html. We fetch the product (public data, anon key) and rewrite
// the head before responding. Any failure falls back to the untouched HTML.

const SUPABASE_URL = 'https://qfgnrsifcwdubkolsgsq.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';

function escHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function fetchProductSeo(id, env) {
  const base = ((env && (env.SUPABASE_URL || env.SUPABASE_PROJECT_URL)) || SUPABASE_URL).trim();
  const url = `${base}/rest/v1/products?id=eq.${encodeURIComponent(id)}`
    + `&select=id,title,subtitle,category,current_price,status,sku,image_url,product_images(image_url,sort_order)`
    + `&limit=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const resp = await fetch(url, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` },
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const rows = await resp.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function injectSeo(html, product, pageUrl) {
  const title = (product.title || '').trim();
  if (!title) return html;
  // subtitle holds the human category ("Jackets"); products.category is an
  // internal code (e.g. "MOT") — never surface it.
  const desc = (product.subtitle
      ? `${title} — ${product.subtitle}. Bold athletic sportswear from ZUWERA's Release 001.`
      : `${title} — bold athletic sportswear from ZUWERA.`)
    .replace(/\s+/g, ' ').trim().slice(0, 300);
  const images = Array.isArray(product.product_images)
    ? [...product.product_images].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    : [];
  const image = (images[0] && images[0].image_url) || product.image_url
    || 'https://zuwera.store/images/og-image.jpg';
  const canonical = `https://zuwera.store${pageUrl.pathname}${product.id ? `?id=${product.id}` : ''}`;
  const price = parseFloat(product.current_price);
  const status = String(product.status || '').toLowerCase();
  const availability = status === 'sold out'
    ? 'https://schema.org/SoldOut'
    : 'https://schema.org/PreOrder';

  const t = escHtml(`${title} — ZUWERA`);
  const d = escHtml(desc);
  const img = escHtml(image);
  const canon = escHtml(canonical);

  html = html
    .replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`)
    .replace(/(<meta name="description"\s+content=")[^"]*(")/, `$1${d}$2`)
    .replace(/(<link rel="canonical"\s+href=")[^"]*(")/, `$1${canon}$2`)
    .replace(/(<meta property="og:type"\s+content=")[^"]*(")/, '$1product$2')
    .replace(/(<meta property="og:url"\s+content=")[^"]*(")/, `$1${canon}$2`)
    .replace(/(<meta property="og:title"\s+content=")[^"]*(")/, `$1${t}$2`)
    .replace(/(<meta property="og:description"\s+content=")[^"]*(")/, `$1${d}$2`)
    .replace(/(<meta property="og:image"\s+content=")[^"]*(")/, `$1${img}$2`)
    .replace(/(<meta name="twitter:title"\s+content=")[^"]*(")/, `$1${t}$2`)
    .replace(/(<meta name="twitter:description"\s+content=")[^"]*(")/, `$1${d}$2`)
    .replace(/(<meta name="twitter:image"\s+content=")[^"]*(")/, `$1${img}$2`);

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: title,
    description: desc,
    image,
    url: canonical,
    brand: { '@type': 'Brand', name: 'ZUWERA' },
  };
  if (product.sku) ld.sku = product.sku;
  if (!Number.isNaN(price) && price > 0) {
    ld.offers = {
      '@type': 'Offer',
      price: price.toFixed(2),
      priceCurrency: 'USD',
      availability,
      url: canonical,
      seller: { '@type': 'Organization', name: 'ZUWERA' },
    };
  }
  // The runtime script re-uses this element by id, so there's never a duplicate.
  const ldTag = `<script type="application/ld+json" id="product-ld-json">${
    JSON.stringify(ld).replace(/</g, '\\u003c')
  }</script>\n</head>`;
  html = html.replace('</head>', ldTag);

  return html;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const assetUrl = new URL(context.request.url);
  assetUrl.pathname = '/product.html';
  let response = await context.env.ASSETS.fetch(assetUrl);

  // ASSETS may return a 301 redirect due to pretty URLs (/product.html -> /product)
  // Follow it internally and return the final content as a 200
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (location) {
      const redirectUrl = new URL(location, assetUrl);
      response = await context.env.ASSETS.fetch(redirectUrl);
    }
  }

  // Read full HTML and return as new 200 response to avoid stream truncation
  let html = await response.text();

  const id = url.searchParams.get('id');
  if (id && /^[0-9a-f-]{32,40}$/i.test(id)) {
    const product = await fetchProductSeo(id, context.env);
    if (product) {
      try { html = injectSeo(html, product, url); } catch (_) { /* serve untouched */ }
    }
  }

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate'
    }
  });
}
