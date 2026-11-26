// WeatherTV — NOAA Weather Radio streams (GWES · weatherradio.org) — updated 2026-11-26T17:00:00Z build.1795712400
//
// The Global Weather & EAS Society streams about 73 NOAA Weather Radio transmitters live
// (https://weatherradio.org). Two public feeds describe them:
//   https://icestats.weatherradio.org/     — the live streams (Icecast status: name, stream URL, listeners)
//   https://transmitters.weatherradio.org/ — every transmitter: call sign, site, frequency, lat/lon,
//                                            and the counties it covers (SAME codes)
// The server reads both (streams every 10 min, transmitters once a day) so viewers never call
// them directly. The guide puts the streams on channels 9900+ (the audio band) and asks
// /api/wxradio/local which one is YOURS: the stream whose transmitter covers your county,
// or the nearest one if none of them does.
'use strict';

const ICESTATS = 'https://icestats.weatherradio.org/';
const TRANSMITTERS = 'https://transmitters.weatherradio.org/';
const UA = { 'User-Agent': 'WeatherTV/1.0 (watchweathertv.com, contact@altruisticapps.com)', Accept: 'application/json' };
const STREAM_EVERY = 10 * 60 * 1000, TX_EVERY = 24 * 60 * 60 * 1000;

// State → FIPS (a county's SAME code is 0 + state FIPS + county FIPS, e.g. Milwaukee County WI = 055079)
const FIPS = { AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11', FL: '12', GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38', OH: '39', OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46', TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54', WI: '55', WY: '56', AS: '60', GU: '66', MP: '69', PR: '72', VI: '78' };

let streams = [], tx = {}, streamsAt = 0, txAt = 0, busy = false;
const localMemo = new Map();                       // rounded lat,lon → { result, at }

async function getJson(url, ms) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms || 20000);
  try {
    const r = await fetch(url, { headers: UA, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// "Milwaukee, WI - KEC60" → { city: 'Milwaukee', st: 'WI', call: 'KEC60' }  ("Hialeah, FL (Spanish) - WZ2531" keeps its note)
function parseName(name) {
  const m = /^(.*?),\s*([A-Z]{2})\b\s*(\([^)]*\))?\s*-\s*([A-Z0-9]{3,7})\b/.exec(String(name || '').trim());
  return m ? { city: m[1].trim(), st: m[2], note: m[3] ? m[3].replace(/[()]/g, '') : '', call: m[4] } : null;
}

async function refresh(force) {
  if (busy) return; busy = true;
  try {
    const now = Date.now();
    if (force || now - txAt > TX_EVERY || !Object.keys(tx).length) {
      try { const j = await getJson(TRANSMITTERS, 60000); if (j && j.transmitters) { tx = j.transmitters; txAt = now; } }
      catch (e) { console.warn('[wxradio] transmitters:', e.message); }
    }
    if (force || now - streamsAt > STREAM_EVERY || !streams.length) {
      try {
        const j = await getJson(ICESTATS, 20000);
        let src = j && j.icestats && j.icestats.source; if (src && !Array.isArray(src)) src = [src];
        const seen = new Set(), out = [];
        (src || []).forEach((s) => {
          const p = parseName(s.server_name); if (!p || !/^https:\/\/wxr\.gwes-cdn\.net\//.test(s.listenurl || '') || seen.has(p.call)) return;
          seen.add(p.call);
          const t = tx[p.call] || {};
          out.push({
            call: p.call, city: p.city, st: p.st, note: p.note, url: s.listenurl, listeners: +s.listeners || 0,
            freq: t.FREQ || '', site: t.SITENAME || p.city, status: t.STATUS || '', wfo: String(t.WFO || '').split('|')[0],
            lat: parseFloat(t.LAT), lon: parseFloat(t.LON), same: Array.isArray(t.SAME) ? t.SAME : [],
          });
        });
        if (out.length) { out.sort((a, b) => a.st.localeCompare(b.st) || a.city.localeCompare(b.city) || a.call.localeCompare(b.call)); streams = out; streamsAt = now; }
      } catch (e) { console.warn('[wxradio] streams:', e.message); }
    }
  } finally { busy = false; }
}

// The streams, as last read (the guide calls this on every build; it never waits on the network)
function stations() { if (Date.now() - streamsAt > STREAM_EVERY) refresh(); return streams; }

function miles(aLat, aLon, bLat, bLon) {
  const R = 3958.8, r = Math.PI / 180, dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Your county's SAME code, from the NWS (points → county zone, e.g. WIC079 → 055079)
async function countyOf(lat, lon) {
  try {
    const j = await getJson('https://api.weather.gov/points/' + lat.toFixed(4) + ',' + lon.toFixed(4), 12000);
    const z = /\/([A-Z]{2})C(\d{3})$/.exec((j && j.properties && j.properties.county) || '');
    return z && FIPS[z[1]] ? '0' + FIPS[z[1]] + z[2] : null;
  } catch (e) { return null; }
}

async function localFor(lat, lon) {
  if (!streams.length) await refresh();
  const list = streams.filter((s) => isFinite(s.lat) && isFinite(s.lon));
  if (!list.length) return null;
  const by = (a, b) => a.d - b.d;
  const near = list.map((s) => ({ s, d: miles(lat, lon, s.lat, s.lon) })).sort(by);
  const same = await countyOf(lat, lon);
  const covers = same ? near.filter((x) => x.s.same.includes(same)) : [];
  const pick = covers[0] || near[0];
  return { call: pick.s.call, by: covers.length ? 'county' : 'nearest', miles: Math.round(pick.d), county: same || undefined };
}

function mount(app) {
  setTimeout(() => refresh(true), 5000);
  setInterval(() => refresh(), STREAM_EVERY);

  // The station list (for the original site's Radio picker)
  app.get('/api/wxradio', (req, res) => {
    const list = stations();
    res.set('Cache-Control', 'public, max-age=120');
    res.json({ updatedAt: streamsAt ? new Date(streamsAt).toISOString() : null, stations: list.map(({ same, ...s }) => s) });
  });

  // Which station is yours. Your location is rounded to about a mile and isn't kept anywhere
  // but this memory cache, which forgets it within a day.
  app.get('/api/wxradio/local', async (req, res) => {
    const lat = Math.round(parseFloat(req.query.lat) * 100) / 100, lon = Math.round(parseFloat(req.query.lon) * 100) / 100;
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return res.status(400).json({ error: 'lat and lon required' });
    const key = lat + ',' + lon, hit = localMemo.get(key);
    if (hit && Date.now() - hit.at < TX_EVERY) return res.json(hit.result);
    try {
      const result = (await localFor(lat, lon)) || { call: null };
      if (result.call) { localMemo.set(key, { result, at: Date.now() }); if (localMemo.size > 5000) localMemo.delete(localMemo.keys().next().value); }
      res.set('Cache-Control', 'private, max-age=3600');
      res.json(result);
    } catch (e) { res.status(502).json({ error: 'Weather radio list unavailable' }); }
  });
}

module.exports = { mount, stations, refresh, parseName, miles, _set(s, t) { streams = s; tx = t || tx; streamsAt = Date.now(); } };
