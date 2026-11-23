// WeatherTV Channel Guide (2.0 prototype) — updated 2026-11-23T01:00:00Z build.1795395600
// One call that returns the whole cable-style guide: blocks of numbered channels,
// each with its live stream (if any) and newest uploads. Built ONLY from data the
// server already caches (live statuses, the twice-daily recent-video fetch,
// playlists, highlights) — a guide request never spends YouTube quota.
//
//   GET /api/guide         { generatedAt, blocks:[{ id, label, range, channels:[…] }] }
//   GET /api/admin/guide   every block and channel with its block, number and tag (admin page)
//   PUT /api/admin/guide   save data.guide = { blocks:{ id:{label,start,order} }, channels:{ id:{block,pos,call} } }
//
// Where a channel goes:
//   1. Arranged in admin (data.guide.channels[id]): that block, at that position, with that tag.
//      block "none" = not in the guide. Blocks appear in their saved order.
//   2. Otherwise from the admin's groups and collections:
//      group-level collections (Regional Forecasts: Asia, Europe…) → regional blocks
//      channel-level "…Chasers" collections with 3+ members      → network blocks
//      National Weather Service family                            → Official block
//      other channel-level collections ("X Channels")             → kept beside their lead channel
//   Channels not arranged yet go after the arranged ones in their block.
// Numbers: each block counts up from its starting number in its channel order,
// skipping any number an earlier block already used.

const MAX_CELLS = 10;
const LIVE_MAX_AGE = 12 * 3600 * 1000;
const MEMO_MS = 30 * 1000;

// Regional blocks for group-level collections, matched by label
const REGIONS = [
  [/US States|United States|US Regional/i, 'US REGIONAL', 150],
  [/Radar/i, 'RADAR CHANNELS', 180],
  [/Canada/i, 'CANADA', 500],
  [/Europe|UK/i, 'UK & EUROPE', 600],
  [/Asia|India|Pakistan|Bangladesh/i, 'ASIA', 700],
  [/Oceania|Australia|New Zealand/i, 'AUSTRALIA & OCEANIA', 800],
  [/Latin|Espa|Mexico|Caribbean/i, 'LATIN AMERICA · ESPAÑOL', 900],
];
const GROUP_BLOCKS = { forecasters: ['FORECASTERS', 100], chasers: ['STORM CHASERS', 200], creators: ['WEATHER CREATORS', 400] };
const NETWORK_START = 300, NETWORK_STEP = 25, OFFICIAL_START = 470;
const RESERVED_MAX = 9;   // 1–9 are the Weather TV channels

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

module.exports = function guide(app, { loadData, saveData, cache, filterRecent }) {
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

  function channelRow(ch, n, call) {
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
    return { n, id: ch.id, name: ch.name, call, live, cells: cells.slice(0, MAX_CELLS) };
  }

  // Lay out every block and channel (no videos yet). Shared by the guide and the admin page.
  function layoutBlocks(data) {
    const groups = data.groups || [];
    const cfg = data.guide || {};
    const pin = cfg.channels || {};
    const bcfg = cfg.blocks || {};
    const isPinned = (ch) => !!(pin[ch.id] && pin[ch.id].block);

    const placed = new Set();          // unsaved channels already in a block
    const meta = {};                   // id → { id, label, start, auto }
    const lists = {};                  // id → [channels]
    const register = (id, label, start) => { if (!meta[id]) meta[id] = { id, label, start, auto: true }; lists[id] = lists[id] || []; };
    const autoIndex = new Map();                                   // order channels were placed in automatically
    const addBlock = (id, label, start, chans, min = 1) => {
      const seen = new Set();
      const list = chans.filter((ch) => ch && !isPinned(ch) && !placed.has(ch.id) && !seen.has(ch.id) && seen.add(ch.id));
      if (list.length < min) return false;
      register(id, label, start);
      list.forEach((ch) => { placed.add(ch.id); autoIndex.set(ch.id, autoIndex.size); lists[id].push(ch); });
      return true;
    };

    const members = {};
    const groupOf = {};
    groups.forEach((g) => (g.channels || []).forEach((ch) => {
      if (ch.enabled === false) return;
      if (!groupOf[ch.id]) groupOf[ch.id] = g;
      const keys = new Set([...(ch.collectionIds || []), ...(ch.collectionId ? [ch.collectionId] : [])]);
      keys.forEach((k) => { (members[k] = members[k] || []).push(ch); });
    }));

    // Regional blocks from group-level collections
    let extraStart = 1000;
    groups.forEach((g) => (g.collections || []).forEach((col) => {
      if (col.enabled === false) return;
      const hit = REGIONS.find(([re]) => re.test(col.label || ''));
      const label = hit ? hit[1] : String(col.label || 'More').replace(/^Regional Forecasts:\s*/i, '').toUpperCase();
      const id = 'col-' + col.id;
      const start = hit ? hit[2] : (extraStart += 100);
      register(id, label, start);                                  // listed even when empty, so admin can use it
      addBlock(id, label, start, members['group:' + g.id + '::' + col.id] || []);
    }));

    // Official (NWS family) and networks (…Chasers, 3+); other families stay beside their lead
    const families = [];
    const networks = [];
    groups.forEach((g) => (g.channels || []).forEach((lead) => (lead.collections || []).forEach((col) => {
      if (col.enabled === false) return;
      const list = members[lead.id + '::' + col.id] || [];
      if (/national weather service/i.test(lead.name)) { register('official', 'OFFICIAL · NWS & AGENCIES', OFFICIAL_START); addBlock('official', 'OFFICIAL · NWS & AGENCIES', OFFICIAL_START, [lead, ...list]); }
      else if (/chasers/i.test(col.label || '') && list.length >= 3) networks.push({ col, list });
      else families.push({ lead, list });
    })));
    networks.sort((a, b) => b.list.length - a.list.length).forEach((nw, i) => {
      const id = 'net-' + nw.col.id, label = String(nw.col.label).toUpperCase(), start = NETWORK_START + i * NETWORK_STEP;
      register(id, label, start);                                  // kept for channels saved into it
      addBlock(id, label, start, nw.list, 3);
    });

    // Group blocks, family channels right after their lead
    const familyOf = {};
    families.forEach((f) => { familyOf[f.lead.id] = (familyOf[f.lead.id] || []).concat(f.list); });
    groups.forEach((g) => {
      const [label, start] = GROUP_BLOCKS[g.id] || [String(g.label || g.id).toUpperCase(), (extraStart += 100)];
      const id = 'grp-' + g.id;
      register(id, label, start);
      const list = [];
      (g.channels || []).forEach((ch) => {
        if (ch.enabled === false || ch.hiddenInGroup) return;
        list.push(ch);
        (familyOf[ch.id] || []).forEach((m) => list.push(m));
      });
      addBlock(id, label, start, list);
      // Hidden-in-group channels that landed nowhere else
      addBlock(id, label, start, (g.channels || []).filter((ch) => ch.enabled !== false));
    });

    // Saved block names/starts, and blocks made in admin
    Object.entries(bcfg).forEach(([id, b]) => {
      if (!b) return;
      if (!meta[id]) { meta[id] = { id, label: cleanLabel(b.label) || id.toUpperCase(), start: +b.start || (extraStart += 100), auto: false }; lists[id] = []; }
      else {
        if (b.label) meta[id].label = cleanLabel(b.label);
        if (+b.start > RESERVED_MAX) meta[id].start = +b.start;
      }
      if (Number.isFinite(+b.order) && b.order !== null && b.order !== '') meta[id].order = +b.order;
    });

    // Saved channels into their blocks
    const hiddenList = [];
    const byId = {};
    groups.forEach((g) => (g.channels || []).forEach((ch) => { if (ch.enabled !== false && !byId[ch.id]) byId[ch.id] = ch; }));
    Object.keys(byId).forEach((id) => {
      if (!isPinned(byId[id])) return;
      const p = pin[id];
      if (p.block === 'none') { hiddenList.push(byId[id]); return; }
      if (!meta[p.block]) { meta[p.block] = { id: p.block, label: p.block.toUpperCase(), start: (extraStart += 100), auto: false }; lists[p.block] = []; }
      lists[p.block].push(byId[id]);
    });

    // Channel order in each block: arranged channels by their saved position
    // (older saves kept a number instead), then anything new in its automatic order
    const posOf = (ch) => { const p = pin[ch.id]; if (!isPinned(ch)) return null; const v = p.pos != null ? +p.pos : +p.n; return Number.isFinite(v) ? v : null; };
    Object.keys(lists).forEach((bid) => {
      lists[bid] = lists[bid].map((ch, i) => ({ ch, i, p: posOf(ch) })).sort((a, b) => {
        if (a.p != null && b.p != null) return a.p - b.p || a.i - b.i;
        if (a.p != null) return -1;
        if (b.p != null) return 1;
        return (autoIndex.get(a.ch.id) ?? a.i) - (autoIndex.get(b.ch.id) ?? b.i);
      }).map((x) => x.ch);
    });

    // Block order: saved order first; a block that has none (e.g. a new collection)
    // slots in before the first ordered block that starts higher than it
    const all = Object.values(meta);
    const ordered = all.filter((m) => m.order != null).sort((a, b) => a.order - b.order);
    all.filter((m) => m.order == null).sort((a, b) => a.start - b.start).forEach((m) => {
      const at = ordered.findIndex((o) => o.start > m.start);
      if (at < 0) ordered.push(m); else ordered.splice(at, 0, m);
    });

    // Numbers: each block counts up from its start, skipping numbers already taken
    const used = new Set();
    const blocks = ordered.map((m) => {
      let n = m.start;
      const chans = lists[m.id].map((ch) => {
        while (used.has(n) || n <= RESERVED_MAX) n++;
        used.add(n);
        return { ch, n: n++, call: cleanTag(pin[ch.id] && pin[ch.id].call) || callSign(ch.name), saved: isPinned(ch), group: (groupOf[ch.id] || {}).id };
      });
      return { ...m, chans };
    });
    return { blocks, hidden: hiddenList.map((ch) => ({ ch, saved: true, group: (groupOf[ch.id] || {}).id, call: cleanTag(pin[ch.id] && pin[ch.id].call) || callSign(ch.name) })) };
  }

  function rangeOf(start, chans) {
    if (!chans.length) return 'CH ' + start;
    const lo = Math.min(...chans.map((c) => c.n)), hi = Math.max(...chans.map((c) => c.n));
    return 'CH ' + lo + (hi > lo ? '–' + hi : '');
  }

  function build() {
    const data = loadData() || {};
    const { blocks } = layoutBlocks(data);
    const out = blocks.filter((b) => b.chans.length).map((b) => ({
      id: b.id, label: b.label, range: rangeOf(b.start, b.chans),
      channels: b.chans.map((c) => channelRow(c.ch, c.n, c.call)),
    }));

    // Weather TV block (1–9)
    const wtv = [
      { n: 1, id: 'forecast', name: 'Your Forecast', call: 'FCST', kind: 'forecast', cells: ['Current Conditions', 'Hourly', '7-Day Forecast', 'Records & Normals'].map((t) => ({ t })) },
      { n: 2, id: 'weatherstar', name: 'WeatherStar', call: 'WSTAR', kind: 'wstar', cells: ['Current Conditions', 'Local Forecast', 'Extended Forecast', 'Regional Radar'].map((t) => ({ t })) },
      { n: 3, id: 'highlights', name: 'Weather TV Highlights', call: 'HILITE', kind: 'list', cells: (data.highlights || []).slice(0, 30).map((h) => ({ v: h.videoId, t: h.title || '' })) },
    ];
    (data.playlists || []).slice(0, 6).forEach((p, i) => {
      const pl = cache.playlist[p.playlistId];
      const cells = ((pl && pl.items) || []).slice(0, 50).map((it) => ({ v: it.snippet && it.snippet.resourceId && it.snippet.resourceId.videoId, t: (it.snippet && it.snippet.title) || '' })).filter((c) => c.v);
      wtv.push({ n: 4 + i, id: 'pl-' + p.playlistId, name: p.title, call: callSign(p.title), kind: 'list', playlistId: p.playlistId, cells, needsFetch: !cells.length });
    });

    // Live Now (top): every live channel, under its home number
    const liveRows = [];
    out.forEach((b) => b.channels.forEach((c) => { if (c.live) liveRows.push({ ...c, block: b.label, home: b.id }); }));   // home: hiding that block hides it here too

    return {
      generatedAt: new Date().toISOString(),
      blocks: [
        { id: 'live', label: 'LIVE NOW · ' + liveRows.length + (liveRows.length === 1 ? ' CHANNEL' : ' CHANNELS'), range: 'UNDER THEIR HOME NUMBERS', channels: liveRows },
        { id: 'wtv', label: 'WEATHER TV', range: 'CH 1–' + (wtv.length), channels: wtv },
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
  app.get('/api/admin/guide', (req, res) => {
    try {
      const data = loadData() || {};
      const { blocks, hidden } = layoutBlocks(data);
      const row = (c, block, n) => ({ id: c.ch.id, name: c.ch.name, group: c.group || '', block, n, call: c.call, autoCall: callSign(c.ch.name), saved: c.saved, live: !!liveOf(c.ch.id) });
      res.set('Cache-Control', 'no-store');
      res.json({
        reserved: RESERVED_MAX,
        groups: (data.groups || []).map((g) => ({ id: g.id, label: g.label })),
        blocks: blocks.map((b, i) => ({ id: b.id, label: b.label, start: b.start, order: i, auto: b.auto, saved: !!((data.guide || {}).blocks || {})[b.id], count: b.chans.length })),
        channels: [...blocks.flatMap((b) => b.chans.map((c) => row(c, b.id, c.n))), ...hidden.map((c) => row(c, 'none', null))],
      });
    } catch (e) {
      console.error('[Guide] admin read failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/admin/guide', (req, res) => {
    const body = req.body || {};
    const data = loadData() || {};
    const known = new Set();
    (data.groups || []).forEach((g) => (g.channels || []).forEach((ch) => known.add(ch.id)));
    const blocks = {};
    Object.entries(body.blocks || {}).forEach(([id, b]) => {
      if (!/^[A-Za-z0-9:_-]{1,80}$/.test(id) || !b) return;
      const start = Math.round(+b.start), order = Math.round(+b.order);
      blocks[id] = { label: cleanLabel(b.label), start: start > RESERVED_MAX && start < 100000 ? start : undefined,
        order: Number.isFinite(order) && order >= 0 && order < 10000 ? order : undefined };
    });
    const channels = {};
    Object.entries(body.channels || {}).forEach(([id, c]) => {
      if (!known.has(id) || !c || !c.block) return;
      if (c.block !== 'none' && !/^[A-Za-z0-9:_-]{1,80}$/.test(c.block)) return;
      const pos = Math.round(+c.pos);
      channels[id] = { block: c.block, pos: Number.isFinite(pos) && pos >= 0 && pos < 100000 ? pos : undefined, call: cleanTag(c.call) || undefined };
    });
    data.guide = { blocks, channels, updatedAt: new Date().toISOString() };
    saveData(data);
    memo = { at: 0, body: null };
    res.json({ ok: true, saved: Object.keys(channels).length });
  });
};
