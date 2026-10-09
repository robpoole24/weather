// WeatherTV airports module — updated 2026-10-09 build.1791750000
// Data for the WeatherStar "Airport Conditions" screen: current weather at the
// 3 airports nearest the viewer — any airport with a weather station, from the
// big hubs down to fields like Oshkosh/Wittman.
//
// The server downloads ONE file every 10 minutes: the FAA Aviation Weather
// Center's cache of every current airport weather report (METAR) in North
// America. Viewer requests only read what's stored, so traffic never reaches
// aviationweather.gov no matter how many people are watching.
//
//   GET /api/airports/conditions?lat=&lon=   3 nearest airports with a recent report
//   GET /api/airports/status                 last download, station count, errors
//
// data/airports-weather.json: ~4,200 U.S. airports with a 4-letter code
// (OurAirports), each with a short on-screen name. Only those with a current
// report are ever shown.

const zlib = require('zlib');
const AIRPORTS = require('./data/airports-weather.json');

const METAR_URL = 'https://aviationweather.gov/data/cache/metars.cache.csv.gz';
const POLL_MIN = 10;
const MAX_AGE_H = 2;            // a report older than this isn't "current"
const RADIUS_MI = 150;          // nearest airports farther than this aren't "nearby"
const UA = { 'User-Agent': 'WeatherTV/1.0 (+https://watchweathertv.com)' };

// ── Geometry + sun ──────────────────────────────────────────────────────────
function miles(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, R = 3958.8;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2
          + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
// Sun elevation in degrees (NOAA low-precision formula) — for day/night icons
function sunElevation(lat, lon, date = new Date()) {
  const rad = Math.PI / 180;
  const d = (date.getTime() / 86400000) - 10957.5;           // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = ((gmst * 15 + lon) * rad) - ra;
  return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha)) / rad;
}

// ── METAR → WeatherStar icon ────────────────────────────────────────────────
// WeatherStar's icon code reads weather.gov-style icon links
// (".../icons/land/{day|night}/{condition}"), so reports are translated into
// that vocabulary and WeatherStar picks its own matching artwork.
function conditionCode(wx, cover, windKt) {
  const w = ` ${String(wx || '').toUpperCase()} `;
  const has = (re) => re.test(w);
  if (has(/\bFC\b|\+FC/)) return 'tornado';
  if (has(/TS/)) return has(/\+/) ? 'tsra_hi' : 'tsra';
  if (has(/FZ(RA|DZ)/)) return has(/SN/) ? 'snow_fzra' : 'fzra';
  if (has(/PL|GS|\bGR\b/)) return has(/SN/) ? 'snow_sleet' : has(/RA/) ? 'rain_sleet' : 'sleet';
  if (has(/SN|SG/)) return has(/RA|DZ/) ? 'rain_snow' : (has(/BL/) || windKt >= 25 ? 'blizzard' : 'snow');
  if (has(/SH\w*RA|SHRA|VCSH/)) return 'rain_showers';
  if (has(/RA|DZ|UP/)) return 'rain';
  if (has(/\bFG\b|FZFG|BCFG|MIFG|PRFG/)) return 'fog';
  if (has(/\bFU\b|\bVA\b/)) return 'smoke';
  if (has(/\bDU\b|\bSA\b|\bSS\b|\bDS\b|PO/)) return 'dust';
  if (has(/\bHZ\b/)) return 'haze';
  if (has(/\bBR\b/)) return 'fog';
  const sky = { CLR: 'skc', SKC: 'skc', CAVOK: 'skc', NSC: 'skc', FEW: 'few', SCT: 'sct', BKN: 'bkn', OVC: 'ovc', OVX: 'ovc', VV: 'ovc' }[cover] || 'skc';
  return windKt >= 20 ? `wind_${sky}` : sky;
}
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function windText(dir, kt) {
  const mph = Math.round((+kt || 0) * 1.15078);
  if (!mph) return 'Calm';
  if (dir === 'VRB' || dir === '' || dir == null || Number.isNaN(+dir)) return `Vrbl ${mph}`;
  return `${COMPASS[Math.round(+dir / 45) % 8]} ${mph}`;
}

// ── Parse the cache file ────────────────────────────────────────────────────
// A few info lines, then a header row starting "raw_text,station_id,…". The
// sky_cover/cloud_base pair repeats (one per cloud layer).
function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i += 1; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
function parseMetarCsv(text) {
  const lines = text.split(/\r?\n/);
  const h = lines.findIndex((l) => l.startsWith('raw_text,'));
  if (h < 0) throw new Error('METAR file: header row not found');
  const head = splitCsv(lines[h]);
  const col = (name) => head.indexOf(name);
  const I = { id: col('station_id'), time: col('observation_time'), lat: col('latitude'), lon: col('longitude'),
    temp: col('temp_c'), wdir: col('wind_dir_degrees'), wspd: col('wind_speed_kt'), vis: col('visibility_statute_mi'), wx: col('wx_string') };
  const skyCols = head.map((n, i) => (n === 'sky_cover' ? i : -1)).filter((i) => i >= 0);
  const RANK = { CLR: 0, SKC: 0, CAVOK: 0, NSC: 0, FEW: 1, SCT: 2, BKN: 3, OVC: 4, OVX: 4, VV: 4 };
  const out = {};
  for (let i = h + 1; i < lines.length; i += 1) {
    if (!lines[i]) continue;
    const f = splitCsv(lines[i]);
    const id = f[I.id];
    if (!id) continue;
    let cover = '';
    skyCols.forEach((c) => { const v = (f[c] || '').toUpperCase(); if (v && (RANK[v] ?? -1) > (RANK[cover] ?? -1)) cover = v; });
    const tc = f[I.temp] === '' ? null : +f[I.temp];
    const kt = f[I.wspd] === '' ? 0 : +f[I.wspd];
    const rec = {
      t: Date.parse(f[I.time]) || null,
      tempF: tc == null || Number.isNaN(tc) ? null : Math.round(tc * 9 / 5 + 32),
      cond: conditionCode(f[I.wx], cover, kt),
      wind: windText(f[I.wdir], kt),
    };
    if (!out[id] || (rec.t || 0) > (out[id].t || 0)) out[id] = rec;   // keep the newest per station
  }
  return out;
}

// ── Service ─────────────────────────────────────────────────────────────────
module.exports = function attachAirports(app, { rGet, rSet }) {
  let obs = {};                       // icao -> { t, tempF, cond, wind }
  const job = { lastRun: null, lastOk: null, stations: 0, lastError: null };

  async function poll() {
    job.lastRun = new Date().toISOString();
    try {
      const r = await fetch(METAR_URL, { headers: UA });
      if (!r.ok) throw new Error(`aviationweather.gov ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      // Usually gzip on the wire; some proxies/clients hand back the plain text
      const text = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
      const parsed = parseMetarCsv(text);
      // A report without a temperature (sensor out) keeps the last one we had, up to 2 h old
      for (const [id, rec] of Object.entries(parsed)) {
        const prev = obs[id];
        if (rec.tempF == null && prev && prev.tempF != null && (rec.t || 0) - (prev.tT || prev.t || 0) < 2 * 3600 * 1000) {
          rec.tempF = prev.tempF; rec.tT = prev.tT || prev.t;
        }
      }
      obs = parsed;
      Object.assign(job, { lastOk: job.lastRun, stations: Object.keys(parsed).length, lastError: null });
      await rSet('airports:metar', { ts: Date.now(), obs }, 6 * 3600);
    } catch (e) {
      job.lastError = e.message;                     // keep the last good set
      console.warn('[Airports] METAR download:', e.message);
    }
  }
  (async () => {
    const saved = await rGet('airports:metar');
    if (saved && saved.obs) obs = saved.obs;         // restart: serve the last set right away
    poll();
    setInterval(poll, POLL_MIN * 60 * 1000);
  })().catch((e) => console.error('[Airports] start failed:', e.message));

  app.get('/api/airports/conditions', (req, res) => {
    const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon ?? req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'lat/lon required' });
    const fresh = Date.now() - MAX_AGE_H * 3600 * 1000;
    const now = new Date();
    const list = AIRPORTS
      .filter((a) => obs[a.icao] && (obs[a.icao].t || 0) >= fresh)
      .map((a) => ({ a, mi: miles(lat, lon, a.lat, a.lon) }))
      .filter((x) => x.mi <= RADIUS_MI)
      .sort((x, y) => x.mi - y.mi)
      .slice(0, 3)
      .map(({ a, mi }) => {
        const o = obs[a.icao];
        const night = sunElevation(a.lat, a.lon, now) < -0.833;
        return {
          icao: a.icao, short: a.short, mi: Math.round(mi), tempF: o.tempF, wind: o.wind, night,
          icon: `https://api.weather.gov/icons/land/${night ? 'night' : 'day'}/${o.cond}`,   // WeatherStar maps this to its own art
          observed: o.t,
        };
      });
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ airports: list, source: 'FAA Aviation Weather Center' });
  });

  app.get('/api/airports/status', (req, res) => res.json({ ...job, airportsKnown: AIRPORTS.length }));
};

module.exports._internals = { parseMetarCsv, conditionCode, windText, sunElevation, miles };
