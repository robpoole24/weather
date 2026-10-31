// CARS 511 feeds (Castle Rock "CARS" program) — New York first; other CARS
// states (Minnesota, Iowa, Kansas, Indiana…) use the same format, so adding one
// is a new line in STATES plus its two Railway variables.
//
//   Road conditions  events API (TMDD/CARS JSON), the state's road-condition
//                    segments → lines on the Winter Road Conditions layer
//   Cameras          CARS-Hub CCTV inventory (XML) → Location Cams
//
// Login: HTTP Basic, from Railway variables only ({ST}_CARS_USER /
// {ST}_CARS_PASSWORD). Never put them in code or URLs.
// Polling: fetched only while someone is looking, then cached — NYSDOT asks
// for no more than once every 5 minutes; we use 10 (roads) and 30 (cameras).
// Nothing here receives or stores anything about viewers.
'use strict';

const UA = 'WeatherTV/1.0 (watchweathertv.com)';

const STATES = [
  { id: 'ny', name: 'New York',
    api: 'https://nysdot.carsprogram.org/carsapi_v1/api/events',
    cctv: 'https://nysdot.carsprogram.org/hub/data/cctv.xml',
    user: 'NY_CARS_USER', pass: 'NY_CARS_PASSWORD',
    // The state's own road-condition reports (the feed also carries roadwork, events, crashes…)
    roadCategory: /road-conditions|winter/i,
    box: [-79.8, 40.5, -71.8, 45.1],
    credit: '511NY · New York State DOT', page: 'https://511ny.org' },
  // CARS Hub states: one FEU-g XML file (events + winter road conditions) and a
  // CCTV inventory each, one shared login (CARS_HUB_USER / CARS_HUB_PASSWORD).
  ...[
    ['in', 'Indiana', 'https://inhub.carsprogram.org/hub/data/', [-88.1, 37.7, -84.7, 41.8], 'INDOT 511', 'https://511in.org'],
    ['ia', 'Iowa', 'https://ia.carsprogram.org/hub/data/', [-96.7, 40.3, -90.1, 43.6], '511 Iowa · Iowa DOT', 'https://www.511ia.org'],
    ['ks', 'Kansas', 'https://ks.carsprogram.org/hub/data/', [-102.1, 36.9, -94.6, 40.1], 'KanDrive · Kansas DOT', 'https://kandrive.org'],
    ['mn', 'Minnesota', 'https://mn.carsprogram.org/hub/data/', [-97.3, 43.4, -89.4, 49.4], '511MN · MnDOT', 'https://511mn.org'],
    ['ne', 'Nebraska', 'https://ne.carsprogram.org/hub/data/', [-104.1, 39.9, -95.3, 43.1], 'Nebraska 511 · NDOT', 'https://new.511.nebraska.gov'],
    // San Diego region (SANDAG), not a state: its cameras join California's list
    ['sandag', 'San Diego (SANDAG)', 'https://sd.carsprogram.org/hub/data/', [-117.7, 32.5, -116.0, 33.6], '511SD · SANDAG', 'https://511sd.com', 'CA'],
  ].map(([id, name, base, box, credit, page, partOf]) => ({
    id, name, hub: true, feu: base + 'feu-g.xml', cctv: base + 'cctv.xml',
    user: 'CARS_HUB_USER', pass: 'CARS_HUB_PASSWORD',
    // Road-condition segments (the seasonal / winter segment events)
    roadCategory: /segment|pavement|winter|road-?condition|surface/i,
    box, credit, page, partOf: partOf || null,
  })),
];
const byId = Object.fromEntries(STATES.map(s => [s.id, s]));

function auth(st) {
  const u = (process.env[st.user] || '').trim(), p = (process.env[st.pass] || '').trim();
  return u && p ? 'Basic ' + Buffer.from(u + ':' + p).toString('base64') : null;
}
const configured = (st) => !!auth(st);

async function get(st, url, { timeout = 45000, accept = 'application/json' } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { Authorization: auth(st), 'User-Agent': UA, Accept: accept }, signal: ctl.signal });
    if (!r.ok) {
      const e = new Error('HTTP ' + r.status + (r.status === 401 ? ' — login refused (check ' + st.user + ' / ' + st.pass + ')' : ''));
      e.status = r.status; throw e;
    }
    return { text: await r.text(), headers: r.headers };
  } finally { clearTimeout(t); }
}

// Every page of the events API (Link: rel="next" until there's none)
async function allEvents(st, query) {
  let url = st.api + '?' + query, out = [];
  for (let page = 0; url && page < 20; page++) {
    const { text, headers } = await get(st, url);
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) throw new Error('events: not a list');
    out = out.concat(rows);
    const next = (headers.get('link') || '').match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    url = next ? next[1].replace(/^http:/, 'https:') : null;   // their Link says http://
  }
  return out;
}

// ── CARS Hub FEU-g (XML) → the same event shape the events API gives ───────────
// One file per state with every event and winter road-condition segment,
// refreshed by the Hub every 30–60 s; we fetch it at most every 5 minutes, only
// while someone is looking, and keep just the fields we use.
const FEU_TTL = 5 * 60 * 1000;
const _feu = new Map();    // id → { ts, rows, loading }
const _t = (xml, name) => { const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`)); return m ? m[1] : ''; };
// Empty means missing — Number('') is 0, which drew lines to 0°N 0°E off Africa
const _deg = (v) => { if (v == null || String(v).trim() === '') return NaN; const n = Number(v); return Number.isFinite(n) ? (Math.abs(n) > 1000 ? n / 1e6 : n) : NaN; };
const _okPt = (p) => p.every(Number.isFinite) && !(Math.abs(p[0]) < 1 && Math.abs(p[1]) < 1) && Math.abs(p[1]) <= 90 && Math.abs(p[0]) <= 180;
// <date>20261030</date><time>134249</time><utc-offset>-0600</utc-offset> → ms
function feuTime(x) {
  const d = _t(x, 'date'), t = _t(x, 'time') || '000000', o = _t(x, 'utc-offset') || '+0000';
  if (!/^\d{8}$/.test(d)) return null;
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.padEnd(6, '0').slice(0, 2)}:${t.padEnd(6, '0').slice(2, 4)}:${t.padEnd(6, '0').slice(4, 6)}${o.slice(0, 3)}:${o.slice(3, 5)}`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
function parseFeu(xml) {
  const out = [];
  const re = /<(?:feu:)?full-event-update\b[^>]*>([\s\S]*?)<\/(?:feu:)?full-event-update>/g;
  let m;
  while ((m = re.exec(xml))) {
    const e = m[1];
    const status = (e.match(/<status>([^<]*)<\/status>/) || [])[1] || '';
    if (/ended|cancel/i.test(status)) continue;
    const expiry = feuTime(_t(_t(e, 'message-header'), 'message-expiry-time'));
    if (expiry && expiry < Date.now()) continue;
    const head = (_t(e, 'headline').match(/<headline>\s*<([\w-]+)>([^<]*)<\//) || []);
    let category = head[1] || '', code = (head[2] || '').trim();
    // A lane or ramp "closure" isn't the road closed
    if (/closure/i.test(category) && !/\bclosed\b/i.test(code)) category = 'lane-restriction';
    if (/closure/i.test(category) && /\blane|shoulder\b/i.test(code)) category = 'lane-restriction';
    const det = _t(e, 'detail');
    const texts = [...det.matchAll(/<additional-text>\s*<description>([\s\S]*?)<\/description>/g)].map(x => unesc(x[1]).replace(/^audio text:\s*/i, '').trim()).filter(Boolean);
    const phrases = [...det.matchAll(/<phrase>\s*<[\w-]+>([^<]*)</g)].map(x => x[1].trim());
    const cause = (_t(det, 'cause').match(/<[\w-]+>([^<]*)</) || [])[1] || '';
    const link = _t(det, 'location-on-link');
    const p1 = _t(_t(link, 'primary-location'), 'geo-location'), p2 = _t(_t(link, 'secondary-location'), 'geo-location');
    const a = [_deg(_t(p1, 'longitude')), _deg(_t(p1, 'latitude'))], b = [_deg(_t(p2, 'longitude')), _deg(_t(p2, 'latitude'))];
    if (!_okPt(a)) continue;
    // A segment needs a real second point, and a road segment is never hundreds of miles long
    const geometry = _okPt(b) && (a[0] !== b[0] || a[1] !== b[1]) && Math.abs(a[0] - b[0]) < 3 && Math.abs(a[1] - b[1]) < 3
      ? { type: 'LineString', coordinates: [a, b] } : { type: 'Point', coordinates: a };
    const times = _t(det, 'times');
    const start = feuTime(_t(times, 'start-time')), end = feuTime(_t(times, 'end-time')), upd = feuTime(_t(times, 'update-time'));
    const route = unesc(_t(link, 'route-designator'));
    const cross = unesc(_t(link, 'cross-street-name-item'));
    const extra = phrases.filter(x => x && x !== code).join(', ');
    out.push({
      'event-id': _t(_t(e, 'event-reference'), 'event-id'),
      headline: { category, code },
      priority: Number((e.match(/<priority>(\d+)<\/priority>/) || [])[1]) || null,
      description: [extra && extra.charAt(0).toUpperCase() + extra.slice(1), cause && 'Cause: ' + cause, ...texts, cross && 'Near ' + cross].filter(Boolean).join('. ').slice(0, 600),
      'update-time': upd ? { time: upd } : null,
      details: [{ locations: [{ 'route-designator': route, 'primary-location': { 'geo-location': { latitude: a[1], longitude: a[0] } },
        'segment-names': texts.filter(x => /^segment name/i.test(x)).map(x => x.replace(/^segment name:\s*/i, '')) }],
        'start-time': start ? { time: start } : null, 'end-time': end ? { time: end } : null,
        'update-time': upd ? { time: upd } : null }],
      geometry,
    });
  }
  return out;
}
function feuEvents(st) {
  const c = _feu.get(st.id);
  if (c && Date.now() - c.ts < FEU_TTL) return Promise.resolve(c.rows);
  if (c && c.loading) return c.loading;
  const loading = get(st, st.feu, { accept: 'application/xml, text/xml, */*', timeout: 90000 })
    .then(({ text }) => {
      const rows = parseFeu(text);
      stat(st.id, 'feed', { bytes: text.length, events: rows.length,
        categories: rows.reduce((m, r) => (m[r.headline.category] = (m[r.headline.category] || 0) + 1, m), {}) });
      _feu.set(st.id, { ts: Date.now(), rows });
      return rows;
    })
    .catch(e => {
      stat(st.id, 'feed', { error: e.message });
      const old = (c && c.rows) || [];
      _feu.set(st.id, { ts: Date.now() - FEU_TTL + 2 * 60 * 1000, rows: old });   // retry in 2 min
      throw e;
    });
  _feu.set(st.id, { ...(c || { ts: 0, rows: [] }), loading });
  return loading;
}

const stats = {};    // state → { roads: {...}, cameras: {...} }
const stat = (id, kind, v) => { (stats[id] = stats[id] || {})[kind] = { ...v, at: new Date().toISOString() }; };

// ── Road conditions ──────────────────────────────────────────────────────────
const ROAD_TTL = 10 * 60 * 1000;
const _roads = new Map();   // id → { ts, features, loading }

function eventToRoad(e, st, roadCategory) {
  const g = e.geometry;
  if (!g || !/LineString/.test(g.type) || !Array.isArray(g.coordinates)) return null;
  const det = (e.details || [])[0] || {};
  const loc = (det.locations || [])[0] || {};
  const code = (e.headline && e.headline.code) || '';
  // The code is the condition ("snow covered", "no active reporting"…); the
  // description also holds place names, so it's only a fallback
  const cat = roadCategory(code || e.description || '');
  const t = (e['update-time'] && e['update-time'].time) || (det['update-time'] && det['update-time'].time);
  const between = String(e.description || '').match(/\bbetween\b(.+?)(?:\.|$)/i);
  return {
    type: 'Feature', geometry: { type: g.type, coordinates: g.coordinates },
    properties: {
      cat, condition: code ? code.charAt(0).toUpperCase() + code.slice(1) : '', surface: '',
      road: loc['route-designator'] || '',
      where: (loc['segment-names'] && loc['segment-names'][0]) || (between ? 'Between' + between[1] : ''),
      updated: t ? new Date(t).toISOString() : null, src: st.id,
    },
  };
}

async function loadRoads(st, roadCategory) {
  // eventClassifications=winterDriving (from NYSDOT's migration guide) keeps the
  // download small; if it's ever ignored we still keep only road conditions
  const rows = st.hub ? await feuEvents(st) : await allEvents(st, 'eventClassifications=winterDriving&limit=500');
  const features = [];
  for (const e of rows) {
    if (!st.roadCategory.test((e.headline && e.headline.category) || '')) continue;
    const f = eventToRoad(e, st, roadCategory);
    if (f) features.push(f);
  }
  stat(st.id, 'roads', { events: rows.length, segments: features.length,
    conditions: features.reduce((m, f) => (m[f.properties.condition] = (m[f.properties.condition] || 0) + 1, m), {}) });
  return features;
}

// roadCategory (good / wet / slippery / snow / ice / closed / unknown) comes from winter.js
function roads(id, roadCategory) {
  const st = byId[id];
  if (!st || !configured(st)) return Promise.resolve([]);
  const c = _roads.get(id);
  if (c && Date.now() - c.ts < ROAD_TTL) return Promise.resolve(c.features);
  if (c && c.loading) return c.loading;
  const loading = loadRoads(st, roadCategory)
    .then(features => { _roads.set(id, { ts: Date.now(), features }); return features; })
    .catch(e => {
      stat(id, 'roads', { error: e.message });
      console.warn(`[CARS ${id}] road conditions: ${e.message}`);
      const old = (c && c.features) || [];
      _roads.set(id, { ts: Date.now() - ROAD_TTL + 2 * 60 * 1000, features: old });   // retry in 2 min
      return old;
    });
  _roads.set(id, { ...(c || { ts: 0, features: [] }), loading });
  return loading;
}

// ── Cameras (CARS-Hub CCTV inventory) ────────────────────────────────────────
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`)); return m ? m[1].trim() : ''; };
const blocks = (xml, name) => xml.match(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?</${name}>`, 'g')) || [];
const unesc = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');
// Hub coordinates are millionths of a degree (40890088 → 40.890088)
const deg = (v) => { const n = Number(v); return !Number.isFinite(n) ? NaN : Math.abs(n) > 1000 ? n / 1e6 : n; };

function parseCctv(xml, st) {
  const out = [], seen = new Set();
  for (const inv of blocks(xml, 'cctvInventory')) {
    const owner = unesc(tag(tag(inv, 'owner'), 'organization-name'));
    for (const b of blocks(inv, 'inventory-item')) {
      const id = tag(b, 'device-id');
      const lat = deg(tag(b, 'latitude')), lng = deg(tag(b, 'longitude'));
      if (!id || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      if (Math.abs(lat) < 1 && Math.abs(lng) < 1) continue;          // portable cameras without a position report 0,0
      const key = owner + ':' + id;
      if (seen.has(key)) continue; seen.add(key);
      const img = unesc(tag(tag(b, 'still-image'), 'url'));
      const video = unesc(tag(b, 'video-url'));
      if (!img && !video) continue;
      out.push({
        id: `${st.id}-${(owner || 'x').replace(/\W+/g, '').toLowerCase()}-${id}`,
        name: unesc(tag(b, 'device-name')) || unesc(tag(b, 'route-designator')) || 'Traffic Camera',
        lat, lng,
        imageUrl: /^https?:\/\//.test(img) ? img : null,
        videoUrl: /^https?:\/\//.test(video) ? video : null,
        direction: null,
        source: st.id,
        provider: owner && !/^NYSDOT$/i.test(owner) ? `${st.credit} · ${owner}` : st.credit,
        pageUrl: st.page,
      });
    }
  }
  return out;
}

async function loadCameras(id) {
  const st = byId[id];
  if (!st || !st.cctv || !configured(st)) return [];
  try {
    const { text } = await get(st, st.cctv, { accept: 'application/xml, text/xml, */*', timeout: 60000 });
    const cams = parseCctv(text, st);
    stat(id, 'cameras', { count: cams.length, withVideo: cams.filter(c => c.videoUrl).length });
    return cams;
  } catch (e) {
    stat(id, 'cameras', { error: e.message });
    throw e;
  }
}

// ── Road closures & weather hazards ──────────────────────────────────────────
// From the full events feed: anything weather-caused (flooding, snow, downed
// lines, storm damage, slides, fires…) plus roads that are closed right now.
// Roadwork that isn't a closure, crashes, sports and concerts are left out.
const HAZ_TTL = 5 * 60 * 1000;      // NYSDOT's recommended polling rate
const _haz = new Map();             // id → { ts, items, loading }
const WEATHER_KINDS = [
  ['flood',  /\bflood(s|ed|ing)?\b|\bhigh water\b|\bwater over (the )?road|\bwash(ed)? ?out\b/i],
  ['snow',   /\bsnow\b|\bheavy snow\b|\bice\b|\bicy\b|\bsleet\b|\bfreezing rain\b|\bblack ice\b|\bwhite ?out\b|\bblowing snow\b|\bwinter storm\b/i],
  ['wind',   /\bdowned (power )?(lines?|wires?|trees?)\b|\b(wires?|lines?|trees?) down\b|\bfallen trees?\b|\bstorm damage\b|\bhigh winds?\b|\bwind damage\b|\bhurricane\b|\btornado\b/i],
  ['slide',  /\b(land|mud|rock) ?slides?\b|\brockfall\b|\bsinkhole\b|\broad surface collapse\b|\bavalanche\b/i],
  ['fire',   /\bbrush fire\b|\bforest fire\b|\bwild ?fire\b/i],
  ['fog',    /\bdense fog\b|\bfog\b|\blow visibility\b/i],
  ['weather',/\badverse weather\b|\bsevere weather\b|\bweather (related|conditions)\b|\bearthquake damage\b/i],
];
// Roadwork, events and the like only count if their own code says weather
// (their descriptions mention streets like "Rice Rd" and "weather permitting")
const PLANNED = /roadwork|construction|special-event|sporting-event|phrases/i;
// What kind of weather hazard a piece of text describes (null = none)
function weatherKind(text) {
  const t = String(text || '').replace(/weather[- ]permit\w*/gi, '');
  return (WEATHER_KINDS.find(([, re]) => re.test(t)) || [])[0] || null;
}
const ms = (t) => (t && Number.isFinite(t.time) ? t.time : null);

function eventToHazard(e, st, now) {
  const det = (e.details || [])[0] || {};
  const head = e.headline || {}, code = String(head.code || ''), cat = String(head.category || '');
  // "This work is weather permitting" is in lots of roadwork notes: not a hazard
  const kind = weatherKind(PLANNED.test(cat) ? code : code + ' ' + String(e.description || ''));
  const closed = /closure/i.test(cat) || /^(road )?closed$/i.test(code);
  if (!kind && !closed) return null;
  if (st.roadCategory.test(cat)) return null;            // road-condition segments live on the roads layer
  const start = ms(det['start-time']), end = ms(det['end-time']);
  if (start && start > now + 15 * 60 * 1000) return null; // planned, hasn't started
  if (end && end < now) return null;                      // already over
  const loc = (det.locations || [])[0] || {};
  const geo = (loc['primary-location'] || {})['geo-location'] || {};
  let lat = Number(geo.latitude), lng = Number(geo.longitude);
  const g = e.geometry || {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const c = g.type === 'Point' ? g.coordinates : Array.isArray(g.coordinates) ? g.coordinates[0] : null;
    if (c) { lng = Number(c[0]); lat = Number(c[1]); }
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (Math.abs(lat) < 1 && Math.abs(lng) < 1)) return null;
  const line = g.type === 'LineString' && Array.isArray(g.coordinates) && g.coordinates.length > 1
    ? g.coordinates.filter((_, i, a) => a.length < 400 || i % Math.ceil(a.length / 400) === 0).map(([x, y]) => [+(+y).toFixed(5), +(+x).toFixed(5)]) : null;
  return {
    id: e['event-id'], kind: kind || 'closure', closed,
    title: code ? code.charAt(0).toUpperCase() + code.slice(1) : (closed ? 'Road closed' : 'Hazard'),
    road: loc['route-designator'] || '', text: String(e.description || '').slice(0, 600),
    lat: +lat.toFixed(5), lng: +lng.toFixed(5), line,
    start: start ? new Date(start).toISOString() : null, end: end && end < now + 5 * 365 * 864e5 ? new Date(end).toISOString() : null,
    updated: ms(e['update-time']) ? new Date(ms(e['update-time'])).toISOString() : null,
    priority: e.priority || null, src: st.id, credit: st.credit,
  };
}

async function loadHazards(st) {
  const rows = st.hub ? await feuEvents(st) : await allEvents(st, 'limit=500');
  const now = Date.now(), items = [];
  for (const e of rows) { const h = eventToHazard(e, st, now); if (h) items.push(h); }
  stat(st.id, 'hazards', { events: rows.length, shown: items.length,
    kinds: items.reduce((m, h) => (m[h.kind] = (m[h.kind] || 0) + 1, m), {}) });
  return items;
}
function hazards(id) {
  const st = byId[id];
  if (!st || !configured(st)) return Promise.resolve([]);
  const c = _haz.get(id);
  if (c && Date.now() - c.ts < HAZ_TTL) return Promise.resolve(c.items);
  if (c && c.loading) return c.loading;
  const loading = loadHazards(st)
    .then(items => { _haz.set(id, { ts: Date.now(), items }); return items; })
    .catch(e => {
      stat(id, 'hazards', { error: e.message });
      console.warn(`[CARS ${id}] hazards: ${e.message}`);
      const old = (c && c.items) || [];
      _haz.set(id, { ts: Date.now() - HAZ_TTL + 2 * 60 * 1000, items: old });
      return old;
    });
  _haz.set(id, { ...(c || { ts: 0, items: [] }), loading });
  return loading;
}

function routes(app) {
  // Admin: what each CARS state last returned (never shows the login)
  app.get('/api/admin/cars', (req, res) => {
    res.json(STATES.map(s => ({ id: s.id, name: s.name, configured: configured(s), ...(stats[s.id] || {}) })));
  });
}

module.exports = { STATES, configured: (id) => !!byId[id] && configured(byId[id]), roads, loadCameras, hazards, routes, weatherKind, PLANNED,
  _test: { parseCctv, eventToRoad, eventToHazard, deg, parseFeu, feuTime } };
