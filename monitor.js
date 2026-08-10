// ═══════════════════════════════════════════════════════════════════
// monitor.js — WeatherTV Health Monitor
// ═══════════════════════════════════════════════════════════════════
// Runs health checks on every WeatherTV subsystem on a schedule.
// Sends FCM push alerts to registered admin devices when anything
// breaks. Results are cached in Redis and served via /api/monitor/status.
//
// Checks run every 5 minutes. Alert cooldown: 30 minutes per check
// type so you don't get spammed during an extended outage.
//
// Called from server.js:
//   const monitor = require('./monitor');
//   monitor.init({ redis, getAllChannels, websubLeases, cache,
//                  primaryQuotaExceeded, eventLog, firebaseApp, admin });
// ═══════════════════════════════════════════════════════════════════

'use strict';

const https = require('https');

// ── Constants ────────────────────────────────────────────────────────────────
const CHECK_INTERVAL_MS   = 5  * 60 * 1000; // run checks every 5 min
const ALERT_COOLDOWN_MS   = 30 * 60 * 1000; // only re-alert same issue after 30 min
const RESULT_TTL_MS       = 10 * 60 * 1000; // status cache lifetime
const APP_URL             = process.env.APP_URL || 'https://www.watchweathertv.com';

// Thresholds
const WEBSUB_FAIL_THRESHOLD  = 0.10; // alert if >10% of channels failed/unknown
const MEMORY_WARN_MB         = 400;  // alert if RSS exceeds this
const RECENT_FETCH_STALE_MS  = 4 * 60 * 60 * 1000; // alert if no fetch in 4hr
const LIVE_CHECK_STALE_MS    = 30 * 60 * 1000;      // alert if live check hasn't run in 30min

// ── Module State ─────────────────────────────────────────────────────────────
let _redis         = null;
let _getAllChannels = null;
let _websubLeases  = null;
let _cache         = null;
let _getQuota      = null;
let _eventLog      = null;
let _firebaseApp   = null;
let _admin         = null;
let _lastRun       = null;
let _lastResults   = null;
let _alertCooldowns = {}; // { checkId: lastAlertTimestamp }
let _checkTimer    = null;
let _adminTokens   = []; // FCM tokens for admin alerts

// ── Init ─────────────────────────────────────────────────────────────────────
function init({ redis, getAllChannels, websubLeases, cache,
                getQuota, eventLog, firebaseApp, admin }) {
  _redis         = redis;
  _getAllChannels = getAllChannels;
  _websubLeases  = websubLeases;
  _cache         = cache;
  _getQuota      = getQuota;
  _eventLog      = eventLog;
  _firebaseApp   = firebaseApp;
  _admin         = admin;

  // Load admin FCM tokens from Redis
  _loadAdminTokens();

  // Run first check 30s after boot, then every 5 min.
  // All wrapped in try/catch — monitor must never crash the main server.
  setTimeout(async () => {
    try { await runAllChecks(); } catch(e) { console.error('[Monitor] Check error:', e.message); }
    _checkTimer = setInterval(async () => {
      try { await runAllChecks(); } catch(e) { console.error('[Monitor] Check error:', e.message); }
    }, CHECK_INTERVAL_MS);
  }, 30 * 1000);

  console.log('[Monitor] Health monitor initialized — first check in 30s');
}

// ── Admin token management ────────────────────────────────────────────────────
async function _loadAdminTokens() {
  if (!_redis) return;
  try {
    const raw = await _redis.get('monitor:admin-tokens');
    if (raw) _adminTokens = JSON.parse(raw);
    console.log(`[Monitor] Loaded ${_adminTokens.length} admin FCM token(s)`);
  } catch(e) {
    console.warn('[Monitor] Could not load admin tokens:', e.message);
  }
}

async function addAdminToken(token) {
  if (!_adminTokens.includes(token)) _adminTokens.push(token);
  if (_redis) await _redis.set('monitor:admin-tokens', JSON.stringify(_adminTokens));
}

async function removeAdminToken(token) {
  _adminTokens = _adminTokens.filter(t => t !== token);
  if (_redis) await _redis.set('monitor:admin-tokens', JSON.stringify(_adminTokens));
}

// ── FCM Alert Sender ─────────────────────────────────────────────────────────
async function _sendAlert(checkId, title, body) {
  // Cooldown — don't re-alert the same issue for 30 min
  const now = Date.now();
  if (_alertCooldowns[checkId] && now - _alertCooldowns[checkId] < ALERT_COOLDOWN_MS) return;
  _alertCooldowns[checkId] = now;

  console.warn(`[Monitor] ALERT: ${title} — ${body}`);

  if (!_firebaseApp || !_admin || !_adminTokens.length) return;
  try {
    const messaging = _admin.messaging(_firebaseApp);
    await messaging.sendEachForMulticast({
      tokens: _adminTokens,
      notification: { title: `⚠️ WeatherTV: ${title}`, body },
      android: {
        priority: 'high',
        notification: { channelId: 'monitor_alerts', priority: 'max', defaultSound: true },
      },
      data: { type: 'monitor_alert', checkId },
    });
  } catch(e) {
    console.error('[Monitor] FCM send error:', e.message);
  }
}

// ── HTTP health fetch ─────────────────────────────────────────────────────────
function _httpGet(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const req = https.get(url, { headers: { 'User-Agent': 'WeatherTV-Monitor/1.0' } }, res => {
      let body = '';
      res.on('data', d => { body += d; if (body.length > 50000) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body, ms: Date.now() - start }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Individual Checks ─────────────────────────────────────────────────────────

// 1. Server self-check
async function checkServer() {
  try {
    const r = await _httpGet(`${APP_URL}/api/health`, 6000);
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

// 7. NWS Alerts API
async function checkNWSAlerts() {
  try {
    const r = await _httpGet('https://api.weather.gov/alerts/active?status=actual&limit=1', 8000);
    const ok = r.status === 200;
    return { ok, label: 'NWS Alerts API', detail: ok ? `${r.ms}ms` : `HTTP ${r.status}` };
  } catch(e) {
    return { ok: false, label: 'NWS Alerts API', detail: e.message };
  }
}

// 8. Open-Meteo forecast API
async function checkOpenMeteo() {
  try {
    const r = await _httpGet('https://api.open-meteo.com/v1/forecast?latitude=43&longitude=-87.9&current=temperature_2m&forecast_days=1', 8000);
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
    const r = await _httpGet('https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/4/4/6.png', 8000);
    const ok = r.status === 200;
    return { ok, label: 'NEXRAD Tiles (IEM)', detail: ok ? `${r.ms}ms` : `HTTP ${r.status}` };
  } catch(e) {
    return { ok: false, label: 'NEXRAD Tiles (IEM)', detail: e.message };
  }
}

// 10. NASA GIBS satellite tiles (GOES animation)
async function checkGIBS() {
  try {
    // Use a time 3hr ago on the half-hour to ensure it's in the archive
    const t = new Date(Date.now() - 3 * 3600 * 1000);
    t.setUTCSeconds(0, 0);
    t.setUTCMinutes(Math.floor(t.getUTCMinutes() / 30) * 30);
    const p = n => String(n).padStart(2, '0');
    const ts = `${t.getUTCFullYear()}-${p(t.getUTCMonth()+1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:00Z`;
    const url = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_Band13_Clean_Infrared/default/${ts}/GoogleMapsCompatible_Level6/4/5/3.jpg`;
    const r = await _httpGet(url, 10000);
    const ok = r.status === 200;
    return { ok, label: 'GOES Satellite (GIBS)', detail: ok ? `${r.ms}ms` : `HTTP ${r.status}` };
  } catch(e) {
    return { ok: false, label: 'GOES Satellite (GIBS)', detail: e.message };
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
    const r = await _httpGet('https://mesonet.agron.iastate.edu/geojson/recent_nexrad.py?minutes=5', 6000);
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

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  init,
  runAllChecks,
  getLastResults: () => _lastResults,
  addAdminToken,
  removeAdminToken,
  getAdminTokens: () => _adminTokens,
};
