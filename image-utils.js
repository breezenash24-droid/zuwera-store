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

  /* ── WHAT COLOUR IS THE EDGE OF THIS PHOTO? ────────────────────────────────
   *
   * A photo shown with object-fit:contain leaves the pane's own background
   * showing beside it. Paint that background the photo's own edge colour and the
   * join disappears — but only if the colour is RIGHT, and on this catalogue a
   * single averaged colour is not. Sampled eight points down each edge of
   * eighteen product photos:
   *
   *     Zuwera Aero Pro      #edeee9 -> #edeee9    flat
   *     Senegal Home Jersey  #454952 -> #99a0a8    86 apart
   *     Zuwera Fleece        #ffffff -> #3c382e    199 apart
   *     Zuwera Tech          left and right edges 53 apart
   *
   * Seven of eighteen backdrops are lit gradients and six have different left
   * and right edges. One flat colour would match at one end of the photo and be
   * plainly wrong at the other, which is worse than an honest dark band.
   *
   * So this returns the edges as STRIPS, and the caller reproduces them as
   * gradients. Sixteen samples down each side is finer than the eye can pick out
   * across a 40-pixel margin.
   *
   * ── ONE REQUEST, ALL FOUR EDGES ────────────────────────────────────────────
   *
   * Cloudinary scales the whole photo to 16x16 — around 400 bytes — and the four
   * edges are that grid's outer rows and columns. Each cell is the average of
   * the sixteenth of the photo it covers, which is exactly the strip that sits
   * against the margin. Four separate edge crops would be four round trips for a
   * worse answer.
   *
   * Read through a canvas, which needs the pixels to be same-origin or CORS-
   * clean. They are: res.cloudinary.com answers `Access-Control-Allow-Origin: *`,
   * verified against the live account. The ORIGINAL host is never touched by
   * this — a product photo can be on any domain a merchant pasted and most of
   * them send no CORS headers at all, so sampling the original directly would
   * taint the canvas and throw. */
  const EDGE_CACHE = new Map();
  function zwEdgeStrips(url) {
    const absoluteUrl = absoluteImageUrl(url);
    if (!absoluteUrl || !/^https?:\/\//i.test(absoluteUrl)) return Promise.resolve(null);
    if (EDGE_CACHE.has(absoluteUrl)) return EDGE_CACHE.get(absoluteUrl);

    const N = 16;
    const job = new Promise((resolve) => {
      if (typeof document === 'undefined' || typeof Image !== 'function') return resolve(null);
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      /* A photo that never answers must not leave a promise pending forever —
         it is cached by URL, so every later slide would await the same one. */
      const timer = setTimeout(() => finish(null), 8000);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = function () {
        clearTimeout(timer);
        try {
          const c = document.createElement('canvas');
          c.width = N; c.height = N;
          const ctx = c.getContext('2d', { willReadFrequently: false });
          ctx.drawImage(img, 0, 0, N, N);
          const d = ctx.getImageData(0, 0, N, N).data;
          const at = (x, y) => {
            const i = (y * N + x) * 4;
            return [d[i], d[i + 1], d[i + 2]];
          };
          const col = (x) => { const o = []; for (let y = 0; y < N; y++) o.push(at(x, y)); return o; };
          const row = (y) => { const o = []; for (let x = 0; x < N; x++) o.push(at(x, y)); return o; };
          const edges = { left: col(0), right: col(N - 1), top: row(0), bottom: row(N - 1) };

          /* ── IS THIS PHOTO SAFE TO CONTINUE PAST ITS OWN EDGE? ───────────
           *
           * Extending an edge assumes there is a BACKDROP at that edge. On a
           * studio shot there is, and the join is invisible. On a close-up crop
           * the garment runs off the frame, and continuing it smears the fabric
           * sideways into a band that reads as a rendering fault.
           *
           * A backdrop touches all four corners, so on a studio shot the corners
           * agree; on a crop they cannot, because at least one is subject.
           * Measured over the catalogue, that separates cleanly with nothing
           * near the line:
           *
           *     Zuwera Aero Pro, Classic, Raw      corner spread   0
           *     Zuwera Tech                                        7
           *     Zuwera Vogue                                   21-33
           *     ---------------------------------------------------- 40
           *     Zuwera Fleece   (collar close-up)                 200
           *     Zuwera Flower Tee (fabric detail)                 214
           *
           * The second test is the shop's own observation: continuing a light
           * backdrop looks like the photo carries on, continuing a dark or
           * coloured one puts a slab against the popup. Both have to hold. */
          const CORNER_TOLERANCE = 40;
          const LIGHT = 200;
          const JUMP = 48;
          const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
          const apart = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
          const corners = [at(0, 0), at(N - 1, 0), at(0, N - 1), at(N - 1, N - 1)];
          let spread = 0;
          for (let a = 0; a < corners.length; a++) {
            for (let b = a + 1; b < corners.length; b++) spread = Math.max(spread, apart(corners[a], corners[b]));
          }

          /* ── PER EDGE, BECAUSE THAT IS THE QUESTION BEING ASKED ───────────
           *
           * The corner test asks "does this photo have a backdrop at all". It
           * cannot ask "is THIS edge clean" — and that is the question the
           * caller actually has, because it knows which two edges the margin
           * sits against and only those two are ever seen.
           *
           * Judging the whole photo throws that away, and on this catalogue it
           * throws away the answer. Measured per edge:
           *
           *                        left      right       top      bottom
           *   Fleece #1            0/255     0/255    119/227    176/174
           *   Aero Tennesee #1     4/234     3/237    113/216    119/106
           *   Fleece #3 (close-up) 160/158  113/157   188/193     43/74
           *
           * The vertical edges are pure backdrop, because the model is centred.
           * The horizontal ones almost never are: a head runs off the top and
           * legs and a shadow off the bottom. A photo can have four agreeing
           * corners and still have an arm crossing an edge in the middle, and
           * continuing THAT is what puts the garment's colour in the margin.
           *
           *   jump  the worst step between neighbouring samples. A lit gradient
           *         moves a few units per step — Senegal's backdrop runs 86 from
           *         end to end and never steps more than about six. A garment
           *         crossing the edge does it in one step. Clean edges here
           *         measure 0 to 29; dirty ones 64 and up.
           *   mean  average luminance. Continuing a dark backdrop puts a slab of
           *         colour against the popup, which is the other half of what
           *         was reported.
           */
          const usable = (strip) => {
            let worst = 0, total = 0;
            for (let i = 0; i < strip.length; i++) {
              total += lum(strip[i]);
              if (i) worst = Math.max(worst, apart(strip[i], strip[i - 1]));
            }
            return worst <= JUMP && (total / strip.length) >= LIGHT;
          };
          const ok = {
            left: usable(edges.left), right: usable(edges.right),
            top: usable(edges.top), bottom: usable(edges.bottom),
          };

          finish(Object.assign(edges, {
            corners,
            /* Reported alongside the verdict, not instead of it: a store that
               overrides this in the builder still wants the numbers legible. */
            cornerSpread: spread,
            ok,
            /* Kept so a cached copy of pdp-gallery.js from before the per-edge
               test still gets a sensible answer rather than `undefined`, which
               it would read as "safe". */
            safe: ok.left && ok.right,
          }));
        } catch (_) {
          finish(null);                       // tainted canvas, or no 2d context
        }
      };
      img.onerror = function () { clearTimeout(timer); finish(null); };
      /* Its own Cloudinary URL is already the sample; asking Cloudinary to fetch
         a Cloudinary URL is a round trip for nothing. */
      img.src = absoluteUrl.indexOf('res.cloudinary.com') !== -1
        ? absoluteUrl
        : `https://res.cloudinary.com/${cloudinaryCloudName}/image/fetch/c_scale,w_${N},h_${N},f_png/${encodeURI(absoluteUrl)}`;
    });

    EDGE_CACHE.set(absoluteUrl, job);
    return job;
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

  /* ── THE ONE PLACE THE FALLBACK CHAIN COULD NOT REACH ─────────────────────
     Colour swatches on a product card were painted with CSS:

         style="background-image:url('<cloudinary url>')"

     A CSS background that 404s fires NO event. Not on the element, not on the
     document, not anywhere — there is nothing to listen for, so the delegated
     handler below could never see it. Every other image on the site has three
     chances; the swatches had none. Over-quota Cloudinary meant every colour on
     every card went blank, and the card kept its layout, so nothing looked
     broken enough to notice.

     Returning a real <img> puts them on the same chain as everything else.
     ONE definition, in image-utils.js rather than in each renderer, because
     there are two independent grid implementations (storefront.js for the
     homepage, drop001.html for the collection) and a rule written twice is a
     rule that ends up written differently. Both call sites fall back to the old
     background-image if this has not loaded, so the worst case is today's
     behaviour rather than an empty swatch. */
  function zwSwatchImg(src, width) {
    const url = String(src || '');
    if (!url) return '';
    const safe = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    /* alt="" on purpose — every one of these sits inside a button that already
       carries aria-label with the colour name, and a described image inside a
       labelled control is announced twice.

       `width` is the size the source was optimised AT, not the size it is drawn
       at. Step 0 of the chain reads getAttribute('width') to size the wsrv
       retry, so passing the same number the optimiser was given keeps the
       fallback the same dimensions as the original request. CSS gives the
       element its real size, so this never affects layout. */
    const w = Number(width) > 0 ? Math.round(Number(width)) : 600;
    return '<img class="zw-swatch-thumb" src="' + safe + '" alt="" '
         + 'width="' + w + '" height="' + w + '" '
         + 'loading="lazy" decoding="async" draggable="false">';
  }
  if (typeof window !== 'undefined') window.zwSwatchImg = zwSwatchImg;

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
    zwEdgeStrips,
    wsrvUrl,
    get fallbackProvider() { return fallbackProvider; }
  };

  window.optimizeImage = optimizeImage;
  window.optimizeVideo = optimizeVideo;
  window.videoPosterUrl = videoPosterUrl;
  window.zwEdgeStrips = zwEdgeStrips;
  window.ZuweraImages.configReady = loadImageConfig();
})();
