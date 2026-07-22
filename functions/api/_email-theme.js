/**
 * Shared email theming + editable content.
 *
 * Every transactional email pulls its look and copy from site_settings, so the
 * admin "Emails" editor controls all of them at once instead of each one baking
 * in its own fonts/colours/text:
 *
 *   - site_settings.fonts        → font-family stacks. NOTE: mail clients can't
 *                                  load web fonts (Futura etc.), so we keep the
 *                                  admin's named families as a hint and always
 *                                  append a universal system fallback.
 *   - site_settings.brand        → accent colour + logo.
 *   - site_settings.email_theme  → 'dark' (default) | 'light' ground.
 *   - site_settings.email_settings[type] → { subject, kicker, heading, intro,
 *                                  footer } editable copy, per email type.
 *
 * Everything is optional and falls back to today's hardcoded look/text, so an
 * email never breaks if a setting is missing or malformed. Read server-side with
 * the service key (fetchSiteSettings), so no public-read RLS change is needed.
 */

function asObj(v) {
  if (!v) return {};
  if (typeof v === 'string') { try { return JSON.parse(v) || {}; } catch (_) { return {}; } }
  return (typeof v === 'object') ? v : {};
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Web fonts can't load in email. Keep the admin's named families (a device that
// actually has one — e.g. Futura on Apple — will use it), drop the generic
// keyword, then append fonts that really exist on the recipient's device so
// there's always a close match. Headings fall back to a GEOMETRIC face
// (Century Gothic ≈ Futura/geometric sans, present on Windows + macOS); body
// falls back to a humanist system stack.
function emailFontStack(adminStack, role) {
  const named = String(adminStack || '').trim()
    .replace(/"/g, "'")   // double→single quotes: a double quote would close the style="…" attribute and mangle the element
    .replace(/;+$/, '')
    .replace(/,?\s*(sans-serif|serif|monospace)\s*$/i, '')
    .replace(/,+\s*$/, '')
    .trim();
  const geo = "'Century Gothic','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const hum = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const base = role === 'head' ? geo : hum;
  return named ? `${named},${base}` : base;
}

// Contrast helpers: keep the brand accent, but if it's too dark to read on a
// dark ground (or too light on a light ground) nudge it toward legibility so
// the kicker/labels never disappear.
function _hexToRgb(hex) {
  const m = String(hex || '').trim().replace(/^#/, '');
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(m)) return null;
  const h = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function _mix(c, target, t) { return Math.round(c + (target - c) * t); }
function _toHex({ r, g, b }) { return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join(''); }
function contrastAccent(hex, light) {
  const rgb = _hexToRgb(hex);
  if (!rgb) return light ? '#b24d63' : '#F891A5';
  const lum = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  // The accent is used at small sizes (11px kicker), so it needs strong contrast.
  if (!light && lum < 0.5) return _toHex({ r: _mix(rgb.r, 255, 0.66), g: _mix(rgb.g, 255, 0.66), b: _mix(rgb.b, 255, 0.66) });
  if (light && lum > 0.6)  return _toHex({ r: _mix(rgb.r, 0, 0.5),    g: _mix(rgb.g, 0, 0.5),    b: _mix(rgb.b, 0, 0.5) });
  return String(hex).trim();
}

export function getEmailAppearance(cache = {}) {
  const fonts = asObj(cache.fonts);
  const brand = asObj(cache.brand);
  const roles = asObj(fonts.roles);
  const headStack = (roles.head && roles.head.stack) || fonts.head || "'Barlow Condensed'";
  const bodyStack = (roles.body && roles.body.stack) || fonts.body || "'Barlow'";
  const monoStack = (roles.mono && roles.mono.stack) || fonts.mono || "'IBM Plex Mono'";
  const light = String(cache.email_theme || '').toLowerCase() === 'light';
  const rawAccent = String(brand.accent || brand.accentColor || '').trim() || '#F891A5';
  const accent = contrastAccent(rawAccent, light);
  const logo = String(cache.BRAND_LOGO_URL || brand.emailLogo || brand.logo || '').trim()
    || 'https://zuwera.store/assets/Zuwera_Wordmark_White.png';
  return {
    light,
    fontHead: emailFontStack(headStack, 'head'),
    fontBody: emailFontStack(bodyStack, 'body'),
    fontMono: `${String(monoStack).replace(/"/g, "'").replace(/;+$/, '').replace(/,?\s*monospace\s*$/i, '')},'Courier New',monospace`,
    accent,
    logo,
    bg:     light ? '#F0EEE9' : '#0b0b0e',
    panel:  light ? '#FFFFFF' : '#17171c',
    text:   light ? '#0b0b0d' : '#f6f3ed',
    // Solid hex, not low-opacity rgba: rgba composites down to a dim grey over a
    // dark panel and some clients (Outlook) drop it entirely. These are the
    // secondary-text colours (intro, meta, footer) — kept clearly legible.
    muted:  light ? '#575249' : '#cbc7be',
    border: light ? '#e2ded4' : '#38383f',
    invertLogo: light,  // white wordmark needs inverting on a light ground
  };
}

// Code defaults for each email type's editable copy. Placeholders like {order}
// / {product} are filled by fillTemplate at send time.
const CONTENT_DEFAULTS = {
  order_confirmation: { subject: 'Order Confirmed – #{order}', kicker: 'Order Confirmed', heading: '#{order}', intro: 'Thanks, {name}. Your order is confirmed and being prepared.', footer: 'Questions about your order? Just reply to this email.' },
  shipped:            { subject: 'Your Zuwera order has shipped', kicker: 'Shipped', heading: 'On its way', intro: '', footer: '' },
  back_in_stock:      { subject: 'Back in stock: {product} ({size})', kicker: 'Back in stock', heading: '{product}', intro: 'The size you wanted is available again — but it may not last. Grab it before it sells out.', footer: "You're receiving this because you asked to be notified when this item came back." },
  return_status:      { subject: 'An update on your return', kicker: 'Return update', heading: 'Your return', intro: '', footer: '' },
  review_request:     { subject: 'How was your Zuwera order?', kicker: 'Your thoughts', heading: 'How did we do?', intro: '{name}your order has had a few days to settle in. A quick review — a line or two, and a photo if you have one — helps other athletes shop with confidence.', footer: "You're receiving this because you ordered from zuwera.store. Thanks for being part of it." },
  abandoned_cart:     { subject: 'You left something in your bag', kicker: 'Still in your bag', heading: 'You left something behind', intro: 'Your bag is still here — grab your picks before they sell out.', footer: "You're receiving this because you started a checkout at zuwera.store. If this wasn't you, ignore this email." },
};

export function getEmailContent(cache, type) {
  const all = asObj(cache && cache.email_settings);
  const def = CONTENT_DEFAULTS[type] || {};
  const cfg = asObj(all[type]);
  const pick = (k) => (cfg[k] != null && String(cfg[k]).trim()) ? String(cfg[k]) : (def[k] || '');
  return { subject: pick('subject'), kicker: pick('kicker'), heading: pick('heading'), intro: pick('intro'), footer: pick('footer') };
}

// Fill {order}, {product}, … placeholders in editable copy.
export function fillTemplate(str, vars) {
  return String(str == null ? '' : str).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null) ? String(vars[k]) : '');
}

/**
 * The standard branded email shell: logo → kicker → heading → intro → the
 * email-specific bodyHtml → footer. Every email that adopts this shares one
 * layout, so theming/fonts change everywhere from one place.
 */
export function renderEmailShell(a, parts = {}) {
  const kicker  = esc(parts.kicker || '');
  const heading = esc(parts.heading || '');
  const intro   = parts.intro ? esc(parts.intro) : '';
  const body    = parts.bodyHtml || '';
  const footer  = parts.footerHtml || (parts.footer ? esc(parts.footer) : '');
  const logoStyle = `height:28px;width:auto;border:0;display:block;margin:0 auto;${a.invertLogo ? 'filter:invert(1);' : ''}`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:${a.bg};font-family:${a.fontBody};color:${a.text};-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${a.bg};">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:${a.panel};border:1px solid ${a.border};border-radius:8px;overflow:hidden;">
        <tr><td style="padding:28px 28px 4px;text-align:center;">
          <img src="${esc(a.logo)}" alt="ZUWERA" height="28" style="${logoStyle}" onerror="this.style.display='none'">
        </td></tr>
        <tr><td style="padding:20px 28px 0;text-align:center;">
          ${kicker ? `<p style="margin:0 0 8px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:${a.accent};font-weight:600;font-family:${a.fontMono};">${kicker}</p>` : ''}
          ${heading ? `<h1 style="margin:0 0 ${intro ? '10' : '4'}px;font-size:30px;font-weight:700;line-height:1.05;color:${a.text};font-family:${a.fontHead};letter-spacing:.01em;">${heading}</h1>` : ''}
          ${intro ? `<p style="margin:0 0 6px;font-size:14px;line-height:1.6;color:${a.muted};">${intro}</p>` : ''}
        </td></tr>
        <tr><td style="padding:22px 28px 8px;">${body}</td></tr>
        ${footer ? `<tr><td style="padding:8px 28px 28px;border-top:1px solid ${a.border};"><p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:${a.muted};text-align:center;">${footer}</p></td></tr>` : '<tr><td style="height:16px"></td></tr>'}
      </table>
    </td></tr>
  </table></body></html>`;
}
