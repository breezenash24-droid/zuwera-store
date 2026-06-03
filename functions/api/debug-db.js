const SUPABASE_URL = 'https://qfgnrsifcwdubkolsgsq.supabase.co';

export async function onRequestGet({ env }) {
  try {
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE;
    if (!serviceKey) {
      return new Response(JSON.stringify({ error: 'No service key found in env' }), { status: 500 });
    }

    const value = {
      sections: [
        { id: 'hero', type: 'hero', label: 'Hero', visible: true, order: 0, settings: {} }
      ],
      updated_at: new Date().toISOString(),
      published: true,
    };

    const rows = [
      { key: 'page_builder', value },
      { key: 'page_builder_published', value }
    ];

    const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/site_settings?on_conflict=key`, {
      method: 'POST',
      headers: {
        apikey:           serviceKey,
        Authorization:    'Bearer ' + serviceKey,
        'Content-Type':   'application/json',
        Prefer:           'resolution=merge-duplicates,return=representation', // return representation to see what was written
      },
      body: JSON.stringify(rows),
    });

    const status = saveRes.status;
    const bodyText = await saveRes.text();

    return new Response(JSON.stringify({
      status,
      body: bodyText
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch(e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), { status: 500 });
  }
}
