/**
 * Cloudflare Pages Function: /api/translate
 * Translates product reviews using the DeepL API.
 * Set DEEPL_API_KEY as an environment variable in your Cloudflare Pages project settings.
 */

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildCorsHeaders(request, env = {}) {
  const origin = request?.headers?.get('Origin') || '';
  const allowedOrigins = new Set([
    env.SITE_URL || 'https://zuwera.store',
    'https://zuwera.store',
    'https://www.zuwera.store',
    ...parseCsv(env.TRANSLATE_ALLOWED_ORIGINS),
  ]);
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  const allowOrigin = origin && (allowedOrigins.has(origin) || isLocal)
    ? origin
    : (env.SITE_URL || 'https://zuwera.store');

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, X-Translate-Token',
    'Content-Type': 'application/json',
  };
}

export async function onRequestPost(context) {
  const corsHeaders = buildCorsHeaders(context.request, context.env);

  function normalizeTranslateEndpoint(value) {
    if (!value) return null;
    const trimmed = String(value).trim().replace(/\/+$/, '');
    if (!trimmed) return null;
    return trimmed.endsWith('/v2/translate') ? trimmed : `${trimmed}/v2/translate`;
  }

  try {
    if (context.env.TRANSLATE_API_TOKEN) {
      const token = context.request.headers.get('X-Translate-Token') || '';
      if (token !== context.env.TRANSLATE_API_TOKEN) {
        return new Response(JSON.stringify({ error: 'Unauthorized.' }), { status: 401, headers: corsHeaders });
      }
    }

    const { texts, target } = await context.request.json();

    if (!texts || !Array.isArray(texts) || !target) {
      return new Response(
        JSON.stringify({ error: 'Missing texts array or target language code.' }),
        { status: 400, headers: corsHeaders }
      );
    }

    const maxTexts = Math.max(1, Number.parseInt(context.env.TRANSLATE_MAX_TEXTS || '20', 10) || 20);
    const maxChars = Math.max(100, Number.parseInt(context.env.TRANSLATE_MAX_CHARS || '5000', 10) || 5000);
    const normalizedTexts = texts.map((text) => String(text || ''));
    const totalChars = normalizedTexts.reduce((sum, text) => sum + text.length, 0);

    if (normalizedTexts.length > maxTexts || totalChars > maxChars) {
      return new Response(
        JSON.stringify({ error: 'Translation request is too large.' }),
        { status: 413, headers: corsHeaders }
      );
    }

    if (!/^[A-Z]{2}(-[A-Z]{2})?$/.test(String(target).toUpperCase())) {
      return new Response(
        JSON.stringify({ error: 'Invalid target language code.' }),
        { status: 400, headers: corsHeaders }
      );
    }

    const API_KEY = String(
      context.env.DEEPL_API_KEY || context.env.DEEPL_AUTH_KEY || context.env.DEEPL_KEY || ''
    ).trim();
    if (!API_KEY) {
      return new Response(
        JSON.stringify({ error: 'DeepL key not found. Add DEEPL_API_KEY, DEEPL_AUTH_KEY, or DEEPL_KEY in Cloudflare Pages environment variables.' }),
        { status: 500, headers: corsHeaders }
      );
    }

    const requestBody = JSON.stringify({
      text: normalizedTexts,
      target_lang: String(target).toUpperCase(),
    });

    const configuredEndpoint = normalizeTranslateEndpoint(
      context.env.DEEPL_API_ENDPOINT || context.env.DEEPL_API_URL || context.env.DEEPL_API_BASE_URL
    );
    const guessedPrimaryEndpoint = API_KEY.endsWith(':fx')
      ? 'https://api-free.deepl.com/v2/translate'
      : 'https://api.deepl.com/v2/translate';
    const guessedFallbackEndpoint = guessedPrimaryEndpoint.includes('api-free')
      ? 'https://api.deepl.com/v2/translate'
      : 'https://api-free.deepl.com/v2/translate';
    const endpoints = [...new Set([configuredEndpoint, guessedPrimaryEndpoint, guessedFallbackEndpoint].filter(Boolean))];

    let translations = null;
    let lastError = 'Translation failed';

    for (const endpoint of endpoints) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `DeepL-Auth-Key ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: requestBody,
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

      if (typeof lastError === 'string' && /wrong endpoint/i.test(lastError) && endpoint !== endpoints[endpoints.length - 1]) {
        continue;
      }

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

export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: {
      ...buildCorsHeaders(context.request, context.env),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Translate-Token',
    },
  });
}
