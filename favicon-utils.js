(function () {
  const FALLBACK_FAVICON = '/images/favicon-32.png?v=3';

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
      normalizedPath === 'images/logo.png?v=2' ||
      normalizedPath === 'logo.png' ||
      normalizedPath === 'favicon.ico'
    ) {
      return FALLBACK_FAVICON;
    }

    return raw;
  }

  function applyFavicon(url) {
    const links = document.querySelectorAll('link[rel="icon"]');
    const href = normalizeFaviconUrl(url);
    if (!links.length) {
      const link = document.createElement('link');
      link.rel = 'icon';
      link.type = 'image/png';
      link.href = href;
      document.head.appendChild(link);
      return href;
    }
    links.forEach((link) => {
      link.type = 'image/png';
      link.href = href;
    });
    return href;
  }

  window.__zwFaviconUrl = normalizeFaviconUrl;
  window.__zwApplyFavicon = applyFavicon;

  applyFavicon(document.querySelector('link[rel="icon"]')?.getAttribute('href'));
})();
