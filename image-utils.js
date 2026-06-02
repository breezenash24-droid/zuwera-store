(function () {
  const DEFAULT_CLOUDINARY_CLOUD_NAME = 'dubg4loah';
  const MAX_DESKTOP_WIDTH = 1400;
  const MAX_TABLET_WIDTH = 1000;
  const MAX_MOBILE_WIDTH = 760;
  const CLOUDINARY_NAME_RE = /^[a-z0-9_-]{2,64}$/i;
  let cloudinaryCloudName = DEFAULT_CLOUDINARY_CLOUD_NAME;

  function setCloudinaryCloudName(value) {
    const next = String(value || '').trim();
    if (!CLOUDINARY_NAME_RE.test(next)) return false;
    cloudinaryCloudName = next;
    if (window.ZuweraImages) window.ZuweraImages.cloudName = cloudinaryCloudName;
    return true;
  }

  function normalizeWidth(width) {
    const requested = Number(width) || 800;
    const viewport = typeof window !== 'undefined' ? Number(window.innerWidth) || 0 : 0;
    let cap = MAX_DESKTOP_WIDTH;

    if (viewport && viewport <= 520) cap = MAX_MOBILE_WIDTH;
    else if (viewport && viewport <= 900) cap = MAX_TABLET_WIDTH;

    return Math.max(120, Math.min(Math.round(requested), cap));
  }

  function absoluteImageUrl(url) {
    const value = String(url || '').trim();
    if (!value) return '';
    if (/^(data:|blob:|mailto:|tel:)/i.test(value)) return value;
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('//')) return `${window.location.protocol}${value}`;
    if (value.startsWith('/') && window.location.protocol !== 'file:') {
      return `${window.location.origin}${value}`;
    }
    return value;
  }

  function optimizeImage(url, width = 800) {
    const absoluteUrl = absoluteImageUrl(url);
    if (!absoluteUrl || /^(data:|blob:)/i.test(absoluteUrl)) return absoluteUrl;
    if (absoluteUrl.includes('cloudinary.com')) return absoluteUrl;
    if (!/^https?:\/\//i.test(absoluteUrl)) return absoluteUrl;

    const safeWidth = normalizeWidth(width);
    return `https://res.cloudinary.com/${cloudinaryCloudName}/image/fetch/f_auto,q_auto,w_${safeWidth}/${encodeURI(absoluteUrl)}`;
  }

  async function loadImageConfig() {
    if (typeof fetch !== 'function') return null;
    try {
      const resp = await fetch('/api/image-config', {
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const cloudName = data?.cloudinary?.cloudName || data?.cloudName;
      if (setCloudinaryCloudName(cloudName)) return data;
    } catch (_) {}
    return null;
  }

  window.ZuweraImages = {
    cloudName: cloudinaryCloudName,
    defaultCloudName: DEFAULT_CLOUDINARY_CLOUD_NAME,
    loadConfig: loadImageConfig,
    normalizeWidth,
    absoluteImageUrl,
    setCloudinaryCloudName,
    optimizeImage
  };

  window.optimizeImage = optimizeImage;
  window.ZuweraImages.configReady = loadImageConfig();
})();
