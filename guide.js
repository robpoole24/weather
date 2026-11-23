// WeatherTV Channel Guide (2.0 prototype) — updated 2026-11-23T02:30:00Z build.1795401000
// One call that returns the whole cable-style guide: blocks of numbered channels,
// each with its live stream (if any) and newest uploads. Built ONLY from data the
// server already caches (live statuses, the twice-daily recent-video fetch,
// playlists, highlights) — a guide request never spends YouTube quota.
//
//   GET  /api/guide                       the guide
//   GET  /api/admin/guide                 blocks, sources (groups/collections → block) and every channel
//   POST /api/admin/guide/preview         the same, for a draft setup (nothing saved)
//   PUT  /api/admin/guide                 save the setup (data.guide, v2)
//   POST /api/admin/guide/countries       suggested country codes from YouTube (1 unit per 50 channels)
//
// Channels 1–10 are Weather TV's own: 1 Live Now, 2 Forecast, 3 Live Radar,
// 4 WeatherStar, 5 Highlights, 6–10 playlists.
//
// Which block a channel is in (first match wins):
//   1. you placed it there in admin
//   2. it's in a collection that's set to go to a block
//   3. its country / state code (IN → Regional Asia, US-WI → Regional United States…)
//   4. its group's block (Forecasters → Forecasters…)
// Inside a block: channels you've ordered, then the rest (regional blocks sort those
// by code). Numbers: fixed numbers first; everyone else counts up from the block's start.

const MAX_CELLS = 10;
const LIVE_MAX_AGE = 12 * 3600 * 1000;
const MEMO_MS = 30 * 1000;
const RESERVED_MAX = 10;   // 1–10: Weather TV's own channels

const DEFAULT_BLOCKS = [
  ['forecasters', 'FORECASTERS', 11, 199],
  ['chasers', 'STORM CHASERS', 200, 499],
  ['creators', 'OTHER WEATHER CREATORS', 500, 699],
  ['react', 'WEATHER REACT CHANNELS', 700, 799],
  ['reg-us', 'REGIONAL UNITED STATES', 800, 899],
  ['reg-europe', 'REGIONAL EUROPE', 900, 999],
  ['reg-oceania', 'REGIONAL AUSTRALIA', 1000, 1099],
  ['reg-asia', 'REGIONAL ASIA', 1100, 1199],
  ['reg-samerica', 'REGIONAL SOUTH AMERICA', 1200, 1299],
  ['reg-africa', 'REGIONAL AFRICA', 1300, 1399],
  ['radar', 'WEATHER RADAR CHANNELS', 1400, 1600],
];
const DEFAULT_GROUP_BLOCK = { forecasters: 'forecasters', chasers: 'chasers', creators: 'creators', react: 'react', reacts: 'react' };
// Collections that go to a block unless changed in admin (matched by name)
const DEFAULT_COLLECTION_BLOCK = [
  [/react/i, 'react'],
  [/radar/i, 'radar'],
  [/US States|United States|US Regional/i, 'reg-us'],
  [/Europe|\bUK\b|United Kingdom|Britain/i, 'reg-europe'],
  [/Oceania|Australia|New Zealand/i, 'reg-oceania'],
  [/Asia|India|Pakistan|Bangladesh|Philippines|Japan/i, 'reg-asia'],
  [/South America|Latin|Brazil|Argentina/i, 'reg-samerica'],
  [/Africa/i, 'reg-africa'],
];

// Country / state codes → regional block. A plain "US" places nothing (most US
// channels are national); a state code like US-WI goes to Regional United States.
const EUROPE = 'GB UK IE FR DE ES PT IT NL BE LU CH AT DK NO SE FI IS PL CZ SK HU RO BG GR HR SI RS BA ME MK AL XK UA BY MD LT LV EE MT CY TR RU GE AM AZ MC LI AD SM VA FO GI IM JE GG'.split(' ');
const ASIA = 'IN PK BD LK NP BT MV AF CN JP KR KP TW HK MO MN PH VN TH MY SG ID MM KH LA BN TL IR IQ SA AE QA KW BH OM YE JO LB SY IL PS KZ UZ TM KG TJ'.split(' ');
const OCEANIA = 'AU NZ PG FJ SB VU NC PF WS TO KI FM MH PW NR TV CK NU'.split(' ');
const SAMERICA = 'BR AR CL CO PE VE EC BO PY UY GY SR GF FK'.split(' ');
const AFRICA = 'ZA NG KE EG MA DZ TN LY ET GH TZ UG RW SN CI CM AO MZ ZW ZM BW NA MG MU SD SS SO DJ ER ML NE TD BF BJ TG LR SL GN GW GM MR CV CF CG CD GA GQ ST BI MW LS SZ KM SC RE YT SH'.split(' ');
function regionOfCode(code) {
  const c = String(code || '').toUpperCase();
  if (/^US-[A-Z]{2}$/.test(c)) return 'reg-us';
  const cc = c.slice(0, 2);
  if (EUROPE.includes(cc)) return 'reg-europe';
  if (ASIA.includes(cc)) return 'reg-asia';
  if (OCEANIA.includes(cc)) return 'reg-oceania';
  if (SAMERICA.includes(cc)) return 'reg-samerica';
  if (AFRICA.includes(cc)) return 'reg-africa';
  return null;
}

const STOP = new Set(['the', 'and', 'of', 'a', 'tv', 'live', 'wx', 'channel']);
function callSign(name) {
  const words = String(name || '').replace(/\(.*?\)/g, '').replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  const keep = words.filter((w) => !STOP.has(w.toLowerCase()));
  const w = keep.length ? keep : words;
  if (!w.length) return '';
  if (w.length === 1) return w[0].slice(0, 6).toUpperCase();
  return (w[0].slice(0, 3) + w[1].slice(0, 3)).toUpperCase();
}
const cleanTag = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9+&'-]/g, '').slice(0, 7);
const cleanLabel = (s) => String(s || '').replace(/[<>]/g, '').trim().slice(0, 40);
const cleanCode = (s) => { const c = String(s || '').toUpperCase().trim(); return /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(c) ? c : ''; };
const ID_RE = /^[A-Za-z0-9:_-]{1,90}$/;
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Math.round(+v); return Number.isFinite(n) ? n : null; };

module.exports = function guide(app, { loadData, saveData, cache, filterRecent, ytFetch, getApiKey, trackBurn, checkQuotaError }) {
  let memo = { at: 0, body: null };

  function videoCells(channelId) {
    const entry = cache.recentVideos[channelId];
    let items = (entry && entry.items) || [];
    try { if (filterRecent) items = filterRecent(items, channelId) || items; } catch (e) {}
    const seen = new Set();
    const out = [];
    for (const it of items) {
      const v = it && it.id && (it.id.videoId || (typeof it.id === 'string' ? it.id : ''));
      if (!v || seen.has(v)) continue;
      seen.add(v);
      const s = it.snippet || {};
      out.push({ v, t: s.title || '', at: s.publishedAt || null });
      if (out.length >= MAX_CELLS + 1) break;
    }
    return out;
  }
  function liveOf(channelId) {
    const st = cache.liveStatuses[channelId];
    if (!st || !st.isLive) return null;
    if (st.checkedAt && Date.now() - st.checkedAt > LIVE_MAX_AGE) return null;
    return st;
  }
  function channelRow(ch, n, call, area) {
    let cells = videoCells(ch.id);
    const st = liveOf(ch.id);
    let live = false;
    if (st) {
      live = true;
      const vid = st.videoId && st.videoId !== 'live' ? st.videoId : null;
      const known = vid ? cells.find((c) => c.v === vid) : null;
      cells = cells.filter((c) => c.v !== vid);
      cells.unshift({ v: vid, t: (known && known.t) || 'Live now', at: (known && known.at) || null, live: true, ch: vid ? null : ch.id });
    }
    return { n, id: ch.id, name: ch.name, call, area: area || undefined, live, cells: cells.slice(0, MAX_CELLS) };
  }

  const configOf = (data) => (data.guide && data.guide.v === 2 ? data.guide : {});

  // ── Lay out every block and channel (no videos). Shared by the guide and admin. ──
  function layout(data, cfgIn) {
    const cfg = cfgIn || configOf(data);
    const bcfg = cfg.blocks || {}, map = cfg.map || {}, ccfg = cfg.channels || {};
    const groups = data.groups || [];

    // Blocks: defaults (renamable / resizable) + blocks made in admin
    const meta = {};
    DEFAULT_BLOCKS.forEach(([id, label, start, end]) => { meta[id] = { id, label, start, end, custom: false }; });
    Object.entries(bcfg).forEach(([id, b]) => {
      if (!b || !ID_RE.test(id)) return;
      if (!meta[id]) meta[id] = { id, label: cleanLabel(b.label) || id.toUpperCase(), start: 0, end: 0, custom: true };
      const m = meta[id];
      if (b.label) m.label = cleanLabel(b.label) || m.label;
      if (num(b.start) > RESERVED_MAX) m.start = num(b.start);
      if (num(b.end) != null && num(b.end) >= m.start) m.end = num(b.end);
      if (num(b.order) != null) m.order = num(b.order);
    });
    let extra = 1700;
    const bump = () => { const s = extra; extra += 100; return s; };
    Object.values(meta).forEach((m) => { if (!(m.start > RESERVED_MAX)) m.start = bump(); if (!(m.end >= m.start)) m.end = m.start + 99; });

    // Sources: groups and collections, each sending its channels to a block
    const sources = [];
    const members = {};
    const groupOf = {}, adminIdx = {};
    const channels = [];
    groups.forEach((g) => (g.channels || []).forEach((ch) => {
      if (ch.enabled === false) return;
      if (!groupOf[ch.id]) { groupOf[ch.id] = g; adminIdx[ch.id] = channels.length; channels.push(ch); }
      new Set([...(ch.collectionIds || []), ...(ch.collectionId ? [ch.collectionId] : [])]).forEach((k) => { (members[k] = members[k] || []).push(ch.id); });
    }));
    const has = (k) => Object.prototype.hasOwnProperty.call(map, k);
    const target = (key, def) => (has(key) ? (map[key] && meta[map[key]] ? map[key] : null) : def);
    groups.forEach((g) => {
      let def = DEFAULT_GROUP_BLOCK[g.id] || null;
      if (!def) {                                                // a group with no block yet gets its own
        const id = 'grp-' + g.id;
        if (!meta[id]) meta[id] = { id, label: String(g.label || g.id).toUpperCase(), start: bump(), custom: false, end: 0 };
        if (!(meta[id].end >= meta[id].start)) meta[id].end = meta[id].start + 99;
        def = id;
      }
      sources.push({ key: 'g:' + g.id, label: g.label || g.id, kind: 'group', count: (g.channels || []).filter((c) => c.enabled !== false).length, def, block: target('g:' + g.id, def) || def });
      (g.collections || []).forEach((col) => {
        if (col.enabled === false) return;
        const k = 'group:' + g.id + '::' + col.id;
        const hit = DEFAULT_COLLECTION_BLOCK.find(([re]) => re.test(col.label || ''));
        const d = hit ? hit[1] : null;
        sources.push({ key: 'c:' + k, label: (g.label || g.id) + ' › ' + (col.label || col.id), kind: 'collection', count: (members[k] || []).length, def: d, block: target('c:' + k, d) });
      });
      (g.channels || []).forEach((lead) => (lead.collections || []).forEach((col) => {
        if (col.enabled === false) return;
        const k = lead.id + '::' + col.id;
        sources.push({ key: 'c:' + k, label: (lead.name || '') + ' › ' + (col.label || col.id), kind: 'collection', count: (members[k] || []).length, def: null, block: target('c:' + k, null) });
      }));
    });
    const srcBlock = {}; sources.forEach((s) => { srcBlock[s.key] = s.block; });

    // Place every channel
    const lists = {}; Object.keys(meta).forEach((id) => { lists[id] = []; });
    const hidden = [];
    const info = {};
    channels.forEach((ch) => {
      const c = ccfg[ch.id] || {};
      const area = cleanCode(c.area);
      let block = null, by = null;
      if (c.block === 'none') { block = 'none'; by = 'you'; }
      else if (c.block && meta[c.block]) { block = c.block; by = 'you'; }
      if (!block) {
        const keys = [...new Set([...(ch.collectionIds || []), ...(ch.collectionId ? [ch.collectionId] : [])])];
        const k = keys.find((key) => srcBlock['c:' + key]);
        if (k) { block = srcBlock['c:' + k]; by = 'collection'; }
      }
      const reg = area ? regionOfCode(area) : null;
      if (!block && reg && meta[reg]) { block = reg; by = 'code'; }
      if (!block) { block = srcBlock['g:' + groupOf[ch.id].id] || 'creators'; by = 'group'; }
      info[ch.id] = { area, by, own: by === 'you', call: cleanTag(c.call) || callSign(ch.name), pos: num(c.pos), fixed: num(c.n) };
      if (block === 'none') hidden.push(ch); else lists[block].push(ch);
    });

    // Order inside each block
    Object.keys(lists).forEach((bid) => {
      const regional = /^reg-/.test(bid);
      lists[bid].sort((a, b) => {
        const A = info[a.id], Bb = info[b.id];
        if (A.pos != null && Bb.pos != null) return A.pos - Bb.pos || adminIdx[a.id] - adminIdx[b.id];
        if (A.pos != null) return -1;
        if (Bb.pos != null) return 1;
        if (regional && A.area !== Bb.area) return (A.area || '~').localeCompare(Bb.area || '~');
        return adminIdx[a.id] - adminIdx[b.id];
      });
    });

    // Block order: saved order first, then the rest by starting number
    const all = Object.values(meta);
    const ordered = all.filter((m) => m.order != null).sort((a, b) => a.order - b.order);
    all.filter((m) => m.order == null).sort((a, b) => a.start - b.start).forEach((m) => {
      const at = ordered.findIndex((o) => o.start > m.start);
      if (at < 0) ordered.push(m); else ordered.splice(at, 0, m);
    });

    // Numbers: fixed numbers first (first claim wins; a duplicate is marked), then count up from each start
    const used = new Set(), fixedOf = {}, conflict = new Set();
    ordered.forEach((m) => lists[m.id].forEach((ch) => {
      const f = info[ch.id].fixed;
      if (!(f > RESERVED_MAX && f < 100000)) return;
      if (used.has(f)) { conflict.add(ch.id); return; }
      used.add(f); fixedOf[ch.id] = f;
    }));
    const blocks = ordered.map((m) => {
      let n = m.start;
      const chans = lists[m.id].map((ch) => {
        let v = fixedOf[ch.id];
        if (v == null) { while (used.has(n) || n <= RESERVED_MAX) n++; used.add(n); v = n++; }
        const i = info[ch.id];
        return { ch, n: v, fixed: fixedOf[ch.id] != null, conflict: conflict.has(ch.id), call: i.call, area: i.area, by: i.by, own: i.own, group: groupOf[ch.id].id };
      }).sort((a, b) => a.n - b.n);
      const overflow = chans.some((c) => c.n > m.end || c.n < m.start);
      return { ...m, chans, overflow };
    });
    return { blocks, sources, hidden: hidden.map((ch) => ({ ch, n: null, fixed: false, conflict: false, call: info[ch.id].call, area: info[ch.id].area, by: 'you', own: true, group: groupOf[ch.id].id })) };
  }

  function rangeOf(chans) {
    if (!chans.length) return '';
    const lo = chans[0].n, hi = chans[chans.length - 1].n;
    return 'CH ' + lo + (hi > lo ? '–' + hi : '');
  }

  function build() {
    const data = loadData() || {};
    const { blocks } = layout(data);
    const out = blocks.filter((b) => b.chans.length).map((b) => ({
      id: b.id, label: b.label, range: rangeOf(b.chans), regional: /^reg-/.test(b.id),
      channels: b.chans.map((c) => channelRow(c.ch, c.n, c.call, c.area)),
    }));

    // Weather TV (2–10); Live Now is channel 1 (the block at the top)
    const wtv = [
      { n: 2, id: 'forecast', name: 'Your Forecast', call: 'FCST', kind: 'forecast', cells: ['Current Conditions', 'Hourly', '7-Day Forecast', 'Records & Normals'].map((t) => ({ t })) },
      { n: 3, id: 'radar', name: 'Live Radar', call: 'RADAR', kind: 'radar', cells: ['Live NEXRAD radar', 'Warnings & watches', 'Storm chasers on the map', 'Future radar'].map((t) => ({ t })) },
      { n: 4, id: 'weatherstar', name: 'WeatherStar', call: 'WSTAR', kind: 'wstar', cells: ['Current Conditions', 'Local Forecast', 'Extended Forecast', 'Regional Radar'].map((t) => ({ t })) },
      { n: 5, id: 'highlights', name: 'Weather TV Highlights', call: 'HILITE', kind: 'list', cells: (data.highlights || []).slice(0, 30).map((h) => ({ v: h.videoId, t: h.title || '' })) },
    ];
    (data.playlists || []).slice(0, 5).forEach((p, i) => {
      const pl = cache.playlist[p.playlistId];
      const cells = ((pl && pl.items) || []).slice(0, 50).map((it) => ({ v: it.snippet && it.snippet.resourceId && it.snippet.resourceId.videoId, t: (it.snippet && it.snippet.title) || '' })).filter((c) => c.v);
      wtv.push({ n: 6 + i, id: 'pl-' + p.playlistId, name: p.title, call: callSign(p.title), kind: 'list', playlistId: p.playlistId, cells, needsFetch: !cells.length });
    });

    const liveRows = [];
    out.forEach((b) => b.channels.forEach((c) => { if (c.live) liveRows.push({ ...c, block: b.label, home: b.id }); }));
    return {
      generatedAt: new Date().toISOString(),
      blocks: [
        { id: 'live', label: 'LIVE NOW · ' + liveRows.length + (liveRows.length === 1 ? ' CHANNEL' : ' CHANNELS'), range: 'CH 1 · UNDER THEIR HOME NUMBERS', n: 1, channels: liveRows },
        { id: 'wtv', label: 'WEATHER TV', range: 'CH 2–' + wtv[wtv.length - 1].n, channels: wtv },
        ...out,
      ],
    };
  }

  app.get('/api/guide', (req, res) => {
    try {
      if (!memo.body || Date.now() - memo.at > MEMO_MS) memo = { at: Date.now(), body: JSON.stringify(build()) };
      res.set('Cache-Control', 'no-cache');
      res.type('application/json').send(memo.body);
    } catch (e) {
      console.error('[Guide] build failed:', e.message);
      res.status(500).json({ error: 'guide_failed' });
    }
  });

  // ── Admin (behind adminAuth via app.use('/api/admin')) ──
  function sanitize(body, data) {
    const known = new Set();
    (data.groups || []).forEach((g) => (g.channels || []).forEach((ch) => known.add(ch.id)));
    const blocks = {}, map = {}, channels = {};
    Object.entries((body && body.blocks) || {}).forEach(([id, b]) => {
      if (!ID_RE.test(id) || !b) return;
      const start = num(b.start), end = num(b.end), order = num(b.order);
      blocks[id] = { label: cleanLabel(b.label) || undefined, start: start > RESERVED_MAX && start < 100000 ? start : undefined,
        end: end > RESERVED_MAX && end < 100000 ? end : undefined, order: order != null && order >= 0 && order < 10000 ? order : undefined };
    });
    Object.entries((body && body.map) || {}).forEach(([key, b]) => {
      if (!/^[gc]:[A-Za-z0-9:_-]{1,120}$/.test(key)) return;
      map[key] = b && ID_RE.test(b) ? b : '';                      // '' = this collection doesn't send its channels anywhere
    });
    Object.entries((body && body.channels) || {}).forEach(([id, c]) => {
      if (!known.has(id) || !c) return;
      const e = {};
      if (c.block === 'none' || (c.block && ID_RE.test(c.block))) e.block = c.block;
      const pos = num(c.pos); if (pos != null && pos >= 0 && pos < 100000) e.pos = pos;
      const n = num(c.n); if (n > RESERVED_MAX && n < 100000) e.n = n;
      const call = cleanTag(c.call); if (call) e.call = call;
      const area = cleanCode(c.area); if (area) e.area = area;
      if (Object.keys(e).length) channels[id] = e;
    });
    return { v: 2, blocks, map, channels };
  }
  function adminView(data, cfg) {
    const { blocks, sources, hidden } = layout(data, cfg);
    const row = (c, block) => ({ id: c.ch.id, name: c.ch.name, group: c.group, block, n: c.n, fixed: c.fixed, conflict: c.conflict, call: c.call, autoCall: callSign(c.ch.name), area: c.area, by: c.by, own: c.own, live: !!liveOf(c.ch.id) });
    return {
      reserved: RESERVED_MAX,
      groups: (data.groups || []).map((g) => ({ id: g.id, label: g.label })),
      blocks: blocks.map((b, i) => ({ id: b.id, label: b.label, start: b.start, end: b.end, order: i, custom: b.custom, count: b.chans.length, overflow: b.overflow })),
      sources: sources.map((s) => ({ key: s.key, label: s.label, kind: s.kind, count: s.count, block: s.block || '', def: s.def || '' })),
      channels: [...blocks.flatMap((b) => b.chans.map((c) => row(c, b.id))), ...hidden.map((c) => row(c, 'none'))],
      config: cfg || configOf(data),
    };
  }
  app.get('/api/admin/guide', (req, res) => {
    try { res.set('Cache-Control', 'no-store'); res.json(adminView(loadData() || {})); }
    catch (e) { console.error('[Guide] admin read failed:', e.message); res.status(500).json({ error: e.message }); }
  });
  app.post('/api/admin/guide/preview', (req, res) => {
    try { const data = loadData() || {}; res.json(adminView(data, sanitize(req.body, data))); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/admin/guide', (req, res) => {
    const data = loadData() || {};
    const cfg = sanitize(req.body, data);
    data.guide = { ...cfg, updatedAt: new Date().toISOString() };
    saveData(data);
    memo = { at: 0, body: null };
    res.json({ ok: true, saved: Object.keys(cfg.channels).length });
  });

  // Suggested country codes from each channel's YouTube "country" (channels.list, 50 per call = 1 unit)
  app.post('/api/admin/guide/countries', async (req, res) => {
    try {
      const key = getApiKey && getApiKey();
      if (!key || !ytFetch) return res.status(500).json({ error: 'No YouTube API key configured' });
      const data = loadData() || {};
      const ids = [...new Set((data.groups || []).flatMap((g) => (g.channels || []).map((c) => c.id)))].filter((id) => /^UC[\w-]{22}$/.test(id));
      const out = {};
      let calls = 0;
      for (let i = 0; i < ids.length; i += 50) {
        const r = await ytFetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&fields=items(id,snippet/country)&maxResults=50&key=' + key + '&id=' + ids.slice(i, i + 50).join(','));
        calls++;
        if (checkQuotaError && checkQuotaError(r)) return res.status(429).json({ error: 'quota_exceeded', countries: out });
        (r.items || []).forEach((it) => { const c = cleanCode(it.snippet && it.snippet.country); if (c) out[it.id] = c; });
      }
      if (trackBurn) trackBurn(true, calls);
      res.json({ ok: true, units: calls, countries: out });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
