# Apple Pay Web Setup (Zuwera)

This repo now includes:
- Frontend Apple Pay session flow in `index.html` and `product.html`
- Merchant validation endpoint: `/api/apple-pay-merchant-session`
- Payment authorization endpoint: `/api/apple-pay-authorize`
- Apple domain association path placeholder:
  `/.well-known/apple-developer-merchantid-domain-association`

## 1) Required Secrets / Vars

### For Cloudflare Pages Functions (`functions/api/*`)
- `STRIPE_SECRET_KEY`
- `SITE_URL`
- `APPLE_PAY_MERCHANT_IDENTIFIER`
- `APPLE_PAY_DISPLAY_NAME` (optional, defaults to `Zuwera`)
- `APPLE_PAY_INITIATIVE_CONTEXT` (optional, usually your checkout domain)
- `APPLE_PAY_MTLS` binding (required for Apple merchant validation)

### For Netlify Functions (`netlify/functions/*`)
- `STRIPE_SECRET_KEY`
- `SITE_URL`
- `APPLE_PAY_MERCHANT_IDENTIFIER`
- `APPLE_PAY_DISPLAY_NAME` (optional)
- `APPLE_PAY_INITIATIVE_CONTEXT` (optional)
- `APPLE_PAY_CERT_PEM` (merchant identity certificate PEM)
- `APPLE_PAY_KEY_PEM` (merchant identity private key PEM)

Use escaped newlines in env vars for PEM material (`\n`) and never expose these in client code.

## 2) Domain Verification File

Replace the placeholder file at:
`/.well-known/apple-developer-merchantid-domain-association`

with the exact Apple-provided file contents from your Merchant ID setup.

## 3) Cloudflare Routing (for verification path)

If you use Cloudflare Pages static assets, the file above is served directly.
If you place a Worker in front, keep a bypass/pass-through for this path:

```js
if (url.pathname === '/.well-known/apple-developer-merchantid-domain-association') {
  return env.ASSETS.fetch(request);
}
```

Equivalent Transform/Rules intent: do not rewrite this path, and let it resolve as a plain text static asset.

## 4) Merchant Session Hand-off

Frontend flow:
1. `ApplePaySession` starts from wallet button click.
2. `onvalidatemerchant` sends `validationURL` to `/api/apple-pay-merchant-session`.
3. Backend returns merchant session object.
4. Frontend calls `session.completeMerchantValidation(sessionObject)`.
5. On `onpaymentauthorized`, frontend posts token payload to `/api/apple-pay-authorize`.
6. On success, checkout moves to Order Confirmed immediately.

