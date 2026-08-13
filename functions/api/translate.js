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

/* Google wants a different shape of language tag from DeepL.
   DeepL takes uppercase ("ES", "PT-BR"); Google takes a BCP-47 tag with a
   lowercase primary subtag ("es", "pt-BR"). Passing DeepL's form straight
   through mostly works — Google is lenient about case — but "ZH" is not "zh-CN"
   and the lenient path silently returns Simplified for a request that meant
   Traditional. Explicit beats lenient where the failure is a wrong answer
   rather than an error. */
function toGoogleLang(target) {
  const t = String(target || '').trim();
  if (!t) return '';
  const [primary, region] = t.split('-');
  const lower = primary.toLowerCase();
  if (lower === 'zh') return region ? 'zh-' + region.toUpperCase() : 'zh-CN';
  return region ? lower + '-' + region.toUpperCase() : lower;
}

/* Google returns HTML-escaped text even when asked for format:'text' — an
   apostrophe comes back as &#39;. Left alone it renders literally in a review,
   which is a subtler kind of broken than a failed request: it looks like the
   translation worked and the customer wrote it strangely. */
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');   // last, or it un-escapes the others' ampersands
}

async function translateWithGoogle(texts, target, key) {
  const lang = toGoogleLang(target);
  const resp = await fetch('https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: texts, target: lang, format: 'text' }),
  });
  const raw = await resp.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }

  const rows = data && data.data && data.data.translations;
  if (!resp.ok || !Array.isArray(rows)) {
    throw new Error((data && data.error && data.error.message) || raw || `Google Translate failed (${resp.status})`);
  }
  /* One translation per input, in order. Google preserves order, but a short
     reply would otherwise line reviews up against the wrong text — so pad
     rather than silently mis-pair. */
  return texts.map((t, i) => (rows[i] ? decodeEntities(rows[i].translatedText) : t));
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

    /* ── Which translator ────────────────────────────────────────────────
       DeepL was the only option, and DeepL is paid past a small free tier.
       A store that decides translation is not worth paying for had exactly two
       choices: keep paying, or lose the feature.

       Google Cloud Translation is the alternative worth having — different
       pricing shape, different free allowance, wider language coverage, and
       lower quality on the long-form prose DeepL is good at. Neither is
       strictly better, which is the reason to make it a choice rather than a
       migration.

       TRANSLATE_PROVIDER picks explicitly. Left unset it resolves to whichever
       key exists, DeepL first — so nothing changes for a store that has one,
       and a store that removes its DeepL key falls to Google automatically
       rather than breaking. */
    const deeplKey = String(
      context.env.DEEPL_API_KEY || context.env.DEEPL_AUTH_KEY || context.env.DEEPL_KEY || ''
    ).trim();
    const googleKey = String(
      context.env.GOOGLE_TRANSLATE_API_KEY || context.env.GOOGLE_TRANSLATE_KEY || ''
    ).trim();

    const requested = String(context.env.TRANSLATE_PROVIDER || '').trim().toLowerCase();
    let provider = '';
    if (requested === 'google') provider = googleKey ? 'google' : '';
    else if (requested === 'deepl') provider = deeplKey ? 'deepl' : '';
    else provider = deeplKey ? 'deepl' : (googleKey ? 'google' : '');

    if (!provider) {
      /* Names both routes. A message that only mentions DeepL is how somebody
         concludes translation costs money and there is no way round it. */
      const asked = requested ? ' (TRANSLATE_PROVIDER is set to "' + requested + '", but its key is missing)' : '';
      return new Response(
        JSON.stringify({ error: 'No translation key configured' + asked + '. Add DEEPL_API_KEY for DeepL, '
          + 'or GOOGLE_TRANSLATE_API_KEY to use Google Cloud Translation instead.' }),
        { status: 500, headers: corsHeaders }
      );
    }

    if (provider === 'google') {
      const translations = await translateWithGoogle(normalizedTexts, target, googleKey);
      return new Response(JSON.stringify({ translations, provider: 'google' }), { status: 200, headers: corsHeaders });
    }

    const API_KEY = deeplKey;

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

    return new Response(JSON.stringify({ translations, provider: 'deepl' }), { status: 200, headers: corsHeaders });
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
