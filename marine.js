// WeatherTV marine module — updated 2026-10-09 build.1791760000
// Data for the WeatherStar "Tides" and "Marine Forecast" screens.
//
//   GET /api/marine/tides?lat=&lon=     2 nearest NOAA tide stations (within 60 mi):
//                                       high/low tides for ~2 days, as timestamps
//   GET /api/marine/forecast?lat=&lon=  nearest NWS marine zone (within 40 mi):
//                                       next two periods — wind direction/speed, seas/waves
//
// Sources (free, no key): NOAA CO-OPS tide predictions; NWS marine zone
// forecasts — the zone forecast API for ocean/Gulf/Pacific zones, and the local
// office's text bulletin (Nearshore NSH / Coastal Waters CWF / Great Lakes GLF)
// when the API has no forecast for a zone (all Great Lakes nearshore zones).
//
// Viewers never cause duplicate upstream calls: results are cached per tide
// station (6 h — predictions don't change) and per marine zone (30 min), and
// every viewer near the same station/zone shares that copy.

const STATIONS = require('./data/tide-stations.json');   // { id, n (short name), st, lat, lon }
const ZONES = require('./data/marine-zones.json');       // { id, name, short, cwa, lat, lon, tz }

const TIDE_RADIUS_MI = 60;
const ZONE_RADIUS_MI = 40;
const UA = { 'User-Agent': 'WeatherTV/1.0 (+https://watchweathertv.com)' };

function miles(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, R = 3958.8;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2
          + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const nearestOf = (list, lat, lon, max, n) => list
  .map((x) => ({ x, mi: miles(lat, lon, x.lat, x.lon) }))
  .filter((o) => o.mi <= max).sort((a, b) => a.mi - b.mi).slice(0, n);

// ── Small shared cache: one upstream call per key at a time ─────────────────
const _cache = new Map();          // key -> { ts, value }
const _inflight = new Map();
async function cached(key, ttlMs, loader) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.value;
  if (_inflight.has(key)) return _inflight.get(key);
  const p = loader().then((value) => {
    _cache.set(key, { ts: Date.now(), value });
    if (_cache.size > 2000) _cache.delete(_cache.keys().next().value);
    return value;
  }).catch((e) => {
    if (hit) return hit.value;                      // keep the last good copy
    throw e;
  }).finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

// ── Tides ───────────────────────────────────────────────────────────────────
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
async function tidePredictions(id) {
  return cached(`tide:${id}`, 6 * 3600 * 1000, async () => {
    const begin = new Date(Date.now() - 24 * 3600 * 1000);
    const url = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&interval=hilo'
      + `&datum=MLLW&units=english&time_zone=gmt&format=json&application=WeatherTV&station=${id}`
      + `&begin_date=${ymd(begin)}&range=96`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`NOAA tides ${r.status}`);
    const d = await r.json();
    if (d.error) throw new Error(`NOAA tides: ${d.error.message || 'error'}`);
    return (d.predictions || []).map((p) => ({
      t: Date.parse(p.t.replace(' ', 'T') + ':00Z'),      // GMT "YYYY-MM-DD HH:MM"
      ft: Math.round(parseFloat(p.v) * 10) / 10,
      hi: p.type === 'H',
    })).filter((p) => Number.isFinite(p.t));
  });
}

// ── Buoys (NDBC) ────────────────────────────────────────────────────────────
// One file has the latest reading from every NDBC buoy and coastal station; station names come
// from NDBC's station list (kept a day). Shared by all viewers, refreshed every 15 minutes.
const _num = (v) => (v == null || v === 'MM' || v === '' ? null : (Number.isFinite(+v) ? +v : null));
async function ndbcNames() {
  return cached('ndbc:names', 24 * 3600 * 1000, async () => {
    const r = await fetch('https://www.ndbc.noaa.gov/activestations.xml', { headers: UA });
    if (!r.ok) throw new Error('NDBC stations ' + r.status);
    const xml = await r.text(), out = {};
    for (const m of xml.matchAll(/<station\s+([^>]+?)\/?>/g)) {
      const a = {}; for (const kv of m[1].matchAll(/(\w+)="([^"]*)"/g)) a[kv[1]] = kv[2];
      if (a.id) out[a.id.toUpperCase()] = { name: (a.name || '').replace(/&amp;/g, '&').replace(/&apos;/g, "'"), type: a.type || '', owner: a.owner || '' };
    }
    return out;
  });
}
async function ndbcLatest() {
  return cached('ndbc:latest', 15 * 60 * 1000, async () => {
    const r = await fetch('https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt', { headers: UA });
    if (!r.ok) throw new Error('NDBC latest ' + r.status);
    const txt = await r.text();
    const names = await ndbcNames().catch(() => ({}));
    const lines = txt.split('\n');
    const head = (lines.find((l) => l.startsWith('#STN')) || '').replace(/^#/, '').trim().split(/\s+/);
    const col = (k) => head.indexOf(k);
    const C = { stn: col('STN'), lat: col('LAT'), lon: col('LON'), yy: col('YYYY'), mo: col('MM'), dd: col('DD'), hh: col('hh'), mn: col('mm'),
      wdir: col('WDIR'), wspd: col('WSPD'), gst: col('GST'), wvht: col('WVHT'), dpd: col('DPD'), mwd: col('MWD'), pres: col('PRES'), ptdy: col('PTDY'),
      atmp: col('ATMP'), wtmp: col('WTMP'), vis: col('VIS'), tide: col('TIDE') };
    const MS_MPH = 2.23694, M_FT = 3.28084, cToF = (c) => Math.round((c * 9 / 5 + 32) * 10) / 10;
    const out = [];
    for (const line of lines) {
      if (!line.trim() || line.startsWith('#')) continue;
      const f = line.trim().split(/\s+/), g = (i) => (i >= 0 ? f[i] : null);
      const lat = _num(g(C.lat)), lon = _num(g(C.lon)); if (lat == null || lon == null) continue;
      const t = Date.UTC(+g(C.yy), +g(C.mo) - 1, +g(C.dd), +g(C.hh), +g(C.mn));
      if (!Number.isFinite(t) || Date.now() - t > 6 * 3600 * 1000) continue;          // skip stale reports
      const id = String(g(C.stn)).toUpperCase(), n = names[id] || {};
      const wspd = _num(g(C.wspd)), gst = _num(g(C.gst)), wvht = _num(g(C.wvht)), atmp = _num(g(C.atmp)), wtmp = _num(g(C.wtmp));
      out.push({ id, name: n.name || id, type: n.type || '', lat, lon, t,
        wdir: _num(g(C.wdir)), wind: wspd == null ? null : Math.round(wspd * MS_MPH), gust: gst == null ? null : Math.round(gst * MS_MPH),
        wave: wvht == null ? null : Math.round(wvht * M_FT * 10) / 10, period: _num(g(C.dpd)), wavedir: _num(g(C.mwd)),
        pres: _num(g(C.pres)), ptdy: _num(g(C.ptdy)), air: atmp == null ? null : cToF(atmp), water: wtmp == null ? null : cToF(wtmp), vis: _num(g(C.vis)) });
    }
    return out;
  });
}

// ── Real-time water levels (NOAA CO-OPS) ───────────────────────────────────
async function waterLevelStations() {
  return cached('coops:wl', 24 * 3600 * 1000, async () => {
    const r = await fetch('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels', { headers: UA });
    if (!r.ok) throw new Error('CO-OPS stations ' + r.status);
    const j = await r.json();
    return (j.stations || []).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
      .map((s) => ({ id: s.id, name: s.name, st: s.state || '', lat: s.lat, lon: s.lng, tidal: !!s.tidal, lakes: !!s.greatlakes }));
  });
}
async function waterLevelNow(st) {
  return cached('coops:now:' + st.id, 6 * 60 * 1000, async () => {
    const datum = st.lakes ? 'IGLD' : 'MLLW';
    const base = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?format=json&application=WeatherTV&units=english&time_zone=gmt';
    const get = (dt) => fetch(`${base}&product=water_level&date=latest&datum=${dt}&station=${st.id}`, { headers: UA }).then((r) => r.json()).catch(() => null);
    // Shown level: feet above mean lower low water (tidal) or lake level (IGLD, Great Lakes).
    // NOAA's flood thresholds are on the station's own datum (STND), so the flood check uses that.
    const [wl, wlStnd, fl] = await Promise.all([get(datum), st.lakes ? null : get('STND'),
      fetch(`https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/${st.id}/floodlevels.json`, { headers: UA }).then((r) => r.json()).catch(() => null)]);
    const d = wl && wl.data && wl.data[0], ds = st.lakes ? d : (wlStnd && wlStnd.data && wlStnd.data[0]);
    const level = d ? _num(d.v) : null, t = d ? Date.parse(d.t.replace(' ', 'T') + ':00Z') : null, cmp = ds ? _num(ds.v) : null;
    const fx = fl && (fl.nos_minor != null || fl.nws_minor != null) ? fl : null;
    const th = fx ? { minor: _num(fx.nos_minor ?? fx.nws_minor), moderate: _num(fx.nos_moderate ?? fx.nws_moderate), major: _num(fx.nos_major ?? fx.nws_major) } : null;
    let flooding = null;
    if (th && cmp != null) flooding = th.major != null && cmp >= th.major ? 'major' : th.moderate != null && cmp >= th.moderate ? 'moderate' : th.minor != null && cmp >= th.minor ? 'minor' : 'none';
    // How far below minor flooding, in feet (same datum on both sides)
    const toMinor = th && th.minor != null && cmp != null ? Math.round((th.minor - cmp) * 10) / 10 : null;
    return { level, t, datum, flooding, toMinor };
  });
}

// ── Marine forecast text → wind / seas ──────────────────────────────────────
const DIRS = { north: 'N', northeast: 'NE', east: 'E', southeast: 'SE', south: 'S', southwest: 'SW', west: 'W', northwest: 'NW',
  n: 'N', ne: 'NE', e: 'E', se: 'SE', s: 'S', sw: 'SW', w: 'W', nw: 'NW', variable: 'VRB' };
function parseMarine(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  // Wind: "NW winds around 10 kt", "West wind 5 to 10 knots", "Variable winds less than 10 kt"
  const wm = /\b(north(?:east|west)?|south(?:east|west)?|east|west|variable|[NSEW]{1,2})\s+winds?\s+(?:around\s+|up to\s+|less than\s+|near\s+)?(\d+)(?:\s+to\s+(\d+))?\s*(?:kt|knots?)/i.exec(t);
  let wind = null;
  if (wm) wind = { dir: DIRS[wm[1].toLowerCase()] || wm[1].toUpperCase(), lo: +wm[2], hi: wm[3] ? +wm[3] : null };
  else if (/winds?\s+(?:light|calm)/i.test(t) || /light (?:and )?variable winds?/i.test(t)) wind = { dir: 'VRB', lo: 0, hi: 5 };
  const gust = /gusts?\s+(?:up\s+)?to\s+(\d+)\s*(?:kt|knots?)/i.exec(t);
  if (wind && gust) wind.gust = +gust[1];
  // Seas / waves: "Seas around 2 ft", "Waves 3 to 4 feet", "Seas 1 foot or less", "Waves nearly calm"
  let seas = null;
  const calm = /\b(seas|waves)\s+(?:nearly\s+)?calm\b/i.exec(t);
  const sm = /\b(seas|waves)\s+(?:around\s+|up to\s+|near\s+)?(\d+)(?:\s+to\s+(\d+))?\s*(?:ft|feet|foot)(\s+or less)?/i.exec(t);
  if (calm && (!sm || calm.index < sm.index)) seas = { kind: calm[1].toLowerCase(), lo: 0, hi: 0 };
  else if (sm) seas = { kind: sm[1].toLowerCase(), lo: sm[4] ? 0 : +sm[2], hi: sm[3] ? +sm[3] : +sm[2] };
  return { wind, seas };
}
function seaState(seas) {
  if (!seas) return null;
  const h = seas.hi;
  if (h < 1) return 'CALM';
  if (h <= 1) return 'SMOOTH';
  if (h <= 2) return 'LGT CHOP';
  if (h <= 4) return 'MOD CHOP';
  if (h <= 7) return 'ROUGH';
  if (h <= 12) return 'VERY ROUGH';
  return 'HIGH SEAS';
}
// "REST OF TONIGHT" → "Tonight", "FRIDAY" → "Today"/"Tomorrow"/"Fri" depending on
// the zone's local date (after midnight, "Friday" means today), "FRIDAY NIGHT"
// on Friday → "Tonight".
const WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function localWeekday(tz, plusDays = 0) {
  const d = new Date(Date.now() + plusDays * 86400000);
  try { return WEEK.indexOf(d.toLocaleDateString('en-US', { weekday: 'short', timeZone: tz || 'America/New_York' }).slice(0, 3).toLowerCase()); }
  catch (_) { return d.getUTCDay(); }
}
function periodName(raw, tz) {
  const s = String(raw || '').toLowerCase().replace(/^rest of\s+/, '').trim();
  if (/^(today|this afternoon|this morning)$/.test(s)) return s === 'this afternoon' ? 'This Aftn' : 'Today';
  if (/^(tonight|this evening|overnight)$/.test(s)) return 'Tonight';
  const day = s.match(/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\w*(\s+night)?$/);
  if (day) {
    const wd = WEEK.indexOf(day[1].slice(0, 3)), night = !!day[2];
    const today = localWeekday(tz), tomorrow = localWeekday(tz, 1);
    if (wd === today) return night ? 'Tonight' : 'Today';
    if (wd === tomorrow) return night ? 'Tmrw Night' : 'Tomorrow';
    return WEEK[wd].replace(/^\w/, (c) => c.toUpperCase()) + (night ? ' Night' : '');
  }
  return s.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 12);
}

// NWS text bulletin: zone blocks start with a UGC line like "LMZ645-646-091000-"
// or "ANZ450>452-091000-" (may wrap), periods are ".TONIGHT...text".
function ugcCovers(header, zoneId) {
  const tokens = header.replace(/\s+/g, '').split('-').filter(Boolean);
  let prefix = null;
  for (const tok of tokens) {
    if (/^\d{6}$/.test(tok)) continue;                       // expiration ddhhmm
    const m = /^([A-Z]{2}Z)?(\d{3})(?:>(\d{3}))?$/.exec(tok);
    if (!m) continue;
    if (m[1]) prefix = m[1];
    if (!prefix || !zoneId.startsWith(prefix)) continue;
    const n = +zoneId.slice(3), a = +m[2], b = m[3] ? +m[3] : a;
    if (n >= a && n <= b) return true;
  }
  return false;
}
function zoneFromBulletin(text, zoneId) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^[A-Z]{2}Z\d{3}/.test(lines[i])) continue;
    let header = lines[i], j = i;
    while (!/\d{6}-\s*$/.test(lines[j]) && j + 1 < lines.length && j - i < 4) { j += 1; header += lines[j]; }
    if (!ugcCovers(header, zoneId)) continue;
    const end = lines.findIndex((l, k) => k > j && /^\$\$/.test(l));
    const body = lines.slice(j + 1, end < 0 ? undefined : end).join('\n');
    const periods = [];
    const re = /^\.([A-Z][A-Z ]+?)\.\.\.([\s\S]*?)(?=^\.[A-Z][A-Z ]+?\.\.\.|$(?![\s\S]))/gm;
    let m;
    while ((m = re.exec(body))) periods.push({ name: m[1].trim(), text: m[2].replace(/\s+/g, ' ').trim() });
    if (periods.length) return periods;
  }
  return null;
}
async function latestProductText(type, office) {
  return cached(`prod:${type}:${office}`, 30 * 60 * 1000, async () => {
    const list = await fetch(`https://api.weather.gov/products/types/${type}/locations/${office}`, { headers: { ...UA, Accept: 'application/ld+json' } });
    if (!list.ok) throw new Error(`NWS ${type} list ${list.status}`);
    const g = (await list.json())['@graph'] || [];
    if (!g.length) return null;
    const p = await fetch(`https://api.weather.gov/products/${g[0].id}`, { headers: { ...UA, Accept: 'application/ld+json' } });
    if (!p.ok) throw new Error(`NWS product ${p.status}`);
    const d = await p.json();
    return { text: d.productText || '', issued: d.issuanceTime || null };
  });
}
async function zoneForecast(zone) {
  return cached(`zone:${zone.id}`, 30 * 60 * 1000, async () => {
    // 1) Zone forecast API (works for ocean, Gulf and Pacific zones)
    try {
      const r = await fetch(`https://api.weather.gov/zones/forecast/${zone.id}/forecast`, { headers: { ...UA, Accept: 'application/geo+json' } });
      if (r.ok) {
        const p = (await r.json()).properties || {};
        const periods = (p.periods || []).map((x) => ({ name: x.name, text: x.detailedForecast || '' }));
        if (periods.length) return { periods, issued: p.updated || null };
      }
    } catch (_) { /* fall through to the bulletin */ }
    // 2) The office's text bulletins (Great Lakes nearshore zones live only here)
    for (const type of ['NSH', 'CWF', 'GLF', 'OFF']) {
      try {
        const prod = await latestProductText(type, zone.cwa);
        const periods = prod && zoneFromBulletin(prod.text, zone.id);
        if (periods) return { periods, issued: prod.issued };
      } catch (_) { /* try the next type */ }
    }
    return null;
  });
}

// ── Routes ──────────────────────────────────────────────────────────────────
module.exports = function attachMarine(app) {
  const point = (req) => {
    const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon ?? req.query.lng);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  };

  // All buoys and coastal stations reporting in the last 6 hours (for the radar map)
  app.get('/api/marine/buoys', async (req, res) => {
    try { res.set('Cache-Control', 'public, max-age=300'); res.json({ buoys: await ndbcLatest(), source: 'NOAA National Data Buoy Center' }); }
    catch (e) { res.status(502).json({ buoys: [], error: 'buoys unavailable: ' + e.message }); }
  });
  // Real-time water-level / tide gauges (list), and one gauge's latest level + coming high/low tides
  app.get('/api/marine/water-levels', async (req, res) => {
    try { res.set('Cache-Control', 'public, max-age=3600'); res.json({ stations: await waterLevelStations(), source: 'NOAA Tides & Currents' }); }
    catch (e) { res.status(502).json({ stations: [], error: 'water levels unavailable' }); }
  });
  app.get('/api/marine/water-level', async (req, res) => {
    try {
      const id = String(req.query.id || '').replace(/\D/g, '');
      const st = (await waterLevelStations()).find((s) => s.id === id);
      if (!st) return res.status(404).json({ error: 'unknown station' });
      const [now, tides] = await Promise.all([waterLevelNow(st), st.tidal ? tidePredictions(id).catch(() => null) : null]);
      res.set('Cache-Control', 'public, max-age=300');
      res.json({ station: st, ...now, tides: (tides || []).filter((e) => e.t > Date.now() - 3600 * 1000).slice(0, 4),
        url: `https://tidesandcurrents.noaa.gov/stationhome.html?id=${id}` });
    } catch (e) { res.status(502).json({ error: 'water level unavailable' }); }
  });

  app.get('/api/marine/tides', async (req, res) => {
    const p = point(req);
    if (!p) return res.status(400).json({ error: 'lat/lon required' });
    const near = [];
    for (const { x, mi } of nearestOf(STATIONS, p.lat, p.lon, TIDE_RADIUS_MI, 6)) {
      if (near.some((o) => o.name.toLowerCase() === x.n.toLowerCase() || miles(o.lat, o.lon, x.lat, x.lon) < 3)) continue;   // skip near-duplicates
      const name = (x.n === x.n.toUpperCase() ? x.n.toLowerCase() : x.n.replace(/\b([A-Z]{4,})\b/g, (w) => w[0] + w.slice(1).toLowerCase()))
        .replace(/(^|[\s,(])([a-z])(?=[a-z]{2})/g, (m, pre, c) => pre + c.toUpperCase());   // "ocean pier" → "Ocean Pier"
      near.push({ id: x.id, name, state: x.st, lat: x.lat, lon: x.lon, mi: Math.round(mi) });
      if (near.length === 2) break;
    }
    try {
      const stations = [];
      for (const s of near) {
        const events = await tidePredictions(s.id).catch(() => null);
        if (events && events.length) stations.push({ ...s, events });
      }
      res.set('Cache-Control', 'public, max-age=900');
      res.json({ stations, source: 'NOAA Tides & Currents' });
    } catch (e) {
      res.status(502).json({ stations: [], error: 'tides unavailable' });
    }
  });

  app.get('/api/marine/forecast', async (req, res) => {
    const p = point(req);
    if (!p) return res.status(400).json({ error: 'lat/lon required' });
    const hit = nearestOf(ZONES, p.lat, p.lon, ZONE_RADIUS_MI, 1)[0];
    if (!hit) return res.json({ zone: null, periods: [] });
    try {
      const f = await zoneForecast(hit.x);
      const periods = [];
      (f ? f.periods : []).forEach((x) => {
        if (periods.length >= 2) return;
        const parsed = parseMarine(x.text);
        if (!parsed.wind && !parsed.seas) return;
        periods.push({ name: periodName(x.name, hit.x.tz), raw: x.name,
          ...parsed, state: seaState(parsed.seas) });
      });
      res.set('Cache-Control', 'public, max-age=900');
      res.json({ zone: { id: hit.x.id, name: hit.x.short, mi: Math.round(hit.mi) }, issued: f ? f.issued : null,
        periods: periods.map(({ raw, ...rest }) => rest), source: 'National Weather Service' });
    } catch (e) {
      res.status(502).json({ zone: null, periods: [], error: 'marine forecast unavailable' });
    }
  });
};

module.exports._internals = { parseMarine, seaState, periodName, ugcCovers, zoneFromBulletin };
