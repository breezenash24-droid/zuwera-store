/**
 * Netlify Function: translate
 *
 * Securely translates product reviews using the DeepL API.
 */

const { ok, err, preflight } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST')    return err(405, 'Method not allowed');

  try {
    const { texts, target } = JSON.parse(event.body);
    
    if (!texts || !Array.isArray(texts) || !target) 
      return err(400, 'Missing texts array or target language code.');

    // Your DeepL API Key
    const API_KEY = '21a6e204-5ef0-4493-9a58-c5cb2365fb74:fx';

    // DeepL Free API keys end with ':fx'
    const isFree = API_KEY.endsWith(':fx');
    const endpoint = isFree ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate';

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `DeepL-Auth-Key ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: texts, target_lang: target.toUpperCase() })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Translation failed');

    const translations = data.translations.map(t => t.text);
    return ok({ translations });
  } catch (e) {
    console.error('Translation error:', e);
    return err(500, e.message);
  }
};