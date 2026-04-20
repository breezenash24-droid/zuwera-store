const DEFAULT_ADMIN_EMAILS = [
  'breezenash24@gmail.com',
  'nasirubreeze@zuwera.store'
];

const DEFAULT_ADMIN_USER_IDS = [];
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

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

export async function onRequestPost({ request, env }) {
  try {
    if (!env.PRODUCT_IMAGES_BUCKET?.put) {
      return json({ success: false, error: 'R2 product image bucket binding is not configured.' }, 500);
    }

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

    await env.PRODUCT_IMAGES_BUCKET.put(key, body, {
      httpMetadata: {
        contentType: file.type,
        cacheControl: 'public, max-age=31536000, immutable'
      },
      customMetadata: {
        originalName: String(file.name || ''),
        uploadedBy: 'zuwera-admin'
      }
    });

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
