// New England Compass — Maine, New Hampshire & Vermont DOTs (Tri-State)
// Developer Portal: https://nec-por.ne-compass.com/DeveloperPortal
// Terms: free to use, reproduce and redistribute with credit to the Tri-State
// DOTs; no state logos; don't claim the data as ours; be gentle with their
// servers. No key needed.
//
//   Cameras        cctvStatusData (locations) + cctvSnapshotData (every
//                  camera's latest JPEG, base64, in ONE file per state).
//                  Snapshots are fetched at most every 3 min per state and only
//                  while someone is looking, then served from memory.
//   Road weather   essData: road-weather stations with road surface condition,
//                  air & pavement temperature → points on the road layer.
'use strict';
const crypto = require('crypto');

const BASE = 'https://nec-por.ne-compass.com/NEC.XmlDataPortal/api/c2c';
const NETWORKS = { me: 'Maine', nh: 'NewHampshire', vt: 'Vermont' };
const CREDIT = 'Maine, New Hampshire & Vermont DOTs (New England Compass)';
const UA = 'WeatherTV/1.0 (watchweathertv.com)';

async function getText(url, timeout = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/xml, text/xml, */*' }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`)); return m ? m[1].trim() : ''; };
const unesc = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const shortId = (id) => crypto.createHash('sha1').update(id).digest('hex').slice(0, 12);
const blocks = (xml, name) => xml.match(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?</${name}>`, 'g')) || [];
const attrId = (b) => unesc((b.match(/\bid="([^"]*)"/) || [])[1] || '');
const micro = (v) => { const n = Number(v); return Number.isFinite(n) ? n / 1e6 : NaN; };

// ── Cameras ──────────────────────────────────────────────────────────────────
async function loadCameras(code) {
  const net = NETWORKS[code];
  if (!net) return [];
  const xml = await getText(`${BASE}?networks=${net}&dataTypes=cctvStatusData`);
  const out = [];
  for (const b of blocks(xml, 'cctvStatus')) {
    const id = attrId(b);
    const lat = micro(tag(b, 'lat')), lng = micro(tag(b, 'lon'));
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (!/online/i.test(tag(b, 'status')) || tag(b, 'blackout') === 'true') continue;
    const sid = shortId(id);
    out.push({
      id: `nec-${code}-${sid}`,
      name: unesc(tag(b, 'name')) || 'Traffic Camera',
      lat, lng,
      imageUrl: `/api/nec-cam/${code}/${sid}.jpg`,     // served from the snapshot cache below
      videoUrl: null,
      direction: unesc(tag(tag(b, 'equipLoc'), 'direction')) || null,
      source: code,
      // Credit + link shown under the picture ("View on New England 511 ↗")
      provider: 'New England 511 · ME, NH & VT DOTs',
      pageUrl: 'https://newengland511.org',
    });
  }
  return out;
}

// One snapshot file per state holds every camera's latest picture.
const _snap = {};        // code → { ts, images: Map(sid → Buffer), loading, lastUse }
const SNAP_TTL = 3 * 60 * 1000;     // Maine's file is ~14 MB: refresh at most every 3 min, only while someone is viewing
async function snapshot(code, sid) {
  const net = NETWORKS[code];
  if (!net) return null;
  let s = _snap[code];
  const now = Date.now();
  if (!s || (now - s.ts > SNAP_TTL && !s.loading)) {
    const prev = s;
    s = _snap[code] = { ts: prev ? prev.ts : 0, images: prev ? prev.images : new Map(), lastUse: now };
    s.loading = getText(`${BASE}?networks=${net}&dataTypes=cctvSnapshotData`, 45000).then(xml => {
      const images = new Map();
      for (const b of blocks(xml, 'cctvSnapshot')) {
        const data = tag(b, 'snippet');
        if (data.length < 200) continue;
        try { images.set(shortId(attrId(b)), Buffer.from(data.replace(/\s+/g, ''), 'base64')); } catch (_) {}
      }
      s.images = images; s.ts = Date.now();
    }).catch(e => { console.warn(`[NEC] ${net} snapshots: ${e.message}`); s.ts = Date.now() - SNAP_TTL + 30000; })
      .finally(() => { s.loading = null; });
  }
  s.lastUse = now;
  if (!s.images.size && s.loading) await s.loading;      // first request waits for the file
  return s.images.get(sid) || null;
}
// Free the pictures when nobody has looked at a state for 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of Object.entries(_snap)) if (!s.loading && now - s.lastUse > 10 * 60 * 1000) delete _snap[k];
}, 60 * 1000).unref();

// ── Road weather stations ────────────────────────────────────────────────────
const _ess = {};         // code → { ts, features }
const ESS_TTL = 10 * 60 * 1000;
function surfaceCategory(s) {
  s = String(s || '').toLowerCase();
  if (!s || /n\/a|unknown|error|other/.test(s)) return null;
  if (/ice|frost|black/.test(s)) return 'ice';
  if (/snow|slush/.test(s)) return 'snow';
  if (/chemically|treated|wet|damp|moist|trace|water|standing/.test(s)) return 'wet';
  if (/dry/.test(s)) return 'good';
  return null;
}
async function roadWeather(code) {
  const c = _ess[code];
  if (c && Date.now() - c.ts < ESS_TTL) return c.features;
  const net = NETWORKS[code];
  let features = [];
  try {
    const xml = await getText(`${BASE}?networks=${net}&dataTypes=essData`);
    for (const b of blocks(xml, 'ess')) {
      const lat = micro(tag(b, 'lat')), lng = micro(tag(b, 'lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !/online/i.test(tag(b, 'status'))) continue;
      const ts = Date.parse(tag(b, 'timestamp'));
      if (!Number.isFinite(ts) || Date.now() - ts > 3 * 3600 * 1000) continue;      // stale reading
      const surface = unesc(tag(b, 'roadSurfaceCond'));
      const cat = surfaceCategory(surface);
      if (!cat) continue;
      const num = (n) => { const v = Number(tag(b, n)); return Number.isFinite(v) ? v : null; };
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {
        cat, condition: surface, surface, road: unesc(tag(tag(b, 'equipLoc'), 'roadway')),
        where: unesc(tag(b, 'name')) + (tag(tag(b, 'equipLoc'), 'locationDescription') ? ' · ' + unesc(tag(tag(b, 'equipLoc'), 'locationDescription')) : ''),
        airF: num('airTemp'), pavementF: num('pavementTemp'), updated: new Date(ts).toISOString(), src: 'nec-' + code, station: true,
      } });
    }
  } catch (e) {
    console.warn(`[NEC] ${net} road weather: ${e.message}`);
    if (c) return c.features;
  }
  _ess[code] = { ts: Date.now(), features };
  return features;
}

function routes(app) {
  app.get('/api/nec-cam/:code/:sid.jpg', async (req, res) => {
    const { code, sid } = req.params;
    if (!NETWORKS[code] || !/^[0-9a-f]{12}$/.test(sid)) return res.status(404).end();
    try {
      const img = await snapshot(code, sid);
      if (!img) return res.status(404).send('no picture');
      res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'public, max-age=60').set('Access-Control-Allow-Origin', '*');
      res.send(img);
    } catch (e) { res.status(502).send('upstream error'); }
  });
}

// Rough state boxes for the road layer
const BOXES = { me: [-71.1, 43.0, -66.9, 47.5], nh: [-72.6, 42.7, -70.6, 45.4], vt: [-73.5, 42.7, -71.4, 45.1] };

module.exports = { loadCameras, roadWeather, routes, BOXES, CREDIT, _test: { surfaceCategory, shortId } };
