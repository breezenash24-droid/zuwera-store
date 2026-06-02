/**
 * Zuwera Sportswear — Apple Pay Merchant Certificate Setup
 * Works on Windows, Mac, and Linux (Node.js 18+, no extra packages needed)
 *
 * Usage:
 *   node scripts/setup-apple-pay-cert.js
 *
 * What it does:
 *   1. Generates an RSA-2048 private key
 *   2. Generates a Certificate Signing Request (CSR) to upload to Apple
 *   3. After you download the signed cert from Apple, converts it to PEM format
 *   4. Combines cert + key into the identity file that gets uploaded to Cloudflare
 *
 * Output (saved to apple-pay-certs/ — already in .gitignore, NEVER commit):
 *   apple-merchant.key              Private key — keep this secret
 *   apple-merchant.csr              Upload this to Apple Developer
 *   apple-merchant-cert.pem         Apple's signed cert (after step 3)
 *   apple-merchant-identity.pem     Upload this to Cloudflare (cert + key combined)
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const readline = require('readline');

// ── Config ────────────────────────────────────────────────────────────────────
const DOMAIN       = 'zuwera.store';
const ORG          = 'Zuwera Sportswear';
const COUNTRY      = 'US';
const OUTPUT_DIR   = path.join(process.cwd(), 'apple-pay-certs');

// ── Helpers ───────────────────────────────────────────────────────────────────
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

function log(msg)  { console.log(msg); }
function ok(msg)   { console.log('  \u2713 ' + msg); }
function warn(msg) { console.log('  ! ' + msg); }
function hr()      { console.log('\n' + '─'.repeat(56) + '\n'); }

/**
 * Build a minimal DER-encoded CSR manually.
 * Node's built-in crypto doesn't expose a CSR builder, so we construct
 * the ASN.1 DER structure directly. This matches what openssl req would output.
 */
function buildCsrDer(publicKeyDer, privateKey, subject) {
  // ASN.1 helpers
  function tag(t, content) {
    const len = content.length;
    if (len < 128) return Buffer.concat([Buffer.from([t, len]), content]);
    if (len < 256) return Buffer.concat([Buffer.from([t, 0x81, len]), content]);
    return Buffer.concat([Buffer.from([t, 0x82, (len >> 8) & 0xff, len & 0xff]), content]);
  }
  const seq  = c => tag(0x30, c);
  const set_ = c => tag(0x31, c);
  const ctx  = (n, c) => tag(0xa0 + n, c);
  function oid(bytes) { return tag(0x06, Buffer.from(bytes)); }
  function utf8str(s) { return tag(0x0c, Buffer.from(s, 'utf8')); }
  function int_(n)    { return tag(0x02, Buffer.from([n])); }
  function bitstr(b)  { return tag(0x03, Buffer.concat([Buffer.from([0x00]), b])); }

  // OIDs
  const OID_RSA      = oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
  const OID_SHA256RSA= oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]);
  const OID_CN       = oid([0x55, 0x04, 0x03]);
  const OID_O        = oid([0x55, 0x04, 0x0a]);
  const OID_C        = oid([0x55, 0x04, 0x06]);

  function rdnAttr(attrOid, value) {
    return set_(seq(Buffer.concat([attrOid, utf8str(value)])));
  }

  // Subject: C, O, CN
  const subjectDer = seq(Buffer.concat([
    rdnAttr(OID_C,  subject.country),
    rdnAttr(OID_O,  subject.org),
    rdnAttr(OID_CN, subject.cn),
  ]));

  // SubjectPublicKeyInfo
  const spki = seq(Buffer.concat([
    seq(Buffer.concat([OID_RSA, tag(0x05, Buffer.alloc(0))])),
    bitstr(publicKeyDer),
  ]));

  // CertificationRequestInfo (version=0, subject, spki, no attributes)
  const certReqInfo = seq(Buffer.concat([
    int_(0),
    subjectDer,
    spki,
    ctx(0, Buffer.alloc(0)),
  ]));

  // Sign CertificationRequestInfo with SHA-256 + RSA
  const sign = crypto.createSign('SHA256');
  sign.update(certReqInfo);
  const signature = sign.sign(privateKey);

  // Full CertificationRequest
  return seq(Buffer.concat([
    certReqInfo,
    seq(Buffer.concat([OID_SHA256RSA, tag(0x05, Buffer.alloc(0))])),
    bitstr(signature),
  ]));
}

function derToPem(label, der) {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/**
 * Convert Apple's DER-encoded .cer certificate to PEM format.
 * Apple downloads are in DER (binary) format; Cloudflare needs PEM (base64).
 */
function cerToPem(cerBuffer) {
  // A DER certificate starts with 0x30 0x82 (SEQUENCE of length > 127)
  // If the file looks like it's already PEM (starts with "-----"), just return it
  const str = cerBuffer.toString('utf8', 0, 10);
  if (str.startsWith('-----')) return cerBuffer.toString('utf8');
  return derToPem('CERTIFICATE', cerBuffer);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('');
  log('╔════════════════════════════════════════════════════════╗');
  log('║        Zuwera Apple Pay Certificate Setup              ║');
  log('╚════════════════════════════════════════════════════════╝');
  log('');

  // Create output directory
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  ok('Output directory: apple-pay-certs\\');

  hr();
  log('STEP 1 OF 4 — Generating RSA-2048 private key...');

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'pkcs1', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const keyPath = path.join(OUTPUT_DIR, 'apple-merchant.key');
  fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
  ok('Saved: apple-pay-certs\\apple-merchant.key');

  hr();
  log('STEP 2 OF 4 — Generating Certificate Signing Request (CSR)...');

  const csrDer = buildCsrDer(publicKey, privateKey, {
    cn:      DOMAIN,
    org:     ORG,
    country: COUNTRY,
  });

  const csrPem = derToPem('CERTIFICATE REQUEST', csrDer);
  const csrPath = path.join(OUTPUT_DIR, 'apple-merchant.csr');
  fs.writeFileSync(csrPath, csrPem);
  ok('Saved: apple-pay-certs\\apple-merchant.csr');

  hr();
  log('STEP 3 OF 4 — Upload CSR to Apple Developer Portal');
  log('');
  log('  1. Open this URL in your browser:');
  log('     https://developer.apple.com/account/resources/identifiers/list/merchant');
  log('');
  log('  2. Click your Merchant ID (or create: merchant.store.zuwera)');
  log('');
  log('  3. Under "Apple Pay on the Web" → Create Certificate');
  log('');
  log('  4. Upload the file: apple-pay-certs\\apple-merchant.csr');
  log('');
  log('  5. Download the signed .cer file Apple gives you');
  log('');
  log('  6. Save it to: apple-pay-certs\\apple_pay.cer');
  log('');
  log('  ─────────────────────────────────────────────────────');
  log('  STRIPE SHORTCUT: If using Stripe\'s paymentRequest()');
  log('  (which Zuwera does), Stripe handles this for you.');
  log('  Go to: Stripe Dashboard → Settings → Payment methods');
  log('  → Apple Pay → Add domain → zuwera.store');
  log('  Stripe registers with Apple and gives you the domain');
  log('  verification file. Skip the cert steps above.');
  log('  ─────────────────────────────────────────────────────');
  log('');

  await ask('  Press Enter once you\'ve saved apple_pay.cer to apple-pay-certs\\ ...');

  const cerPath = path.join(OUTPUT_DIR, 'apple_pay.cer');
  if (!fs.existsSync(cerPath)) {
    warn('ERROR: apple-pay-certs\\apple_pay.cer not found.');
    warn('Download the cert from Apple and save it there, then re-run.');
    process.exit(1);
  }

  hr();
  log('STEP 4 OF 4 — Converting certificate and creating identity file...');

  const cerBuffer = fs.readFileSync(cerPath);
  const certPem   = cerToPem(cerBuffer);
  const certPath  = path.join(OUTPUT_DIR, 'apple-merchant-cert.pem');
  fs.writeFileSync(certPath, certPem);
  ok('Saved: apple-pay-certs\\apple-merchant-cert.pem');

  // Combined identity file (cert + key) — what Cloudflare needs for mTLS
  const identityPem  = certPem + '\n' + privateKey;
  const identityPath = path.join(OUTPUT_DIR, 'apple-merchant-identity.pem');
  fs.writeFileSync(identityPath, identityPem, { mode: 0o600 });
  ok('Saved: apple-pay-certs\\apple-merchant-identity.pem');

  hr();
  log('STEP 5 — Upload to Cloudflare Pages');
  log('');
  log('  In your browser:');
  log('  Cloudflare Dashboard → Pages → zuwera-store');
  log('  → Settings → Functions → mTLS Certificate Bindings → Add');
  log('');
  log('  Binding name:  APPLE_PAY_CERT');
  log('  Certificate:   apple-pay-certs\\apple-merchant-cert.pem');
  log('  Private key:   apple-pay-certs\\apple-merchant.key');
  log('');
  log('  After uploading, copy the Certificate ID shown.');
  log('  Open wrangler.toml and replace:');
  log('    certificate_id = "REPLACE_WITH_YOUR_CF_CERTIFICATE_ID"');
  log('  with the ID you just copied, then commit and push.');
  log('');
  log('STEP 6 — Add environment variables');
  log('');
  log('  In CF Pages → Settings → Environment variables, add:');
  log('    APPLE_MERCHANT_ID   = merchant.store.zuwera');
  log('    APPLE_DOMAIN_NAME   = zuwera.store');
  log('    APPLE_DISPLAY_NAME  = Zuwera Sportswear');
  log('');
  log('════════════════════════════════════════════════════════');
  log('  Done! Keep apple-pay-certs\\ safe — it\'s in .gitignore.');
  log('════════════════════════════════════════════════════════');
  log('');
}

main().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
