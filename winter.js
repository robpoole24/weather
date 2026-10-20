// WeatherTV — seasonal server features
//
//   Road conditions  /api/roads?bbox=w,s,e,n
//     State 511 "winter road conditions" (IBI/Skyline platform, the same
//     {STATE}_511_KEY variables the cameras use) plus Road511's normalised
//     road_conditions feed (ROAD511_API_KEY). Fetched only for states the map
//     is looking at, cached 10 min, so the 511 limits (10 calls/min) hold.
//
//   Fall colors      /api/foliage/status · /api/foliage/data?frame=…
//     Explore Fall's foliage KMLs (free with credit + link to ExploreFall.com),
//     read from their public Google Drive folder with GOOGLE_DRIVE_API_KEY,
//     converted to GeoJSON twice a day during the season. An admin switch
//     (/api/admin/foliage) turns the layer off for everyone if they ask us to.
//
// Nothing here receives or stores anything about viewers.
'use strict';
const zlib = require('zlib');

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
  for (const v of ['v2', 'v3']) {
    try {
      const txt = await getText(`${st.base}/api/${v}/get/winterroads?key=${encodeURIComponent(key)}&format=json`);
      const rows = JSON.parse(txt);
      const list = Array.isArray(rows) ? rows : (rows.WinterRoads || rows.winterRoads || rows.data || []);
      const features = [];
      for (const r of list) {
        const poly = Array.isArray(r.EncodedPolyline) ? r.EncodedPolyline.join('') : r.EncodedPolyline;
        const coords = decodePolyline(poly);
        if (coords.length < 2) continue;
        const cond = r['Overall Condition'] || r.OverallCondition || r['Overall-Condition'] || r.Condition || '';
        const surface = r.RoadSurface || r.SurfaceCondition || '';
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

// Road511 (normalised feed across many states). Cached per 2° cell.
const _r511Cache = new Map();
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
    if (!c || Date.now() - c.ts > ROAD_TTL) {
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
        _roadStats.road511 = { count: (_roadStats.road511?.count || 0) + feats.length, at: new Date().toISOString() };
      } catch (err) {
        c = { ts: Date.now(), features: [] };
        _roadStats.road511 = { error: err.message, at: new Date().toISOString() };
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
// Fall colors (Explore Fall KML)
// ════════════════════════════════════════════════════════════════════════════
const FOLIAGE_FOLDER = process.env.FOLIAGE_DRIVE_FOLDER || '1c7tbG7arTIBLkDXM8F-ZTUchG4oHOyvU';
const FOLIAGE_FLAG = 'wt:flag:foliage';
const FOLIAGE_CACHE = 'wt:foliage:v1';
let foliage = { frames: [], updated: null, checked: null, error: null, files: [] };
let foliageEnabled = true;

function inFallSeason(d = new Date()) {
  const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  return md >= 901 && md <= 1130;
}

// Minimal .zip reader for KMZ (central directory + deflate)
function unzip(buf) {
  const files = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26), lxlen = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
    files[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    p += 46 + nlen + xlen + clen;
  }
  return files;
}

const tagText = (xml, tag) => { const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`)); return m ? m[1].trim() : ''; };
const allBlocks = (xml, tag) => xml.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>[\\s\\S]*?</(?:\\w+:)?${tag}>`, 'g')) || [];
const unCdata = s => String(s || '').replace(/^<!\[CDATA\[|\]\]>$/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

// KML colour is aabbggrr
function kmlColor(c) {
  const m = String(c || '').trim().match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  return { hex: '#' + m[4] + m[3] + m[2], alpha: parseInt(m[1], 16) / 255 };
}

// Douglas–Peucker for very detailed outlines (keeps payloads small for phones/TVs)
function simplify(pts, tol) {
  if (pts.length <= 4) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0, idx = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function parseCoords(s) {
  const pts = [];
  for (const t of String(s).trim().split(/\s+/)) {
    const [x, y] = t.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push([+x.toFixed(4), +y.toFixed(4)]);
  }
  return pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
}

function parseKml(xml, images) {
  // Styles (and StyleMaps pointing at a "normal" style)
  const styles = {};
  for (const b of allBlocks(xml, 'Style')) {
    const id = (b.match(/\bid="([^"]+)"/) || [])[1]; if (!id) continue;
    const poly = tagText(b, 'PolyStyle'), line = tagText(b, 'LineStyle');
    const fill = kmlColor(tagText(poly, 'color')) || kmlColor(tagText(line, 'color'));
    const noFill = tagText(poly, 'fill') === '0';
    styles['#' + id] = { fill: noFill ? null : fill, line: kmlColor(tagText(line, 'color')) };
  }
  for (const b of allBlocks(xml, 'StyleMap')) {
    const id = (b.match(/\bid="([^"]+)"/) || [])[1]; if (!id) continue;
    const pairs = allBlocks(b, 'Pair');
    const normal = pairs.find(p => /normal/.test(tagText(p, 'key'))) || pairs[0];
    if (normal) styles['#' + id] = styles[tagText(normal, 'styleUrl')] || styles['#' + id];
  }

  const placemarkToFeatures = (pm) => {
    const name = unCdata(tagText(pm, 'name'));
    const styleUrl = tagText(pm, 'styleUrl');
    const inline = tagText(pm, 'Style');
    let st = styles[styleUrl] || {};
    if (inline) { const f = kmlColor(tagText(tagText(inline, 'PolyStyle'), 'color')); if (f) st = { ...st, fill: f }; }
    const ext = {};
    for (const d of allBlocks(pm, 'Data')) { const k = (d.match(/name="([^"]+)"/) || [])[1]; if (k) ext[k] = unCdata(tagText(d, 'value')); }
    for (const d of allBlocks(pm, 'SimpleData')) { const k = (d.match(/name="([^"]+)"/) || [])[1]; if (k) ext[k] = unCdata(d.replace(/<[^>]+>/g, '')); }
    const props = { name, style: styleUrl.replace(/^#/, ''), color: st.fill?.hex || st.line?.hex || '#888888',
      opacity: st.fill ? Math.max(0.35, Math.min(0.85, st.fill.alpha || 0.6)) : 0.6, ...ext };
    const out = [];
    for (const poly of allBlocks(pm, 'Polygon')) {
      const outer = parseCoords(tagText(tagText(poly, 'outerBoundaryIs'), 'coordinates'));
      if (outer.length < 4) continue;
      const tol = outer.length > 400 ? 0.01 : 0.003;
      const rings = [simplify(outer, tol)];
      for (const ib of allBlocks(poly, 'innerBoundaryIs')) {
        const r = parseCoords(tagText(ib, 'coordinates'));
        if (r.length >= 4) rings.push(simplify(r, tol));
      }
      out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: rings }, properties: props });
    }
    return out;
  };

  // Frames: top-level Folders (e.g. one per forecast day), else the whole document
  const doc = tagText(xml, 'Document') || xml;
  let folders = [];
  const folderRe = /<(?:\w+:)?Folder\b[^>]*>/g;
  // Only folders that directly contain placemarks count as frames
  const blocks = allBlocks(doc, 'Folder').filter(f => /<(?:\w+:)?Placemark\b/.test(f));
  const leaf = blocks.filter(f => (f.match(folderRe) || []).length === 1);
  for (const f of (leaf.length ? leaf : blocks)) {
    const feats = allBlocks(f, 'Placemark').flatMap(placemarkToFeatures);
    if (feats.length) folders.push({ name: unCdata(tagText(f, 'name')) || 'Map', features: feats });
  }
  if (!folders.length) {
    const feats = allBlocks(doc, 'Placemark').flatMap(placemarkToFeatures);
    if (feats.length) folders.push({ name: unCdata(tagText(doc, 'name')) || 'Map', features: feats });
  }

  // Image overlays (some KMLs are a picture laid over the map)
  const overlays = [];
  for (const g of allBlocks(xml, 'GroundOverlay')) {
    const href = tagText(tagText(g, 'Icon'), 'href');
    const box = tagText(g, 'LatLonBox');
    const n = +tagText(box, 'north'), s = +tagText(box, 'south'), e = +tagText(box, 'east'), w = +tagText(box, 'west');
    if (!href || ![n, s, e, w].every(Number.isFinite)) continue;
    const img = images && (images[href] || images[href.replace(/^\.\//, '')]);
    overlays.push({ name: unCdata(tagText(g, 'name')) || 'Map', bounds: [[s, w], [n, e]], href, image: img ? img.toString('base64') : null,
      type: /\.jpe?g$/i.test(href) ? 'image/jpeg' : 'image/png' });
  }
  return { folders, overlays };
}

// Legend from the colours actually used
function legendFor(features) {
  const seen = new Map();
  for (const f of features) {
    const p = f.properties;
    const label = p.name || p.Category || p.category || p.style || '';
    const k = p.color + '|' + label;
    if (!seen.has(k)) seen.set(k, { color: p.color, label });
  }
  const list = [...seen.values()];
  return list.length > 14 ? [] : list;
}

const _frameImages = {};   // frame id → { buf, type }

async function refreshFoliage(force = false) {
  const key = process.env.GOOGLE_DRIVE_API_KEY;
  foliage.checked = new Date().toISOString();
  if (!key) { foliage.error = 'GOOGLE_DRIVE_API_KEY is not set'; return foliage; }
  if (!force && !inFallSeason()) return foliage;
  try {
    const list = async (folder) => {
      const q = encodeURIComponent(`'${folder}' in parents and trashed = false`);
      const j = JSON.parse(await getText(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&pageSize=100&fields=files(id,name,mimeType,modifiedTime)&key=${encodeURIComponent(key)}`));
      return j.files || [];
    };
    let files = await list(FOLIAGE_FOLDER);
    // Newest sub-folder (e.g. one per update) if the files aren't at the top
    const isMap = f => /\.km[lz]$/i.test(f.name) || /kml|kmz|google-earth/i.test(f.mimeType);
    if (!files.some(isMap)) {
      const sub = files.find(f => f.mimeType === 'application/vnd.google-apps.folder');
      if (sub) files = await list(sub.id);
    }
    const maps = files.filter(isMap).sort((a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime));
    if (!maps.length) throw new Error('no KML/KMZ files found in the shared folder');
    // Newest "forecast" file and newest other ("current") file
    const forecast = maps.find(f => /forecast|predict|future|outlook/i.test(f.name));
    const current = maps.find(f => f !== forecast && !/forecast|predict|future|outlook/i.test(f.name)) || (forecast ? null : maps[0]);
    const pick = [current && { kind: 'now', f: current }, forecast && { kind: 'forecast', f: forecast }].filter(Boolean);

    const frames = [];
    for (const { kind, f } of pick) {
      const buf = await getText(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&key=${encodeURIComponent(key)}`, { buffer: true, timeout: 60000 });
      let xml, images = null;
      if (buf[0] === 0x50 && buf[1] === 0x4b) {           // KMZ (zip)
        const z = unzip(buf);
        const kmlName = Object.keys(z).find(n => /\.kml$/i.test(n));
        if (!kmlName) throw new Error(f.name + ': no .kml inside');
        xml = z[kmlName].toString('utf8');
        images = z;
      } else xml = buf.toString('utf8');
      const parsed = parseKml(xml, images);
      parsed.folders.forEach((fo, i) => {
        frames.push({ id: `${kind}-${i}`, kind, label: kind === 'now' ? (parsed.folders.length > 1 ? fo.name : 'Now') : (fo.name || 'Forecast'),
          file: f.name, updated: f.modifiedTime, legend: legendFor(fo.features),
          data: { type: 'FeatureCollection', features: fo.features } });
      });
      parsed.overlays.forEach((o, i) => {
        const id = `${kind}-img-${i}`;
        if (o.image) _frameImages[id] = { buf: Buffer.from(o.image, 'base64'), type: o.type };
        frames.push({ id, kind, label: kind === 'now' ? 'Now' : (o.name || 'Forecast'), file: f.name, updated: f.modifiedTime,
          image: { bounds: o.bounds, url: o.image ? `/api/foliage/image/${id}` : (/^https:\/\//.test(o.href) ? o.href : null) }, legend: [] });
      });
    }
    if (!frames.length) throw new Error('the KML files had no map shapes');
    foliage = { frames, updated: maps[0].modifiedTime, checked: foliage.checked, error: null,
      files: pick.map(p => ({ kind: p.kind, name: p.f.name, modified: p.f.modifiedTime })) };
    if (redis) {
      const imgs = Object.fromEntries(Object.entries(_frameImages).map(([k, v]) => [k, { b64: v.buf.toString('base64'), type: v.type }]));
      redis.set(FOLIAGE_CACHE, JSON.stringify({ foliage, imgs }), 'EX', 14 * 86400).catch(() => {});
    }
    console.log(`[Foliage] ${frames.length} frame(s) from ${pick.map(p => p.f.name).join(', ')}`);
  } catch (e) {
    foliage.error = e.message;
    console.warn('[Foliage]', e.message);
  }
  return foliage;
}

function foliageStatus() {
  return {
    enabled: foliageEnabled,
    inSeason: inFallSeason(),
    available: foliageEnabled && foliage.frames.length > 0,
    updated: foliage.updated,
    frames: foliageEnabled ? foliage.frames.map(f => ({ id: f.id, kind: f.kind, label: f.label, legend: f.legend, image: f.image || null })) : [],
    credit: { text: 'Fall foliage data: Explore Fall', url: 'https://www.explorefall.com' },
  };
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
      const parts = await Promise.all([...states.map(ibiState), road511(b)]);
      const seen = new Set(), features = [];
      for (const f of parts.flat()) {
        if (!lineInBox(f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.flat() : f.geometry.coordinates, b)) continue;
        const c = f.geometry.coordinates, k = JSON.stringify(c[0]) + JSON.stringify(c[c.length - 1]);
        if (seen.has(k)) continue; seen.add(k);
        features.push(f);
        if (features.length >= 4000) break;
      }
      res.set('Cache-Control', 'public, max-age=300');
      res.json({ type: 'FeatureCollection', features, sources: states.map(s => s.id).concat(process.env.ROAD511_API_KEY ? ['road511'] : []) });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });
  app.get('/api/admin/roads', (req, res) => {
    res.json({ states: ROAD_STATES.map(s => ({ id: s.id, key: !!process.env[s.env], ...(_roadStats[s.id] || {}) })),
      road511: { key: !!process.env.ROAD511_API_KEY, ...(_roadStats.road511 || {}) } });
  });

  // ── Fall colors ──
  app.get('/api/foliage/status', (req, res) => {
    res.set('Cache-Control', 'public, max-age=600');
    res.json(foliageStatus());
  });
  app.get('/api/foliage/data', (req, res) => {
    if (!foliageEnabled) return res.status(404).json({ error: 'off' });
    const fr = foliage.frames.find(f => f.id === req.query.frame) || foliage.frames[0];
    if (!fr || !fr.data) return res.status(404).json({ error: 'no data' });
    res.set('Cache-Control', 'public, max-age=1800');
    res.json(fr.data);
  });
  app.get('/api/foliage/image/:id', (req, res) => {
    const img = foliageEnabled && _frameImages[req.params.id];
    if (!img) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=1800').type(img.type).send(img.buf);
  });
  // Admin: on/off switch + status (under /api/admin, so it needs the admin login)
  app.get('/api/admin/foliage', (req, res) => {
    res.json({ enabled: foliageEnabled, inSeason: inFallSeason(), keySet: !!process.env.GOOGLE_DRIVE_API_KEY,
      frames: foliage.frames.length, files: foliage.files, updated: foliage.updated, checked: foliage.checked, error: foliage.error });
  });
  app.post('/api/admin/foliage', async (req, res) => {
    const body = req.body || {};
    if (typeof body.enabled === 'boolean') {
      foliageEnabled = body.enabled;
      if (redis) await redis.set(FOLIAGE_FLAG, foliageEnabled ? 'on' : 'off').catch(() => {});
    }
    if (body.refresh) await refreshFoliage(true);
    res.json({ enabled: foliageEnabled, frames: foliage.frames.length, files: foliage.files, error: foliage.error, updated: foliage.updated });
  });
}

async function init(redisClient) {
  redis = redisClient || null;
  if (redis) {
    try { foliageEnabled = (await redis.get(FOLIAGE_FLAG)) !== 'off'; } catch (_) {}
    try {
      const saved = JSON.parse((await redis.get(FOLIAGE_CACHE)) || 'null');
      if (saved && saved.foliage) {
        foliage = saved.foliage;
        for (const [k, v] of Object.entries(saved.imgs || {})) _frameImages[k] = { buf: Buffer.from(v.b64, 'base64'), type: v.type };
      }
    } catch (_) {}
  }
  // Explore Fall updates Mondays & Thursdays: checking every 6 hours is plenty
  setTimeout(() => refreshFoliage(false), 60 * 1000).unref();
  setInterval(() => refreshFoliage(false), 6 * 3600 * 1000).unref();
}

module.exports = { routes, init, _test: { decodePolyline, roadCategory, parseKml, unzip, legendFor, simplify } };
