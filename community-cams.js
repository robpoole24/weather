// WeatherTV Community Cams — build.1791090000
//
// Town, beach, harbor and other public webcams that aren't part of any DOT or
// Windy feed — mostly YouTube 24/7 livestreams (embedding is allowed by
// YouTube), plus the occasional public still image.
//
// How cameras get in (nothing appears on the map without an admin approval):
//   1. Admin adds one directly (paste a YouTube/image URL + location).
//   2. Viewers suggest one from the radar ("Suggest a camera") → review queue.
//   3. Discovery searches YouTube for live cams near a place → review queue.
//      On demand from the admin page, or nightly if COMMUNITY_DISCOVERY=true
//      (COMMUNITY_DISCOVERY_PER_NIGHT searches, default 10 → 1,000 quota units).
//
// Staying current: every 20 minutes.
//   • YouTube VIDEO links → YouTube API videos.list, up to 50 per call at 1
//     quota unit per call (~72 units/day). Scraping video pages from a server
//     is unreliable: YouTube often serves datacenter IPs a stripped/"are you a
//     bot" page with no live marker, which read as "offline" (the Greendale bug).
//   • CHANNEL links → the channel's /live page, checked for "isLive":true (the
//     live verifier's proven method, no quota).
//   • If a page can't be read, the result is UNKNOWN, never "offline".
// Streams confirmed offline for 6+ hours are hidden until they come back.
//
// Stream replacement: 24/7 streams end (restarts, new stream keys, YouTube's
// limits) and the owner starts a NEW stream with a new address but nearly the
// same title. When a camera's stream has ended, the owner's channel is checked
// for a live stream with a matching title; if one is found it takes the old
// one's place on the map — same name, same location — automatically.
//
// Watched channels: channels you import are remembered and re-checked every
// night for NEW live streams, which go to the review queue.
// Cost: ~2–4 quota units per channel check (newest uploads + which are live).
//
// Privacy: suggestions store only the camera URL, the location and an optional
// note. No names, emails or IP addresses are kept (rate limiting is in memory).

const STORE_KEY = 'wt:community:v1';
const CHECK_EVERY_MS = 20 * 60 * 1000;
const HIDE_AFTER_OFFLINE_MS = 6 * 3600 * 1000;

const DISCOVERY_PLACES = [
  ['Miami, FL', 25.77, -80.19], ['Key West, FL', 24.56, -81.78], ['Tampa, FL', 27.95, -82.46],
  ['New Orleans, LA', 29.95, -90.07], ['Galveston, TX', 29.30, -94.80], ['Corpus Christi, TX', 27.80, -97.40],
  ['Gulf Shores, AL', 30.25, -87.70], ['Charleston, SC', 32.78, -79.93], ['Myrtle Beach, SC', 33.69, -78.89],
  ['Wilmington, NC', 34.23, -77.94], ['Outer Banks, NC', 35.91, -75.60], ['Virginia Beach, VA', 36.85, -75.98],
  ['Ocean City, MD', 38.34, -75.08], ['Atlantic City, NJ', 39.36, -74.42], ['New York City, NY', 40.71, -74.00],
  ['Boston, MA', 42.36, -71.06], ['Portland, ME', 43.66, -70.26], ['San Juan, PR', 18.47, -66.11],
  ['St. Thomas, USVI', 18.34, -64.93], ['Honolulu, HI', 21.31, -157.86], ['Maui, HI', 20.80, -156.33],
  ['Hilo, HI', 19.71, -155.08], ['Anchorage, AK', 61.22, -149.90], ['Seattle, WA', 47.61, -122.33],
  ['San Diego, CA', 32.72, -117.16], ['Los Angeles, CA', 34.05, -118.24], ['Denver, CO', 39.74, -104.99],
  ['Oklahoma City, OK', 35.47, -97.52], ['Wichita, KS', 37.69, -97.34], ['Omaha, NE', 41.26, -95.93],
  ['Dallas, TX', 32.78, -96.80], ['Houston, TX', 29.76, -95.37], ['Chicago, IL', 41.88, -87.63],
  ['Milwaukee, WI', 43.04, -87.91], ['Minneapolis, MN', 44.98, -93.27], ['Detroit, MI', 42.33, -83.05],
  ['Cleveland, OH', 41.50, -81.69], ['Buffalo, NY', 42.89, -78.88], ['Pittsburgh, PA', 40.44, -80.00],
  ['Nashville, TN', 36.16, -86.78], ['Atlanta, GA', 33.75, -84.39], ['Jacksonville, FL', 30.33, -81.66],
];
const CAM_WORDS = /\b(cam|webcam|live ?view|live ?stream|beach|pier|harbou?r|marina|downtown|main street|skyline|traffic|weather|port|bay|lake|river|boardwalk|surf|island)\b/i;
const NOT_CAM_WORDS = /\b(music|lofi|lo-fi|gaming|gameplay|sermon|church service|podcast|radio|asmr|news|press conference|concert|dj set)\b/i;

// "42.9375° N", "87.9969 W", "-87.99", 42.9 → signed decimal degrees
function parseCoord(v, axis) {
  if (typeof v === 'number') return v;
  const m = String(v || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*°?\s*([NSEW])?$/i);
  if (!m) return NaN;
  let n = parseFloat(m[1]);
  const h = (m[2] || '').toUpperCase();
  if ((h === 'S' && axis === 'lat') || (h === 'W' && axis === 'lng')) n = -Math.abs(n);
  if ((h === 'N' && axis === 'lat') || (h === 'E' && axis === 'lng')) n = Math.abs(n);
  return n;
}

// "Pat&#39;s Pier &amp; Grill" → "Pat's Pier & Grill" (YouTube search + directory
// pages send titles HTML-escaped)
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', hellip: '…', eacute: 'é', egrave: 'è', aacute: 'á', oacute: 'ó', uacute: 'ú', iacute: 'í', ntilde: 'ñ',
  uuml: 'ü', ouml: 'ö', auml: 'ä', ccedil: 'ç', deg: '°' };
function decodeEntities(t) {
  let s = String(t == null ? '' : t);
  for (let i = 0; i < 2 && /&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(s); i++) {        // twice: catches "&amp;#39;"
    s = s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
      return ENT[e.toLowerCase()] ?? m;
    });
  }
  return s;
}

// Which country is a camera in? From the directory address (/united-kingdom/…)
// or its title ("…, Maui Hawaii", "… Spain"). Used to keep place lookups in
// the right country — "Cornwall" exists in England, Canada and Australia.
const COUNTRY = {
  'united states': 'us', usa: 'us', 'u.s.a.': 'us', america: 'us', 'united kingdom': 'gb', uk: 'gb', england: 'gb', scotland: 'gb',
  wales: 'gb', 'northern ireland': 'gb', britain: 'gb', ireland: 'ie', canada: 'ca', mexico: 'mx', japan: 'jp', china: 'cn',
  taiwan: 'tw', 'hong kong': 'hk', 'south korea': 'kr', korea: 'kr', thailand: 'th', philippines: 'ph', indonesia: 'id', bali: 'id',
  singapore: 'sg', malaysia: 'my', vietnam: 'vn', india: 'in', nepal: 'np', australia: 'au', 'new zealand': 'nz', fiji: 'fj',
  'french polynesia': 'pf', netherlands: 'nl', holland: 'nl', belgium: 'be', germany: 'de', france: 'fr', italy: 'it', spain: 'es',
  portugal: 'pt', switzerland: 'ch', austria: 'at', 'czech republic': 'cz', czechia: 'cz', poland: 'pl', slovenia: 'si', croatia: 'hr',
  serbia: 'rs', romania: 'ro', hungary: 'hu', greece: 'gr', malta: 'mt', denmark: 'dk', sweden: 'se', norway: 'no', finland: 'fi',
  iceland: 'is', greenland: 'gl', latvia: 'lv', russia: 'ru', israel: 'il', 'saudi arabia': 'sa', vatican: 'va', 'south africa': 'za',
  rsa: 'za', namibia: 'na', brazil: 'br', argentina: 'ar', chile: 'cl', 'costa rica': 'cr', honduras: 'hn', jamaica: 'jm',
  'dominican republic': 'do', 'puerto rico': 'pr', 'us virgin islands': 'vi', 'virgin islands': 'vi', 'british virgin islands': 'vg',
  'cayman islands': 'ky', 'grand cayman': 'ky', 'turks and caicos': 'tc', barbados: 'bb', aruba: 'aw', curacao: 'cw', bonaire: 'bq',
  'sint maarten': 'sx', 'saint barthelemy': 'bl', 'st barts': 'bl', anguilla: 'ai', bahamas: 'bs', 'cape verde': 'cv',
};
const US_STATES = ['alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho',
  'illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri',
  'montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon',
  'pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia',
  'wisconsin','wyoming','district of columbia'];
const US_ABBR = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;
function countryHint(text, slug) {
  const sl = String(slug || '').toLowerCase().replace(/-/g, ' ').trim();
  if (sl && COUNTRY[sl]) return COUNTRY[sl];
  const t = ' ' + String(text || '').toLowerCase().replace(/[^a-z.\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
  // longest names first ("british virgin islands" before "virgin islands")
  for (const name of Object.keys(COUNTRY).sort((a, b) => b.length - a.length)) if (t.includes(' ' + name + ' ')) return COUNTRY[name];
  if (US_STATES.some(st => t.includes(' ' + st + ' ')) || US_ABBR.test(String(text || ''))) return 'us';
  return null;
}

function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

module.exports = function setupCommunityCams(app, deps) {
  const { rGet, rSet, fetchTextOverHttp, youtubeKey, stateFor, upstreamCount = () => {} } = deps;
  let db = { cams: [], queue: [], rejected: [], lastDiscovery: null, nextPlace: 0, channels: {} };
  let loaded = false;

  async function load() {
    if (loaded) return;
    const saved = await rGet(STORE_KEY);
    if (saved && Array.isArray(saved.cams)) db = { ...db, ...saved };
    if (!db.channels) db.channels = {};
    loaded = true;
    // One-time: fix escaped characters ("&#39;", "&amp;") in names already saved
    if (!db.namesDecoded) {
      let fixed = 0;
      for (const c of [...db.cams, ...db.queue]) {
        for (const f of ['name', 'channelTitle', 'streamTitle']) {
          if (c[f] && /&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(c[f])) { c[f] = decodeEntities(c[f]); fixed++; }
        }
      }
      db.namesDecoded = true;
      await save();
      if (fixed) console.log(`[Community] Fixed ${fixed} names with escaped characters (&#39; → ', &amp; → &)`);
    }
  }
  async function save() { await rSet(STORE_KEY, db); }

  // ── Understand a pasted URL ────────────────────────────────────────────────
  async function parseUrl(raw) {
    let u;
    try { u = new URL(String(raw || '').trim()); } catch { throw new Error('Not a valid URL'); }
    if (u.protocol !== 'https:') throw new Error('Only https:// links are accepted');
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') return { kind: 'yt-video', ref: u.pathname.slice(1, 12) };
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const v = u.searchParams.get('v');
      if (v) return { kind: 'yt-video', ref: v.slice(0, 11) };
      const m = u.pathname.match(/^\/(?:live|embed|shorts)\/([A-Za-z0-9_-]{11})/);
      if (m) return { kind: 'yt-video', ref: m[1] };
      const ch = u.pathname.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})/);
      if (ch) return { kind: 'yt-channel', ref: ch[1] };
      if (/^\/@[^/]+/.test(u.pathname)) {   // @handle → channel id, read from the public page (no quota)
        const html = await fetchTextOverHttp(`https://www.youtube.com/${u.pathname.split('/')[1]}`);
        // The page mentions OTHER channels too (featured, collaborations), so take
        // the channel's own id: externalId, then the canonical link, then browseId.
        const id = (html.match(/"externalId":"(UC[A-Za-z0-9_-]{22})"/) || [])[1]
          || (html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/) || [])[1]
          || (html.match(/"browseId":"(UC[A-Za-z0-9_-]{22})"/) || [])[1];
        if (!id) throw new Error('Could not find that YouTube channel');
        return { kind: 'yt-channel', ref: id };
      }
      throw new Error('Paste a YouTube video, live or channel link');
    }
    if (/\.(jpe?g|png|webp|gif)$/i.test(u.pathname)) return { kind: 'image', ref: u.href };
    // Unofficial relays of other people's protected streams — never used
    if (/proxy/i.test(u.pathname) && /hdontap/i.test(u.href)) {
      throw new Error("That's an unofficial relay of an HDOnTap camera. Paste the camera's hdontap.com page instead");
    }
    // Nest public cameras: Nest's own embed player
    if (host === 'video.nest.com') {
      const m = u.pathname.match(/\/(?:embedded\/)?live\/([A-Za-z0-9_-]+)/);
      if (!m) throw new Error('Paste the public Nest camera link (video.nest.com/live/…)');
      return { kind: 'embed', ref: `https://video.nest.com/embedded/live/${m[1]}?autoplay=1`, page: `https://video.nest.com/live/${m[1]}`, provider: 'Nest' };
    }
    // A direct live video stream
    if (/\.m3u8$/i.test(u.pathname)) return { kind: 'hls', ref: u.href, provider: u.hostname.replace(/^www\./, '') };
    // HDOnTap doesn't allow embedding (token-secured): show its published
    // preview picture, with a button to watch live on HDOnTap
    if (host === 'hdontap.com' && /^\/stream\//.test(u.pathname)) {
      const html = await fetchTextOverHttp(u.href);
      const img = (html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i) || [])[1];
      const title = ((html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) || [])[1] || '').replace(/\s*-\s*HDOnTap$/i, '');
      if (!img) throw new Error('Could not find a preview picture on that HDOnTap page');
      return { kind: 'link', ref: u.href.split('?')[0], preview: img, provider: 'HDOnTap', suggestedName: title };
    }
    // A camera host's own player/embed link pasted directly
    const direct = findPlayerInPage(u.href, u.href);
    if (direct && direct.kind === 'embed') return direct;
    // Any other page: look inside it for a player we can show
    let html = '';
    try { html = await fetchTextOverHttp(u.href); } catch (e) { throw new Error("Couldn't open that page (" + e.message + ')'); }
    const found = findPlayerInPage(html, u.href);
    if (found) return found;
    throw new Error("Couldn't find a camera on that page we're allowed to show (YouTube, Nest, Brownrice, IPCamLive, RTSP.me, Angelcam or a live video stream). "
      + "If the page has a Share or Embed option, paste that link instead");
  }
  // Players we recognize inside someone's page, best first
  function findPlayerInPage(html, base) {
    const yt = html.match(/youtube(?:-nocookie)?\.com\/(?:embed|live)\/([A-Za-z0-9_-]{11})/) || html.match(/youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/) || html.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
    if (yt && yt[1] !== 'live_stream') return { kind: 'yt-video', ref: yt[1], page: base };
    const ytch = html.match(/youtube\.com\/embed\/live_stream\?channel=(UC[A-Za-z0-9_-]{22})/);
    if (ytch) return { kind: 'yt-channel', ref: ytch[1], page: base };
    const nest = html.match(/video\.nest\.com\/(?:embedded\/)?live\/([A-Za-z0-9_-]+)/);
    if (nest) return { kind: 'embed', ref: `https://video.nest.com/embedded/live/${nest[1]}?autoplay=1`, page: base, provider: 'Nest' };
    // Camera hosts used by towns, tourism boards and resorts — their own embed players.
    // Brownrice: iframe (/embed/NAME), JavaScript tag (?sn=NAME), or the older live2 player
    const bri = html.match(/player\.brownrice\.com\/embed\/([A-Za-z0-9_-]+)/i)
      || html.match(/player\.brownrice\.com\/?\?[^"'<>\s]*?\bsn=([A-Za-z0-9_-]+)/i)
      || html.match(/live\d*\.brownrice\.com\/player\/live\/([A-Za-z0-9_-]+)/i);
    if (bri) return { kind: 'embed', ref: `https://player.brownrice.com/embed/${bri[1]}`, page: base, provider: 'Brownrice' };
    const ipc = html.match(/ipcamlive\.com\/player\/player\.php\?[^"'<>\s]*?\balias=([A-Za-z0-9_-]+)/i);
    if (ipc) return { kind: 'embed', ref: `https://ipcamlive.com/player/player.php?alias=${ipc[1]}&autoplay=1`, page: base, provider: 'IPCamLive' };
    const rtsp = html.match(/rtsp\.me\/embed\/([A-Za-z0-9_-]+)/i);
    if (rtsp) return { kind: 'embed', ref: `https://rtsp.me/embed/${rtsp[1]}/`, page: base, provider: 'RTSP.me' };
    const angel = html.match(/v\.angelcam\.com\/iframe\?[^"'<>\s]*?\bv=([A-Za-z0-9_-]+)/i);
    if (angel) return { kind: 'embed', ref: `https://v.angelcam.com/iframe?v=${angel[1]}&autoplay=1`, page: base, provider: 'Angelcam' };
    const hls = html.match(/https:\/\/[^"'\s<>\\]+?\.m3u8(?:\?[^"'\s<>\\]*)?/i);
    if (hls && !/hdontap/i.test(hls[0])) return { kind: 'hls', ref: hls[0], page: base, provider: new URL(base).hostname.replace(/^www\./, '') };
    return null;
  }
  // ── Place → coordinates (so nobody has to look up lat/long) ──────────────
  // OpenStreetMap Nominatim: street addresses and landmarks ("Broad St,
  // Greendale WI", "Waikiki Beach"). Usage policy: identify ourselves, max 1
  // request/second, cache results, credit OpenStreetMap. Falls back to
  // Open-Meteo's city search. Limited to the US and its territories.
  const geoCache = new Map();
  let geoChain = Promise.resolve();
  function geocode(q, cc) {
    cc = cc ? String(cc).toLowerCase() : '';
    const key = String(q || '').trim().toLowerCase() + (cc ? '|' + cc : '');
    if (key.length < 3) return Promise.resolve([]);
    if (geoCache.has(key)) return Promise.resolve(geoCache.get(key));
    const job = geoChain.then(async () => {
      let out = [];
      try {
        const txt = await fetchTextOverHttp('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5'
          + (cc ? `&countrycodes=${cc}` : '')
          + `&q=${encodeURIComponent(q)}`, { 'User-Agent': 'WeatherTV/1.0 (https://watchweathertv.com)', 'Accept-Language': 'en' });
        out = (JSON.parse(txt) || []).map(r => ({ lat: +r.lat, lng: +r.lon, label: r.display_name, source: 'OpenStreetMap' }));
      } catch (_) { /* fall through */ }
      if (!out.length) {
        try {
          const j = JSON.parse(await fetchTextOverHttp(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=en&format=json`));
          out = (j.results || []).filter(r => !cc || String(r.country_code || '').toLowerCase() === cc)
            .map(r => ({ lat: r.latitude, lng: r.longitude, label: [r.name, r.admin1, r.country_code].filter(Boolean).join(', '), source: 'Open-Meteo' }));
        } catch (_) { /* nothing found */ }
      }
      out = out.filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng)).slice(0, 5);
      geoCache.set(key, out);
      if (geoCache.size > 2000) geoCache.delete(geoCache.keys().next().value);
      await new Promise(r => setTimeout(r, 1100));   // stay under 1 request/second
      return out;
    });
    geoChain = job.catch(() => {});
    return job;
  }

  const revCache = new Map();
  function reverseCountry(lat, lng) {
    const key = `${lat.toFixed(1)},${lng.toFixed(1)}`;
    if (revCache.has(key)) return Promise.resolve(revCache.get(key));
    const job = geoChain.then(async () => {
      let cc = null;
      try {
        const j = JSON.parse(await fetchTextOverHttp(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=5&addressdetails=1&lat=${lat}&lon=${lng}`,
          { 'User-Agent': 'WeatherTV/1.0 (https://watchweathertv.com)', 'Accept-Language': 'en' }));
        cc = (j.address && j.address.country_code) || null;
        if (cc === 'us' && j.address && /puerto rico/i.test(j.address.state || '')) cc = 'pr';
      } catch (_) {}
      revCache.set(key, cc);
      await new Promise(r => setTimeout(r, 1100));
      return cc;
    });
    geoChain = job.catch(() => {});
    return job;
  }
  // The place a camera's own name points to: "Amsterdam: Dam Square" → "Amsterdam"
  const placeFromName = (c) => decodeEntities(c.name).split(/[:|–—-]\s/)[0].replace(/\b(live|cam|webcam|camera|stream)\b/ig, '').trim();
  const pageSlug = (c) => { try { const u = new URL(c.page || ''); return u.pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; } };

  // Titles put the place first OR last ("Live River Cam | La Crosse, Wisconsin").
  // Try each part (camera words removed) and use the first that's a real place.
  async function placeFromParts(title, cc) {
    const parts = decodeEntities(title).split(/\s[|•–—]\s|\s-\s|:\s/).map(p => p
      .replace(/\b(live ?stream|live ?cam(era)?|webcam|web cam|live|streaming|24\/7|4k|hd|cam|camera|view|views)\b/ig, ' ')
      .replace(/\s{2,}/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '')).filter(p => p.length >= 3);
    for (const part of parts.sort((a, b) => (b.includes(',') - a.includes(',')))) {   // "City, State" parts first
      const r = await placeIt(part, cc);
      if (r.hit) return { ...r, place: part };
    }
    return { hit: null, confident: false, place: parts[0] || title };
  }

  // Place a camera. With a known country, only results IN that country count
  // (✓ confirmed). Without one, the best guess is used but marked ⚠ check.
  async function placeIt(place, cc, fallbackPlace) {
    if (!place || place.length < 3) return { hit: null, confident: false };
    if (cc) {
      const hit = (await geocode(place, cc))[0] || (fallbackPlace ? (await geocode(fallbackPlace, cc))[0] : null);
      return { hit: hit || null, confident: !!hit };
    }
    const hit = (await geocode(place))[0] || (fallbackPlace ? (await geocode(fallbackPlace))[0] : null);
    return { hit: hit || null, confident: false };
  }

  // "Ashland, Virginia USA | Virtual Railfan LIVE" → "Ashland, Virginia USA"
  // "Times Square, New York City - EarthCam Live" → "Times Square, New York City"
  function placeFromTitle(title, channelTitle) {
    let t = String(title || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ');
    const brand = String(channelTitle || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (brand) t = t.replace(new RegExp(brand, 'ig'), ' ');
    t = t.split(/\s[|•–—]\s|\s-\s/)[0];
    t = t.replace(/\b(live ?stream|live ?cam(era)?|webcam|web cam|live|streaming|24\/7|4k|hd|uhd|virtual railfan|earthcam|cam\b|camera)\b/ig, ' ')
         .replace(/[\[\]()]/g, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s,:-]+|[\s,:-]+$/g, '');
    return t.slice(0, 100);
  }

  const known = (ref) => db.cams.some(c => c.ref === ref) || db.queue.some(q => q.ref === ref) || db.rejected.includes(ref);

  // ── Live checks ───────────────────────────────────────────────────────────
  // Videos: YouTube API, 50 per call, 1 quota unit per call.
  async function checkVideos(cams) {
    if (!youtubeKey) return cams.forEach(c => { c.live = null; c.lastError = 'YOUTUBE_API_KEY not set'; });
    for (let i = 0; i < cams.length; i += 50) {
      const batch = cams.slice(i, i + 50);
      try {
        upstreamCount('youtubeVideosCommunity');
        const j = JSON.parse(await fetchTextOverHttp('https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails,status'
          + `&id=${batch.map(c => c.ref).join(',')}&key=${encodeURIComponent(youtubeKey)}`));
        if (j.error) throw new Error(j.error.message || 'YouTube API error');
        const byId = new Map((j.items || []).map(it => [it.id, it]));
        for (const c of batch) {
          const it = byId.get(c.ref);
          if (!it) { c.live = false; c.ended = true; c.lastError = 'Video not found (removed or private)'; }
          else {
            // Live and embeddable are separate: a live stream whose owner blocks
            // embedding is still shown — as a live snapshot + "Watch on YouTube"
            c.embeddable = !(it.status && it.status.embeddable === false);
            c.live = !!(it.snippet && it.snippet.liveBroadcastContent === 'live');
            c.lastError = !c.live ? 'Not live on YouTube right now'
              : !c.embeddable ? 'Owner blocks embedding — shown as a live snapshot with a Watch on YouTube button' : null;
            if (it.snippet) {
              if (!c.channelTitle) c.channelTitle = it.snippet.channelTitle || '';
              if (!c.channelId) c.channelId = it.snippet.channelId || null;
              if (!c.streamTitle) c.streamTitle = it.snippet.title || '';
              c.ended = !c.live && ['none', 'completed'].includes(it.snippet.liveBroadcastContent) && !!(it.liveStreamingDetails && it.liveStreamingDetails.actualEndTime);
            }
          }
          c.lastChecked = Date.now();
          if (c.live) c.lastLive = Date.now();
        }
      } catch (e) {
        batch.forEach(c => { c.live = null; c.lastError = e.message; c.lastChecked = Date.now(); });   // unknown, not offline
      }
    }
  }
  // Channels and images: read the page / image (no quota).
  async function checkPage(c) {
    try {
      if (c.kind === 'hls' || c.kind === 'embed' || c.kind === 'link') {
        const url = c.kind === 'link' ? c.preview : c.ref;
        const r = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WeatherTV/1.0)' } });
        c.live = r.ok;
        c.lastError = r.ok ? null : `${c.provider || 'Source'} returned HTTP ${r.status}`;
      } else if (c.kind === 'image') {
        const r = await fetch(c.ref, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WeatherTV/1.0)' } });
        c.live = r.ok && /image/i.test(r.headers.get('content-type') || '');
        c.lastError = c.live ? null : `Image returned HTTP ${r.status}`;
      } else {
        const html = await fetchTextOverHttp(`https://www.youtube.com/channel/${c.ref}/live`, { 'Accept-Language': 'en-US,en;q=0.9' });
        if (html.includes('"isLive":true')) { c.live = true; c.lastError = null; }
        else if (html.includes('ytInitialData')) { c.live = false; c.lastError = 'Channel is not live right now'; }   // a real page with no live stream
        else { c.live = null; c.lastError = 'YouTube returned a page we could not read'; }                        // blocked/odd page → unknown
      }
    } catch (e) { c.live = null; c.lastError = e.message; }
    c.lastChecked = Date.now();
    if (c.live) c.lastLive = Date.now();
  }
  async function checkOne(c) {
    if (c.kind === 'yt-video') await checkVideos([c]); else await checkPage(c);
    return c;
  }
  // ── A channel's streams that are live right now (newest uploads first) ───
  async function liveOnChannel(channelId, pages = 2) {
    const out = new Map();
    let tok = '';
    for (let i = 0; i < pages; i++) {
      const pl = JSON.parse(await fetchTextOverHttp('https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50'
        + `&playlistId=UU${channelId.slice(2)}${tok ? '&pageToken=' + tok : ''}&key=${encodeURIComponent(youtubeKey)}`));
      if (pl.error) throw new Error(pl.error.message);
      const ids = (pl.items || []).map(x => x.contentDetails && x.contentDetails.videoId).filter(Boolean);
      if (ids.length) {
        const vj = JSON.parse(await fetchTextOverHttp(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids.join(',')}&key=${encodeURIComponent(youtubeKey)}`));
        for (const it of vj.items || []) if (it.snippet && it.snippet.liveBroadcastContent === 'live') out.set(it.id, { title: it.snippet.title, channelTitle: it.snippet.channelTitle });
      }
      upstreamCount('youtubeChannelScan');
      tok = pl.nextPageToken || '';
      if (!tok) break;
    }
    return out;
  }

  // "Ashland, Virginia USA | Virtual Railfan LIVE  🔴 Day 812" → {ashland, virginia}
  // Drops the channel's own name, live/cam words, numbers and dates, so two
  // streams of the same camera match and two different cameras don't.
  const TITLE_NOISE = new Set(['live', 'livestream', 'stream', 'streaming', 'cam', 'webcam', 'camera', 'cams', '247', '24', '7', 'hd', '4k', 'uhd',
    'usa', 'us', 'the', 'a', 'of', 'at', 'in', 'on', 'and', 'from', 'view', 'day', 'new', 'now', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul',
    'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october',
    'november', 'december']);
  function titleTokens(title, channelTitle) {
    const brand = new Set(String(channelTitle || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    return new Set(String(title || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/).filter(w => w && !TITLE_NOISE.has(w) && !brand.has(w) && !/^\d+$/.test(w)));
  }
  function titleSimilarity(a, b, channelTitle) {
    const A = titleTokens(a, channelTitle), B = titleTokens(b, channelTitle);
    if (!A.size || !B.size) return 0;
    let both = 0; A.forEach(w => { if (B.has(w)) both++; });
    return both / (A.size + B.size - both);
  }

  // Ended streams → find their replacement on the same channel
  async function replaceEnded() {
    if (!youtubeKey) return 0;
    const dead = db.cams.filter(c => c.kind === 'yt-video' && c.live === false && c.channelId && c.streamTitle
      && (c.ended || (c.lastLive && Date.now() - c.lastLive > 30 * 60 * 1000))
      && (!c.replaceCheckedAt || Date.now() - c.replaceCheckedAt > 2 * 3600 * 1000));   // each camera checked at most every 2 h
    const byChannel = new Map();
    dead.forEach(c => { if (!byChannel.has(c.channelId)) byChannel.set(c.channelId, []); byChannel.get(c.channelId).push(c); });
    let replaced = 0, channelsChecked = 0;
    const onMap = new Set(db.cams.map(c => c.ref));
    for (const [channelId, cams] of byChannel) {
      if (channelsChecked++ >= 15) break;                                  // spread big batches over several runs
      let live;
      try { live = await liveOnChannel(channelId, 2); } catch (e) { cams.forEach(c => { c.replaceCheckedAt = Date.now(); }); continue; }
      for (const c of cams) {
        c.replaceCheckedAt = Date.now();
        let best = null, bestSim = 0;
        for (const [id, v] of live) {
          if (onMap.has(id) || db.rejected.includes(id)) continue;
          const sim = titleSimilarity(c.streamTitle, v.title, v.channelTitle || c.channelTitle);
          if (sim > bestSim) { bestSim = sim; best = { id, ...v }; }
        }
        if (best && bestSim >= 0.6) {
          console.log(`[Community] Replaced ended stream for "${c.name}": ${c.ref} → ${best.id} (title match ${Math.round(bestSim * 100)}%)`);
          (c.history || (c.history = [])).push({ ref: c.ref, until: Date.now() });
          c.history = c.history.slice(-10);
          onMap.delete(c.ref); onMap.add(best.id);
          c.ref = best.id; c.streamTitle = best.title; c.live = true; c.ended = false; c.lastLive = Date.now();
          c.lastError = null; c.replacedAt = Date.now(); c.replacements = (c.replacements || 0) + 1;
          replaced++;
        }
      }
    }
    return replaced;
  }

  // Watched channels: new live streams since last time → review queue
  async function scanWatchedChannels(onlyId) {
    if (!youtubeKey) throw new Error('YOUTUBE_API_KEY not set');
    let queued = 0;
    for (const [channelId, ch] of Object.entries(db.channels)) {
      if (onlyId && onlyId !== channelId) continue;
      let live;
      try { live = await liveOnChannel(channelId, 3); } catch (e) { ch.lastError = e.message; continue; }
      ch.lastScan = Date.now(); ch.lastError = null; ch.liveCount = live.size;
      for (const [id, v] of live) {
        if (known(id)) continue;
        // Probably a restarted stream of a camera we already have? Leave it to replaceEnded()
        if (db.cams.some(c => c.channelId === channelId && titleSimilarity(c.streamTitle, v.title, v.channelTitle) >= 0.6)) continue;
        const place = placeFromTitle(v.title, v.channelTitle);
        const { hit, confident } = await placeIt(place, countryHint(v.title));
        db.queue.push({ id: uid(), kind: 'yt-video', ref: id, name: decodeEntities(v.title).slice(0, 120), channelTitle: decodeEntities(v.channelTitle), confident,
          thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, lat: hit ? hit.lat : null, lng: hit ? hit.lng : null,
          locationGuess: hit ? `From title "${place}" → ${hit.label}` : `Couldn't place "${place}" — set it on the map`,
          source: 'channel', foundAt: Date.now() });
        queued++;
      }
    }
    db.queue = db.queue.slice(-600);
    await save();
    return queued;
  }

  let checking = false;
  async function checkAll() {
    if (checking) return;
    checking = true;
    try {
      await load();
      await checkVideos(db.cams.filter(c => c.kind === 'yt-video'));
      try { const n = await replaceEnded(); if (n) console.log(`[Community] ${n} ended stream(s) replaced with their new live stream`); }
      catch (e) { console.warn('[Community] replacement check:', e.message); }
      for (const c of db.cams.filter(c => c.kind !== 'yt-video')) { await checkPage(c); await new Promise(r => setTimeout(r, 1500)); }
      await save();
      const live = db.cams.filter(c => c.live).length, unknown = db.cams.filter(c => c.live == null).length;
      if (db.cams.length) console.log(`[Community] live check: ${live}/${db.cams.length} live` + (unknown ? `, ${unknown} unknown` : ''));
    } finally { checking = false; }
  }
  const visible = (c) => c.live !== false || (c.lastLive && Date.now() - c.lastLive < HIDE_AFTER_OFFLINE_MS);

  // ── Discovery (YouTube Data API: 100 units per search) ───────────────────
  async function discover({ place, lat, lng, radiusKm }) {
    if (!youtubeKey) throw new Error('YOUTUBE_API_KEY not set');
    const q = place ? `${place} live cam` : 'live cam';
    let url = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&eventType=live&maxResults=25'
      + `&q=${encodeURIComponent(q)}&key=${encodeURIComponent(youtubeKey)}`;
    // Without a place name, search around the point (only finds geotagged streams)
    if (!place && Number.isFinite(lat) && Number.isFinite(lng)) url += `&location=${lat},${lng}&locationRadius=${Math.min(Math.max(radiusKm || 50, 5), 1000)}km`;
    upstreamCount('youtubeSearchCommunity');
    const j = JSON.parse(await fetchTextOverHttp(url));
    if (j.error) throw new Error(j.error.message || 'YouTube search failed');
    let added = 0;
    for (const it of j.items || []) {
      const id = it.id && it.id.videoId, sn = it.snippet || {};
      if (!id || known(id)) continue;
      const text = `${sn.title || ''} ${sn.description || ''}`;
      if (!CAM_WORDS.test(text) || NOT_CAM_WORDS.test(text)) continue;
      db.queue.push({
        id: uid(), kind: 'yt-video', ref: id, name: decodeEntities(sn.title).slice(0, 120), channelTitle: decodeEntities(sn.channelTitle), confident: false,
        thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null,
        locationGuess: place ? `Near ${place} (from the search — check before approving)` : 'Search area center',
        source: 'discovery', foundAt: Date.now(),
      });
      added++;
    }
    db.queue = db.queue.slice(-400);
    await save();
    return { found: (j.items || []).length, added };
  }
  async function nightly() {
    await load();
    try { const q = await scanWatchedChannels(); if (Object.keys(db.channels).length) console.log(`[Community] watched channels: ${q} new live streams queued`); }
    catch (e) { console.warn('[Community] watched channels:', e.message); }
    if (!/^(1|true|yes)$/i.test(process.env.COMMUNITY_DISCOVERY || '')) { db.lastDiscovery = Date.now(); await save(); return; }
    const n = Math.max(1, Math.min(40, parseInt(process.env.COMMUNITY_DISCOVERY_PER_NIGHT || '10', 10) || 10));
    let total = 0;
    for (let i = 0; i < n; i++) {
      const [place, lat, lng] = DISCOVERY_PLACES[(db.nextPlace + i) % DISCOVERY_PLACES.length];
      try { total += (await discover({ place, lat, lng })).added; } catch (e) { console.warn('[Community] discovery:', e.message); break; }
    }
    db.nextPlace = (db.nextPlace + n) % DISCOVERY_PLACES.length;
    db.lastDiscovery = Date.now();
    await save();
    console.log(`[Community] nightly discovery: ${total} new candidates queued`);
  }

  // ── Map output ─────────────────────────────────────────────────────────────
  function toCamera(c) {
    // Owner blocks embedding: YouTube's live thumbnail (refreshes every few
    // minutes) + a button to watch on YouTube — like the HDOnTap preview cards
    if (c.kind === 'yt-video' && c.embeddable === false) {
      return { id: 'comm-' + c.id, name: c.name, lat: c.lat, lng: c.lng, source: 'community', playerUrl: null,
               imageUrl: `https://i.ytimg.com/vi/${c.ref}/hqdefault_live.jpg`, videoUrl: null, direction: null,
               pageUrl: `https://www.youtube.com/watch?v=${c.ref}`, provider: 'YouTube', isStreaming: true };
    }
    const player = c.kind === 'yt-video' ? `https://www.youtube-nocookie.com/embed/${c.ref}?autoplay=1&mute=1&playsinline=1`
      : c.kind === 'yt-channel' ? `https://www.youtube.com/embed/live_stream?channel=${c.ref}&autoplay=1&mute=1`
      : c.kind === 'embed' ? c.ref : null;
    const page = c.kind === 'yt-video' ? `https://www.youtube.com/watch?v=${c.ref}` : c.kind === 'yt-channel' ? `https://www.youtube.com/channel/${c.ref}/live`
      : c.kind === 'link' ? c.ref : (c.page || null);
    return {
      id: 'comm-' + c.id, name: c.name, lat: c.lat, lng: c.lng, source: 'community',
      playerUrl: player, imageUrl: c.kind === 'image' ? c.ref : c.kind === 'link' ? c.preview : null,
      videoUrl: c.kind === 'hls' ? c.ref : null, direction: null,
      pageUrl: page, provider: c.provider || (/^yt-/.test(c.kind) ? 'YouTube' : null),
      isStreaming: c.kind !== 'image',
    };
  }
  async function forState(code) {
    await load();
    return db.cams.filter(c => c.state === code && visible(c)).map(toCamera);
  }

  // ── Public: suggest a camera (rate-limited in memory, nothing personal kept)
  const recent = new Map();
  app.post('/api/community/suggest', async (req, res) => {
    const ip = (req.headers['cf-connecting-ip'] || req.ip || '').toString();
    const hits = (recent.get(ip) || []).filter(t => Date.now() - t < 3600 * 1000);
    if (hits.length >= 5) return res.status(429).json({ error: 'Thanks! That is plenty for now — try again later.' });
    recent.set(ip, [...hits, Date.now()]);
    if (recent.size > 5000) recent.delete(recent.keys().next().value);
    try {
      await load();
      const { url, lat, lng, place, note } = req.body || {};
      const p = await parseUrl(url);
      if (known(p.ref)) return res.json({ ok: true, message: 'Already on our list — thank you!' });
      let la = parseCoord(lat, 'lat'), lo = parseCoord(lng, 'lng');
      let guess = String(place || '').slice(0, 120);
      if ((!Number.isFinite(la) || !Number.isFinite(lo)) && place) {   // no map spot → look the place up
        const hit = (await geocode(place))[0];
        if (hit) { la = hit.lat; lo = hit.lng; guess = `${guess} → looked up: ${hit.label}`; }
      }
      db.queue.push({
        id: uid(), ...p, name: String(place || '').slice(0, 120) || 'Suggested camera',
        thumb: p.kind === 'yt-video' ? `https://i.ytimg.com/vi/${p.ref}/mqdefault.jpg` : (p.kind === 'image' ? p.ref : p.kind === 'link' ? p.preview : null),
        lat: Number.isFinite(la) ? la : null, lng: Number.isFinite(lo) ? lo : null,
        locationGuess: guess, note: String(note || '').slice(0, 300),
        source: 'suggestion', foundAt: Date.now(),
      });
      db.queue = db.queue.slice(-400);
      await save();
      res.json({ ok: true, message: 'Thanks! We will review it soon.' });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── Admin API (protected by app.use('/api/admin', adminAuth)) ─────────────
  app.get('/api/admin/community', async (req, res) => {
    await load();
    res.json({
      cams: db.cams.map(c => ({ ...c, visible: visible(c) })), queue: db.queue.slice().reverse(), rejectedCount: db.rejected.length,
      channels: Object.entries(db.channels).map(([id, c]) => ({ id, ...c })),
      discovery: { nightly: /^(1|true|yes)$/i.test(process.env.COMMUNITY_DISCOVERY || ''), perNight: parseInt(process.env.COMMUNITY_DISCOVERY_PER_NIGHT || '10', 10) || 10,
                   lastRun: db.lastDiscovery, places: DISCOVERY_PLACES.length },
    });
  });
  const approveInto = async (base, body) => {
    const lat = parseCoord(body.lat, 'lat'), lng = parseCoord(body.lng, 'lng');
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Set a latitude and longitude first (e.g. 42.9375 and -87.9969, or 42.9375° N and 87.9969° W)');
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error('Those coordinates are out of range');
    const state = stateFor(lat, lng);
    if (!state) throw new Error('Could not work out where that is — check the coordinates');
    const cam = { id: base.id || uid(), kind: base.kind, ref: base.ref, page: base.page || null, preview: base.preview || null, provider: base.provider || null,
                  name: decodeEntities(String(body.name || base.name || base.suggestedName || 'Community camera')).slice(0, 120),
                  channelTitle: base.channelTitle || '', lat, lng, state, addedAt: Date.now(), source: base.source || 'admin', live: null };
    await checkOne(cam);
    db.cams.push(cam);
    return cam;
  };
  app.post('/api/admin/community/add', async (req, res) => {
    try {
      await load();
      const p = await parseUrl(req.body && req.body.url);
      if (db.cams.some(c => c.ref === p.ref)) throw new Error('That camera is already on the map');
      const cam = await approveInto({ ...p, source: 'admin' }, req.body || {});
      db.queue = db.queue.filter(q => q.ref !== p.ref);
      await save();
      res.json({ ok: true, cam });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/admin/community/approve', async (req, res) => {
    try {
      await load();
      const q = db.queue.find(x => x.id === (req.body || {}).id);
      if (!q) throw new Error('Not in the queue');
      const cam = await approveInto(q, req.body || {});
      db.queue = db.queue.filter(x => x.id !== q.id);
      await save();
      res.json({ ok: true, cam });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/admin/community/reject', async (req, res) => {
    await load();
    const q = db.queue.find(x => x.id === (req.body || {}).id);
    if (q) { db.rejected.push(q.ref); db.rejected = db.rejected.slice(-3000); db.queue = db.queue.filter(x => x.id !== q.id); await save(); }
    res.json({ ok: true });
  });
  app.post('/api/admin/community/remove', async (req, res) => {
    await load();
    const c = db.cams.find(x => x.id === (req.body || {}).id);
    if (c) { db.cams = db.cams.filter(x => x.id !== c.id); db.rejected.push(c.ref); await save(); }
    res.json({ ok: true });
  });
  app.post('/api/admin/community/discover', async (req, res) => {
    try {
      await load();
      const b = req.body || {};
      const r = await discover({ place: String(b.place || '').trim().slice(0, 80) || null,
                                 lat: parseFloat(b.lat), lng: parseFloat(b.lng), radiusKm: parseFloat(b.radiusKm) });
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  // ── Background jobs ────────────────────────────────────────────────────────
  // Big imports take minutes (uploads scan + place lookups at 1/second), but
  // Cloudflare ends any request after 100 s with a 524. So imports start here,
  // answer at once with a job id, and the admin page polls for progress.
  const jobs = new Map();
  function background(path, handler) {
    app.post(path, (req, res) => {
      const job = { id: uid(), status: 'running', started: Date.now(), progress: 'Starting…', result: null };
      jobs.set(job.id, job);
      if (jobs.size > 50) jobs.delete(jobs.keys().next().value);
      const fakeRes = {
        status() { return fakeRes; },
        json(o) { job.result = o; job.status = o && o.error ? 'error' : 'done'; job.finished = Date.now(); return fakeRes; },
      };
      Promise.resolve(handler(Object.assign(Object.create(req), { body: req.body, _job: job }), fakeRes))
        .catch(e => { job.status = 'error'; job.result = { error: e.message }; job.finished = Date.now(); });
      res.json({ ok: true, jobId: job.id });
    });
  }
  app.get('/api/admin/community/job/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found (the server may have restarted)' });
    res.json(job);
  });

  // Bulk import: pasted text with a place line followed by one or more links.
  // Each link is looked up by its place and queued with the location filled in.
  background('/api/admin/community/import', async (req, res) => {
    try {
      await load();
      const lines = String((req.body || {}).text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 400);
      let place = '', queued = 0, skipped = 0, noPlace = 0;
      const report = [];
      const totalLinks = lines.filter(l => /^https?:\/\//i.test(l)).length;
      for (const line of lines) {
        if (!/^https?:\/\//i.test(line)) { place = line; continue; }
        if (req._job) req._job.progress = `Looking up ${queued + skipped + 1} of ${totalLinks}: ${place || line.slice(0, 40)}`;
        let p;
        try { p = await parseUrl(line); } catch (e) { report.push(`✗ ${line.slice(0, 60)} — ${e.message}`); skipped++; continue; }
        if (known(p.ref)) { report.push(`• already listed: ${place || line.slice(0, 40)}`); skipped++; continue; }
        const { hit, confident } = await placeIt(place, countryHint(place));
        if (!hit) noPlace++;
        db.queue.push({
          id: uid(), ...p, name: decodeEntities(place) || 'Imported camera', confident,
          thumb: p.kind === 'yt-video' ? `https://i.ytimg.com/vi/${p.ref}/mqdefault.jpg` : p.kind === 'link' ? p.preview : null,
          lat: hit ? hit.lat : null, lng: hit ? hit.lng : null,
          locationGuess: hit ? `Looked up: ${hit.label}` : (place ? `Couldn't find "${place}" — set it on the map` : 'No place given'),
          source: 'import', foundAt: Date.now(),
        });
        queued++;
        report.push(`${hit ? '✓' : '?'} ${place || '(no place)'}${hit ? ' → ' + hit.label.split(',').slice(0, 3).join(',') : ''}`);
      }
      db.queue = db.queue.slice(-600);
      await save();
      res.json({ ok: true, queued, skipped, noPlace, report });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Channel import: every stream a channel has LIVE right now (YouTube API:
  // 100 units per 50 streams). The place is read from each title and looked up.
  background('/api/admin/community/import-channel', async (req, res) => {
    try {
      await load();
      if (!youtubeKey) throw new Error('YOUTUBE_API_KEY not set');
      const raw = String((req.body || {}).channel || '').trim();
      // This box is for YouTube channels only — point other sites to the right tool
      if (/^https?:/i.test(raw) && !/^https?:\/\/(www\.|m\.)?youtube\.com\//i.test(raw)) {
        throw new Error('This box is for YouTube channels (like @VirtualRailfan). For a website that lists cameras, '
          + 'use "Import every camera from a directory site" below. For a single camera page, use "Add a camera" above');
      }
      const p = await parseUrl(/^https?:/i.test(raw) ? raw : `https://www.youtube.com/${raw.startsWith('@') ? raw : '@' + raw}`);
      if (p.kind !== 'yt-channel') throw new Error('Give a channel link or @handle');
      const maxPages = Math.min(6, Math.max(1, parseInt((req.body || {}).maxPages || '4', 10) || 4));
      let token = '', pages = 0, units = 0, queued = 0, skipped = 0, channelTitle = '';
      const report = [];
      const found = new Map();   // videoId → { title, channelTitle }
      // (a) YouTube's live search — 100 units per 50
      do {
        upstreamCount('youtubeSearchCommunity');
        const j = JSON.parse(await fetchTextOverHttp('https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&eventType=live&maxResults=50'
          + `&channelId=${p.ref}${token ? '&pageToken=' + token : ''}&key=${encodeURIComponent(youtubeKey)}`));
        units += 100;
        if (j.error) throw new Error(j.error.message || 'YouTube search failed');
        for (const it of j.items || []) {
          const id = it.id && it.id.videoId, sn = it.snippet || {};
          if (id) found.set(id, { title: sn.title, channelTitle: sn.channelTitle });
        }
        token = j.nextPageToken || '';
        pages++;
      } while (token && pages < maxPages);
      // (b) Live search is known to miss streams on some channels. Read the
      //     channel's uploads list (1 unit per 50) and ask which are live now
      //     (videos.list, 1 unit per 50). 24/7 streams can be old, so read deep.
      let scanned = 0;
      try {
        let ptok = '', ppages = 0;
        const uploads = 'UU' + p.ref.slice(2);
        do {
          const pl = JSON.parse(await fetchTextOverHttp('https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50'
            + `&playlistId=${uploads}${ptok ? '&pageToken=' + ptok : ''}&key=${encodeURIComponent(youtubeKey)}`));
          units += 1;
          if (pl.error) throw new Error(pl.error.message);
          const ids = (pl.items || []).map(i => i.contentDetails && i.contentDetails.videoId).filter(id => id && !found.has(id));
          scanned += (pl.items || []).length;
          if (req._job) req._job.progress = `Checking uploads for live streams: ${scanned} checked, ${found.size} live so far`;
          if (ids.length) {
            const vj = JSON.parse(await fetchTextOverHttp(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids.join(',')}&key=${encodeURIComponent(youtubeKey)}`));
            units += 1;
            for (const it of vj.items || []) {
              if (it.snippet && it.snippet.liveBroadcastContent === 'live') found.set(it.id, { title: it.snippet.title, channelTitle: it.snippet.channelTitle });
            }
          }
          ptok = pl.nextPageToken || '';
          ppages++;
        } while (ptok && ppages < 60);   // up to 3,000 uploads, ~120 units
      } catch (e) { report.push(`(uploads scan stopped: ${e.message})`); }

      let n = 0;
      for (const [id, v] of found) {
        channelTitle = v.channelTitle || channelTitle;
        if (req._job) req._job.progress = `Placing stream ${++n} of ${found.size}: ${String(v.title || '').slice(0, 60)}`;
        if (known(id)) { skipped++; continue; }
        const place = placeFromTitle(v.title, v.channelTitle);
        const { hit, confident } = await placeIt(place, countryHint(v.title));
        db.queue.push({
          id: uid(), kind: 'yt-video', ref: id, name: decodeEntities(v.title).slice(0, 120), channelTitle: decodeEntities(v.channelTitle), confident,
          thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, lat: hit ? hit.lat : null, lng: hit ? hit.lng : null,
          locationGuess: hit ? `From title "${place}" → ${hit.label}` : `Couldn't place "${place}" — set it on the map`,
          source: 'channel', foundAt: Date.now(),
        });
        queued++;
        report.push(`${hit ? '✓' : '?'} ${v.title}`);
      }
      report.unshift(`Channel ${p.ref}: ${found.size} live now (search + ${scanned} uploads checked)`);
      db.channels[p.ref] = { ...(db.channels[p.ref] || {}), title: channelTitle || p.ref, addedAt: (db.channels[p.ref] || {}).addedAt || Date.now(),
                             lastScan: Date.now(), liveCount: found.size };
      report.unshift(`Now watching this channel — new live streams will be found nightly.`);
      db.queue = db.queue.slice(-600);
      await save();
      res.json({ ok: true, channelTitle: channelTitle || p.ref, pages, unitsUsed: units, queued, skipped, report: report.slice(0, 300) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Directory import: a page that LISTS cameras (e.g. worldcams.tv/cities/,
  // 13 pages). Reads every listing page, collects the camera links, opens each
  // one and finds the real player inside (YouTube / Nest / live stream). The
  // ORIGINAL stream is embedded, not the directory's page. Place comes from the
  // camera's title ("Amsterdam: Dam Square") + the country/city in its address.
  background('/api/admin/community/import-directory', async (req, res) => {
    try {
      await load();
      const b = req.body || {};
      let start; try { start = new URL(String(b.url || '').trim()); } catch { throw new Error('Paste the address of the page that lists the cameras'); }
      const pages = Math.max(1, Math.min(40, parseInt(b.pages || '1', 10) || 1));
      const mustContain = String(b.contains || '').trim();
      const job = req._job || {};
      const links = new Map();   // url → link text
      for (let pg = 1; pg <= pages; pg++) {
        const pu = new URL(start.href);
        if (pg > 1) pu.searchParams.set('page', String(pg));
        job.progress = `Reading listing page ${pg} of ${pages}… (${links.size} camera links so far)`;
        let html;
        try { html = await fetchTextOverHttp(pu.href); } catch (e) { if (pg === 1) throw new Error("Couldn't open that page: " + e.message); break; }
        for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
          let href; try { href = new URL(m[1], pu.href); } catch { continue; }
          if (href.hostname !== start.hostname) continue;
          const segs = href.pathname.split('/').filter(Boolean);
          const text = m[2].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
          // Camera pages sit deeper than category pages (e.g. /country/city/camera)
          if (segs.length < 3 || !text || text.length < 3) continue;
          if (mustContain && !href.href.includes(mustContain)) continue;
          href.search = ''; href.hash = '';
          if (!links.has(href.href) || links.get(href.href).length < text.length) links.set(href.href, text);
        }
        await new Promise(r => setTimeout(r, 400));
      }
      if (!links.size) {
        // Not a directory — maybe the page itself is a single camera
        let html0 = ''; try { html0 = await fetchTextOverHttp(start.href); } catch (_) {}
        const one = findPlayerInPage(html0, start.href);
        if (!one) throw new Error("No list of cameras on that page, and no camera player we recognize on it either");
        if (known(one.ref)) return res.json({ ok: true, found: 1, queued: 0, skipped: 1, noPlayer: 0, report: ['That camera is already on the map or in the queue'] });
        const title = decodeEntities(((html0.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) || html0.match(/<title>([^<]+)<\/title>/i) || [])[1] || start.hostname)).trim();
        const { hit, confident, place } = await placeFromParts(title, countryHint(title + ' ' + start.hostname));
        db.queue.push({ id: uid(), ...one, page: one.page || start.href, name: title.slice(0, 120), confident,
          thumb: one.kind === 'yt-video' ? `https://i.ytimg.com/vi/${one.ref}/hqdefault_live.jpg` : null,
          lat: hit ? hit.lat : null, lng: hit ? hit.lng : null,
          locationGuess: hit ? `From page title "${place}" → ${hit.label}` : `Couldn't place "${place}" — set it on the map`,
          source: 'import', foundAt: Date.now() });
        await save();
        return res.json({ ok: true, found: 1, queued: 1, skipped: 0, noPlayer: 0,
          report: [`This page is a single camera (${one.provider || one.kind}) — added to the review queue. (For one page, "Add a camera" works too.)`] });
      }
      const deslug = (x) => decodeURIComponent(x || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      let n = 0, queued = 0, skipped = 0, noPlayer = 0;
      const report = [];
      for (const [href, text] of links) {
        n++;
        job.progress = `Checking camera ${n} of ${links.size}: ${text.slice(0, 60)}`;
        let p;
        try {
          const html = await fetchTextOverHttp(href);
          p = findPlayerInPage(html, href);
        } catch (_) { p = null; }
        if (!p) { noPlayer++; report.push(`– no usable player: ${text}`); continue; }
        if (known(p.ref)) { skipped++; continue; }
        const segs = new URL(href).pathname.split('/').filter(Boolean);
        const country = deslug(segs[0]), city = deslug(segs[1]);
        const fromTitle = text.includes(':') ? text.split(':')[0].trim() : city;
        const place = [fromTitle, country].filter(Boolean).join(', ').replace(/, United States$/, ', USA');
        const cc = countryHint(text, segs[0]);
        const { hit, confident } = await placeIt(place, cc, [city, country].join(', '));
        db.queue.push({
          id: uid(), ...p, page: p.page || href, name: decodeEntities(text).slice(0, 120), confident,
          thumb: p.kind === 'yt-video' ? `https://i.ytimg.com/vi/${p.ref}/mqdefault.jpg` : null,
          lat: hit ? hit.lat : null, lng: hit ? hit.lng : null,
          locationGuess: hit ? `${place} → ${hit.label}` : `Couldn't place "${place}"${cc ? ' in ' + country : ''} — set it on the map`,
          source: 'import', foundAt: Date.now(),
        });
        queued++;
        report.push(`${hit ? '✓' : '?'} ${text}`);
        if (queued % 10 === 0) await save();
        await new Promise(r => setTimeout(r, 300));
      }
      db.queue = db.queue.slice(-800);
      await save();
      res.json({ ok: true, found: links.size, queued, skipped, noPlayer, report: report.slice(0, 400) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── Check placements: is every camera on the map in the country it should be?
  background('/api/admin/community/check-placements', async (req, res) => {
    await load();
    const job = req._job || {};
    const issues = []; let checked = 0, unknown = 0;
    const cams = db.cams.filter(c => !c.placementOk);
    for (const c of cams) {
      checked++;
      job.progress = `Checking ${checked} of ${cams.length}: ${decodeEntities(c.name).slice(0, 50)} · ${issues.length} look misplaced so far`;
      const expected = countryHint(c.name + ' ' + (c.channelTitle || ''), pageSlug(c));
      if (!expected) { unknown++; continue; }                 // nothing says which country — can't judge
      const actual = await reverseCountry(c.lat, c.lng);
      if (!actual || actual === expected || (expected === 'us' && ['pr', 'vi', 'gu', 'as', 'mp'].includes(actual))) continue;
      const { hit } = await placeIt(placeFromName(c), expected);
      issues.push({ id: c.id, name: c.name, lat: c.lat, lng: c.lng, expected, actual,
                    suggestion: hit ? { lat: hit.lat, lng: hit.lng, label: hit.label } : null });
    }
    db.placementReport = { at: Date.now(), issues, checked, unknown };
    await save();
    res.json({ ok: true, checked, unknown, issues });
  });
  app.get('/api/admin/community/placement-report', async (req, res) => { await load(); res.json(db.placementReport || null); });
  // Move a camera (from the report or the map picker), or mark its placement as fine
  app.post('/api/admin/community/move', async (req, res) => {
    await load();
    const b = req.body || {};
    const c = db.cams.find(x => x.id === b.id);
    if (!c) return res.status(404).json({ error: 'Camera not found' });
    if (b.ok) c.placementOk = true;
    else {
      const lat = parseCoord(b.lat, 'lat'), lng = parseCoord(b.lng, 'lng');
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'Bad coordinates' });
      c.lat = lat; c.lng = lng; c.state = stateFor(lat, lng) || c.state; c.placementOk = true;
    }
    if (db.placementReport) db.placementReport.issues = db.placementReport.issues.filter(i => i.id !== c.id);
    await save();
    res.json({ ok: true, cam: c });
  });

  // ── Rejected cameras: which are live right now? (YouTube videos.list, 1 unit / 50)
  background('/api/admin/community/rejected-check', async (req, res) => {
    await load();
    if (!youtubeKey) throw new Error('YOUTUBE_API_KEY not set');
    const ids = [...new Set(db.rejected.filter(r => /^[A-Za-z0-9_-]{11}$/.test(r)))].filter(id => !db.cams.some(c => c.ref === id));
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      if (req._job) req._job.progress = `Asking YouTube about ${Math.min(i + 50, ids.length)} of ${ids.length} rejected videos…`;
      const batch = ids.slice(i, i + 50);
      const j = JSON.parse(await fetchTextOverHttp(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${batch.join(',')}&key=${encodeURIComponent(youtubeKey)}`));
      if (j.error) throw new Error(j.error.message || 'YouTube API error');
      for (const it of j.items || []) {
        out.push({ ref: it.id, title: decodeEntities(it.snippet.title), channelTitle: decodeEntities(it.snippet.channelTitle),
                   live: it.snippet.liveBroadcastContent === 'live', embeddable: !(it.status && it.status.embeddable === false) });
      }
    }
    out.sort((a, b) => (b.live - a.live) || a.title.localeCompare(b.title));
    res.json({ ok: true, total: ids.length, live: out.filter(x => x.live).length, items: out });
  });
  // Restore a rejected camera to the review queue (location guessed from its title)
  app.post('/api/admin/community/unreject', async (req, res) => {
    await load();
    const b = req.body || {};
    const ref = String(b.ref || '');
    if (!db.rejected.includes(ref)) return res.status(404).json({ error: 'Not in the rejected list' });
    db.rejected = db.rejected.filter(r => r !== ref);
    const title = decodeEntities(b.title || 'Restored camera');
    const place = placeFromTitle(title, b.channelTitle || '');
    const { hit, confident } = await placeIt(place, countryHint(title));
    db.queue.push({ id: uid(), kind: 'yt-video', ref, name: title.slice(0, 120), channelTitle: decodeEntities(b.channelTitle || ''), confident,
      thumb: `https://i.ytimg.com/vi/${ref}/hqdefault_live.jpg`, lat: hit ? hit.lat : null, lng: hit ? hit.lng : null,
      locationGuess: hit ? `From title "${place}" → ${hit.label}` : `Couldn't place "${place}" — set it on the map`,
      source: 'restored', foundAt: Date.now() });
    await save();
    res.json({ ok: true });
  });

  // Approve every queued camera that already has a location (one click after a big import)
  app.post('/api/admin/community/approve-located', async (req, res) => {
    await load();
    const onlyConfirmed = !!(req.body || {}).confirmedOnly;
    const ready = db.queue.filter(q => Number.isFinite(q.lat) && Number.isFinite(q.lng) && (!onlyConfirmed || q.confident));
    let approved = 0; const failed = [];
    for (const q of ready) {
      try {
        const state = stateFor(q.lat, q.lng);
        if (!state) throw new Error('could not work out where that is');
        db.cams.push({ id: q.id, kind: q.kind, ref: q.ref, page: q.page || null, preview: q.preview || null, provider: q.provider || null,
                       name: q.name, channelTitle: q.channelTitle || '', lat: q.lat, lng: q.lng,
                       state, addedAt: Date.now(), source: q.source, live: null });
        db.queue = db.queue.filter(x => x.id !== q.id);
        approved++;
      } catch (e) { failed.push(`${q.name}: ${e.message}`); }
    }
    await save();
    res.json({ ok: true, approved, failed });
    checkAll();   // live + embeddable status for the new ones, in the background
  });

  app.post('/api/admin/community/channels/rescan', async (req, res) => {
    try { await load(); res.json({ ok: true, queued: await scanWatchedChannels((req.body || {}).channelId) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/admin/community/channels/remove', async (req, res) => {
    await load(); delete db.channels[(req.body || {}).channelId]; await save(); res.json({ ok: true });
  });

  app.get('/api/admin/community/geocode', async (req, res) => {
    try { res.json({ results: await geocode(String(req.query.q || '').slice(0, 200)) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/admin/community/check', async (req, res) => {
    await load();
    const c = db.cams.find(x => x.id === (req.body || {}).id);
    if (c) { await checkOne(c); await save(); return res.json({ ok: true, cam: c }); }
    checkAll();
    res.json({ ok: true, started: true });
  });

  // Schedules: live checks every 20 min; discovery once a night (~3 AM Central)
  setTimeout(checkAll, 60 * 1000);
  setInterval(checkAll, CHECK_EVERY_MS);
  setInterval(() => {
    const h = new Date(Date.now() - 5 * 3600 * 1000).getUTCHours();
    if (h === 3 && (!db.lastDiscovery || Date.now() - db.lastDiscovery > 20 * 3600 * 1000)) nightly().catch(() => {});
  }, 15 * 60 * 1000);

  return { forState, parseUrl, geocode, _test: { db: () => db, discover, checkOne, visible, replaceEnded, scanWatchedChannels, titleSimilarity, checkAll } };
};
