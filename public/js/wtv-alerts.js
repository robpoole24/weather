// WeatherTV alerts client — build.1790546400
// Keeps the user's alert location + alert-type choices ON THE DEVICE and
// turns them into push-topic subscriptions. Our server only relays the
// subscribe call to Firebase; it never receives coordinates.
const WTVAlerts = (() => {
  const LS_LOC = 'wtv-alert-location';     // { lat, lon, ugc:[…], label, ts }
  const LS_TYPES = 'push-alert-types';     // chosen alert types (existing key)
  const LS_SUB = 'wtv-alert-subscription'; // { token, topics:[…] } last synced
  let catalog = null;

  const read = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

  async function alertTypes() {
    if (catalog) return catalog;
    const r = await fetch('/api/radar/alert-types');
    catalog = await r.json();
    return catalog;
  }

  function kmBetween(a, b) {
    const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLon = (b.lon - a.lon) * Math.PI / 180;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // County + forecast zone codes, straight from NWS (browser → api.weather.gov)
  async function lookupAreas(lat, lon) {
    const r = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { headers: { Accept: 'application/geo+json' } });
    if (!r.ok) throw new Error('NWS points ' + r.status);
    const p = (await r.json()).properties || {};
    const ugc = [p.county, p.forecastZone].filter(Boolean).map(u => u.split('/').pop()).filter(u => /^[A-Z]{2}[CZ]\d{3}$/.test(u));
    const rl = p.relativeLocation?.properties || {};
    return { ugc, label: rl.city && rl.state ? `${rl.city}, ${rl.state}` : (ugc[0] || 'your area') };
  }

  // Save the alert location (device only). Re-looks-up NWS areas only after moving ~2 km.
  async function setLocation(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return getLocation();
    const prev = getLocation();
    const here = { lat: +lat.toFixed(4), lon: +lon.toFixed(4) };
    let loc;
    if (prev && prev.ugc?.length && kmBetween(prev, here) < 2) {
      loc = { ...prev, ...here, ts: Date.now() };
    } else {
      const a = await lookupAreas(here.lat, here.lon);
      loc = { ...here, ugc: a.ugc, label: a.label, ts: Date.now() };
    }
    write(LS_LOC, loc);
    await WTVAlertsCore.set('location', loc);   // for the service worker's polygon check
    await sync();
    return loc;
  }
  function getLocation() { return read(LS_LOC); }

  function hasSavedTypes() { return !!read(LS_TYPES); }
  async function chosenCodes() {
    const cat = await alertTypes();
    const saved = read(LS_TYPES);
    return cat.types.filter(t => t.always || (saved ? saved.includes(t.event) : t.defaultOn)).map(t => t.code);
  }
  async function setTypes(types) { write(LS_TYPES, types); await sync(); }

  // Make Firebase's topic list for this token match (areas × chosen types)
  async function sync(token) {
    const sub = read(LS_SUB) || {};
    token = token || sub.token;
    const loc = getLocation();
    if (!token || !loc || !loc.ugc?.length) return { skipped: true };
    const codes = await chosenCodes();
    const want = loc.ugc.flatMap(u => codes.map(c => `a_${u}_${c}`));
    const have = sub.token === token ? (sub.topics || []) : [];   // new token = fresh start
    const add = want.filter(t => !have.includes(t));
    const remove = have.filter(t => !want.includes(t));
    if (!add.length && !remove.length) return { unchanged: true };
    const r = await fetch('/api/radar/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, add, remove }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) write(LS_SUB, { token, topics: want.filter(t => !(j.failed || []).includes(t)) });
    return j;
  }

  return { setLocation, getLocation, setTypes, hasSavedTypes, alertTypes, sync, lookupAreas };
})();
