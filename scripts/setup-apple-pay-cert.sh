#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Zuwera Sportswear — Apple Pay Merchant Certificate Setup
# Run once on your local Mac/Linux to generate the Apple Merchant Identity cert.
#
# Usage:
#   chmod +x scripts/setup-apple-pay-cert.sh
#   ./scripts/setup-apple-pay-cert.sh
#
# Output (in apple-pay-certs/ — NEVER commit to git):
#   apple-merchant.key              Private key
#   apple-merchant.csr              Upload this to Apple Developer
#   apple-merchant-cert.pem         Apple's signed certificate (after download)
#   apple-merchant-identity.pem     Combined cert+key (upload to Cloudflare)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="zuwera.store"
ORG="Zuwera Sportswear"
COUNTRY="US"
OUT="./apple-pay-certs"

echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║   Zuwera Apple Pay Certificate Setup          ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

mkdir -p "$OUT"

# Step 1 — Generate private key
echo "Generating private key..."
openssl genrsa -out "$OUT/apple-merchant.key" 2048
chmod 600 "$OUT/apple-merchant.key"
echo "✓ $OUT/apple-merchant.key"

# Step 2 — Generate CSR
echo "Generating CSR..."
openssl req -new \
  -key "$OUT/apple-merchant.key" \
  -out "$OUT/apple-merchant.csr" \
  -subj "/CN=$DOMAIN/O=$ORG/C=$COUNTRY"
echo "✓ $OUT/apple-merchant.csr"

echo ""
echo "──────────────────────────────────────────────────"
echo "  NEXT: Upload the CSR to Apple Developer Portal"
echo "──────────────────────────────────────────────────"
echo "  1. https://developer.apple.com/account/resources/identifiers/list/merchant"
echo "  2. Click your Merchant ID → Create Certificate"
echo "  3. Upload: $OUT/apple-merchant.csr"
echo "  4. Download the .cer file → save as $OUT/apple_pay.cer"
echo ""
echo "  TIP: If using Stripe's paymentRequest() (which Zuwera does), Stripe"
echo "  handles this automatically. Only needed for raw ApplePaySession use."
echo ""
read -rp "Press Enter after saving apple_pay.cer to $OUT/ ..."

# Step 3 — Convert .cer to PEM
[ -f "$OUT/apple_pay.cer" ] || { echo "ERROR: $OUT/apple_pay.cer not found"; exit 1; }
echo ""
echo "Converting certificate to PEM..."
openssl x509 -inform DER -in "$OUT/apple_pay.cer" -out "$OUT/apple-merchant-cert.pem"
echo "✓ $OUT/apple-merchant-cert.pem"

# Step 4 — Combine into identity file
cat "$OUT/apple-merchant-cert.pem" "$OUT/apple-merchant.key" > "$OUT/apple-merchant-identity.pem"
chmod 600 "$OUT/apple-merchant-identity.pem"
echo "✓ $OUT/apple-merchant-identity.pem"

# Step 5 — Verify
echo ""
openssl x509 -in "$OUT/apple-merchant-cert.pem" -noout -subject -dates

echo ""
echo "──────────────────────────────────────────────────"
echo "  NEXT: Upload to Cloudflare"
echo "──────────────────────────────────────────────────"
echo ""
echo "  Option A (Dashboard):"
echo "    CF Dashboard → Pages → zuwera-store → Settings → Functions → mTLS"
echo "    Binding: APPLE_PAY_CERT"
echo "    Cert:    $OUT/apple-merchant-cert.pem"
echo "    Key:     $OUT/apple-merchant.key"
echo ""
echo "  Option B (API):"
echo "    Read wrangler.toml for the curl command."
echo ""
echo "  After uploading, paste the certificate_id into wrangler.toml."
echo ""
echo "✓ Done! Keep apple-pay-certs/ out of git (already in .gitignore)."
