// WeatherTV Channel Guide (2.0 prototype) — updated 2026-11-26T03:30:00Z build.1795663800
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
// Saving with syncGroups: a channel you put in a group's block (Forecasters,
// Storm Chasers, Other Weather Creators…) also moves to that group on the original site.
//
// Channel 1 is Live Now. Weather TV's own channels are built in and sit in ordinary
// blocks that work like the rest (move, renumber, add YouTube channels to them):
//   WEATHER TV (2–10): 2 Forecast, 3 Live Radar, 4 WeatherStar, 5 Highlights, then playlists
//   AUDIO CHANNELS (9900–9999): 9999 WeatherStar Radio (public/weatherstar/music/default, nonstop)
//   Playlist channels added in admin (data.guide.extras), e.g. the holiday Yule logs in
//   SEASONAL CHANNELS (9000–9099): a YouTube playlist on repeat, shown only between its dates
//
// Which block a channel is in (first match wins):
//   1. you placed it there in admin
//   2. it's in a collection that's set to go to a block
//   3. its country / state code (IN → Regional Asia, US-WI → Regional United States…)
//   4. its group's block (Forecasters → Forecasters…)
// Inside a block: channels you've ordered, then the rest (regional blocks sort those
// by code). Numbers: fixed numbers first; everyone else counts up from the block's start.
//
// Each collection has a type (set in admin; the default comes from its name):
//   block    — sends its channels to a block (regional collections)
//   network  — "… Chasers": members get the network's badge; nothing moves
//   creator  — "… Channels": the creator's other channels sit right after the lead

const MAX_CELLS = 10;
const LIVE_MAX_AGE = 12 * 3600 * 1000;
const MEMO_MS = 30 * 1000;
const RESERVED_MAX = 1;    // channel 1 is Live Now; every other number is a normal channel number
// 2000–2099: each viewer's own favorites (YOUR FAVORITES, kept in their browser). No channel is ever numbered there.
const FAV_RANGE = [2000, 2099];

// Layout v3 (agreed 2026-11-25): blocks by region, then section. Parents (US NATIONAL,
// EUROPE…) exist only in the guide's ☰ BLOCKS menu; each child is one band in the guide
// ("US NATIONAL · FORECASTERS"). Ids of the old blocks are kept where the meaning carried over.
const LAYOUT_V = 3;
const REGIONS = [
  ['us-nat', 'US NATIONAL'], ['us-reg', 'US REGIONAL'], ['na', 'NORTH AMERICA'], ['europe', 'EUROPE'],
  ['oceania', 'OCEANIA'], ['asia', 'ASIA'], ['samerica', 'SOUTH AMERICA'], ['africa', 'AFRICA'],
];
const REGION_LABEL = Object.fromEntries(REGIONS);
const DEFAULT_BLOCKS = [            // [id, label, start, end, parent region]
  ['wtv', 'WEATHER TV', 2, 10],
  ['forecasters', 'FORECASTERS', 11, 199, 'us-nat'],
  ['chasers', 'STORM CHASERS', 200, 499, 'us-nat'],
  ['nws', 'NWS', 500, 549, 'us-nat'],
  ['reg-us', 'FORECASTERS', 550, 699, 'us-reg'],
  ['nws-off', 'NWS OFFICES', 700, 899, 'us-reg'],
  ['reg-na', 'FORECASTERS', 900, 949, 'na'], ['reg-na-ch', 'STORM CHASERS', 950, 999, 'na'],
  ['reg-europe', 'FORECASTERS', 1000, 1049, 'europe'], ['reg-europe-ch', 'STORM CHASERS', 1050, 1099, 'europe'],
  ['reg-oceania', 'FORECASTERS', 1100, 1149, 'oceania'], ['reg-oceania-ch', 'STORM CHASERS', 1150, 1199, 'oceania'],
  ['reg-asia', 'FORECASTERS', 1200, 1249, 'asia'], ['reg-asia-ch', 'STORM CHASERS', 1250, 1299, 'asia'],
  ['reg-samerica', 'FORECASTERS', 1300, 1349, 'samerica'], ['reg-samerica-ch', 'STORM CHASERS', 1350, 1399, 'samerica'],
  ['reg-africa', 'FORECASTERS', 1400, 1449, 'africa'], ['reg-africa-ch', 'STORM CHASERS', 1450, 1499, 'africa'],
  ['creators', 'OTHER WEATHER CREATORS', 1500, 1699],
  ['react', 'WEATHER REACT CHANNELS', 1700, 1799],
  ['radar', 'WEATHER RADAR CHANNELS', 1800, 1899],
  ['seasonal', 'SEASONAL CHANNELS', 9000, 9099],
  ['audio', 'AUDIO CHANNELS', 9900, 9999],
];
// Region + section → block. A US chaser marked US Regional still chases nationally.
const SECTION_BLOCK = {
  'us-nat': { fc: 'forecasters', ch: 'chasers', nws: 'nws' },
  'us-reg': { fc: 'reg-us', ch: 'chasers', nws: 'nws-off' },
  na: { fc: 'reg-na', ch: 'reg-na-ch' }, europe: { fc: 'reg-europe', ch: 'reg-europe-ch' },
  oceania: { fc: 'reg-oceania', ch: 'reg-oceania-ch' }, asia: { fc: 'reg-asia', ch: 'reg-asia-ch' },
  samerica: { fc: 'reg-samerica', ch: 'reg-samerica-ch' }, africa: { fc: 'reg-africa', ch: 'reg-africa-ch' },
};
// Which section a group's channels are (by the original site's groups)
function sectionOfGroup(g) {
  const id = String((g && g.id) || ''), label = String((g && g.label) || '');
  if (id === 'forecasters' || /forecast/i.test(label)) return 'fc';
  if (id === 'chasers' || /chaser/i.test(label)) return 'ch';
  if (id === 'nws' || /national weather service|^nws\b/i.test(label)) return 'nws';
  return null;
}
// The forecasters always at the top of US National · Forecasters (unless you number them yourself)
const DEFAULT_PINS = { UCvBVK2ymNzPLRJrgip2GeQQ: 11, 'UCJHAT3Uvv-g3I8H3GhHWV7w': 12, 'UCuYqi3hOfz6-3Hdp6tEJjAg': 13, UCpYQmszu4IP37xyt3RQb2gw: 14 };   // Max Velocity, Ryan Hall Y'all, AccuWeather, More Max Velocity
// Role icons next to the channel number (default from the section; per channel in admin)
const ROLE_ICON = {
  forecaster: '/images/role-forecaster.png', chaser: '/images/role-chaser.png', hurricane: '/images/role-hurricane.png',
  radar: '/images/role-radar.png', nws: '/images/role-forecaster.png', wtv: '/images/icon-192.png', aa: '/images/role-altruistic-apps.png',
};
const ROLE_CHOICES = ['forecaster', 'chaser', 'hurricane', 'radar', 'nws', 'none'];
// Block colors, like the old PPV and premium-channel bands (set per block in admin)
const THEMES = ['holiday', 'halloween', 'ppv', 'shamrock', 'frost', 'patriot', 'gold'];
const DEFAULT_THEME = { seasonal: 'holiday' };
// YouTube channels that start in a particular block (until moved in admin)
const DEFAULT_CHANNEL_BLOCK = { UCUEQ5cxsnSpYL1VoTqbhsDw: 'wtv' };   // Altruistic Apps → Weather TV
const WTV_GROUP = { id: 'wtv', label: 'Weather TV (built in)' };
const OWN_ROLE = { UCUEQ5cxsnSpYL1VoTqbhsDw: 'aa' };   // Altruistic Apps: its own "A"
// Groups that keep their own block (no region): Other Weather Creators, Weather React
const DEFAULT_GROUP_BLOCK = { creators: 'creators', react: 'react', reacts: 'react' };
const groupBlockByLabel = (label) => (/react/i.test(label || '') ? 'react' : /creator/i.test(label || '') ? 'creators' : null);
// Collections that go to a block unless changed in admin (matched by name)
// Group collections: a block (react, radar) or a region ("r:…") for their members
const DEFAULT_COLLECTION_BLOCK = [
  [/react/i, 'react'],
  [/radar/i, 'radar'],
  [/US States|United States|US Regional/i, 'r:us-reg'],
  [/Canada|Mexico|North America/i, 'r:na'],
  [/Europe|\bUK\b|United Kingdom|Britain/i, 'r:europe'],
  [/Oceania|Australia|New Zealand/i, 'r:oceania'],
  [/Asia|India|Pakistan|Bangladesh|Philippines|Japan/i, 'r:asia'],
  [/South America|Latin|Brazil|Argentina/i, 'r:samerica'],
  [/Africa/i, 'r:africa'],
];

// Country / state codes → regional block. A plain "US" places nothing (most US
// channels are national); a state code like US-WI goes to Regional United States.
const EUROPE = 'GB UK IE FR DE ES PT IT NL BE LU CH AT DK NO SE FI IS PL CZ SK HU RO BG GR HR SI RS BA ME MK AL XK UA BY MD LT LV EE MT CY TR RU GE AM AZ MC LI AD SM VA FO GI IM JE GG'.split(' ');
const ASIA = 'IN PK BD LK NP BT MV AF CN JP KR KP TW HK MO MN PH VN TH MY SG ID MM KH LA BN TL IR IQ SA AE QA KW BH OM YE JO LB SY IL PS KZ UZ TM KG TJ'.split(' ');
const OCEANIA = 'AU NZ PG FJ SB VU NC PF WS TO KI FM MH PW NR TV CK NU'.split(' ');
const SAMERICA = 'BR AR CL CO PE VE EC BO PY UY GY SR GF FK'.split(' ');
const AFRICA = 'ZA NG KE EG MA DZ TN LY ET GH TZ UG RW SN CI CM AO MZ ZW ZM BW NA MG MU SD SS SO DJ ER ML NE TD BF BJ TG LR SL GN GW GM MR CV CF CG CD GA GQ ST BI MW LS SZ KM SC RE YT SH'.split(' ');
// A country code → its region. US codes (plain or state) give no region: national vs regional is your call.
const NAMERICA = 'CA MX GL PM BM'.split(' ');
function regionOfCode(code) {
  const c = String(code || '').toUpperCase();
  if (!c || /^US/.test(c) || c === 'PR' || c === 'GU' || c === 'VI') return null;
  const cc = c.slice(0, 2);
  if (NAMERICA.includes(cc)) return 'na';
  if (EUROPE.includes(cc)) return 'europe';
  if (ASIA.includes(cc)) return 'asia';
  if (OCEANIA.includes(cc)) return 'oceania';
  if (SAMERICA.includes(cc)) return 'samerica';
  if (AFRICA.includes(cc)) return 'africa';
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
const TYPES = ['block', 'network', 'creator'];
// Default type from the collection's name. Only a channel's own collections can be a
// network or a creator's channels; group collections (regions, radar…) send to a block.
const defaultType = (label, lead) => (!lead ? 'block' : /chasers?\b/i.test(label || '') ? 'network' : /channels\b/i.test(label || '') ? 'creator' : 'block');
const fs = require('fs');
const path = require('path');
const IMG_DIR = path.join(__dirname, 'public', 'images');
// Badge logo: public/images/<name>.webp (WeatherWise → weatherwise or weather-wise)
function logoFor(name) {
  const base = String(name || '').replace(/[^A-Za-z0-9 ]/g, '').trim();
  const tries = [base.replace(/\s+/g, '').toLowerCase(), base.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/\s+/g, '-').toLowerCase()];
  for (const t of tries) for (const ext of ['webp', 'png', 'svg']) {
    try { if (t && fs.existsSync(path.join(IMG_DIR, t + '.' + ext))) return '/images/' + t + '.' + ext; } catch (e) {}
  }
  return null;
}
// WeatherStar Radio: every track in the WeatherStar music folder
const MUSIC_DIR = path.join(__dirname, 'public', 'weatherstar', 'music', 'default');
function trackTitle(file) {
  let t = file.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]\d{3,}$/, '');
  if (/^[a-z0-9_]+(-[a-z0-9_]+)+$/.test(t)) {               // stock-music slugs: "artist-name-song-name" → Song words
    t = t.split(/[-_]/).filter((w) => !/^(youtube|music|flow|amplify|djartmusic)$/.test(w)).join(' ');
  }
  return t.replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
}
// A song's own tags (title, artist, album) from its ID3 header, or the old ID3v1 tag at the end.
// Read once per file (and again only if the file changes); only the start of the file is read.
const tagMemo = {};
function id3Text(d, enc) {
  let s;
  if (enc === 1 || enc === 2) {
    let be = enc === 2;
    if (d[0] === 0xff && d[1] === 0xfe) { d = d.subarray(2); be = false; } else if (d[0] === 0xfe && d[1] === 0xff) { d = d.subarray(2); be = true; }
    const c = Buffer.from(d.subarray(0, d.length & ~1)); if (be) c.swap16();
    s = c.toString('utf16le');
  } else s = d.toString(enc === 3 ? 'utf8' : 'latin1');
  return s.split('\u0000')[0].replace(/\s+/g, ' ').trim().slice(0, 120);
}
function songTags(file) {
  let fd = null;
  try {
    const st = fs.statSync(file), m = tagMemo[file];
    if (m && m.at === st.mtimeMs) return m.tags;
    const tags = {};
    fd = fs.openSync(file, 'r');
    const h = Buffer.alloc(10); fs.readSync(fd, h, 0, 10, 0);
    if (h.toString('latin1', 0, 3) === 'ID3') {
      const v = h[3], size = ((h[6] & 0x7f) << 21) | ((h[7] & 0x7f) << 14) | ((h[8] & 0x7f) << 7) | (h[9] & 0x7f);
      const len = Math.min(size, 1024 * 1024), b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, 10);
      const KEYS = v === 2 ? { TT2: 't', TP1: 'a', TAL: 'al' } : { TIT2: 't', TPE1: 'a', TALB: 'al' };
      const idLen = v === 2 ? 3 : 4, hdr = v === 2 ? 6 : 10;
      let i = 0;
      if (v > 2 && (h[5] & 0x40)) i = v === 4 ? ((b[0] & 0x7f) << 21 | (b[1] & 0x7f) << 14 | (b[2] & 0x7f) << 7 | (b[3] & 0x7f)) : b.readUInt32BE(0) + 4;   // extended header
      while (i + hdr <= len) {
        const id = b.toString('latin1', i, i + idLen); if (!/^[A-Z0-9]+$/.test(id)) break;
        let sz = v === 2 ? (b[i + 3] << 16 | b[i + 4] << 8 | b[i + 5]) : b.readUInt32BE(i + 4);
        if (v === 4) sz = ((sz >>> 24) & 0x7f) << 21 | ((sz >>> 16) & 0x7f) << 14 | ((sz >>> 8) & 0x7f) << 7 | (sz & 0x7f);
        if (sz <= 0 || i + hdr + sz > len) break;
        if (KEYS[id]) { const t = id3Text(b.subarray(i + hdr + 1, i + hdr + sz), b[i + hdr]); if (t) tags[KEYS[id]] = t; }
        i += hdr + sz;
      }
    }
    if (!tags.t) {                                                  // ID3v1: the last 128 bytes
      const t1 = Buffer.alloc(128);
      if (st.size > 128 && fs.readSync(fd, t1, 0, 128, st.size - 128) === 128 && t1.toString('latin1', 0, 3) === 'TAG') {
        const f = (a, z) => t1.toString('latin1', a, z).split('\u0000')[0].trim();
        if (f(3, 33)) { tags.t = f(3, 33); if (f(33, 63)) tags.a = f(33, 63); if (f(63, 93)) tags.al = f(63, 93); }
      }
    }
    tagMemo[file] = { at: st.mtimeMs, tags };
    return tags;
  } catch (e) { return {}; } finally { if (fd != null) try { fs.closeSync(fd); } catch (e) {} }
}
// The songs in a music folder: title (its tag, else a tidied file name), artist, album
const MUSIC_ROOT = path.join(__dirname, 'public', 'weatherstar', 'music');
const FOLDER_RE = /^[A-Za-z0-9 _-]{1,40}$/;
function folderTracks(folder) {
  if (!FOLDER_RE.test(folder || '')) return [];
  try {
    return fs.readdirSync(path.join(MUSIC_ROOT, folder)).filter((f) => /\.(mp3|m4a|ogg)$/i.test(f)).sort().map((f) => {
      const g = /\.mp3$/i.test(f) ? songTags(path.join(MUSIC_ROOT, folder, f)) : {};
      const x = { t: g.t || trackTitle(f), src: '/weatherstar/music/' + encodeURIComponent(folder) + '/' + encodeURIComponent(f) };
      if (g.a) x.a = g.a; if (g.al) x.al = g.al;
      return x;
    });
  } catch (e) { return []; }
}
// The music folders you can give a channel as its soundtrack (subfolders of weatherstar/music)
function musicFolders() {
  try { return fs.readdirSync(MUSIC_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && FOLDER_RE.test(d.name)).map((d) => d.name).sort(); }
  catch (e) { return []; }
}
function radioTracks() { return folderTracks('default'); }
// Playlist channels (a YouTube playlist that plays on repeat), set in admin. Until you
// save your own list, these holiday Yule logs are used, Nov 1 – Dec 31. Each one can also
// be switched off (hidden) and back on in admin without losing it.
const DEFAULT_EXTRAS = [
  { playlistId: 'PLNJHctTJPWVI', title: 'WPIX Yule Log', block: 'seasonal', from: '11-01', to: '12-31' },
  { playlistId: 'PLOD1fWE3_FPI', title: 'Townsends Log Cabin Fire', block: 'seasonal', from: '11-01', to: '12-31' },
  { playlistId: 'PL9pARcP4EoEj3ALLqT3H9wYbri2HKZqEY', title: 'Bing at Christmas Yule Log', block: 'seasonal', from: '11-01', to: '12-31' },
  { playlistId: 'PLV3-REjEjIi4', title: 'Classic Christmas Songs', block: 'seasonal', from: '11-01', to: '12-31' },
  { playlistId: 'PLcsYfW8jCWiA', title: 'Yule Logs (Natural Sounds)', block: 'seasonal', from: '11-01', to: '12-31' },
  { playlistId: 'PLSODG9J4zv6Y', title: 'Christmas Around The World', block: 'seasonal', from: '11-01', to: '12-31' },
];
const PLAYLIST_RE = /^[A-Za-z0-9_-]{10,64}$/;
const MMDD_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
function todayMMDD() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// from–to can wrap the new year (11-20 → 01-06)
function inSeason(e) {
  if (e.on === false) return false;                                     // switched off in admin
  if (!e.from || !e.to) return true;
  const t = todayMMDD();
  return e.from <= e.to ? t >= e.from && t <= e.to : t >= e.from || t <= e.to;
}
const extrasOf = (cfg) => (cfg && Array.isArray(cfg.extras) ? cfg.extras : DEFAULT_EXTRAS);

// Weather TV's own channels, laid out like any other channel
function builtins(data, cfg, all) {
  const out = [
    { id: 'forecast', name: 'Your Forecast', call: 'FCST', kind: 'forecast', block: 'wtv', n: 2 },
    { id: 'radar', name: 'Live Radar', call: 'RADAR', kind: 'radar', block: 'wtv', n: 3 },
    { id: 'weatherstar', name: 'WeatherStar', call: 'WSTAR', kind: 'wstar', block: 'wtv', n: 4 },
    { id: 'highlights', name: 'Weather TV Highlights', call: 'HILITE', kind: 'list', block: 'wtv', n: 5 },
  ];
  ((data && data.playlists) || []).forEach((p) => { if (p && p.playlistId) out.push({ id: 'pl-' + p.playlistId, name: p.title || 'Playlist', call: callSign(p.title), kind: 'list', block: 'wtv', playlistId: p.playlistId }); });
  out.push({ id: 'wsradio', name: 'WeatherStar Radio', call: 'WXRADIO', kind: 'radio', block: 'audio', n: 9999 });
  extrasOf(cfg).forEach((e) => {
    if (!all && !inSeason(e)) return;                                   // out of season: not in the guide
    out.push({ id: 'x-' + e.playlistId, name: e.title, call: callSign(e.title), kind: 'list', block: e.block || 'seasonal', playlistId: e.playlistId, repeat: true, music: e.music || undefined });
  });
  return out.map((b) => ({ ...b, builtin: true }));
}
const netName = (label) => cleanLabel(String(label || '').replace(/\s*(chasers?|network)\s*$/i, '')) || cleanLabel(label);
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
  function channelRow(ch, n, call, area, nets, fam) {
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
    return { n, id: ch.id, name: ch.name, call, area: area || undefined, nets: nets && nets.length ? nets : undefined, fam: fam || undefined, live, cells: cells.slice(0, MAX_CELLS) };
  }

  const configOf = (data) => (data.guide && data.guide.v === 2 ? data.guide : {});

  // ── Lay out every block and channel (no videos). Shared by the guide and admin. ──
  function layout(data, cfgIn) {
    const cfg = cfgIn || configOf(data);
    const bcfg = cfg.blocks || {}, map = Object.assign({}, cfg.map || {}), ccfg = cfg.channels || {}, tcfg = cfg.types || {};
    const groups = data.groups || [];

    // Saved before layout v3: the old blocks' names, ranges and order (and the "nothing chosen"
    // entries the old admin saved for every collection) don't apply to the new layout
    const v3 = cfg.layoutV === LAYOUT_V;
    const defIds = new Set(DEFAULT_BLOCKS.map((d) => d[0]));

    // Blocks: defaults (renamable / resizable) + blocks made in admin
    const meta = {};
    DEFAULT_BLOCKS.forEach(([id, label, start, end, parent]) => { meta[id] = { id, label, start, end, parent: parent || null, custom: false }; });
    Object.entries(bcfg).forEach(([id, b]) => {
      if (!b || !ID_RE.test(id)) return;
      const isDef = defIds.has(id);
      if (!meta[id]) meta[id] = { id, label: cleanLabel(b.label) || id.toUpperCase(), start: 0, end: 0, parent: null, custom: true };
      const m = meta[id];
      if (b.theme === 'none' || THEMES.includes(b.theme)) m.theme = b.theme;
      if (isDef && !v3) return;                                   // old layout's name / range / order: ignored
      if (b.label) m.label = cleanLabel(b.label) || m.label;
      if (num(b.start) > RESERVED_MAX) m.start = num(b.start);
      if (num(b.end) != null && num(b.end) >= m.start) m.end = num(b.end);
      if (num(b.order) != null) m.order = num(b.order);
      if (m.custom && REGION_LABEL[b.parent]) m.parent = b.parent;
    });
    let extra = 1900;
    const bump = () => { const s = extra; extra += 100; return s; };
    Object.values(meta).forEach((m) => { if (!m.theme) m.theme = DEFAULT_THEME[m.id] || 'none'; if (!(m.start > RESERVED_MAX)) m.start = bump(); if (!(m.end >= m.start)) m.end = m.start + 99; });

    // Sources: groups and collections
    const sources = [];
    const members = {};
    const groupOf = {}, adminIdx = {};
    const channels = [];
    groups.forEach((g) => (g.channels || []).forEach((ch) => {
      if (ch.enabled === false) return;
      if (!groupOf[ch.id]) { groupOf[ch.id] = g; adminIdx[ch.id] = channels.length; channels.push(ch); }
      new Set([...(ch.collectionIds || []), ...(ch.collectionId ? [ch.collectionId] : [])]).forEach((k) => { (members[k] = members[k] || []).push(ch.id); });
    }));
    builtins(data, cfg).forEach((b) => { if (!groupOf[b.id]) { groupOf[b.id] = WTV_GROUP; adminIdx[b.id] = channels.length; channels.push(b); } });
    const has = (k) => Object.prototype.hasOwnProperty.call(map, k) && (v3 || map[k] !== '');
    const typeOf = (key, label, lead) => (TYPES.includes(tcfg[key]) && (lead || tcfg[key] === 'block') ? tcfg[key] : defaultType(label, lead));
    const networks = {}, netsOf = {}, families = [];
    // Before regions (layout v3), "send to Regional Europe" meant the whole region: show and keep it as one
    if (!v3) Object.keys(map).forEach((k) => { const g = /^reg-(us|na|europe|oceania|asia|samerica|africa)$/.exec(map[k] || ''); if (g) map[k] = 'r:' + (g[1] === 'us' ? 'us-reg' : g[1]); });
    const okTarget = (v) => !!v && (meta[v] || (v.startsWith('r:') && REGION_LABEL[v.slice(2)]));
    const target = (key, def) => (has(key) ? (okTarget(map[key]) ? map[key] : null) : def);
    groups.forEach((g) => {
      const sec = sectionOfGroup(g);
      let def = sec ? null : (DEFAULT_GROUP_BLOCK[g.id] || groupBlockByLabel(g.label) || null);
      if (!sec && !def) {                                         // a group with no block yet gets its own
        const id = 'grp-' + g.id;
        if (!meta[id]) meta[id] = { id, label: String(g.label || g.id).toUpperCase(), start: bump(), custom: false, end: 0, parent: null, theme: 'none' };
        if (!(meta[id].end >= meta[id].start)) meta[id].end = meta[id].start + 99;
        def = id;
      }
      // Forecasters, Storm Chasers and NWS are placed by region; other groups go to one block
      sources.push({ key: 'g:' + g.id, label: g.label || g.id, kind: 'group', type: 'block', defType: 'block', byRegion: !!sec, count: (g.channels || []).filter((c) => c.enabled !== false).length, def: def || '', block: sec ? '' : (target('g:' + g.id, def) || def) });
      (g.collections || []).forEach((col) => {
        if (col.enabled === false) return;
        const k = 'group:' + g.id + '::' + col.id;
        const hit = DEFAULT_COLLECTION_BLOCK.find(([re]) => re.test(col.label || ''));
        let d = hit ? hit[1] : null;
        sources.push({ key: 'c:' + k, label: (g.label || g.id) + ' › ' + (col.label || col.id), kind: 'collection', type: typeOf('c:' + k, col.label, null), defType: 'block', count: (members[k] || []).length, def: d, block: target('c:' + k, d) });
      });
      (g.channels || []).forEach((lead) => (lead.collections || []).forEach((col) => {
        if (col.enabled === false) return;
        const k = lead.id + '::' + col.id;
        const type = typeOf('c:' + k, col.label, lead);
        const ids = [...new Set([lead.id, ...(members[k] || [])])];
        sources.push({ key: 'c:' + k, label: (lead.name || '') + ' › ' + (col.label || col.id), kind: 'collection', type, defType: defaultType(col.label, lead), lead: lead.id, count: (members[k] || []).length, def: null, block: target('c:' + k, null) });
        if (type === 'network') {
          const name = netName(col.label);
          networks['c:' + k] = { name, label: cleanLabel(col.label), lead: lead.id, logo: logoFor(name) };
          ids.forEach((id) => { (netsOf[id] = netsOf[id] || []).push('c:' + k); });
        } else if (type === 'creator') {
          families.push({ key: 'c:' + k, lead: lead.id, ids: ids.filter((id) => id !== lead.id) });
        }
      }));
    });
    // Only "block" collections place channels; networks and creator collections don't
    const srcBlock = {}; sources.forEach((s) => { if (s.block && (s.type === 'block' || s.kind === 'group')) srcBlock[s.key] = s.block; });

    // Place every channel: you → built-in → collection block → region + section → group
    const lists = {}; Object.keys(meta).forEach((id) => { lists[id] = []; });
    const hidden = [];
    const info = {};
    channels.forEach((ch) => {
      const c = ccfg[ch.id] || {};
      const area = cleanCode(c.area);
      const g = groupOf[ch.id];
      const sec = ch.builtin ? null : sectionOfGroup(g);
      let block = null, by = null, region = null, regionBy = null;
      if (c.block === 'none') { block = 'none'; by = 'you'; }
      else if (c.block && meta[c.block]) { block = c.block; by = 'you'; }
      else if (ch.builtin) { block = meta[ch.block] ? ch.block : 'wtv'; by = 'builtin'; }
      else if (DEFAULT_CHANNEL_BLOCK[ch.id] && meta[DEFAULT_CHANNEL_BLOCK[ch.id]]) { block = DEFAULT_CHANNEL_BLOCK[ch.id]; by = 'builtin'; }
      // Its region: the Region picker → a collection → its country code (NWS: a state code = an office) → US National
      if (!ch.builtin) {
        const keys = [...new Set([...(ch.collectionIds || []), ...(ch.collectionId ? [ch.collectionId] : [])])];
        let colBlock = null;
        for (const key of keys) {
          const t = srcBlock['c:' + key]; if (!t) continue;
          if (t.startsWith('r:')) { if (!region) { region = t.slice(2); regionBy = 'collection'; } }
          else if (meta[t] && meta[t].parent) { if (!region) { region = meta[t].parent; regionBy = 'collection'; } }   // an old "send to Regional Asia": its region
          else if (!colBlock) colBlock = t;
        }
        if (REGION_LABEL[c.region]) { region = c.region; regionBy = 'you'; }
        if (!region) { const r = regionOfCode(area); if (r) { region = r; regionBy = 'code'; } }
        if (!region && sec === 'nws' && (/^US-[A-Z]{2}$/.test(area) || /^(PR|GU|VI|AS|MP)$/.test(area))) { region = 'us-reg'; regionBy = 'code'; }   // an NWS office (states and territories)
        if (!block && colBlock) { block = colBlock; by = 'collection'; }
        const explicit = regionBy === 'you' || regionBy === 'collection';
        const s2 = sec || (explicit ? 'fc' : null);                // a creator you put in a region counts as one of its forecasters
        if (!block && s2) {
          const rr = region || 'us-nat';
          const tbl = SECTION_BLOCK[rr] || SECTION_BLOCK['us-nat'];
          block = tbl[s2] || tbl.fc; by = regionBy || 'region';
          if (!region) { region = 'us-nat'; regionBy = 'default'; }
        }
      }
      if (!block) { block = srcBlock['g:' + g.id] || 'creators'; by = 'group'; }
      // Its role icon: yours → our own channels → radar → by section
      const roleSet = ROLE_CHOICES.includes(c.icon) ? c.icon : null;
      const role = roleSet || (ch.builtin ? 'wtv' : OWN_ROLE[ch.id] || (block === 'radar' ? 'radar' : /hurricane|cyclone|tropical/i.test(ch.name || '') ? 'hurricane' : sec === 'fc' ? 'forecaster' : sec === 'ch' ? 'chaser' : sec === 'nws' ? 'nws' : (block !== 'creators' && block !== 'react' && meta[block] && meta[block].parent ? 'forecaster' : 'none')));
      info[ch.id] = { block, area, by, own: by === 'you', region, regionBy, role, roleSet, call: cleanTag(c.call) || ch.call || callSign(ch.name), pos: num(c.pos), fixed: num(c.n) != null ? num(c.n) : (ch.builtin && ch.n && block === ch.block ? ch.n : null), nSet: num(c.n) != null };
    });
    // A creator's other channels go where the lead is (unless you placed them yourself)
    const leadOf = {};
    families.forEach((f) => {
      const L = info[f.lead];
      if (!L) return;
      f.ids.forEach((id) => {
        const I = info[id];
        if (!I || leadOf[id]) return;
        leadOf[id] = f.lead;
        if (I.by !== 'you' && L.block !== 'none') { I.block = L.block; I.by = 'creator'; if (!I.roleSet && I.role === 'none') I.role = L.role; }   // and the lead's icon
      });
    });
    // The four national forecasters at the top (11–14), unless you numbered them yourself
    Object.entries(DEFAULT_PINS).forEach(([id, n]) => { const I = info[id]; if (I && !I.nSet && I.block === 'forecasters') I.fixed = n; });
    const famOf = (id) => (leadOf[id] && info[leadOf[id]] ? leadOf[id] : families.some((f) => f.lead === id && f.ids.some((x) => info[x])) ? id : null);
    channels.forEach((ch) => { if (info[ch.id].block === 'none') hidden.push(ch); else lists[info[ch.id].block].push(ch); });

    // Order inside each block
    Object.keys(lists).forEach((bid) => {
      const regional = !!(meta[bid] && meta[bid].parent && meta[bid].parent !== 'us-nat');   // regional blocks and NWS offices: by country / state code
      const blank = '~';
      lists[bid].sort((a, b) => {
        const A = info[a.id], Bb = info[b.id];
        if (A.pos != null && Bb.pos != null) return A.pos - Bb.pos || adminIdx[a.id] - adminIdx[b.id];
        if (A.pos != null) return -1;
        if (Bb.pos != null) return 1;
        if (!!a.builtin !== !!b.builtin) return a.builtin ? -1 : 1;   // Weather TV's own channels first, then channels added to the block
        if (regional && A.area !== Bb.area) return (A.area || blank).localeCompare(Bb.area || blank);
        return adminIdx[a.id] - adminIdx[b.id];
      });
      // …then each creator's other channels (not ordered by you) right after the lead
      const list = lists[bid];
      const kids = list.filter((ch) => leadOf[ch.id] && info[ch.id].pos == null && list.some((x) => x.id === leadOf[ch.id]));
      if (kids.length) {
        const rest = list.filter((ch) => !kids.includes(ch));
        kids.slice().reverse().forEach((k) => { const at = rest.findIndex((x) => x.id === leadOf[k.id]); rest.splice(at + 1, 0, k); });
        lists[bid] = rest;
      }
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
    for (let f = FAV_RANGE[0]; f <= FAV_RANGE[1]; f++) used.add(f);   // viewers' favorites
    ordered.forEach((m) => lists[m.id].forEach((ch) => {
      const f = info[ch.id].fixed;
      if (!(f > RESERVED_MAX && f < 100000)) return;
      if (ch.builtin && num((ccfg[ch.id] || {}).n) == null && used.has(f)) return;   // a built-in's usual number is taken: it counts up instead
      if (used.has(f)) { conflict.add(ch.id); return; }
      used.add(f); fixedOf[ch.id] = f;
    }));
    const blocks = ordered.map((m) => {
      let n = m.start;
      const numOf = {};
      const chans = lists[m.id].map((ch) => {
        let v = fixedOf[ch.id];
        const L = leadOf[ch.id];
        if (v == null && L && numOf[L] != null && info[ch.id].by !== 'you') {      // a creator's other channel: the next free number after the lead
          v = numOf[L] + 1; while (used.has(v)) v++; used.add(v);
        }
        if (v == null) { while (used.has(n) || n <= RESERVED_MAX) n++; used.add(n); v = n++; }
        numOf[ch.id] = v;
        const i = info[ch.id];
        return { ch, n: v, fixed: fixedOf[ch.id] != null && i.nSet, conflict: conflict.has(ch.id), call: i.call, area: i.area, by: i.by, own: i.own, group: groupOf[ch.id].id, nets: netsOf[ch.id] || [], fam: famOf(ch.id), role: i.role, roleSet: i.roleSet, region: i.region, regionBy: i.regionBy };
      }).sort((a, b) => a.n - b.n);
      const overflow = chans.some((c) => c.n > m.end || c.n < m.start);
      return { ...m, chans, overflow };
    });
    return { blocks, sources, networks, hidden: hidden.map((ch) => { const i = info[ch.id]; return { ch, n: null, fixed: false, conflict: false, call: i.call, area: i.area, by: 'you', own: true, group: groupOf[ch.id].id, nets: netsOf[ch.id] || [], fam: famOf(ch.id), role: i.role, roleSet: i.roleSet, region: i.region, regionBy: i.regionBy }; }) };
  }

  function rangeOf(chans) {
    if (!chans.length) return '';
    const lo = chans[0].n, hi = chans[chans.length - 1].n;
    return 'CH ' + lo + (hi > lo ? '–' + hi : '');
  }

  // A built-in channel's row: what it opens or plays
  function builtinRow(c, data) {
    const ch = c.ch, base = { n: c.n, id: ch.id, name: ch.name, call: c.call, kind: ch.kind, repeat: ch.repeat || undefined, icon: ROLE_ICON[c.role] || undefined };
    if (ch.kind === 'forecast') return { ...base, cells: ['Current Conditions', 'Hourly', '7-Day Forecast', 'Records & Normals'].map((t) => ({ t })) };
    if (ch.kind === 'radar') return { ...base, cells: ['Live NEXRAD radar', 'Warnings & watches', 'Storm chasers on the map', 'Future radar'].map((t) => ({ t })) };
    if (ch.kind === 'wstar') return { ...base, cells: ['Current Conditions', 'Local Forecast', 'Extended Forecast', 'Regional Radar'].map((t) => ({ t })) };
    if (ch.kind === 'radio') return { ...base, cells: radioTracks() };
    if (ch.id === 'highlights') return { ...base, cells: (data.highlights || []).slice(0, 30).map((h) => ({ v: h.videoId, t: h.title || '' })) };
    const pl = cache.playlist[ch.playlistId];
    const cells = ((pl && pl.items) || []).map((it) => ({ v: it.snippet && it.snippet.resourceId && it.snippet.resourceId.videoId, t: (it.snippet && it.snippet.title) || '' })).filter((x) => x.v);
    return { ...base, playlistId: ch.playlistId, cells, needsFetch: !cells.length, soundtrack: ch.music && folderTracks(ch.music).length ? ch.music : undefined };
  }

  function build() {
    const data = loadData() || {};
    const { blocks, networks } = layout(data);
    // A child block's band reads "US NATIONAL · FORECASTERS"; its parent is only used by ☰ BLOCKS
    const out = blocks.filter((b) => b.chans.length).map((b) => ({
      id: b.id, label: b.parent ? REGION_LABEL[b.parent] + ' · ' + b.label : b.label, range: rangeOf(b.chans),
      parent: b.parent || undefined, parentLabel: b.parent ? REGION_LABEL[b.parent] : undefined,
      regional: !!(b.parent && b.parent !== 'us-nat'), theme: b.theme !== 'none' ? b.theme : undefined,
      channels: b.chans.map((c) => (c.ch.builtin ? builtinRow(c, data) : Object.assign(channelRow(c.ch, c.n, c.call, c.area, c.nets, c.fam), ROLE_ICON[c.role] ? { icon: ROLE_ICON[c.role] } : {}))),
    }));
    // Live Now: everyone live, except the 24/7 radar channels
    const liveRows = [];
    out.forEach((b) => { if (b.id === 'radar') return; b.channels.forEach((c) => { if (c.live) liveRows.push({ ...c, block: b.label, home: b.id }); }); });
    // Soundtracks: the songs of each music folder a channel plays instead of its videos' sound
    const music = {};
    out.forEach((b) => b.channels.forEach((c) => { if (c.soundtrack && !music[c.soundtrack]) music[c.soundtrack] = folderTracks(c.soundtrack); }));
    return {
      generatedAt: new Date().toISOString(),
      networks, music,
      blocks: [
        { id: 'live', label: 'LIVE NOW · ' + liveRows.length + (liveRows.length === 1 ? ' CHANNEL' : ' CHANNELS'), range: 'CH 1 · UNDER THEIR HOME NUMBERS', n: 1, channels: liveRows },
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
    const extras = [];
    if (body && Array.isArray(body.extras)) body.extras.slice(0, 50).forEach((e) => {
      if (!e || !PLAYLIST_RE.test(e.playlistId || '') || extras.some((x) => x.playlistId === e.playlistId)) return;
      const x = { playlistId: e.playlistId, title: cleanLabel(e.title) || 'Playlist', block: ID_RE.test(e.block || '') ? e.block : 'seasonal' };
      if (MMDD_RE.test(e.from || '') && MMDD_RE.test(e.to || '')) { x.from = e.from; x.to = e.to; }
      if (e.on === false) x.on = false;
      if (FOLDER_RE.test(e.music || '')) x.music = e.music;     // play this music folder instead of the videos' sound
      extras.push(x);
    });
    builtins(data, body && Array.isArray(body.extras) ? { extras } : configOf(data), true).forEach((b) => known.add(b.id));
    const blocks = {}, map = {}, channels = {}, types = {};
    Object.entries((body && body.blocks) || {}).forEach(([id, b]) => {
      if (!ID_RE.test(id) || !b) return;
      const start = num(b.start), end = num(b.end), order = num(b.order);
      blocks[id] = { label: cleanLabel(b.label) || undefined, start: start > RESERVED_MAX && start < 100000 ? start : undefined,
        end: end > RESERVED_MAX && end < 100000 ? end : undefined, order: order != null && order >= 0 && order < 10000 ? order : undefined,
        theme: b.theme === 'none' || THEMES.includes(b.theme) ? b.theme : undefined,
        parent: REGION_LABEL[b.parent] ? b.parent : undefined };
    });
    Object.entries((body && body.map) || {}).forEach(([key, b]) => {
      if (!/^[gc]:[A-Za-z0-9:_-]{1,120}$/.test(key)) return;
      map[key] = b && ID_RE.test(b) ? b : '';                      // a block, "r:<region>", or '' = this collection doesn't send its channels anywhere
    });
    Object.entries((body && body.types) || {}).forEach(([key, t]) => {
      if (/^c:[A-Za-z0-9:_-]{1,120}$/.test(key) && TYPES.includes(t)) types[key] = t;
    });
    Object.entries((body && body.channels) || {}).forEach(([id, c]) => {
      if (!known.has(id) || !c) return;
      const e = {};
      if (c.block === 'none' || (c.block && ID_RE.test(c.block))) e.block = c.block;
      const pos = num(c.pos); if (pos != null && pos >= 0 && pos < 100000) e.pos = pos;
      const n = num(c.n); if (n > RESERVED_MAX && n < 100000) e.n = n;
      const call = cleanTag(c.call); if (call) e.call = call;
      const area = cleanCode(c.area); if (area) e.area = area;
      if (REGION_LABEL[c.region]) e.region = c.region;
      if (ROLE_CHOICES.includes(c.icon)) e.icon = c.icon;
      if (Object.keys(e).length) channels[id] = e;
    });
    const out = { v: 2, layoutV: LAYOUT_V, blocks, map, channels, types };
    if (body && Array.isArray(body.extras)) out.extras = extras;
    else if (Array.isArray(configOf(data).extras)) out.extras = configOf(data).extras;
    return out;
  }
  function adminView(data, cfg) {
    const { blocks, sources, hidden, networks } = layout(data, cfg);
    const row = (c, block) => ({ id: c.ch.id, builtin: !!c.ch.builtin, guideOnly: !!c.ch.guideOnly, name: c.ch.name, group: c.group, block, n: c.n, fixed: c.fixed, conflict: c.conflict, call: c.call, autoCall: c.ch.call || callSign(c.ch.name), area: c.area, by: c.by, own: c.own, region: c.region || null, regionBy: c.regionBy || null, role: c.role || 'none', roleSet: c.roleSet || null, live: !!liveOf(c.ch.id), nets: (c.nets || []).map((k) => networks[k] && networks[k].name).filter(Boolean), fam: c.fam || null });
    return {
      reserved: RESERVED_MAX,
      groups: [WTV_GROUP, ...(data.groups || []).map((g) => ({ id: g.id, label: g.label }))],
      regions: REGIONS.map(([id, label]) => ({ id, label })),
      roles: ROLE_CHOICES,
      blocks: blocks.map((b, i) => ({ id: b.id, label: b.label, parent: b.parent || null, fullLabel: b.parent ? REGION_LABEL[b.parent] + ' · ' + b.label : b.label, start: b.start, end: b.end, order: i, custom: b.custom, count: b.chans.length, overflow: b.overflow, theme: b.theme })),
      sources: sources.map((s) => ({ key: s.key, label: s.label, kind: s.kind, type: s.type, defType: s.defType, byRegion: !!s.byRegion, lead: s.lead || null, count: s.count, block: s.block || '', def: s.def || '' })),
      channels: [...blocks.flatMap((b) => b.chans.map((c) => row(c, b.id))), ...hidden.map((c) => row(c, 'none'))],
      config: cfg || configOf(data),
      extras: extrasOf(cfg || configOf(data)).map((e) => ({ ...e, inSeason: inSeason(e) })),
      today: todayMMDD(),
      musicFolders: musicFolders().map((f) => ({ id: f, songs: folderTracks(f).length })),
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
    const moved = [];
    if (req.body && req.body.syncGroups) {
      // Which group each block belongs to (Forecasters → forecasters…), as set under Groups & collections
      const groupOfBlock = {};
      layout(data, cfg).sources.forEach((src) => { if (src.kind === 'group' && src.block && !groupOfBlock[src.block]) groupOfBlock[src.block] = src.key.slice(2); });
      Object.entries(cfg.channels).forEach(([id, c]) => {
        const gid = c.block && groupOfBlock[c.block];
        if (!gid) return;
        const from = (data.groups || []).find((g) => (g.channels || []).some((x) => x.id === id));
        const to = (data.groups || []).find((g) => g.id === gid);
        if (!from || !to || from === to || (to.channels || []).some((x) => x.id === id)) return;
        const [chObj] = from.channels.splice(from.channels.findIndex((x) => x.id === id), 1);
        (to.channels = to.channels || []).push(chObj);
        moved.push({ id, name: chObj.name, from: from.label, to: to.label });
      });
      if (moved.length) data.groupsRev = (data.groupsRev || 0) + 1;   // an admin page open from before must reload
    }
    saveData(data);
    memo = { at: 0, body: null };
    res.json({ ok: true, saved: Object.keys(cfg.channels).length, moved });
  });

  // ── Backfill: any channel with no saved video list gets one, in the background ──
  // The scheduled fetch checks quiet channels only every few days, and new or long-
  // quiet channels can have no list saved at all, which left empty guide rows. On the
  // server's own schedule (never because someone opened the guide), up to 25 such
  // channels every 30 minutes go through /api/yt/recent (1 unit each), which saves
  // the list the same way as everywhere else. A channel that comes back empty is
  // not tried again for a day.
  const PORT = process.env.PORT || 3000;
  const PL_REFRESH = 60 * 60 * 1000;                                // guide playlists: re-read every hour
  const tried = new Map();
  // The guide's playlists (6–10 and the playlist channels in season) are re-read every hour,
  // so videos you add to a playlist show up within the hour (1 unit per 50 videos). Admin's
  // "Refresh playlists now" does it straight away.
  function guidePlaylists(data) {
    return [...new Set([...(data.playlists || []).map((p) => p.playlistId), ...extrasOf(configOf(data)).filter(inSeason).map((e) => e.playlistId)].filter(Boolean))];
  }
  async function refreshPlaylists(data, now) {
    let n = 0;
    for (const pid of guidePlaylists(data)) {
      const c = cache.playlist[pid];
      if (!now && c && Date.now() - (c.cachedAt || 0) < PL_REFRESH) continue;
      if (!now && Date.now() - (tried.get('pl:' + pid) || 0) < PL_REFRESH) continue;
      tried.set('pl:' + pid, Date.now());
      try { await fetch('http://127.0.0.1:' + PORT + '/api/yt/playlist/' + encodeURIComponent(pid) + '?fresh=1'); n++; } catch (err) {}
      await new Promise((r) => setTimeout(r, now ? 300 : 1500));
    }
    if (n) memo = { at: 0, body: null };
    return n;
  }
  app.post('/api/admin/guide/refresh-playlists', async (req, res) => {
    try {
      const data = loadData() || {};
      const n = await refreshPlaylists(data, true);
      const counts = {};
      guidePlaylists(data).forEach((pid) => { counts[pid] = ((cache.playlist[pid] || {}).items || []).length; });
      res.json({ ok: true, refreshed: n, counts });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  async function backfill() {
    try {
      const data = loadData() || {};
      const ids = [...new Set((data.groups || []).flatMap((g) => (g.channels || []).filter((c) => c.enabled !== false).map((c) => c.id)))];
      const missing = ids.filter((id) => {
        const e = cache.recentVideos[id];
        return !(e && Array.isArray(e.items)) && Date.now() - (tried.get(id) || 0) > 24 * 3600 * 1000;
      }).slice(0, 25);
      for (const id of missing) {
        tried.set(id, Date.now());
        try { await fetch('http://127.0.0.1:' + PORT + '/api/yt/recent/' + encodeURIComponent(id)); } catch (e) {}
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (missing.length) { memo = { at: 0, body: null }; console.log('[Guide] Filled in video lists for ' + missing.length + ' channels'); }
      await refreshPlaylists(data, false);
    } catch (e) { console.warn('[Guide] Backfill failed:', e.message); }
  }
  const t1 = setTimeout(backfill, 60 * 1000); if (t1.unref) t1.unref();
  const t2 = setInterval(backfill, 15 * 60 * 1000); if (t2.unref) t2.unref();

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
