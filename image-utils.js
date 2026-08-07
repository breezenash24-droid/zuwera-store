(function () {
  const DEFAULT_CLOUDINARY_CLOUD_NAME = 'dubg4loah';
  const MAX_DESKTOP_WIDTH = 1400;
  const MAX_TABLET_WIDTH = 1000;
  const MAX_MOBILE_WIDTH = 760;
  const CLOUDINARY_NAME_RE = /^[a-z0-9_-]{2,64}$/i;
  let cloudinaryCloudName = DEFAULT_CLOUDINARY_CLOUD_NAME;
  // Secondary optimizer, used ONLY as a fallback when a Cloudinary image fails to load
  // (Cloudinary over quota / down / a transform error). 'wsrv' = images.weserv.nl, a
  // free, Cloudflare-backed image CDN that needs no account. Server can turn it off via
  // /api/image-config (site_settings.IMAGE_FALLBACK='off'). Default on — it's a safety
  // net that only ever activates on a broken image, so it can't hurt.
  let fallbackProvider = 'wsrv';

  // Build a wsrv.nl optimized URL for an already-absolute image URL.
  function wsrvUrl(absoluteUrl, width) {
    const w = normalizeWidth(width);
    // wsrv wants the source without the scheme; 'ssl:' marks an https origin.
    const src = String(absoluteUrl || '').replace(/^https:\/\//i, 'ssl:').replace(/^http:\/\//i, '');
    return `https://images.weserv.nl/?url=${encodeURIComponent(src)}&w=${w}&output=webp&q=80`;
  }

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
    return `https://res.cloudinary.com/${cloudinaryCloudName}/image/fetch/f_auto,q_auto:eco,w_${safeWidth}/${encodeURI(absoluteUrl)}`;
  }

  // Fallback chain for a broken optimized <img>: Cloudinary → wsrv.nl → the raw original.
  // Delegated capture listener (image 'error' events don't bubble). Each <img> is marked
  // so it retries at most twice and can never loop.
  function installImgFallback() {
    if (typeof document === 'undefined') return;
    document.addEventListener('error', function (e) {
      const img = e.target;
      if (!img || img.tagName !== 'IMG') return;
      const step = img.dataset.zwFb || '0';
      if (step === '2') return;                               // already exhausted
      const src = img.currentSrc || img.src || '';
      if (step === '0') {
        if (!fallbackProvider) return;                        // fallback turned off by config
        if (src.indexOf('res.cloudinary.com') === -1) return; // only OUR Cloudinary output
        const i = src.indexOf('/image/fetch/');
        if (i === -1) return;
        const after = src.slice(i + 13);                      // strip '/image/fetch/'
        const s = after.indexOf('/');                         // then the transforms segment
        if (s === -1) return;
        let orig = after.slice(s + 1);
        try { orig = decodeURI(orig); } catch (_) {}
        img.dataset.zwOrig = orig;
        img.dataset.zwFb = '1';
        img.src = wsrvUrl(absoluteImageUrl(orig), img.getAttribute('width') || 800);
      } else if (step === '1') {
        img.dataset.zwFb = '2';                               // last resort: unoptimized original
        if (img.dataset.zwOrig) img.src = img.dataset.zwOrig;
      }
    }, true);
  }
  installImgFallback();

  async function loadImageConfig() {
    if (typeof fetch !== 'function') return null;
    try {
      const resp = await fetch('/api/image-config', {
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (data && 'fallback' in data) fallbackProvider = data.fallback || null;
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
    optimizeImage,
    wsrvUrl,
    get fallbackProvider() { return fallbackProvider; }
  };

  window.optimizeImage = optimizeImage;
  window.ZuweraImages.configReady = loadImageConfig();
})();
