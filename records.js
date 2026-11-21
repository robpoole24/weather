// WeatherTV daily records module — updated 2026-11-21T10:00:00Z build.1795255200
// Daily climate records and normals for the forecast panel, from the Regional
// Climate Centers' ACIS service (data.rcc-acis.org, free, no key).
//
// Records come from NOAA "ThreadEx" stations: ~300 long-record city sites
// ("Milwaukee Area", records back to 1871) that stitch together a city's
// downtown + airport history. These are the same records NWS offices quote.
//
// The server pulls every station on its own schedule — one station every few
// seconds, each refreshed once a day — and keeps the results in Redis.
// Viewer requests only read what's stored, so traffic never reaches ACIS no
// matter how many people are watching.
//
//   GET /api/records?lat=&lon=&start=YYYY-MM-DD&days=8   nearest station's records + normals
//   GET /api/records/status                              sweep progress, errors
//
// The station list (~415 active ThreadEx sites) is built from ACIS station
// metadata on first start and then once a month, and kept in Redis. ThreadEx
// sites have no coordinates of their own, so each uses its namesake airport or
// co-op station's location.

let STATIONS = [];
const META = 'https://data.rcc-acis.org/StnMeta';
const STATES = ('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP').split(' ');
// Sites ACIS can't place, or places wrongly (lon, lat)
const LL_FIX = { AGY: [-135.3157, 59.4601], LMT: [-121.7332, 42.1561], STU: [-170.7136, -14.3310], AUS: [-97.6799, 30.1831] };
const STATIONS_KEY = 'acis:stations:v1';

const ACIS = 'https://data.rcc-acis.org/StnData';
const UA = { 'User-Agent': 'WeatherTV/1.0 (+https://watchweathertv.com)', 'Content-Type': 'application/json' };
const PACE_MS = 4000;                 // one station every 4 s (~20 min for a full sweep)
const REFRESH_MS = 20 * 3600 * 1000;  // re-pull a station once it's 20 h old
const REDIS_TTL = 4 * 24 * 3600;      // keep a station 4 days if refreshes keep failing
const RADIUS_MI = 120;                // farther than this, the records don't describe your town
const KEY = (sid) => `acis:records:v1:${sid}`;

const mem = new Map();                // sid -> { ts, days: [366 rows] }
const wanted = new Set();             // stations viewers are waiting on, pulled first
const status = { started: null, lastSweepDone: null, stationsCached: 0, ok: 0, failed: 0, lastError: null, total: 0 };

function miles(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, R = 3958.8;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2
          + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Day-of-year slot as ACIS numbers it with groupby 0101–1231: Jan 1 = 0, Feb 29 = 59, Dec 31 = 365
const CUM = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
const slot = (m, d) => CUM[m - 1] + d - 1;

// "66" -> 66, "T" -> trace (0.001), "M"/"" -> null
const num = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === 'T') return 0.001;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};
const year = (d) => (d && /^\d{4}/.test(d) ? +d.slice(0, 4) : null);

async function acis(body, url = ACIS) {
  const r = await fetch(url, { method: 'POST', headers: UA, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('ACIS HTTP ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error('ACIS: ' + j.error);
  return j;
}

// Every active ThreadEx station (network 9), one request per state, then their coordinates.
async function buildStationList() {
  const rows = new Map();
  for (const st of STATES) {
    const j = await acis({ state: st, meta: ['name', 'state', 'sids', 'valid_daterange'], elems: 'maxt' }, META);
    for (const m of j.meta || []) {
      const s9 = (m.sids || []).find(x => / 9$/.test(x)); if (!s9) continue;
      const sid = s9.split(' ')[0], vr = ((m.valid_daterange || [])[0]) || [];
      if (!vr[1] || vr[1] < new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10)) continue;   // retired site
      if (!rows.has(sid)) rows.set(sid, { sid, name: String(m.name || '').replace(/ Area$/, ''), state: m.state || st, start: +String(vr[0] || '').slice(0, 4) || null });
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  const codes = [...rows.keys()].map(s => s.replace(/thr$/, '')), ll = {};
  for (let i = 0; i < codes.length; i += 60) {
    const chunk = codes.slice(i, i + 60);
    const j = await acis({ sids: chunk.join(','), meta: ['sids', 'll'] }, META).catch(() => ({}));
    for (const m of j.meta || []) for (const x of m.sids || []) { const c = x.split(' ')[0]; if (chunk.includes(c) && m.ll && !ll[c]) ll[c] = m.ll; }
    await new Promise(r => setTimeout(r, 1500));
  }
  const out = [];
  for (const [sid, r] of rows) {
    const c = sid.replace(/thr$/, ''), p = LL_FIX[c] || ll[c];
    if (p) out.push({ ...r, lat: +p[1].toFixed(4), lon: +p[0].toFixed(4) });
  }
  return out;
}

// Two requests per station: records for all 366 days, then 1991–2020 normals.
async function pullStation(sid) {
  const G = ['year', '0101', '1231'];
  const rec = (name, reduce) => ({ name, interval: 'dly', duration: 'dly', smry: { reduce, add: 'date' }, smry_only: 1, groupby: G });
  const r = await acis({ sid, sdate: 'por', edate: 'por',
    elems: [rec('maxt', 'max'), rec('mint', 'min'), rec('maxt', 'min'), rec('mint', 'max'), rec('pcpn', 'max'), rec('snow', 'max')] });
  const s = r.smry || [];
  if (s.length !== 6 || !Array.isArray(s[0]) || s[0].length !== 366) throw new Error('unexpected records shape');
  const n = await acis({ sid, sdate: '2024-01-01', edate: '2024-12-31',   // 2024 is a leap year: 366 rows, same slots
    elems: [{ name: 'maxt', normal: '1', interval: 'dly' }, { name: 'mint', normal: '1', interval: 'dly' },
            { name: 'pcpn', normal: '1', interval: 'dly' }, { name: 'snow', normal: '1', interval: 'dly' }] }).catch(() => null);
  const N = (n && n.data) || [];
  const pair = (x) => [num(x && x[0]), year(x && x[1])];
  // Compact row: [hi, hiYr, lo, loYr, coldHi, coldHiYr, warmLo, warmLoYr, rain, rainYr, snow, snowYr, nHi, nLo, nRain, nSnow]
  const days = [];
  for (let i = 0; i < 366; i++) {
    const nr = N[i] || [];
    days.push([...pair(s[0][i]), ...pair(s[1][i]), ...pair(s[2][i]), ...pair(s[3][i]), ...pair(s[4][i]), ...pair(s[5][i]),
      num(nr[1]), num(nr[2]), num(nr[3]), num(nr[4])]);
  }
  return { ts: Date.now(), days };
}

module.exports = function records(app, { rGet, rSet }) {
  status.started = new Date().toISOString();

  // Start from what Redis already has, then keep every station fresh in the background.
  async function loadStations() {
    const hit = await rGet(STATIONS_KEY);
    if (hit && Array.isArray(hit.list) && hit.list.length > 100) {
      STATIONS = hit.list; status.total = STATIONS.length;
      if (Date.now() - hit.ts < 30 * 86400000) return;
    }
    try {
      const list = await buildStationList();
      if (list.length > 100) {
        STATIONS = list; status.total = list.length;
        await rSet(STATIONS_KEY, { ts: Date.now(), list }, 60 * 86400);
        console.log(`[Records] station list built: ${list.length} ThreadEx sites`);
      }
    } catch (e) { status.lastError = 'station list: ' + e.message; console.warn('[Records] station list failed:', e.message); }
  }

  async function warm() {
    await loadStations();
    for (const st of STATIONS) {
      const hit = await rGet(KEY(st.sid));
      if (hit && Array.isArray(hit.days) && hit.days.length === 366) mem.set(st.sid, hit);
    }
    status.stationsCached = mem.size;
    console.log(`[Records] ${mem.size}/${STATIONS.length} stations loaded from Redis`);
  }

  let busy = false;
  async function sweep() {
    if (busy) return; busy = true;
    try {
      // Oldest first, so a restart resumes where the last sweep left off
      const due = STATIONS.filter(st => { const h = mem.get(st.sid); return !h || Date.now() - h.ts > REFRESH_MS; })
        .sort((a, b) => ((mem.get(a.sid) || {}).ts || 0) - ((mem.get(b.sid) || {}).ts || 0));
      for (let k = 0; k < due.length; k++) {
        // Anyone waiting on a station jumps the queue
        const w = due.findIndex((x, i) => i >= k && wanted.has(x.sid));
        if (w > k) { const [x] = due.splice(w, 1); due.splice(k, 0, x); }
        const st = due[k]; wanted.delete(st.sid);
        try {
          const data = await pullStation(st.sid);
          mem.set(st.sid, data);
          await rSet(KEY(st.sid), data, REDIS_TTL);
          status.ok++;
        } catch (e) {
          status.failed++; status.lastError = `${st.sid}: ${e.message}`;
        }
        status.stationsCached = mem.size;
        await new Promise(r => setTimeout(r, PACE_MS));
      }
      if (due.length) { status.lastSweepDone = new Date().toISOString(); console.log(`[Records] sweep done: ${due.length} stations, ${mem.size} cached`); }
    } finally { busy = false; }
  }

  // Redis connects after the modules load — wait for it, so a restart reuses the stored records
  setTimeout(() => {
    warm().catch(e => console.warn('[Records] warm failed:', e.message))
      .finally(() => { setTimeout(() => sweep().catch(() => {}), 30 * 1000).unref(); });
  }, 30 * 1000).unref();
  setInterval(() => sweep().catch(() => {}), 60 * 60 * 1000).unref();                  // hourly check for stale stations
  setInterval(() => loadStations().catch(() => {}), 24 * 3600 * 1000).unref();         // rebuilds the list once it's a month old

  app.get('/api/records', (req, res) => {
    const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return res.status(400).json({ error: 'lat/lon required' });
    const m = String(req.query.start || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const start = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date();
    if (isNaN(start)) return res.status(400).json({ error: 'start=YYYY-MM-DD' });
    const nDays = Math.min(Math.max(parseInt(req.query.days, 10) || 1, 1), 14);

    // Nearest station, whether or not it's been pulled yet — never stand in a farther city's records
    let best = null, bestMi = Infinity;
    for (const st of STATIONS) {
      const d = miles(lat, lon, st.lat, st.lon);
      if (d < bestMi) { bestMi = d; best = st; }
    }
    if (!STATIONS.length) { res.set('Cache-Control', 'no-store'); return res.json({ found: false, reason: 'warming_up' }); }
    if (!best || bestMi > RADIUS_MI) { res.set('Cache-Control', 'public, max-age=1800'); return res.json({ found: false, reason: STATIONS.length ? 'no_station_nearby' : 'warming_up' }); }
    if (!mem.has(best.sid)) {
      wanted.add(best.sid);                       // viewers are waiting on this one: the sweep takes it next
      res.set('Cache-Control', 'no-store');
      return res.json({ found: false, reason: 'warming_up' });
    }
    res.set('Cache-Control', 'no-cache');

    const rows = mem.get(best.sid).days, out = [];
    for (let i = 0; i < nDays; i++) {
      const dt = new Date(start.getTime() + i * 86400000);
      const mo = dt.getUTCMonth() + 1, dy = dt.getUTCDate(), r = rows[slot(mo, dy)];
      const v = (a, b) => (r[a] == null ? null : { value: r[a], year: r[b] });
      out.push({
        date: dt.toISOString().slice(0, 10),
        normal: { high: r[12], low: r[13], precip: r[14], snow: r[15] },
        record: { high: v(0, 1), low: v(2, 3), coldestHigh: v(4, 5), warmestLow: v(6, 7), precip: v(8, 9), snow: v(10, 11) },
      });
    }
    res.json({
      found: true,
      station: { id: best.sid, name: best.name, state: best.state, since: best.start, miles: Math.round(bestMi) },
      updated: new Date(mem.get(best.sid).ts).toISOString(),
      days: out,
      credit: 'NOAA Regional Climate Centers (ACIS) · normals 1991–2020',
    });
  });

  app.get('/api/records/status', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(status); });
};
