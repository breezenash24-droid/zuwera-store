import { fetchSiteSettings, resolveSetting } from './_settings.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function cleanCloudinaryCloudName(value) {
  const cloudName = String(value || '').trim();
  return /^[a-z0-9_-]{2,64}$/i.test(cloudName) ? cloudName : '';
}

export async function onRequestGet({ env }) {
  const cache = await fetchSiteSettings(['CLOUDINARY_CLOUD_NAME'], env);
  const cloudName = cleanCloudinaryCloudName(
    resolveSetting('CLOUDINARY_CLOUD_NAME', env, cache)
  );

  return json({
    ok: true,
    cloudinary: {
      enabled: Boolean(cloudName),
      cloudName,
    },
  });
}
