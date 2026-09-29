// WeatherTV Community Cams — build.1790791200
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
// Staying current (zero YouTube quota): every 20 minutes each approved stream's
// public YouTube page is checked for "isLive":true — the same signal the live
// verifier uses. Streams that have been offline for 6+ hours are hidden from
// the map until they come back.
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
  const known = (ref) => db.cams.some(c => c.ref === ref) || db.queue.some(q => q.ref === ref) || db.rejected.includes(ref);

  // ── Live checks (no YouTube quota) ────────────────────────────────────────
  async function checkOne(c) {
    try {
      if (c.kind === 'image') {
        const r = await fetch(c.ref, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WeatherTV/1.0)' } });
        c.live = r.ok && /image/i.test(r.headers.get('content-type') || '');
      } else {
        const url = c.kind === 'yt-video' ? `https://www.youtube.com/watch?v=${c.ref}` : `https://www.youtube.com/channel/${c.ref}/live`;
        const html = await fetchTextOverHttp(url, { 'Accept-Language': 'en-US,en;q=0.9' });
        c.live = html.includes('"isLive":true');
        if (!c.channelTitle) c.channelTitle = (html.match(/"ownerChannelName":"([^"]{1,80})"/) || [])[1] || c.channelTitle;
      }
    } catch (e) { c.live = null; c.lastError = e.message; }
    c.lastChecked = Date.now();
    if (c.live) c.lastLive = Date.now();
    return c;
  }
  let checking = false;
  async function checkAll() {
    if (checking) return;
    checking = true;
    try {
      await load();
      for (const c of db.cams) { await checkOne(c); await new Promise(r => setTimeout(r, 1500)); }
      await save();
      const live = db.cams.filter(c => c.live).length;
      if (db.cams.length) console.log(`[Community] live check: ${live}/${db.cams.length} streams live`);
    } finally { checking = false; }
  }
  // Shown while live, unchecked, or offline for under 6 h (brief outages).
  // Confirmed offline and not live in the last 6 h → hidden until it returns.
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
      const la = parseFloat(lat), lo = parseFloat(lng);
      db.queue.push({
        id: uid(), ...p, name: String(place || '').slice(0, 120) || 'Suggested camera',
        thumb: p.kind === 'yt-video' ? `https://i.ytimg.com/vi/${p.ref}/mqdefault.jpg` : (p.kind === 'image' ? p.ref : null),
        lat: Number.isFinite(la) ? la : null, lng: Number.isFinite(lo) ? lo : null,
        locationGuess: String(place || '').slice(0, 120), note: String(note || '').slice(0, 300),
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
    const lat = parseFloat(body.lat), lng = parseFloat(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Set a latitude and longitude first');
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

  return { forState, parseUrl, _test: { db: () => db, discover, checkOne, visible } };
};
