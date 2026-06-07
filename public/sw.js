// Weather TV Service Worker
// Minimal SW — just enough to satisfy PWA requirements
// Weather TV is a live content platform so we don't cache aggressively

const CACHE_NAME = 'weathertv-v1';
const STATIC_ASSETS = ['/'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network first — always fetch fresh content for a live platform
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// Handle FCM push notifications (already wired via Firebase)
self.addEventListener('push', e => {
  if (!e.data) return;
  try {
    const data = e.data.json();
    self.registration.showNotification(data.title || 'Weather TV Alert', {
      body: data.body || '',
      icon: '/images/icon-192.png',
      badge: '/images/icon-192.png',
      tag: 'weather-alert',
      renotify: true,
    });
  } catch(err) {}
});
