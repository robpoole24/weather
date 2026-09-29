// WeatherTV Community Cams — build.1790827200
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

function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

module.exports = function setupCommunityCams(app, deps) {
  const { rGet, rSet, fetchTextOverHttp, youtubeKey, stateFor, upstreamCount = () => {} } = deps;
  let db = { cams: [], queue: [], rejected: [], lastDiscovery: null, nextPlace: 0 };
  let loaded = false;

  async function load() {
    if (loaded) return;
    const saved = await rGet(STORE_KEY);
    if (saved && Array.isArray(saved.cams)) db = { ...db, ...saved };
    loaded = true;
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
        const id = (html.match(/"(?:channelId|externalId)":"(UC[A-Za-z0-9_-]{22})"/) || [])[1];
        if (!id) throw new Error('Could not find that YouTube channel');
        return { kind: 'yt-channel', ref: id };
      }
      throw new Error('Paste a YouTube video, live or channel link');
    }
    if (/\.(jpe?g|png|webp|gif)$/i.test(u.pathname)) return { kind: 'image', ref: u.href };
    throw new Error('Supported: YouTube links, or a direct link to a camera image (.jpg/.png)');
  }
  // ── Place → coordinates (so nobody has to look up lat/long) ──────────────
  // OpenStreetMap Nominatim: street addresses and landmarks ("Broad St,
  // Greendale WI", "Waikiki Beach"). Usage policy: identify ourselves, max 1
  // request/second, cache results, credit OpenStreetMap. Falls back to
  // Open-Meteo's city search. Limited to the US and its territories.
  const geoCache = new Map();
  let geoChain = Promise.resolve();
  function geocode(q) {
    const key = String(q || '').trim().toLowerCase();
    if (key.length < 3) return Promise.resolve([]);
    if (geoCache.has(key)) return Promise.resolve(geoCache.get(key));
    const job = geoChain.then(async () => {
      let out = [];
      try {
        const txt = await fetchTextOverHttp('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5'
          + '&countrycodes=us,pr,vi,gu,as,mp,ca,jm,bs,tc,ky,cu,ht,do,vg,ai,kn,ag,dm,lc,vc,bb,gd,tt,aw,cw,bq,sx,mf,bl,gp,mq,bm,mx,bz'
          + `&q=${encodeURIComponent(q)}`, { 'User-Agent': 'WeatherTV/1.0 (https://watchweathertv.com)', 'Accept-Language': 'en' });
        out = (JSON.parse(txt) || []).map(r => ({ lat: +r.lat, lng: +r.lon, label: r.display_name, source: 'OpenStreetMap' }));
      } catch (_) { /* fall through */ }
      if (!out.length) {
        try {
          const j = JSON.parse(await fetchTextOverHttp(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=en&format=json`));
          out = (j.results || []).filter(r => !['GB', 'IE', 'AU', 'NZ'].includes(r.country_code))
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
          if (!it) { c.live = false; c.lastError = 'Video not found (removed or private)'; }
          else {
            c.embeddable = !(it.status && it.status.embeddable === false);
            c.live = c.embeddable && it.snippet && it.snippet.liveBroadcastContent === 'live';
            c.lastError = !c.embeddable ? 'The owner does not allow embedding this stream' : c.live ? null : 'Not live on YouTube right now';
            if (!c.channelTitle && it.snippet) c.channelTitle = it.snippet.channelTitle || '';
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
      if (c.kind === 'image') {
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
  let checking = false;
  async function checkAll() {
    if (checking) return;
    checking = true;
    try {
      await load();
      await checkVideos(db.cams.filter(c => c.kind === 'yt-video'));
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
        id: uid(), kind: 'yt-video', ref: id, name: (sn.title || '').slice(0, 120), channelTitle: sn.channelTitle || '',
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
    if (!/^(1|true|yes)$/i.test(process.env.COMMUNITY_DISCOVERY || '')) return;
    await load();
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
    const player = c.kind === 'yt-video' ? `https://www.youtube-nocookie.com/embed/${c.ref}?autoplay=1&mute=1&playsinline=1`
      : c.kind === 'yt-channel' ? `https://www.youtube.com/embed/live_stream?channel=${c.ref}&autoplay=1&mute=1` : null;
    return {
      id: 'comm-' + c.id, name: c.name, lat: c.lat, lng: c.lng, source: 'community',
      playerUrl: player, imageUrl: c.kind === 'image' ? c.ref : null, videoUrl: null, direction: null,
      pageUrl: c.kind === 'yt-video' ? `https://www.youtube.com/watch?v=${c.ref}` : c.kind === 'yt-channel' ? `https://www.youtube.com/channel/${c.ref}/live` : null,
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
        thumb: p.kind === 'yt-video' ? `https://i.ytimg.com/vi/${p.ref}/mqdefault.jpg` : (p.kind === 'image' ? p.ref : null),
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
      discovery: { nightly: /^(1|true|yes)$/i.test(process.env.COMMUNITY_DISCOVERY || ''), perNight: parseInt(process.env.COMMUNITY_DISCOVERY_PER_NIGHT || '10', 10) || 10,
                   lastRun: db.lastDiscovery, places: DISCOVERY_PLACES.length },
    });
  });
  const approveInto = async (base, body) => {
    const lat = parseCoord(body.lat, 'lat'), lng = parseCoord(body.lng, 'lng');
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Set a latitude and longitude first (e.g. 42.9375 and -87.9969, or 42.9375° N and 87.9969° W)');
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error('Those coordinates are out of range');
    const state = stateFor(lat, lng);
    if (!state) throw new Error('That location is not in a U.S. state or territory');
    const cam = { id: base.id || uid(), kind: base.kind, ref: base.ref, name: String(body.name || base.name || 'Community camera').slice(0, 120),
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
  // Bulk import: pasted text with a place line followed by one or more links.
  // Each link is looked up by its place and queued with the location filled in.
  app.post('/api/admin/community/import', async (req, res) => {
    try {
      await load();
      const lines = String((req.body || {}).text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 400);
      let place = '', queued = 0, skipped = 0, noPlace = 0;
      const report = [];
      for (const line of lines) {
        if (!/^https?:\/\//i.test(line)) { place = line; continue; }
        let p;
        try { p = await parseUrl(line); } catch (e) { report.push(`✗ ${line.slice(0, 60)} — ${e.message}`); skipped++; continue; }
        if (known(p.ref)) { report.push(`• already listed: ${place || line.slice(0, 40)}`); skipped++; continue; }
        const hit = place ? (await geocode(place))[0] : null;
        if (!hit) noPlace++;
        db.queue.push({
          id: uid(), ...p, name: place || 'Imported camera',
          thumb: p.kind === 'yt-video' ? `https://i.ytimg.com/vi/${p.ref}/mqdefault.jpg` : null,
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
  app.post('/api/admin/community/import-channel', async (req, res) => {
    try {
      await load();
      if (!youtubeKey) throw new Error('YOUTUBE_API_KEY not set');
      const raw = String((req.body || {}).channel || '').trim();
      const p = await parseUrl(/^https?:/i.test(raw) ? raw : `https://www.youtube.com/${raw.startsWith('@') ? raw : '@' + raw}`);
      if (p.kind !== 'yt-channel') throw new Error('Give a channel link or @handle');
      const maxPages = Math.min(6, Math.max(1, parseInt((req.body || {}).maxPages || '4', 10) || 4));
      let token = '', pages = 0, queued = 0, skipped = 0, channelTitle = '';
      const report = [];
      do {
        upstreamCount('youtubeSearchCommunity');
        const j = JSON.parse(await fetchTextOverHttp('https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&eventType=live&maxResults=50'
          + `&channelId=${p.ref}${token ? '&pageToken=' + token : ''}&key=${encodeURIComponent(youtubeKey)}`));
        if (j.error) throw new Error(j.error.message || 'YouTube search failed');
        for (const it of j.items || []) {
          const id = it.id && it.id.videoId, sn = it.snippet || {};
          channelTitle = sn.channelTitle || channelTitle;
          if (!id || known(id)) { skipped++; continue; }
          const place = placeFromTitle(sn.title, sn.channelTitle);
          const hit = place.length >= 3 ? (await geocode(place))[0] : null;
          db.queue.push({
            id: uid(), kind: 'yt-video', ref: id, name: (sn.title || '').slice(0, 120), channelTitle: sn.channelTitle || '',
            thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, lat: hit ? hit.lat : null, lng: hit ? hit.lng : null,
            locationGuess: hit ? `From title "${place}" → ${hit.label}` : `Couldn't place "${place}" — set it on the map`,
            source: 'channel', foundAt: Date.now(),
          });
          queued++;
          report.push(`${hit ? '✓' : '?'} ${sn.title}`);
        }
        token = j.nextPageToken || '';
        pages++;
      } while (token && pages < maxPages);
      db.queue = db.queue.slice(-600);
      await save();
      res.json({ ok: true, channelTitle, pages, unitsUsed: pages * 100, queued, skipped, report: report.slice(0, 300) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Approve every queued camera that already has a location (one click after a big import)
  app.post('/api/admin/community/approve-located', async (req, res) => {
    await load();
    const ready = db.queue.filter(q => Number.isFinite(q.lat) && Number.isFinite(q.lng));
    let approved = 0; const failed = [];
    for (const q of ready) {
      try {
        const state = stateFor(q.lat, q.lng);
        if (!state) throw new Error('outside our camera regions');
        db.cams.push({ id: q.id, kind: q.kind, ref: q.ref, name: q.name, channelTitle: q.channelTitle || '', lat: q.lat, lng: q.lng,
                       state, addedAt: Date.now(), source: q.source, live: null });
        db.queue = db.queue.filter(x => x.id !== q.id);
        approved++;
      } catch (e) { failed.push(`${q.name}: ${e.message}`); }
    }
    await save();
    res.json({ ok: true, approved, failed });
    checkAll();   // live + embeddable status for the new ones, in the background
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

  return { forState, parseUrl, geocode, _test: { db: () => db, discover, checkOne, visible } };
};
