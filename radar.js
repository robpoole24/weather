// ═══════════════════════════════════════════════════════════════════
// radar.js — WeatherTV NWS Alert Push Notifications (privacy-first)
// build.1790546400
// ═══════════════════════════════════════════════════════════════════
// HOW IT WORKS — the server never learns or stores where anyone is:
//
//   1. The DEVICE looks up its own NWS county + forecast zone codes
//      (straight from api.weather.gov) and subscribes its push token to
//      Firebase topics like  a_WIC079_TOR  (area WIC079, Tornado Warning).
//      One topic per (area, alert type) the user wants. We relay the
//      subscribe call to Firebase and keep nothing.
//   2. This server polls NWS every 60s. For each new warning it sends ONE
//      message per group of affected areas to those topics — Firebase fans
//      it out. Alert-type preferences are enforced by which topics a device
//      joined, so no per-user data exists anywhere on our side.
//   3. Storm-based warnings include their polygon. The DEVICE checks its own
//      location against it: inside → full alarm; same county but outside the
//      polygon → a quiet "nearby" note. The location never leaves the phone.
//
// The old design stored a push token + county per device in Redis. On
// startup those legacy records are deleted.
// ═══════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');

let firebaseApp = null;
function initFirebase() {
  if (firebaseApp) return firebaseApp;
  try {
    const raw = process.env.FCM_SERVICE_ACCOUNT;
    if (!raw) { console.warn('[Radar] FCM_SERVICE_ACCOUNT not set — push notifications disabled'); return null; }
    const serviceAccount = typeof raw === 'string' ? JSON.parse(raw) : raw;
    firebaseApp = admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: 'weather-tv-radar' });
    console.log('[Radar] Firebase Admin initialized');
    return firebaseApp;
  } catch (e) {
    console.error('[Radar] Firebase init error:', e.message);
    return null;
  }
}

// ── Alert catalog ────────────────────────────────────────────────────────────
// code:  3-letter id used in topic names
// tier:  sound class on devices — 'siren' (outdoor warning siren),
//        'chime' (soft two-note), 'quiet' (system default / low-key)
// always: life-safety — every device subscribes, can't be turned off
// defaultOn: on for new users, can be turned off
const ALERT_META = {
  'Tornado Warning':             { code:'TOR', icon:'🌪️', color:'#ff0000', tier:'siren', always:true  },
  'Extreme Wind Warning':        { code:'EWW', icon:'💨', color:'#ff4500', tier:'siren', always:true  },
  'Severe Thunderstorm Warning': { code:'SVR', icon:'⛈️', color:'#ff8c00', tier:'chime', always:true  },
  'Flash Flood Warning':         { code:'FFW', icon:'🌊', color:'#00ff00', tier:'chime', always:false, defaultOn:true },
  'Tornado Watch':               { code:'TOA', icon:'🌪️', color:'#ffff00', tier:'quiet', always:false, defaultOn:true },
  'Severe Thunderstorm Watch':   { code:'SVA', icon:'⛈️', color:'#db8d00', tier:'quiet', always:false, defaultOn:true },
  'Flood Warning':               { code:'FLW', icon:'🌊', color:'#2e8b57', tier:'quiet', always:false, defaultOn:false },
  'Flash Flood Watch':           { code:'FFA', icon:'🌊', color:'#2e8b57', tier:'quiet', always:false, defaultOn:false },
  'Winter Storm Warning':        { code:'WSW', icon:'❄️', color:'#9370db', tier:'quiet', always:false, defaultOn:false },
  'Blizzard Warning':            { code:'BZW', icon:'❄️', color:'#ff69b4', tier:'quiet', always:false, defaultOn:false },
  'Ice Storm Warning':           { code:'ISW', icon:'❄️', color:'#8b008b', tier:'quiet', always:false, defaultOn:false },
  'High Wind Warning':           { code:'HWW', icon:'💨', color:'#daa520', tier:'quiet', always:false, defaultOn:false },
  'Extreme Heat Warning':        { code:'EHW', icon:'🌡️', color:'#c71585', tier:'quiet', always:false, defaultOn:false },
  'Red Flag Warning':            { code:'FWW', icon:'🔥', color:'#ff1493', tier:'quiet', always:false, defaultOn:false },
  'Air Quality Alert':           { code:'AQA', icon:'😷', color:'#c97a1e', tier:'quiet', always:false, defaultOn:false },
  'Dense Smoke Advisory':        { code:'DSA', icon:'💨', color:'#b05a00', tier:'quiet', always:false, defaultOn:false },
  'Special Weather Statement':   { code:'SPS', icon:'⚠️', color:'#a0a0a0', tier:'quiet', always:false, defaultOn:false },
};
// NWS renamed "Excessive Heat" to "Extreme Heat" in 2025; accept both spellings
const EVENT_ALIASES = { 'Excessive Heat Warning': 'Extreme Heat Warning' };

const DEFAULT_ALERT_TYPES = Object.entries(ALERT_META).filter(([, m]) => m.always || m.defaultOn).map(([k]) => k);
const TOPIC_RE = /^a_[A-Z]{2}[CZ]\d{3}_[A-Z]{3}$/;
const UGC_RE = /^[A-Z]{2}[CZ]\d{3}$/;
const NWS_HEADERS = { 'User-Agent': 'WeatherTV/1.0 contact@altruisticapps.com', 'Accept': 'application/geo+json' };

// ── State ────────────────────────────────────────────────────────────────────
let redisClient = null;
let pollTimer = null;
const SENT_PREFIX = 'wt:alertpush:sent:';
const stats = { day: null, polls: 0, alertsSent: 0, messages: 0, errors: 0, subscribeCalls: 0, lastPoll: null, lastError: null, recent: [] };
function bump(k, n = 1) {
  const today = new Date().toISOString().slice(0, 10);
  if (stats.day !== today) Object.assign(stats, { day: today, polls: 0, alertsSent: 0, messages: 0, errors: 0, subscribeCalls: 0 });
  stats[k] += n;
}

function init(redis) {
  redisClient = redis;
  initFirebase();
  purgeLegacyDeviceRecords().catch(() => {});
  pollAlerts();
  pollTimer = setInterval(pollAlerts, 60 * 1000);
  console.log('[Radar] NWS alert polling started (60s, topic-based, no device storage)');
}

// Old design kept token + county per device. Delete it all, once.
async function purgeLegacyDeviceRecords() {
  if (!redisClient) return;
  const keys = await redisClient.smembers('wt:fcm:tokens');
  if (!keys || !keys.length) return;
  for (let i = 0; i < keys.length; i += 500) await redisClient.del(...keys.slice(i, i + 500));
  await redisClient.del('wt:fcm:tokens');
  console.log(`[Radar] Deleted ${keys.length} legacy device records (tokens + zones) — no device data is stored anymore`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function restoreGeographicNames(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/Gulf of America/gi, 'Gulf of Mexico').replace(/America's Gulf/gi, 'Gulf of Mexico')
    .replace(/the Gulf of America/gi, 'the Gulf of Mexico').replace(/Lake America/gi, 'Lake Ontario')
    .replace(/Mount McKinley/gi, 'Denali');
}

// Compact "lat,lon;lat,lon;…" (3 decimals ≈ 100 m). FCM data must stay under
// 4 KB, so very detailed outlines are thinned (warning polygons are small).
function encodePolygon(geom) {
  if (!geom) return '';
  let ring = null;
  if (geom.type === 'Polygon') ring = geom.coordinates[0];
  else if (geom.type === 'MultiPolygon') ring = geom.coordinates[0][0];
  if (!ring || ring.length < 3) return '';
  let pts = ring.map(([lon, lat]) => `${lat.toFixed(3)},${lon.toFixed(3)}`);
  let step = 1;
  while (pts.join(';').length > 2400 && step < 64) {
    step *= 2;
    pts = ring.filter((_, i) => i % step === 0 || i === ring.length - 1).map(([lon, lat]) => `${lat.toFixed(3)},${lon.toFixed(3)}`);
  }
  return pts.join(';');
}

// Stable identity for an alert across NWS updates, from its VTEC code
// e.g. /O.NEW.KMKX.TO.W.0012.260927T2200Z-.../ → KMKX.TO.W.0012
function vtecKey(props) {
  const v = (props.parameters?.VTEC || [])[0] || '';
  const m = v.match(/\/[A-Z]\.[A-Z]{3}\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\./);
  return m ? `${m[1]}.${m[2]}.${m[3]}.${m[4]}` : null;
}

// Decide whether an alert (or an update to one) should be pushed, and how it's labelled
function classify(props) {
  const event = EVENT_ALIASES[props.event] || props.event;
  const meta = ALERT_META[event];
  if (!meta) return null;
  const torThreat = (props.parameters?.tornadoDamageThreat || [])[0] || '';
  const ffThreat = (props.parameters?.flashFloodDamageThreat || [])[0] || '';
  let displayEvent = event, tier = meta.tier, level = 'base';
  if (event === 'Tornado Warning' && torThreat === 'CATASTROPHIC') { displayEvent = 'TORNADO EMERGENCY'; level = 'emergency'; }
  else if (event === 'Tornado Warning' && torThreat === 'CONSIDERABLE') { displayEvent = 'PDS Tornado Warning'; level = 'pds'; }
  else if (event === 'Flash Flood Warning' && ffThreat === 'CATASTROPHIC') { displayEvent = 'FLASH FLOOD EMERGENCY'; tier = 'siren'; level = 'emergency'; }
  // Updates (continuations, tweaks) only push when they ESCALATE the threat
  if (props.messageType === 'Update' && level === 'base') return null;
  if (props.messageType !== 'Alert' && props.messageType !== 'Update') return null;
  return { event, meta, displayEvent, tier, level };
}

// ── Polling + sending ────────────────────────────────────────────────────────
async function pollAlerts() {
  if (!firebaseApp || !redisClient) return;
  bump('polls');
  stats.lastPoll = new Date().toISOString();
  try {
    const res = await fetch('https://api.weather.gov/alerts/active?status=actual&region_type=land', { headers: NWS_HEADERS });
    if (!res.ok) throw new Error('NWS HTTP ' + res.status);
    const features = (await res.json()).features || [];
    for (const f of features) {
      const props = f.properties || {};
      const c = classify(props);
      if (!c) continue;
      if (props.expires && Date.parse(props.expires) < Date.now()) continue;
      const ugc = (props.geocode?.UGC || []).filter(u => UGC_RE.test(u));
      if (!ugc.length) continue;

      // One push per alert per threat level (so an upgrade to Tornado Emergency pushes again)
      const identity = (vtecKey(props) || props.id) + ':' + c.level;
      const sentKey = SENT_PREFIX + identity;
      if (await redisClient.get(sentKey)) continue;

      const ok = await sendAlert(props, f.geometry, c, ugc, identity);
      if (ok) {
        const ttl = Math.max(600, Math.min(86400, Math.round((Date.parse(props.expires || 0) - Date.now()) / 1000) + 3600));
        await redisClient.set(sentKey, '1', 'EX', ttl);
        bump('alertsSent');
        stats.recent.unshift({ at: new Date().toISOString(), event: c.displayEvent, areas: ugc.length, area: (props.areaDesc || '').slice(0, 80) });
        stats.recent = stats.recent.slice(0, 25);
      }
    }
  } catch (e) {
    bump('errors'); stats.lastError = e.message;
    console.error('[Radar] Poll error:', e.message);
  }
}

function buildData(props, geometry, c, identity, test = false) {
  const expires = props.expires || new Date(Date.now() + 30 * 60000).toISOString();
  return {
    type: 'weather_alert',
    alertKey: identity.replace(/[^A-Za-z0-9.:_-]/g, '_'),
    event: c.event,
    displayEvent: c.displayEvent,
    tier: c.tier,
    icon: c.meta.icon,
    headline: restoreGeographicNames(props.headline || c.displayEvent).slice(0, 300),
    area: restoreGeographicNames(props.areaDesc || '').slice(0, 300),
    expires,
    poly: encodePolygon(geometry),
    url: '/radar.html',
    test: test ? '1' : '0',
  };
}

// Firebase conditions allow up to 5 topics OR'ed together; one message per group
async function sendAlert(props, geometry, c, ugcList, identity, test = false) {
  const messaging = admin.messaging(firebaseApp);
  const data = buildData(props, geometry, c, identity, test);
  const ttlMs = Math.max(60000, Math.min(6 * 3600000, Date.parse(data.expires) - Date.now()));
  let okAny = false;
  for (let i = 0; i < ugcList.length; i += 5) {
    const condition = ugcList.slice(i, i + 5).map(u => `'a_${u}_${c.meta.code}' in topics`).join(' || ');
    try {
      await messaging.send({
        condition, data,
        android: { priority: 'high', ttl: ttlMs },
        webpush: { headers: { Urgency: 'high', TTL: String(Math.round(ttlMs / 1000)) } },
      });
      bump('messages'); okAny = true;
    } catch (e) {
      bump('errors'); stats.lastError = e.message;
      console.error('[Radar] FCM send error:', e.message);
    }
  }
  if (okAny) console.log(`[Radar] Push: ${c.displayEvent} → ${ugcList.length} area(s)`);
  return okAny;
}

// ── Tiny per-IP limiter for the subscribe relay ─────────────────────────────
const _rate = new Map();
setInterval(() => _rate.clear(), 60 * 1000).unref();
function rateOk(req, max = 30) {
  const ip = req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const n = (_rate.get(ip) || 0) + 1; _rate.set(ip, n);
  return n <= max;
}

// ── Routes ───────────────────────────────────────────────────────────────────
function routes(app) {
  // POST /api/radar/subscribe  { token, add:[topics], remove:[topics] }
  // Relays topic (un)subscriptions to Firebase. Nothing is stored.
  app.post('/api/radar/subscribe', async (req, res) => {
    if (!rateOk(req)) return res.status(429).json({ error: 'slow down' });
    if (!firebaseApp) return res.status(503).json({ error: 'push disabled' });
    const { token } = req.body || {};
    const add = Array.isArray(req.body?.add) ? req.body.add : [];
    const remove = Array.isArray(req.body?.remove) ? req.body.remove : [];
    if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return res.status(400).json({ error: 'bad token' });
    if (add.length > 80 || remove.length > 80 || ![...add, ...remove].every(t => TOPIC_RE.test(t))) {
      return res.status(400).json({ error: 'bad topics' });
    }
    const messaging = admin.messaging(firebaseApp);
    const failed = [];
    for (const t of add) {
      try { const r = await messaging.subscribeToTopic(token, t); if (r.failureCount) failed.push(t); } catch (_) { failed.push(t); }
    }
    for (const t of remove) {
      try { await messaging.unsubscribeFromTopic(token, t); } catch (_) { /* best effort */ }
    }
    bump('subscribeCalls');
    res.json({ ok: failed.length === 0, added: add.length - failed.length, removed: remove.length, failed });
  });

  // GET /api/radar/alert-types — catalog for the preferences UI
  app.get('/api/radar/alert-types', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    const types = Object.entries(ALERT_META).map(([event, m]) => ({
      event, code: m.code, icon: m.icon, color: m.color, tier: m.tier, always: m.always, defaultOn: m.defaultOn || false,
    }));
    res.json({ types, defaults: DEFAULT_ALERT_TYPES });
  });

  // Retired endpoints (old pages may still call them). Nothing is stored.
  app.post('/api/radar/register', (req, res) => res.status(410).json({ success: false, deprecated: true, use: '/api/radar/subscribe' }));
  app.put('/api/radar/preferences', (req, res) => res.status(410).json({ success: false, deprecated: true }));
  app.delete('/api/radar/unregister', (req, res) => res.json({ success: true }));

  // ── Admin (behind /api/admin auth) ──
  app.get('/api/admin/radar/status', (req, res) => res.json({ enabled: !!firebaseApp, deviceRecordsStored: 0, ...stats }));

  // POST /api/admin/radar/test  { ugc:'WIC079', type:'Tornado Warning' }
  // Sends a clearly-labelled TEST push to everyone subscribed to that area+type.
  app.post('/api/admin/radar/test', async (req, res) => {
    if (!firebaseApp) return res.status(503).json({ error: 'push disabled' });
    const ugc = String(req.body?.ugc || '').toUpperCase();
    const event = req.body?.type || 'Tornado Warning';
    const meta = ALERT_META[event];
    if (!UGC_RE.test(ugc) || !meta) return res.status(400).json({ error: 'ugc like WIC079 and a known type required' });
    const c = { event, meta, displayEvent: event, tier: meta.tier, level: 'base' };
    const props = { headline: `TEST — ${event} (not a real warning)`, areaDesc: `WeatherTV push test for ${ugc}`,
                    expires: new Date(Date.now() + 15 * 60000).toISOString() };
    const ok = await sendAlert(props, null, c, [ugc], 'TEST.' + ugc + '.' + Date.now(), true);
    res.json({ ok });
  });
}

module.exports = { init, routes, pollAlerts, ALERT_META, DEFAULT_ALERT_TYPES, encodePolygon, classify, vtecKey, TOPIC_RE };
