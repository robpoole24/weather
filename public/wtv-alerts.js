// WeatherTV alerts client — build.1792500000
// Keeps the user's alert location + alert-type choices ON THE DEVICE and
// turns them into push-topic subscriptions. Our server only relays the
// subscribe call to Firebase; it never receives coordinates.
const WTVAlerts = (() => {
  const LS_LOC = 'wtv-alert-location';     // { lat, lon, ugc:[…], label, ts }
  const LS_TYPES = 'push-alert-types';     // chosen alert types (existing key)
  const LS_SUB = 'wtv-alert-subscription'; // { token, topics:[…] } last synced
  const LS_KNOWN = 'push-alert-known';     // alert types this device has been offered
  // The 17 types offered before the full list. People who saved choices back
  // then haven't seen the newer types, so new on-by-default ones turn on for them.
  const FIRST_TYPES = ['Tornado Warning', 'Extreme Wind Warning', 'Severe Thunderstorm Warning', 'Flash Flood Warning',
    'Tornado Watch', 'Severe Thunderstorm Watch', 'Flood Warning', 'Flash Flood Watch', 'Winter Storm Warning',
    'Blizzard Warning', 'Ice Storm Warning', 'High Wind Warning', 'Extreme Heat Warning', 'Red Flag Warning',
    'Air Quality Alert', 'Dense Smoke Advisory', 'Special Weather Statement'];
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
    const known = read(LS_KNOWN) || FIRST_TYPES;
    return cat.types.filter(t => t.always || (saved ? (saved.includes(t.event) || (t.defaultOn && !known.includes(t.event))) : t.defaultOn))
      .map(t => t.code);
  }
  // The choices shown in the settings (same rule as above, by name)
  async function chosenTypes() {
    const cat = await alertTypes();
    const codes = await chosenCodes();
    return cat.types.filter(t => codes.includes(t.code)).map(t => t.event);
  }
  async function setTypes(types) {
    const cat = await alertTypes();
    write(LS_TYPES, types);
    write(LS_KNOWN, cat.types.map(t => t.event));   // everything in the list has now been offered
    await sync();
  }

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
    // The server takes up to 80 topics per call (areas × alert types can be ~180)
    const failed = [];
    let added = 0, removed = 0, ok = true, error = null;
    for (let i = 0; i < Math.max(add.length, remove.length); i += 80) {
      const r = await fetch('/api/radar/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, add: add.slice(i, i + 80), remove: remove.slice(i, i + 80) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { ok = false; error = j.error || ('HTTP ' + r.status); add.slice(i, i + 80).forEach(t => failed.push(t)); continue; }
      (j.failed || []).forEach(t => failed.push(t));
      added += j.added || 0; removed += j.removed || 0;
    }
    write(LS_SUB, { token, topics: want.filter(t => !failed.includes(t) && (have.includes(t) || add.includes(t))) });
    return { ok: ok && !failed.length, added, removed, failed, error };
  }

  return { setLocation, getLocation, setTypes, chosenTypes, hasSavedTypes, alertTypes, sync, lookupAreas };
})();
