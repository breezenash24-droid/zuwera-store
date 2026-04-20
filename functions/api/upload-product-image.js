const DEFAULT_ADMIN_EMAILS = [
  'breezenash24@gmail.com',
  'nasirubreeze@zuwera.store'
];

const DEFAULT_ADMIN_USER_IDS = [];
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function parseList(value, { lowercase = true } = {}) {
  return String(value || '')
    .split(',')
    .map((item) => {
      const trimmed = item.trim();
      return lowercase ? trimmed.toLowerCase() : trimmed;
    })
    .filter(Boolean);
}

function collectEmails(user) {
  return [...new Set([
    user?.email,
    user?.user_metadata?.email,
    ...(Array.isArray(user?.identities)
      ? user.identities.map((identity) => identity?.identity_data?.email || identity?.email)
      : [])
  ])]
    .map((value) => String(value || '').toLowerCase().trim())
    .filter(Boolean);
}

function collectUserIds(user) {
  return [...new Set([
    user?.id,
    user?.user_metadata?.user_id,
    ...(Array.isArray(user?.identities)
      ? user.identities.map((identity) => identity?.id || identity?.user_id)
      : [])
  ])]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function isAllowedAdmin(user, env) {
  const emails = collectEmails(user);
  const exactEmails = new Set([
    ...DEFAULT_ADMIN_EMAILS,
    ...parseList(env.ADMIN_EMAILS)
  ]);
  const exactUserIds = new Set([
    ...DEFAULT_ADMIN_USER_IDS,
    ...parseList(env.ADMIN_USER_IDS, { lowercase: false })
  ]);
  const userIds = collectUserIds(user);

  return emails.some((email) => exactEmails.has(email))
    || userIds.some((userId) => exactUserIds.has(userId));
}

async function verifyAdmin(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  const apiKey = env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;

  if (!env.SUPABASE_URL || !apiKey) {
    throw new Error('Supabase admin verification is not configured.');
  }

  if (!accessToken) {
    const error = new Error('Missing admin session token.');
    error.status = 401;
    throw error;
  }

  const resp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!resp.ok) {
    const error = new Error(`Unable to verify admin session (${resp.status}).`);
    error.status = 401;
    throw error;
  }

  const user = await resp.json();
  if (!user?.id || !isAllowedAdmin(user, env)) {
    const error = new Error('Your account does not have admin upload access.');
    error.status = 403;
    throw error;
  }

  return user;
}

function extensionForType(type, fallbackName = '') {
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/gif') return 'gif';
  const ext = String(fallbackName).split('.').pop()?.toLowerCase();
  return ext && /^[a-z0-9]+$/.test(ext) ? ext : 'webp';
}

function safeSegment(value, fallback) {
  return String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || fallback;
}

function publicUrlForKey(env, key) {
  const base = String(env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base) {
    const error = new Error('R2_PUBLIC_BASE_URL is not configured.');
    error.status = 500;
    throw error;
  }
  return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(value) {
  return toHex(await crypto.subtle.digest('SHA-256', value));
}

async function hmac(key, value) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, typeof value === 'string' ? new TextEncoder().encode(value) : value);
}

async function getSigningKey(secretAccessKey, dateStamp) {
  const kDate = await hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = await hmac(kDate, 'auto');
  const kService = await hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

function encodePath(path) {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function r2Endpoint(env) {
  const accountId = String(env.R2_ACCOUNT_ID || '').trim();
  if (!accountId) {
    const error = new Error('R2_ACCOUNT_ID is not configured.');
    error.status = 500;
    throw error;
  }

  const jurisdiction = String(env.R2_JURISDICTION || '').trim().toLowerCase();
  const jurisdictionPart = jurisdiction ? `.${jurisdiction}` : '';
  return `https://${accountId}${jurisdictionPart}.r2.cloudflarestorage.com`;
}

function r2BucketName(env) {
  return String(env.R2_BUCKET_NAME || 'zuwera-product-images').trim();
}

function requireR2ApiCredentials(env) {
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || '').trim();
  if (!accessKeyId || !secretAccessKey) {
    const error = new Error('R2 API credentials are not configured.');
    error.status = 500;
    throw error;
  }
  return { accessKeyId, secretAccessKey };
}

async function signedR2Request(env, { method, key, body, contentType }) {
  const { accessKeyId, secretAccessKey } = requireR2ApiCredentials(env);
  const endpoint = r2Endpoint(env);
  const bucket = r2BucketName(env);
  const url = new URL(`${endpoint}/${bucket}/${encodePath(key)}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = body ? await sha256Hex(body) : EMPTY_SHA256;
  const headers = {
    'cache-control': 'public, max-age=31536000, immutable',
    'content-type': contentType || 'application/octet-stream',
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  };

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join('');
  const canonicalRequest = [
    method,
    url.pathname,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(new TextEncoder().encode(canonicalRequest))
  ].join('\n');
  const signingKey = await getSigningKey(secretAccessKey, dateStamp);
  const signature = toHex(await hmac(signingKey, stringToSign));
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const { host, ...requestHeaders } = headers;
  return fetch(url.href, {
    method,
    headers: {
      ...requestHeaders,
      Authorization: authorization
    },
    body
  });
}

async function putR2Object(env, key, body, contentType) {
  if (env.PRODUCT_IMAGES_BUCKET?.put) {
    await env.PRODUCT_IMAGES_BUCKET.put(key, body, {
      httpMetadata: {
        contentType,
        cacheControl: 'public, max-age=31536000, immutable'
      },
      customMetadata: {
        uploadedBy: 'zuwera-admin'
      }
    });
    return;
  }

  const resp = await signedR2Request(env, {
    method: 'PUT',
    key,
    body,
    contentType
  });

  if (!resp.ok) {
    throw new Error(`R2 S3 upload failed (${resp.status}): ${await resp.text()}`);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    await verifyAdmin(request, env);

    const form = await request.formData();
    const file = form.get('file');
    const productId = safeSegment(form.get('productId'), 'unassigned');

    if (!file || typeof file.arrayBuffer !== 'function') {
      return json({ success: false, error: 'Missing image file.' }, 400);
    }

    if (!ALLOWED_TYPES.has(file.type)) {
      return json({ success: false, error: 'Only JPEG, PNG, WebP, and GIF images are allowed.' }, 400);
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return json({ success: false, error: 'Image is still too large after compression. Please use an image under 6 MB.' }, 413);
    }

    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const ext = extensionForType(file.type, file.name);
    const key = `products/${yyyy}/${mm}/${productId}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
    const body = await file.arrayBuffer();

    await putR2Object(env, key, body, file.type);

    return json({
      success: true,
      key,
      url: publicUrlForKey(env, key),
      size: file.size,
      contentType: file.type
    });
  } catch (error) {
    return json({ success: false, error: error.message || 'Image upload failed.' }, error.status || 500);
  }
}
