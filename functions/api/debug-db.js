const SUPABASE_URL = 'https://qfgnrsifcwdubkolsgsq.supabase.co';

export async function onRequestGet({ env }) {
  try {
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE;
    if (!serviceKey) {
      return new Response(JSON.stringify({ error: 'No service key found in env' }), { status: 500 });
    }

    // Perform SELECT using service role key (bypasses RLS)
    const selectRes = await fetch(`${SUPABASE_URL}/rest/v1/site_settings?select=*`, {
      method: 'GET',
      headers: {
        apikey:           serviceKey,
        Authorization:    'Bearer ' + serviceKey,
      }
    });

    const status = selectRes.status;
    const data = await selectRes.json();

    return new Response(JSON.stringify({
      status,
      rows: data
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch(e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), { status: 500 });
  }
}
