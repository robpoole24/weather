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

// ── NWS Alert Priority & Icons ───────────────────────────────────────────────
const ALERT_PRIORITY = {
  'Tornado Warning':                    { priority: 1,  icon: '🌪️', color: '#ff0000' },
  'Flash Flood Emergency':              { priority: 2,  icon: '🌊', color: '#00ff00' },
  'Extreme Wind Warning':               { priority: 3,  icon: '💨', color: '#ff4500' },
  'Severe Thunderstorm Warning':        { priority: 4,  icon: '⛈️',  color: '#ff8c00' },
  'Flash Flood Warning':                { priority: 5,  icon: '🌊', color: '#00ff00' },
  'Flood Warning':                      { priority: 6,  icon: '🌊', color: '#00ff00' },
  'Tornado Watch':                      { priority: 7,  icon: '🌪️', color: '#ffff00' },
  'Severe Thunderstorm Watch':          { priority: 8,  icon: '⛈️',  color: '#db8d00' },
  'Flash Flood Watch':                  { priority: 9,  icon: '🌊', color: '#2e8b57' },
  'Winter Storm Warning':               { priority: 10, icon: '❄️',  color: '#9370db' },
  'Blizzard Warning':                   { priority: 11, icon: '❄️',  color: '#ff69b4' },
  'Ice Storm Warning':                  { priority: 12, icon: '❄️',  color: '#8b008b' },
  'High Wind Warning':                  { priority: 13, icon: '💨', color: '#daa520' },
  'Excessive Heat Warning':             { priority: 14, icon: '🌡️', color: '#c71585' },
  'Red Flag Warning':                   { priority: 15, icon: '🔥', color: '#ff1493' },
  'Special Weather Statement':          { priority: 16, icon: '⚠️',  color: '#a0a0a0' },
};

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
async function registerToken(token, zone, zoneId) {
  if (!redisClient || !token || !zone) return false;
  try {
    const key = FCM_TOKEN_PREFIX + token;
    const data = JSON.stringify({ token, zone, zoneId: zoneId || zone, registeredAt: Date.now() });
    await redisClient.set(key, data);
    await redisClient.sadd(FCM_TOKENS_INDEX, key);
    console.log(`[Radar] Token registered for zone ${zone}`);
    return true;
  } catch(e) {
    console.error('[Radar] Token register error:', e.message);
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

      // Skip low-priority events that don't warrant push notifications
      if (!ALERT_PRIORITY[event] || ALERT_PRIORITY[event].priority > 15) continue;

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

      // Find tokens in affected zones
      const tokensToNotify = [];
      Object.entries(tokensByZone).forEach(([zone, zoneTokens]) => {
        if (
          affectedZoneIds.includes(zone) ||
          geocodeUGC.includes(zone) ||
          geocodeSAME.some(s => zone.includes(s.slice(-6)))
        ) {
          tokensToNotify.push(...zoneTokens);
        }
      });

      if (!tokensToNotify.length) continue;

      // Send notifications
      const info = ALERT_PRIORITY[event] || { icon: '⚠️', color: '#a0a0a0' };
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

  // GET /api/radar/status
  // Returns number of registered devices (admin use)
  app.get('/api/radar/status', async (req, res) => {
    const tokens = await getAllTokens();
    const byZone = {};
    tokens.forEach(t => {
      byZone[t.zone] = (byZone[t.zone] || 0) + 1;
    });
    res.json({ totalDevices: tokens.length, byZone });
  });
}

module.exports = { init, routes, registerToken, unregisterToken, lookupZone };
