// WeatherTV — seasonal server features (road conditions)
//
//   Road conditions  /api/roads?bbox=w,s,e,n
//     State 511 "winter road conditions" (IBI/Skyline platform, the same
//     {STATE}_511_KEY variables the cameras use), plus Road511 (ROAD511_API_KEY)
//     for states nothing else covers. Fetched only for states the map is
//     looking at and cached, so every provider's limits hold.
//
//   CARS 511 states (New York…) come from cars.js: their road-condition
//   segments, with the login in Railway variables.
//
//   (Fall colors moved to the tile service: WeatherTV's own leaf-color model.)
//
// Nothing here receives or stores anything about viewers.
'use strict';

let redis = null;
const cars = require('./cars');   // CARS 511 states (New York…): road-condition segments
const UA = 'WeatherTV/1.0 (watchweathertv.com)';

async function getText(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 20000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, */*', ...(opts.headers || {}) }, signal: ctl.signal });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return opts.buffer ? Buffer.from(await r.arrayBuffer()) : await r.text();
  } finally { clearTimeout(t); }
}

// ════════════════════════════════════════════════════════════════════════════
// Road conditions
// ════════════════════════════════════════════════════════════════════════════

// Google encoded polyline → [[lon, lat], …]
function decodePolyline(str) {
  const out = []; let i = 0, lat = 0, lon = 0;
  str = String(str || '').replace(/\s+/g, '');
  while (i < str.length) {
    let b, shift = 0, res = 0;
    do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < str.length);
    lat += (res & 1) ? ~(res >> 1) : (res >> 1);
    shift = 0; res = 0;
    do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < str.length);
    lon += (res & 1) ? ~(res >> 1) : (res >> 1);
    out.push([lon / 1e5, lat / 1e5]);
  }
  return out;
}

// One scale for every source: what a driver needs to know
//   good · wet · slippery (partly covered / slush / frost) · snow · ice · closed · unknown
function roadCategory(...texts) {
  const s = texts.filter(Boolean).join(' ').toLowerCase();
  if (!s.trim()) return 'unknown';
  if (/clos|impass|travel not advised|do not travel|no travel/.test(s)) return 'closed';
  if (/ice|icy|glaze|freezing rain|black ice/.test(s)) return 'ice';
  if (/snow ?covered|completely covered|covered|drift|snow packed|snowpack|packed/.test(s) && !/partly|partially|patch|spots|scatter/.test(s)) return 'snow';
  if (/partly|partially|patch|spots|scatter|slush|frost|slippery|slick|snow|winter driving|difficult|hazard/.test(s)) return 'slippery';
  if (/wet|moist|damp|rain|standing water/.test(s)) return 'wet';
  if (/dry|good|clear|normal|seasonal|bare|open/.test(s)) return 'good';
  if (/no report|unknown|not reported|n\/a/.test(s)) return 'unknown';
  return 'unknown';
}

// IBI/Skyline 511 states (same keys as the cameras). Boxes are rough state outlines.
const ROAD_STATES = [
  { id: 'wi', name: 'Wisconsin', base: 'https://511wi.gov',            env: 'WI_511_KEY', box: [-92.9, 42.4, -86.2, 47.1] },
  { id: 'ny', name: 'New York', base: 'https://511ny.org',            env: 'NY_511_KEY', box: [-79.8, 40.5, -71.8, 45.1] },
  { id: 'id', name: 'Idaho', base: 'https://511.idaho.gov',        env: 'ID_511_KEY', box: [-117.3, 41.9, -111.0, 49.1] },
  { id: 'nv', name: 'Nevada', base: 'https://www.nvroads.com',      env: 'NV_511_KEY', box: [-120.1, 35.0, -114.0, 42.1] },
  { id: 'ut', name: 'Utah', base: 'https://prod-ut.ibi511.com',   env: 'UT_511_KEY', box: [-114.1, 36.9, -109.0, 42.1] },
  { id: 'ak', name: 'Alaska', base: 'https://511.alaska.gov',       env: 'AK_511_KEY', box: [-170, 51, -129.9, 71.5] },
  // (Connecticut's API has no winter road conditions — only signs, events, advisories)
  // New England 511 = Maine, New Hampshire and Vermont (one system, one key)
  { id: 'ne', name: 'Maine, New Hampshire & Vermont', base: 'https://newengland511.org',    env: 'NE_511_KEY', box: [-73.5, 42.7, -66.9, 47.5] },
  { id: 'az', name: 'Arizona', base: 'https://az511.com',            env: 'AZ_511_KEY', box: [-114.9, 31.3, -109.0, 37.1] },
  { id: 'nc', name: 'North Carolina', base: 'https://www.drivenc.gov',      env: 'NC_511_KEY', box: [-84.4, 33.8, -75.4, 36.6] },
  { id: 'ga', name: 'Georgia', base: 'https://511ga.org',            env: 'GA_511_KEY', box: [-85.7, 30.3, -80.8, 35.0] },
];
const _roadCache = new Map();   // state id → { ts, features, error }
const ROAD_TTL = 10 * 60 * 1000, ROAD_MISS_TTL = 6 * 3600 * 1000;
const _roadStats = {};          // state id → { ok, count, error, at }

async function loadIbiState(st) {
  const key = (process.env[st.env] || '').trim();
  if (!key) return { features: [], error: 'no key' };
  let lastErr = null;
  // Newer sites answer /api/v2 or v3; older ones (511NY) use /api/GetWinterRoadConditions
  const paths = ['/api/v2/get/winterroads', '/api/v3/get/winterroads', '/api/getwinterroadconditions'];
  for (const path of paths) {
    try {
      const txt = await getText(`${st.base}${path}?key=${encodeURIComponent(key)}&format=json`);
      const rows = JSON.parse(txt);
      const list = Array.isArray(rows) ? rows : (rows.WinterRoads || rows.winterRoads || rows.data || []);
      const features = [];
      for (const r of list) {
        const enc = r.EncodedPolyline ?? r.Polyline ?? r.EncodedPolylines;
        const poly = Array.isArray(enc) ? enc.join('') : enc;
        const coords = decodePolyline(poly);
        if (coords.length < 2) continue;
        let cond = r['Overall Condition'] || r.OverallCondition || r['Overall-Condition'] || r.Condition || '';
        let surface = r.RoadSurface || r.SurfaceCondition || '';
        // States name these differently (Idaho, Utah…): fall back to any condition-like field
        if (!cond && !surface) {
          const bits = [];
          for (const [k, v] of Object.entries(r)) {
            if (!/cond|surface|pavement|travel|roadstate/i.test(k) || /id$|time|date|updated|polyline|location|area|roadway/i.test(k)) continue;
            if (typeof v === 'string' && v.trim()) bits.push(v.trim());
            else if (Array.isArray(v)) v.forEach(x => { if (typeof x === 'string' && x.trim()) bits.push(x.trim()); else if (x && typeof x === 'object') Object.values(x).forEach(y => { if (typeof y === 'string' && y.trim() && y.length < 60) bits.push(y.trim()); }); });
          }
          cond = [...new Set(bits)].join(', ');
        }
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: {
            cat: roadCategory(cond, surface), condition: cond, surface,
            road: r.RoadwayName || r.Roadway || '', where: r.LocationDescription || r.AreaName || '',
            updated: r.LastUpdated ? new Date(Number(r.LastUpdated) * 1000).toISOString() : null, src: st.id,
          },
        });
      }
      return { features };
    } catch (e) { lastErr = e; if (e.status && e.status !== 404) break; }
  }
  return { features: [], error: lastErr ? lastErr.message : 'failed', miss: lastErr && lastErr.status === 404 };
}

async function ibiState(st) {
  const c = _roadCache.get(st.id);
  if (c && Date.now() - c.ts < (c.miss ? ROAD_MISS_TTL : ROAD_TTL)) return c.features;
  if (c && c.loading) return c.loading;
  const loading = loadIbiState(st).then(r => {
    _roadCache.set(st.id, { ts: Date.now(), features: r.features, miss: r.miss, error: r.error });
    _roadStats[st.id] = { count: r.features.length, error: r.error || null, at: new Date().toISOString() };
    return r.features;
  }).catch(() => { _roadCache.set(st.id, { ts: Date.now(), features: [] }); return []; });
  _roadCache.set(st.id, { ...(c || { ts: 0, features: [] }), loading });
  return loading;
}

// Road511 — fills the states we don't get road conditions from directly.
// Shaped for their Free/trial plan (Oct 2026): every request names its states
// (jurisdiction=XX,YY — at most 2), plain JSON (no GeoJSON), 100 results per
// page, 20 requests/minute, 1,000 requests/day. So: one call per pair of states
// per page, each state cached 45 min and shared by every viewer, only states on
// screen, only states with no other road-condition feed, a daily budget below
// their limit (ROAD511_DAILY_CAP, default 900) and at most 15 calls a minute.
// Over budget or refused: keep showing the last data and stop asking for a while.
const R511_BASE = 'https://api.road511.com/api/v1/features';
const R511_TTL = Number(process.env.ROAD511_TTL_MIN || 45) * 60 * 1000;
const R511_DAILY_CAP = Number(process.env.ROAD511_DAILY_CAP || 900);
const R511_PER_MIN = 15, R511_PAGE = 100, R511_MAX_PAGES = 15;
// Rough state outlines (w, s, e, n) — to know which states are on screen
const STATE_BOXES = {
  AL: [-88.5, 30.1, -84.9, 35.0], AZ: [-114.9, 31.3, -109.0, 37.0], AR: [-94.7, 33.0, -89.6, 36.5], CA: [-124.5, 32.5, -114.1, 42.0],
  CO: [-109.1, 36.9, -102.0, 41.0], CT: [-73.8, 40.9, -71.8, 42.1], DE: [-75.8, 38.4, -75.0, 39.9], DC: [-77.2, 38.8, -76.9, 39.0],
  FL: [-87.7, 24.4, -80.0, 31.0], GA: [-85.7, 30.3, -80.8, 35.0], ID: [-117.3, 41.9, -111.0, 49.0], IL: [-91.6, 36.9, -87.0, 42.5],
  IN: [-88.1, 37.7, -84.8, 41.8], IA: [-96.7, 40.3, -90.1, 43.6], KS: [-102.1, 36.9, -94.6, 40.0], KY: [-89.6, 36.4, -81.9, 39.2],
  LA: [-94.1, 28.9, -88.8, 33.1], ME: [-71.1, 43.0, -66.9, 47.5], MD: [-79.5, 37.9, -75.0, 39.8], MA: [-73.6, 41.2, -69.9, 42.9],
  MI: [-90.5, 41.6, -82.1, 48.3], MN: [-97.3, 43.5, -89.5, 49.4], MS: [-91.7, 30.1, -88.1, 35.0], MO: [-95.8, 35.9, -89.1, 40.7],
  MT: [-116.1, 44.3, -104.0, 49.0], NE: [-104.1, 39.9, -95.3, 43.1], NV: [-120.1, 35.0, -114.0, 42.0], NH: [-72.6, 42.6, -70.6, 45.4],
  NJ: [-75.6, 38.9, -73.9, 41.4], NM: [-109.1, 31.3, -103.0, 37.0], NY: [-79.8, 40.5, -71.8, 45.1], NC: [-84.4, 33.8, -75.4, 36.6],
  ND: [-104.1, 45.9, -96.5, 49.0], OH: [-84.9, 38.4, -80.5, 42.0], OK: [-103.1, 33.6, -94.4, 37.0], OR: [-124.6, 41.9, -116.4, 46.3],
  PA: [-80.6, 39.7, -74.7, 42.3], RI: [-71.9, 41.1, -71.1, 42.1], SC: [-83.4, 32.0, -78.5, 35.3], SD: [-104.1, 42.4, -96.4, 45.95],
  TN: [-90.4, 34.9, -81.6, 36.7], TX: [-106.7, 25.8, -93.5, 36.5], UT: [-114.1, 36.9, -109.0, 42.0], VT: [-73.5, 42.7, -71.4, 45.1],
  VA: [-83.7, 36.5, -75.2, 39.5], WA: [-124.8, 45.5, -116.9, 49.0], WV: [-82.7, 37.2, -77.7, 40.7], WI: [-92.9, 42.4, -86.2, 47.1],
  WY: [-111.1, 40.9, -104.0, 45.0], AK: [-170, 51, -129.9, 71.5], HI: [-160.3, 18.9, -154.8, 22.3],
};
const _r511 = new Map();                  // state → { ts, features }
const _r511Stats = {};                    // state → { count, at, error }
let _r511Day = '', _r511Calls = 0, _r511Minute = 0, _r511MinuteCalls = 0, _r511PauseUntil = 0, _r511Sample = null, _r511Busy = null;
function _r511Budget() {
  const now = Date.now(), today = new Date().toISOString().slice(0, 10), min = Math.floor(now / 60000);
  if (_r511Day !== today) { _r511Day = today; _r511Calls = 0; }
  if (_r511Minute !== min) { _r511Minute = min; _r511MinuteCalls = 0; }
  return now >= _r511PauseUntil && _r511Calls < R511_DAILY_CAP && _r511MinuteCalls < R511_PER_MIN;
}
// Their JSON shape isn't documented to us: accept a list, or a list inside data/features/items/results
function _r511Rows(j) {
  if (Array.isArray(j)) return j;
  for (const k of ['data', 'features', 'items', 'results', 'records']) if (j && Array.isArray(j[k])) return j[k];
  return [];
}
function _r511Line(r) {
  const g = r.geometry || (r.properties && r.properties.geometry) || null;
  if (g && Array.isArray(g.coordinates)) {
    if (g.type === 'LineString' && g.coordinates.length > 1) return { type: 'LineString', coordinates: g.coordinates };
    if (g.type === 'MultiLineString' && g.coordinates.length) return { type: 'MultiLineString', coordinates: g.coordinates };
  }
  const enc = r.encoded_polyline || r.polyline || r.EncodedPolyline || (typeof g === 'string' && !/^\s*[A-Z]+\s*\(/.test(g) ? g : null);
  if (enc) { const c = decodePolyline(enc); if (c.length > 1) return { type: 'LineString', coordinates: c }; }
  const wkt = typeof g === 'string' ? g.match(/LINESTRING\s*\(([^)]+)\)/i) : null;
  if (wkt) {
    const c = wkt[1].split(',').map(p => p.trim().split(/\s+/).map(Number)).filter(p => p.length >= 2 && p.every(Number.isFinite));
    if (c.length > 1) return { type: 'LineString', coordinates: c };
  }
  return null;
}
function _r511Feature(r, st) {
  const p = Object.assign({}, r.properties || {}, r);
  const geometry = _r511Line(r);
  if (!geometry) return null;
  const cond = p.condition || p.road_condition || p.surface_condition || p.status || p.title || p.description || '';
  return { type: 'Feature', geometry, properties: {
    cat: roadCategory(cond, p.surface), condition: String(cond).slice(0, 120), surface: p.surface || '',
    road: p.road_name || p.roadway || p.road || p.name || '', where: p.location || p.description || '',
    updated: p.updated_at || p.last_updated || p.updated || null, src: 'road511-' + st.toLowerCase() } };
}
async function _r511Fetch(pair, key) {
  const feats = Object.fromEntries(pair.map(s => [s, []]));
  for (let page = 0; page < R511_MAX_PAGES; page++) {
    if (!_r511Budget()) throw Object.assign(new Error('over budget'), { budget: true });
    _r511Calls++; _r511MinuteCalls++;
    let rows;
    try {
      const txt = await getText(`${R511_BASE}?type=road_conditions&jurisdiction=${pair.join(',')}&limit=${R511_PAGE}&offset=${page * R511_PAGE}`,
        { headers: { 'X-API-Key': key }, timeout: 20000 });
      const j = JSON.parse(txt);
      rows = _r511Rows(j);
      if (!_r511Sample && rows[0]) _r511Sample = { topLevel: Array.isArray(j) ? 'list' : Object.keys(j).slice(0, 12), firstItemKeys: Object.keys(rows[0]).slice(0, 30) };
    } catch (e) {
      // Refused (401/403) or throttled (429): stop asking for a while
      if (e.status === 401 || e.status === 403) _r511PauseUntil = Date.now() + 6 * 3600 * 1000;
      if (e.status === 429) _r511PauseUntil = Date.now() + 10 * 60 * 1000;
      throw e;
    }
    for (const r of rows) {
      const p = r.properties || r;
      const j = String(p.jurisdiction || p.state || p.state_code || '').toUpperCase().slice(-2);
      const st = pair.includes(j) ? j : pair[0];
      const f = _r511Feature(r, st);
      if (f) feats[st].push(f);
    }
    if (rows.length < R511_PAGE) break;
  }
  return feats;
}
async function road511(bbox, coveredStates) {
  const key = process.env.ROAD511_API_KEY;
  if (!key) return [];
  // Only states on screen that no other source covers
  const want = Object.entries(STATE_BOXES).filter(([st, box]) => boxHits(box, bbox) && !coveredStates.has(st)).map(([st]) => st);
  if (want.length > 8) return [];                             // zoomed out too far for this source
  const stale = want.filter(st => { const c = _r511.get(st); return !c || Date.now() - c.ts > R511_TTL; });
  if (stale.length) {
    // One refresh at a time, shared: other viewers wait for it instead of asking again
    if (!_r511Busy) {
      _r511Busy = (async () => {
        for (let i = 0; i < stale.length; i += 2) {
          const pair = stale.slice(i, i + 2);
          try {
            const got = await _r511Fetch(pair, key);
            for (const st of pair) { _r511.set(st, { ts: Date.now(), features: got[st] }); _r511Stats[st] = { count: got[st].length, at: new Date().toISOString() }; }
          } catch (e) {
            for (const st of pair) {
              const old = _r511.get(st);
              // Keep what we had; try again after a quarter of the cache time
              _r511.set(st, { ts: Date.now() - R511_TTL * 0.75, features: old ? old.features : [] });
              _r511Stats[st] = { ...(_r511Stats[st] || {}), error: e.budget ? 'daily/minute budget reached' : e.message, at: new Date().toISOString() };
            }
            if (e.budget) break;
          }
        }
      })().finally(() => { _r511Busy = null; });
    }
    await _r511Busy;
  }
  _roadStats.road511 = { callsToday: _r511Calls, cap: R511_DAILY_CAP, perMinute: R511_PER_MIN, cacheMinutes: R511_TTL / 60000,
    pausedUntil: _r511PauseUntil > Date.now() ? new Date(_r511PauseUntil).toISOString() : null, states: _r511Stats, sample: _r511Sample };
  return want.flatMap(st => (_r511.get(st) || { features: [] }).features);
}

// ── Road closures & weather hazards from the same IBI 511 states ─────────────
// /api/v2/get/event (roadwork · closures · accidentsAndIncidents). Same keys
// and the same sorting as the CARS states: weather-caused events, plus roads
// fully closed right now. Ordinary roadwork, crashes and events are left out.
const HAZ_TTL = 5 * 60 * 1000;
const _ibiHaz = new Map();      // state id → { ts, items, loading, miss }
function ibiEventToHazard(ev, st, now) {
  const type = String(ev.EventType || ''), sub = String(ev.EventSubType || ''), desc = String(ev.Description || '');
  const kind = cars.weatherKind(/roadwork|special/i.test(type) ? sub : sub + ' ' + desc + ' ' + String(ev.Comment || ''));
  const closed = ev.IsFullClosure === true || (/closure/i.test(type) && /\b(road|roadway|highway|bridge|ramp|all lanes)\b[^.]{0,40}\bclosed\b|\bclosed\b[^.]{0,20}\b(both directions|to (all )?traffic)\b/i.test(desc));
  if (!kind && !closed) return null;
  const sec = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) * 1000 : null);
  const start = sec(ev.StartDate), end = sec(ev.PlannedEndDate);
  if (start && start > now + 15 * 60 * 1000) return null;
  if (end && end < now) return null;
  const lat = Number(ev.Latitude), lng = Number(ev.Longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (Math.abs(lat) < 1 && Math.abs(lng) < 1)) return null;
  let line = null;
  if (ev.EncodedPolyline) {
    const pts = decodePolyline(ev.EncodedPolyline);
    if (pts.length > 1) line = pts.filter((_, i, a) => a.length < 400 || i % Math.ceil(a.length / 400) === 0).map(([x, y]) => [+y.toFixed(5), +x.toFixed(5)]);
  }
  const title = sub && !/^(roadwork|closures|accidentsAndIncidents)$/i.test(sub) ? sub : (closed ? 'Road closed' : (kind ? 'Weather hazard' : 'Hazard'));
  return {
    id: st.id + '-' + ev.ID, kind: kind || 'closure', closed,
    title: title.charAt(0).toUpperCase() + title.slice(1),
    road: ev.RoadwayName || '', text: [desc, ev.Comment].filter(Boolean).join(' ').slice(0, 600),
    lat: +lat.toFixed(5), lng: +lng.toFixed(5), line,
    start: start ? new Date(start).toISOString() : null, end: end ? new Date(end).toISOString() : null,
    updated: sec(ev.LastUpdated) ? new Date(sec(ev.LastUpdated)).toISOString() : null,
    priority: ev.Severity || null, src: st.id, credit: (new URL(st.base).host.replace(/^www\./, '')) + ' · ' + st.name + ' 511',
  };
}
async function loadIbiHazards(st) {
  const key = (process.env[st.env] || '').trim();
  let lastErr = null;
  for (const path of ['/api/v2/get/event', '/api/getevents']) {
    try {
      const rows = JSON.parse(await getText(`${st.base}${path}?key=${encodeURIComponent(key)}&format=json`, { timeout: 30000 }));
      const list = Array.isArray(rows) ? rows : (rows.Events || rows.events || []);
      const now = Date.now(), items = [];
      for (const ev of list) { const h = ibiEventToHazard(ev, st, now); if (h) items.push(h); }
      _roadStats['events-' + st.id] = { events: list.length, shown: items.length, at: new Date().toISOString() };
      return { items };
    } catch (e) { lastErr = e; if (e.status && e.status !== 404) break; }
  }
  _roadStats['events-' + st.id] = { error: lastErr ? lastErr.message : 'failed', at: new Date().toISOString() };
  return { items: [], miss: lastErr && lastErr.status === 404 };
}
function ibiHazards(st) {
  const c = _ibiHaz.get(st.id);
  if (c && Date.now() - c.ts < (c.miss ? ROAD_MISS_TTL : HAZ_TTL)) return Promise.resolve(c.items);
  if (c && c.loading) return c.loading;
  const loading = loadIbiHazards(st)
    .then(r => { _ibiHaz.set(st.id, { ts: Date.now(), items: r.items, miss: r.miss }); return r.items; })
    .catch(() => { _ibiHaz.set(st.id, { ts: Date.now(), items: (c && c.items) || [] }); return (c && c.items) || []; });
  _ibiHaz.set(st.id, { ...(c || { ts: 0, items: [] }), loading });
  return loading;
}

const boxHits = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
function lineInBox(coords, b) {
  for (const [x, y] of coords) if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) return true;
  return false;
}

// ════════════════════════════════════════════════════════════════════════════
function routes(app) {
  // ── Road conditions ──
  app.get('/api/roads', async (req, res) => {
    const b = String(req.query.bbox || '').split(',').map(Number);
    if (b.length !== 4 || !b.every(Number.isFinite) || b[2] <= b[0] || b[3] <= b[1]) return res.status(400).json({ error: 'bbox=w,s,e,n' });
    if ((b[2] - b[0]) > 30 || (b[3] - b[1]) > 20) return res.json({ type: 'FeatureCollection', features: [], tooWide: true });
    try {
      // A state on the newer CARS feed replaces its old 511 entry
      const carsStates = cars.STATES.filter(st => cars.configured(st.id) && boxHits(st.box, b));
      const states = ROAD_STATES.filter(st => process.env[st.env] && boxHits(st.box, b) && !carsStates.some(c => c.id === st.id));
      const nec = require('./nec');
      const necStates = Object.entries(nec.BOXES).filter(([, box]) => boxHits(box, b)).map(([code]) => code);
      // Road511 only fills states no other source covers (their trial allows 1,000 calls a day)
      const covered = new Set([...ROAD_STATES.filter(st => process.env[st.env]).map(st => st.id === 'ne' ? ['ME', 'NH', 'VT'] : [st.id.toUpperCase()]).flat(),
        ...cars.STATES.filter(st => cars.configured(st.id)).map(st => st.id.toUpperCase()), ...Object.keys(nec.BOXES).map(c => c.toUpperCase())]);
      const parts = await Promise.all([...states.map(ibiState), road511(b, covered), ...necStates.map(c => nec.roadWeather(c)),
        ...carsStates.map(st => cars.roads(st.id, roadCategory))]);
      const seen = new Set(), features = [];
      for (const f of parts.flat()) {
        const g = f.geometry;
        const pts = g.type === 'Point' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates.flat() : g.coordinates;
        if (!lineInBox(pts, b)) continue;
        const k = JSON.stringify(pts[0]) + JSON.stringify(pts[pts.length - 1]);
        if (seen.has(k)) continue; seen.add(k);
        features.push(f);
        if (features.length >= 4000) break;
      }
      res.set('Cache-Control', 'public, max-age=300');
      res.json({ type: 'FeatureCollection', features, sources: states.map(s => s.id).concat(process.env.ROAD511_API_KEY ? ['road511'] : [], necStates.map(c => 'nec-' + c), carsStates.map(s => 'cars-' + s.id)),
        credits: necStates.length ? [nec.CREDIT] : [] });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });
  // ── Road closures & weather hazards in the map view: ?bbox=w,s,e,n ──
  app.get('/api/road-hazards', async (req, res) => {
    const b = String(req.query.bbox || '').split(',').map(Number);
    if (b.length !== 4 || !b.every(Number.isFinite) || b[2] <= b[0] || b[3] <= b[1]) return res.status(400).json({ error: 'bbox=w,s,e,n' });
    if ((b[2] - b[0]) > 40 || (b[3] - b[1]) > 25) return res.json({ items: [], tooWide: true });
    // Feeds can carry events just over a state line, so look a little past each state's edge
    const near = (box) => boxHits([box[0] - 2, box[1] - 2, box[2] + 2, box[3] + 2], b);
    const carsStates = cars.STATES.filter(st => cars.configured(st.id));
    const ibiStates = ROAD_STATES.filter(st => process.env[st.env] && !carsStates.some(c => c.id === st.id));
    const covered = carsStates.map(s => s.name).concat(ibiStates.map(s => s.name));
    try {
      const parts = await Promise.all([...carsStates.filter(st => near(st.box)).map(st => cars.hazards(st.id)),
        ...ibiStates.filter(st => near(st.box)).map(ibiHazards)]);
      const seen = new Set(), items = [];
      for (const h of parts.flat()) {
        if (h.lat < b[1] || h.lat > b[3] || h.lng < b[0] || h.lng > b[2] || seen.has(h.id)) continue;
        seen.add(h.id); items.push(h);
        if (items.length >= 1500) break;
      }
      res.set('Cache-Control', 'public, max-age=120');
      res.json({ items, states: parts.length ? covered : [], covered });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.get('/api/admin/roads', (req, res) => {
    // roads / events: what each feed returned the last time someone looked (nothing yet = not used since the last restart)
    const none = 'not checked since restart';
    res.json({ states: ROAD_STATES.map(s => ({ id: s.id, name: s.name, key: !!process.env[s.env],
        roads: _roadStats[s.id] || none, events: _roadStats['events-' + s.id] || none })),
      road511: { key: !!process.env.ROAD511_API_KEY, ...(_roadStats.road511 || {}) },
      cars: cars.STATES.map(s => ({ id: s.id, name: s.name, configured: cars.configured(s.id) })),
      note: 'Feeds are only fetched while someone has the layer on. Open the map with Winter Road Conditions or Road Closures & Hazards on over a state, then reload this page. New York (CARS) details: /api/admin/cars' });
  });
}

async function init(redisClient) {
  redis = redisClient || null;
  // Remove the Explore Fall copies saved while that layer briefly ran (we don't use their data)
  if (redis) redis.del('wt:foliage:v1', 'wt:foliage:v2', 'wt:flag:foliage').catch(() => {});
}

module.exports = { routes, init, _test: { decodePolyline, roadCategory } };
