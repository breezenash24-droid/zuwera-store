import { cors, getSetting, json, sanitizeCommerceConfig } from './_commerce.js';

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestGet({ env }) {
  try {
    const config = sanitizeCommerceConfig(await getSetting(env, 'commerce_config', {}));
    return json({ success: true, config }, 200, cors(env));
  } catch (error) {
    return json({ success: false, error: error?.message || 'Could not load commerce config.' }, 500, cors(env));
  }
}
