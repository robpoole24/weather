// ═══════════════════════════════════════════════════════════════════
// radar.js — WeatherTV NWS Alert Push Notification Module
// ═══════════════════════════════════════════════════════════════════
// Responsibilities:
//   1. Register/unregister FCM device tokens with NWS zone
//   2. Poll NWS alerts API every 2 minutes
//   3. Match active alerts to registered device zones
//   4. Send FCM push notifications via Firebase Admin SDK
//   5. Track sent alerts in Redis to avoid duplicate notifications
// ═══════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');

// ── Firebase Admin Init ──────────────────────────────────────────────────────
let firebaseApp = null;

function initFirebase() {
  if (firebaseApp) return firebaseApp;
  try {
    const serviceAccountRaw = process.env.FCM_SERVICE_ACCOUNT;
    if (!serviceAccountRaw) {
      console.warn('[Radar] FCM_SERVICE_ACCOUNT not set — push notifications disabled');
      return null;
    }
    const serviceAccount = typeof serviceAccountRaw === 'string'
      ? JSON.parse(serviceAccountRaw)
      : serviceAccountRaw;

    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: 'weather-tv-radar',
    });
    console.log('[Radar] Firebase Admin initialized');
    return firebaseApp;
  } catch(e) {
    console.error('[Radar] Firebase init error:', e.message);
    return null;
  }
}

// ── NWS Alert Config ────────────────────────────────────────────────────────
// ALWAYS_NOTIFY: sent regardless of user preferences (life-safety critical)
// DEFAULT_ON:    enabled for all new registrations, user can disable
// DEFAULT_OFF:   user must opt in (useful for specific groups e.g. asthmatics)
const ALERT_META = {
  'Tornado Warning':             { icon:'🌪️', color:'#ff0000', always:true  },
  'Severe Thunderstorm Warning': { icon:'⛈️',  color:'#ff8c00', always:true  },
  'Flash Flood Emergency':       { icon:'🌊', color:'#00ff00', always:true  },
  'Extreme Wind Warning':        { icon:'💨', color:'#ff4500', always:true  },
  'Tornado Watch':               { icon:'🌪️', color:'#ffff00', always:false, defaultOn:true  },
  'Severe Thunderstorm Watch':   { icon:'⛈️',  color:'#db8d00', always:false, defaultOn:true  },
  'Flash Flood Warning':         { icon:'🌊', color:'#00ff00', always:false, defaultOn:true  },
  'Flood Warning':               { icon:'🌊', color:'#2e8b57', always:false, defaultOn:false },
  'Flash Flood Watch':           { icon:'🌊', color:'#2e8b57', always:false, defaultOn:false },
  'Winter Storm Warning':        { icon:'❄️',  color:'#9370db', always:false, defaultOn:false },
  'Blizzard Warning':            { icon:'❄️',  color:'#ff69b4', always:false, defaultOn:false },
  'Ice Storm Warning':           { icon:'❄️',  color:'#8b008b', always:false, defaultOn:false },
  'High Wind Warning':           { icon:'💨', color:'#daa520', always:false, defaultOn:false },
  'Excessive Heat Warning':      { icon:'🌡️', color:'#c71585', always:false, defaultOn:false },
  'Red Flag Warning':            { icon:'🔥', color:'#ff1493', always:false, defaultOn:false },
  'Air Quality Alert':           { icon:'😷', color:'#c97a1e', always:false, defaultOn:false },
  'Dense Smoke Advisory':        { icon:'💨', color:'#b05a00', always:false, defaultOn:false },
  'Special Weather Statement':   { icon:'⚠️',  color:'#a0a0a0', always:false, defaultOn:false },
};

// Build the default alert type list for new registrations
const DEFAULT_ALERT_TYPES = Object.entries(ALERT_META)
  .filter(([, m]) => m.always || m.defaultOn)
  .map(([k]) => k);

// Backward-compat alias used in older code paths
const ALERT_PRIORITY = Object.fromEntries(
  Object.entries(ALERT_META).map(([k, m], i) => [k, { priority: i+1, icon: m.icon, color: m.color }])
);

// ── Redis Key Helpers ────────────────────────────────────────────────────────
// These use the rGet/rSet/rDel functions passed in from server.js
// Token storage: wt:fcm:token:{token} = { token, zone, zoneId, registeredAt }
// Sent alerts:   wt:fcm:sent:{alertId} = timestamp (expires after 6 hours)

const FCM_TOKEN_PREFIX  = 'wt:fcm:token:';
const FCM_SENT_PREFIX   = 'wt:fcm:sent:';
const FCM_TOKENS_INDEX  = 'wt:fcm:tokens'; // SET of all token keys

// ── Module State ─────────────────────────────────────────────────────────────
let pollInterval = null;
let redisClient  = null;

// ── Init ─────────────────────────────────────────────────────────────────────
function init(redis) {
  redisClient = redis;
  initFirebase();
  startPolling();
  console.log('[Radar] NWS alert polling started');
}

// ── Token Registration ────────────────────────────────────────────────────────
// zone: NWS zone string e.g. "WIZ066" (county zone) — obtained from NWS API
// zoneId: human label e.g. "Milwaukee, WI"
async function registerToken(token, zone, zoneId, alertTypes = null) {
  if (!redisClient || !token || !zone) return false;
  try {
    const key = FCM_TOKEN_PREFIX + token;
    // Preserve existing preferences if token re-registers (e.g. location update)
    let existingPrefs = null;
    try {
      const existing = await redisClient.get(key);
      if (existing) existingPrefs = JSON.parse(existing).alertTypes;
    } catch(_) {}
    const data = JSON.stringify({
      token,
      zone,
      zoneId:       zoneId || zone,
      registeredAt: Date.now(),
      alertTypes:   alertTypes || existingPrefs || DEFAULT_ALERT_TYPES,
    });
    await redisClient.set(key, data);
    await redisClient.sadd(FCM_TOKENS_INDEX, key);
    console.log(`[Radar] Token registered for zone ${zone}`);
    return true;
  } catch(e) {
    console.error('[Radar] Token register error:', e.message);
    return false;
  }
}

async function updateTokenPreferences(token, alertTypes) {
  if (!redisClient || !token || !Array.isArray(alertTypes)) return false;
  try {
    const key = FCM_TOKEN_PREFIX + token;
    const raw = await redisClient.get(key);
    if (!raw) return false;
    const data = JSON.parse(raw);
    // Always include the non-negotiable always-on alerts
    const alwaysOn = Object.entries(ALERT_META).filter(([,m]) => m.always).map(([k]) => k);
    const merged   = [...new Set([...alwaysOn, ...alertTypes])];
    data.alertTypes = merged;
    await redisClient.set(key, JSON.stringify(data));
    console.log(`[Radar] Preferences updated for token (${merged.length} types enabled)`);
    return true;
  } catch(e) {
    console.error('[Radar] Preference update error:', e.message);
    return false;
  }
}

async function unregisterToken(token) {
  if (!redisClient || !token) return;
  try {
    const key = FCM_TOKEN_PREFIX + token;
    await redisClient.del(key);
    await redisClient.srem(FCM_TOKENS_INDEX, key);
  } catch(e) {}
}

async function getAllTokens() {
  if (!redisClient) return [];
  try {
    const keys = await redisClient.smembers(FCM_TOKENS_INDEX);
    if (!keys.length) return [];
    const values = await Promise.all(keys.map(k => redisClient.get(k)));
    return values
      .filter(Boolean)
      .map(v => { try { return JSON.parse(v); } catch(e) { return null; } })
      .filter(Boolean);
  } catch(e) {
    console.error('[Radar] getAllTokens error:', e.message);
    return [];
  }
}

// ── NWS Zone Lookup ───────────────────────────────────────────────────────────
// Given lat/lng, finds the NWS county zone (e.g. WIZ066)
async function lookupZone(lat, lng) {
  try {
    const res = await fetch(
      `https://api.weather.gov/points/${lat},${lng}`,
      { headers: { 'User-Agent': 'WeatherTV/1.0 contact@altruisticapps.com', 'Accept': 'application/json' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const zoneUrl = data.properties?.county || data.properties?.forecastZone;
    if (!zoneUrl) return null;
    // Extract zone ID from URL e.g. https://api.weather.gov/zones/county/WIZ066
    const zoneId = zoneUrl.split('/').pop();
    const city = data.properties?.relativeLocation?.properties?.city || '';
    const state = data.properties?.relativeLocation?.properties?.state || '';
    const label = city && state ? `${city}, ${state}` : zoneId;
    return { zoneId, label };
  } catch(e) {
    console.error('[Radar] Zone lookup error:', e.message);
    return null;
  }
}

// ── NWS Alert Polling ─────────────────────────────────────────────────────────
function startPolling() {
  // Poll immediately, then every 2 minutes
  pollAlerts();
  pollInterval = setInterval(pollAlerts, 2 * 60 * 1000);
}

async function pollAlerts() {
  if (!firebaseApp) return;
  try {
    const tokens = await getAllTokens();
    if (!tokens.length) return;

    // Fetch all active alerts
    const res = await fetch(
      'https://api.weather.gov/alerts/active?status=actual&message_type=alert&region_type=land',
      { headers: { 'User-Agent': 'WeatherTV/1.0 contact@altruisticapps.com', 'Accept': 'application/geo+json' } }
    );
    if (!res.ok) return;
    const data = await res.json();
    const features = data.features || [];

    // Group tokens by zone for efficient matching
    const tokensByZone = {};
    tokens.forEach(t => {
      if (!tokensByZone[t.zone]) tokensByZone[t.zone] = [];
      tokensByZone[t.zone].push(t);
    });

    // For each alert, check which zones it affects
    for (const feature of features) {
      const props = feature.properties;
      const alertId = props.id;
      const event = props.event || 'Advisory';

      // Skip events not in our known alert meta (truly unknown types)
      if (!ALERT_META[event]) continue;

      // Check if we've already sent this alert
      const sentKey = FCM_SENT_PREFIX + alertId;
      const alreadySent = await redisClient.get(sentKey);
      if (alreadySent) continue;

      // Get zones affected by this alert from NWS affectedZones
      const affectedZones = props.affectedZones || [];
      const affectedZoneIds = affectedZones.map(z => z.split('/').pop());

      // Also check geocode SAME codes (county FIPS) and UGC
      const geocodeSAME = props.geocode?.SAME || [];
      const geocodeUGC  = props.geocode?.UGC  || [];

      // Find tokens in affected zones whose preferences include this alert type
      const meta = ALERT_META[event];
      const tokensToNotify = [];
      Object.entries(tokensByZone).forEach(([zone, zoneTokens]) => {
        const inZone = affectedZoneIds.includes(zone) ||
                       geocodeUGC.includes(zone) ||
                       geocodeSAME.some(s => zone.includes(s.slice(-6)));
        if (!inZone) return;
        zoneTokens.forEach(t => {
          // Always-on alerts go to everyone; otherwise check user prefs
          const prefs = t.alertTypes || DEFAULT_ALERT_TYPES;
          if (meta.always || prefs.includes(event)) tokensToNotify.push(t);
        });
      });

      if (!tokensToNotify.length) continue;

      // Send notifications
      const info = ALERT_META[event] || { icon: '⚠️', color: '#a0a0a0' };
      const headline = props.headline || event;
      const areaDesc = (props.areaDesc || '').split(';')[0].trim();
      const expires  = props.expires
        ? new Date(props.expires).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })
        : '';

      const sent = await sendPushNotifications(tokensToNotify, {
        title: `${info.icon} ${event}`,
        body: areaDesc ? `${areaDesc}${expires ? ' · Until ' + expires : ''}` : headline,
        event,
        alertId,
        color: info.color,
        headline,
      });

      if (sent) {
        // Mark as sent — expire after 6 hours so it can re-notify if extended
        await redisClient.set(sentKey, Date.now().toString(), 'EX', 21600);
        console.log(`[Radar] Push sent: ${event} → ${tokensToNotify.length} device(s)`);
      }
    }
  } catch(e) {
    console.error('[Radar] Poll error:', e.message);
  }
}

// ── FCM Send ──────────────────────────────────────────────────────────────────
async function sendPushNotifications(tokenObjs, payload) {
  if (!firebaseApp || !tokenObjs.length) return false;
  try {
    const messaging = admin.messaging(firebaseApp);
    const tokens = tokenObjs.map(t => t.token);

    // Send in batches of 500 (FCM limit)
    const BATCH = 500;
    for (let i = 0; i < tokens.length; i += BATCH) {
      const batch = tokens.slice(i, i + BATCH);
      const message = {
        tokens: batch,
        notification: {
          title: payload.title,
          body:  payload.body,
        },
        android: {
          priority: 'high',
          notification: {
            color: payload.color,
            channelId: 'weather_alerts',
            priority: 'max',
            defaultSound: true,
            defaultVibrateTimings: true,
          },
        },
        data: {
          event:    payload.event,
          alertId:  payload.alertId,
          headline: payload.headline,
          type:     'weather_alert',
        },
      };

      const response = await messaging.sendEachForMulticast(message);

      // Clean up invalid tokens
      response.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error?.code;
          if (code === 'messaging/invalid-registration-token' ||
              code === 'messaging/registration-token-not-registered') {
            unregisterToken(batch[idx]);
          }
        }
      });
    }
    return true;
  } catch(e) {
    console.error('[Radar] FCM send error:', e.message);
    return false;
  }
}

// ── Express Routes (mounted by server.js) ────────────────────────────────────
function routes(app) {

  // POST /api/radar/register
  // Body: { token, lat, lng }
  // Looks up NWS zone from lat/lng and registers the FCM token
  app.post('/api/radar/register', async (req, res) => {
    const { token, lat, lng } = req.body;
    if (!token || lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'token, lat, lng required' });
    }
    const zone = await lookupZone(lat, lng);
    if (!zone) {
      return res.status(400).json({ error: 'Could not determine NWS zone for location' });
    }
    const ok = await registerToken(token, zone.zoneId, zone.label);
    if (ok) {
      res.json({ success: true, zone: zone.zoneId, label: zone.label });
    } else {
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // DELETE /api/radar/unregister
  // Body: { token }
  app.delete('/api/radar/unregister', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });
    await unregisterToken(token);
    res.json({ success: true });
  });

  // GET /api/radar/status — admin overview
  app.get('/api/radar/status', async (req, res) => {
    const tokens = await getAllTokens();
    const byZone = {};
    tokens.forEach(t => { byZone[t.zone] = (byZone[t.zone] || 0) + 1; });
    res.json({ totalDevices: tokens.length, byZone });
  });

  // GET /api/radar/alert-types — available alert types with metadata
  app.get('/api/radar/alert-types', (req, res) => {
    const types = Object.entries(ALERT_META).map(([event, m]) => ({
      event, icon: m.icon, color: m.color,
      always: m.always, defaultOn: m.defaultOn || false,
    }));
    res.json({ types, defaults: DEFAULT_ALERT_TYPES });
  });

  // PUT /api/radar/preferences — update per-token alert type preferences
  // Body: { token, alertTypes: ['Tornado Warning', ...] }
  app.put('/api/radar/preferences', async (req, res) => {
    const { token, alertTypes } = req.body;
    if (!token || !Array.isArray(alertTypes)) {
      return res.status(400).json({ error: 'token and alertTypes array required' });
    }
    const ok = await updateTokenPreferences(token, alertTypes);
    if (ok) {
      res.json({ success: true, alertTypes });
    } else {
      res.status(404).json({ error: 'Token not found — register first' });
    }
  });
}

module.exports = { init, routes, registerToken, unregisterToken, updateTokenPreferences, lookupZone, ALERT_META, DEFAULT_ALERT_TYPES, get _firebaseApp() { return firebaseApp; } };
