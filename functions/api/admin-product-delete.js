/**
 * POST /api/admin-product-delete — deleting a product, through a limit.
 *
 * The panel did the whole cascade from the browser: product_images,
 * color_variants, product_sizes, then products, four direct Supabase calls.
 * Nothing was asked, so the "Deleting products" limit could not refuse — the
 * same reason the rest sat marked not-working.
 *
 * Unlike the export, this one is worth closing properly, and migration 0009
 * does: authenticated sessions can no longer DELETE from products at all, so
 * this endpoint is not merely the polite route, it is the only one. An admin
 * with a console cannot go around it. That is possible here and not there
 * because nothing legitimate deletes a product from the browser, whereas
 * plenty legitimately reads profiles.
 *
 * PARENT LAST. If the run dies partway, a product with some children missing
 * is a mess somebody can see and fix; a product row gone with children left
 * behind is invisible rows nobody will ever look for.
 */

import { cors, json, decide } from './_commerce.js';

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  const h = cors(env);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, 400, h); }

  const { accessToken, productId } = body || {};
  const id = String(productId || '').trim();
  if (!id) return json({ error: 'Which product?' }, 400, h);

  const sbKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
  const sbH = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  /* Read it BEFORE deciding, because the limit is written about the product's
     state — "not while it is Live" — and that is a fact about the row, not
     something the caller can be trusted to report about it. */
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/products?id=eq.${encodeURIComponent(id)}&select=id,name,status,published&limit=1`,
    { headers: sbH }
  );
  const rows = res.ok ? await res.json().catch(() => []) : [];
  const product = rows && rows[0];
  if (!product) return json({ error: 'That product no longer exists.' }, 404, h);

  /* Two spellings of the same fact. The limit ships written against 'Live',
     and some rows carry only the boolean, so a product published with no
     status string must not read as a draft. */
  const status = String(product.status || (product.published ? 'Live' : 'Draft'));

  const verdict = await decide(env, accessToken, 'product_delete', {
    action: 'product_delete',
    resource: { status, id, name: String(product.name || '') },
  });
  if (!verdict.allow) {
    return json({
      error: verdict.reason || 'A limit on your account stopped this deletion.',
      limited: !!verdict.limited,
      ownerMayOverride: !!verdict.ownerMayOverride,
      rule: verdict.rule || '',
      status,
    }, 403, h);
  }

  const del = async (table, column) => {
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/${table}?${column}=eq.${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: { ...sbH, Prefer: 'return=minimal' } }
    );
    if (!r.ok) throw new Error(`${table}: ${r.status}`);
  };

  try {
    await del('product_images', 'product_id');
    await del('color_variants', 'product_id');
    await del('product_sizes', 'product_id');
    await del('products', 'id');
  } catch (e) {
    return json({ error: `Deletion stopped partway — ${e.message}. The product is still there; try again.` }, 502, h);
  }

  return json({ success: true, id, name: String(product.name || ''), status }, 200, h);
}
