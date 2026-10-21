// WeatherTV — seasonal server features (road conditions)
//
//   Road conditions  /api/roads?bbox=w,s,e,n
//     State 511 "winter road conditions" (IBI/Skyline platform, the same
//     {STATE}_511_KEY variables the cameras use) plus Road511's normalised
//     road_conditions feed (ROAD511_API_KEY). Fetched only for states the map
//     is looking at, cached 10 min, so the 511 limits (10 calls/min) hold.
//
//   (Fall colors moved to the tile service: WeatherTV's own leaf-color model.)
//
// Nothing here receives or stores anything about viewers.
'use strict';

let redis = null;
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
  { id: 'wi', base: 'https://511wi.gov',            env: 'WI_511_KEY', box: [-92.9, 42.4, -86.2, 47.1] },
  { id: 'ny', base: 'https://511ny.org',            env: 'NY_511_KEY', box: [-79.8, 40.5, -71.8, 45.1] },
  { id: 'id', base: 'https://511.idaho.gov',        env: 'ID_511_KEY', box: [-117.3, 41.9, -111.0, 49.1] },
  { id: 'nv', base: 'https://www.nvroads.com',      env: 'NV_511_KEY', box: [-120.1, 35.0, -114.0, 42.1] },
  { id: 'ut', base: 'https://prod-ut.ibi511.com',   env: 'UT_511_KEY', box: [-114.1, 36.9, -109.0, 42.1] },
  { id: 'ak', base: 'https://511.alaska.gov',       env: 'AK_511_KEY', box: [-170, 51, -129.9, 71.5] },
  { id: 'ct', base: 'https://ctroads.org',          env: 'CT_511_KEY', box: [-73.8, 40.9, -71.7, 42.1] },
  // New England 511 = Maine, New Hampshire and Vermont (one system, one key)
  { id: 'ne', base: 'https://newengland511.org',    env: 'NE_511_KEY', box: [-73.5, 42.7, -66.9, 47.5] },
  { id: 'az', base: 'https://az511.com',            env: 'AZ_511_KEY', box: [-114.9, 31.3, -109.0, 37.1] },
  { id: 'nc', base: 'https://www.drivenc.gov',      env: 'NC_511_KEY', box: [-84.4, 33.8, -75.4, 36.6] },
  { id: 'ga', base: 'https://511ga.org',            env: 'GA_511_KEY', box: [-85.7, 30.3, -80.8, 35.0] },
];
const _roadCache = new Map();   // state id → { ts, features, error }
const ROAD_TTL = 10 * 60 * 1000, ROAD_MISS_TTL = 6 * 3600 * 1000;
const _roadStats = {};          // state id → { ok, count, error, at }

async function loadIbiState(st) {
  const key = process.env[st.env];
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

// Road511 (normalised feed across many states). Cached per 2° cell for 15 min and
// shared by every viewer, so calls don't grow with traffic. A daily cap keeps us
// well inside the Starter plan's 50,000 requests/day.
const _r511Cache = new Map();
const R511_TTL = 15 * 60 * 1000;
const R511_DAILY_CAP = Number(process.env.ROAD511_DAILY_CAP || 40000);
let _r511Day = '', _r511Calls = 0;
async function road511(bbox) {
  const key = process.env.ROAD511_API_KEY;
  if (!key) return [];
  const [w, s, e, n] = bbox;
  const cells = [];
  for (let x = Math.floor(w / 2) * 2; x < e; x += 2) for (let y = Math.floor(s / 2) * 2; y < n; y += 2) cells.push([x, y]);
  if (cells.length > 30) return [];        // zoomed out too far for this source
  const out = [];
  for (const [x, y] of cells) {
    const ck = x + ',' + y;
    let c = _r511Cache.get(ck);
    const today = new Date().toISOString().slice(0, 10);
    if (_r511Day !== today) { _r511Day = today; _r511Calls = 0; }
    if ((!c || Date.now() - c.ts > R511_TTL) && _r511Calls >= R511_DAILY_CAP) {
      if (c) out.push(...c.features);                 // over today's cap: keep serving what we have
      continue;
    }
    if (!c || Date.now() - c.ts > R511_TTL) {
      _r511Calls++;
      try {
        const txt = await getText(`https://api.road511.com/api/v1/features/geojson?type=road_conditions&bbox=${x},${y},${x + 2},${y + 2}&limit=1000`,
          { headers: { 'X-API-Key': key } });
        const fc = JSON.parse(txt);
        const feats = (fc.features || []).filter(f => f.geometry && /LineString/.test(f.geometry.type)).map(f => {
          const p = f.properties || {};
          const cond = p.condition || p.road_condition || p.surface_condition || p.status || p.title || '';
          return { type: 'Feature', geometry: f.geometry, properties: {
            cat: roadCategory(cond, p.surface, p.description), condition: String(cond), surface: p.surface || '',
            road: p.road_name || p.roadway || p.name || '', where: p.description || p.location || '',
            updated: p.updated_at || p.last_updated || null, src: 'road511' } };
        });
        c = { ts: Date.now(), features: feats };
        _roadStats.road511 = { count: (_roadStats.road511?.count || 0) + feats.length, at: new Date().toISOString(), callsToday: _r511Calls, cap: R511_DAILY_CAP };
      } catch (err) {
        c = { ts: Date.now(), features: [] };
        _roadStats.road511 = { error: err.message, at: new Date().toISOString(), callsToday: _r511Calls, cap: R511_DAILY_CAP };
      }
      _r511Cache.set(ck, c);
      if (_r511Cache.size > 400) _r511Cache.delete(_r511Cache.keys().next().value);
    }
    out.push(...c.features);
  }
  return out;
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
      const states = ROAD_STATES.filter(st => process.env[st.env] && boxHits(st.box, b));
      const nec = require('./nec');
      const necStates = Object.entries(nec.BOXES).filter(([, box]) => boxHits(box, b)).map(([code]) => code);
      const parts = await Promise.all([...states.map(ibiState), road511(b), ...necStates.map(c => nec.roadWeather(c))]);
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
      res.json({ type: 'FeatureCollection', features, sources: states.map(s => s.id).concat(process.env.ROAD511_API_KEY ? ['road511'] : [], necStates.map(c => 'nec-' + c)),
        credits: necStates.length ? [nec.CREDIT] : [] });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });
  app.get('/api/admin/roads', (req, res) => {
    res.json({ states: ROAD_STATES.map(s => ({ id: s.id, key: !!process.env[s.env], ...(_roadStats[s.id] || {}) })),
      road511: { key: !!process.env.ROAD511_API_KEY, ...(_roadStats.road511 || {}) } });
  });
}

async function init(redisClient) {
  redis = redisClient || null;
  // Remove the Explore Fall copies saved while that layer briefly ran (we don't use their data)
  if (redis) redis.del('wt:foliage:v1', 'wt:foliage:v2', 'wt:flag:foliage').catch(() => {});
}

module.exports = { routes, init, _test: { decodePolyline, roadCategory } };
