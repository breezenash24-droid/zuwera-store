/**
 * Cloudflare Pages Function: POST /api/email-preview   (admin-protected)
 *
 * Renders any transactional email EXACTLY as it will send — it reuses each
 * email's own builder function plus the shared _email-theme.js engine, with
 * sample data — so the admin can preview it without sending. Because it calls
 * the real builders, the preview can never drift from the sent email.
 *
 * Body: { accessToken, type, theme?, content? }
 *   theme   — 'dark' | 'light' to preview an unsaved background choice
 *   content — { subject,kicker,heading,intro,footer } to preview unsaved copy
 * Returns: text/html of the rendered email (for an <iframe srcdoc>).
 */

import { cors, json, verifyAdmin } from './_commerce.js';
import { fetchSiteSettings, resolveSetting } from './_settings.js';
import { getEmailAppearance, getEmailContent } from './_email-theme.js';
import { buildEmail as buildBackInStock } from './notify-restock.js';
import { buildEmail as buildReview } from './send-review-requests.js';
import { buildEmail as buildAbandoned } from './send-abandoned-cart-emails.js';
import { buildEmail as buildReturnStatus } from './send-return-status-email.js';
import { buildReturnLabelEmail } from './generate-return-label.js';
import { buildRefundEmail } from './admin-refund.js';
import { buildOrderConfirmation } from './stripe-webhook.js';
import { shippedEmail, deliveredEmail } from './shippo-webhook.js';
import { buildJournalEmail } from './send-journal.js';

const SITE = 'https://zuwera.store';
const LOGO_FALLBACK = 'https://zuwera.store/assets/Zuwera_Wordmark_White.png';
// Self-contained placeholder so previews never depend on a live product image.
const SAMPLE_IMG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='300'%3E%3Crect width='100%25' height='100%25' fill='%23e6e4df'/%3E%3Ctext x='50%25' y='50%25' font-family='sans-serif' font-size='15' fill='%23a09a90' text-anchor='middle' dominant-baseline='middle'%3EProduct photo%3C/text%3E%3C/svg%3E";

export const PREVIEWABLE_TYPES = [
  'order_confirmation', 'shipped', 'delivered', 'back_in_stock',
  'review_request', 'abandoned_cart', 'return_status', 'return_label',
  'refund', 'journal',
];

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  try {
    const authHeader = request.headers.get('Authorization') || '';
    const body = await request.json().catch(() => ({}));
    const accessToken = String(body.accessToken || authHeader.replace(/^Bearer\s+/i, '') || '').trim();
    if (!accessToken) return json({ ok: false, error: 'Missing access token' }, 401, cors(env));
    const admin = await verifyAdmin(env, accessToken);
    if (!admin) return json({ ok: false, error: 'Admin access required' }, 403, cors(env));

    const type = String(body.type || 'back_in_stock');

    const cache = await fetchSiteSettings(
      ['fonts', 'brand', 'email_theme', 'email_settings', 'BRAND_LOGO_URL', 'journal_settings'], env
    );
    // Apply unsaved-edit overrides so the preview matches the editor live.
    if (body.theme === 'light' || body.theme === 'dark') cache.email_theme = body.theme;
    const lh = parseInt(body.logoHeight, 10);
    const hasContent = body.content && typeof body.content === 'object';
    if (hasContent || (lh >= 14 && lh <= 90)) {
      let es = cache.email_settings;
      if (typeof es === 'string') { try { es = JSON.parse(es); } catch (_) { es = {}; } }
      es = (es && typeof es === 'object') ? es : {};
      if (hasContent) es[type] = Object.assign({}, es[type], body.content);
      if (lh >= 14 && lh <= 90) es.logoHeight = lh;   // preview an unsaved logo size
      cache.email_settings = es;
    }

    const appearance = getEmailAppearance(cache);
    const logoUrl = resolveSetting('BRAND_LOGO_URL', env, cache) || LOGO_FALLBACK;
    appearance.logo = logoUrl;
    const content = getEmailContent(cache, type);

    const html = renderPreview(type, appearance, content, cache, logoUrl);
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...cors(env) },
    });
  } catch (e) {
    const msg = String((e && e.message) || 'Preview failed');
    return new Response(
      `<div style="font-family:sans-serif;padding:24px;color:#b00">Preview error: ${msg.replace(/</g, '&lt;')}</div>`,
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

// Sample HTML fragments for the order-confirmation preview, built with the same
// appearance tokens the real webhook uses so the preview matches the sent email.
function sampleOrderFragments(a) {
  const item = (name, variant, sku, price, qty) => `<tr>
    <td style="padding:16px 0;border-bottom:1px solid ${a.border};vertical-align:top;width:80px;"><img src="${SAMPLE_IMG}" alt="" width="72" height="90" style="width:72px;height:90px;object-fit:cover;border-radius:4px;display:block;"></td>
    <td style="padding:16px 12px;border-bottom:1px solid ${a.border};vertical-align:top;">
      <div style="font-weight:600;font-size:15px;color:${a.text};margin-bottom:4px;">${name}</div>
      <div style="font-size:13px;color:${a.muted};margin-bottom:4px;">${variant}</div>
      <div style="font-size:11px;color:${a.muted};letter-spacing:.04em;font-family:${a.fontMono};">SKU: ${sku}</div>
    </td>
    <td style="padding:16px 0;border-bottom:1px solid ${a.border};vertical-align:top;text-align:right;white-space:nowrap;">
      <div style="font-size:14px;color:${a.text};font-weight:500;">$${price.toFixed(2)}</div>
      ${qty > 1 ? `<div style="font-size:12px;color:${a.muted};margin-top:3px;">× ${qty}</div>` : ''}
    </td></tr>`;
  const itemsHtml = item('Zuwera Aero Pro', 'M · Tennesee', 'AER-M-TEN', 35, 1) + item('Zuwera Fleece', 'L · Navy', 'FLC-L-NVY', 30, 1);
  const addressHtml = `
      <tr><td style="padding:24px 0 4px;">
        <p style="margin:0 0 8px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${a.muted};font-weight:600;font-family:${a.fontMono};">Ships to</p>
        <p style="margin:0;font-size:14px;color:${a.text};line-height:1.65;">Alex Kim<br>123 Market St<br>Nashville, TN 37201</p>
      </td></tr>`;
  const carrierHtml = `
      <tr><td style="padding:16px 0 8px;">
        <p style="margin:0 0 8px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${a.muted};font-weight:600;font-family:${a.fontMono};">Delivery</p>
        <p style="margin:0;font-size:14px;color:${a.text};">Ships via USPS Ground Advantage</p>
        <p style="margin:4px 0 0;font-size:14px;color:${a.muted};">Estimated delivery: 5–7 business days</p>
      </td></tr>`;
  return { itemsHtml, addressHtml, carrierHtml };
}

function renderPreview(type, appearance, content, cache, logoUrl) {
  const productUrl = SITE + '/product/sample?id=demo';
  switch (type) {
    case 'order_confirmation': {
      const f = sampleOrderFragments(appearance);
      return buildOrderConfirmation({ appearance, content, orderId: 'AB12CD', toName: 'Alex Kim', itemsHtml: f.itemsHtml, subtotalCents: 6500, discountRow: '', shippingDisplay: 'Free', taxCents: 546, totalDollars: '70.46', addressHtml: f.addressHtml, carrierHtml: f.carrierHtml });
    }

    case 'return_label':
      return buildReturnLabelEmail({ toName: 'Alex Kim', orderLabel: '#AB12CD', label: { carrier: 'USPS', service: 'Ground Advantage', trackingNumber: '9400 1000 0000 0000', labelUrl: '#', trackingUrl: '#' }, storeAddress: 'Zuwera Returns\n123 Market St\nNashville, TN 37201\nUS', resolutionLabel: 'refund', appearance });

    case 'refund':
      return buildRefundEmail({ action: 'refund', orderNumber: 'AB12CD', orderTotal: 70.46, stripeRefundAmount: 3500, reason: 'customer request', customerName: 'Alex Kim', customerNote: '', fromEmail: 'support@zuwera.store', appearance }).html;

    case 'back_in_stock':
      return buildBackInStock({ productTitle: 'Zuwera Aero Pro', size: 'M', colorName: 'Tennesee', url: productUrl, image: SAMPLE_IMG, appearance, content });

    case 'review_request':
      return buildReview({ items: [{ name: 'Zuwera Aero Pro', image: SAMPLE_IMG }, { name: 'Zuwera Fleece', image: SAMPLE_IMG }], name: 'Alex', appearance, content });

    case 'abandoned_cart':
      return buildAbandoned({ items: [{ title: 'Zuwera Aero Pro', color: 'Tennesee', size: 'M', qty: 1, price: 35, image: SAMPLE_IMG }, { title: 'Zuwera Fleece', color: 'Navy', size: 'L', qty: 1, price: 65, image: SAMPLE_IMG }], url: SITE + '/bag.html', appearance, content });

    case 'shipped':
      return shippedEmail({ orderId: 'AB12CD', customerName: 'Alex', carrier: 'USPS', trackingNumber: '9400 1000 0000 0000 0000 00', trackingUrl: '#', eta: new Date(Date.now() + 3 * 86400000).toISOString(), logoUrl, appearance });

    case 'delivered':
      return deliveredEmail({ orderId: 'AB12CD', customerName: 'Alex', logoUrl, appearance });

    case 'return_status':
      return buildReturnStatus({ r: { orderLabel: '#AB12CD', orderId: 'AB12CD', customerMessage: '', carrier: 'USPS', service: 'Ground Advantage', labelUrl: '#', trackingNumber: '9400 1000 0000 0000', trackingUrl: '#', resolution: 'return' }, status: 'approved', resolution: 'return', fromFirstName: 'Alex', logoUrl, appearance });

    case 'journal': {
      let js = cache.journal_settings;
      if (typeof js === 'string') { try { js = JSON.parse(js); } catch (_) { js = null; } }
      return buildJournalEmail({ post: { title: 'Behind The Design', slug: 'behind-the-design', body: 'This is a preview of a journal post.\n\nA second paragraph shows how body copy wraps and breathes inside the email layout.', cover_image: SAMPLE_IMG, published_at: new Date().toISOString() }, label: (js && js.label) || 'The Journal', logoUrl, unsubUrl: '#', appearance });
    }

    default:
      return `<div style="font-family:sans-serif;padding:24px;color:#666">No preview available for "${String(type).replace(/</g, '&lt;')}". This email is generated inline by its handler and isn't wired to the preview yet.</div>`;
  }
}
