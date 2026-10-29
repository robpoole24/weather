// WeatherTV Channel Discovery — finds weather channels you don't carry yet.
//
// Where candidates come from:
//   1. Fresh-upload searches: weather topics uploaded in the last 24 h, in a
//      rotating list of terms and languages (100 quota units each). New, small
//      creators show up because they're posting, not because anyone links them.
//      During active severe weather the rotation leans on LIVE searches.
//   2. The network: channels your approved channels feature on their pages
//      (channelSections, 1 unit per channel, ~30 channels a day).
//
// Every candidate is vetted from its own uploads before you see it (~3 units):
// how much of it is weather, how often it posts, whether it streams live, and a
// suggested type — Chaser, Forecaster, Weather creator, React channel or Mixed.
// Channels that are barely weather (<15%) are skipped quietly and not rechecked
// for 60 days. Nothing is added without your approval; Reject is remembered for
// good, "Not now" brings it back in 30 days.
//
// Budget: DISCOVERY_SEARCHES_PER_DAY (default 16 → ~1,600 units) + ~30 network
// checks + vetting (~3 units per new channel). Turn off with CHANNEL_DISCOVERY=false.

const STORE_KEY = 'wt:discovery:v1';
const DAY = 864e5;

// Search terms: [query, extra params]. Rotated in order, one per search.
const TERMS = [
  ['storm chase', {}], ['tornado', {}], ['severe weather forecast', {}], ['weather forecast update', {}],
  ['hurricane update', {}], ['storm chasing vlog', {}], ['supercell', {}], ['tropical storm forecast', {}],
  ['winter storm forecast', {}], ['severe weather outlook', {}], ['storm chaser', { regionCode: 'AU' }],
  ['severe thunderstorm', { regionCode: 'AU' }], ['cyclone update', { regionCode: 'AU' }], ['storm reaction', { regionCode: 'GB' }],
  ['tornado reaction', {}], ['weather explained', {}], ['lightning storm', {}], ['hail storm', {}],
  ['caza de tormentas', { relevanceLanguage: 'es' }], ['tornado en vivo', { relevanceLanguage: 'es' }],
  ['caçador de tempestades', { relevanceLanguage: 'pt' }], ['Sturmjäger', { relevanceLanguage: 'de' }],
  ['chasseur d\'orages', { relevanceLanguage: 'fr' }], ['typhoon update', {}], ['flash flooding', {}],
  ['weather radar live', {}], ['blizzard', {}], ['derecho', {}],
];
const LIVE_TERMS = ['tornado live', 'storm chase live', 'severe weather live', 'hurricane live', 'live storm chasing'];

const WEATHER = /\b(tornado(e?s)?|tornadic|storms?|stormy|severe|weather|forecasts?|forecasting|hurricanes?|tropic(s|al)|cyclones?|typhoons?|hail|supercells?|chas(e|es|ing|er|ers)|radar|blizzards?|snow(storm|fall)?|winter storm|flood(s|ing)?|derecho|lightning|thunder(storms?)?|wind ?storm|heat ?wave|outlook|spc|nws|el ni[ñn]o|la ni[ñn]a|meteorolog\w*|meteorologist|wx|tormentas?|tempestades?|clima|unwetter|gewitter|m[ée]t[ée]o|orages?|funnel|wall cloud|dryline|squall|monsoon|drought|nor'?easter|atmospheric river|polar vortex|aurora)\b/i;
const CHASE = /\b(chas(e|es|ing|er|ers)|intercept(ed)?|on the ground|caught|wall cloud|funnel|road ?trip|dashcam|close range)\b|caza|caçador|sturmj/i;
const FORECAST = /\b(forecasts?|outlooks?|update|briefing|discussion|models?|tropics|threat|risk|timeline|what to expect|this week|weekend|next week|maps?|explained|analysis)\b/i;
const REACT = /\breact(s|ing|ion|ions)?\b|\breacting to\b/i;
const LIVE_T = /\blive\b|🔴/i;

function createChannelDiscovery(app, deps) {
  const { rGet, rSet, ytFetch, getApiKey, isQuotaExceeded, markQuotaExceeded, checkQuotaError, trackBurn = () => {},
          loadData, saveData, subscribe = async () => {}, isSevereActive = async () => false } = deps;
  let db = { candidates: {}, rejected: [], snoozed: {}, skipped: {}, termIdx: 0, netIdx: 0, runs: [], today: null, searchesToday: 0, unitsToday: 0 };
  let loaded = false, running = false;

  async function load() {
    if (loaded) return;
    const s = await rGet(STORE_KEY).catch(() => null);
    const v = typeof s === 'string' ? JSON.parse(s) : s;
    if (v && v.candidates) db = { ...db, ...v };
    loaded = true;
  }
  const save = () => rSet(STORE_KEY, db);
  const enabled = () => !/^(false|0|no|off)$/i.test(process.env.CHANNEL_DISCOVERY || '');
  const perDay = () => parseInt(process.env.DISCOVERY_SEARCHES_PER_DAY || '16', 10) || 16;

  function rollDay() {
    const d = new Date().toISOString().slice(0, 10);
    if (db.today !== d) { db.today = d; db.searchesToday = 0; db.unitsToday = 0; }
  }
  async function yt(path, units) {
    const key = getApiKey();
    if (!key || isQuotaExceeded()) throw new Error('YouTube API unavailable (no key or quota used up)');
    trackBurn(true, units); rollDay(); db.unitsToday += units;
    const j = await ytFetch('https://www.googleapis.com/youtube/v3/' + path + (path.includes('?') ? '&' : '?') + 'key=' + key);
    if (checkQuotaError(j)) { markQuotaExceeded(true); throw new Error('quota exceeded'); }
    if (j.error) throw new Error((j.error.errors?.[0]?.reason || j.error.code) + ' ' + (j.error.message || ''));
    return j;
  }

  // Channels already on WeatherTV
  function carried() {
    const ids = new Set();
    for (const g of (loadData().groups || [])) for (const c of g.channels) ids.add(c.id);
    return ids;
  }
  function isNew(id, have) {
    if (!/^UC[\w-]{22}$/.test(id) || have.has(id) || db.rejected.includes(id) || db.candidates[id]) return false;
    if (db.snoozed[id] && Date.now() < db.snoozed[id]) return false;
    if (db.skipped[id] && Date.now() - db.skipped[id] < 60 * DAY) return false;
    return true;
  }

  // ── Vetting: read a channel's own uploads ───────────────────────────────────
  async function vet(ids, foundVia) {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const ch = await yt('channels?part=snippet,statistics,contentDetails&id=' + batch.join(','), 1);
      for (const c of ch.items || []) {
        try {
          const uploads = c.contentDetails?.relatedPlaylists?.uploads;
          if (!uploads) continue;
          const pl = await yt('playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=' + uploads, 1);
          const vids = (pl.items || []).map(it => ({ id: it.contentDetails?.videoId, title: it.snippet?.title || '', at: Date.parse(it.contentDetails?.videoPublishedAt || it.snippet?.publishedAt || '') || 0 }))
            .filter(v => v.id);
          let lives = 0, lastLive = null;
          if (vids.length) {
            const vd = await yt('videos?part=liveStreamingDetails&fields=items(id,liveStreamingDetails(actualStartTime))&id=' + vids.map(v => v.id).join(','), 1);
            for (const v of vd.items || []) {
              const t = Date.parse(v.liveStreamingDetails?.actualStartTime || '');
              if (t && Date.now() - t < 60 * DAY) { lives++; if (!lastLive || t > lastLive) lastLive = t; }
            }
          }
          const n = vids.length || 1, share = (re) => vids.filter(v => re.test(v.title)).length / n;
          const descr = c.snippet?.description || '';
          const weather = share(WEATHER), react = share(REACT), chase = share(CHASE), forecast = share(FORECAST);
          const recent = vids.filter(v => Date.now() - v.at < 30 * DAY).length;
          const lastPost = vids.reduce((m, v) => Math.max(m, v.at), 0) || null;
          const type = react >= 0.3 && weather >= 0.3 ? 'React channel'
            : weather < 0.4 ? 'Mixed'
            : (chase >= 0.2 || /storm ?chas|chaser/i.test(descr)) ? 'Chaser'
            : (forecast >= 0.3 || /meteorolog|forecast/i.test(descr)) ? 'Forecaster' : 'Weather creator';
          const row = {
            id: c.id, name: c.snippet?.title || c.id, country: c.snippet?.country || null,
            thumb: c.snippet?.thumbnails?.medium?.url || c.snippet?.thumbnails?.default?.url || null,
            subs: c.statistics?.hiddenSubscriberCount ? null : +c.statistics?.subscriberCount || 0, videos: +c.statistics?.videoCount || 0,
            weather: Math.round(weather * 100), react: Math.round(react * 100), type,
            postsPerWeek: +(recent / 4.3).toFixed(1), lastPost, lives60d: lives, lastLive,
            samples: vids.slice(0, 6).map(v => ({ id: v.id, title: v.title })),
            suggestedGroup: type === 'Chaser' ? 'chasers' : type === 'Forecaster' ? 'forecasters' : 'creators',
            foundVia, foundAt: Date.now(),
          };
          // Barely weather and not vouched for by a channel you carry → skip quietly
          if (row.weather < 15 && !/^featured by/.test(foundVia)) { db.skipped[c.id] = Date.now(); continue; }
          if (!lastPost || Date.now() - lastPost > 180 * DAY) { db.skipped[c.id] = Date.now(); continue; }   // dormant
          out.push(row);
        } catch (e) { if (/quota/.test(e.message)) throw e; }
      }
    }
    return out;
  }

  function addCandidates(rows) { let n = 0; for (const r of rows) if (!db.candidates[r.id]) { db.candidates[r.id] = r; n++; } return n; }

  // ── Source 1: fresh-upload (or live) searches ───────────────────────────────
  async function runSearch() {
    const severe = await isSevereActive().catch(() => false);
    let q, extra = {}, live = false;
    if (severe && db.searchesToday % 2 === 0) { q = LIVE_TERMS[db.searchesToday / 2 % LIVE_TERMS.length]; live = true; }
    else { [q, extra] = TERMS[db.termIdx % TERMS.length]; db.termIdx++; }
    const p = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '50', q, ...extra,
      ...(live ? { eventType: 'live' } : { order: 'date', publishedAfter: new Date(Date.now() - DAY).toISOString() }) });
    const r = await yt('search?' + p.toString(), 100);
    db.searchesToday++;
    const have = carried();
    const ids = [...new Set((r.items || []).map(it => it.snippet?.channelId).filter(Boolean))].filter(id => isNew(id, have));
    const rows = await vet(ids, `search: “${q}”${live ? ' (live now)' : ''}${extra.regionCode ? ' · ' + extra.regionCode : ''}`);
    return { source: 'search', q, live, results: (r.items || []).length, newChannels: ids.length, added: addCandidates(rows) };
  }

  // ── Source 2: channels your channels feature ────────────────────────────────
  async function runNetwork(count = 30) {
    const all = [];
    for (const g of (loadData().groups || [])) for (const c of g.channels) if (c.enabled !== false) all.push(c);
    if (!all.length) return { source: 'network', checked: 0, added: 0 };
    const have = carried(), found = new Map();
    let checked = 0;
    for (let i = 0; i < Math.min(count, all.length); i++) {
      const ch = all[(db.netIdx + i) % all.length];
      checked++;
      try {
        const s = await yt('channelSections?part=contentDetails&channelId=' + ch.id, 1);
        for (const sec of s.items || []) for (const id of sec.contentDetails?.channels || []) if (isNew(id, have) && !found.has(id)) found.set(id, ch.name);
      } catch (e) { if (/quota/.test(e.message)) break; }
    }
    db.netIdx = (db.netIdx + checked) % all.length;
    let added = 0;
    const byFeaturer = new Map();
    for (const [id, by] of found) { if (!byFeaturer.has(by)) byFeaturer.set(by, []); byFeaturer.get(by).push(id); }
    for (const [by, ids] of byFeaturer) added += addCandidates(await vet(ids, 'featured by ' + by));
    return { source: 'network', checked, newChannels: found.size, added };
  }

  async function run(kind) {
    await load();
    if (running) return { skipped: 'already running' };
    running = true;
    const t0 = Date.now();
    try {
      rollDay();
      const r = kind === 'network' ? await runNetwork() : await runSearch();
      db.runs.unshift({ at: t0, ...r }); db.runs = db.runs.slice(0, 60);
      if (r.added) console.log(`[Discovery] ${r.source}${r.q ? ' “' + r.q + '”' : ''}: ${r.added} new candidate channel(s)`);
      return r;
    } catch (e) {
      db.runs.unshift({ at: t0, source: kind || 'search', error: e.message }); db.runs = db.runs.slice(0, 60);
      return { error: e.message };
    } finally { running = false; await save(); }
  }

  // Schedule: searches spread over the day; the network once a day
  function start() {
    if (!enabled()) { console.log('[Discovery] off (CHANNEL_DISCOVERY=false)'); return; }
    setInterval(async () => {
      await load(); rollDay();
      if (db.searchesToday < perDay()) await run('search');
    }, Math.max(30, Math.floor(24 * 60 / perDay())) * 60 * 1000).unref();
    setInterval(async () => {
      await load();
      if (!db.lastNetwork || Date.now() - db.lastNetwork > DAY - 3600e3) { db.lastNetwork = Date.now(); await run('network'); }
    }, 3 * 3600 * 1000).unref();
  }

  // ── Admin API (behind adminAuth via app.use('/api/admin')) ──────────────────
  app.get('/api/admin/discovery', async (req, res) => {
    await load(); rollDay();
    const groups = (loadData().groups || []).map(g => ({ id: g.id, label: g.label,
      collections: g.channels.flatMap(c => (c.collections || []).map(k => ({ id: c.id + '::' + k.id, label: k.label, owner: c.name }))) }));
    const list = Object.values(db.candidates).sort((a, b) => (b.lives60d > 0) - (a.lives60d > 0) || b.weather - a.weather || (b.lastPost || 0) - (a.lastPost || 0));
    res.json({ candidates: list, groups, rejected: db.rejected.length, snoozed: Object.keys(db.snoozed).length,
      today: { searches: db.searchesToday, of: perDay(), units: db.unitsToday }, runs: db.runs.slice(0, 20), enabled: enabled() });
  });
  app.post('/api/admin/discovery/run', async (req, res) => res.json(await run((req.body || {}).kind === 'network' ? 'network' : 'search')));
  app.post('/api/admin/discovery/approve', async (req, res) => {
    await load();
    const { id, group, collectionIds = [], name, weatherOnly } = req.body || {};
    const c = db.candidates[id];
    const data = loadData();
    const g = (data.groups || []).find(x => x.id === group);
    if (!c || !g) return res.status(400).json({ error: 'Pick a group first (or refresh the page)' });
    if (carried().has(id)) { delete db.candidates[id]; await save(); return res.status(409).json({ error: 'Already on WeatherTV' }); }
    const cols = (Array.isArray(collectionIds) ? collectionIds : [collectionIds]).filter(Boolean);
    g.channels.push({ id, name: String(name || c.name).slice(0, 80), hasLive: true, enabled: true, ...(weatherOnly ? { weatherOnly: true } : {}),
      ...(cols.length ? { collectionIds: cols, collectionId: cols[0] } : {}) });
    saveData(data);
    delete db.candidates[id];
    await save();
    subscribe(id).catch(() => {});   // WebSub, so their lives are caught from day one
    res.json({ ok: true });
  });
  app.post('/api/admin/discovery/reject', async (req, res) => {
    await load();
    const id = (req.body || {}).id;
    if (id) { db.rejected.push(id); db.rejected = db.rejected.slice(-5000); delete db.candidates[id]; await save(); }
    res.json({ ok: true });
  });
  app.post('/api/admin/discovery/snooze', async (req, res) => {
    await load();
    const id = (req.body || {}).id;
    if (id && db.candidates[id]) { db.snoozed[id] = Date.now() + 30 * DAY; delete db.candidates[id]; await save(); }
    res.json({ ok: true });
  });

  return { start, run, _test: { db: () => db, vet, load, WEATHER, REACT } };
}

module.exports = { createChannelDiscovery };
