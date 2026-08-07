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
  const cache = await fetchSiteSettings(['CLOUDINARY_CLOUD_NAME', 'IMAGE_FALLBACK'], env);
  const cloudName = cleanCloudinaryCloudName(
    resolveSetting('CLOUDINARY_CLOUD_NAME', env, cache)
  );

  // Secondary optimizer, used only when a Cloudinary image fails to load. Defaults to
  // 'wsrv' (images.weserv.nl — free, Cloudflare-backed, no account). Set
  // site_settings.IMAGE_FALLBACK to 'off' (or 'none'/'false') to disable it site-wide.
  const fbRaw = String(resolveSetting('IMAGE_FALLBACK', env, cache) || 'wsrv').trim().toLowerCase();
  const fallback = (fbRaw === 'off' || fbRaw === 'none' || fbRaw === 'false') ? null : 'wsrv';

  return json({
    ok: true,
    cloudinary: {
      enabled: Boolean(cloudName),
      cloudName,
    },
    fallback,
  });
}
