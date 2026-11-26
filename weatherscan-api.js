// WeatherTV — Weatherscan data translator — updated 2026-11-26T22:30:00Z build.1795732200
//
// Weatherscan v2 (Mist Weather Media, GPL-3.0; self-hosted at /weatherscan/) was written for The
// Weather Company's paid API (api.weather.com/v3/...). Our copy asks THIS server instead
// (/wxapi/v3/...), and we answer in the same shapes from free public sources:
//   • NWS (api.weather.gov)            — forecast wording (US), alerts, observing stations, airport codes
//   • Open-Meteo (api.open-meteo.com)  — current conditions, hourly and daily numbers (worldwide)
//   • Open-Meteo archive               — normal and record highs/lows (almanac)
//   • Open-Meteo air quality           — US AQI and the main pollutant; UV and watering needs from the forecast
//   • Open-Meteo / Nominatim geocoding — finding a place by name or ZIP
// No weather.com keys, nothing from viewers' browsers goes anywhere but here. Everything is
// cached in memory by rounded location, so a room full of Weatherscans costs a few calls.
'use strict';

const UA = { 'User-Agent': 'WeatherTV/1.0 (watchweathertv.com, contact@altruisticapps.com)' };
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

// ── tiny cache ──────────────────────────────────────────────────────────────
const store = new Map();
function cached(key, ttl, fn) {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.p;
  const p = Promise.resolve().then(fn).catch((e) => { store.delete(key); throw e; });
  store.set(key, { at: Date.now(), p });
  if (store.size > 20000) store.delete(store.keys().next().value);
  return p;
}
async function getJson(url, ms, accept) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms || 15000);
  try {
    const r = await fetch(url, { headers: { ...UA, Accept: accept || 'application/json' }, signal: ctl.signal });
    if (!r.ok) { const e = new Error('HTTP ' + r.status + ' ' + url); e.status = r.status; throw e; }
    return await r.json();
  } finally { clearTimeout(t); }
}
const r2 = (x) => Math.round(x * 100) / 100;
const num = (x) => (x == null || x === '' || !isFinite(+x) ? null : +x);

// ── places ──────────────────────────────────────────────────────────────────
const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico', GU: 'Guam', VI: 'U.S. Virgin Islands' };
const STATE_CODE = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [v.toLowerCase(), k]));

// The weather.com location IDs in Weatherscan's own settings (travel, international maps): where they are
const LOCID = {
  'USIL0225': [41.88, -87.63], 'USIL0228': [41.88, -87.63], 'USTX0327': [32.78, -96.80], 'USTX0617': [29.76, -95.37], 'USFL0228': [30.33, -81.66],
  'USCA0090': [34.05, -118.24], 'USNY0996': [40.71, -74.01], 'USNY0998': [40.71, -74.01], 'USPA1276': [39.95, -75.17], 'USAZ0166': [33.45, -112.07],
  'USTX1200': [29.42, -98.49], 'USCA0982': [32.72, -117.16], 'USGA0028': [33.75, -84.39], 'USMA0046': [42.36, -71.06], 'USFL0372': [28.54, -81.38],
  'USDC0001': [38.90, -77.04], 'USCA0987': [37.77, -122.42], 'USPR0062': [18.47, -66.11],
  'CAXX0109': [64.06, -139.43], 'CAXX0557': [62.45, -114.37], 'CAXX0078': [58.77, -94.17], 'CAXX0574': [53.55, -64.01], 'CAXX0518': [49.28, -123.12],
  'CAXX0126': [53.55, -113.49], 'CAXX0547': [49.90, -97.14], 'CAXX0301': [45.50, -73.57], 'CAXX0504': [43.65, -79.38],
  'MXSR0019': [27.92, -110.90], 'MXNL0068': [25.69, -100.32], 'MXMO0826': [24.14, -110.31], 'MXDF0021': [19.43, -99.13], 'MXQR0112': [21.16, -86.85],
  'BFXX0005': [25.05, -77.35], 'JMXX0002': [17.97, -76.79], '19019': [14.07, -87.19], 'AAXX0002': [12.52, -70.03],
  'BRXX0717': [-3.12, -60.02], 'BRXX0554': [-8.05, -34.88], 'PEXX0003': [-12.05, -77.04], 'BRXX0043': [-15.79, -47.88], 'CIXX3066': [-33.45, -70.67], 'ARXX1012': [-34.60, -58.38],
  'UKXX0800': [55.95, -3.19], 'EIXX0014': [53.35, -6.26], 'UKXX1382': [53.48, -2.24], 'EIXX0011': [51.90, -8.47], 'UKXX1822': [51.51, -0.13],
  'GMXX2985': [52.52, 13.40], 'RSXX0065': [55.76, 37.62], 'FRXX0007': [48.86, 2.35], 'HUXX0016': [47.50, 19.04], 'SPXX0005': [40.42, -3.70], 'ITXX0021': [41.90, 12.50], 'TUXX0024': [41.01, 28.98],
  '22049': [14.72, -17.47], 'NIXX0195': [9.08, 7.40], 'EGXX2875': [30.04, 31.24], 'SAXX0018': [24.71, 46.68], 'KEXX3769': [-1.29, 36.82], 'AOXX0009': [-8.84, 13.23], 'MZXX0003': [-25.97, 32.57],
  'PKXX2599': [24.86, 67.01], 'INXX0096': [28.61, 77.21], 'INXX0028': [22.57, 88.36], 'INXX0087': [19.08, 72.88], 'INXX0202': [13.08, 80.27], 'BMXX0004': [16.87, 96.20],
  'CHXX0012': [39.90, 116.41], 'KSXX6909': [37.57, 126.98], 'JAXX0111': [35.68, 139.69], 'CHXX1544': [29.56, 106.55], 'CHXX1063': [31.23, 121.47], 'CHXX2259': [23.13, 113.26],
  'SNXX0149': [1.35, 103.82], 'RPXX0830': [7.19, 125.46], 'PPXX6688': [-9.44, 147.18], 'FJXX0093': [-18.14, 178.44],
  'HKXX0049': [22.32, 114.17], 'NLXX0313': [52.37, 4.90], 'HOXX0017': [14.07, -87.19], 'USNJ0355': [40.06, -74.41],
  'ASXX0002': [-23.70, 133.88], 'ASXX0089': [-31.95, 115.86], 'ASXX0112': [-33.87, 151.21], 'ASXX0092': [-20.31, 118.58], 'ASXX6680': [-19.26, 146.82], 'ASXX0228': [-33.33, 115.64], 'ASXX1157': [-37.81, 144.96],
};

// NWS: the point → office, forecast URL, city/state, time zone, county, stations (US only)
function nwsPoint(lat, lon) {
  return cached('pt:' + r2(lat) + ',' + r2(lon), DAY, async () => {
    try { return (await getJson('https://api.weather.gov/points/' + r2(lat) + ',' + r2(lon), 12000, 'application/geo+json')).properties || null; }
    catch (e) { if (e.status === 404) return null; throw e; }        // 404 = outside the US
  });
}
function nwsStation(id) {
  return cached('st:' + id, 7 * DAY, async () => {
    const j = await getJson('https://api.weather.gov/stations/' + encodeURIComponent(id), 12000, 'application/geo+json');
    const c = (j.geometry && j.geometry.coordinates) || [];
    return { id: j.properties.stationIdentifier, name: j.properties.name, lat: c[1], lon: c[0], tz: j.properties.timeZone };
  });
}
function nwsStationsNear(lat, lon) {
  return cached('stn:' + r2(lat) + ',' + r2(lon), DAY, async () => {
    const p = await nwsPoint(lat, lon); if (!p || !p.observationStations) return [];
    const j = await getJson(p.observationStations, 15000, 'application/geo+json');
    return (j.features || []).map((f) => ({ id: f.properties.stationIdentifier, name: f.properties.name, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], tz: f.properties.timeZone }));
  });
}
function miles(aLat, aLon, bLat, bLon) {
  const R = 3958.8, k = Math.PI / 180, dLat = (bLat - aLat) * k, dLon = (bLon - aLon) * k;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * k) * Math.cos(bLat * k) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// A place's name and time zone (US: the NWS's nearest town; elsewhere: Open-Meteo's)
async function placeAt(lat, lon, hint) {
  const p = await nwsPoint(lat, lon).catch(() => null);
  if (p && p.relativeLocation) {
    const rl = p.relativeLocation.properties || {};
    return { city: hint || rl.city, st: rl.state, country: 'United States', cc: 'US', tz: p.timeZone, county: p.county };
  }
  const om = await openMeteo(lat, lon).catch(() => null);
  return { city: hint || (r2(lat) + ', ' + r2(lon)), st: '', country: '', cc: '', tz: (om && om.timezone) || 'UTC' };
}
function locObj(lat, lon, pl, extra) {
  return Object.assign({
    latitude: r2(lat), longitude: r2(lon), city: pl.city, locale: { locale1: null, locale2: pl.city, locale3: null, locale4: null },
    neighborhood: null, adminDistrict: STATES[pl.st] || pl.st || null, adminDistrictCode: pl.st || null, postalCode: null, postalKey: null,
    country: pl.country, countryCode: pl.cc, ianaTimeZone: pl.tz, displayName: pl.city, dstEnd: null, dstStart: null, dmaCd: null,
    placeId: 'wtv-' + r2(lat) + '_' + r2(lon), disputedArea: false, canonicalCityId: null, countyId: null, locId: '@' + r2(lat) + ',' + r2(lon) + ':1:' + (pl.cc || 'XX'),
    locationCategory: null, pollenId: null, pwsId: null, regionalSatellite: null, tideId: null, type: 'city', zoneId: null,
  }, extra || {});
}
// Weatherscan keeps each place as an "icaoCode". Where there's no real station (outside the US),
// we hand it a made-up code that carries the coordinates: "@lat,lon".
async function icaoFor(lat, lon) {
  const list = await nwsStationsNear(lat, lon).catch(() => []);
  const s = list.find((x) => /^[A-Z][A-Z0-9]{3}$/.test(x.id));
  return s ? s.id : '@' + r2(lat) + ',' + r2(lon);
}
async function coordsOfCode(code) {
  code = String(code || '').trim();
  const g = /^@?(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/.exec(code);
  if (g) return { lat: +g[1], lon: +g[2] };
  if (/^[A-Z0-9]{3,5}$/i.test(code)) { const s = await nwsStation(code.toUpperCase()); return { lat: s.lat, lon: s.lon, station: s }; }
  throw Object.assign(new Error('unknown place ' + code), { status: 404 });
}
// geocode=lat,lon · icaoCode=KMKE or @lat,lon · iataCode=MKE · locid=USIL0225:1:US
async function whereFrom(q) {
  if (q.geocode) { const [a, b] = String(q.geocode).split(',').map(Number); if (isFinite(a) && isFinite(b)) return { lat: a, lon: b }; }
  if (q.icaoCode) return coordsOfCode(q.icaoCode);
  if (q.iataCode) return coordsOfCode((String(q.iataCode).length === 3 ? 'K' : '') + q.iataCode);
  const id = String(q.locid || q.locId || q.placeid || '').split(':')[0];
  if (id) {
    if (id.startsWith('@')) return coordsOfCode(id);
    if (LOCID[id]) return { lat: LOCID[id][0], lon: LOCID[id][1] };
  }
  throw Object.assign(new Error('no location'), { status: 400 });
}

async function search(query) {
  query = String(query || '').trim();
  // "lat,lon" or "lat,lon;Name" (how Weather TV opens it)
  const g = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)(?:;(.*))?$/.exec(query);
  let hits = [];
  if (g) hits = [{ lat: +g[1], lon: +g[2], name: (g[3] || '').trim() || null }];
  else if (/^\d{5}$/.test(query)) {                                   // a US ZIP code
    const j = await getJson('https://nominatim.openstreetmap.org/search?format=json&countrycodes=us&limit=1&postalcode=' + query);
    hits = (j || []).map((x) => ({ lat: +x.lat, lon: +x.lon, name: null }));
  } else {
    const parts = query.split(',').map((s) => s.trim()).filter(Boolean);
    const name = parts[0], qual = (parts[1] || '').toLowerCase();
    const j = await getJson('https://geocoding-api.open-meteo.com/v1/search?count=20&language=en&format=json&name=' + encodeURIComponent(name));
    let res = j.results || [];
    if (qual) {
      const want = STATES[qual.toUpperCase()] ? STATES[qual.toUpperCase()].toLowerCase() : qual;
      const m = res.filter((r) => [r.admin1, r.country, r.country_code].some((x) => String(x || '').toLowerCase() === want));
      if (m.length) res = m;
    }
    hits = res.slice(0, 5).map((r) => ({ lat: r.latitude, lon: r.longitude, name: r.name, tz: r.timezone, st: r.country_code === 'US' ? STATE_CODE[String(r.admin1 || '').toLowerCase()] : r.admin1, cc: r.country_code, country: r.country }));
  }
  const out = await Promise.all(hits.slice(0, 5).map(async (h) => {
    const pl = await placeAt(h.lat, h.lon, h.name);
    if (h.tz && !pl.tz) pl.tz = h.tz;
    if (h.cc && !pl.cc) { pl.cc = h.cc; pl.country = h.country; pl.st = h.st || ''; }
    return locObj(h.lat, h.lon, pl, { icaoCode: await icaoFor(h.lat, h.lon), address: [pl.city, pl.st || pl.country].filter(Boolean).join(', ') });
  }));
  // weather.com's search answers with one array per field
  const keys = Object.keys(out[0] || locObj(0, 0, { city: '', tz: 'UTC' }, { icaoCode: '', address: '' }));
  const loc = {}; keys.forEach((k) => { loc[k] = out.map((o) => o[k]); });
  return { location: loc };
}

// ── weather (Open-Meteo) ────────────────────────────────────────────────────
function openMeteo(lat, lon) {
  return cached('om:' + r2(lat) + ',' + r2(lon), 10 * MIN, () => getJson('https://api.open-meteo.com/v1/forecast?latitude=' + r2(lat) + '&longitude=' + r2(lon)
    + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,dew_point_2m,uv_index'
    + '&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,precipitation_probability,weather_code,pressure_msl,cloud_cover,visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index,is_day'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_probability_max,precipitation_sum,snowfall_sum,wind_speed_10m_max,wind_direction_10m_dominant,et0_fao_evapotranspiration'
    + '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&forecast_days=9&past_days=1'));
}
const CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const card = (deg) => (deg == null ? 'CALM' : CARD[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]);
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function offsetStr(sec) { const s = sec < 0 ? '-' : '+', a = Math.abs(sec); return s + String(Math.floor(a / 3600)).padStart(2, '0') + ':' + String(Math.floor(a % 3600 / 60)).padStart(2, '0'); }
const localIso = (t, om) => (t.length === 16 ? t + ':00' : t) + offsetStr(om.utc_offset_seconds || 0);   // "2026-11-26T13:00" → "2026-11-26T13:00:00-06:00"
const dowOf = (ymd) => DOW[new Date(ymd.slice(0, 10) + 'T12:00:00Z').getUTCDay()];
const gmt = (t, om) => Math.round(new Date(localIso(t, om)).getTime() / 1000);

// WMO weather code → The Weather Channel's icon codes. Current conditions and forecasts use two
// different code tables in Weatherscan, so there are two maps.
function obsCode(w, day) {
  w = +w;
  if (w === 0) return day ? 3200 : 3100;
  if (w === 1) return day ? 3400 : 3300;
  if (w === 2) return day ? 3000 : 2900;
  if (w === 3) return 2600;
  if (w === 45 || w === 48) return 2000;
  if (w >= 51 && w <= 55) return 900;
  if (w === 56 || w === 57) return 800;
  if (w >= 61 && w <= 65) return 1200;
  if (w === 66 || w === 67) return 1000;
  if (w >= 71 && w <= 77) return 1600;
  if (w >= 80 && w <= 82) return 1100;
  if (w === 85 || w === 86) return 1400;
  if (w >= 95) return 400;
  return day ? 3000 : 2900;
}
function fcstCode(w, day, pop) {
  w = +w; pop = pop == null ? 100 : +pop;
  if (w === 0) return day ? 3200 : 3100;
  if (w === 1) return day ? 3400 : 3300;
  if (w === 2) return day ? 3000 : 2900;
  if (w === 3) return 2600;
  if (w === 45 || w === 48) return 2000;
  if (w >= 51 && w <= 55) return 900;
  if (w === 56 || w === 57) return 800;
  if (w === 61 || w === 63) return pop < 30 ? 4600 : 1200;
  if (w === 65) return 4000;
  if (w === 66 || w === 67) return 1000;
  if (w === 71) return pop < 40 ? 1300 : 1600;
  if (w === 73 || w === 77) return 1600;
  if (w === 75) return 4200;
  if (w === 80) return pop < 30 ? 4600 : pop < 60 ? 3900 : 1100;
  if (w === 81 || w === 82) return pop < 60 ? 3900 : 1100;
  if (w === 85) return pop < 30 ? 4700 : 4100;
  if (w === 86) return 1400;
  if (w === 95) return pop < 60 ? 3800 : 400;
  if (w >= 96) return 400;
  return day ? 3000 : 2900;
}
const PHRASE = { 3200: 'Sunny', 3100: 'Clear', 3400: 'Mostly Sunny', 3300: 'Mostly Clear', 3000: 'Partly Cloudy', 2900: 'Partly Cloudy', 2800: 'Mostly Cloudy', 2700: 'Mostly Cloudy', 2600: 'Cloudy',
  2000: 'Fog', 900: 'Drizzle', 800: 'Freezing Drizzle', 1200: 'Rain', 4600: 'Few Showers', 4000: 'Heavy Rain', 1000: 'Freezing Rain', 1300: 'Flurries', 1600: 'Snow', 4200: 'Heavy Snow',
  3900: 'Scattered Showers', 1100: 'Showers', 4700: 'Few Snow Showers', 4100: 'Scattered Snow Showers', 1400: 'Snow Showers', 3800: 'Scattered Thunderstorms', 400: 'Thunderstorms' };
const SHORT = { 'Scattered Showers': "Sct'd Showers", 'Scattered Thunderstorms': "Sct'd T-Storms", Thunderstorms: 'T-Storms', 'Scattered Snow Showers': "Sct'd Snow Shwrs", 'Freezing Drizzle': 'Frz Drizzle', 'Freezing Rain': 'Frz Rain' };
const phrase = (code) => PHRASE[code] || 'Cloudy';
const shortPhrase = (code) => SHORT[phrase(code)] || phrase(code);
const icon = (ext) => Math.floor(ext / 100);
const uvDesc = (u) => (u == null ? null : u < 3 ? 'Low' : u < 6 ? 'Moderate' : u < 8 ? 'High' : u < 11 ? 'Very High' : 'Extreme');

// The hour index in Open-Meteo's hourly arrays for "now" (local)
function nowIndex(om) {
  const now = Date.now();
  let k = 0;
  for (let i = 0; i < om.hourly.time.length; i++) { if (gmt(om.hourly.time[i], om) * 1000 <= now) k = i; else break; }
  return k;
}

async function observations(q) {
  const w = await whereFrom(q);
  const om = await openMeteo(w.lat, w.lon), c = om.current, d = om.daily;
  const day = !!c.is_day, ext = obsCode(c.weather_code, day);
  const k = nowIndex(om), H = om.hourly;
  const past = H.pressure_msl.slice(Math.max(0, k - 3), k + 1);
  const dp = past.length > 1 ? past[past.length - 1] - past[0] : 0;
  const t24 = H.temperature_2m.slice(Math.max(0, k - 23), k + 1).filter((x) => x != null);
  const ti = d.time.indexOf(c.time.slice(0, 10));
  const gust = c.wind_gusts_10m != null && c.wind_gusts_10m >= (c.wind_speed_10m || 0) + 9 ? Math.round(c.wind_gusts_10m) : null;
  const spd = Math.round(c.wind_speed_10m || 0);
  return {
    cloudCeiling: null, cloudCoverPhrase: c.cloud_cover > 87 ? 'Cloudy' : c.cloud_cover > 62 ? 'Mostly Cloudy' : c.cloud_cover > 37 ? 'Partly Cloudy' : 'Clear',
    dayOfWeek: dowOf(c.time), dayOrNight: day ? 'D' : 'N', expirationTimeUtc: Math.round(Date.now() / 1000) + 600,
    iconCode: icon(ext), iconCodeExtend: ext, obsQualifierCode: null, obsQualifierSeverity: null, precip1Hour: 0, precip6Hour: 0, precip24Hour: 0,
    pressureAltimeter: Math.round((c.pressure_msl || 1013.25) * 0.02953 * 100) / 100, pressureChange: Math.round(dp * 0.02953 * 100) / 100,
    pressureMeanSeaLevel: Math.round(c.pressure_msl || 1013), pressureTendencyCode: Math.abs(dp) < 0.5 ? 0 : dp > 0 ? 1 : 2,
    pressureTendencyTrend: Math.abs(dp) < 0.5 ? 'Steady' : dp > 0 ? 'Rising' : 'Falling',
    relativeHumidity: Math.round(c.relative_humidity_2m), snow1Hour: 0, snow6Hour: 0, snow24Hour: 0,
    sunriseTimeLocal: ti >= 0 ? localIso(d.sunrise[ti], om) : null, sunsetTimeLocal: ti >= 0 ? localIso(d.sunset[ti], om) : null,
    sunriseTimeUtc: ti >= 0 ? gmt(d.sunrise[ti], om) : null, sunsetTimeUtc: ti >= 0 ? gmt(d.sunset[ti], om) : null,
    temperature: Math.round(c.temperature_2m), temperatureChange24Hour: null, temperatureDewPoint: Math.round(c.dew_point_2m),
    temperatureFeelsLike: Math.round(c.apparent_temperature), temperatureHeatIndex: Math.round(Math.max(c.temperature_2m, c.apparent_temperature)),
    temperatureMax24Hour: t24.length ? Math.round(Math.max(...t24)) : null, temperatureMaxSince7Am: null, temperatureMin24Hour: t24.length ? Math.round(Math.min(...t24)) : null,
    temperatureWindChill: Math.round(Math.min(c.temperature_2m, c.apparent_temperature)), uvDescription: uvDesc(c.uv_index), uvIndex: c.uv_index == null ? null : Math.round(c.uv_index),
    validTimeLocal: localIso(c.time, om), validTimeUtc: gmt(c.time, om), visibility: c.visibility == null ? 10 : Math.min(10, Math.round(c.visibility / 1609.34 * 100) / 100),
    windDirection: spd ? Math.round(c.wind_direction_10m) : null, windDirectionCardinal: spd ? card(c.wind_direction_10m) : 'CALM', windGust: gust, windSpeed: spd,
    wxPhraseLong: phrase(ext), wxPhraseMedium: phrase(ext), wxPhraseShort: shortPhrase(ext),
  };
}

// NWS forecast periods (US): the forecast wording
function nwsForecast(lat, lon) {
  return cached('nf:' + r2(lat) + ',' + r2(lon), 30 * MIN, async () => {
    const p = await nwsPoint(lat, lon); if (!p || !p.forecast) return null;
    try { return (await getJson(p.forecast, 15000, 'application/geo+json')).properties.periods || null; } catch (e) { return null; }
  });
}
function windWords(dir, lo, hi) {
  if (!hi || hi < 5) return 'Winds light and variable.';
  return 'Winds ' + card(dir) + ' at ' + (lo && lo < hi - 4 ? Math.round(lo / 5) * 5 + ' to ' : '') + Math.round(hi / 5) * 5 + ' mph.';
}
// A forecast sentence where the NWS has none (outside the US)
function madeNarrative(ext, day, temp, pop, dir, wind) {
  return phrase(ext) + '. ' + (day ? 'High ' : 'Low ') + temp + 'F. ' + windWords(dir, wind * 0.6, wind) + (pop >= 20 ? ' Chance of precip ' + Math.round(pop / 10) * 10 + '%.' : '');
}

async function daily(q, days) {
  const w = await whereFrom(q);
  const [om, periods] = await Promise.all([openMeteo(w.lat, w.lon), nwsForecast(w.lat, w.lon).catch(() => null)]);
  const d = om.daily, H = om.hourly;
  const today = om.current.time.slice(0, 10), i0 = Math.max(0, d.time.indexOf(today));
  const n = days + 1, localHour = +om.current.time.slice(11, 13);
  const out = { calendarDayTemperatureMax: [], calendarDayTemperatureMin: [], dayOfWeek: [], expirationTimeUtc: [], moonPhase: [], moonPhaseCode: [], moonPhaseDay: [],
    moonriseTimeLocal: [], moonriseTimeUtc: [], moonsetTimeLocal: [], moonsetTimeUtc: [], narrative: [], qpf: [], qpfSnow: [], sunriseTimeLocal: [], sunriseTimeUtc: [],
    sunsetTimeLocal: [], sunsetTimeUtc: [], temperatureMax: [], temperatureMin: [], validTimeLocal: [], validTimeUtc: [] };
  const dp = { cloudCover: [], dayOrNight: [], daypartName: [], iconCode: [], iconCodeExtend: [], narrative: [], precipChance: [], precipType: [], qpf: [], qpfSnow: [],
    qualifierCode: [], qualifierPhrase: [], relativeHumidity: [], snowRange: [], temperature: [], temperatureHeatIndex: [], temperatureWindChill: [], thunderCategory: [],
    thunderIndex: [], uvDescription: [], uvIndex: [], windDirection: [], windDirectionCardinal: [], windPhrase: [], windSpeed: [], wqxPhraseLong: [], wxPhraseLong: [], wxPhraseShort: [] };
  // Hourly stats for one half of a day (6am–6pm "day", 6pm–6am "night")
  function half(ymd, night) {
    const hs = [];
    H.time.forEach((t, i) => {
      const date = t.slice(0, 10), h = +t.slice(11, 13);
      const next = new Date(Date.parse(ymd + 'T12:00:00Z') + DAY).toISOString().slice(0, 10);
      if (!night ? (date === ymd && h >= 6 && h < 18) : ((date === ymd && h >= 18) || (date === next && h < 6))) hs.push(i);
    });
    const v = (arr, f) => { const x = hs.map((i) => arr[i]).filter((y) => y != null); return x.length ? f(x) : null; };
    const max = (x) => Math.max(...x), min = (x) => Math.min(...x), avg = (x) => x.reduce((a, b) => a + b, 0) / x.length;
    // the most significant weather in the period (highest WMO code wins), like a forecaster would headline it
    const codes = hs.map((i) => H.weather_code[i]).filter((y) => y != null);
    const sig = codes.filter((c) => c >= 45);
    const wcode = sig.length ? Math.max(...sig) : codes.length ? Math.round(avg(codes)) : 3;
    return { wcode, pop: v(H.precipitation_probability, max) || 0, t: night ? v(H.temperature_2m, min) : v(H.temperature_2m, max), rh: v(H.relative_humidity_2m, avg),
      cc: v(H.cloud_cover, avg), ws: v(H.wind_speed_10m, max), wl: v(H.wind_speed_10m, min), wd: v(H.wind_direction_10m, avg), uv: v(H.uv_index, max), fl: v(H.apparent_temperature, night ? min : max) };
  }
  for (let j = 0; j < n; j++) {
    const i = i0 + j, ymd = d.time[i];
    if (!ymd) { Object.keys(out).forEach((k) => out[k].push(null)); for (let x = 0; x < 2; x++) Object.keys(dp).forEach((k) => dp[k].push(null)); continue; }
    const hi = Math.round(d.temperature_2m_max[i]), lo = Math.round(d.temperature_2m_min[i]);
    const dayGone = j === 0 && localHour >= 15;                   // like weather.com: after 3 pm, today's day part is gone
    out.calendarDayTemperatureMax.push(hi); out.calendarDayTemperatureMin.push(lo); out.dayOfWeek.push(dowOf(ymd)); out.expirationTimeUtc.push(Math.round(Date.now() / 1000) + 1800);
    out.moonPhase.push(null); out.moonPhaseCode.push(null); out.moonPhaseDay.push(null); out.moonriseTimeLocal.push(null); out.moonriseTimeUtc.push(null); out.moonsetTimeLocal.push(null); out.moonsetTimeUtc.push(null);
    out.qpf.push(Math.round((d.precipitation_sum[i] || 0) * 100) / 100); out.qpfSnow.push(Math.round((d.snowfall_sum[i] || 0) / 2.54 * 10) / 10);
    out.sunriseTimeLocal.push(localIso(d.sunrise[i], om)); out.sunriseTimeUtc.push(gmt(d.sunrise[i], om)); out.sunsetTimeLocal.push(localIso(d.sunset[i], om)); out.sunsetTimeUtc.push(gmt(d.sunset[i], om));
    out.temperatureMax.push(dayGone ? null : hi); out.temperatureMin.push(lo); out.validTimeLocal.push(localIso(ymd + 'T07:00', om)); out.validTimeUtc.push(gmt(ymd + 'T07:00', om));
    const dname = j === 0 ? 'Today' : j === 1 ? 'Tomorrow' : dowOf(ymd);
    const nname = j === 0 ? 'Tonight' : (j === 1 ? 'Tomorrow' : dowOf(ymd)) + ' night';
    const parts = [];
    [false, true].forEach((night) => {
      const s = half(ymd, night), ext = fcstCode(s.wcode, !night, s.pop);
      const temp = Math.round(s.t != null ? s.t : night ? lo : hi);
      const nws = periods && periods.find((p) => p.startTime.slice(0, 10) === ymd && p.isDaytime === !night)
        || (periods && night && periods.find((p) => !p.isDaytime && p.startTime.slice(0, 10) === ymd));
      const text = nws ? nws.detailedForecast : madeNarrative(ext, !night, temp, s.pop, s.wd, s.ws || 0);
      parts.push(text);
      const gone = !night && dayGone;
      dp.cloudCover.push(gone ? null : Math.round(s.cc || 0)); dp.dayOrNight.push(gone ? null : night ? 'N' : 'D'); dp.daypartName.push(gone ? null : night ? nname : dname);
      dp.iconCode.push(gone ? null : icon(ext)); dp.iconCodeExtend.push(gone ? null : ext); dp.narrative.push(gone ? null : text);
      dp.precipChance.push(gone ? null : Math.round(s.pop / 10) * 10); dp.precipType.push(gone ? null : s.wcode >= 71 && s.wcode <= 77 || s.wcode >= 85 && s.wcode <= 86 ? 'snow' : 'rain');
      dp.qpf.push(gone ? null : 0); dp.qpfSnow.push(gone ? null : 0); dp.qualifierCode.push(null); dp.qualifierPhrase.push(null);
      dp.relativeHumidity.push(gone ? null : Math.round(s.rh || 0)); dp.snowRange.push(gone ? null : '');
      dp.temperature.push(gone ? null : temp); dp.temperatureHeatIndex.push(gone ? null : Math.round(Math.max(temp, s.fl != null ? s.fl : temp)));
      dp.temperatureWindChill.push(gone ? null : Math.round(Math.min(temp, s.fl != null ? s.fl : temp)));
      dp.thunderCategory.push(null); dp.thunderIndex.push(gone ? null : s.wcode >= 95 ? 2 : 0);
      dp.uvDescription.push(gone ? null : uvDesc(night ? 0 : s.uv)); dp.uvIndex.push(gone ? null : night ? 0 : Math.round(s.uv || 0));
      dp.windDirection.push(gone ? null : Math.round(s.wd || 0)); dp.windDirectionCardinal.push(gone ? null : card(s.wd || 0));
      dp.windPhrase.push(gone ? null : windWords(s.wd, s.wl, s.ws)); dp.windSpeed.push(gone ? null : Math.round(s.ws || 0));
      dp.wqxPhraseLong.push(gone ? null : phrase(ext)); dp.wxPhraseLong.push(gone ? null : phrase(ext)); dp.wxPhraseShort.push(gone ? null : shortPhrase(ext));
    });
    out.narrative.push(parts.join(' '));
  }
  out.daypart = [dp];
  return out;
}

async function hourly(q, hours) {
  const w = await whereFrom(q);
  const om = await openMeteo(w.lat, w.lon), H = om.hourly;
  const k = nowIndex(om) + 1;
  const out = { cloudCover: [], dayOfWeek: [], dayOrNight: [], expirationTimeUtc: [], iconCode: [], iconCodeExtend: [], precipChance: [], precipType: [], pressureMeanSeaLevel: [],
    qpf: [], qpfSnow: [], relativeHumidity: [], temperature: [], temperatureDewPoint: [], temperatureFeelsLike: [], temperatureHeatIndex: [], temperatureWindChill: [],
    uvDescription: [], uvIndex: [], validTimeLocal: [], validTimeUtc: [], visibility: [], windDirection: [], windDirectionCardinal: [], windGust: [], windSpeed: [],
    wxPhraseLong: [], wxPhraseShort: [], wxSeverity: [] };
  for (let i = k; i < k + hours && i < H.time.length; i++) {
    const day = !!H.is_day[i], ext = fcstCode(H.weather_code[i], day, H.precipitation_probability[i]);
    out.cloudCover.push(Math.round(H.cloud_cover[i] || 0)); out.dayOfWeek.push(dowOf(H.time[i])); out.dayOrNight.push(day ? 'D' : 'N'); out.expirationTimeUtc.push(Math.round(Date.now() / 1000) + 900);
    out.iconCode.push(icon(ext)); out.iconCodeExtend.push(ext); out.precipChance.push(Math.round((H.precipitation_probability[i] || 0) / 10) * 10);
    out.precipType.push(H.weather_code[i] >= 71 && H.weather_code[i] <= 77 ? 'snow' : 'rain'); out.pressureMeanSeaLevel.push(Math.round((H.pressure_msl[i] || 1013) * 0.02953 * 100) / 100);
    out.qpf.push(0); out.qpfSnow.push(0); out.relativeHumidity.push(Math.round(H.relative_humidity_2m[i] || 0)); out.temperature.push(Math.round(H.temperature_2m[i]));
    out.temperatureDewPoint.push(Math.round(H.dew_point_2m[i])); out.temperatureFeelsLike.push(Math.round(H.apparent_temperature[i]));
    out.temperatureHeatIndex.push(Math.round(Math.max(H.temperature_2m[i], H.apparent_temperature[i]))); out.temperatureWindChill.push(Math.round(Math.min(H.temperature_2m[i], H.apparent_temperature[i])));
    out.uvDescription.push(uvDesc(H.uv_index[i])); out.uvIndex.push(Math.round(H.uv_index[i] || 0)); out.validTimeLocal.push(localIso(H.time[i], om)); out.validTimeUtc.push(gmt(H.time[i], om));
    out.visibility.push(H.visibility[i] == null ? 10 : Math.min(10, Math.round(H.visibility[i] / 1609.34 * 100) / 100));
    out.windDirection.push(Math.round(H.wind_direction_10m[i] || 0)); out.windDirectionCardinal.push(card(H.wind_direction_10m[i] || 0));
    out.windGust.push(H.wind_gusts_10m[i] != null && H.wind_gusts_10m[i] >= (H.wind_speed_10m[i] || 0) + 9 ? Math.round(H.wind_gusts_10m[i]) : null); out.windSpeed.push(Math.round(H.wind_speed_10m[i] || 0));
    out.wxPhraseLong.push(phrase(ext)); out.wxPhraseShort.push(shortPhrase(ext)); out.wxSeverity.push(1);
  }
  return out;
}

// ── health and garden ───────────────────────────────────────────────────────
// Air quality (US AQI) from Open-Meteo's air-quality service
function airQuality(lat, lon) {
  return cached('aq:' + r2(lat) + ',' + r2(lon), 30 * MIN, () => getJson('https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + r2(lat) + '&longitude=' + r2(lon)
    + '&current=us_aqi,us_aqi_pm2_5,us_aqi_pm10,us_aqi_nitrogen_dioxide,us_aqi_ozone,us_aqi_sulphur_dioxide,us_aqi_carbon_monoxide&timezone=auto'));
}
async function globalAirQuality(q) {
  const w = await whereFrom(q), j = await airQuality(w.lat, w.lon), c = j.current || {};
  if (c.us_aqi == null) throw Object.assign(new Error('no air quality here'), { status: 404 });
  const parts = { 'PM2.5': c.us_aqi_pm2_5, PM10: c.us_aqi_pm10, NO2: c.us_aqi_nitrogen_dioxide, O3: c.us_aqi_ozone, SO2: c.us_aqi_sulphur_dioxide, CO: c.us_aqi_carbon_monoxide };
  const main = Object.keys(parts).filter((k) => parts[k] != null).sort((a, b) => parts[b] - parts[a])[0] || 'O3';
  const aqi = Math.round(c.us_aqi), cat = aqi <= 50 ? 1 : aqi <= 100 ? 2 : aqi <= 150 ? 3 : aqi <= 200 ? 4 : aqi <= 300 ? 5 : 6;
  return { metadata: { latitude: r2(w.lat), longitude: r2(w.lon) }, globalairquality: {
    airQualityIndex: aqi, airQualityCategoryIndex: [0, 0, 2, 4, 6, 6, 8][cat], /* Weatherscan halves this onto its 5-step scale */ airQualityCategory: ['', 'Good', 'Moderate', 'Unhealthy for Sensitive Groups', 'Unhealthy', 'Very Unhealthy', 'Hazardous'][cat],
    airQualityCategoryIndexColor: ['', '00E400', 'FFFF00', 'FF7E00', 'FF0000', '8F3F97', '7E0023'][cat], primaryPollutant: main, source: 'Open-Meteo (CAMS)', disclaimer: null,
    expireTimeGmt: Math.round(Date.now() / 1000) + 3600, messages: {} } };
}
// UV index for the next 48 hours, hour by hour
async function uvHourly(q) {
  const w = await whereFrom(q), om = await openMeteo(w.lat, w.lon), H = om.hourly, k = nowIndex(om) + 1;
  const out = { fcstValidLocal: [], fcstValid: [], uvIndex: [], uvDesc: [], dow: [], uvWarning: [] };
  for (let i = k; i < k + 48 && i < H.time.length; i++) {
    const u = Math.round(H.uv_index[i] || 0);
    out.fcstValidLocal.push(localIso(H.time[i], om)); out.fcstValid.push(gmt(H.time[i], om)); out.uvIndex.push(u); out.uvDesc.push(uvDesc(u)); out.dow.push(dowOf(H.time[i])); out.uvWarning.push(0);
  }
  return { uvIndex1hour: out };
}
// Watering needs, 0–10, for each half-day: how much water plants lose to the air
// (FAO-56 reference evapotranspiration) minus the rain that falls, over that day and the next.
// It's 0 when nothing is growing (highs under 40°F). Low ≤3, Moderate 4–7, High 8–10.
async function wateringNeeds(q, days) {
  const w = await whereFrom(q), om = await openMeteo(w.lat, w.lon), d = om.daily;
  const i0 = Math.max(0, d.time.indexOf(om.current.time.slice(0, 10)));
  const out = { fcstValidLocal: [], dayInd: [], num: [], daypartName: [], wateringNeedsIndex: [], wateringNeedsCategory: [] };
  const night = +om.current.time.slice(11, 13) >= 18;
  for (let j = 0; j < days; j++) for (let h = 0; h < 2; h++) {
    if (j === 0 && h === 0 && night) continue;                      // like weather.com: tonight first after 6 pm
    const i = i0 + j; if (!d.time[i]) break;
    const et = (d.et0_fao_evapotranspiration[i] || 0) + (d.et0_fao_evapotranspiration[i + 1] || 0);   // mm, two days
    const rain = ((d.precipitation_sum[i] || 0) + (d.precipitation_sum[i + 1] || 0)) * 25.4;          // inches → mm
    let idx = Math.max(0, Math.min(10, Math.round((et - rain) / 1.2)));
    if ((d.temperature_2m_max[i] || 0) < 40) idx = 0;
    out.fcstValidLocal.push(localIso(d.time[i] + (h ? 'T19:00' : 'T07:00'), om)); out.dayInd.push(h ? 'N' : 'D'); out.num.push(out.num.length + 1);
    out.daypartName.push(h ? 'Tonight' : 'Today'); out.wateringNeedsIndex.push(idx); out.wateringNeedsCategory.push(idx <= 3 ? 'Low' : idx <= 7 ? 'Moderate' : 'High');
  }
  return { wateringNeedsIndex12hour: out };
}

// ── almanac: normals (1991–2020) and records, from the Open-Meteo archive ──
function climate(lat, lon) {
  const la = Math.round(lat * 4) / 4, lo = Math.round(lon * 4) / 4;
  return cached('cl:' + la + ',' + lo, 30 * DAY, async () => {
    const end = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
    const j = await getJson('https://archive-api.open-meteo.com/v1/archive?latitude=' + la + '&longitude=' + lo + '&start_date=1980-01-01&end_date=' + end
      + '&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=auto', 60000);
    const byDay = {};                                               // "11-26" → { max:[[t,year]], min:[[t,year]] }
    j.daily.time.forEach((t, i) => {
      const md = t.slice(5), y = +t.slice(0, 4), a = j.daily.temperature_2m_max[i], b = j.daily.temperature_2m_min[i];
      const e = byDay[md] || (byDay[md] = { max: [], min: [] });
      if (a != null) e.max.push([a, y]); if (b != null) e.min.push([b, y]);
    });
    return byDay;
  });
}
async function almanac(q, days) {
  const w = await whereFrom(q), cl = await climate(w.lat, w.lon);
  const now = new Date(), month = +(q.startMonth || now.getMonth() + 1), day = +(q.startDay || now.getDate());
  const out = { almanacInterval: [], almanacRecordDate: [], almanacRecordPeriod: [], almanacRecordYearMax: [], almanacRecordYearMin: [], precipitationAverage: [], snowfallAverage: [],
    stationId: [], stationName: [], temperatureAverageMax: [], temperatureAverageMin: [], temperatureMean: [], temperatureRecordMax: [], temperatureRecordMin: [] };
  for (let k = 0; k < days; k++) {
    const dt = new Date(Date.UTC(2001, month - 1, day) + k * DAY), md = String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
    const e = cl[md] || { max: [], min: [] };
    const normal = (arr) => { const x = arr.filter(([, y]) => y >= 1991 && y <= 2020).map(([t]) => t); return x.length ? Math.round(x.reduce((a, b) => a + b, 0) / x.length) : null; };
    const recMax = e.max.reduce((m, v) => (!m || v[0] > m[0] ? v : m), null), recMin = e.min.reduce((m, v) => (!m || v[0] < m[0] ? v : m), null);
    out.almanacInterval.push('D'); out.almanacRecordDate.push(md.replace('-', '')); out.almanacRecordPeriod.push(null);
    out.almanacRecordYearMax.push(recMax ? recMax[1] : null); out.almanacRecordYearMin.push(recMin ? recMin[1] : null);
    out.precipitationAverage.push(null); out.snowfallAverage.push(null); out.stationId.push(null); out.stationName.push(null);
    const am = normal(e.max), an = normal(e.min);
    out.temperatureAverageMax.push(am); out.temperatureAverageMin.push(an); out.temperatureMean.push(am != null && an != null ? Math.round((am + an) / 2) : null);
    out.temperatureRecordMax.push(recMax ? Math.round(recMax[0]) : null); out.temperatureRecordMin.push(recMin ? Math.round(recMin[0]) : null);
  }
  return out;
}

// ── alerts (NWS) ────────────────────────────────────────────────────────────
function vtecOf(p) {
  const v = ((p.parameters && p.parameters.VTEC) || [])[0] || '';
  const m = /\/[OTEX]\.([A-Z]{3})\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})/.exec(v);
  return m ? { action: m[1], office: m[2], phen: m[3], sig: m[4], etn: m[5] } : {};
}
function alertObj(f) {
  const p = f.properties, v = vtecOf(p);
  const until = p.ends || p.expires;
  const untilTxt = until ? new Date(until).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  return {
    adminDistrict: null, adminDistrictCode: null, areaId: null, areaName: p.areaDesc, areaTypeCode: 'Z', certainty: p.certainty, certaintyCode: null, countryCode: 'US', countryName: 'UNITED STATES OF AMERICA',
    detailKey: Buffer.from(String(p.id || f.id)).toString('base64url'), disclaimer: null, effectiveTimeLocal: p.effective, effectiveTimeLocalTimeZone: null,
    endTimeLocal: p.ends, endTimeLocalTimeZone: null, endTimeUTC: p.ends ? Math.round(Date.parse(p.ends) / 1000) : null, eventDescription: p.event, eventTrackingNumber: v.etn || null,
    expireTimeLocal: p.expires, expireTimeLocalTimeZone: null, expireTimeUTC: p.expires ? Math.round(Date.parse(p.expires) / 1000) : null,
    headlineText: (p.parameters && p.parameters.NWSheadline && p.parameters.NWSheadline[0]) || (p.event + (until ? ' until ' + untilTxt : '')),
    identifier: p.id, issueTimeLocal: p.sent, issueTimeLocalTimeZone: null, latitude: null, longitude: null, messageType: p.messageType, messageTypeCode: p.messageType === 'Update' ? 2 : p.messageType === 'Cancel' ? 3 : 1,
    officeAdminDistrict: null, officeAdminDistrictCode: null, officeCode: v.office || null, officeCountryCode: 'US', officeName: p.senderName, onsetTimeLocal: p.onset,
    phenomena: v.phen || null, processTimeUTC: Math.round(Date.parse(p.sent) / 1000), productIdentifier: null, severity: p.severity, severityCode: { Extreme: 1, Severe: 2, Moderate: 3, Minor: 4 }[p.severity] || 5,
    significance: v.sig || null, source: 'National Weather Service', urgency: p.urgency, urgencyCode: null,
  };
}
function nwsAlerts(lat, lon) {
  return cached('al:' + r2(lat) + ',' + r2(lon), 2 * MIN, async () => {
    const j = await getJson('https://api.weather.gov/alerts/active?point=' + r2(lat) + ',' + r2(lon), 15000, 'application/geo+json');
    return (j.features || []).filter((f) => f.properties && f.properties.status === 'Actual');
  });
}

// ── nearby observation stations / airports (NWS) ───────────────────────────
async function near(q) {
  const w = await whereFrom(q).catch(() => null);
  const empty = { location: { stationName: [], stationId: [], icaoCode: [], iataCode: [], airportName: [], latitude: [], longitude: [], distanceKm: [], distanceMi: [], ianaTimeZone: [], countryCode: [], adminDistrictCode: [], pwsId: [], qcStatus: [], updateTimeUtc: [], partnerId: [] } };
  if (!w) return empty;
  let list = await nwsStationsNear(w.lat, w.lon).catch(() => []);
  list = list.filter((s) => /^[A-Z][A-Z0-9]{3}$/.test(s.id)).map((s) => ({ ...s, d: miles(w.lat, w.lon, s.lat, s.lon) })).sort((a, b) => a.d - b.d);
  if (q.product === 'airport') list = list.filter((s) => /^K[A-Z]{3}$/.test(s.id) && /airport|int'?l|international|field|municipal/i.test(s.name));
  list = list.slice(0, 10);
  const L = empty.location;
  list.forEach((s) => {
    L.stationName.push(s.name); L.stationId.push(s.id); L.icaoCode.push(s.id); L.iataCode.push(/^K[A-Z]{3}$/.test(s.id) ? s.id.slice(1) : null); L.airportName.push(s.name);
    L.latitude.push(r2(s.lat)); L.longitude.push(r2(s.lon)); L.distanceKm.push(Math.round(s.d * 1.609 * 10) / 10); L.distanceMi.push(Math.round(s.d * 10) / 10);
    L.ianaTimeZone.push(s.tz); L.countryCode.push('US'); L.adminDistrictCode.push(null); L.pwsId.push(null); L.qcStatus.push(null); L.updateTimeUtc.push(null); L.partnerId.push(null);
  });
  return empty;
}
async function point(q) {
  const w = await whereFrom(q);
  // A station: name it for the town it's in (the NWS's nearest town to the station)
  const pl = await placeAt(w.lat, w.lon);
  const extra = {};
  if (w.station) {
    extra.icaoCode = w.station.id; extra.iataCode = /^K[A-Z]{3}$/.test(w.station.id) ? w.station.id.slice(1) : null; extra.airportName = w.station.name;
    if (!pl.tz && w.station.tz) pl.tz = w.station.tz;
  } else extra.icaoCode = await icaoFor(w.lat, w.lon);
  return { location: locObj(w.lat, w.lon, pl, extra) };
}

// ── moon phases (mean lunar month from a known new moon; close to the day) ─────
const SYNODIC = 29.530588853, NEW0 = Date.UTC(2000, 0, 6, 18, 14) / DAY;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function lunar(year, month) {
  const first = Date.UTC(year, month - 1, 1) / DAY, days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const marks = {};                                                 // day of month → phase name
  const names = ['New Moon', 'First quarter', 'Full moon', 'Last quarter'];
  const n0 = Math.floor((first - NEW0) / SYNODIC) - 1;
  for (let n = n0; n <= n0 + 2; n++) for (let k = 0; k < 4; k++) {
    const t = NEW0 + (n + k / 4) * SYNODIC - 6 / 24;               // in US Central time, near enough for a date
    const d = Math.floor(t - first) + 1;
    if (d >= 1 && d <= days) marks[d] = names[k];
  }
  const phase = {};
  for (let d = 1; d <= days; d++) {
    const age = (((first + d - 0.5 - NEW0) % SYNODIC) + SYNODIC) % SYNODIC;
    phase[d] = marks[d] ? { phaseName: marks[d], isPhaseLimit: 1, lighting: null } : { phaseName: age < SYNODIC / 2 ? 'Waxing' : 'Waning', isPhaseLimit: false, lighting: null };
  }
  return { monthName: MONTHS[month - 1], year, month, phase };
}
const CRAWL = [
  'Weather TV · free, ad-free weather from Altruistic Apps · watchweathertv.com',
  'Live storm chasers, forecasters and radar, all in one place · watchweathertv.com',
  'Weather data from the National Weather Service and Open-Meteo · radar from NOAA via Iowa State University',
  'Weatherscan recreation by Mist Weather Media · adapted for Weather TV',
];

// ── routes ──────────────────────────────────────────────────────────────────
function mount(app) {
  const send = (fn) => async (req, res) => {
    try {
      const body = await fn(req.query, req);
      if (body == null) return res.status(204).end();
      res.set('Cache-Control', 'public, max-age=120');
      res.json(body);
    } catch (e) {
      const st = e.status && e.status < 500 ? e.status : 502;
      res.status(st).json({ errors: [{ error: { code: 'WTV-' + st, message: e.message } }] });
    }
  };
  const base = '/wxapi';
  app.get(base + '/v3/location/search', send((q) => search(q.query)));
  app.get(base + '/v3/location/point', send(point));
  app.get(base + '/v3/location/near', send(near));
  app.get(base + '/v3/wx/observations/current', send(observations));
  // (regular-expression routes: the same on Express 4 and 5)
  app.get(/^\/wxapi\/v3\/wx\/forecast\/daily\/(\d+)day$/, send((q, req) => daily(q, Math.min(14, +req.params[0]))));
  app.get(/^\/wxapi\/v3\/wx\/forecast\/hourly\/(\d+)day$/, send((q, req) => hourly(q, Math.min(15, +req.params[0]) * 24)));
  app.get(/^\/wxapi\/v3\/wx\/almanac\/daily\/(\d+)day$/, send((q, req) => almanac(q, Math.min(15, +req.params[0]))));
  // Several places' 5- or 7-day forecasts in one go: geocodes=lat,lon;lat,lon
  app.get(base + '/v3/aggcommon/:prod', send(async (q, req) => {
    const m = /^v3-wx-forecast-daily-(\d+)day$/.exec(req.params.prod); if (!m) throw Object.assign(new Error('not supported'), { status: 404 });
    const list = String(q.geocodes || '').split(';').map((s) => s.trim()).filter(Boolean).slice(0, 25);
    return Promise.all(list.map(async (g) => ({ id: g, [req.params.prod]: await daily({ geocode: g }, +m[1]).catch(() => null) })));
  }));
  app.get(base + '/v3/alerts/headlines', send(async (q) => {
    const w = await whereFrom(q); const list = await nwsAlerts(w.lat, w.lon);
    return list.length ? { metadata: { next: null }, alerts: list.map(alertObj) } : null;   // weather.com answers 204 when there are none
  }));
  app.get(base + '/v3/alerts/detail', send(async (q) => {
    let id; try { id = Buffer.from(String(q.alertId || ''), 'base64url').toString(); } catch (e) { id = ''; }
    if (!/^(urn:oid:|https:\/\/api\.weather\.gov\/alerts\/)/.test(id)) throw Object.assign(new Error('unknown alert'), { status: 404 });
    const url = id.startsWith('https://') ? id : 'https://api.weather.gov/alerts/' + encodeURIComponent(id);
    const f = await cached('ad:' + id, 10 * MIN, () => getJson(url, 15000, 'application/geo+json'));
    const a = alertObj(f), p = f.properties;
    a.texts = [{ languageCode: 'en-US', description: p.description || '', instruction: p.instruction || '', overview: p.headline || '' }];
    return { alertDetail: a };
  }));
  app.get(base + '/v3/wx/globalAirQuality', send(globalAirQuality));
  app.get(base + '/v2/indices/uv/hourly/48hour', send(uvHourly));
  app.get(/^\/wxapi\/v2\/indices\/wateringNeeds\/daypart\/(\d+)day$/, send((q, req) => wateringNeeds(q, Math.min(7, +req.params[0]))));
  // Moon phases for a month, in the shape Weatherscan's almanac expects (it used icalendar37.net):
  // { monthName, phase: { "1": { phaseName, isPhaseLimit }, … } } — the four main phases marked.
  app.get(base + '/lunar', send((q) => lunar(+q.year || new Date().getUTCFullYear(), +q.month || new Date().getUTCMonth() + 1)));
  // Weatherscan's "network" crawl lines and version check (it used mistwx.com): ours instead
  app.get(base + '/crawlnetwork.json', send(() => ({ crawls: { scanv2: CRAWL }, simVersions: { scanv2: null } })));
  // US airport delays (FAA NAS Status), which Weatherscan's own server used to pass along
  app.get(base + '/airports', send(() => cached('faa', 5 * MIN, () => getJson('https://nasstatus.faa.gov/api/airport-events', 15000)).catch(() => [])));
  // Anything else Weatherscan asks for (pollen, golf, aches, air quality…) we don't have: say so quietly
  app.use(base, (req, res) => res.status(404).json({ errors: [{ error: { code: 'WTV-404', message: 'Not available' } }] }));
}

module.exports = { mount, _t: { lunar, obsCode, fcstCode, search, observations, daily, hourly, almanac, near, point, offsetStr, localIso } };
