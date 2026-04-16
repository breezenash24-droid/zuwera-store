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
  const allowedDomains = parseList(env.ADMIN_EMAIL_DOMAINS);
  const userIds = collectUserIds(user);

  const isExactEmailAllowed = emails.some((email) => exactEmails.has(email));
  const isExactUserAllowed = userIds.some((userId) => exactUserIds.has(userId));
  const isDomainAllowed = allowedDomains.length > 0 && emails.some((email) => {
    const at = email.lastIndexOf('@');
    return at > -1 && allowedDomains.includes(email.slice(at + 1));
  });

  return isExactEmailAllowed || isExactUserAllowed || isDomainAllowed;
}

async function fetchUser(accessToken, env) {
  const apiKey = env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  const resp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!resp.ok) {
    throw new Error(`Unable to verify session (${resp.status})`);
  }

  return resp.json();
}

async function upsertAdminProfile(user, env) {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  const emails = collectEmails(user);
  const payload = {
    id: user.id,
    email: emails[0] || user.email || null,
    full_name: user?.user_metadata?.full_name || null,
    role: 'admin'
  };

  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?on_conflict=id`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    throw new Error(`Unable to update admin profile (${resp.status})`);
  }

  const data = await resp.json().catch(() => null);
  return Array.isArray(data) ? data[0] || payload : (data || payload);
}

export async function onRequestPost({ request, env }) {
  try {
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
    if (!env.SUPABASE_URL || !serviceKey) {
      return json({ success: false, error: 'Supabase admin access is not configured.' }, 500);
    }

    const body = await request.json().catch(() => ({}));
    const accessToken = String(body?.accessToken || '').trim();

    if (!accessToken) {
      return json({ success: false, error: 'Missing access token.' }, 401);
    }

    const user = await fetchUser(accessToken, env);

    if (!user?.id) {
      return json({ success: false, error: 'Unable to verify account.' }, 401);
    }

    if (!isAllowedAdmin(user, env)) {
      return json({ success: false, error: 'Your account does not have admin privileges.' }, 403);
    }

    const profile = await upsertAdminProfile(user, env);
    return json({ success: true, role: 'admin', profile });
  } catch (err) {
    return json({ success: false, error: err.message || 'Admin access failed.' }, 500);
  }
}
