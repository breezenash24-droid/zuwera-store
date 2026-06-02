/**
 * Netlify Function: apple-pay-merchant-session
 *
 * Creates the merchant validation session object for Apple Pay JS API.
 *
 * Required env vars:
 *   APPLE_PAY_MERCHANT_IDENTIFIER
 *   APPLE_PAY_CERT_PEM
 *   APPLE_PAY_KEY_PEM
 *
 * Optional env vars:
 *   APPLE_PAY_DISPLAY_NAME
 *   APPLE_PAY_INITIATIVE_CONTEXT
 */

const https = require('https');
const { ok, err, preflight } = require('./_shared');

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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return err(405, 'Method not allowed');

  try {
    const { validationURL, initiativeContext } = JSON.parse(event.body || '{}');
    if (!validationURL) return err(400, 'Missing validationURL');
    if (!isAppleValidationURL(validationURL)) return err(400, 'Invalid Apple validation URL');

    const merchantIdentifier = process.env.APPLE_PAY_MERCHANT_IDENTIFIER;
    if (!merchantIdentifier) return err(500, 'Missing APPLE_PAY_MERCHANT_IDENTIFIER');

    const cert = normalizePem(process.env.APPLE_PAY_CERT_PEM);
    const key = normalizePem(process.env.APPLE_PAY_KEY_PEM);
    if (!cert || !key) {
      return err(500, 'Missing APPLE_PAY_CERT_PEM or APPLE_PAY_KEY_PEM');
    }

    const headerHost = (event.headers?.['x-forwarded-host'] || event.headers?.host || '').split(':')[0];
    const validatedContext = String(
      initiativeContext ||
      process.env.APPLE_PAY_INITIATIVE_CONTEXT ||
      headerHost
    ).trim().toLowerCase();

    if (!validatedContext) return err(400, 'Missing initiative context (domain)');

    const merchantSession = await postAppleMerchantValidation(validationURL, {
      merchantIdentifier,
      displayName: process.env.APPLE_PAY_DISPLAY_NAME || 'Zuwera',
      initiative: 'web',
      initiativeContext: validatedContext,
    }, cert, key);

    return ok(merchantSession);
  } catch (error) {
    return err(500, error?.message || 'Apple merchant validation failed');
  }
};

