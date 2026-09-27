// WeatherTV alerts core — build.1790546400
// Shared by the web pages AND the service worker (via importScripts).
// Stores the user's alert location ON THIS DEVICE ONLY (IndexedDB), and
// decides whether an incoming warning polygon actually covers that location.
(function (g) {
  const DB = 'wtv-alerts', STORE = 'kv';

  function open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function get(key) {
    try {
      const db = await open();
      return await new Promise(res => {
        const q = db.transaction(STORE).objectStore(STORE).get(key);
        q.onsuccess = () => res(q.result); q.onerror = () => res(undefined);
      });
    } catch (_) { return undefined; }
  }
  async function set(key, value) {
    try {
      const db = await open();
      return await new Promise(res => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => res(true); tx.onerror = () => res(false);
      });
    } catch (_) { return false; }
  }

  // "lat,lon;lat,lon;…" → [[lat,lon],…]
  function parsePoly(s) {
    if (!s) return null;
    const pts = s.split(';').map(p => p.split(',').map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite));
    return pts.length >= 3 ? pts : null;
  }
  // Ray casting
  function pointInRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i], [yj, xj] = ring[j];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  // true  → warning covers the saved location (or it's a whole-zone alert)
  // false → same county, but the storm's polygon doesn't include the location
  function atLocation(data, loc) {
    const ring = parsePoly(data && data.poly);
    if (!ring || !loc || !Number.isFinite(loc.lat)) return true;
    return pointInRing(loc.lat, loc.lon, ring);
  }

  g.WTVAlertsCore = { get, set, parsePoly, pointInRing, atLocation };
})(typeof self !== 'undefined' ? self : this);
