// ═══════════════════════════════════════════════════════════════════
// monitor.js — WeatherTV Health Monitor
// ═══════════════════════════════════════════════════════════════════
// Runs health checks on every WeatherTV subsystem on a schedule.
// Sends alerts via email (Resend) and/or SMS (Textbelt) when anything
// breaks. Results are cached in Redis and served via /api/monitor/status.
//
// Checks run every 5 minutes. Alert cooldown: 30 minutes per check
// type so you don't get spammed during an extended outage.
//
// Railway env vars — set whichever you want, both are optional:
//   MONITOR_EMAIL_TO   — address to send alert emails to
//   MONITOR_EMAIL_FROM — sending address (must be verified in Resend)
//   RESEND_API_KEY     — from resend.com (3,000 emails/month free)
//   MONITOR_SMS_TO     — phone number for SMS alerts e.g. +19206669979
//   TEXTBELT_API_KEY   — from textbelt.com ($10 for ~1,000 texts)
//                        use 'textbelt' (no quotes) for the free 1/day key
//
// Called from server.js:
//   const monitor = require('./monitor');
//   monitor.init({ redis, getAllChannels, websubLeases, cache,
//                  getQuota, eventLog });
// ═══════════════════════════════════════════════════════════════════

'use strict';

const https = require('https');
const http  = require('http');

// ── Constants ────────────────────────────────────────────────────────────────
const CHECK_INTERVAL_MS   = 5  * 60 * 1000; // run checks every 5 min
const ALERT_COOLDOWN_MS   = 30 * 60 * 1000; // only re-alert same issue after 30 min
const APP_URL             = process.env.APP_URL || 'https://www.watchweathertv.com';

// Thresholds
const WEBSUB_FAIL_THRESHOLD  = 0.10; // alert if >10% of channels failed/unknown
const MEMORY_WARN_MB         = 400;  // alert if RSS exceeds this
const RECENT_FETCH_STALE_MS  = 18 * 60 * 60 * 1000; // fetches run at noon+6pm EST; 18hr covers overnight gap
const LIVE_CHECK_STALE_MS    = 30 * 60 * 1000;      // alert if live check hasn't run in 30min

// ── Module State ─────────────────────────────────────────────────────────────
let _redis         = null;
let _getAllChannels = null;
let _websubLeases  = null;
let _cache         = null;
let _getQuota      = null;
let _eventLog      = null;
let _lastRun       = null;
let _lastResults   = null;
let _alertCooldowns = {}; // { checkId: lastAlertTimestamp }
let _checkTimer    = null;
let _startTime     = Date.now();

// ── Init ─────────────────────────────────────────────────────────────────────
function init({ redis, getAllChannels, websubLeases, cache, getQuota, eventLog }) {
  _redis         = redis;
  _getAllChannels = getAllChannels;
  _websubLeases  = websubLeases;
  _cache         = cache;
  _getQuota      = getQuota;
  _eventLog      = eventLog;

  const email = process.env.MONITOR_EMAIL_TO;
  const sms   = process.env.MONITOR_SMS_TO;
  const chan   = [email && 'email', sms && 'SMS'].filter(Boolean).join(' + ') || 'none configured';
  console.log(`[Monitor] Alert channels: ${chan}`);

  // Restore cooldowns from Redis so a deploy doesn't trigger a re-alert flood
  if (redis) {
    (async () => {
      try {
        const keys = await redis.keys('monitor:cooldown:*');
        for (const key of keys) {
          const val = await redis.get(key);
          if (val) _alertCooldowns[key.replace('monitor:cooldown:', '')] = parseInt(val, 10);
        }
        if (keys.length) console.log(`[Monitor] Restored ${keys.length} alert cooldown(s) from Redis`);
        // If no cooldowns exist yet, write a fresh set for all known check IDs
        // to suppress the post-deploy flood for one full cooldown window
        else {
          const checkIds = ['server','redis','websub','live-detection','recent-fetch',
            'yt-quota','nws-/-forecast-api','open-meteo','nexrad-tiles-(iem)',
            'goes-satellite-(gibs)','memory','lightning-(iem)','channels','error-log'];
          const now = Date.now();
          const ttl  = Math.ceil(ALERT_COOLDOWN_MS / 1000);
          for (const id of checkIds) {
            await redis.setex('monitor:cooldown:' + id, ttl, String(now));
            _alertCooldowns[id] = now;
          }
          console.log('[Monitor] Wrote initial cooldowns to Redis — suppressing post-deploy flood for 30min');
        }
      } catch(e) { console.warn('[Monitor] Could not restore cooldowns:', e.message); }
    })();
  }

  // Run first check 30s after boot, then every 5 min.
  // All wrapped in try/catch — monitor must never crash the main server.
  setTimeout(async () => {
    try { await runAllChecks(); } catch(e) { console.error('[Monitor] Check error:', e.message); }
    _checkTimer = setInterval(async () => {
      try { await runAllChecks(); } catch(e) { console.error('[Monitor] Check error:', e.message); }
    }, CHECK_INTERVAL_MS);
  }, 3 * 60 * 1000);

  console.log('[Monitor] Health monitor initialized — first check in 3 minutes');
}

// ── Email via Resend ──────────────────────────────────────────────────────────
async function _sendEmail(subject, text) {
  const apiKey = process.env.RESEND_API_KEY;
  const to     = process.env.MONITOR_EMAIL_TO;
  const from   = process.env.MONITOR_EMAIL_FROM || 'monitor@watchweathertv.com';
  if (!apiKey || !to) return false;

  const body = JSON.stringify({
    from, to,
    subject,
    text,
    html: `<pre style="font-family:monospace;font-size:14px">${text.replace(/</g,'&lt;')}</pre>`,
  });

  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers:  { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        if (!ok) console.error(`[Monitor] Resend failed ${res.statusCode}:`, data);
        else console.log('[Monitor] Resend email sent OK');
        resolve(ok);
      });
    });
    req.on('error', e => { console.error('[Monitor] Resend error:', e.message); resolve(false); });
    req.setTimeout(8000, () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ── SMS via Textbelt ──────────────────────────────────────────────────────────
async function _sendSMS(text) {
  const apiKey = process.env.TEXTBELT_API_KEY;
  const phone  = process.env.MONITOR_SMS_TO;
  if (!apiKey || !phone) return false;

  // Textbelt has a 160-char SMS limit — trim if needed
  const msg = text.length > 155 ? text.slice(0, 152) + '...' : text;
  const body = new URLSearchParams({ phone, message: msg, key: apiKey }).toString();

  return new Promise(resolve => {
    const req = https.request({
      hostname: 'textbelt.com',
      path:     '/text',
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (!j.success) console.warn('[Monitor] Textbelt failed:', j.error || data);
          resolve(!!j.success);
        } catch { resolve(false); }
      });
    });
    req.on('error', e => { console.error('[Monitor] Textbelt error:', e.message); resolve(false); });
    req.setTimeout(8000, () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ── Alert dispatcher ─────────────────────────────────────────────────────────
async function _sendAlert(checkId, title, body) {
  // Cooldown — check Redis directly as the source of truth so deploys never
  // cause a re-alert flood. In-memory copy is a fast-path fallback only.
  const now = Date.now();
  if (_alertCooldowns[checkId] && now - _alertCooldowns[checkId] < ALERT_COOLDOWN_MS) return;
  if (_redis) {
    try {
      const stored = await _redis.get('monitor:cooldown:' + checkId);
      if (stored && now - parseInt(stored, 10) < ALERT_COOLDOWN_MS) {
        _alertCooldowns[checkId] = parseInt(stored, 10); // sync in-memory
        return;
      }
      // Set cooldown in Redis BEFORE sending so concurrent runs can't both fire
      await _redis.setex('monitor:cooldown:' + checkId, Math.ceil(ALERT_COOLDOWN_MS / 1000), String(now));
    } catch(_) {}
  }
  _alertCooldowns[checkId] = now;

  console.warn(`[Monitor] ALERT: ${title} — ${body}`);

  const subject = `⚠️ WeatherTV: ${title}`;
  const text    = `WeatherTV Monitor Alert

Check: ${title}
Detail: ${body}
Time: ${new Date().toLocaleString()}
Dashboard: ${APP_URL}/monitor`;

  // Fire both channels concurrently — failure of one doesn't block the other
  await Promise.allSettled([
    _sendEmail(subject, text),
    _sendSMS(`WeatherTV ALERT: ${title} — ${body}`),
  ]);
}

// ── HTTP health fetch ─────────────────────────────────────────────────────────
function _httpGet(url, timeoutMs = 8000) {
  // Use Promise.race against a hard deadline — req.setTimeout only catches
  // inactivity, not total wall-clock time. Supports http and https, and
  // follows one redirect (handles 301/302 from IEM and others).
  const deadline = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
  );
  const request = new Promise((resolve, reject) => {
    const start = Date.now();
    const lib   = url.startsWith('https') ? https : http;
    try {
      const req = lib.get(url, { headers: { 'User-Agent': 'WeatherTV-Monitor/1.0' } }, res => {
        // Follow one redirect
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          res.resume();
          const redirectLib = res.headers.location.startsWith('https') ? https : http;
          redirectLib.get(res.headers.location, { headers: { 'User-Agent': 'WeatherTV-Monitor/1.0' } }, res2 => {
            let body = '';
            res2.on('data', d => { body += d; if (body.length > 50000) res2.destroy(); });
            res2.on('end', () => resolve({ status: res2.statusCode, body, ms: Date.now() - start }));
            res2.on('error', reject);
          }).on('error', reject);
          return;
        }
        let body = '';
        res.on('data', d => { body += d; if (body.length > 50000) req.destroy(); });
        res.on('end', () => resolve({ status: res.statusCode, body, ms: Date.now() - start }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('socket timeout')); });
    } catch(e) { reject(e); }
  });
  return Promise.race([request, deadline]);
}

// ── Individual Checks ─────────────────────────────────────────────────────────

// 1. Server self-check
async function checkServer() {
  try {
    // Use 127.0.0.1 explicitly — 'localhost' resolves to ::1 (IPv6) on some
    // Railway containers where the server only binds on IPv4, causing ECONNREFUSED.
    const port = process.env.PORT || 3000;
    const r = await _httpGet(`http://127.0.0.1:${port}/api/health`, 4000);
    const ok = r.status === 200;
    return { ok, label: 'Server', detail: ok ? `${r.ms}ms` : `HTTP ${r.status}` };
  } catch(e) {
    return { ok: false, label: 'Server', detail: e.message };
  }
}

// 2. Redis connectivity
async function checkRedis() {
  if (!_redis) return { ok: false, label: 'Redis', detail: 'No REDIS_URL configured' };
  try {
    const pong = await _redis.ping();
    return { ok: pong === 'PONG', label: 'Redis', detail: pong === 'PONG' ? 'Connected' : 'Bad response' };
  } catch(e) {
    return { ok: false, label: 'Redis', detail: e.message };
  }
}

// 3. WebSub subscription health
async function checkWebSub() {
  if (!_getAllChannels || !_websubLeases) return { ok: false, label: 'WebSub', detail: 'Not initialized' };
  // Give 5 minutes after boot for subscriptions to complete before alarming.
  // Initial subscription of 159 channels takes 1-2 minutes.
  const uptimeMs = Date.now() - _startTime;
  if (uptimeMs < 5 * 60 * 1000) {
    return { ok: true, label: 'WebSub', detail: `Subscribing… (${Math.round(uptimeMs/1000)}s since boot)` };
  }
  const channels = _getAllChannels().filter(c => c.hasLive);
  if (!channels.length) return { ok: true, label: 'WebSub', detail: 'No live channels' };
  const now = Date.now();
  let active = 0, failed = 0, unknown = 0, expiringSoon = 0;
  channels.forEach(ch => {
    const lease = _websubLeases[ch.id];
    if (!lease || lease.status === 'unknown') { unknown++; return; }
    if (lease.status === 'failed' || lease.status === 'error') { failed++; return; }
    if (lease.status === 'active') {
      active++;
      if (lease.expiresAt && (lease.expiresAt - now) < 48 * 3600 * 1000) expiringSoon++;
    }
  });
  const failRate = (failed + unknown) / channels.length;
  const ok = failRate < WEBSUB_FAIL_THRESHOLD;
  return {
    ok, label: 'WebSub',
    detail: `${active}/${channels.length} active`,
    extra: { active, failed, unknown, expiringSoon, total: channels.length },
  };
}

// 4. YouTube live detection — was there a live check recently?
async function checkLiveDetection() {
  if (!_cache) return { ok: false, label: 'Live Detection', detail: 'Cache not available' };
  const lastCheck = _cache.lastLiveCheck || null;
  if (!lastCheck) return { ok: false, label: 'Live Detection', detail: 'No live check recorded yet' };
  const age = Date.now() - lastCheck;
  const ok = age < LIVE_CHECK_STALE_MS;
  const mins = Math.round(age / 60000);
  return { ok, label: 'Live Detection', detail: ok ? `Last check ${mins}m ago` : `Stale — ${mins}m since last check` };
}

// 5. Recent video fetch health
async function checkRecentFetch() {
  if (!_cache) return { ok: false, label: 'Recent Fetch', detail: 'Cache not available' };
  const lastFetch = _cache.lastRecentFetch || null;
  if (!lastFetch) return { ok: false, label: 'Recent Fetch', detail: 'No fetch recorded yet' };
  const age = Date.now() - lastFetch;
  const ok = age < RECENT_FETCH_STALE_MS;
  const hrs = Math.round(age / 3600000 * 10) / 10;
  return { ok, label: 'Recent Fetch', detail: ok ? `Last fetch ${hrs}h ago` : `Stale — ${hrs}h since last fetch` };
}

// 6. YouTube quota status
async function checkQuota() {
  if (!_getQuota) return { ok: true, label: 'YT Quota', detail: 'Not tracked' };
  try {
    const q = _getQuota();
    const ok = !q.primaryExceeded;
    const pct = Math.round((q.primaryUnits / q.primaryLimit) * 100);
    return {
      ok, label: 'YT Quota',
      detail: ok ? `${q.primaryUnits}/${q.primaryLimit} units (${pct}%)` : 'Primary key quota exceeded',
      extra: q,
    };
  } catch(e) {
    return { ok: true, label: 'YT Quota', detail: 'Could not read quota' };
  }
}

// 7. NWS reachability — check via the /api/forecast proxy which calls NWS /points.
// Hitting api.weather.gov directly from Railway IPs is unreliable (rate-limited).
// The forecast endpoint is server-side and cached, making it a better proxy indicator.
async function checkNWSAlerts() {
  try {
    const port = process.env.PORT || 3000;
    // Milwaukee coords — just checking reachability of the server's NWS-backed endpoint
    const r = await _httpGet(`http://127.0.0.1:${port}/api/forecast?lat=43.04&lon=-87.91`, 8000);
    const ok = r.status === 200;
    return { ok, label: 'NWS / Forecast API', detail: ok ? `${r.ms}ms` : `HTTP ${r.status}` };
  } catch(e) {
    return { ok: false, label: 'NWS / Forecast API', detail: e.message };
  }
}

// 8. Open-Meteo forecast API
async function checkOpenMeteo() {
  try {
    const r = await _httpGet('https://api.open-meteo.com/v1/forecast?latitude=43&longitude=-87.9&current=temperature_2m&forecast_days=1', 5000);
    const ok = r.status === 200;
    return { ok, label: 'Open-Meteo', detail: ok ? `${r.ms}ms` : `HTTP ${r.status}` };
  } catch(e) {
    return { ok: false, label: 'Open-Meteo', detail: e.message };
  }
}

// 9. IEM NEXRAD tiles (spot check one tile)
async function checkNEXRAD() {
  try {
    // Check a known-good static tile URL (current frame)
    const r = await _httpGet('https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/4/4/6.png', 5000);
    const ok = r.status === 200;
    return { ok, label: 'NEXRAD Tiles (IEM)', detail: ok ? `${r.ms}ms` : `HTTP ${r.status}` };
  } catch(e) {
    return { ok: false, label: 'NEXRAD Tiles (IEM)', detail: e.message };
  }
}

// 10. NASA GIBS satellite tiles (GOES animation)
async function checkGIBS() {
  try {
    // Use a time 6hr ago on the half-hour — well within GIBS archive window.
    // GIBS cold-renders tiles on first request (10-15s); timeout is generous.
    // A timeout here means GIBS is slow, not broken — treat as warning not failure.
    const t = new Date(Date.now() - 6 * 3600 * 1000);
    t.setUTCSeconds(0, 0);
    t.setUTCMinutes(Math.floor(t.getUTCMinutes() / 30) * 30);
    const p = n => String(n).padStart(2, '0');
    const ts = `${t.getUTCFullYear()}-${p(t.getUTCMonth()+1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:00Z`;
    const url = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_Band13_Clean_Infrared/default/${ts}/GoogleMapsCompatible_Level6/4/5/3.jpg`;
    const r = await _httpGet(url, 20000);
    const ok = r.status === 200;
    return { ok, label: 'GOES Satellite (GIBS)', detail: ok ? `${r.ms}ms` : `HTTP ${r.status}` };
  } catch(e) {
    // Timeout from GIBS is a slow-render, not a true outage — mark ok with note
    const isTimeout = e.message.includes('timeout') || e.message === 'aborted';
    return { ok: isTimeout, label: 'GOES Satellite (GIBS)', detail: isTimeout ? 'Slow (tile cold-render)' : e.message };
  }
}

// 11. Memory usage
async function checkMemory() {
  const mb = Math.round(process.memoryUsage().rss / 1048576);
  const ok = mb < MEMORY_WARN_MB;
  return { ok, label: 'Memory', detail: `${mb} MB RSS`, extra: { mb } };
}

// 12. Blitzortung / Lightning WebSocket (just check the IEM endpoint responds)
async function checkLightning() {
  try {
    // Can't test WSS easily over HTTP, so check IEM's lightning data endpoint
    const r = await _httpGet('https://mesonet.agron.iastate.edu/json/radar.py?operation=list&network=NEXRAD', 5000);
    const ok = r.status === 200;
    return { ok, label: 'Lightning (IEM)', detail: ok ? `${r.ms}ms` : `HTTP ${r.status}` };
  } catch(e) {
    return { ok: false, label: 'Lightning (IEM)', detail: e.message };
  }
}

// 13. Channel count sanity — are there any channels at all?
async function checkChannels() {
  if (!_getAllChannels) return { ok: false, label: 'Channels', detail: 'Not initialized' };
  const channels = _getAllChannels();
  const total = channels.length;
  const live  = channels.filter(c => c.hasLive).length;
  const ok = total > 0;
  return { ok, label: 'Channels', detail: `${total} total, ${live} with live detection`, extra: { total, live } };
}

// 14. Recent error spike — are errors accumulating?
async function checkErrorLog() {
  if (!_eventLog) return { ok: true, label: 'Error Log', detail: 'Not available' };
  const fiveMin = Date.now() - 5 * 60 * 1000;
  const recentErrors = _eventLog.filter(e => e.severity === 'error' && e.timestamp > fiveMin);
  const ok = recentErrors.length < 10; // >10 errors in 5min is a spike
  return {
    ok, label: 'Error Log',
    detail: ok ? `${recentErrors.length} errors in last 5min` : `⚠ ${recentErrors.length} errors in last 5min`,
    extra: { recentErrors: recentErrors.length },
  };
}

// ── Main check runner ─────────────────────────────────────────────────────────
async function runAllChecks() {
  const start = Date.now();
  console.log('[Monitor] Running health checks...');

  const checks = await Promise.allSettled([
    checkServer(),
    checkRedis(),
    checkWebSub(),
    checkLiveDetection(),
    checkRecentFetch(),
    checkQuota(),
    checkNWSAlerts(),
    checkOpenMeteo(),
    checkNEXRAD(),
    checkGIBS(),
    checkMemory(),
    checkLightning(),
    checkChannels(),
    checkErrorLog(),
  ]);

  const results = checks.map((c, i) => {
    if (c.status === 'fulfilled') return c.value;
    const labels = ['Server','Redis','WebSub','Live Detection','Recent Fetch','YT Quota',
                    'NWS Alerts API','Open-Meteo','NEXRAD Tiles','GOES Satellite',
                    'Memory','Lightning','Channels','Error Log'];
    return { ok: false, label: labels[i] || `Check ${i}`, detail: c.reason?.message || 'Failed' };
  });

  const failed = results.filter(r => !r.ok);
  const allOk  = failed.length === 0;
  const ms     = Date.now() - start;

  _lastRun     = Date.now();
  _lastResults = { ok: allOk, checkedAt: _lastRun, durationMs: ms, results, failed: failed.length };

  // Cache in Redis for the monitor dashboard
  if (_redis) {
    try {
      await _redis.setex('monitor:last-results', 600, JSON.stringify(_lastResults));
    } catch(_) {}
  }

  // Send alerts for each failed check
  for (const r of failed) {
    const checkId = r.label.toLowerCase().replace(/\s+/g, '-');

    // Skip alerts for checks that are informational-only even when "failing"
    if (checkId === 'error-log' && (_lastResults?.results?.find(x => x.label === 'Error Log')?.extra?.recentErrors || 0) < 5) continue;

    await _sendAlert(checkId, r.label + ' down', r.detail || 'Health check failed');
  }

  const statusLine = allOk ? 'All systems OK' : `${failed.length} check(s) failed: ${failed.map(f => f.label).join(', ')}`;
  console.log(`[Monitor] ${statusLine} (${ms}ms)`);
  return _lastResults;
}

// ── Test alert ────────────────────────────────────────────────────────────────
async function sendTestAlert() {
  const subject = '✅ WeatherTV Monitor — test alert';
  const text    = `This is a test alert from WeatherTV Monitor.\n\nIf you received this, email and/or SMS alerts are working correctly.\n\nTime: ${new Date().toLocaleString()}\nDashboard: ${APP_URL}/monitor`;

  const emailOk = await _sendEmail(subject, text);
  const smsOk   = await _sendSMS(`WeatherTV Monitor test — alerts are working. ${new Date().toLocaleTimeString()}`);

  const emailCfg = !!(process.env.RESEND_API_KEY && process.env.MONITOR_EMAIL_TO);
  const smsCfg   = !!(process.env.TEXTBELT_API_KEY && process.env.MONITOR_SMS_TO);

  return {
    email: emailCfg ? (emailOk ? 'sent' : 'failed — check RESEND_API_KEY and MONITOR_EMAIL_FROM') : 'not configured',
    sms:   smsCfg   ? (smsOk   ? 'sent' : 'failed — check TEXTBELT_API_KEY and MONITOR_SMS_TO')   : 'not configured',
    emailTo:  process.env.MONITOR_EMAIL_TO  || null,
    smsTo:    process.env.MONITOR_SMS_TO    || null,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  init,
  runAllChecks,
  sendTestAlert,
  getLastResults: () => _lastResults,
};
