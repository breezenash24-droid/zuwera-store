const DEFAULT_ADMIN_EMAILS = [
  'breezenash24@gmail.com',
  'nasirubreeze@zuwera.store'
];

const DEFAULT_ADMIN_USER_IDS = [];

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
    const error = new Error('Your account does not have admin image delete access.');
    error.status = 403;
    throw error;
  }

  return user;
}

function keyFromPublicUrl(env, value) {
  const base = String(env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return '';

  try {
    const baseUrl = new URL(base);
    const url = new URL(String(value || ''));
    if (url.hostname !== baseUrl.hostname) return '';

    const basePath = baseUrl.pathname.replace(/\/+$/, '');
    if (basePath && !url.pathname.startsWith(`${basePath}/`)) return '';

    const rawKey = url.pathname.slice((basePath ? basePath.length : 0) + 1);
    const key = decodeURIComponent(rawKey);
    return key.startsWith('products/') && !key.includes('..') ? key : '';
  } catch {
    return '';
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.PRODUCT_IMAGES_BUCKET?.delete) {
      return json({ success: false, error: 'R2 product image bucket binding is not configured.' }, 500);
    }

    await verifyAdmin(request, env);

    const body = await request.json().catch(() => ({}));
    const urls = Array.isArray(body.urls) ? body.urls : [];
    const keys = [...new Set(urls.map((url) => keyFromPublicUrl(env, url)).filter(Boolean))];

    for (const key of keys) {
      await env.PRODUCT_IMAGES_BUCKET.delete(key);
    }

    return json({ success: true, deleted: keys.length });
  } catch (error) {
    return json({ success: false, error: error.message || 'Image cleanup failed.' }, error.status || 500);
  }
}
