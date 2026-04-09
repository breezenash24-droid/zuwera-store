/**
 * Cloudflare Pages Function: /api/translate
 * Translates product reviews using the DeepL API.
 * Set DEEPL_API_KEY as an environment variable in your Cloudflare Pages project settings.
 */

export async function onRequestPost(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  try {
    const { texts, target } = await context.request.json();

    if (!texts || !Array.isArray(texts) || !target) {
      return new Response(
        JSON.stringify({ error: 'Missing texts array or target language code.' }),
        { status: 400, headers: corsHeaders }
      );
    }

    const API_KEY = context.env.DEEPL_API_KEY || context.env.DEEPL_AUTH_KEY || context.env.DEEPL_KEY;
    if (!API_KEY) {
      return new Response(
        JSON.stringify({ error: 'DeepL key not found. Add DEEPL_API_KEY, DEEPL_AUTH_KEY, or DEEPL_KEY in Cloudflare Pages environment variables.' }),
        { status: 500, headers: corsHeaders }
      );
    }
    const requestBody = new URLSearchParams();
    requestBody.append('auth_key', API_KEY);
    requestBody.append('target_lang', String(target).toUpperCase());
    texts.forEach((text) => requestBody.append('text', String(text)));

    const primaryEndpoint = API_KEY.endsWith(':fx')
      ? 'https://api-free.deepl.com/v2/translate'
      : 'https://api.deepl.com/v2/translate';
    const fallbackEndpoint = primaryEndpoint.includes('api-free')
      ? 'https://api.deepl.com/v2/translate'
      : 'https://api-free.deepl.com/v2/translate';

    let translations = null;
    let lastError = 'Translation failed';

    for (const endpoint of [primaryEndpoint, fallbackEndpoint]) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: requestBody.toString(),
      });

      const raw = await response.text();
      let data = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = {};
      }

      if (response.ok && Array.isArray(data.translations)) {
        translations = data.translations.map((item) => item.text);
        break;
      }

      lastError = data.message || data.detail || data.error?.message || data.error || raw || `Translation request failed (${response.status})`;

      // DeepL sometimes returns auth-like failures when the wrong free/pro endpoint
      // is used, so give the alternate endpoint one shot before surfacing the error.
      if (![401, 403, 404, 456].includes(response.status)) {
        break;
      }
    }

    if (!translations) {
      throw new Error(lastError);
    }

    return new Response(JSON.stringify({ translations }), { status: 200, headers: corsHeaders });
  } catch (e) {
    console.error('Translation error:', e);
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
