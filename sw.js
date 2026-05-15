const CACHE_NAME = 'zuwera-v28';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/drop001.html',
  '/product.html',
  '/account.html',
  '/returns.html',
  '/policies.html',
  '/sizeguide.html',
  '/bag.html',
  '/confirm.html',
  '/base.css',
  '/nav.css',
  '/layout.css',
  '/cart.css',
  '/payment.css',
  '/product.css',
  '/storefront-cohesion.css',
  '/storefront-theme.js',
  '/image-utils.js',
  '/mobile-menu.js',
  '/stripe-client-config.js',
  '/checkout-tax.js',
  '/favicon-utils.js',
  '/images/logo-192.png',
  '/images/logo.png',
  '/images/wordmark-nav.png',
  '/images/wordmark-footer.png',
  '/images/hero-mobile.jpg',
  '/images/favicon-32.png',
  '/images/favicon-black.png',
  '/images/favicon-black-192.png',
  '/images/apple-touch-icon.png'
];

// Install event: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.log('Cache addAll error (non-critical):', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate event: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event: cache-first for static assets, network-first for HTML
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Scripts and styles: network-first so storefront fixes are not trapped behind an old service-worker cache.
  // A 6-second timeout prevents a hanging network request from freezing the page renderer.
  if (/\.(css|js)$/i.test(url.pathname)) {
    event.respondWith(
      (function () {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('SW fetch timeout')), 6000)
        );
        return Promise.race([fetch(request), timeoutPromise])
          .then((fetchResponse) => {
            return caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, fetchResponse.clone());
              return fetchResponse;
            });
          })
          .catch(() => {
            return caches.match(request).then((response) => {
              return response || new Response('Offline', { status: 503 });
            });
          });
      })()
    );
    return;
  }

  // Images and fonts: cache-first strategy
  if (/\.(png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot)$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((response) => {
        return response || fetch(request).then((fetchResponse) => {
          return caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, fetchResponse.clone());
            return fetchResponse;
          });
        });
      }).catch(() => {
        return new Response('Offline', { status: 503 });
      })
    );
    return;
  }

  // HTML: network-first with timeout so a hanging fetch never freezes the browser tab
  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      (function () {
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('SW HTML timeout')), 8000)
        );
        return Promise.race([fetch(request), timeout])
          .then((fetchResponse) => {
            return caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, fetchResponse.clone());
              return fetchResponse;
            });
          })
          .catch(() => {
            return caches.match(request).then((response) => {
              return response || new Response('Offline', { status: 503 });
            });
          });
      })()
    );
    return;
  }

  // Default: network-first with timeout
  event.respondWith(
    (function () {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('SW default timeout')), 8000)
      );
      return Promise.race([fetch(request), timeout])
        .catch(() => caches.match(request));
    })()
  );
});
