/**
 * GET /sitemap.xml — generated from the catalogue, not typed by hand.
 *
 * WHAT IT REPLACES. A static sitemap.xml with product UUIDs written into it by
 * a person, last touched on 11 June, which scripts/cloudflare-pages-build.js
 * copied to the output and nothing regenerated. Measured against the live
 * catalogue on 20 August:
 *
 *     live products                      11
 *     product URLs in the file            4
 *     in the catalogue but not listed     7
 *
 * Zuwera Essentials, Senegal Home Jersey, Zuwera Fleece, Zuwera Tech, Zuwera
 * Raw and Zuwera Flower Tee did not exist as far as a crawler was concerned.
 * One of the four that WAS listed pointed at /product/clasic — the slug of a
 * product whose title carries a typo, faithfully reproduced.
 *
 * WHY AN EDGE FUNCTION AND NOT A BUILD STEP. A build step would have been
 * correct at deploy time and wrong again the moment somebody published a
 * product — and publishing a product does not deploy anything here, by explicit
 * decision ("I don't want every little change to take 3 minutes"). Generating
 * it per request removes the staleness rather than shortening it.
 *
 * A static asset would win over this route, so the old sitemap.xml is deleted
 * rather than left in place — a file that shadows its own replacement is the
 * kind of thing that looks fixed for months.
 *
 * FAILURE IS A SMALLER SITEMAP, NEVER AN ERROR. If the catalogue query fails,
 * the static pages are still returned. A sitemap that 500s tells a crawler the
 * site is broken; one that is short tells it less than it could, which is the
 * lesser harm and is what the file did every day anyway.
 */

import { supabaseUrl, supabaseAnonKey } from './api/_config.js';

const SITE = 'https://zuwera.store';

/* The same transformation productHref() applies in storefront.js — the URL a
   crawler is told about has to be the URL the site links to, or the sitemap
   advertises a page nobody can reach from anywhere. Kept in step by
   tests/sitemap-lists-the-catalogue.test.js, which compares the two. */
function productSlug(title) {
  if (!title) return '';
  return String(title)
    .replace(/^zuwera\s+/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function day(value) {
  const d = new Date(value || Date.now());
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function rows(env, query) {
  const key = supabaseAnonKey(env);
  const base = supabaseUrl(env);
  if (!base || !key) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const resp = await fetch(`${base}/rest/v1/${query}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!resp.ok) return [];
    const out = await resp.json().catch(() => []);
    return Array.isArray(out) ? out : [];
  } catch (_) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/* Customer-facing pages only. account.html, bag.html and checkout.html are
   deliberately absent for the same reason robots.txt disallows the first: a
   crawler has nothing to index on a page that exists to show YOUR data, and
   listing it invites the attempt. product.html is absent too — it is the
   template, and every real product has its own /product/<slug> entry. */
const STATIC = [
  { loc: '/', priority: '1.0', changefreq: 'daily' },
  { loc: '/drop001.html', priority: '0.9', changefreq: 'daily' },
  { loc: '/journal.html', priority: '0.6', changefreq: 'weekly' },
  { loc: '/about.html', priority: '0.5', changefreq: 'monthly' },
  { loc: '/sizeguide.html', priority: '0.4', changefreq: 'monthly' },
  { loc: '/returns.html', priority: '0.3', changefreq: 'monthly' },
  { loc: '/policies.html', priority: '0.3', changefreq: 'monthly' },
];

export async function onRequest({ env }) {
  const urls = STATIC.map((p) => ({ ...p, loc: SITE + p.loc }));

  /* status=neq.Legacy&status=neq.Draft is the same filter /api/catalog and the
     product feed use — a draft product must not be advertised to a crawler
     before it is advertised to a shopper. */
  const products = await rows(env,
    'products?select=id,title,updated_at,status'
    + '&status=neq.Legacy&status=neq.Draft&order=sort_order.asc');

  for (const p of products) {
    const slug = productSlug(p.title);
    if (!p.id) continue;
    urls.push({
      loc: SITE + (slug ? `/product/${slug}` : '/product') + `?id=${p.id}`,
      lastmod: day(p.updated_at),
      priority: '0.8',
      changefreq: 'weekly',
    });
  }

  const posts = await rows(env,
    'journal_posts?select=slug,updated_at,published_at,status'
    + '&status=eq.published&order=published_at.desc');

  for (const post of posts) {
    if (!post.slug) continue;
    urls.push({
      loc: `${SITE}/journal.html?slug=${encodeURIComponent(post.slug)}`,
      lastmod: day(post.updated_at || post.published_at),
      priority: '0.5',
      changefreq: 'monthly',
    });
  }

  const body = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.map((u) => '  <url>\n'
      + `    <loc>${esc(u.loc)}</loc>\n`
      + (u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : '')
      + `    <changefreq>${u.changefreq}</changefreq>\n`
      + `    <priority>${u.priority}</priority>\n`
      + '  </url>').join('\n')
    + '\n</urlset>\n';

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      /* An hour at the edge. Long enough that a crawl does not cost eleven
         database round trips, short enough that a product published this
         morning is listed by lunchtime — which is eleven weeks sooner than the
         file it replaces managed. */
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
