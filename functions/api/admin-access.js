const DEFAULT_ADMIN_EMAILS = [
  'breezenash24@gmail.com',
  'nasirubreeze@zuwera.store'
];

const DEFAULT_ADMIN_HINTS = [
  'breezenash24',
  'breez',
  'breeze',
  'nash24',
  'nasiru'
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function collectEmails(user) {
  return [
    user?.email,
    user?.user_metadata?.email,
    ...(Array.isArray(user?.identities)
      ? user.identities.map((identity) => identity?.identity_data?.email || identity?.email)
      : [])
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase().trim());
}

function isAllowedAdmin(user, env) {
  const emails = collectEmails(user);
  const fullName = String(user?.user_metadata?.full_name || '').toLowerCase().trim();
  const exactEmails = new Set([
    ...DEFAULT_ADMIN_EMAILS,
    ...parseList(env.ADMIN_EMAILS)
  ]);
  const allowedDomains = parseList(env.ADMIN_EMAIL_DOMAINS || 'zuwera.store');
  const hints = [...DEFAULT_ADMIN_HINTS, ...parseList(env.ADMIN_EMAIL_HINTS)];

  return emails.some((email) => exactEmails.has(email))
    || emails.some((email) => allowedDomains.some((domain) => email.endsWith(`@${domain}`)))
    || hints.some((hint) => emails.some((email) => email.includes(hint)) || fullName.includes(hint));
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
