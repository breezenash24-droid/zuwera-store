(function () {
  const FALLBACK_FAVICON = '/images/favicon-black.png?v=1';

  function normalizeFaviconUrl(url) {
    if (!url) return FALLBACK_FAVICON;

    const raw = String(url).trim();
    if (!raw) return FALLBACK_FAVICON;

    let path = raw.split('?')[0];
    try {
      path = new URL(raw, window.location.href).pathname;
    } catch (error) {
      path = path.replace(window.location.origin, '');
    }

    const normalizedPath = path.replace(/^\/+/, '').toLowerCase();
    if (
      normalizedPath === 'images/logo.png' ||
      normalizedPath === 'logo.png' ||
      normalizedPath === 'favicon.ico'
    ) {
      return FALLBACK_FAVICON;
    }

    return raw;
  }

  function applyFavicon(url) {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }

    link.type = 'image/png';
    link.href = normalizeFaviconUrl(url);
    return link.href;
  }

  window.__zwFaviconUrl = normalizeFaviconUrl;
  window.__zwApplyFavicon = applyFavicon;

  applyFavicon(document.querySelector('link[rel="icon"]')?.getAttribute('href'));
})();
