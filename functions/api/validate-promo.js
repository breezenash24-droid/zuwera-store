/**
 * Cloudflare Pages Function: /api/validate-promo
 *
 * Lightweight endpoint for client-side promo code preview. Validates a code
 * and returns an estimated discount amount based on client-provided prices.
 * The actual discount is always recomputed server-side at payment intent time.
 */

import {
  computePromotionDiscount,
  getSetting,
  normalizePromoCode,
  sanitizeCommerceConfig,
} from './_commerce.js';

const CORS = (env) => ({
  'Access-Control-Allow-Origin': env.SITE_URL || 'https://zuwera.store',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
});

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: CORS(env) });
}

export async function onRequestPost({ request, env }) {
  const headers = CORS(env);
  try {
    const body = await request.json().catch(() => ({}));
    const { promoCode = '', items = [] } = body;

    const normalized = normalizePromoCode(promoCode);
    if (!normalized) {
      return json({ valid: false, message: 'Enter a promo code.' }, 200, headers);
    }

    const config = sanitizeCommerceConfig(await getSetting(env, 'commerce_config', {}));
    const promotion = config.promotions.find(
      (p) => normalizePromoCode(p.code) === normalized
    );

    if (!promotion) {
      return json({ valid: false, message: 'Code not found or expired.' }, 200, headers);
    }

    // Build client items array; prices are in dollars from localStorage
    const clientItems = Array.isArray(items)
      ? items.slice(0, 25).map((item) => ({
          productId: String(item.productId || item.id || '').trim(),
          collectionId: String(item.collectionId || item.collection || '').trim(),
          amount: Math.round(Math.max(0, Number(item.price || 0)) * 100), // dollars → cents
          quantity: Math.max(1, Math.min(99, parseInt(item.quantity, 10) || 1)),
        }))
      : [];

    const subtotalCents = clientItems.reduce(
      (sum, item) => sum + item.amount * item.quantity,
      0
    );

    const minSubtotalCents = Math.round(Number(promotion.minSubtotal || 0) * 100);
    if (subtotalCents < minSubtotalCents) {
      return json({
        valid: false,
        message: `Minimum order of $${promotion.minSubtotal.toFixed(2)} required for this code.`,
      }, 200, headers);
    }

    const targetProductIds = promotion.targetProductIds || [];
    const targetCollectionIds = promotion.targetCollectionIds || [];
    const hasTargets = targetProductIds.length > 0 || targetCollectionIds.length > 0;

    const discountCents = computePromotionDiscount(
      promotion,
      subtotalCents,
      0,
      hasTargets ? clientItems : null
    );

    if (hasTargets && discountCents === 0) {
      return json({
        valid: false,
        message: 'This code applies to specific items not in your bag.',
      }, 200, headers);
    }

    const discount = (discountCents / 100).toFixed(2);
    return json({
      valid: true,
      code: promotion.code,
      label: promotion.label,
      type: promotion.type,
      value: promotion.value,
      discountCents,
      discount,
      message: promotion.description || `${promotion.label} applied!`,
      targetProductIds,
      targetCollectionIds,
    }, 200, headers);
  } catch (e) {
    return json({ valid: false, message: 'Could not validate promo code.' }, 200, headers);
  }
}
