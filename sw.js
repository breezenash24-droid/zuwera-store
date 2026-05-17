// Kill-switch service worker
// Purpose: forcibly unregister any previously installed service worker and
// purge every cache it created, so users stop being served stale assets.
// Once Cloudflare Pages has stopped serving an older sw.js to all visitors,
// this file can be deleted (along with the registration in index.html).

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
          try {
                  const keys = await caches.keys();
                  await Promise.all(keys.map((k) => caches.delete(k)));
          } catch (_) {}
          try {
                  await self.registration.unregister();
          } catch (_) {}
          try {
                  const clients = await self.clients.matchAll({ type: 'window' });
                  for (const client of clients) {
                            try { client.navigate(client.url); } catch (_) {}
                  }
          } catch (_) {}
    })());
    self.clients.claim();
});

// No fetch handler — all requests go straight to the network.
