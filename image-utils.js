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

  /* ── VIDEO GOES THROUGH CLOUDINARY TOO, AND IT MATTERS MORE THAN IMAGES ────
     Every hero IMAGE has been served through Cloudinary for a while. The hero
     VIDEO was not — it came straight off R2 at whatever size was uploaded.
     Measured on the live homepage's hero:

         raw from R2                          3,371,102 bytes
         video/fetch f_auto,q_auto,w_1400     1,271,347 bytes    62% less

     And it is the LCP element, so those bytes are the largest paint. */
  function optimizeVideo(url, width = 1400) {
    const absoluteUrl = absoluteImageUrl(url);
    if (!absoluteUrl || /^(data:|blob:)/i.test(absoluteUrl)) return absoluteUrl;
    if (absoluteUrl.includes('cloudinary.com')) return absoluteUrl;
    if (!/^https?:\/\//i.test(absoluteUrl)) return absoluteUrl;
    const safeWidth = normalizeWidth(width);
    return `https://res.cloudinary.com/${cloudinaryCloudName}/video/fetch/f_auto,q_auto,w_${safeWidth}/${encodeURI(absoluteUrl)}`;
  }

  /* The first frame of a video, as a JPEG.
     58 KB against a 3.4 MB video — so a hero video can PAINT while it is still
     downloading, instead of holding the largest contentful paint until enough
     of the video has arrived to decode.

     This also exists because of a real defect it replaces: the carousel emitted
     poster="${sl.video_poster||''}", and an EMPTY poster attribute is not the
     same as no poster attribute. The browser resolves "" against the document,
     so every homepage load fetched https://zuwera.store/ a second time and
     tried to decode the HTML as an image. A wasted request and a guaranteed
     decode failure, on every visit. */
  function videoPosterUrl(url, width = 1400) {
    const absoluteUrl = absoluteImageUrl(url);
    if (!absoluteUrl || /^(data:|blob:)/i.test(absoluteUrl)) return '';
    if (!/^https?:\/\//i.test(absoluteUrl)) return '';
    if (absoluteUrl.includes('cloudinary.com')) return '';
    const safeWidth = normalizeWidth(width);
    return `https://res.cloudinary.com/${cloudinaryCloudName}/video/fetch/so_0,f_jpg,q_auto,w_${safeWidth}/${encodeURI(absoluteUrl)}`;
  }

  /* Pull the untransformed source back out of one of our own Cloudinary URLs.
     The shape is /<type>/fetch/<transforms>/<encoded original>, so the original
     is everything after the first slash that follows the transform segment.
     Returns '' for anything that is not ours, which is what stops this touching
     a Cloudinary URL somebody stored directly. */
  function originalFromFetchUrl(src, kind) {
    const url = String(src || '');
    if (url.indexOf('res.cloudinary.com') === -1) return '';
    const marker = '/' + kind + '/fetch/';
    const i = url.indexOf(marker);
    if (i === -1) return '';
    const after = url.slice(i + marker.length);
    const s = after.indexOf('/');
    if (s === -1) return '';
    let orig = after.slice(s + 1);
    try { orig = decodeURI(orig); } catch (_) {}
    return orig;
  }

  /* ── WHEN CLOUDINARY STOPS ANSWERING ──────────────────────────────────────
     An over-quota or down Cloudinary is not hypothetical — it is a monthly
     credit limit on a free plan — and what happens then differs by media type:

       IMAGES  Cloudinary → wsrv.nl → the raw original. Three chances, and the
               worst case is a full-size photo rather than a missing one.

       VIDEO   Cloudinary → the raw original. Two, because there is no second
               optimiser: images.weserv.nl answers 404 for an .mp4 (checked, it
               is an image service). So the fallback costs bytes, not the video.

     Measured on the live hero:  Cloudinary 1,239,381 b   raw from R2 5,755,657 b

     Before this branch existed there was no fallback for video AT ALL — the
     listener returned immediately for anything that was not an <img>, which was
     correct right up until the day video started going through Cloudinary too.
     A hero that silently fails to a black rectangle is a worse failure than a
     hero that costs 4.6 MB.

     `error` on media elements does not bubble, but it does travel down the
     capture path, which is why this is a capture listener on the document. */
  function videoFallback(el) {
    if (!el) return;
    /* Once. There is nowhere further to fall, so a second attempt could only
       loop. */
    if (el.dataset.zwVfb === '1') return;
    const src = el.currentSrc || el.src || el.getAttribute('src') || '';
    const orig = originalFromFetchUrl(src, 'video');
    if (!orig) return;
    el.dataset.zwVfb = '1';
    /* The poster came from the same account and is failing for the same
       reason. Left in place it would sit over the video that is now working. */
    const poster = el.getAttribute('poster') || '';
    if (poster.indexOf('res.cloudinary.com') !== -1) el.removeAttribute('poster');
    el.src = orig;
    try { el.load(); } catch (_) {}
  }

  // Fallback chain for a broken optimized <img>: Cloudinary → wsrv.nl → the raw original.
  // Delegated capture listener (image 'error' events don't bubble). Each <img> is marked
  // so it retries at most twice and can never loop.
  function installImgFallback() {
    if (typeof document === 'undefined') return;
    document.addEventListener('error', function (e) {
      const img = e.target;
      if (!img) return;
      if (img.tagName === 'VIDEO') { videoFallback(img); return; }
      /* A <source> that fails reports on itself, not on the <video> around it,
         and a <video> with only failing sources may never report at all. */
      if (img.tagName === 'SOURCE' && img.parentElement
          && img.parentElement.tagName === 'VIDEO') {
        const v = img.parentElement;
        const orig = originalFromFetchUrl(img.getAttribute('src') || '', 'video');
        if (orig && v.dataset.zwVfb !== '1') {
          v.dataset.zwVfb = '1';
          img.src = orig;
          const poster = v.getAttribute('poster') || '';
          if (poster.indexOf('res.cloudinary.com') !== -1) v.removeAttribute('poster');
          try { v.load(); } catch (_) {}
        }
        return;
      }
      if (img.tagName !== 'IMG') return;
      const step = img.dataset.zwFb || '0';
      if (step === '2') return;                               // already exhausted
      const src = img.currentSrc || img.src || '';
      if (step === '0') {
        if (!fallbackProvider) return;                        // fallback turned off by config
        const orig = originalFromFetchUrl(src, 'image');      // only OUR Cloudinary output
        if (!orig) return;
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
    optimizeVideo,
    videoPosterUrl,
    wsrvUrl,
    get fallbackProvider() { return fallbackProvider; }
  };

  window.optimizeImage = optimizeImage;
  window.optimizeVideo = optimizeVideo;
  window.videoPosterUrl = videoPosterUrl;
  window.ZuweraImages.configReady = loadImageConfig();
})();
