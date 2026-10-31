// WeatherTV — extra road-closure sources for the Road Closures & Weather Hazards layer
//
//  • WZDx work-zone feeds (the U.S. DOT standard): the public, key-free feeds
//    listed in the national WZDx feed registry (datahub.transportation.gov).
//    Feeds that need a key or token are only used if their full address is set
//    in a Railway variable (see OPTIONAL below) — never written into the code.
//  • Caltrans Lane Closure System (cwwp2.dot.ca.gov), all 12 districts — no key.
//
// Only closures that shut the road (all lanes / "Full" / ramp) and are in effect
// NOW. Each source is fetched only while its area is on screen, at most every
// 10 minutes; the caller merges duplicates of closures other feeds already show.
'use strict';

const UA = 'WeatherTV/1.0 (watchweathertv.com)';
const TTL = 10 * 60 * 1000;
const MAX_BYTES = 40 * 1024 * 1024;

// [id, name, url, state code(s) whose box it covers]
const PUBLIC = [
  ['ut', 'Utah DOT', 'https://udottraffic.utah.gov/wzdx/udot/v40/data', ['UT']],
  ['ia', 'Iowa DOT', 'https://iowa-atms.cloud-q-free.com/api/rest/dataprism/wzdx/wzdxfeed', ['IA']],
  ['mn', 'Minnesota DOT', 'https://mn.carsprogram.org/carsapi_v1/api/wzdx', ['MN']],
  ['md', 'Maryland DOT', 'https://filter.ritis.org/wzdx_v4.1/mdot.geojson', ['MD']],
  ['mo', 'Missouri DOT', 'https://traveler.modot.org/timconfig/feed/desktop/mo_wzdx.json', ['MO']],
  ['mo-scc', 'St. Charles County MO', 'https://scc.ridsi-dash.com:5000/wzdx.geojson', ['MO']],
  ['wi', 'Wisconsin DOT', 'https://511wi.gov/api/wzdx', ['WI']],
  ['az-mc', 'Maricopa County DOT', 'https://wzdxapi.aztech.org/construction', ['AZ']],
  ['nm', 'New Mexico DOT', 'https://ai.blyncsy.io/wzdx/nmdot/feed', ['NM']],
  ['hi', 'Hawaii DOT', 'https://ai.blyncsy.io/wzdx/hidot/feed', ['HI']],
  ['ny', 'New York DOT', 'https://511ny.org/api/wzdx', ['NY']],
  ['wa', 'Washington State DOT', 'https://wzdx.wsdot.wa.gov/api/v4/WorkZoneFeed', ['WA']],
  ['nj', 'New Jersey (NJIT)', 'https://smartworkzones.njit.edu/nj/wzdx', ['NJ']],
  ['ky', 'Kentucky Transportation Cabinet', 'https://storage.googleapis.com/kytc-its-2020-openrecords/public/feeds/WZDx/kytc_wzdx_v4.1.geojson', ['KY']],
  ['ks', 'Kansas DOT', 'https://ks.carsprogram.org/carsapi_v1/api/wzdx', ['KS']],
  ['tx-austin', 'City of Austin', 'https://data.austintexas.gov/download/d9mm-cjw9', ['TX']],
  ['de', 'Delaware DOT', 'https://wzdx.e-dot.com/del_dot_feed_wzdx_v4.1.geojson', ['DE']],
  ['la', 'Louisiana DOTD', 'https://wzdx.e-dot.com/la_dot_d_feed_wzdx_v4.1.geojson', ['LA']],
  ['id', 'Idaho DOT', 'https://511.idaho.gov/api/wzdx', ['ID']],
  ['in', 'Indiana DOT', 'https://in.carsprogram.org/carsapi_v1/api/wzdx', ['IN']],
  ['nec', 'New England Compass (NH/VT/ME)', 'https://api.dx.ne-compass.com/wzdx-latest/', ['NH', 'VT', 'ME']],
  ['ms', 'Mississippi DOT', 'https://api.mdottraffic.com/prod/v3/data/wzdx', ['MS']],
  ['nd', 'North Dakota DOT', 'https://travelfiles.dot.nd.gov/geojson_nc/wzdx_geojson.json', ['ND']],
];
// Feeds whose address carries a key or token: used only when the whole
// address is set in the named Railway variable.
const OPTIONAL = [
  ['ok', 'Oklahoma DOT', 'OK_WZDX_URL', ['OK']],
  ['fl', 'Florida DOT', 'FL_WZDX_URL', ['FL']],
  ['co', 'Colorado DOT', 'CO_WZDX_URL', ['CO']],
  ['tx', 'Texas DOT', 'TX_WZDX_URL', ['TX']],
  ['oh', 'Ohio DOT', 'OH_WZDX_URL', ['OH']],

  ['nc', 'North Carolina DOT', 'NC_WZDX_URL', ['NC']],
];
// Same platform as a 511 key we already hold: build the address from that key
// For these, the *_WZDX_URL variable may hold just the key instead of the full address.
const KEY_ONLY = {
  CO_WZDX_URL: (k) => 'https://data.cotrip.org/api/v1/wzdx?apiKey=' + encodeURIComponent(k),
  TX_WZDX_URL: (k) => 'https://api.drivetexas.org/api/conditions.wzdx.geojson?key=' + encodeURIComponent(k),
};
const FROM_511_KEY = {
  NC_WZDX_URL: ['NC_511_KEY', (k) => 'https://www.drivenc.gov/api/wzdx?key=' + encodeURIComponent(k)],
  OH_WZDX_URL: ['OH_DOT_KEY', (k) => 'https://publicapi.ohgo.com/api/work-zones/wzdx/4.2?api-key=' + encodeURIComponent(k)],
};
// Feeds whose key goes in a request header: [id, name, url, key variable, header, states]
const HEADER_KEYED = [
  ['or', 'Oregon DOT', 'https://api.odot.state.or.us/WZDx/v4.0/Workzones', 'ODOT_API_KEY', 'Ocp-Apim-Subscription-Key', ['OR']],
];
function wzdxSources() {
  const urlFor = (env) => {
    const direct = (process.env[env] || '').trim().replace(/^['"<\s]+|['">\s]+$/g, '');
    if (/^https?:\/\//i.test(direct)) return direct.replace(/\s+/g, '');
    // A bare key in the variable: build the feed address around it.
    if (direct && KEY_ONLY[env]) return KEY_ONLY[env](direct);
    if (direct) return null;
    const alt = FROM_511_KEY[env], key = alt && (process.env[alt[0]] || '').trim();
    return key ? alt[1](key) : null;
  };
  return PUBLIC.map(([id, name, url, states]) => ({ id, name, url, states }))
    .concat(OPTIONAL.map(([id, name, env, states]) => ({ id, name, url: urlFor(env), states })).filter(s => s.url))
    .concat(HEADER_KEYED.filter(([, , , env]) => (process.env[env] || '').trim())
      .map(([id, name, url, env, header, states]) => ({ id, name, url, states, headers: { [header]: process.env[env].trim() } })));
}

// Caltrans districts and rough boxes [w, s, e, n]
const CALTRANS = [
  [1, [-124.5, 38.7, -122.7, 42.0]], [2, [-123.5, 39.5, -119.9, 42.0]], [3, [-123.0, 38.2, -119.9, 40.2]], [4, [-123.6, 36.9, -121.2, 38.9]],
  [5, [-122.0, 34.3, -119.4, 37.3]], [6, [-121.0, 35.0, -117.6, 37.6]], [7, [-119.5, 33.6, -117.6, 34.9]], [8, [-118.0, 33.4, -114.1, 35.9]],
  [9, [-119.6, 35.4, -116.9, 38.8]], [10, [-121.6, 37.0, -119.2, 38.9]], [11, [-117.6, 32.5, -114.4, 33.6]], [12, [-118.2, 33.3, -117.4, 34.0]],
].map(([d, box]) => ({ id: 'ct-d' + d, d, box, url: `https://cwwp2.dot.ca.gov/data/d${d}/lcs/lcsStatusD${String(d).padStart(2, '0')}.json` }));

module.exports = function setupClosures({ cars, stateBoxes }) {
  const cache = new Map();     // source id → { ts, items, loading }
  const stats = {};

  async function getJSON(url, extraHeaders) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 60000);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, application/geo+json, */*', ...(extraHeaders || {}) }, signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const len = Number(r.headers.get('content-length') || 0);
      if (len > MAX_BYTES) throw new Error('feed too large (' + Math.round(len / 1e6) + ' MB)');
      const txt = await r.text();
      if (txt.length > MAX_BYTES) throw new Error('feed too large');
      return JSON.parse(txt.replace(/^﻿/, ''));
    } finally { clearTimeout(t); }
  }
  const pts = (g) => {
    if (!g) return [];
    const c = g.type === 'LineString' || g.type === 'MultiPoint' ? g.coordinates : g.type === 'Point' ? [g.coordinates]
      : g.type === 'MultiLineString' ? (g.coordinates || []).flat() : [];
    return (c || []).filter(p => Array.isArray(p) && p.length >= 2 && Number.isFinite(+p[0]) && Number.isFinite(+p[1]) && !(Math.abs(p[0]) < 1 && Math.abs(p[1]) < 1));
  };
  const thin = (p) => p.length > 1 ? p.filter((_, i, a) => a.length < 300 || i % Math.ceil(a.length / 300) === 0).map(([x, y]) => [+(+y).toFixed(5), +(+x).toFixed(5)]) : null;

  // ── WZDx (v3 / v4.x) ──
  function wzdxItems(src, j) {
    const feats = Array.isArray(j.features) ? j.features : Array.isArray(j.road_events) ? j.road_events : [];
    const now = Date.now(), out = [], impacts = {};
    for (const f of feats) {
      const p = f.properties || {}, core = p.core_details || p;
      const type = String(core.event_type || p.event_type || '').toLowerCase();
      if (type && !/work.?zone/.test(type)) continue;          // detours describe the way around, not the closure
      const impact = String(p.vehicle_impact || '').toLowerCase();
      impacts[impact || '—'] = (impacts[impact || '—'] || 0) + 1;
      const desc = String(core.description || p.description || '');
      if (impact !== 'all-lanes-closed' && !cars.isFullClosure(desc)) continue;
      const start = Date.parse(p.start_date || ''), end = Date.parse(p.end_date || '');
      if (Number.isFinite(start) && start > now + 15 * 60 * 1000) continue;
      if (Number.isFinite(end) && end < now) continue;
      const pp = pts(f.geometry);
      if (!pp.length) continue;
      const roads = core.road_names || (p.road_name ? [p.road_name] : []);
      const upd = Date.parse(core.update_date || p.update_date || '');
      const kind = cars.weatherKind(desc);
      out.push({
        id: 'wz-' + src.id + '-' + (f.id || core.data_source_id || out.length), kind: kind || 'closure', closed: true,
        cause: kind ? 'weather' : 'construction', title: 'Road closed · work zone',
        road: (roads || []).filter(Boolean).join(' / '), text: desc.slice(0, 600),
        lat: +(+pp[0][1]).toFixed(5), lng: +(+pp[0][0]).toFixed(5), line: thin(pp),
        start: Number.isFinite(start) ? new Date(start).toISOString() : null, end: Number.isFinite(end) ? new Date(end).toISOString() : null,
        updated: Number.isFinite(upd) ? new Date(upd).toISOString() : null, priority: null, src: 'wzdx-' + src.id, credit: src.name + ' · work zones (WZDx)',
      });
    }
    stats[src.id] = { name: src.name, zones: feats.length, closedNow: out.length, impacts, at: new Date().toISOString() };
    return out;
  }

  // ── Caltrans Lane Closure System ──
  const ON = (o, k) => String(((o || {})[k] || '')).toLowerCase() === 'true';
  function caltransItems(src, j) {
    const rows = Array.isArray(j.data) ? j.data : [];
    const now = Date.now() / 1000, out = [];
    let inEffect = 0;
    for (const r of rows) {
      const l = r.lcs || {}, c = l.closure || {};
      if (!ON(c.code1097, 'isCode1097') || ON(c.code1098, 'isCode1098') || ON(c.code1022, 'isCode1022')) continue;   // in effect, not ended, not cancelled
      inEffect++;
      const type = String(c.typeOfClosure || '');
      if (!/^(full|ramp|connector)/i.test(type)) continue;                       // lanes / alternating / moving: road still open
      const ts = c.closureTimestamp || {};
      const endE = Number(ts.closureEndEpoch), indefinite = String(ts.isClosureEndIndefinite).toLowerCase() === 'true';
      if (!indefinite && Number.isFinite(endE) && endE > 0 && endE < now) continue;
      const b = (l.location || {}).begin || {}, e = (l.location || {}).end || {};
      const a = [Number(b.beginLongitude), Number(b.beginLatitude)], z = [Number(e.endLongitude), Number(e.endLatitude)];
      if (!a.every(Number.isFinite) || (Math.abs(a[0]) < 1 && Math.abs(a[1]) < 1)) continue;
      const line = z.every(Number.isFinite) && Math.abs(z[0]) > 1 && Math.abs(a[0] - z[0]) < 1 && Math.abs(a[1] - z[1]) < 1 ? [[a[1], a[0]], [z[1], z[0]]] : null;
      const work = String(c.typeOfWork || '');
      const kind = cars.weatherKind(work);
      const dir = (l.location || {}).travelFlowDirection;
      out.push({
        id: 'ct-' + (l.index || c.closureID + '-' + c.logNumber), kind: kind || 'closure', closed: true,
        cause: kind ? 'weather' : 'construction',
        title: (/ramp|connector/i.test(type) ? 'Ramp closed' : 'Road closed') + (work ? ' · ' + work : ''),
        road: [b.beginRoute, dir].filter(Boolean).join(' '),
        text: [b.beginLocationName && e.endLocationName ? `${b.beginLocationName} to ${e.endLocationName}` : '', b.beginNearbyPlace, b.beginCounty && b.beginCounty + ' County',
          c.durationOfClosure, c.estimatedDelay ? 'Estimated delay ' + c.estimatedDelay + ' min' : ''].filter(Boolean).join(' · ').slice(0, 600),
        lat: +a[1].toFixed(5), lng: +a[0].toFixed(5), line,
        start: Number(ts.closureStartEpoch) ? new Date(Number(ts.closureStartEpoch) * 1000).toISOString() : null,
        end: !indefinite && Number.isFinite(endE) && endE > 0 ? new Date(endE * 1000).toISOString() : null,
        updated: Number(((l.recordTimestamp || {}).recordEpoch)) ? new Date(Number(l.recordTimestamp.recordEpoch) * 1000).toISOString() : null,
        priority: null, src: src.id, credit: 'Caltrans · Lane Closure System (District ' + src.d + ')',
      });
    }
    stats[src.id] = { name: 'Caltrans District ' + src.d, closures: rows.length, inEffect, fullNow: out.length, at: new Date().toISOString() };
    return out;
  }

  function load(src, kind) {
    const c = cache.get(src.id);
    if (c && Date.now() - c.ts < TTL) return Promise.resolve(c.items);
    if (c && c.loading) return c.loading;
    const loading = getJSON(src.url, src.headers)
      .then(j => { const items = kind === 'ct' ? caltransItems(src, j) : wzdxItems(src, j); cache.set(src.id, { ts: Date.now(), items }); return items; })
      .catch(e => {
        stats[src.id] = { ...(stats[src.id] || {}), name: src.name || src.id, error: e.message, at: new Date().toISOString() };
        const old = (c && c.items) || [];
        cache.set(src.id, { ts: Date.now() - TTL + 3 * 60 * 1000, items: old });   // retry in 3 min
        return old;
      });
    cache.set(src.id, { ...(c || { ts: 0, items: [] }), loading });
    return loading;
  }

  const hits = (box, b) => box && !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]);
  const grow = (box) => box && [box[0] - 0.5, box[1] - 0.5, box[2] + 0.5, box[3] + 0.5];
  // Closures for the map view b = [w, s, e, n]
  function forView(b) {
    const jobs = [];
    for (const src of wzdxSources()) if (src.states.some(st => hits(grow(stateBoxes[st]), b))) jobs.push(load(src, 'wz'));
    for (const src of CALTRANS) if (hits(grow(src.box), b)) jobs.push(load(src, 'ct'));
    return Promise.all(jobs).then(r => r.flat());
  }
  const coveredNames = () => [...new Set(wzdxSources().map(s => s.name))].concat('California (Caltrans)');
  // Admin check: fetch one feed now (skipping the cache) and report what came back
  async function probe(id) {
    const all = wzdxSources().map(x => ({ ...x, kind: 'wz' })).concat(CALTRANS.map(x => ({ ...x, kind: 'ct' })));
    const configured = all.map(x => x.id);
    const src = all.find(x => x.id === id);
    if (!src) return { id, configured: false, note: 'Not configured. Check the Railway variable name, then redeploy.', feedsConfigured: configured };
    cache.delete(src.id);
    const t0 = Date.now();
    const items = await load(src, src.kind);
    return { id, configured: true, host: (() => { try { return new URL(src.url).host; } catch { return null; } })(),
      seconds: +((Date.now() - t0) / 1000).toFixed(1), stats: stats[src.id] || null, closedNow: items.length,
      sample: items.slice(0, 3).map(h => ({ title: h.title, road: h.road, cause: h.cause, lat: h.lat, lng: h.lng })), feedsConfigured: configured };
  }
  return { forView, probe, stats: () => stats, coveredNames, _test: { wzdxItems, caltransItems, CALTRANS } };
};
