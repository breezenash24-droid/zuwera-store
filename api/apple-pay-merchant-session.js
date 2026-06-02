/**
 * Vercel Function: /api/apple-pay-merchant-session
 */

const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': process.env.SITE_URL || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function normalizePem(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

function isAppleValidationURL(urlValue) {
  try {
    const parsed = new URL(urlValue);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host.includes('apple-pay-gateway') && host.endsWith('.apple.com');
  } catch {
    return false;
  }
}

function postAppleMerchantValidation(validationURL, payload, cert, key) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(validationURL, {
      method: 'POST',
      cert,
      key,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (resp) => {
      let raw = '';
      resp.on('data', (chunk) => { raw += chunk; });
      resp.on('end', () => {
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          reject(new Error(`Apple validation failed (${resp.statusCode}): ${raw.slice(0, 700)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (parseError) {
          reject(new Error(`Apple validation returned invalid JSON: ${parseError.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { validationURL, initiativeContext } = req.body || {};
    if (!validationURL) return res.status(400).json({ error: 'Missing validationURL' });
    if (!isAppleValidationURL(validationURL)) return res.status(400).json({ error: 'Invalid Apple validation URL' });

    const merchantIdentifier = process.env.APPLE_PAY_MERCHANT_IDENTIFIER;
    if (!merchantIdentifier) return res.status(500).json({ error: 'Missing APPLE_PAY_MERCHANT_IDENTIFIER' });

    const cert = normalizePem(process.env.APPLE_PAY_CERT_PEM);
    const key = normalizePem(process.env.APPLE_PAY_KEY_PEM);
    if (!cert || !key) {
      return res.status(500).json({ error: 'Missing APPLE_PAY_CERT_PEM or APPLE_PAY_KEY_PEM' });
    }

    const hostHeader = (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
    const validatedContext = String(
      initiativeContext ||
      process.env.APPLE_PAY_INITIATIVE_CONTEXT ||
      hostHeader
    ).trim().toLowerCase();
    if (!validatedContext) return res.status(400).json({ error: 'Missing initiative context (domain)' });

    const merchantSession = await postAppleMerchantValidation(validationURL, {
      merchantIdentifier,
      displayName: process.env.APPLE_PAY_DISPLAY_NAME || 'Zuwera',
      initiative: 'web',
      initiativeContext: validatedContext,
    }, cert, key);

    return res.status(200).json(merchantSession);
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Apple merchant validation failed' });
  }
};

