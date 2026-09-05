// Weather TV Service Worker
// Minimal SW — just enough to satisfy PWA requirements
// Weather TV is a live content platform so we don't cache aggressively

const CACHE_NAME = 'weathertv-v2';
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

// Network first — ONLY for same-origin requests.
// DO NOT intercept cross-origin tile requests (IEM, NOAA, Cloudflare tiles,
// api.weather.gov, etc.) — those should go straight to the network.
// Intercepting tile CDNs adds overhead and causes "Failed to convert value
// to 'Response'" errors whenever a tile 404s or 503s.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Skip the radar page itself — it needs fresh data always
  if (url.pathname === '/radar.html') return;

  e.respondWith(
    fetch(e.request).catch(() =>
      caches.match(e.request).then(cached =>
        cached || new Response('', { status: 503, statusText: 'Offline' })
      )
    )
  );
});

// Handle FCM push notifications
self.addEventListener('push', e => {
  if (!e.data) return;
  e.waitUntil((async () => {
    try {
      const payload = e.data.json();
      // FCM V1 sends { notification:{title,body}, data:{event,url,...} }
      // Some paths send title/body at top level — handle both
      const title = payload.notification?.title || payload.title || 'WeatherTV Alert';
      const body  = payload.notification?.body  || payload.body  || '';
      const pdata = payload.data || {};
      // Use the deep-link URL which includes lat/lng so tapping the
      // notification opens the radar centered on the user's location
      const url   = pdata.url || payload.fcmOptions?.link || 'https://www.watchweathertv.com/radar.html';

      await self.registration.showNotification(title, {
        body,
        icon:               '/images/icon-192.png',
        badge:              '/images/icon-192.png',
        tag:                'weather-alert-' + (pdata.alertId || 'active'),
        renotify:           true,
        requireInteraction: true,
        vibrate:            [200, 100, 200, 100, 400],
        data:               { url },
      });
    } catch(err) {
      // Fallback — always show something
      await self.registration.showNotification('WeatherTV Alert', {
        body: 'Active weather alert in your area. Tap to view.',
        icon: '/images/icon-192.png',
        data: { url: '/radar.html' },
      });
    }
  })());
});

// Open radar when user taps the notification
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/radar.html';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // If WeatherTV is already open, focus it and navigate to radar
      for (const client of windowClients) {
        if (client.url.includes('watchweathertv.com') && 'focus' in client) {
          client.focus();
          client.navigate(url);
          return;
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
