const CACHE_NAME = 'zuwera-v3';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/drop001.html',
  '/sizeguide.html',
  '/base.css',
  '/nav.css',
  '/layout.css',
  '/cart.css',
  '/images/logo.png',
  '/images/wordmark.png'
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

  // Static assets: cache-first strategy
  if (/\.(css|js|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot)$/i.test(url.pathname)) {
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

  // HTML: network-first strategy
  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request).then((fetchResponse) => {
        return caches.open(CACHE_NAME).then((cache) => {
          cache.put(request, fetchResponse.clone());
          return fetchResponse;
        });
      }).catch(() => {
        return caches.match(request).then((response) => {
          return response || new Response('Offline', { status: 503 });
        });
      })
    );
    return;
  }

  // Default: network-first
  event.respondWith(
    fetch(request).catch(() => {
      return caches.match(request);
    })
  );
});
