// WeatherTV Live Verifier — build.1790391600
// Zero-quota secondary live check: loads youtube.com/channel/{id}/live directly
// and reads the page's own player data to confirm whether the channel is live NOW.
// Tracks every run + every stream the primary (WebSub/Atom) system missed, and
// serves an admin page with miss-rate baselines. Node 18+, no dependencies.

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cookie': 'CONSENT=YES+cb; SOCS=CAI',
};
const MAX_BYTES = 2 * 1024 * 1024;     // hard cap per page
const RUNS_KEY = 'wt:verifier:runs';
const STREAMS_KEY = 'wt:verifier:streams';
const MAX_RUNS = 200;                  // ~13h of history at 4-min sweeps
const STREAM_RETENTION_DAYS = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const WATCH_CANON = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/;

// ---------- Fetch (streams the page and stops reading as soon as we know) ----------
// Offline channels get the channel homepage: we stop after </head> (~10% of the page).
// Live channels: we stop once the player data is in, before the big ytInitialData blob.
function haveEnough(html, channelId) {
  if (html.indexOf('</head>') === -1) return false;
  if (!WATCH_CANON.test(html)) return true; // channel page → offline, done
  return (html.includes('"isLiveNow":') && html.includes(`"channelId":"${channelId}"`))
      || html.includes('var ytInitialData');
}

async function fetchLivePage(channelId, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://www.youtube.com/channel/${channelId}/live`, {
      headers: HEADERS, redirect: 'follow', signal: ctrl.signal,
    });
    if (!res.ok) { res.body?.cancel?.().catch(() => {}); return { code: res.status, bytes: 0 }; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let html = '', bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      html += dec.decode(value, { stream: true });
      if (haveEnough(html, channelId) || bytes > MAX_BYTES) { reader.cancel().catch(() => {}); break; }
    }
    return { code: 200, html, bytes };
  } finally {
    clearTimeout(t);
  }
}

// ---------- Parser (pure, testable) ----------
function parseLivePage(channelId, html) {
  if (html.includes('consent.youtube.com') || html.includes('google.com/sorry')) return { channelId, status: 'blocked' };
  const canon = html.match(WATCH_CANON);
  if (!canon) return { channelId, status: 'offline' };
  const videoId = canon[1];
  if (!html.includes(`"channelId":"${channelId}"`)) return { channelId, status: 'offline', videoId, note: 'foreign' };
  const isLiveNow = /"isLiveNow":true/.test(html);
  const isUpcoming = /"isUpcoming":true/.test(html);
  const title = html.match(/<meta name="title" content="([^"]*)"/);
  const start = html.match(/"startTimestamp":"([^"]+)"/);
  const base = { channelId, videoId, title: title ? decode(title[1]) : null, startedAt: start ? start[1] : null };
  if (isLiveNow && !isUpcoming) return { ...base, status: 'live' };
  if (isUpcoming) return { ...base, status: 'upcoming' };
  return { ...base, status: 'offline' };
}

async function checkChannelLive(channelId, timeoutMs = 10000) {
  try {
    const { code, html, bytes } = await fetchLivePage(channelId, timeoutMs);
    if (code === 429) return { channelId, status: 'throttled', bytes };
    if (code !== 200) return { channelId, status: 'error', code, bytes };
    return { ...parseLivePage(channelId, html), bytes };
  } catch (e) {
    return { channelId, status: 'error', error: e.name === 'AbortError' ? 'timeout' : e.message, bytes: 0 };
  }
}

// ---------- Store helpers (works whether rGet/rSet stringify for you or not) ----------
function parseStored(v, fallback) {
  for (let i = 0; i < 2 && typeof v === 'string'; i++) { try { v = JSON.parse(v); } catch { return fallback; } }
  return v ?? fallback;
}

// ---------- Verifier ----------
function createLiveVerifier({
  getChannels,          // async () => [channelId] or [{ id, name }]
  isKnownLive,          // async (channelId, videoId?) => bool — is WTV already showing THIS stream? REQUIRED for miss tracking.
  onLive,               // async ({ channelId, videoId, title, startedAt, wasKnown }) => {} — called every sweep a channel is live
  onOffline,            // async (channelId) => {} — only called for channels currently shown live
  store,                // { get: async key => value, set: async (key, object) => {} } e.g. rGet/rSet
  concurrency = 3,
  sweepIntervalMs = 4 * 60 * 1000,
  offlineConfirmations = 2,
  backoffMs = 15 * 60 * 1000,
  log = (...a) => console.log('[live-verifier]', ...a),
}) {
  const offlineStreak = new Map();
  let runs = [];
  let streams = {};     // videoId -> { channelId, name, title, firstSeen, lastSeen, caughtByPrimary }
  let names = {};
  let pausedUntil = 0, running = false, timer = null, lastStartedAt = null, loaded = false, started = false;

  async function load() {
    if (loaded || !store) { loaded = true; return; }
    try {
      runs = parseStored(await store.get(RUNS_KEY), []);
      streams = parseStored(await store.get(STREAMS_KEY), {});
    } catch (e) { log('load failed:', e.message); }
    loaded = true;
  }

  async function persist() {
    if (!store) return;
    const cutoff = Date.now() - STREAM_RETENTION_DAYS * 864e5;
    for (const [vid, s] of Object.entries(streams)) if (Date.parse(s.lastSeen) < cutoff) delete streams[vid];
    try {
      await store.set(RUNS_KEY, runs);
      await store.set(STREAMS_KEY, streams);
    } catch (e) { log('persist failed:', e.message); }
  }

  async function sweep(trigger = 'timer') {
    await load();
    if (running) return { skipped: 'already running' };
    if (Date.now() < pausedUntil) return { skipped: 'paused (throttled)' };
    running = true;
    lastStartedAt = new Date().toISOString();
    const t0 = Date.now();

    const raw = await getChannels();
    const list = raw.map((c) => (typeof c === 'string' ? { id: c, name: c } : { id: c.id || c.channelId, name: c.name || c.id || c.channelId }));
    list.forEach((c) => { names[c.id] = c.name; });
    list.sort(() => Math.random() - 0.5);
    if (!list.length) { running = false; return { skipped: 'no channels in window' }; } // quiet hours — don't log empty runs

    const run = {
      startedAt: lastStartedAt, trigger, checked: 0, live: 0, upcoming: 0, offline: 0, errors: 0,
      throttled: false, bytes: 0, missed: [], staleCleared: [], errorChannels: [],
    };
    let i = 0;

    async function worker() {
      while (i < list.length && Date.now() >= pausedUntil) {
        const { id, name } = list[i++];
        const r = await checkChannelLive(id);
        run.checked++; run.bytes += r.bytes || 0;
        try {
          if (r.status === 'live') {
            run.live++;
            offlineStreak.delete(id);
            const known = isKnownLive ? !!(await isKnownLive(id, r.videoId)) : true;
            const now = new Date().toISOString();
            if (!streams[r.videoId]) {
              // First time we've ever seen this stream: was the primary system already showing it?
              streams[r.videoId] = { channelId: id, name, title: r.title, firstSeen: now, lastSeen: now, caughtByPrimary: known };
              if (!known) run.missed.push({ channelId: id, name, videoId: r.videoId, title: r.title, startedAt: r.startedAt });
            } else {
              streams[r.videoId].lastSeen = now;
            }
            await onLive({ ...r, wasKnown: known });
          } else if (r.status === 'offline' || r.status === 'upcoming') {
            run[r.status]++;
            const n = (offlineStreak.get(id) || 0) + 1;
            offlineStreak.set(id, n);
            if (n === offlineConfirmations) {
              const known = isKnownLive ? !!(await isKnownLive(id)) : true;
              if (known) { run.staleCleared.push({ channelId: id, name }); await onOffline(id); }
            }
          } else if (r.status === 'throttled' || r.status === 'blocked') {
            run.throttled = true;
            pausedUntil = Date.now() + backoffMs;
            log(`${r.status} by YouTube — pausing ${backoffMs / 60000} min`);
          } else {
            run.errors++;
            run.errorChannels.push({ channelId: id, name, error: r.error || r.code });
          }
        } catch (e) {
          log(`callback error for ${id}:`, e.message);
        }
        await sleep(700 + Math.random() * 900);
      }
    }

    try {
      await Promise.all(Array.from({ length: concurrency }, worker));
    } finally {
      run.finishedAt = new Date().toISOString();
      run.durationSec = Math.round((Date.now() - t0) / 1000);
      run.errorChannels = run.errorChannels.slice(0, 20);
      runs.unshift(run);
      runs = runs.slice(0, MAX_RUNS);
      running = false;
      await persist();
      log(`sweep: ${run.checked} checked, ${run.live} live, ${run.missed.length} missed, ${run.staleCleared.length} stale, ` +
          `${(run.bytes / 1048576).toFixed(1)} MB, ${run.durationSec}s`);
    }
    return run;
  }

  function stats() {
    const windows = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 };
    const out = {};
    const all = Object.values(streams);
    for (const [label, ms] of Object.entries(windows)) {
      const cutoff = Date.now() - ms;
      const inWin = all.filter((s) => Date.parse(s.firstSeen) >= cutoff);
      const missed = inWin.filter((s) => !s.caughtByPrimary).length;
      out[label] = { streams: inWin.length, missed, missRate: inWin.length ? +(missed / inWin.length * 100).toFixed(1) : null };
    }
    const recent = runs.filter((r) => Date.parse(r.startedAt) >= Date.now() - 864e5);
    out.stale24h = recent.reduce((n, r) => n + r.staleCleared.length, 0);
    out.mb24h = +(recent.reduce((n, r) => n + r.bytes, 0) / 1048576).toFixed(1);
    return out;
  }

  function snapshot() {
    const lastRun = lastStartedAt || (runs[0] && runs[0].startedAt) || null; // survives restarts via Redis
    return {
      enabled: started,
      running,
      paused: Date.now() < pausedUntil ? new Date(pausedUntil).toISOString() : null,
      lastStartedAt: lastRun,
      nextRunAt: started && lastRun ? new Date(Date.parse(lastRun) + sweepIntervalMs).toISOString() : null,
      intervalMin: sweepIntervalMs / 60000,
      stats: stats(),
      recentMisses: Object.entries(streams).filter(([, s]) => !s.caughtByPrimary)
        .sort((a, b) => b[1].firstSeen.localeCompare(a[1].firstSeen)).slice(0, 50)
        .map(([videoId, s]) => ({ videoId, ...s })),
      runs: runs.slice(0, 50),
    };
  }

  // Mount AFTER your admin auth middleware and BEFORE any /admin wildcard routes.
  function mountAdmin(app, base = '/admin/live-verifier') {
    app.get(`${base}/data`, async (req, res) => { await load(); res.json(snapshot()); });
    app.post(`${base}/run`, (req, res) => { sweep('manual'); res.json({ started: true }); });
    app.get(`${base}/check/:channelId`, async (req, res) => res.json(await checkChannelLive(req.params.channelId)));
    // Check one channel AND update WTV's live status to match (free — no API quota)
    app.post(`${base}/check/:channelId/apply`, async (req, res) => {
      const id = req.params.channelId;
      const r = await checkChannelLive(id);
      let applied = null;
      try {
        if (r.status === 'live') {
          const known = isKnownLive ? !!(await isKnownLive(id, r.videoId)) : true;
          await onLive({ ...r, wasKnown: known });
          applied = known ? 'already-live' : 'marked-live';
        } else if (r.status === 'offline' || r.status === 'upcoming') {
          const known = isKnownLive ? !!(await isKnownLive(id)) : false;
          if (known) { await onOffline(id); applied = 'marked-offline'; } else applied = 'already-offline';
        }
      } catch (e) { return res.status(500).json({ ...r, error: e.message }); }
      res.json({ ...r, applied });
    });
    app.get(base, (req, res) => res.type('html').send(ADMIN_HTML.replace(/__BASE__/g, base)));
  }

  return {
    start() {
      if (typeof fetch !== 'function') { log('Node 18+ required (no global fetch) — verifier NOT started'); return; }
      started = true;
      sweep('startup'); timer = setInterval(() => sweep('timer'), sweepIntervalMs); },
    stop() { clearInterval(timer); },
    sweep, snapshot, mountAdmin, checkOne: checkChannelLive,
  };
}

const ADMIN_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live Verifier — WeatherTV Admin</title>
<style>
:root{--bg:#0f1318;--card:#18202a;--text:#e6edf3;--mute:#8b98a5;--bad:#ff6b6b;--ok:#4cd07d;--warn:#f5b942;--line:#263241}
body{margin:0;padding:16px;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 8px;color:var(--mute);text-transform:uppercase;letter-spacing:.05em}
.status{color:var(--mute);margin-bottom:14px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}.card .n{font-size:26px;font-weight:700}.card .l{color:var(--mute);font-size:12px}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;min-width:560px}th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{color:var(--mute);font-weight:600;font-size:12px}td.t{white-space:normal;min-width:200px}a{color:#6cb6ff}
.bad{color:var(--bad)}.ok{color:var(--ok)}.warn{color:var(--warn)}button{background:#2d6cdf;color:#fff;border:0;border-radius:6px;padding:8px 14px;font-weight:600;cursor:pointer}
</style></head><body>
<h1>Live Verifier</h1><div class="status" id="status">Loading…</div><button id="run">Run check now</button>
<h2>Primary detection miss rate</h2><div class="cards" id="cards"></div>
<h2>Streams WebSub/Atom missed</h2><div class="wrap"><table><thead><tr><th>Found</th><th>Channel</th><th>Stream</th></tr></thead><tbody id="misses"></tbody></table></div>
<h2>Recent runs</h2><div class="wrap"><table><thead><tr><th>Started</th><th>Took</th><th>Checked</th><th>Live</th><th>Missed</th><th>Stale cleared</th><th>Errors</th><th>MB</th></tr></thead><tbody id="runs"></tbody></table></div>
<script>
const B='__BASE__',t=s=>s?new Date(s).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'—';
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const rate=r=>r==null?'<span class="n">—</span>':'<span class="n '+(r>10?'bad':r>0?'warn':'ok')+'">'+r+'%</span>';
async function load(){
  const d=await (await fetch(B+'/data')).json();
  document.getElementById('status').textContent=(d.running?'Running now · ':'')+(d.paused?'PAUSED (YouTube throttled) until '+t(d.paused)+' · ':'')+
    'Last run '+t(d.lastStartedAt)+' · Next '+t(d.nextRunAt)+' · Every '+d.intervalMin+' min';
  const s=d.stats;
  document.getElementById('cards').innerHTML=['24h','7d','30d'].map(k=>'<div class="card">'+rate(s[k].missRate)+'<div class="l">'+k+' · '+s[k].missed+' of '+s[k].streams+' streams missed</div></div>').join('')+
    '<div class="card"><span class="n">'+s.stale24h+'</span><div class="l">stale lives cleared (24h)</div></div>'+
    '<div class="card"><span class="n">'+s.mb24h+'</span><div class="l">MB downloaded (24h)</div></div>';
  document.getElementById('misses').innerHTML=d.recentMisses.map(m=>'<tr><td>'+t(m.firstSeen)+'</td><td>'+esc(m.name)+'</td><td class="t"><a target="_blank" href="https://youtube.com/watch?v='+m.videoId+'">'+esc(m.title||m.videoId)+'</a></td></tr>').join('')||'<tr><td colspan="3">None yet</td></tr>';
  document.getElementById('runs').innerHTML=d.runs.map(r=>'<tr><td>'+t(r.startedAt)+(r.trigger!=='timer'?' ('+r.trigger+')':'')+'</td><td>'+r.durationSec+'s</td><td>'+r.checked+'</td><td>'+r.live+'</td><td class="'+(r.missed.length?'bad':'')+'">'+r.missed.length+'</td><td class="'+(r.staleCleared.length?'warn':'')+'">'+r.staleCleared.length+'</td><td'+(r.errors?' class="warn" title="'+esc(r.errorChannels.map(e=>e.name+': '+e.error).join('\\n'))+'"':'')+'>'+r.errors+(r.throttled?' ⚠ throttled':'')+'</td><td>'+(r.bytes/1048576).toFixed(1)+'</td></tr>').join('')||'<tr><td colspan="8">No runs yet</td></tr>';
}
document.getElementById('run').onclick=async()=>{await fetch(B+'/run',{method:'POST'});setTimeout(load,1500)};
load();setInterval(load,60000);
</script></body></html>`;

module.exports = { createLiveVerifier, checkChannelLive, parseLivePage };
