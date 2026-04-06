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

    const API_KEY = context.env.DEEPL_API_KEY;
    if (!API_KEY) {
      return new Response(
        JSON.stringify({ error: 'DEEPL_API_KEY environment variable is not set. Please add it in your Cloudflare Pages project settings.' }),
        { status: 500, headers: corsHeaders }
      );
    }
    const isFree = API_KEY.endsWith(':fx');
    const endpoint = isFree
      ? 'https://api-free.deepl.com/v2/translate'
      : 'https://api.deepl.com/v2/translate';

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: texts, target_lang: target.toUpperCase() }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Translation failed');

    const translations = data.translations.map(t => t.text);
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
