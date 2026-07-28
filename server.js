// WeatherTV Server — updated 2026-07-09T06:12:19Z build.1780105000
const express = require('express');
const { applySecurityMiddleware, applyErrorHandler } = require('./security-middleware');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const radar = require('./radar');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

// Load .env file if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && !key.startsWith('#') && val.length) {
      process.env[key.trim()] = val.join('=').trim();
    }
  });
}

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'channels.json');

applySecurityMiddleware(app);
app.use(express.json({ limit: '5mb' })); // 5MB covers the full appData payload sent by saveAll()

// ── WS4KP dynamic music playlist ──────────────────────────────────────────
// Scans the actual music folder so any MP3 pushed to GitHub is auto-included.
// Must be before express.static so it takes precedence over any static file.
app.get('/weatherstar/playlist.json', (req, res) => {
  const fs = require('fs');
  const musicRoot = path.join(__dirname, 'public', 'weatherstar', 'music');
  const files = [];
  // Root music/ folder
  try {
    fs.readdirSync(musicRoot)
      .filter(f => /\.mp3$/i.test(f))
      .forEach(f => files.push(f));
  } catch (_) {}
  // music/default/ subfolder (WS4KP's built-in location)
  try {
    fs.readdirSync(path.join(musicRoot, 'default'))
      .filter(f => /\.mp3$/i.test(f))
      .forEach(f => files.push(`default/${f}`));
  } catch (_) {}
  res.json({ availableFiles: files });
});

// ── Admin Authentication ──
// HTTP Basic Auth gates the entire admin panel and all /api/admin/* routes.
// Without this, ANYONE who finds /admin can read the YouTube API key (via
// GET /api/admin/config, which returns the full data store including
// config.apiKey), overwrite the entire channel database (POST /api/admin/restore
// accepts arbitrary JSON with no validation beyond shape), mark channels
// live/offline, burn API quota on demand, etc.
//
// Set ADMIN_USER and ADMIN_PASSWORD as Railway environment variables to enable.
// If ADMIN_PASSWORD is not set, admin routes remain OPEN (fail-open) so local
// dev isn't broken by default -- but a loud warning is logged on every request
// so this can't go unnoticed in production logs.
function adminAuth(req, res, next) {
  const expectedUser = process.env.ADMIN_USER || 'admin';
  const expectedPass = process.env.ADMIN_PASSWORD;

  if (!expectedPass) {
    console.warn('[WeatherTV] WARNING: ADMIN_PASSWORD not set -- admin panel is UNPROTECTED. Set ADMIN_USER and ADMIN_PASSWORD env vars to secure it.');
    return next();
  }

  const authHeader = req.headers.authorization || '';
  const [scheme, encoded] = authHeader.split(' ');

  if (scheme === 'Basic' && encoded) {
    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const sepIdx = decoded.indexOf(':');
      const user = decoded.slice(0, sepIdx);
      const pass = decoded.slice(sepIdx + 1);

      // Timing-safe comparison -- pad to equal length first since
      // timingSafeEqual throws on mismatched buffer lengths.
      const userBuf = Buffer.from(user);
      const expectedUserBuf = Buffer.from(expectedUser);
      const passBuf = Buffer.from(pass);
      const expectedPassBuf = Buffer.from(expectedPass);

      const userMatch = userBuf.length === expectedUserBuf.length && crypto.timingSafeEqual(userBuf, expectedUserBuf);
      const passMatch = passBuf.length === expectedPassBuf.length && crypto.timingSafeEqual(passBuf, expectedPassBuf);

      if (userMatch && passMatch) return next();
    } catch (e) { /* fall through to 401 */ }
  }

  res.set('WWW-Authenticate', 'Basic realm="WeatherTV Admin"');
  return res.status(401).send('Authentication required');
}

// /admin and /api/admin must be registered BEFORE the general public static
// middleware below. express.static() serves a matching file and never calls
// next() -- if public/admin/ exists for any reason (e.g. leftover from an
// earlier project layout), the general static handler would serve it directly
// and adminAuth would never run, regardless of whether ADMIN_PASSWORD is set.
app.use('/admin', adminAuth, express.static(path.join(__dirname, 'admin')));
app.use('/api/admin', adminAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ── Load / Save data ──
// In-memory data store — loaded from Redis or file on startup
let appDataStore = null;

function loadData() {
  if (appDataStore) return appDataStore;
  // Fall back to file if Redis hasn't loaded yet
  if (fs.existsSync(DATA_FILE)) {
    try {
      appDataStore = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return appDataStore;
    } catch(e) {}
  }
  appDataStore = getDefaultData();
  return appDataStore;
}

function saveData(data) {
  // Update in-memory store
  appDataStore = data;

  // Write to Redis (primary persistent store)
  rSet('wt:appData', data);

  // Also write to file as backup
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch(e) {
    console.warn('[WeatherTV] Could not write channels.json:', e.message);
  }
}

// Load app data from Redis into memory on startup
async function restoreAppDataFromRedis() {
  if (!redis) return;
  try {
    const stored = await rGet('wt:appData');
    if (stored && stored.groups && stored.groups.length > 0) {
      // Validate structure — must have proper groups with channels arrays
      const valid = stored.groups.every(g => g.id && g.label && Array.isArray(g.channels));
      if (!valid) {
        console.error('[Redis] Stored data has invalid structure — using defaults');
        return;
      }

      // Use Redis data directly — it was saved by admin and is authoritative
      // New channels added via code will appear after admin does Save All Changes
      appDataStore = stored;
      const chCount = stored.groups.reduce((s, g) => s + (g.channels||[]).length, 0);
      console.log('[Redis] App data restored — ' + stored.groups.length + ' groups, ' + chCount + ' channels');
    } else {
      console.log('[Redis] No app data in Redis — using defaults');
    }
  } catch(e) {
    console.error('[Redis] App data restore error:', e.message);
  }
}

function getDefaultData() {
  return {
    config: {
      playlistId: 'PLNDLR7JhLYhOdX-lSyjsgUSkwcd55UuiI',
      apiKey: process.env.YOUTUBE_API_KEY || '',
      liveCheckIntervalHours: 2,    // 2 hours between live polls — set to 0.25 after quota increase to 50k
      recentFetchHourEST: 12,       // hour (0-23) in EST for first daily fetch -- noon, after most forecasters post their daily forecast
      recentFetchHour2EST: 18,      // hour (0-23) in EST for second daily fetch -- 6pm, catches afternoon/evening storm content
    },
    groups: [
      {
        id: 'forecasters',
        label: 'Weather Forecasters',
        icon: '⛅',
        channels: [
              { id: 'max-chasers', label: 'Exclusive Chasers', enabled: false }
            ]
          },
              { id: 'ryan-chasers', label: 'Exclusive Chasers', enabled: false }
            ]
          },
          { id: 'UCuYqi3hOfz6-3Hdp6tEJjAg', name: 'AccuWeather',         hasLive: true,  enabled: true },
          { id: 'UCp2G_jHO53yj2NVjv8zbDmQ', name: 'Evan Fryberger',    hasLive: true,  enabled: true },
          { id: 'UCvBVK2ymNzPLRJrgip2GeQQ', name: 'Max Velocity',      hasLive: true,  enabled: true,
            collections: [
          { id: 'UCJHAT3Uvv-g3I8H3GhHWV7w', name: "Ryan Hall Y'all",   hasLive: true,  enabled: true,
            collections: [
          { id: 'UCBtR7ynKM9odz-PW_7uyzDw', name: 'Severe Studios',    hasLive: true,  enabled: true },
        ]
      },
      {
        id: 'chasers',
        label: 'Storm Chasers',
        icon: '🌪',
        channels: [
          { id: 'UC8QZ-OIqfWKek1CpMvs2O3g', name: 'Aaron Jayjack',          hasLive: true,  enabled: true },
          { id: 'UCf8dNCufHlKZp-CgU8NPryw', name: 'Adam Lucio',             hasLive: true,  enabled: true },
          { id: 'UCXQYQMwU9wc584i7ecZzm_A', name: 'Adri Mozeris',           hasLive: false, enabled: true },
          { id: 'UCW-db9uRShMINgICqQeyt1Q', name: 'Alexander Spahn',        hasLive: false, enabled: true },
          { id: 'UCT1IIkU3Yafr6nfNxQlWuSQ', name: 'Andrew Pritchard',       hasLive: true,  enabled: true },
          { id: 'UCXZJRhrMbtXqjZCZUGp5CTg', name: 'Bamawxcom',              hasLive: false, enabled: true },
          { id: 'UCj6aoh3tZuQoqfHs4ZWpHcA', name: 'Brad Arnold',            hasLive: true,  enabled: true },
          { id: 'UCD3KREyo3IqCLBC-4khGgIw', name: 'Brandon Clement',        hasLive: true,  enabled: true },
          { id: 'UCniY5-9rLWSE6c3iA4fh73w', name: 'Brandon Copic Archive',  hasLive: false, enabled: true },
          { id: 'UCPqLI_AohMn1jnFg8ocMyHA', name: 'Brandon Copic Live',     hasLive: true,  enabled: true },
          { id: 'UC0xEzjGJ6waQPoHwAdhYD7Q', name: 'Brandon Ivey', hasLive: true, enabled: true },
          { id: 'UCMmlV4B6Bx2GuYtIaxpLcfw', name: 'Brittney Richardson',    hasLive: true,  enabled: true },
          { id: 'UCLfN3U2O0sEYabjo2lxIttw', name: 'Celton Henderson',       hasLive: false, enabled: true },
          { id: 'UCvIqVAaqpx1Q_e9DzIxgk1A', name: 'CF Productions',         hasLive: true,  enabled: true },
          { id: 'UCGpPbdVAtTUgW_w98lXC9nw', name: 'Chris Riske',            hasLive: true,  enabled: true },
          { id: 'UCx_mcHxMvZ8PBmVTtg6Ddtw', name: 'CJ Ziegler',             hasLive: true,  enabled: true },
          { id: 'UCb0U1g5r4kH_NDMGiGRhysA', name: 'Connor Croff',           hasLive: true,  enabled: true },
          { id: 'UCRYYy0UrfyGmMKQDU1N1R3g', name: 'Convective Chronicles',  hasLive: true,  enabled: true },
          { id: 'UCx5ex9rJumpj-oKgVJrP4hA', name: 'Corey Gerken',           hasLive: true,  enabled: true },
          { id: 'UC1dcRoXHbZ0QFOBB6DKPmdg', name: 'Dan Robinson',            hasLive: false, enabled: true },
          { id: 'UCemyFpFfu55JvAP_eWW1NdA', name: 'Daniel Shaw',            hasLive: true,  enabled: true },
          { id: 'UCixgOrfusZuPt_FVO1sIXAw', name: 'Dilly Dilly Dalton',      hasLive: true,  enabled: true },
          { id: 'UChZ_VT3MrHB53bSqFiVf4eg', name: "Edgar O'Neal",           hasLive: true,  enabled: true },
          { id: 'UCZSDkxJS7PRw9V0_Sm6U7jg', name: 'Freddy McKinney',        hasLive: true,  enabled: true },
          { id: 'UC6lUxl1KxmI7TWnAA6go1EQ', name: 'Jaden Pappenheim',       hasLive: true,  enabled: true },
          { id: 'UCPgskHnT1cT_hpfbq9nUK7w', name: 'Jakob McMillin',         hasLive: true,  enabled: true },
          { id: 'UCgHiLhzivmLjWTnYerF8E9A', name: 'James Hammett', hasLive: false, enabled: true },
          { id: 'UCWMRFAo3Cvd7W8yQpQwsOQA', name: 'John McKinney',          hasLive: true,  enabled: true },
          { id: 'UCSoEfOMuGNjrrhD4iLTKo_A', name: 'Jonas Piontek',          hasLive: false, enabled: true },
          { id: 'UC86mOt7YnKgRUQxblDpsN-g', name: 'Jordan Hall',            hasLive: true,  enabled: true },
          { id: 'UCvRBXkjHG0vbDrO-03ZIWxw', name: 'Justin Noonan',          hasLive: false, enabled: true },
          { id: 'UClIZx2ESMJVocfMIbji_ujg', name: 'Justin Poublon',         hasLive: true,  enabled: true },
          { id: 'UCPtizAsfQaJktz0tw9YuKLQ', name: 'Kannon Kalton',          hasLive: true,  enabled: true },
          { id: 'UC1nJElGcVcTpeZJVyxEbzJw', name: 'Live Storms Media',      hasLive: true,  enabled: true },
          { id: 'UC9Y_sKyerjEGdywnoB0XrXg', name: 'Mark Peyton', hasLive: true, enabled: true },
          { id: 'UCeE90n3GWO1XZcwt8xpNRtw', name: 'Melanie Metz',           hasLive: true,  enabled: true },
          { id: 'UCXUU-_dJ-eGBh3-bjPNsalQ', name: 'Nathan Moore',            hasLive: true,  enabled: true },
          { id: 'UC-uBgtNjd3V0ngd7-IZbphQ', name: 'Nick Stewart', hasLive: true, enabled: true },
          { id: 'UCy5cFthFcECu6DMSBcOX5AQ', name: 'Oklahoma Weather Couple', hasLive: false, enabled: true },
          { id: 'UCV6hWxB0-u_IX7e-h4fEBAw', name: 'Reed Timmer',            hasLive: true,  enabled: true },
          { id: 'UChxsy558HhpaqnB1Hk6tHkw', name: 'Reilly Dibble',          hasLive: true,  enabled: true },
          { id: 'UCY4Vj4lQZ-TSrz66RDi-DJA', name: 'Ryan Miller',             hasLive: true,  enabled: true },
          { id: 'UCSQH3qItz0gZ5oXw8cSNR2w', name: 'Ryan Scholl',            hasLive: true,  enabled: true },
          { id: 'UCIQ1bii18GuNOICBA86HUMQ', name: 'Sawyer Spiral',           hasLive: false, enabled: true },
          { id: 'UCqsI0A7OlQTnwPFOUZaISMA', name: 'Scott Currens',          hasLive: false, enabled: true },
          { id: 'UCqAWcfd0BJBgCW8iyOLOF3g', name: 'Scott Peake',            hasLive: true,  enabled: true },
          { id: 'UCkB7RBehEqHvsD60C1yfAAg', name: 'Skip Talbot', hasLive: false, enabled: true },
          { id: 'UCddpbBha4DGhxy5KI9smjow', name: 'Storm Chase HQ',        hasLive: true,  enabled: true },
          { id: 'UCdSMdTFOfqmOXP-1vD2cxAA', name: 'Storm Chase TV',         hasLive: true,  enabled: true },
          { id: 'UCrqV52vTW5wksR-8vCZgAyA', name: 'Storm Chaser Dana',     hasLive: true,  enabled: true },
          { id: 'UCWAN-rRJFLosqgiiIFVpkEQ', name: 'Storm Chasing Video',    hasLive: true,  enabled: true },
          { id: 'UCapcjkwRd5jNJ6vbE7NWIkw', name: 'Storm Hunters',           hasLive: true,  enabled: true },
          { id: 'UCGS82m2ORvg1nfeAJsFqWDg', name: 'Storm of Passion', hasLive: true, enabled: true },
          { id: 'UCAnSuGYTjwbGoBMgF_aBpnQ', name: 'Stormgasm',              hasLive: true,  enabled: true },
          { id: 'UCBmOfiL9LC3dT4Ps2veVCoQ', name: 'Stormrunner Media',      hasLive: true,  enabled: true },
          { id: 'UCAdsKTAapDXhosiq7B237SA', name: 'Tanner Charles',           hasLive: true,  enabled: true },
          { id: 'UCaS1PyCKSyoDlel7iVOI2Vw', name: 'Tornado Crew Storm Chasers', hasLive: true, enabled: true },
          { id: 'UCCzfjxXs0o9h1cOgnnmc2Zw', name: 'Tornado Paigeyy',        hasLive: true,  enabled: true },
          { id: 'UCuer9Sw2UAD5LWZpVXbgKTA', name: 'Tornado TRX',            hasLive: false, enabled: true },
          { id: 'UCTWhf2uDTdr3pVNKUCdgnDQ', name: 'Twister Chasers', hasLive: true, enabled: true },
          { id: 'UC-4XLQqaY8y7K2aNGbOAJfQ', name: 'White Weather', hasLive: false, enabled: true },
          { id: 'UCuDoeT6EEdOTtuZh0s_gcpQ', name: 'DL Scales', hasLive: true, enabled: true },
          { id: 'UCMARQE2OVE9a6kzOMhKuPVw', name: 'Moderate Motley', hasLive: true, enabled: true },
          { id: 'UCqSk-ojoH2rgAuYadPLJgJA', name: 'Vince Waelti', hasLive: true, enabled: true },
          { id: 'UCG6jXdmfKUqR_OiPsRLDAnw', name: 'The UK Storm Chaser', hasLive: true, enabled: true },
        ]
      },
      {
        id: 'creators',
        label: 'Other Weather Creators',
        icon: '🎬',
        channels: [
          { id: 'UCBJXCq0V3EdcbQWwZ7HO7tQ', name: 'Alexander Androshchuk', hasLive: false, enabled: true },
          { id: 'UCuFxM1HTY6SONb_FICAl6gQ', name: 'Carly Anna WX',          hasLive: false, enabled: true },
          { id: 'UCGEZlX4V82wv7_Z2LsXtjPA', name: 'June First',             hasLive: true,  enabled: true },
          { id: 'UCy4Zv53jpdE_FfNh3bmtKiA', name: 'Michigan Storm Chasers', hasLive: true, enabled: true },
          { id: 'UCpYQmszu4IP37xyt3RQb2gw', name: 'More Max Velocity',      hasLive: true,  enabled: true },
          { id: 'UCTRPdC_jSFKsBVOUFQ52jGg', name: 'Out of the Whirlwind',   hasLive: false, enabled: true },
          { id: 'UCo-3ThNQmPmQSQL9WPjMaUQ', name: 'Pecos Hank',             hasLive: false, enabled: true },
          { id: 'UClEH97oWJjrm1PX6ZCEcafQ', name: 'Sky Whisper', hasLive: false, enabled: true },
          { id: 'UCCP12NYSDa9KL26PW1zokcA', name: 'Storm Channel Coaching', hasLive: false, enabled: true },
          { id: 'UCz2BWcrW-njx_py1FR0447A', name: 'Storm Reel',             hasLive: false, enabled: true },
          { id: 'UCZTme3vf6kXmXfSsIr06lvQ', name: 'Swegle Studios',         hasLive: false, enabled: true },
          { id: 'UCVdfIdcYEQfUJ9bpmGMaK4Q', name: 'The Old Callisto', hasLive: false, enabled: true },
          { id: 'UCbxfONPDpv4r3IXwppgcTdA', name: 'The Twister Archives',   hasLive: false, enabled: true },
          { id: 'UCGTUbwceCMibvpbd2NaIP7A', name: 'The Weather Channel', hasLive: false, enabled: true },
          { id: 'UC0CPqIPMHCELm208KiwBwdw', name: 'Tornado Forensics',      hasLive: false, enabled: true },
          { id: 'UC9c4E_DWmPMel1MelOBTznw', name: 'Tornado Video Library',  hasLive: false, enabled: true },
          { id: 'UCgGTo_tNrWxArxh3c3aI6bw', name: 'Tornado Warned',         hasLive: false, enabled: true },
          { id: 'UCZOxO3O5KWC4FvSL3d-U_8w', name: 'Weather Beat', hasLive: false, enabled: true },
          { id: 'UCCtYdNBm-8C_wZk0n6u8VnQ', name: 'Weatherbox Studios',     hasLive: false, enabled: true },
          { id: 'UCHf2fy0H-GJNrdVO3KxDV5Q', name: 'WorldStorm',             hasLive: false, enabled: true },
        ]
      }
    ],
    apps: [
      { name: 'WeatherFront',        img: 'images/weatherfront.webp',    ios: 'https://apps.apple.com/us/app/weatherfront-radar-models/id6739154126',            iosSoon: false, android: null,                                                                          androidSoon: true,  enabled: true },
      { name: 'Weather Wise',        img: 'images/weather-wise.webp',    ios: 'https://apps.apple.com/us/app/weatherwise-app/id6736407724',                     iosSoon: false, android: 'https://play.google.com/store/apps/details?id=com.interactiveweather.weatherwise', androidSoon: false, enabled: true },
      { name: 'Radar Omega',         img: 'images/radar-omega.webp',     ios: 'https://apps.apple.com/us/app/radaromega-doppler-radar-app/id1439881811',         iosSoon: false, android: 'https://play.google.com/store/apps/details?id=com.radarx.stormmapping.stormmapping', androidSoon: false, enabled: true },
      { name: 'Windy',               img: 'images/windy.webp',           ios: 'https://apps.apple.com/app/windy-wind-weather-forecast/id1161387262',             iosSoon: false, android: 'https://play.google.com/store/apps/details?id=com.windyty.android',          androidSoon: false, enabled: true },
      { name: 'The Weather Channel', img: 'images/weather-channel.webp', ios: 'https://apps.apple.com/app/the-weather-channel/id295646461',                     iosSoon: false, android: 'https://play.google.com/store/apps/details?id=com.weather.Weather',          androidSoon: false, enabled: true },
      { name: 'AccuWeather',         img: 'images/accuweather.webp',     ios: 'https://apps.apple.com/app/accuweather/id300048137',                              iosSoon: false, android: 'https://play.google.com/store/apps/details?id=com.accuweather.android',      androidSoon: false, enabled: true, collectionRef: 'UCuYqi3hOfz6-3Hdp6tEJjAg::col-1780335893616' },
    ],
    highlights: [],
    chaserMap: {},
    // Accumulating registry of every Spotter Network chaser we've ever seen
    // in a poll, keyed by their Spotter Network ID. The live feed only
    // shows who's currently broadcasting a position, so this persists names
    // across polls — without it, suggestions/matching would be at the mercy
    // of whoever happens to be active in any given 2-minute window.
    // Shape: { [spotterNetworkId]: { name, firstSeenAt, lastSeenAt, youtubeUrl } }
    knownChasers: {},
    // Spotter Network IDs the admin has explicitly said are NOT a match for
    // anything (dismissed from Suggestions) or NOT worth adding (dismissed
    // from New Chasers Found) — excluded from those lists going forward so
    // a "no" answer doesn't keep resurfacing every refresh.
    dismissedSuggestions: [], // array of "spotterNetworkId::channelId" pairs
    dismissedNewChasers: [],  // array of spotterNetworkId
    playlists: [
      { id: 'playlist-1', title: 'Weather Playlist', playlistId: 'PLNDLR7JhLYhOdX-lSyjsgUSkwcd55UuiI' }
    ]
  };
}

// ── API Routes ──

// Get all data
app.get('/api/data', (req, res) => {
  const data = loadData();
  // Strip API key from public response
  const safe = { ...data, config: { ...data.config, apiKey: '***' } };
  res.json(safe);
});

// Get config (admin only — protect this in production!)
app.get('/api/admin/config', (req, res) => {
  // Prevent Cloudflare (and any other proxy) from caching admin API responses.
  // Without this, a POST to /api/admin/restore followed immediately by a GET
  // here could return a stale cached version, making edits appear to revert.
  res.set('Cache-Control', 'no-store');
  res.json(loadData());
});

// Export full config as downloadable JSON backup
app.get('/api/admin/backup', (req, res) => {
  const data = loadData();
  const filename = 'weathertv-backup-' + new Date().toISOString().split('T')[0] + '.json';
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.setHeader('Content-Type', 'application/json');
  res.json(data);
});

// Restore from JSON backup — overwrites current data
app.post('/api/admin/restore', async (req, res) => {
  const data = req.body;
  if (!data || !data.groups || !data.config) {
    return res.status(400).json({ error: 'Invalid backup file — must contain groups and config' });
  }
  // Update in-memory immediately
  appDataStore = data;
  // Wait for Redis to confirm save before responding
  await rSet('wt:appData', data);
  // Also write to filesystem
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch(e) {}
  const totalChannels = data.groups.reduce((s,g) => s + (g.channels||[]).length, 0);
  res.json({ ok: true, message: 'Restored — ' + data.groups.length + ' groups, ' + totalChannels + ' channels loaded' });
});

// Update config
app.put('/api/admin/config', (req, res) => {
  const data = loadData();
  data.config = { ...data.config, ...req.body };
  saveData(data);
  res.json({ ok: true });
});

// Get all groups
app.get('/api/groups', (req, res) => {
  res.json(loadData().groups);
});

// ── Highlights routes ──

// Public — frontend fetches on page load
app.get('/api/highlights', (req, res) => {
  const data = loadData();
  res.json(data.highlights || []);
});

// Admin — get highlights
app.get('/api/admin/highlights', (req, res) => {
  const data = loadData();
  res.json(data.highlights || []);
});

// Admin — add highlight
app.post('/api/admin/highlights', (req, res) => {
  const { channelId, videoId, title, thumbnail } = req.body;
  if (!channelId || !videoId) return res.status(400).json({ error: 'channelId and videoId required' });
  const data = loadData();
  if (!data.highlights) data.highlights = [];
  data.highlights.push({ channelId, videoId, title: title || '', thumbnail: thumbnail || '' });
  saveData(data);
  res.json({ ok: true });
});

// Admin — remove highlight by index
app.delete('/api/admin/highlights/:index', (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const data = loadData();
  if (!data.highlights || idx < 0 || idx >= data.highlights.length) {
    return res.status(404).json({ error: 'Highlight not found' });
  }
  data.highlights.splice(idx, 1);
  saveData(data);
  res.json({ ok: true });
});

// Admin — reorder highlights (swap by index, direction up/down)
app.put('/api/admin/highlights/reorder', (req, res) => {
  const { index, direction } = req.body;
  const data = loadData();
  if (!data.highlights) return res.json({ ok: true });
  const newIdx = direction === 'up' ? index - 1 : index + 1;
  if (newIdx < 0 || newIdx >= data.highlights.length) return res.json({ ok: true });
  const tmp = data.highlights[index];
  data.highlights[index] = data.highlights[newIdx];
  data.highlights[newIdx] = tmp;
  saveData(data);
  res.json({ ok: true });
});

// ── Playlists routes ──

// Public — frontend fetches on page load
app.get('/api/playlists', (req, res) => {
  const data = loadData();
  res.json(data.playlists || []);
});

// Admin — add playlist
app.post('/api/admin/playlists', (req, res) => {
  const { title, playlistId } = req.body;
  if (!title || !playlistId) return res.status(400).json({ error: 'title and playlistId required' });
  const data = loadData();
  if (!data.playlists) data.playlists = [];
  data.playlists.push({ id: 'playlist-' + Date.now(), title, playlistId });
  saveData(data);
  res.json({ ok: true });
});

// Admin — reorder playlists (must be before /:id to avoid Express matching 'reorder' as a param)
app.put('/api/admin/playlists/reorder', (req, res) => {
  const { id, direction } = req.body;
  const data = loadData();
  if (!data.playlists) return res.json({ ok: true });
  const idx = data.playlists.findIndex(p => p.id === id);
  if (idx === -1) return res.json({ ok: true });
  const newIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (newIdx < 0 || newIdx >= data.playlists.length) return res.json({ ok: true });
  const tmp = data.playlists[idx];
  data.playlists[idx] = data.playlists[newIdx];
  data.playlists[newIdx] = tmp;
  saveData(data);
  res.json({ ok: true });
});

// Admin — update playlist
app.put('/api/admin/playlists/:id', (req, res) => {
  const data = loadData();
  if (!data.playlists) return res.status(404).json({ error: 'Not found' });
  const idx = data.playlists.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Playlist not found' });
  data.playlists[idx] = { ...data.playlists[idx], ...req.body };
  saveData(data);
  res.json({ ok: true });
});

// Admin — remove playlist
app.delete('/api/admin/playlists/:id', (req, res) => {
  const data = loadData();
  if (!data.playlists) return res.json({ ok: true });
  data.playlists = data.playlists.filter(p => p.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

// Update a group
app.put('/api/admin/groups/:id', (req, res) => {
  const data = loadData();
  const idx = data.groups.findIndex(g => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Group not found' });
  data.groups[idx] = { ...data.groups[idx], ...req.body };
  saveData(data);
  res.json({ ok: true });
});

// Add channel to group
app.post('/api/admin/groups/:groupId/channels', (req, res) => {
  const data = loadData();
  const group = data.groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const newChannel = { enabled: true, hasLive: true, ...req.body };
  group.channels.push(newChannel);
  saveData(data);
  res.json({ ok: true, channel: newChannel });
});

// Update channel
app.put('/api/admin/groups/:groupId/channels/reorder', (req, res) => {
  const data = loadData();
  const group = data.groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const { channelId, direction } = req.body;
  const idx = group.channels.findIndex(c => c.id === channelId);
  if (idx === -1) return res.status(404).json({ error: 'Channel not found' });
  const newIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (newIdx < 0 || newIdx >= group.channels.length) return res.json({ ok: true });
  const tmp = group.channels[idx];
  group.channels[idx] = group.channels[newIdx];
  group.channels[newIdx] = tmp;
  saveData(data);
  res.json({ ok: true });
});

// Set full channel order for a group (used by A-Z sort and drag-drop).
// Accepts an array of channel IDs in the desired order; reorders the
// channels array in place without touching any other channel fields.
app.put('/api/admin/groups/:groupId/channels/order', (req, res) => {
  const data = loadData();
  const group = data.groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array' });
  const byId = Object.fromEntries(group.channels.map(c => [c.id, c]));
  const reordered = orderedIds.map(id => byId[id]).filter(Boolean);
  // Preserve any channels not in orderedIds (edge case safety)
  const included = new Set(orderedIds);
  group.channels.find(c => !included.has(c.id)) && reordered.push(...group.channels.filter(c => !included.has(c.id)));
  group.channels = reordered;
  saveData(data);
  res.json({ ok: true });
});

app.put('/api/admin/groups/:groupId/channels/:channelId', (req, res) => {
  const data = loadData();
  const group = data.groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const idx = group.channels.findIndex(c => c.id === req.params.channelId);
  if (idx === -1) return res.status(404).json({ error: 'Channel not found' });
  group.channels[idx] = { ...group.channels[idx], ...req.body };
  saveData(data);
  res.json({ ok: true });
});

// Delete channel
app.delete('/api/admin/groups/:groupId/channels/:channelId', (req, res) => {
  const data = loadData();
  const group = data.groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  group.channels = group.channels.filter(c => c.id !== req.params.channelId);
  saveData(data);
  res.json({ ok: true });
});

// Reorder channels within a group
// Add group
app.post('/api/admin/groups', (req, res) => {
  const data = loadData();
  const newGroup = {
    id: req.body.id || 'group-' + Date.now(),
    label: req.body.label || 'New Group',
    icon: req.body.icon || '📺',
    channels: []
  };
  data.groups.push(newGroup);
  saveData(data);
  res.json({ ok: true, group: newGroup });
});

// Delete group
app.delete('/api/admin/groups/:groupId', (req, res) => {
  const data = loadData();
  data.groups = data.groups.filter(g => g.id !== req.params.groupId);
  saveData(data);
  res.json({ ok: true });
});

// Reorder groups
app.put('/api/admin/groups/reorder', (req, res) => {
  const data = loadData();
  const { groupId, direction } = req.body;
  const idx = data.groups.findIndex(g => g.id === groupId);
  if (idx === -1) return res.status(404).json({ error: 'Group not found' });
  const newIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (newIdx < 0 || newIdx >= data.groups.length) return res.json({ ok: true });
  const tmp = data.groups[idx];
  data.groups[idx] = data.groups[newIdx];
  data.groups[newIdx] = tmp;
  saveData(data);
  res.json({ ok: true });
});

// ── Collection (sub-group) routes ──

// Add collection to a channel
app.post('/api/admin/groups/:groupId/channels/:channelId/collections', (req, res) => {
  const data = loadData();
  const group = data.groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const channel = group.channels.find(c => c.id === req.params.channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (!channel.collections) channel.collections = [];
  const col = {
    id: req.body.id || 'col-' + Date.now(),
    label: req.body.label || 'New Collection',
    enabled: req.body.enabled !== false
    // No channelIds — channels declare membership via their own collectionId field
  };
  channel.collections.push(col);
  saveData(data);
  res.json({ ok: true, collection: col });
});

// Update collection
app.put('/api/admin/groups/:groupId/channels/:channelId/collections/:colId', (req, res) => {
  const data = loadData();
  const group = data.groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const channel = group.channels.find(c => c.id === req.params.channelId);
  if (!channel || !channel.collections) return res.status(404).json({ error: 'Not found' });
  const colIdx = channel.collections.findIndex(c => c.id === req.params.colId);
  if (colIdx === -1) return res.status(404).json({ error: 'Collection not found' });
  // Only update label and enabled — membership managed via channel's collectionId
  const { label, enabled } = req.body;
  if (label !== undefined) channel.collections[colIdx].label = label;
  if (enabled !== undefined) channel.collections[colIdx].enabled = enabled;
  saveData(data);
  res.json({ ok: true });
});

// Update a channel's collection memberships (supports multiple)
app.put('/api/admin/groups/:groupId/channels/:channelId/collection-membership', (req, res) => {
  const data = loadData();
  const group = data.groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const channel = group.channels.find(c => c.id === req.params.channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const ids = req.body.collectionIds || [];
  channel.collectionIds = ids;
  channel.collectionId = ids.length > 0 ? ids[0] : null;
  // hiddenInGroup: hide this channel from the main group list
  // Only visible through its collection button on the parent channel card
  if (req.body.hiddenInGroup !== undefined) {
    channel.hiddenInGroup = req.body.hiddenInGroup;
  }
  saveData(data);
  res.json({ ok: true });
});

// Delete collection
app.delete('/api/admin/groups/:groupId/channels/:channelId/collections/:colId', (req, res) => {
  const data = loadData();
  const group = data.groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const channel = group.channels.find(c => c.id === req.params.channelId);
  if (!channel || !channel.collections) return res.status(404).json({ error: 'Not found' });
  channel.collections = channel.collections.filter(c => c.id !== req.params.colId);
  saveData(data);
  res.json({ ok: true });
});

// Update apps
app.put('/api/admin/apps', (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Expected an array of apps' });
  }
  const data = loadData();
  data.apps = req.body;
  saveData(data);
  res.json({ ok: true });
});

// ── App logo upload ──
// Accepts a base64 data URL from the admin panel's file picker, decodes it,
// and writes it to public/images/apps/<slug>.<ext>. Returns the relative path
// to store in app.img -- index.html's buildAppsPanel() and the collection-button
// logo (height:10px, auto width) both render whatever this points to, so any
// reasonably square image works without further resizing.
app.post('/api/admin/upload-app-logo', (req, res) => {
  try {
    const { name, dataUrl } = req.body;
    if (!name || !dataUrl) return res.status(400).json({ error: 'name and dataUrl required' });

    const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Unsupported image format -- use PNG, JPEG, WEBP, or SVG' });

    let ext = match[1] === 'jpeg' ? 'jpg' : match[1] === 'svg+xml' ? 'svg' : match[1];
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 3 * 1024 * 1024) return res.status(400).json({ error: 'Image too large -- 3MB max' });

    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
    const dir = path.join(__dirname, 'public', 'images', 'apps');
    fs.mkdirSync(dir, { recursive: true });

    const filename = `${slug}-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(dir, filename), buffer);

    res.json({ ok: true, path: `images/apps/${filename}` });
  } catch (e) {
    console.error('[WeatherTV] App logo upload failed:', e.message);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── YouTube API Proxy with Server-Side Caching ──
// The server checks live status on a schedule and caches all results.
// Browser clients get cached data instantly — no extra API calls per user.
// This means 1 user or 1000 users costs the same quota.

const https = require('https');

// ── Quota Guard ──
// Primary key (YOUTUBE_API_KEY): 60,000 units/day — handles all normal
// operations: WebSub live confirmations, recent video fetches (via
// playlistItems.list at 1 unit/channel), and manual checks.
//
// Archive key (YOUTUBE_API_KEY_2): 10,000 units/day — kept configured as
// emergency standby only. Never used on a normal day. Activates automatically
// if the primary key somehow hits its limit (e.g. an unusual spike in
// WebSub confirmations or a manual admin fetch run on top of scheduled ones).
//
// Estimated normal daily usage on primary key:
//   2x recent fetch × 146 channels × 1 unit = ~292 units
//   WebSub confirmations (videos.list, 1 unit each, ~30/day) = ~30 units
//   Total: ~320 units/day — well under 60,000 unit limit.
//
// These pools are independent — the archive key running out must NOT also
// halt WebSub-based live detection on the primary key, which is the
// safety-critical path.
let primaryQuotaExceeded = false;
let archiveQuotaExceeded = false;
let primaryQuotaResetTimer = null;
let archiveQuotaResetTimer = null;

function markQuotaExceeded(isPrimary = true) {
  const label = isPrimary ? 'primary' : 'archive';
  const already = isPrimary ? primaryQuotaExceeded : archiveQuotaExceeded;
  if (already) return;
  if (isPrimary) primaryQuotaExceeded = true; else archiveQuotaExceeded = true;
  console.warn(`[WeatherTV] YouTube ${label} key quota exceeded — pausing ${label}-key calls until midnight Pacific`);
  logEvent({ type: 'quota', severity: 'warn', source: label + '-key', message: `YouTube ${label} key quota exceeded — pausing until midnight Pacific` });
  const now = new Date();
  const pacific = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const midnight = new Date(pacific);
  midnight.setHours(24, 0, 30, 0);
  const msUntilReset = midnight - pacific;
  console.log(`[WeatherTV] ${label} key quota will reset in ${Math.round(msUntilReset / 60000)} minutes`);
  const resetFn = () => {
    if (isPrimary) primaryQuotaExceeded = false; else archiveQuotaExceeded = false;
    console.log(`[WeatherTV] ${label} key quota reset — resuming ${label}-key calls`);
    logEvent({ type: 'quota', severity: 'info', source: label + '-key', message: `${label} key quota reset at midnight Pacific — resuming calls` });
    if (isPrimary) scheduledLiveCheck();
  };
  if (isPrimary) {
    if (primaryQuotaResetTimer) clearTimeout(primaryQuotaResetTimer);
    primaryQuotaResetTimer = setTimeout(resetFn, msUntilReset);
  } else {
    if (archiveQuotaResetTimer) clearTimeout(archiveQuotaResetTimer);
    archiveQuotaResetTimer = setTimeout(resetFn, msUntilReset);
  }
}

function getApiKey() {
  return process.env.YOUTUBE_API_KEY || loadData().config.apiKey;
}

// Archive key (YOUTUBE_API_KEY_2) — used for recent video fetches and playlist access
// Falls back to primary key if not configured
function getArchiveApiKey() {
  return process.env.YOUTUBE_API_KEY_2 || getApiKey();
}

function ytFetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function checkQuotaError(data) {
  return data.error && data.error.errors && data.error.errors[0].reason === 'quotaExceeded';
}

// ── Redis Persistent Cache ──
const Redis = require('ioredis');

let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  redis.on('connect', () => console.log('[Redis] Connected — cache persists across deploys'));
  redis.on('error', (e) => console.error('[Redis] Error:', e.message));
} else {
  console.warn('[Redis] No REDIS_URL — using in-memory cache only');
}

// ── Server start time ────────────────────────────────────────────────────────
const SERVER_START_TIME = Date.now();

// In-memory mirrors (fast reads, Redis for persistence)
const cache = {
  liveStatuses: {},
  recentVideos: {},
  playlist: {},
  channelActivity: {}, // { channelId: { lastVideoDate, lastLiveDate, nextFetchDue } }
  lastLiveCheck: null,
  lastNotificationReceived: null, // last WebSub push from YouTube (free, 0 units)
  lastRecentFetch: null,
  websubActive: false,
};

// ── Daily quota burn tracker ─────────────────────────────────────────────────
// Tracks estimated total API units used per day, per key.
// Resets automatically at midnight by checking today's date.
const burnTracker = { date: '', primaryUnits: 0, archiveUnits: 0 };

function trackBurn(isPrimary, units = 100) {
  const today = new Date().toISOString().split('T')[0];
  if (burnTracker.date !== today) {
    burnTracker.date = today;
    burnTracker.primaryUnits = 0;
    burnTracker.archiveUnits = 0;
  }
  if (isPrimary) burnTracker.primaryUnits += units;
  else burnTracker.archiveUnits += units;
}

// ── Storm Chaser Tracker (Spotter Network) ──────────────────────────────────
// Polls the public Spotter Network KML feed every 2 minutes and caches the
// parsed result in memory. No API key required — this is a public feed.
// Source: https://www.spotternetwork.org/feeds/earth-all.txt
//
// Each chaser record looks like:
// { id, name, lat, lng, status, movement, heading, note, positionTime, youtubeUrl }
//
// youtubeUrl is auto-detected from the free-text `Note` field when a chaser
// has self-reported their channel — this lets us flag chasers we don't have
// in our Groups yet (see /api/admin/chasers/unmapped-youtube below).

const SPOTTER_NETWORK_FEED_URL = 'https://www.spotternetwork.org/feeds/earth-all.txt';

let chaserCache = { updatedAt: null, chasers: [] };

function fetchTextOverHttp(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https://') ? https : require('http');
    const opts = new URL(url);
    const reqOptions = {
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      headers: { 'User-Agent': 'WeatherTV/1.0', ...extraHeaders },
    };
    lib.get(reqOptions, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchTextOverHttp(res.headers.location, extraHeaders).then(resolve, reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Extracts a YouTube channel/handle/video URL from free text, if present.
function extractYouTubeUrl(text) {
  if (!text) return null;
  const match = text.match(/https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/[^\s<>"']+/i);
  if (match) return match[0].replace(/[.,)]+$/, ''); // trim trailing punctuation
  return null;
}

// Parses the Spotter Network KML text into an array of chaser objects.
// Regex-based rather than a full XML parser — the feed's structure is flat
// and consistent (one <Placemark> per chaser), so this avoids adding a
// dependency for a one-off parse.
function parseSpotterNetworkKML(kmlText) {
  const chasers = [];
  const placemarkRegex = /<Placemark id="(\d+)">([\s\S]*?)<\/Placemark>/g;
  let pm;
  while ((pm = placemarkRegex.exec(kmlText)) !== null) {
    const id = pm[1];
    const block = pm[2];

    const iconMatch = block.match(/<href>([^<]+)<\/href>/);
    const icon = iconMatch ? iconMatch[1] : '';
    let status = 'active';
    let mobile = false;
    if (icon.includes('red_house')) status = 'inactive';
    if (icon.includes('mobile')) mobile = true;
    if (icon.includes('inactive_mobile')) status = 'inactive';

    const nameMatch = block.match(/<name>([^<]*)<\/name>/);
    const name = nameMatch ? nameMatch[1].trim() : 'Unknown';

    const descMatch = block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/);
    const descRaw = descMatch ? descMatch[1] : '';

    const posTimeMatch = descRaw.match(/Position Time:\s*([^<]+)</);
    const positionTime = posTimeMatch ? posTimeMatch[1].trim() : null;

    const movementMatch = descRaw.match(/Movement:\s*([^<]+)</);
    const movement = movementMatch ? movementMatch[1].trim() : 'Stationary';

    const noteMatch = descRaw.match(/Note:\s*([^<]+)</);
    const note = noteMatch ? noteMatch[1].trim() : null;

    const coordMatch = block.match(/<coordinates>([^<]+)<\/coordinates>/);
    let lat = null, lng = null;
    if (coordMatch) {
      const parts = coordMatch[1].split(',');
      lng = parseFloat(parts[0]);
      lat = parseFloat(parts[1]);
    }

    if (lat === null || lng === null || isNaN(lat) || isNaN(lng)) continue;

    chasers.push({
      id,
      name,
      lat,
      lng,
      status,           // 'active' | 'inactive'
      mobile,           // true if currently moving
      movement,         // e.g. 'NNW (321)' or 'Stationary'
      note,
      positionTime,
      youtubeUrl: extractYouTubeUrl(note)
    });
  }
  return chasers;
}

async function refreshChaserCache() {
  try {
    const text = await fetchTextOverHttp(SPOTTER_NETWORK_FEED_URL);
    const chasers = parseSpotterNetworkKML(text);
    chaserCache = { updatedAt: new Date().toISOString(), chasers };
    console.log(`[Chasers] Refreshed Spotter Network feed: ${chasers.length} positions`);
    mergeIntoKnownChasers(chasers);
  } catch (e) {
    console.warn('[Chasers] Failed to refresh Spotter Network feed:', e.message);
  }
}

// Merges this poll's live positions into the persisted, accumulating
// registry (data.knownChasers). This is what lets suggestions/matching work
// against everyone we've EVER seen broadcast, not just whoever happens to
// be active in this specific 2-minute window. Saved to Redis via saveData
// so it survives restarts and keeps growing over days/weeks.
function mergeIntoKnownChasers(chasers) {
  if (!chasers.length) return;
  const data = loadData();
  if (!data.knownChasers) data.knownChasers = {};
  const now = Date.now();
  let added = 0;

  chasers.forEach(c => {
    const existing = data.knownChasers[c.id];
    if (existing) {
      existing.name = c.name; // keep name current in case they update it
      existing.lastSeenAt = now;
      if (c.youtubeUrl) existing.youtubeUrl = c.youtubeUrl; // pick up a newly-added link
    } else {
      data.knownChasers[c.id] = {
        name: c.name,
        firstSeenAt: now,
        lastSeenAt: now,
        youtubeUrl: c.youtubeUrl || null
      };
      added++;
    }
  });

  if (added > 0) console.log(`[Chasers] Added ${added} newly-seen chaser(s) to known registry (total: ${Object.keys(data.knownChasers).length})`);
  saveData(data);
}

// Public — all current chaser positions, with our channel mapping applied
app.get('/api/chasers', (req, res) => {
  const data = loadData();
  const chaserMap = data.chaserMap || {}; // { spotterNetworkId: channelId }
  // Build reverse lookup: channelId -> name, for attaching to mapped chasers
  const channelById = {};
  (data.groups || []).forEach(g => {
    (g.channels || []).forEach(ch => { channelById[ch.id] = ch; });
  });

  const enriched = chaserCache.chasers.map(c => {
    const mappedChannelId = chaserMap[c.id] || null;
    const mappedChannel = mappedChannelId ? channelById[mappedChannelId] : null;
    return {
      ...c,
      channelId: mappedChannelId,
      channelName: mappedChannel ? mappedChannel.name : null
    };
  });

  res.json({ updatedAt: chaserCache.updatedAt, chasers: enriched });
});

// Admin — same data, used by the Chaser Mapping panel
app.get('/api/admin/chasers', (req, res) => {
  const data = loadData();
  res.json({
    updatedAt: chaserCache.updatedAt,
    chasers: chaserCache.chasers,
    chaserMap: data.chaserMap || {},
    knownChasersCount: Object.keys(data.knownChasers || {}).length
  });
});

// Admin — full accumulated registry of every chaser we've ever seen, for
// browsing directly (the "All Known" tab). The Suggestions matcher is
// intentionally conservative to avoid false positives, so this gives the
// admin a way to manually catch anything the matcher missed — e.g. a
// channel name that's a stage name with zero token overlap with the
// chaser's real name on Spotter Network.
app.get('/api/admin/chasers/known', (req, res) => {
  const data = loadData();
  const knownChasers = data.knownChasers || {};
  const chaserMap = data.chaserMap || {};
  const dismissedNew = new Set(data.dismissedNewChasers || []);
  const liveIds = new Set(chaserCache.chasers.map(c => c.id));

  const all = Object.entries(knownChasers).map(([spotterNetworkId, c]) => ({
    spotterNetworkId,
    name: c.name,
    firstSeenAt: c.firstSeenAt,
    lastSeenAt: c.lastSeenAt,
    youtubeUrl: c.youtubeUrl || null,
    isLiveNow: liveIds.has(spotterNetworkId),
    mappedChannelId: chaserMap[spotterNetworkId] || null,
    dismissedAsNew: dismissedNew.has(spotterNetworkId)
  }));

  res.json({ total: all.length, chasers: all });
});

// ── Canadian Radar (MSC GeoMet) GetCapabilities proxy ───────────────────────
// The WMS tile images themselves (RADAR_1KM_RRAI) load fine directly from
// the browser via Leaflet's <img>-based tile layer — <img> tags aren't
// subject to CORS. The one call that IS subject to CORS is the
// GetCapabilities XML fetch radar.html uses to discover available frame
// timestamps, since that goes through fetch(), which browsers do enforce
// CORS on. Rather than depend on whether geo.weather.gc.ca happens to send
// permissive CORS headers (unverified, and out of our control either way),
// this proxies that one XML request through our own server — server-to-
// server requests are never subject to CORS, so this removes the
// uncertainty entirely regardless of the answer.
//
// LAYER ID NOTE: the originally-used RADAR_1KM_RDBR does not appear in MSC
// GeoMet's current official documentation and was almost certainly the
// reason nothing rendered. RADAR_1KM_RRAI ("Radar precipitation rate for
// rain [mm/hr]") is the confirmed correct ID per ECCC's own readme:
// https://eccc-msc.github.io/open-data/msc-data/obs_radar/readme_radar_geomet_en/
// GET /api/firebase-config
// Serves the PUBLIC Firebase web app config to the client.
// These values identify the Firebase project but are NOT secret — they are
// safe to expose to browsers (this is how Firebase is designed to work).
// Store these in Railway env vars rather than hardcoding in index.html so
// the source code doesn't need to change if the Firebase project changes.
//
// Required Railway env vars:
//   FIREBASE_WEB_API_KEY         — Firebase Console → Project Settings → Web app → apiKey
//   FIREBASE_MESSAGING_SENDER_ID — Firebase Console → Project Settings → Web app → messagingSenderId
//   FIREBASE_APP_ID              — Firebase Console → Project Settings → Web app → appId
//   FIREBASE_VAPID_KEY           — Firebase Console → Cloud Messaging → Web Push certificates → Key pair
app.get('/api/firebase-config', (req, res) => {
  const apiKey      = process.env.FIREBASE_WEB_API_KEY;
  const senderId    = process.env.FIREBASE_MESSAGING_SENDER_ID;
  const appId       = process.env.FIREBASE_APP_ID;
  const vapidKey    = process.env.FIREBASE_VAPID_KEY;

  // If none of the vars are set, return a signal the client can detect
  if (!apiKey && !senderId && !appId && !vapidKey) {
    return res.json({ configured: false });
  }

  res.set('Cache-Control', 'public, max-age=3600'); // config rarely changes
  res.json({
    configured: true,
    config: {
      apiKey:            apiKey            || '',
      authDomain:        'weather-tv-radar.firebaseapp.com',
      projectId:         'weather-tv-radar',
      storageBucket:     'weather-tv-radar.firebasestorage.app',
      messagingSenderId: senderId          || '',
      appId:             appId             || '',
    },
    vapidKey: vapidKey || '',
  });
});

// GET /api/nhc-storms
// Proxies NHC CurrentStorms.json — nhc.noaa.gov does not send CORS headers so
// browsers (including the WeatherStar iframe) cannot fetch it directly.
// Cached 10 minutes — storm positions update roughly every 3-6 hours.
const _nhcCache = { data: null, ts: 0 };
const NHC_TTL = 10 * 60 * 1000;

app.get('/api/nhc-storms', async (req, res) => {
  if (_nhcCache.data && Date.now() - _nhcCache.ts < NHC_TTL) {
    res.set('Cache-Control', 'public, max-age=600');
    return res.json(_nhcCache.data);
  }
  try {
    const text = await fetchTextOverHttp('https://www.nhc.noaa.gov/CurrentStorms.json');
    const data = JSON.parse(text);
    _nhcCache.data = data;
    _nhcCache.ts = Date.now();
    res.set('Cache-Control', 'public, max-age=600');
    res.json(data);
  } catch(e) {
    console.warn('[NHC] Proxy error:', e.message);
    if (_nhcCache.data) return res.json(_nhcCache.data);
    res.status(502).json({ activeStorms: [], error: 'NHC unavailable' });
  }
});

// GET /api/river-gauges?xmin=&ymin=&xmax=&ymax=
// Proxies NOAA NWPS gauge API — api.water.noaa.gov does not send CORS headers.
// Cached 5 minutes per bbox (gauges update every 15 min).
const _gaugeCache = new Map();
const GAUGE_TTL = 5 * 60 * 1000;

app.get('/api/river-gauges', async (req, res) => {
  const { xmin, ymin, xmax, ymax } = req.query;
  if (!xmin || !ymin || !xmax || !ymax) {
    return res.status(400).json({ error: 'Missing bbox params: xmin, ymin, xmax, ymax' });
  }
  const key = [xmin, ymin, xmax, ymax].map(v => parseFloat(v).toFixed(2)).join(',');
  const cached = _gaugeCache.get(key);
  if (cached && Date.now() - cached.ts < GAUGE_TTL) {
    res.set('Cache-Control', 'public, max-age=300');
    return res.json(cached.data);
  }
  try {
    const url = `https://api.water.noaa.gov/nwps/v1/gauges?` +
      `bbox.xmin=${xmin}&bbox.ymin=${ymin}&bbox.xmax=${xmax}&bbox.ymax=${ymax}` +
      `&srid=EPSG_4326&count=200`;
    const text = await fetchTextOverHttp(url);
    const data = JSON.parse(text);
    _gaugeCache.set(key, { data, ts: Date.now() });
    if (_gaugeCache.size > 50) {
      const oldest = [..._gaugeCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      _gaugeCache.delete(oldest[0]);
    }
    res.set('Cache-Control', 'public, max-age=300');
    res.json(data);
  } catch(e) {
    console.warn('[River Gauges] Proxy error:', e.message);
    const stale = _gaugeCache.get(key);
    if (stale) return res.json(stale.data);
    res.status(502).json({ gauges: [], error: 'NWPS unavailable' });
  }
});

// GET /api/canada-alerts
// Proxies Environment Canada's national weather alert ATOM feed and returns
// structured JSON. EC's ATOM feed gives us event type, headline, province/
// territory, severity, and expiry time. We also fetch GeoMet's WFS features
// for the ALERTS layer to get geographic polygons where available.
// Cached 5 minutes — EC typically updates alerts every 5–15 minutes.
const _caAlertsCache = { data: null, ts: 0 };
const CA_ALERTS_TTL = 5 * 60 * 1000;

const EC_SEVERITY = {
  'warning':  { color: '#ff0000', rank: 3 },
  'watch':    { color: '#ff8c00', rank: 2 },
  'advisory': { color: '#ffff00', rank: 1 },
  'statement':{ color: '#6699cc', rank: 0 },
  'ended':    { color: '#888888', rank: -1 },
};

function parseECAtom(xml) {
  const entries = [];
  const entryBlocks = xml.match(/<entry[\s\S]*?<\/entry>/g) || [];
  entryBlocks.forEach(block => {
    const title    = (block.match(/<title[^>]*>([^<]+)<\/title>/)  || [])[1] || '';
    const summary  = (block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1] || '';
    const updated  = (block.match(/<updated>([^<]+)<\/updated>/)   || [])[1] || '';
    const link     = (block.match(/<link[^>]+href="([^"]+)"/)      || [])[1] || '';
    const category = (block.match(/<category[^>]+term="([^"]+)"/)  || [])[1] || '';
    const id       = (block.match(/<id>([^<]+)<\/id>/)             || [])[1] || '';

    // Parse "Event Type in effect - Location, Province" pattern
    const titleMatch = title.match(/^(.+?)\s+in\s+effect\s*[-–]\s*(.+)$/i);
    const eventType  = titleMatch ? titleMatch[1].trim() : title.trim();
    const location   = titleMatch ? titleMatch[2].trim() : '';

    // Derive severity from event name
    const lower = eventType.toLowerCase();
    let severity = 'statement';
    if (lower.includes('warning') || lower.includes('watch')) {
      severity = lower.includes('warning') ? 'warning' : 'watch';
    } else if (lower.includes('advisory')) {
      severity = 'advisory';
    }
    if (lower.includes('ended') || lower.includes('cancel')) severity = 'ended';

    entries.push({ id, eventType, location, severity, summary: summary.replace(/<[^>]+>/g,'').trim().slice(0,300), updated, link, category });
  });
  // Sort by severity rank (warnings first)
  entries.sort((a,b) => (EC_SEVERITY[b.severity]?.rank||0) - (EC_SEVERITY[a.severity]?.rank||0));
  return entries;
}

app.get('/api/canada-alerts', async (req, res) => {
  if (_caAlertsCache.data && Date.now() - _caAlertsCache.ts < CA_ALERTS_TTL) {
    res.set('Cache-Control', 'public, max-age=300');
    return res.json(_caAlertsCache.data);
  }
  // EC has several URL patterns for their alert feeds — try each until one works
  const EC_ALERT_URLS = [
    'https://weather.gc.ca/rss/battleboard/can_e.xml',
    'https://www.weather.gc.ca/rss/battleboard/can_e.xml',
    'https://weather.gc.ca/en/warnings/rss/can_e.xml',
  ];
  let xml = null;
  for (const feedUrl of EC_ALERT_URLS) {
    try {
      const text = await fetchTextOverHttp(feedUrl);
      if (text.includes('<entry') || text.includes('<item')) { xml = text; break; }
      console.log(`[CA Alerts] ${feedUrl} returned no entries`);
    } catch(e) {
      console.warn(`[CA Alerts] ${feedUrl} failed:`, e.message);
    }
  }
  if (!xml) {
    console.warn('[CA Alerts] All EC feed URLs failed');
    if (_caAlertsCache.data) return res.json(_caAlertsCache.data);
    return res.status(502).json({ error: 'Environment Canada alerts unavailable', alerts: [] });
  }
  try {
    const alerts = parseECAtom(xml);
    console.log(`[CA Alerts] Parsed ${alerts.length} alerts from EC feed`);
    const result = { alerts, generatedAt: Date.now(), source: 'Environment Canada / ECCC' };
    _caAlertsCache.data = result;
    _caAlertsCache.ts = Date.now();
    res.set('Cache-Control', 'public, max-age=300');
    res.json(result);
  } catch(e) {
    console.warn('[CA Alerts] Parse failed:', e.message);
    if (_caAlertsCache.data) return res.json(_caAlertsCache.data);
    res.status(502).json({ error: 'Environment Canada alerts unavailable', alerts: [] });
  }
});

app.get('/api/canada-radar/capabilities', async (req, res) => {
  const layer = (req.query.layer || 'RADAR_1KM_RRAI').replace(/[^A-Z0-9_]/gi, ''); // basic allowlist sanitization
  const url = `https://geo.weather.gc.ca/geomet?service=WMS&version=1.3.0&request=GetCapabilities&layer=${layer}&t=${Date.now()}`;
  try {
    const xml = await fetchTextOverHttp(url);
    res.set('Content-Type', 'application/xml');
    res.set('Cache-Control', 'public, max-age=120'); // capabilities don't change every second
    res.send(xml);
  } catch (e) {
    console.warn('[CanadaRadar] GetCapabilities proxy failed:', e.message);
    res.status(502).json({ error: 'Could not reach geo.weather.gc.ca' });
  }
});

// ── TRAFFIC CAMERAS ─────────────────────────────────────────────────────────
// Merges two sources into one normalised feed:
//   1. OpenTrafficCamMap (OTC) — MIT-licensed static JSON on GitHub,
//      ~7,500 US cameras, no API key required. Fetched once and cached for
//      60 min since it's a static file that rarely changes.
//   2. Road511 — normalised 511 feed, 10,000+ cameras, requires API key
//      (ROAD511_API_KEY env var). Queried per bounding-box viewport so
//      we only pull what's visible. Cached 3 min per viewport cell.
//
// The client sees ONE endpoint, ONE schema. Source attribution is invisible
// to users. Road511 data is preferred when both sources have a camera at
// the same physical location (deduplicated within 100m).
//
// CORS handling: DOT camera image URLs almost universally block direct
// browser requests. We don't proxy the images themselves (that would
// massively increase bandwidth costs) — instead, the client fetches
// images via /api/camera-image?url=... which pipes them back with the
// right CORS headers. Cached 25s so a 30-second refresh cycle stays fresh.

const OTC_JSON_URL = 'https://raw.githubusercontent.com/AidanWelch/OpenTrafficCamMap/master/cameras/USA.json';
let _otcCache = null;       // parsed flat array of cameras
let _otcCacheTime = 0;
const OTC_TTL = 60 * 60 * 1000; // 60 min — static file, rarely changes

// Road511 viewport cache: key = `${bbox}` -> { cameras, ts }
const _road511Cache = new Map();
const ROAD511_TTL = 3 * 60 * 1000; // 3 min

// Image proxy cache: key = url -> { buf, ct, ts }
const _imgCache = new Map();
const IMG_TTL = 25 * 1000; // 25s — keeps refresh cycle fresh

// ── STATE DOT CAMERA SOURCES ─────────────────────────────────────────────────
// The IBI Group / Skyline 511 platform is used by the majority of US state
// DOTs. Every state on this platform uses the IDENTICAL JSON schema:
//   GET /api/v2/get/cameras?key={key}&format=json
//   → [ { Id, Latitude, Longitude, Location, Roadway, Direction,
//          Views: [{ Id, Url, VideoUrl, Status }] } ]
//
// Adding a new state DOT is a single entry in STATE_DOTS — no new parse
// logic, no new edge cases, no code changes beyond this array. The generic
// _loadStateDOT() loader handles fetch, cache, parse, and error handling
// uniformly for every entry.
//
// To add a state:
//   1. Sign up for a developer key at their 511 portal (or confirm it's public)
//   2. Add { id, label, url, envKey, cacheTTL } below
//   3. Add the env var to Railway — that's it
//
// envKey: Railway env var name that holds the API key.
//         Set to null for public endpoints that need no key.
//
// CONFIRMED ON SAME PLATFORM (can add immediately once you have a key):
//   Arizona:   https://az511.com/api/v2/get/cameras   (AZDOT_511_KEY)
//   Georgia:   https://511ga.org/api/v2/get/cameras   (GA_511_KEY)
//   Louisiana: https://511la.org/api/v2/get/cameras   (LA_511_KEY)
//   (any other state 511 site running the IBI/Skyline platform)

const STATE_DOTS = [
  // ── IBI Group / Skyline 511 platform ────────────────────────────────────
  // All these states use the IDENTICAL API schema. Adding any new state on
  // this platform: copy an entry, update id/label/url/envKey, done.
  // Env var convention: {STATE}_511_KEY  (e.g. WI_511_KEY, GA_511_KEY)
  {
    id: 'wi',
    label: 'Wisconsin DOT',
    url: 'https://511wi.gov/api/v2/get/cameras?format=json',
    envKey: 'WI_511_KEY',
    cacheTTL: 10 * 60 * 1000,
    parse: _parseIBI511,
  },
  {
    id: 'ny',
    label: 'New York DOT',
    url: 'https://511ny.org/api/v2/get/cameras?format=json',
    envKey: 'NY_511_KEY',
    cacheTTL: 10 * 60 * 1000,
    parse: _parseIBI511,
  },
  {
    id: 'ga',
    label: 'Georgia DOT',
    url: 'https://511ga.org/api/v2/get/cameras?format=json',
    envKey: 'GA_511_KEY',
    cacheTTL: 10 * 60 * 1000,
    parse: _parseIBI511,
  },
  {
    id: 'la',
    label: 'Louisiana DOTD',
    url: 'https://www.511la.org/api/v2/get/cameras?format=json',
    envKey: 'LA_511_KEY',
    cacheTTL: 10 * 60 * 1000,
    parse: _parseIBI511,
  },
  {
    id: 'az',
    label: 'Arizona DOT',
    url: 'https://az511.com/api/v2/get/cameras?format=json',
    envKey: 'AZ_511_KEY',
    cacheTTL: 10 * 60 * 1000,
    parse: _parseIBI511,
  },

  // ── North Carolina ───────────────────────────────────────────────────────
  // DriveNC (drivenc.gov) — confirmed IBI/Skyline platform, same schema.
  // Env var: NC_511_KEY (key obtained via drivenc.gov developer portal)
  {
    id: 'nc',
    label: 'North Carolina DOT',
    url: 'https://www.drivenc.gov/api/v2/get/cameras?format=json',
    envKey: 'NC_511_KEY',
    cacheTTL: 10 * 60 * 1000,
    parse: _parseIBI511,
  },

  // ── Pennsylvania ─────────────────────────────────────────────────────────
  // PA uses ASP.NET map layer markers per Road511's article — non-standard
  // format, needs investigation before building a parser.
  // { id:'pa', label:'Pennsylvania DOT', url:'CONFIRM_URL',
  //   envKey:'PA_511_KEY', cacheTTL:10*60*1000, parse:_parsePADOT },

  // ── Additional IBI/Skyline states (same _parseIBI511, just needs a key) ─
  { id:'id', label:'Idaho DOT',   url:'https://511.idaho.gov/api/v2/get/cameras?format=json',     envKey:'ID_511_KEY', cacheTTL:10*60*1000, parse:_parseIBI511 },
  { id:'nv', label:'Nevada DOT',  url:'https://www.nvroads.com/api/v2/get/cameras?format=json',    envKey:'NV_511_KEY', cacheTTL:10*60*1000, parse:_parseIBI511 },
  { id:'ut', label:'Utah DOT',    url:'https://prod-ut.ibi511.com/api/v2/get/cameras?format=json', envKey:'UT_511_KEY', cacheTTL:10*60*1000, parse:_parseIBI511 },

  // ── Florida ──────────────────────────────────────────────────────────────
  // FL511 (fl511.com) runs on FDOT's proprietary SunGuide ATMS platform,
  // built entirely in-house. There is NO public developer API — no endpoint
  // docs, no key signup, no documented REST interface. The camera images
  // are publicly viewable on fl511.com but the data comes from internal
  // SunGuide feeds that aren't exposed externally. Would require
  // reverse-engineering the FL511 web app's network requests, which is
  // fragile, against their ToS, and not worth maintaining.
  // Florida is one of the few states Road511 had to handle with custom
  // scraping rather than an official API — if we ever want FL coverage,
  // Road511 Starter ($29/mo) is the realistic path.

  // ── Minnesota DOT ────────────────────────────────────────────────────────
  // Public endpoint, no key required. Different platform from IBI/Skyline.
  // Schema verified defensively — see _parseMnDOT below.
  {
    id: 'mn',
    label: 'Minnesota DOT',
    url: 'https://tr.511mn.org/tgcameras/api/cameras',
    envKey: null,
    cacheTTL: 10 * 60 * 1000,
    parse: _parseMnDOT,
  },

  // ── Illinois DOT (Gateway system) ────────────────────────────────────────
  // Illinois uses IDOT's ArcGIS Hub (public open data portal) for the
  // Gateway camera dataset. gis-idot.opendata.arcgis.com is IDOT's PUBLIC
  // data sharing site — NOT the same system as gis1.dot.illinois.gov
  // (their private internal ArcGIS Server for infrastructure/permits).
  //
  // The IL_ARCGIS_KEY obtained from gis1.dot.illinois.gov almost certainly
  // does NOT authenticate against the public Hub — but the Hub dataset is
  // likely publicly accessible without any key at all, since that's the
  // whole point of an open data portal. Setting envKey to null so this
  // always loads without requiring a key.
  //
  // If the public endpoint starts returning 401/403, revisit whether IDOT
  // has added auth to this specific dataset — at that point contact
  // travelmidwest.com directly for data feed credentials (which Road511's
  // article identified as the real upstream for IL camera images).
  {
    id: 'il',
    label: 'Illinois DOT (Gateway)',
    url: 'https://gis-idot.opendata.arcgis.com/datasets/IDOT::illinois-gateway-traffic-cameras/FeatureServer/0/query?where=1%3D1&outFields=*&f=json',
    envKey: null,                  // public open data Hub — no key required
    cacheTTL: 10 * 60 * 1000,
    parse: _parseILGateway,
  },

  // ── Ohio DOT (OHGO) ──────────────────────────────────────────────────────
  // OHGO Public API — publicapi.ohgo.com. Different schema from IBI/Skyline.
  // Auth: api-key query param. Each camera site has a CameraViews array with
  // SmallUrl/LargeUrl/Direction. Images update every 5 seconds — genuinely live.
  {
    id: 'oh',
    label: 'Ohio DOT (OHGO)',
    url: 'https://publicapi.ohgo.com/api/v1/cameras',
    envKey: 'OH_DOT_KEY',
    authParam: 'api-key',
    cacheTTL: 10 * 60 * 1000,
    parse: _parseOHGO,
  },

  // ── To add more states ───────────────────────────────────────────────────
  // IBI/Skyline platform (most US state 511 sites):
  //   { id:'xx', label:'State DOT', url:'https://511xx.gov/api/v2/get/cameras?format=json',
  //     envKey:'XX_511_KEY', cacheTTL: 10*60*1000, parse: _parseIBI511 }
  //
  // Other platforms: write a new parse function following the same pattern
  // as _parseILGateway, then use it here.
];

// ── Ohio DOT (OHGO) parser ────────────────────────────────────────────────
// OHGO returns { results: [ { Id, Latitude, Longitude, Location, Description,
//   CameraViews: [ { Direction, SmallUrl, LargeUrl, MainRoute } ] } ] }
// One camera site may have multiple views (directions). We emit one camera
// object per view so each appears as an independent dot on the map.
function _parseOHGO(raw) {
  const cameras = [];
  const results = Array.isArray(raw) ? raw : (raw.results || raw.data || []);
  results.forEach(site => {
    const lat = parseFloat(site.Latitude);
    const lng = parseFloat(site.Longitude);
    if (!isFinite(lat) || !isFinite(lng)) return;
    const views = Array.isArray(site.CameraViews) ? site.CameraViews : [];
    if (views.length === 0) return;
    views.forEach((view, i) => {
      const imageUrl = view.LargeUrl || view.SmallUrl;
      if (!imageUrl) return;
      cameras.push({
        id:        `ohgo-${site.Id}-${i}`,
        name:      site.Location || site.Description || 'Ohio Camera',
        lat, lng,
        imageUrl,
        videoUrl:  null,
        playerUrl: null,
        direction: view.Direction || null,
        source:    'dot',
        state:     'OH',
      });
    });
  });
  return cameras;
}

// Cache for state DOT data: id -> { cameras, ts }
const _stateDOTCache = new Map();

// Standard IBI Group / Skyline 511 platform parser.
// Used by WI and confirmed identical on AZ, GA, LA, and most US state DOTs.
function _parseIBI511(raw, sourceId, dot) {
  if (!Array.isArray(raw)) return [];
  let baseUrl = '';
  try { if (dot?.url) baseUrl = new URL(dot.url).origin; } catch(_) {}
  const cameras = [];
  for (const cam of raw) {
    const lat = parseFloat(cam.Latitude), lng = parseFloat(cam.Longitude);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    const views = Array.isArray(cam.Views) ? cam.Views : [];
    const view = views.find(v => v.Status === 'Enabled') || views[0];
    if (!view) continue;
    // Skip cameras where ALL views are disabled — their images redirect to /notfound
    if (view.Status === 'Disabled' && !views.some(v => v.Status === 'Enabled')) continue;
    const videoUrl = view.VideoUrl || null;
    const key = (dot?.envKey && process.env[dot.envKey]) ? process.env[dot.envKey] : null;
    const imageUrl = view.ImageUrl
      || (baseUrl && view.Id
        ? `${baseUrl}/Cctv/GetCctvImage?viewId=${view.Id}${key ? '&key=' + encodeURIComponent(key) : ''}`
        : null);
    cameras.push({
      id: `${sourceId}-${cam.Id}`,
      name: cam.Location || cam.Roadway || 'Traffic Camera',
      lat, lng,
      imageUrl,
      videoUrl,
      direction: (cam.Direction && cam.Direction !== 'Unknown') ? cam.Direction : null,
      source: sourceId,
    });
  }
  return cameras;
}

// Minnesota DOT parser (tr.511mn.org/tgcameras/api/cameras).
// Schema unverified from official docs — written defensively to handle
// whatever actually comes back. Will log the raw schema on first load so
// we can refine this if the field names differ from the IBI standard.
function _parseMnDOT(raw, sourceId) {
  if (!Array.isArray(raw)) {
    // Some MN endpoints wrap the array in a container object
    if (raw && Array.isArray(raw.cameras)) raw = raw.cameras;
    else if (raw && Array.isArray(raw.features)) {
      // GeoJSON FeatureCollection fallback
      return raw.features.map((f, i) => {
        const p = f.properties || {};
        const coords = f.geometry && f.geometry.coordinates;
        if (!coords) return null;
        return {
          id: `${sourceId}-${p.id || p.ID || i}`,
          name: p.location || p.name || p.roadway || 'MN Traffic Camera',
          lat: coords[1], lng: coords[0],
          imageUrl: p.imageUrl || p.image_url || null,
          videoUrl: p.videoUrl || p.video_url || null,
          direction: p.direction || null,
          source: sourceId,
        };
      }).filter(Boolean);
    }
    else { console.warn('[Cameras] MN DOT: unexpected schema', typeof raw); return []; }
  }
  // Log first entry on first load so we can see the real field names
  if (raw.length > 0 && !_stateDOTCache.has('mn')) {
    console.log('[Cameras] MN DOT first entry schema:', JSON.stringify(raw[0], null, 2).slice(0, 500));
  }
  return raw.map((cam, i) => {
    // Try the IBI field names first, then common MN-specific variants
    const lat = parseFloat(cam.Latitude ?? cam.latitude ?? cam.lat ?? cam.Y ?? cam.y);
    const lng = parseFloat(cam.Longitude ?? cam.longitude ?? cam.lng ?? cam.X ?? cam.x);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    const views = cam.Views || cam.views || [];
    const view = (Array.isArray(views) ? views : []).find(v => (v.Status || v.status) === 'Enabled') || views[0];
    const videoUrl = (view && (view.VideoUrl || view.videoUrl)) || cam.videoUrl || cam.VideoUrl || null;
    const imageUrl = (view && (view.ImageUrl || view.imageUrl)) || cam.imageUrl || cam.url || null;
    const name = cam.Location || cam.location || cam.name || cam.description || cam.Roadway || cam.roadway || 'MN Traffic Camera';
    return {
      id: `${sourceId}-${cam.Id || cam.id || cam.cameraId || i}`,
      name, lat, lng, imageUrl, videoUrl,
      direction: cam.Direction || cam.direction || null,
      source: sourceId,
    };
  }).filter(Boolean);
}

// Illinois Gateway system parser.
// ArcGIS FeatureServer response; field names: y (lat), x (lng),
// CameraLocation, CameraDirection, SnapShot (direct image URL).
// The ArcGIS token goes in the query string as `token=`.
function _parseILGateway(raw, sourceId) {
  // ArcGIS query responses wrap features in { features: [{ attributes, geometry }] }
  const features = raw.features || [];
  return features.map((f, i) => {
    const a = f.attributes || {};
    // Geometry coordinates come in the feature's geometry block if outSR=4326,
    // but we also have explicit lat/lng attributes from this layer.
    const lat = parseFloat(a.y ?? (f.geometry && f.geometry.y));
    const lng = parseFloat(a.x ?? (f.geometry && f.geometry.x));
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return {
      id: `${sourceId}-${a.OBJECTID || a.FID || i}`,
      name: a.CameraLocation || a.ImgPath || 'IL Traffic Camera',
      lat, lng,
      imageUrl: a.SnapShot || null,   // direct JPEG URL, suitable for <img>
      videoUrl: null,                  // Gateway is image-only, no HLS streams
      direction: a.CameraDirection !== 'NONE' ? a.CameraDirection : null,
      source: sourceId,
    };
  }).filter(Boolean);
}

async function _loadStateDOT(dot) {
  const cached = _stateDOTCache.get(dot.id);
  if (cached && Date.now() - cached.ts < dot.cacheTTL) return cached.cameras;

  // Skip if this DOT requires a key and it's not configured
  if (dot.envKey && !process.env[dot.envKey]) return [];

  let url = dot.url;
  if (dot.envKey && process.env[dot.envKey]) {
    // 511 IBI/Skyline platforms use `key=`, ArcGIS services use `token=`.
    // Each DOT config can specify authParam to override; default is 'key'.
    const paramName = dot.authParam || 'key';
    url += (url.includes('?') ? '&' : '?') + `${paramName}=${encodeURIComponent(process.env[dot.envKey])}`;
  }

  let cameras = [];
  try {
    const text = await fetchTextOverHttp(url);
    const raw = JSON.parse(text);
    cameras = dot.parse(raw, dot.id, dot);
    console.log(`[Cameras] ${dot.label}: ${cameras.length} cameras loaded`);
  } catch (e) {
    console.warn(`[Cameras] ${dot.label} failed:`, e.message);
  }

  _stateDOTCache.set(dot.id, { cameras, ts: Date.now() });
  return cameras;
}

function _haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Full-name → 2-letter code map for OTC state keys
const OTC_STATE_CODES = {
  'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA',
  'Colorado':'CO','Connecticut':'CT','Delaware':'DE','Florida':'FL','Georgia':'GA',
  'Hawaii':'HI','Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA',
  'Kansas':'KS','Kentucky':'KY','Louisiana':'LA','Maine':'ME','Maryland':'MD',
  'Massachusetts':'MA','Michigan':'MI','Minnesota':'MN','Mississippi':'MS',
  'Missouri':'MO','Montana':'MT','Nebraska':'NE','Nevada':'NV','New Hampshire':'NH',
  'New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC',
  'North Dakota':'ND','Ohio':'OH','Oklahoma':'OK','Oregon':'OR','Pennsylvania':'PA',
  'Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD','Tennessee':'TN',
  'Texas':'TX','Utah':'UT','Vermont':'VT','Virginia':'VA','Washington':'WA',
  'West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY',
};

async function _loadOTC() {
  if (_otcCache && Date.now() - _otcCacheTime < OTC_TTL) return _otcCache;
  console.log('[Cameras] Fetching OpenTrafficCamMap USA.json…');
  const text = await fetchTextOverHttp(OTC_JSON_URL);
  const raw = JSON.parse(text);
  const cameras = [];

  // OTC has two known schemas:
  // v1/old master: { "Wisconsin": { "county": [{latitude, longitude, url, ...}] } }
  // new master: may be a flat array or restructured — handle gracefully
  const addCam = (cam, stateCode) => {
    // Support both old field names (latitude/longitude) and new (lat/lng or location.*)
    const lat = parseFloat(cam.latitude ?? cam.lat ?? cam.location?.latitude);
    const lng = parseFloat(cam.longitude ?? cam.lng ?? cam.location?.longitude);
    const url = cam.url ?? cam.imageUrl ?? cam.image_url ?? null;
    if (!isFinite(lat) || !isFinite(lng)) return;
    if (Math.abs(lat) < 1 && Math.abs(lng) < 1) return;
    if (!url) return; // skip cameras with no feed URL
    const isHLS = (cam.format ?? '').toUpperCase().includes('M3U');
    cameras.push({
      id: 'otc-' + cameras.length,
      name: cam.description ?? cam.name ?? cam.title ?? 'Traffic Camera',
      lat, lng,
      imageUrl: isHLS ? null : url,
      videoUrl: isHLS ? url : null,
      direction: cam.direction ?? null,
      source: 'otc',
      state: stateCode,
    });
  };

  if (Array.isArray(raw)) {
    // Flat array schema
    raw.forEach(cam => addCam(cam, OTC_STATE_CODES[cam.state] || cam.state || null));
  } else if (typeof raw === 'object') {
    // Nested state→county schema (original format)
    for (const [stateName, counties] of Object.entries(raw)) {
      const stateCode = OTC_STATE_CODES[stateName] || null;
      if (Array.isArray(counties)) {
        counties.forEach(cam => addCam(cam, stateCode));
      } else if (typeof counties === 'object') {
        for (const countyArr of Object.values(counties)) {
          if (Array.isArray(countyArr)) countyArr.forEach(cam => addCam(cam, stateCode));
        }
      }
    }
  }
  _otcCache = cameras;
  _otcCacheTime = Date.now();
  console.log(`[Cameras] OTC loaded: ${cameras.length} cameras`);
  return cameras;
}

async function _loadRoad511(bbox) {
  const key = bbox;
  const cached = _road511Cache.get(key);
  if (cached && Date.now() - cached.ts < ROAD511_TTL) return cached.cameras;

  const apiKey = process.env.ROAD511_API_KEY;
  if (!apiKey) return [];

  const url = `https://api.road511.com/api/v1/features/geojson?type=cameras&bbox=${encodeURIComponent(bbox)}&limit=500`;
  let cameras = [];
  try {
    const text = await fetchTextOverHttp(url, { 'X-API-Key': apiKey });
    const gj = JSON.parse(text);
    cameras = (gj.features || []).map(f => {
      const p = f.properties || {};
      return {
        id: 'r511-' + (p.id || ''),
        name: p.name || 'Traffic Camera',
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0],
        imageUrl: p.image_url || null,
        videoUrl: p.video_url || null,
        direction: p.direction || null,
        source: 'road511',
      };
    }).filter(c => isFinite(c.lat) && isFinite(c.lng));
  } catch (e) {
    console.warn('[Cameras] Road511 fetch failed:', e.message);
  }
  _road511Cache.set(key, { cameras, ts: Date.now() });
  return cameras;
}


// ── Windy Webcams Integration ─────────────────────────────────────────────────
// Approximate bounding boxes [N, W, S, E] for all 50 states + DC.
// Used to query Windy's bounding-box API when a user selects a state.
const STATE_BBOX = {
  AL:[35.0,-88.5,30.1,-84.8], AK:[71.5,-168.0,54.5,-130.0],
  AZ:[37.0,-114.8,31.3,-109.0], AR:[36.5,-94.6,33.0,-89.6],
  CA:[42.0,-124.5,32.5,-114.1], CO:[41.0,-109.1,36.9,-102.0],
  CT:[42.1,-73.7,40.9,-71.8],  DE:[39.8,-75.8,38.4,-75.0],
  FL:[31.0,-87.6,24.4,-80.0],  GA:[35.0,-85.6,30.4,-80.8],
  HI:[22.2,-160.2,18.9,-154.8],ID:[49.0,-117.2,41.9,-111.0],
  IL:[42.5,-91.5,36.9,-87.0],  IN:[41.8,-88.1,37.8,-84.7],
  IA:[43.5,-96.6,40.4,-90.1],  KS:[40.0,-102.1,36.9,-94.6],
  KY:[39.1,-89.6,36.5,-81.9],  LA:[33.0,-94.0,28.9,-88.8],
  ME:[47.5,-71.1,43.0,-66.9],  MD:[39.7,-79.5,37.9,-75.0],
  MA:[42.9,-73.5,41.2,-69.9],  MI:[48.3,-90.4,41.7,-82.4],
  MN:[49.4,-97.2,43.5,-89.5],  MS:[35.0,-91.7,30.2,-88.1],
  MO:[40.6,-95.8,35.9,-89.1],  MT:[49.0,-116.0,44.4,-104.0],
  NE:[43.0,-104.1,40.0,-95.3], NV:[42.0,-120.0,35.0,-114.0],
  NH:[45.3,-72.6,42.7,-70.6],  NJ:[41.4,-75.6,38.9,-73.9],
  NM:[37.0,-109.1,31.3,-103.0],NY:[45.0,-79.8,40.5,-71.9],
  NC:[36.6,-84.3,33.8,-75.5],  ND:[49.0,-104.1,45.9,-96.6],
  OH:[42.3,-84.8,38.4,-80.5],  OK:[37.0,-103.0,33.6,-94.4],
  OR:[46.3,-124.6,41.9,-116.5],PA:[42.3,-80.5,39.7,-74.7],
  RI:[42.0,-71.9,41.1,-71.1],  SC:[35.2,-83.4,32.0,-78.5],
  SD:[45.9,-104.1,42.5,-96.4], TN:[36.7,-90.3,34.9,-81.6],
  TX:[36.5,-106.6,25.8,-93.5], UT:[42.0,-114.1,36.9,-109.0],
  VT:[45.0,-73.4,42.7,-71.5],  VA:[39.5,-83.7,36.5,-75.2],
  WA:[49.0,-124.7,45.5,-116.9],WV:[40.6,-82.6,37.2,-77.7],
  WI:[47.1,-92.9,42.5,-86.8],  WY:[45.0,-111.1,40.9,-104.0],
  DC:[39.0,-77.1,38.8,-77.0],
};

const _windyCache = new Map();
const WINDY_TTL = 12 * 60 * 1000; // 12 min — images expire at 15 min

async function _loadWindy(stateCode) {
  const key = process.env.WINDY_WEBCAM_KEY;
  if (!key) { console.log('[Cameras] Windy skipped — WINDY_WEBCAM_KEY not set'); return []; }

  const cached = _windyCache.get(stateCode);
  if (cached && Date.now() - cached.ts < WINDY_TTL) {
    console.log(`[Cameras] Windy ${stateCode}: serving ${cached.cameras.length} from cache`);
    return cached.cameras;
  }
  console.log(`[Cameras] Windy ${stateCode}: fetching fresh data...`);

  const bbox = STATE_BBOX[stateCode];
  if (!bbox) return [];
  const [N, W, S, E] = bbox;

  // Windy V3 uses nearby={lat},{lon},{radius_km} — NOT boundingBox.
  // Calculate center point and radius from the state's bounding box.
  const centerLat = (N + S) / 2;
  const centerLng = (W + E) / 2;
  // Distance from center to corner in km (approximate)
  const latKm = Math.abs(N - S) * 111;
  const lngKm = Math.abs(E - W) * 111 * Math.cos(centerLat * Math.PI / 180);
  const radiusKm = Math.min(250, Math.ceil(Math.sqrt((latKm/2)**2 + (lngKm/2)**2))); // Windy max = 250km

  // Fetch multiple pages to get good coverage — free tier allows up to
  // offset 1000, so up to 4 pages of 50 gives 200 cameras per state.
  const allCameras = [];
  const pages = 4;
  for (let page = 0; page < pages; page++) {
    const url = `https://api.windy.com/webcams/api/v3/webcams`
      + `?nearby=${centerLat.toFixed(4)},${centerLng.toFixed(4)},${radiusKm}`
      + `&include=location,images,player`
      + `&limit=50&offset=${page * 50}`;
    try {
      const text = await fetchTextOverHttp(url, { 'x-windy-api-key': key });
      // Diagnostic: log first 200 chars so Railway logs show auth/format issues
      if (page === 0) console.log(`[Cameras] Windy ${stateCode} raw:`, text.slice(0, 200));
      const data = JSON.parse(text);
      const batch = data.webcams || data.data || []; // V3 returns {data:[...]}, V2 {webcams:[...]}
      if (!batch.length) break; // no more results

      batch.forEach(w => {
        const lat = w.location?.latitude, lng = w.location?.longitude;
        if (!isFinite(lat) || !isFinite(lng)) return;
        // Filter to state bounding box so we don't spill into neighbours
        if (lat < S || lat > N || lng < W || lng > E) return;
        allCameras.push({
          id:        'windy-' + w.webcamId,
          name:      w.title || 'Webcam',
          lat, lng,
          imageUrl:  w.images?.current?.preview || w.image?.current?.preview || null,
          videoUrl:  null,
          // Always construct from webcamId — API's player.day.embed returns
          // a broken V2 /we_player/ URL that 404s. The V3 embed URL works reliably.
          playerUrl: w.webcamId
                     ? `https://webcams.windy.com/webcams/public/embed/player/${w.webcamId}`
                     : null,
          windyId:   w.webcamId,
          direction: null,
          source:    'windy',
          state:     stateCode,
        });
      });
      if (batch.length < 50) break; // last page
    } catch(e) {
      console.warn(`[Cameras] Windy ${stateCode} page ${page} failed:`, e.message);
      break;
    }
  }

  _windyCache.set(stateCode, { cameras: allCameras, ts: Date.now() });
  console.log(`[Cameras] Windy ${stateCode}: ${allCameras.length} webcams`);
  return allCameras;
}

// GET /api/cameras/coverage
// Returns which state codes have camera data available (used by the client
// to build the state dropdown and mark states as covered vs. unavailable).
// STATE_DOTS states are included if their key is configured (or no key required).
// OTC states are always included since the file is always loaded.
app.get('/api/cameras/coverage', async (req, res) => {
  const covered = new Set();

  // OTC states (always available once the file loads)
  Object.keys(OTC_STATE_CODES).forEach(name => {
    // We'll only mark a state as covered if OTC actually has cameras there
  });
  // Fetch OTC to know which states have entries
  try {
    const otc = await _loadOTC();
    otc.forEach(c => { if (c.state) covered.add(c.state); });
  } catch (e) { /* OTC unavailable, skip */ }

  // STATE_DOTS states: covered if key is configured (or envKey is null = public)
  STATE_DOTS.forEach(dot => {
    if (!dot.envKey || process.env[dot.envKey]) covered.add(dot.id.toUpperCase());
  });

  res.set('Cache-Control', 'public, max-age=300'); // 5 min — coverage rarely changes
  // If Windy key is configured, all 50 states have webcam coverage
  // (Windy is global — every state has at least some cameras indexed)
  if (process.env.WINDY_WEBCAM_KEY) {
    Object.keys(STATE_BBOX).forEach(s => covered.add(s));
  }

  res.json({ covered: [...covered].sort() });
});

// GET /api/cameras/state/:code
// Returns all cameras for a specific US state code (e.g. WI, CA, MN).
// Replaces the old bbox-based endpoint — state-level loading is far more
// performant than loading thousands of cameras across the whole country
// and filtering by viewport on every pan/zoom. Users select the state they
// want to monitor (typically where a storm is active) and see only those
// cameras, which loads fast and doesn't lock up the map.
app.get('/api/cameras/state/:code', async (req, res) => {
  const code = req.params.code.toUpperCase().replace(/[^A-Z]/g, '');
  if (code.length !== 2) return res.status(400).json({ error: 'Invalid state code' });

  try {
    // Find the STATE_DOTS entry for this state, if we have one
    const dot = STATE_DOTS.find(d => d.id.toUpperCase() === code);

    const [otcAll, stateDOT, windyCams] = await Promise.all([
      _loadOTC().catch(() => []),
      dot ? _loadStateDOT(dot).catch(() => []) : Promise.resolve([]),
      _loadWindy(code).catch(() => []),
    ]);

    // Filter OTC to this state
    const otcForState = otcAll.filter(c => c.state === code);

    // Merge priority: STATE_DOTS (traffic) → OTC → Windy (scenic/weather).
    // Deduplicate at 100m so we don't show two cameras from different sources
    // that are essentially at the same location.
    const merged = [...stateDOT];
    for (const cam of [...otcForState, ...windyCams]) {
      const tooClose = merged.some(r => _haversineM(cam.lat, cam.lng, r.lat, r.lng) < 100);
      if (!tooClose) merged.push(cam);
    }

    if (merged.length === 0) {
      return res.json({ cameras: [], total: 0, covered: false,
        message: `No camera feeds available for ${code} yet.` });
    }

    const sourceCounts = {};
    merged.forEach(c => { sourceCounts[c.source] = (sourceCounts[c.source] || 0) + 1; });

    res.set('Cache-Control', 'no-store');
    res.json({ cameras: merged, total: merged.length, covered: true, sources: sourceCounts });
  } catch (e) {
    console.error(`[Cameras] State ${code} failed:`, e.message);
    res.status(500).json({ error: 'Camera data unavailable' });
  }
});

// GET /api/aqi?lat=&lng=
// Server-side proxy for AirNow API — keeps AIRNOW_KEY out of client JS.
// Returns current AQI observations within 250 miles of the given lat/lng.
// Cached 30 minutes (AirNow data updates hourly; 30min balances freshness
// vs quota). Set AIRNOW_KEY in Railway environment variables.
const _aqiCache = new Map();
const AQI_TTL = 30 * 60 * 1000;

app.get('/api/aqi', async (req, res) => {
  const key = process.env.AIRNOW_KEY;
  if (!key) return res.status(503).json({ error: 'AirNow API key not configured' });

  // Accept bounding box (preferred — covers the visible map area) or lat/lng fallback
  const hasBbox = req.query.south && req.query.west && req.query.north && req.query.east;
  const south = parseFloat(req.query.south), west  = parseFloat(req.query.west);
  const north = parseFloat(req.query.north), east  = parseFloat(req.query.east);
  const lat   = parseFloat(req.query.lat),   lng   = parseFloat(req.query.lng);

  if (hasBbox && [south,west,north,east].some(isNaN)) return res.status(400).json({ error: 'invalid bbox' });
  if (!hasBbox && (isNaN(lat) || isNaN(lng))) return res.status(400).json({ error: 'lat/lng or bbox required' });

  const cacheKey = hasBbox
    ? `bbox:${south.toFixed(1)},${west.toFixed(1)},${north.toFixed(1)},${east.toFixed(1)}`
    : `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const cached = _aqiCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < AQI_TTL) {
    res.set('Cache-Control', 'public, max-age=1800');
    return res.json(cached.data);
  }

  try {
    // Bounding box endpoint returns all stations within the viewport — much better for national view
    const url = hasBbox
      ? `https://www.airnowapi.org/aq/data/?parameters=PM25,OZONE&BBOX=${west.toFixed(4)},${south.toFixed(4)},${east.toFixed(4)},${north.toFixed(4)}&dataType=A&format=application/json&verbose=1&monitorType=0&includerawconcentrations=0&API_KEY=${key}`
      : `https://www.airnowapi.org/aq/observation/latLong/current/?format=application/json&latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&distance=250&API_KEY=${key}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'WeatherTV/1.0 (+https://watchweathertv.com)' } });
    if (!response.ok) throw new Error(`AirNow returned ${response.status}`);
    const data = await response.json();
    _aqiCache.set(cacheKey, { data, ts: Date.now() });
    if (_aqiCache.size > 50) {
      const oldest = [..._aqiCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) _aqiCache.delete(oldest[0]);
    }
    res.set('Cache-Control', 'public, max-age=1800');
    res.json(data);
  } catch(e) {
    console.error('[AQI] Proxy error:', e.message);
    res.status(502).json({ error: 'AirNow unavailable', detail: e.message });
  }
});

// GET /api/forecast?lat=&lon=  (or ?zip=)
// Unified forecast proxy — merges Open-Meteo (GFS/HRRR) + NWS narrative text.
// Open-Meteo: current conditions, 168h hourly, 7-day daily — free, no key.
// NWS: plain-English forecast narrative for each period — US only, free.
// Cached 15 minutes server-side. Zip-to-coords via Open-Meteo geocoding.
const _forecastCache = new Map();
const FORECAST_TTL = 15 * 60 * 1000;

app.get('/api/forecast', async (req, res) => {
  console.log(`[Forecast] Request: zip=${req.query.zip} lat=${req.query.lat} lon=${req.query.lon}`);
  let lat = parseFloat(req.query.lat);
  let lon = parseFloat(req.query.lon);
  let locationName = req.query.name || null;

  // Zip-to-coords via Open-Meteo geocoding (free, no key)
  if (req.query.zip) {
    try {
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(req.query.zip.trim())}&count=1&language=en&format=json`;
      const geoText = await fetchTextOverHttp(geoUrl);
      const geo = JSON.parse(geoText);
      const r = geo.results?.[0];
      if (!r) return res.status(404).json({ error: `No location found for "${req.query.zip}"` });
      lat = r.latitude; lon = r.longitude;
      locationName = locationName || [r.name, r.admin1].filter(Boolean).join(', ');
    } catch(e) {
      return res.status(502).json({ error: 'Geocoding unavailable', detail: e.message });
    }
  }

  if (isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ error: 'lat/lon or zip required' });
  }

  const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = _forecastCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < FORECAST_TTL) {
    res.set('Cache-Control', 'public, max-age=900');
    return res.json(cached.data);
  }

  try {
    // ── Open-Meteo GFS/HRRR ─────────────────────────────────────────────────
    const omUrl = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
      + '&timezone=auto'
      + '&temperature_unit=fahrenheit'
      + '&wind_speed_unit=mph'
      + '&precipitation_unit=inch'
      + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,'
      + 'dew_point_2m,precipitation,weather_code,cloud_cover,'
      + 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,'
      + 'surface_pressure,visibility,is_day'
      + '&hourly=temperature_2m,apparent_temperature,precipitation_probability,'
      + 'precipitation,weather_code,cloud_cover,wind_speed_10m,'
      + 'wind_direction_10m,wind_gusts_10m,visibility,'
      + 'cape,lifted_index,freezing_level_height,'
      + 'snowfall,snow_depth,uv_index,is_day,relative_humidity_2m,dew_point_2m'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,'
      + 'apparent_temperature_max,apparent_temperature_min,'
      + 'sunrise,sunset,daylight_duration,uv_index,'
      + 'precipitation_sum,snowfall_sum,precipitation_hours,'
      + 'precipitation_probability_max,'
      + 'wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant'
      + '&forecast_days=7&models=best_match';

    const omText = await fetchTextOverHttp(omUrl);
    const om = JSON.parse(omText);
    console.log(`[Forecast] Open-Meteo response keys: ${Object.keys(om).join(', ')}`);
    console.log(`[Forecast] current fields: ${JSON.stringify(om.current).slice(0, 200)}`);

    // ── NWS narrative (US only — skip gracefully outside coverage) ──────────
    let nwsNarrative = null;
    try {
      const ptsText = await fetchTextOverHttp(
        `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
        { 'Accept': 'application/geo+json', 'User-Agent': 'WeatherTV/1.0 (+https://watchweathertv.com)' }
      );
      const pts = JSON.parse(ptsText);
      const forecastUrl = pts?.properties?.forecast;
      if (forecastUrl) {
        const fText = await fetchTextOverHttp(forecastUrl,
          { 'Accept': 'application/geo+json', 'User-Agent': 'WeatherTV/1.0 (+https://watchweathertv.com)' }
        );
        const f = JSON.parse(fText);
        // Keep the first 14 periods (7 days × day+night) with name + short + detailed forecast
        nwsNarrative = (f?.properties?.periods || []).slice(0, 14).map(p => ({
          name:     p.name,
          short:    p.shortForecast,
          detail:   p.detailedForecast,
          isDaytime: p.isDaytime,
          temp:     p.temperature,
          tempUnit: p.temperatureUnit,
          icon:     p.icon,
        }));
      }
    } catch(e) {
      // NWS doesn't cover outside CONUS — silent fail, Open-Meteo data still returned
      console.log(`[Forecast] NWS unavailable for ${lat.toFixed(3)},${lon.toFixed(3)}: ${e.message}`);
    }

    const data = {
      location: { lat, lon, name: locationName },
      timezone: om.timezone,
      timezone_abbreviation: om.timezone_abbreviation,
      utc_offset_seconds: om.utc_offset_seconds,
      current: om.current,
      current_units: om.current_units,
      hourly: om.hourly,
      hourly_units: om.hourly_units,
      daily: om.daily,
      daily_units: om.daily_units,
      nws: nwsNarrative,
      generated_at: Date.now(),
    };

    _forecastCache.set(cacheKey, { data, ts: Date.now() });
    // Evict oldest if cache grows too large (one entry per location)
    if (_forecastCache.size > 30) {
      const oldest = [..._forecastCache.entries()].sort((a,b) => a[1].ts - b[1].ts)[0];
      if (oldest) _forecastCache.delete(oldest[0]);
    }

    res.set('Cache-Control', 'public, max-age=900');
    res.json(data);
  } catch(e) {
    console.error('[Forecast] Error:', e.message);
    res.status(502).json({ error: 'Forecast unavailable', detail: e.message });
  }
});

// GET /api/hms-smoke
// Proxies NOAA OSPO's current HMS smoke KML and converts it to GeoJSON.
// NOAA does NOT publish a GeoJSON format — only KML, Shapefile, and GeoTiff.
// The OSPO KML at ospo.noaa.gov/data/land/fire/smoke.kml is a live-updating
// file with today's smoke polygons. Cached 2 hours.
const _hmsSmokeCache = { data: null, ts: 0 };
const HMS_TTL = 2 * 60 * 60 * 1000;
const HMS_KML_URL = 'https://www.ospo.noaa.gov/Products/land/hms/data/latest_smoke_final.kml';

function parseHMSKML(kml) {
  const features = [];
  const blocks = kml.match(/<Placemark[\s\S]*?<\/Placemark>/g) || [];
  blocks.forEach(block => {
    // Density from styleUrl (#Smoke_Light / #Smoke_Medium / #Smoke_Heavy)
    const styleUrl = (block.match(/<styleUrl>#?([^<]+)<\/styleUrl>/) || [])[1] || '';
    let density = 'Light';
    if (/medium/i.test(styleUrl)) density = 'Medium';
    if (/heavy|thick/i.test(styleUrl)) density = 'Heavy';

    // Parse outer ring coordinates
    const coordsMatch = block.match(/<coordinates>([\s\S]*?)<\/coordinates>/);
    if (!coordsMatch) return;
    const ring = coordsMatch[1].trim().split(/\s+/)
      .map(t => { const p = t.split(',').map(Number); return p; })
      .filter(p => p.length >= 2 && !isNaN(p[0]) && !isNaN(p[1]))
      .map(p => [p[0], p[1]]);
    if (ring.length < 3) return;

    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { Density: density },
    });
  });
  return { type: 'FeatureCollection', features };
}

app.get('/api/hms-smoke', async (req, res) => {
  if (_hmsSmokeCache.data && Date.now() - _hmsSmokeCache.ts < HMS_TTL) {
    res.set('Content-Type', 'application/json');
    res.set('Cache-Control', 'public, max-age=7200');
    return res.json(_hmsSmokeCache.data);
  }
  try {
    const kml = await fetchTextOverHttp(HMS_KML_URL);
    if (!kml.includes('<Placemark')) throw new Error('No Placemark elements in KML response');
    const geojson = parseHMSKML(kml);
    _hmsSmokeCache.data = geojson;
    _hmsSmokeCache.ts = Date.now();
    console.log(`[HMS Smoke] Loaded ${geojson.features.length} smoke polygons from OSPO KML`);
    res.set('Content-Type', 'application/json');
    res.set('Cache-Control', 'public, max-age=7200');
    res.json(geojson);
  } catch(e) {
    console.warn('[HMS Smoke] KML proxy failed:', e.message);
    if (_hmsSmokeCache.data) return res.json(_hmsSmokeCache.data); // serve stale on error
    res.status(502).json({ error: 'HMS smoke unavailable', type: 'FeatureCollection', features: [] });
  }
});

// GET /api/fire-perimeters
// Proxies NIFC active fire perimeter GeoJSON from WFIGS (Wildland Fire
// Interagency Geospatial Services). Tries two known NIFC ArcGIS service
// names since NIFC occasionally renames layers. Cached 30 minutes.
const _fireCache = { data: null, ts: 0 };
const FIRE_TTL = 30 * 60 * 1000;

const NIFC_ENDPOINTS = [
  // Confirmed correct NIFC service name (via NIFC Open Data / Data Basin)
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/Current_WildlandFire_Perimeters/FeatureServer/0/query',
  // YTD perimeters — wider dataset, includes fires from current year
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_YTD/FeatureServer/0/query',
  // Fallbacks in case NIFC renames the service
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query',
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/Active_Fires/FeatureServer/0/query',
];
const NIFC_PARAMS = '?where=1%3D1&outFields=IncidentName,GISAcres,PercentContained,FireCause,POOState,FeatureCategory&resultRecordCount=500&f=geojson';

app.get('/api/fire-perimeters', async (req, res) => {
  if (_fireCache.data && Date.now() - _fireCache.ts < FIRE_TTL) {
    res.set('Content-Type', 'application/json');
    res.set('Cache-Control', 'public, max-age=1800');
    return res.send(_fireCache.data);
  }

  let bestResult = null;
  for (const base of NIFC_ENDPOINTS) {
    try {
      const data = await fetchTextOverHttp(base + NIFC_PARAMS);
      const parsed = JSON.parse(data);
      const count = (parsed.features || []).length;
      console.log(`[Fire] ${base.split('/').slice(-3,-1).join('/')} → ${count} features`);
      if (count > 0) {
        _fireCache.data = data;
        _fireCache.ts = Date.now();
        res.set('Content-Type', 'application/json');
        res.set('Cache-Control', 'public, max-age=1800');
        return res.send(data);
      }
      if (!bestResult) bestResult = data; // keep first valid (even if empty)
    } catch(e) {
      console.warn(`[Fire] ${base.split('/').slice(-3,-1).join('/')} failed:`, e.message);
    }
  }

  // All endpoints returned 0 features or failed — send best result (empty GeoJSON)
  console.warn('[Fire] No active fire perimeters found across all NIFC endpoints');
  const empty = bestResult || JSON.stringify({ type:'FeatureCollection', features:[] });
  _fireCache.data = empty;
  _fireCache.ts = Date.now();
  res.set('Content-Type', 'application/json');
  res.send(empty);
});

// GET /api/camera-hls?url=...
// HLS stream proxy — routes M3U8 and .ts segment requests through our server
// so HLS.js XHR calls stay same-origin and never trigger connect-src CSP.
// M3U8 playlists are rewritten to route all segment URLs through this proxy.
const _hlsCache = new Map();
const HLS_M3U8_TTL = 4 * 1000;
const HLS_SEG_TTL  = 30 * 1000;

function _isPrivateHost(hostname) {
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname);
}

function _fetchBinary(url) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = new URL(url); } catch(e) { return reject(e); }
    const mod = p.protocol === 'https:' ? require('https') : require('http');
    const opts = { headers: { 'User-Agent': 'WeatherTV/1.0 (+https://watchweathertv.com)' } };
    mod.get(url, opts, r => {
      if (r.statusCode === 301 || r.statusCode === 302) {
        const rawLoc = r.headers.location;
        if (!rawLoc) return reject(new Error('redirect with no location'));
        let loc;
        try { loc = rawLoc.startsWith('http') ? rawLoc : new URL(rawLoc, url).href; }
        catch(_) { return reject(new Error('bad redirect')); }
        return _fetchBinary(loc).then(resolve, reject);
      }
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve({ buf: Buffer.concat(chunks), ct: r.headers['content-type'] || '', status: r.statusCode }));
      r.on('error', reject);
    }).on('error', reject);
  });
}

app.get('/api/camera-hls', async (req, res) => {
  const rawUrl = (req.query.url || '').trim();
  if (!rawUrl) return res.status(400).send('url required');
  let parsedUrl;
  try { parsedUrl = new URL(rawUrl); } catch { return res.status(400).send('invalid url'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) return res.status(400).send('http/https only');
  if (_isPrivateHost(parsedUrl.hostname)) return res.status(403).send('private addresses not allowed');

  const isM3U8 = rawUrl.includes('.m3u8') || rawUrl.includes('playlist');
  const ttl = isM3U8 ? HLS_M3U8_TTL : HLS_SEG_TTL;
  const cached = _hlsCache.get(rawUrl);
  if (cached && Date.now() - cached.ts < ttl) {
    res.set('Content-Type', cached.ct);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', isM3U8 ? 'no-cache' : 'public, max-age=30');
    return res.send(cached.buf);
  }

  try {
    const { buf, ct, status } = await _fetchBinary(rawUrl);
    if (status && status >= 400) return res.status(status).send('upstream ' + status);

    let outBuf = buf, outCt = ct;
    if (isM3U8) {
      const baseUrl = rawUrl.substring(0, rawUrl.lastIndexOf('/') + 1);
      const text = buf.toString('utf8');
      const rewritten = text.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        let absUrl;
        try { absUrl = trimmed.startsWith('http') ? trimmed : new URL(trimmed, baseUrl).href; }
        catch(_) { return line; }
        return `/api/camera-hls?url=${encodeURIComponent(absUrl)}`;
      }).join('\n');
      outBuf = Buffer.from(rewritten, 'utf8');
      outCt  = 'application/vnd.apple.mpegurl';
    } else {
      if (!outCt || outCt.includes('text/html')) outCt = 'video/MP2T';
    }

    _hlsCache.set(rawUrl, { buf: outBuf, ct: outCt, ts: Date.now() });
    if (_hlsCache.size > 500) {
      [..._hlsCache.entries()].sort((a,b) => a[1].ts - b[1].ts).slice(0, 100).forEach(([k]) => _hlsCache.delete(k));
    }
    res.set('Content-Type', outCt);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', isM3U8 ? 'no-cache' : 'public, max-age=30');
    res.send(outBuf);
  } catch(e) {
    console.warn('[HLS Proxy]', e.message);
    res.status(502).send('upstream error');
  }
});

// GET /api/camera-image?url=...
// CORS proxy for camera image URLs — almost all DOT servers block direct
// browser requests with missing CORS headers. We fetch server-side and
// pipe back the bytes with the correct headers. Cached 25s so repeated
// refreshes within a poll cycle don't hammer upstream.
app.get('/api/camera-image', async (req, res) => {
  const rawUrl = (req.query.url || '').trim();
  if (!rawUrl) return res.status(400).send('url required');

  // Only allow http/https and block internal addresses — never let this
  // become an SSRF vector for fetching localhost or Railway internals.
  let parsedUrl;
  try { parsedUrl = new URL(rawUrl); } catch { return res.status(400).send('invalid url'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) return res.status(400).send('http/https only');
  const host = parsedUrl.hostname;
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    return res.status(403).send('private addresses not allowed');
  }

  const cached = _imgCache.get(rawUrl);
  if (cached && Date.now() - cached.ts < IMG_TTL) {
    res.set('Content-Type', cached.ct || 'image/jpeg');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=25');
    return res.send(cached.buf);
  }

  try {
    const buf = await new Promise((resolve, reject) => {
      const mod = parsedUrl.protocol === 'https:' ? require('https') : require('http');
      const options = { headers: { 'User-Agent': 'WeatherTV/1.0 (+https://watchweathertv.com)' } };
      mod.get(rawUrl, options, r => {
        if (r.statusCode === 301 || r.statusCode === 302) {
          const rawLoc = r.headers.location;
          if (!rawLoc) return reject(new Error('redirect with no location'));
          let loc;
          try { loc = rawLoc.startsWith('http') ? rawLoc : new URL(rawLoc, rawUrl).href; }
          catch(_) { return reject(new Error('unresolvable redirect: ' + rawLoc)); }
          const mod2 = loc.startsWith('https') ? require('https') : require('http');
          mod2.get(loc, options, r2 => {
            const chunks = [];
            r2.on('data', c => chunks.push(c));
            r2.on('end', () => resolve({ buf: Buffer.concat(chunks), ct: r2.headers['content-type'] }));
            r2.on('error', reject);
          }).on('error', reject);
          return;
        }
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => resolve({ buf: Buffer.concat(chunks), ct: r.headers['content-type'] }));
        r.on('error', reject);
      }).on('error', reject);
    });
    _imgCache.set(rawUrl, { ...buf, ts: Date.now() });
    // Prune cache if it grows large (shouldn't happen with 25s TTL but be safe)
    if (_imgCache.size > 200) {
      const oldest = [..._imgCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) _imgCache.delete(oldest[0]);
    }
    res.set('Content-Type', buf.ct || 'image/jpeg');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=25');
    res.send(buf.buf);
  } catch (e) {
    console.warn('[CameraProxy]', e.message);
    res.status(502).send('upstream error');
  }
});



// Admin — map a Spotter Network chaser ID to one of our channel IDs
app.post('/api/admin/chasers/map', (req, res) => {
  const { spotterNetworkId, channelId } = req.body;
  if (!spotterNetworkId) return res.status(400).json({ error: 'spotterNetworkId required' });
  const data = loadData();
  if (!data.chaserMap) data.chaserMap = {};
  if (channelId) {
    data.chaserMap[spotterNetworkId] = channelId;
  } else {
    delete data.chaserMap[spotterNetworkId]; // unmap
  }
  saveData(data);
  res.json({ ok: true });
});

// Admin — dismiss a single (spotterNetworkId, channelId) suggestion pair as
// "not a match." Stored permanently so it never resurfaces in Suggestions
// again, even though the same name-similarity will keep recomputing on
// every refresh. Scoped to the pair, not the whole chaser, since the same
// person might still be a fuzzy match candidate against a DIFFERENT channel
// later (e.g. if they're later confirmed as someone else entirely).
app.post('/api/admin/chasers/dismiss-suggestion', (req, res) => {
  const { spotterNetworkId, channelId } = req.body;
  if (!spotterNetworkId || !channelId) return res.status(400).json({ error: 'spotterNetworkId and channelId required' });
  const data = loadData();
  if (!data.dismissedSuggestions) data.dismissedSuggestions = [];
  const key = spotterNetworkId + '::' + channelId;
  if (!data.dismissedSuggestions.includes(key)) data.dismissedSuggestions.push(key);
  saveData(data);
  res.json({ ok: true });
});

// Admin — dismiss a chaser entirely from "New Chasers Found" (e.g. a
// self-reported YouTube link that turns out to be unrelated, a duplicate,
// or just not someone you want to add). Stored permanently — the chaser
// stays excluded from that list even though they'll keep appearing in the
// knownChasers registry and the live feed/radar dots.
app.post('/api/admin/chasers/dismiss-new', (req, res) => {
  const { spotterNetworkId } = req.body;
  if (!spotterNetworkId) return res.status(400).json({ error: 'spotterNetworkId required' });
  const data = loadData();
  if (!data.dismissedNewChasers) data.dismissedNewChasers = [];
  if (!data.dismissedNewChasers.includes(spotterNetworkId)) data.dismissedNewChasers.push(spotterNetworkId);
  saveData(data);
  res.json({ ok: true });
});

// Admin — auto-maps every current "exact" tier match in one call. Exact
// matches are normalized-identical names or full-token-subset matches (see
// matchConfidence above), which is a low false-positive-risk bar — these
// don't need a human click each. Fuzzy matches are intentionally excluded
// and still require manual confirmation in the Suggestions tab.
app.post('/api/admin/chasers/auto-map-exact', (req, res) => {
  const data = loadData();
  if (!data.chaserMap) data.chaserMap = {};
  const knownChasers = data.knownChasers || {};
  const allChannels = [];
  (data.groups || []).forEach(g => {
    (g.channels || []).forEach(ch => allChannels.push({ id: ch.id, name: ch.name }));
  });

  let mapped = 0;
  const mappedNames = [];
  Object.entries(knownChasers).forEach(([spotterNetworkId, c]) => {
    if (data.chaserMap[spotterNetworkId]) return; // already mapped
    for (const ch of allChannels) {
      if (matchConfidence(c.name, ch.name) === 'exact') {
        data.chaserMap[spotterNetworkId] = ch.id;
        mapped++;
        mappedNames.push({ spotterName: c.name, channelName: ch.name });
        break; // first exact match wins — exact tier is narrow enough that
                // multiple exact matches for one chaser should be rare
      }
    }
  });

  if (mapped > 0) saveData(data);
  res.json({ ok: true, mapped, mappedNames });
});

// Admin — suggested matches: compares Spotter Network names against our
// existing channel names (case-insensitive substring match) so the admin
// doesn't have to manually search 400+ chasers for matches by hand.
// Compares a Spotter Network name against a channel name and returns a
// confidence tier: 'exact' (normalized names are identical — safe to
// auto-map), 'fuzzy' (one contains the other, or they share both first and
// last token — needs human review), or null (no meaningful match).
function matchConfidence(spotterName, channelName) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const sNorm = norm(spotterName);
  const cNorm = norm(channelName);
  if (!sNorm || !cNorm) return null;

  if (sNorm === cNorm) return 'exact';

  const sTokens = spotterName.toLowerCase().split(/\s+/).filter(Boolean);
  const cTokens = channelName.toLowerCase().split(/\s+/).filter(Boolean);

  // Suffix case: every token of the shorter name appears, in order, at the
  // start of the longer name's token list — e.g. "Brandon Copic" vs.
  // "Brandon Copic Live" / "Brandon Copic Archive". This only checks a
  // leading prefix match (not "any shared tokens"), so it can't be
  // triggered by two people merely sharing a first name.
  const [shorter, longer] = sTokens.length <= cTokens.length ? [sTokens, cTokens] : [cTokens, sTokens];
  if (shorter.length >= 2 && longer.length > shorter.length) {
    const isPrefixMatch = shorter.every((t, i) => longer[i] === t);
    if (isPrefixMatch) return 'exact';
  }

  // Last-name token must match for any further comparison — this is what
  // prevents "John Brown" from fuzzy-matching "John Smith" just because
  // they share a common first name. Without this guard, common first names
  // (John, Mike, etc.) across hundreds of live chasers would flood the
  // fuzzy review list with false positives.
  const sLast = sTokens[sTokens.length - 1];
  const cLast = cTokens[cTokens.length - 1];
  if (sTokens.length < 2 || cTokens.length < 2 || sLast !== cLast) {
    // No reliable last-name anchor — only allow a match if one full
    // normalized name is contained in the other (e.g. single-word channel
    // brand names that happen to embed the full spotter name).
    if (cNorm.includes(sNorm) || sNorm.includes(cNorm)) return 'fuzzy';
    return null;
  }

  // Last names match — first name token must also match for 'exact',
  // otherwise fuzzy (covers nicknames/initials on the first name only).
  const sFirst = sTokens[0];
  const cFirst = cTokens[0];
  if (sFirst === cFirst) return 'exact';
  return 'fuzzy';
}

app.get('/api/admin/chasers/suggestions', (req, res) => {
  const data = loadData();
  const chaserMap = data.chaserMap || {};
  const knownChasers = data.knownChasers || {};
  const dismissed = new Set(data.dismissedSuggestions || []);
  const allChannels = [];
  (data.groups || []).forEach(g => {
    (g.channels || []).forEach(ch => allChannels.push({ id: ch.id, name: ch.name }));
  });

  const exact = [];
  const fuzzy = [];
  Object.entries(knownChasers).forEach(([spotterNetworkId, c]) => {
    if (chaserMap[spotterNetworkId]) return; // already mapped
    allChannels.forEach(ch => {
      if (dismissed.has(spotterNetworkId + '::' + ch.id)) return; // admin already said no
      const confidence = matchConfidence(c.name, ch.name);
      if (!confidence) return;
      const entry = {
        spotterNetworkId,
        spotterName: c.name,
        channelId: ch.id,
        channelName: ch.name,
        lastSeenAt: c.lastSeenAt
      };
      if (confidence === 'exact') exact.push(entry); else fuzzy.push(entry);
    });
  });

  res.json({ exact, fuzzy, suggestions: fuzzy }); // `suggestions` kept for backward compat — fuzzy tier only
});

// Admin — chasers with a self-reported YouTube link in their Note field who
// are NOT yet mapped to one of our channels. Surfaces new chasers to add.
// Runs against the persisted knownChasers registry, not just the current
// 2-minute live snapshot, so this accumulates everyone we've ever spotted
// reporting a link rather than only whoever happens to be active right now.
app.get('/api/admin/chasers/unmapped-youtube', (req, res) => {
  const data = loadData();
  const chaserMap = data.chaserMap || {};
  const knownChasers = data.knownChasers || {};
  const dismissedNew = new Set(data.dismissedNewChasers || []);

  const found = Object.entries(knownChasers)
    .filter(([spotterNetworkId, c]) => c.youtubeUrl && !chaserMap[spotterNetworkId] && !dismissedNew.has(spotterNetworkId))
    .map(([spotterNetworkId, c]) => {
      // Pull current live status from the cache if they're active right
      // now; otherwise fall back to "last seen" since they may not be
      // broadcasting in this exact poll window.
      const live = chaserCache.chasers.find(lc => lc.id === spotterNetworkId);
      return {
        spotterNetworkId,
        name: c.name,
        youtubeUrl: c.youtubeUrl,
        lat: live ? live.lat : null,
        lng: live ? live.lng : null,
        status: live ? live.status : 'offline',
        lastSeenAt: c.lastSeenAt
      };
    });

  res.json({ unmapped: found });
});

// Resolves a YouTube URL (handle, /channel/UC..., /c/name, /user/name, or a
// video URL) into a channel ID + display name + thumbnail via the YouTube
// Data API. Used by the "Add as Channel" button on the New Chasers Found
// tab, since chasers self-report arbitrary YouTube URL formats in their
// Spotter Network Note field, not raw channel IDs.
function parseYouTubeUrlParts(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, ''); // strip trailing slash

    let m;
    if ((m = path.match(/^\/channel\/(UC[\w-]{10,})/))) return { type: 'id', value: m[1] };
    if ((m = path.match(/^\/@([\w.-]+)/)))              return { type: 'handle', value: '@' + m[1] };
    if ((m = path.match(/^\/c\/([\w.-]+)/)))             return { type: 'custom', value: m[1] };
    if ((m = path.match(/^\/user\/([\w.-]+)/)))          return { type: 'legacy', value: m[1] };
    // Video URL — resolve via the video's channelId instead
    if (path === '/watch' && u.searchParams.get('v'))   return { type: 'video', value: u.searchParams.get('v') };
    if (u.hostname.includes('youtu.be'))                 return { type: 'video', value: path.slice(1) };
  } catch(e) {}
  return null;
}

async function resolveYouTubeChannel(url) {
  const parts = parseYouTubeUrlParts(url);
  if (!parts) {
    const err = new Error('Could not parse a recognizable YouTube URL format from: ' + url);
    err.code = 'unparseable_url';
    throw err;
  }
  const key = getApiKey();

  let apiUrl = null;
  if (parts.type === 'id') {
    apiUrl = `https://www.googleapis.com/youtube/v3/channels?key=${key}&id=${parts.value}&part=snippet`;
  } else if (parts.type === 'handle') {
    apiUrl = `https://www.googleapis.com/youtube/v3/channels?key=${key}&forHandle=${encodeURIComponent(parts.value)}&part=snippet`;
  } else if (parts.type === 'custom' || parts.type === 'legacy') {
    // Legacy /c/ and /user/ URLs aren't directly resolvable by the v3 API —
    // fall back to a search, which costs more quota but covers the format.
    apiUrl = `https://www.googleapis.com/youtube/v3/search?key=${key}&q=${encodeURIComponent(parts.value)}&type=channel&part=snippet&maxResults=1`;
  } else if (parts.type === 'video') {
    const videoData = await ytFetch(`https://www.googleapis.com/youtube/v3/videos?key=${key}&id=${parts.value}&part=snippet`);
    if (checkQuotaError(videoData)) { markQuotaExceeded(true); const e = new Error('quota_exceeded'); e.code = 'quota_exceeded'; throw e; }
    const channelId = videoData.items && videoData.items[0] && videoData.items[0].snippet.channelId;
    if (!channelId) {
      const err = new Error('Video lookup returned no channelId (video may be private, deleted, or ID is wrong). Raw API response: ' + JSON.stringify(videoData).slice(0, 300));
      err.code = 'video_lookup_empty';
      throw err;
    }
    apiUrl = `https://www.googleapis.com/youtube/v3/channels?key=${key}&id=${channelId}&part=snippet`;
  }

  if (!apiUrl) {
    const err = new Error('Internal: no API URL constructed for parsed type "' + parts.type + '"');
    err.code = 'internal_no_url';
    throw err;
  }

  const data = await ytFetch(apiUrl);
  if (checkQuotaError(data)) { markQuotaExceeded(true); const e = new Error('quota_exceeded'); e.code = 'quota_exceeded'; throw e; }

  // Surface the API's own error payload rather than swallowing it — this is
  // what was previously hidden behind a generic "Could not resolve" message,
  // making it impossible to tell a bad handle apart from an API-level
  // rejection (e.g. forHandle not recognizing a channel that exists but
  // hasn't claimed a handle, or a transient API error).
  if (data.error) {
    const err = new Error('YouTube API error: ' + (data.error.message || JSON.stringify(data.error)));
    err.code = 'api_error';
    throw err;
  }

  const item = data.items && data.items[0];
  if (!item) {
    const err = new Error(
      `No channel found for ${parts.type} "${parts.value}". This can happen if the channel was deleted/suspended, ` +
      `the handle was never claimed by this exact string, or (for older accounts) the channel has no handle set at all. ` +
      `Use the channel ID override below if you have it.`
    );
    err.code = 'not_found';
    throw err;
  }

  const channelId = item.id?.channelId || item.id; // search results nest id.channelId
  const snippet = item.snippet || {};
  return {
    channelId,
    name: snippet.title || parts.value,
    thumbnail: snippet.thumbnails?.default?.url || null
  };
}

// Admin — resolve a YouTube URL to a channel ID/name without adding it yet.
// Lets the admin preview what will be added before confirming.
app.post('/api/admin/chasers/resolve-youtube', async (req, res) => {
  const { youtubeUrl } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: 'youtubeUrl required' });
  try {
    const resolved = await resolveYouTubeChannel(youtubeUrl);
    res.json(resolved);
  } catch(e) {
    if (e.code === 'quota_exceeded') return res.status(429).json({ error: 'quota_exceeded' });
    res.status(404).json({ error: e.message, code: e.code || 'unknown' });
  }
});

// Admin — one-click flow for the New Chasers Found tab: resolves the
// chaser's self-reported YouTube URL to a channel ID, adds it as a new
// channel in the Storm Chasers group (alphabetized), and immediately maps
// the Spotter Network ID to the new channel. All three steps happen
// server-side in one call so the UI doesn't need multiple round trips.
//
// If `manualChannelId` is provided, resolution is skipped entirely and that
// ID is used directly — this is the workaround for chasers whose handle
// won't resolve via forHandle (deleted/renamed channel, handle never
// claimed, transient API quirk, etc.) but whose channel ID the admin found
// by hand (e.g. via the page source or a third-party ID lookup tool).
// channelName is required alongside manualChannelId since there's no API
// call to fetch a display name from in this path.
app.post('/api/admin/chasers/add-and-map', async (req, res) => {
  const { spotterNetworkId, youtubeUrl, groupId, manualChannelId, manualChannelName } = req.body;
  if (!spotterNetworkId) {
    return res.status(400).json({ error: 'spotterNetworkId required' });
  }
  if (!youtubeUrl && !manualChannelId) {
    return res.status(400).json({ error: 'youtubeUrl or manualChannelId required' });
  }

  try {
    let resolved;
    if (manualChannelId) {
      const trimmedId = manualChannelId.trim();
      if (!/^UC[\w-]{10,}$/.test(trimmedId)) {
        return res.status(400).json({ error: 'That doesn\'t look like a valid YouTube channel ID — it should start with "UC" (e.g. UCcJ8bLvmhJgK_cCGESPjzxQ).' });
      }
      if (!manualChannelName || !manualChannelName.trim()) {
        return res.status(400).json({ error: 'A display name is required when adding by channel ID manually.' });
      }
      resolved = { channelId: trimmedId, name: manualChannelName.trim(), thumbnail: null };
    } else {
      resolved = await resolveYouTubeChannel(youtubeUrl);
    }

    const data = loadData();
    const targetGroupId = groupId || 'chasers';
    const group = (data.groups || []).find(g => g.id === targetGroupId);
    if (!group) return res.status(404).json({ error: 'Target group not found: ' + targetGroupId });

    // Skip if this channel ID is already in the group (avoid duplicates)
    const exists = (group.channels || []).some(ch => ch.id === resolved.channelId);
    if (!exists) {
      group.channels = group.channels || [];
      group.channels.push({
        id: resolved.channelId,
        name: resolved.name,
        hasLive: true,
        enabled: true
      });
      // Re-alphabetize the group by name, case-insensitive — matches the
      // existing sort order convention used across all channel groups.
      group.channels.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    }

    if (!data.chaserMap) data.chaserMap = {};
    data.chaserMap[spotterNetworkId] = resolved.channelId;

    saveData(data);
    res.json({ ok: true, channelId: resolved.channelId, channelName: resolved.name, alreadyExisted: exists });
  } catch(e) {
    if (e.code === 'quota_exceeded') return res.status(429).json({ error: 'quota_exceeded' });
    res.status(404).json({ error: e.message, code: e.code || 'unknown' });
  }
});

// Refresh the chaser cache every 45 seconds — close to Spotter Network's own
// ~30-60s device ping cadence, so we're not adding much extra staleness on
// top of their source data. This is a public, unauthenticated feed; if
// Spotter Network ever wants this slowed down they'll let us know (rate
// limit response, blocked IP, etc.) and we can back off then.
setInterval(refreshChaserCache, 45 * 1000);
// Initial fetch shortly after boot
setTimeout(refreshChaserCache, 5000);

// ── WebSub subscription lease tracker ───────────────────────────────────────
// Tracks per-channel subscription status and lease expiry.
const websubLeases = {}; // { channelId: { subscribedAt, expiresAt, status } }

// ── Failed fetch error log ────────────────────────────────────────────────────
// Circular buffer of last 50 fetch errors — visible in admin panel.
// ── Event log — captures errors, quota hits, fetches, admin actions ──────────
// type: 'error' | 'quota' | 'fetch' | 'admin' | 'info'
// severity: 'error' | 'warn' | 'info'
const eventLog = [];
const MAX_EVENT_LOG = 200;

function logEvent({ type = 'info', severity = 'info', source = 'system', channelId = null, channelName = null, message, detail = null }) {
  const entry = { type, severity, source, channelId, channelName, message, detail, timestamp: Date.now() };
  eventLog.unshift(entry);
  if (eventLog.length > MAX_EVENT_LOG) eventLog.pop();
  if (severity === 'error') console.error(`[WeatherTV][${type}] ${message}`, detail || '');
  else if (severity === 'warn') console.warn(`[WeatherTV][${type}] ${message}`, detail || '');
}

// Back-compat shim — existing logFetchError calls still work
function logFetchError(channelId, channelName, errorMsg) {
  logEvent({ type: 'error', severity: 'error', source: 'fetch', channelId, channelName, message: errorMsg });
}

// ── Daily live-check quota tracker ──────────────────────────────────────────
// Each WebSub-triggered check now uses videos.list (1 unit) not search (100 units).
// Cap raised to 500 checks/day = ~500 units max (vs old 40 × 100 = 4,000 units).
// The 100-unit search fallback (no video ID) still counts against this limit.
const quotaTracker = { date: "", liveChecks: 0 };
const DAILY_LIVE_CHECK_LIMIT = 2000; // videos.list at 1 unit each — 2,000 max/day uses ~2,000 of 60,000 available units

function getLiveChecksToday() {
  const today = new Date().toISOString().split('T')[0];
  if (quotaTracker.date !== today) { quotaTracker.date = today; quotaTracker.liveChecks = 0; }
  return quotaTracker.liveChecks;
}

function recordLiveCheck() {
  const today = new Date().toISOString().split('T')[0];
  if (quotaTracker.date !== today) { quotaTracker.date = today; quotaTracker.liveChecks = 0; }
  quotaTracker.liveChecks++;
}

// ── Channel activity tracking ────────────────────────────────────────────────
// Tracks per-channel last video upload date and last confirmed live date.
// Used to assign channels to fetch tiers so quota is spent on active creators.

async function updateChannelActivity(channelId, updates) {
  const existing = cache.channelActivity[channelId] || {};
  const updated = { ...existing, ...updates };
  cache.channelActivity[channelId] = updated;
  await rSet('wt:activity:' + channelId, updated, REDIS_TTL.channelActivity);
}

// Tier 1 (fetch daily): last video < 14 days OR hasLive + last live < 30 days
// Tier 2 (fetch every 14 days): hasLive but not live in 30+ days
// Tier 3 (fetch every 14 days, offset): no hasLive, last video 14+ days
function getChannelTier(ch) {
  const act = cache.channelActivity[ch.id] || {};
  const now = Date.now();
  const DAY = 86400000;

  const hasVideoHistory = !!act.lastVideoDate;
  const hasLiveHistory  = !!act.lastLiveDate;

  // Bootstrap case — no activity data ever recorded for this channel.
  // Use hasLive as a proxy: live-capable channels are almost certainly active,
  // non-live channels can wait for a 14-day check without losing much freshness.
  if (!hasVideoHistory && !hasLiveHistory) {
    return ch.hasLive ? 1 : 3;
  }

  const lastVideoAge = hasVideoHistory ? (now - act.lastVideoDate) / DAY : 999;
  const lastLiveAge  = hasLiveHistory  ? (now - act.lastLiveDate)  / DAY : 999;

  if (lastVideoAge < 14) return 1;              // recently posted video
  if (ch.hasLive && lastLiveAge < 30) return 1; // recently confirmed live
  if (ch.hasLive) return 2;                      // has live capability, but inactive
  return 3;                                      // no live, inactive video poster
}

// Should a Tier 2/3 channel be fetched today?
// Tier 2 (inactive live) fetches on days 1,3,5... of a 14-day rolling window
// Tier 3 (inactive video) fetches on days 8,10,12... (7-day offset from Tier 2)
// This staggers them so they never both hit on the same day.
function shouldFetchTodayByTier(ch, tier) {
  const act = cache.channelActivity[ch.id] || {};
  if (act.nextFetchDue && Date.now() < act.nextFetchDue) return false;
  return true; // due date passed or never set — fetch it
}

// Alternates fetch order daily so different channels get priority when quota runs out
function getChannelFetchOrder(channels) {
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  const reversed = dayOfYear % 2 === 1;
  return reversed ? [...channels].reverse() : [...channels];
}

const REDIS_TTL = {
  recentVideos:         7 * 24 * 60 * 60,  // 7 days  (was 25h — survives quota gaps)
  recentVideosInactive: 14 * 24 * 60 * 60, // 14 days for inactive-tier channels
  liveStatus:           5 * 24 * 60 * 60,  // 5 days  (was 24h — keeps last known state)
  playlist:             49 * 60 * 60,       // 49 hours (unchanged)
  channelActivity:      60 * 24 * 60 * 60, // 60 days — long-term per-channel activity
};

async function rSet(key, value, ttl) {
  if (!redis) return;
  try {
    if (ttl) await redis.setex(key, ttl, JSON.stringify(value));
    else await redis.set(key, JSON.stringify(value));
  } catch(e) { console.error('[Redis] SET error ' + key + ':', e.message); }
}

async function rGet(key) {
  if (!redis) return null;
  try {
    const v = await redis.get(key);
    return v ? JSON.parse(v) : null;
  } catch(e) { console.error('[Redis] GET error ' + key + ':', e.message); return null; }
}

async function rDel(key) {
  if (!redis) return;
  try { await redis.del(key); } catch(e) {}
}

async function rKeys(pattern) {
  if (!redis) return [];
  try { return await redis.keys(pattern); } catch(e) { return []; }
}

// Restore cache from Redis on startup — survives deploys and restarts
async function restoreCacheFromRedis() {
  if (!redis) return;
  try {
    console.log('[Redis] Restoring cache from Redis...');

    // Metadata
    const lastFetch = await rGet('wt:lastFetch');
    if (lastFetch) cache.lastRecentFetch = lastFetch;
    const lastLive = await rGet('wt:lastLive');
    if (lastLive) cache.lastLiveCheck = lastLive;
    const lastNotification = await rGet('wt:lastNotification');
    if (lastNotification) cache.lastNotificationReceived = lastNotification;
    const websubActive = await rGet('wt:websubActive');
    if (websubActive !== null) cache.websubActive = websubActive;

    // Live statuses
    const liveKeys = await rKeys('wt:live:*');
    for (const key of liveKeys) {
      const val = await rGet(key);
      if (val) cache.liveStatuses[key.replace('wt:live:', '')] = val;
    }

    // Recent videos
    const recentKeys = await rKeys('wt:recent:*');
    for (const key of recentKeys) {
      const val = await rGet(key);
      if (val) cache.recentVideos[key.replace('wt:recent:', '')] = val;
    }

    // Playlist
    const plKeys = await rKeys('wt:playlist:*');
    for (const key of plKeys) {
      const val = await rGet(key);
      if (val) cache.playlist[key.replace('wt:playlist:', '')] = val;
    }

    // Channel activity (tier tracking)
    const activityKeys = await rKeys('wt:activity:*');
    for (const key of activityKeys) {
      const val = await rGet(key);
      if (val) cache.channelActivity[key.replace('wt:activity:', '')] = val;
    }

    console.log('[Redis] Restored — ' + recentKeys.length + ' video caches, ' + liveKeys.length + ' live statuses, ' + activityKeys.length + ' activity records');
  } catch(e) {
    console.error('[Redis] Restore error:', e.message);
  }
}

// Intervals are configurable via admin panel — stored in channels.json config
// Defaults shown here, overridden by loadData().config values
const CACHE_TTL = {
  recentVideos: 24 * 60 * 60 * 1000,  // 24 hours default
  playlist:     48 * 60 * 60 * 1000,  // 48 hours (not configurable — rarely changes)
  liveCheck:    2 * 60 * 60 * 1000,   // 2 hours default — reduce to 15min after quota increase
};

function getLiveCheckInterval() {
  try {
    const cfg = loadData().config;
    if (cfg.liveCheckIntervalHours) return cfg.liveCheckIntervalHours * 60 * 60 * 1000;
  } catch(e) {}
  return CACHE_TTL.liveCheck;
}

function getRecentFetchHour() {
  try {
    const cfg = loadData().config;
    if (cfg.recentFetchHourEST !== undefined) return cfg.recentFetchHourEST;
  } catch(e) {}
  return 12; // noon EST default -- most forecasters have their daily forecast posted by then
}

// ── Helper: get channels eligible for live check based on time (EST) ──
// Forecasters: checked 6am-2am EST (stop 2am-6am)
// Chasers/Creators: checked 6am-midnight EST (stop midnight-6am)
function getLiveChannels() {
  const channels = [];
  try {
    const data = loadData();
    if (!data.groups) return channels;

    // Current hour in EST
    const estNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const estHour = estNow.getHours(); // 0-23

    // Forecaster group ID — only they get the extended 2am window
    const FORECASTER_GROUP = 'forecasters';

    data.groups.forEach(g => {
      g.channels.forEach(ch => {
        if (!ch.hasLive || ch.enabled === false) return;

        if (g.id === FORECASTER_GROUP) {
          // Forecasters: active 6am-2am EST (pause 2am-6am)
          const active = estHour >= 6 || estHour < 2;
          if (active) channels.push({ ...ch, _group: g.id });
        } else {
          // All others: active 6am-midnight EST (pause midnight-6am)
          const active = estHour >= 6 && estHour < 24;
          if (active) channels.push({ ...ch, _group: g.id });
        }
      });
    });
  } catch(e) {}
  return channels;
}

// ── Helper: get all enabled channels ──
function getAllChannels() {
  const channels = [];
  try {
    const data = loadData();
    if (data.groups) {
      data.groups.forEach(g => {
        g.channels.forEach(ch => {
          if (ch.enabled !== false) channels.push(ch);
        });
      });
    }
  } catch(e) {}
  return channels;
}

// ════════════════════════════════════════════
// LIVE STATUS — channels endpoint (1 unit each vs 100 for search)
// Uses YouTube's channels API to check if a channel has an active
// live broadcast — costs 1 unit per channel instead of 100
// ════════════════════════════════════════════
async function checkLiveStatus(channelId) {
  const key = getApiKey();
  // Use search with eventType=live — the only reliable live detection method
  // Costs 100 units per channel but is accurate
  const url = 'https://www.googleapis.com/youtube/v3/search?key=' + key +
    '&channelId=' + channelId + '&part=id&eventType=live&type=video';
  const data = await ytFetch(url);
  if (checkQuotaError(data)) { markQuotaExceeded(true); throw new Error('quota_exceeded'); }
  return !!(data.items && data.items.length > 0);
}

// ── Scheduled Live Check ──
// WebSub handles real-time live detection on Railway (zero quota cost)
// This poll runs every 4 hours as a safety net catch-all
// Uses search?eventType=live (100 units/channel) — accurate but expensive
// Time-aware: chasers/creators stop at midnight EST, forecasters at 2am EST
// IMPORTANT: Submit quota increase request at console.cloud.google.com
async function scheduledLiveCheck() {
  if (cache.websubActive) {
    console.log('[WeatherTV] WebSub active — skipping poll-based live check');
    return;
  }
  if (primaryQuotaExceeded) {
    console.log('[WeatherTV] Skipping live check — primary key quota exceeded');
    return;
  }

  const key = getApiKey();
  if (!key || key === 'YOUR_YOUTUBE_API_KEY') return;

  const channels = getLiveChannels();
  if (channels.length === 0) {
    console.log('[WeatherTV] No channels configured yet for live check');
    return;
  }

  const estHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours();
  console.log('[WeatherTV] Running live check (' + channels.length + ' channels, 100 units each = ' + (channels.length * 100) + ' units) — EST hour: ' + estHour + '...');
  let liveCount = 0;

  for (const ch of channels) {
    try {
      const isLive = await checkLiveStatus(ch.id);
      const liveEntry = { isLive, checkedAt: Date.now(), source: 'poll' };
      cache.liveStatuses[ch.id] = liveEntry;
      rSet('wt:live:' + ch.id, liveEntry, REDIS_TTL.liveStatus);
      if (isLive) liveCount++;
      await new Promise(r => setTimeout(r, 100));
    } catch(e) {
      if (e.message === 'quota_exceeded') break;
      console.error('[WeatherTV] Live check error for ' + ch.id + ':', e.message);
    }
  }

  cache.lastLiveCheck = Date.now();
  await rSet('wt:lastLive', cache.lastLiveCheck);
  console.log('[WeatherTV] Live check complete — ' + liveCount + ' channel(s) live (' + (channels.length * 100) + ' units used)');

  // No automatic rescheduling — this function is called manually via admin panel only
  // WebSub handles ongoing live detection
}

// Scheduled live polling removed — WebSub handles real-time live detection at zero quota cost
// YouTube notifies us instantly when a channel goes live via WebSub push
// Use the manual 'Check Now' button in admin panel if you need to verify live status
// The scheduledLiveCheck function is still available for the manual Check Now button
console.log('[WeatherTV] Live detection via WebSub only — no scheduled polling');

// Startup live check — only checks channels with no cached status in Redis
// Catches channels that were already live before server subscribed to WebSub
// Disabled until quota increase approved — set STARTUP_LIVE_CHECK=true to enable
if (process.env.STARTUP_LIVE_CHECK === 'true') {
  setTimeout(async () => {
    if (primaryQuotaExceeded) return;
    const channels = getLiveChannels();
    const unchecked = channels.filter(ch => !cache.liveStatuses[ch.id]);
    if (unchecked.length === 0) {
      console.log('[WeatherTV] Startup live check — all channels already have cached status');
      return;
    }
    console.log('[WeatherTV] Startup live check for ' + unchecked.length + ' unchecked channels (' + (unchecked.length * 100) + ' units)...');
    const key = getApiKey();
    if (!key) return;
    for (const ch of unchecked) {
      if (primaryQuotaExceeded) break;
      try {
        const isLive = await checkLiveStatus(ch.id);
        const liveEntry = { isLive, checkedAt: Date.now(), source: 'startup' };
        cache.liveStatuses[ch.id] = liveEntry;
        rSet('wt:live:' + ch.id, liveEntry, REDIS_TTL.liveStatus);
        if (isLive) console.log('[WeatherTV] Startup check — ' + ch.name + ' is LIVE');
        await new Promise(r => setTimeout(r, 150));
      } catch(e) {
        if (e.message === 'quota_exceeded') break;
      }
    }
    cache.lastLiveCheck = Date.now();
    rSet('wt:lastLive', cache.lastLiveCheck);
    console.log('[WeatherTV] Startup live check complete');
  }, 5000);
}

// ════════════════════════════════════════════
// WEBSUB / PUBSUBHUBBUB
// YouTube pushes notifications when a channel goes live or posts a video
// Zero quota cost — YouTube calls us instead of us calling YouTube
// Requires a public URL (Railway) — not available on localhost
// ════════════════════════════════════════════
const WEBSUB_HUB = 'https://pubsubhubbub.appspot.com/subscribe';
const WEBSUB_LEASE = 9 * 24 * 60 * 60; // 9 days in seconds (max is 10)
const rawBodyParser = express.raw({ type: 'application/atom+xml', limit: '1mb' });

// Subscribe a single channel to WebSub
async function websubSubscribe(channelId) {
  const baseUrl = process.env.APP_URL;
  if (!baseUrl) return; // Not deployed yet

  const callbackUrl = baseUrl + '/websub/callback/' + channelId;
  const topicUrl = 'https://www.youtube.com/xml/feeds/videos.xml?channel_id=' + channelId;

  const body = new URLSearchParams({
    'hub.callback':     callbackUrl,
    'hub.topic':        topicUrl,
    'hub.verify':       'async',
    'hub.mode':         'subscribe',
    'hub.lease_seconds': String(WEBSUB_LEASE),
    'hub.secret':       process.env.WEBSUB_SECRET || 'weathertv-secret'
  });

  return new Promise((resolve, reject) => {
    const postData = body.toString();
    const opts = {
      hostname: 'pubsubhubbub.appspot.com',
      path: '/subscribe',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    const req = https.request(opts, res => {
      const now = Date.now();
      const status = res.statusCode >= 200 && res.statusCode < 300 ? 'active' : 'failed';
      const expiresAt = now + WEBSUB_LEASE * 1000;
      websubLeases[channelId] = {
        subscribedAt: now,
        expiresAt,
        status,
        statusCode: res.statusCode,
      };
      // Persist expiry so restarts don't re-subscribe still-valid channels
      if (status === 'active') rSet('wt:ws:' + channelId, String(expiresAt));
      console.log('[WebSub] Subscribe response for ' + channelId + ': ' + res.statusCode);
      if (status === 'failed') {
        const ch = getAllChannels().find(c => c.id === channelId);
        logFetchError(channelId, ch ? ch.name : channelId, 'WebSub subscribe failed — HTTP ' + res.statusCode);
      }
      resolve(res.statusCode);
    });
    req.on('error', e => {
      websubLeases[channelId] = { subscribedAt: Date.now(), expiresAt: null, status: 'error', error: e.message };
      const ch = getAllChannels().find(c => c.id === channelId);
      logFetchError(channelId, ch ? ch.name : channelId, 'WebSub subscribe error — ' + e.message);
      reject(e);
    });
    req.write(postData);
    req.end();
  });
}

// ── Startup sequence ──
// Restore app data and cache from Redis first
(async () => {
  await restoreAppDataFromRedis();  // groups, channels, collections
  await restoreCacheFromRedis();    // video cache, live statuses

  // Check if today's scheduled fetch was missed
  // Compare dates not just timestamps to prevent double-fetching on same day
  const fetchHour = getRecentFetchHour();
  const estNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const estHour = estNow.getHours();
  const lastFetch = cache.lastRecentFetch;

  let missedFetch = false;
  if (estHour >= fetchHour) {
    if (!lastFetch) {
      // Never fetched — run now
      missedFetch = true;
    } else {
      // Check if last fetch was before today's scheduled fetch time
      const lastFetchEST = new Date(new Date(lastFetch).toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const fetchedTodayAfterSchedule = 
        lastFetchEST.toDateString() === estNow.toDateString() && 
        lastFetchEST.getHours() >= fetchHour;
      missedFetch = !fetchedTodayAfterSchedule;
    }
  }

  if (missedFetch) {
    console.log('[WeatherTV] Missed scheduled fetch detected — running now (last fetch: ' + (lastFetch ? new Date(lastFetch).toLocaleString() : 'never') + ')');
    fetchAllRecentVideos(); // don't await — run in background
  } else {
    const minsAgo = lastFetch ? Math.round((Date.now() - lastFetch) / 60000) : null;
    console.log('[WeatherTV] No missed fetch — ' + (minsAgo ? 'last fetch ' + minsAgo + 'm ago' : 'before scheduled time'));
  }
  scheduleNextRecentFetch();
})();

// Subscribe all hasLive channels on startup (only when APP_URL is set)
async function subscribeAllChannels() {
  if (!process.env.APP_URL) {
    console.log('[WebSub] APP_URL not set — WebSub disabled (expected on localhost)');
    return;
  }

  const channels = getLiveChannels();
  const RENEW_WINDOW = 24 * 60 * 60 * 1000; // re-subscribe if expiring within 24h
  const now = Date.now();

  // Check Redis for existing valid subscriptions — skip channels that don't
  // need re-subscribing. This makes restarts after recent deploys near-instant
  // instead of blocking for 60+ seconds re-subscribing every channel.
  const toSubscribe = [];
  let skipped = 0;
  for (const ch of channels) {
    try {
      const stored = redisClient ? await redisClient.get('wt:ws:' + ch.id) : null;
      if (stored) {
        const expiresAt = parseInt(stored, 10);
        if (!isNaN(expiresAt) && expiresAt - now > RENEW_WINDOW) {
          // Still valid for >24h — mark as active without hitting the hub
          websubLeases[ch.id] = { subscribedAt: null, expiresAt, status: 'active' };
          skipped++;
          continue;
        }
      }
    } catch(_) { /* Redis unavailable — subscribe to be safe */ }
    toSubscribe.push(ch);
  }

  if (toSubscribe.length === 0) {
    cache.websubActive = true;
    rSet('wt:websubActive', true);
    console.log(`[WebSub] All ${channels.length} subscriptions still valid — skipped hub calls`);
    return;
  }

  console.log(`[WebSub] Subscribing ${toSubscribe.length}/${channels.length} channels (${skipped} still valid)...`);

  for (const ch of toSubscribe) {
    try {
      await websubSubscribe(ch.id);
      await new Promise(r => setTimeout(r, 500));
    } catch(e) {
      console.error('[WebSub] Subscribe error for ' + ch.name + ':', e.message);
    }
  }

  cache.websubActive = true;
  rSet('wt:websubActive', true);
  console.log('[WebSub] Subscription refresh complete — push notifications active');
}

// WebSub verification handshake — YouTube calls this to confirm subscription
app.get('/websub/callback/:channelId', (req, res) => {
  const challenge = req.query['hub.challenge'];
  const mode = req.query['hub.mode'];
  console.log('[WebSub] Verification for ' + req.params.channelId + ' mode=' + mode);
  if (challenge) {
    res.status(200).send(challenge);
  } else {
    res.status(400).send('No challenge');
  }
});

// WebSub notification — YouTube pushes this when a channel posts or goes live
// Rate limit: only do API live check if we haven't checked this channel in last 10 minutes
const websubLastCheck = {}; // channelId -> timestamp
const WEBSUB_RATE_LIMIT_MS = 10 * 60 * 1000; // 10 minutes

app.post('/websub/callback/:channelId', rawBodyParser, (req, res) => {
  res.status(200).send('OK'); // Always respond quickly

  const channelId = req.params.channelId;
  const body = req.body ? req.body.toString() : '';

  // Track that YouTube pushed a notification to us (free, 0 units)
  cache.lastNotificationReceived = Date.now();
  rSet('wt:lastNotification', cache.lastNotificationReceived);

  // Step 1: Parse Atom feed — free, no quota cost
  // Extract video ID and live status directly from the feed XML
  const videoIdMatch = body.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
  const feedVideoId = videoIdMatch ? videoIdMatch[1].trim() : null;
  const feedIsLive     = body.includes('<yt:liveBroadcastContent>live</yt:liveBroadcastContent>');
  const feedIsUpcoming = body.includes('<yt:liveBroadcastContent>upcoming</yt:liveBroadcastContent>');

  // Step 2: If feed explicitly says LIVE — trust it, mark immediately, no API call (0 units)
  if (feedIsLive && feedVideoId) {
    const wasLive = cache.liveStatuses[channelId] && cache.liveStatuses[channelId].isLive;
    const wsEntry = { isLive: true, videoId: feedVideoId, checkedAt: Date.now(), source: 'websub_feed' };
    cache.liveStatuses[channelId] = wsEntry;
    cache.lastLiveCheck = Date.now();
    rSet('wt:live:' + channelId, wsEntry, REDIS_TTL.liveStatus);
    rSet('wt:lastLive', cache.lastLiveCheck);
    updateChannelActivity(channelId, { lastLiveDate: Date.now() });
    websubLastCheck[channelId] = Date.now();
    if (!wasLive) console.log('[WebSub] LIVE (feed confirmed, 0 units): ' + channelId + ' video: ' + feedVideoId);
    delete cache.recentVideos[channelId];
    rDel('wt:recent:' + channelId);
    return;
  }

  // Step 3: If feed says UPCOMING — note it, no API call needed
  if (feedIsUpcoming) {
    console.log('[WebSub] ' + channelId + ' has upcoming stream (0 units)');
    delete cache.recentVideos[channelId];
    rDel('wt:recent:' + channelId);
    return;
  }

  // Step 4: Feed is ambiguous (regular video post, no live indicator)
  // Invalidate recent video cache — content changed
  delete cache.recentVideos[channelId];
  rDel('wt:recent:' + channelId);

  // Step 5: Rate limit — skip confirmation API call if we checked this channel recently
  const lastCheck = websubLastCheck[channelId] || 0;
  const timeSinceCheck = Date.now() - lastCheck;
  const recentlyChecked = timeSinceCheck < WEBSUB_RATE_LIMIT_MS;
  if (recentlyChecked) {
    console.log('[WebSub] ' + channelId + ' posted content (checked ' + Math.round(timeSinceCheck/60000) + 'm ago — skipping confirmation)');
    return;
  }

  // Step 6: Ambiguous — use videos.list?part=liveStreamingDetails for 1 unit (not 100)
  // This checks if the specific video from the notification is an active live stream
  const liveChecksToday = getLiveChecksToday();
  if (!primaryQuotaExceeded && liveChecksToday < DAILY_LIVE_CHECK_LIMIT) {
    const key = getApiKey();
    if (key && key !== 'YOUR_YOUTUBE_API_KEY' && feedVideoId) {
      websubLastCheck[channelId] = Date.now();
      recordLiveCheck();
      trackBurn(true, 1); // videos.list costs 1 unit, not 100
      console.log('[WebSub] Live detail check (1 unit) for ' + channelId + ' video: ' + feedVideoId);
      const url = 'https://www.googleapis.com/youtube/v3/videos?key=' + key +
        '&id=' + feedVideoId + '&part=liveStreamingDetails&fields=items/liveStreamingDetails';
      ytFetch(url).then(data => {
        if (checkQuotaError(data)) { markQuotaExceeded(true); return; }
        const details = data.items && data.items[0] && data.items[0].liveStreamingDetails;
        // Active live stream: has actualStartTime but no actualEndTime
        const isLive = !!(details && details.actualStartTime && !details.actualEndTime);
        const wasLive = cache.liveStatuses[channelId] && cache.liveStatuses[channelId].isLive;
        const wsEntry = { isLive, videoId: isLive ? feedVideoId : null, checkedAt: Date.now(), source: 'websub_details' };
        cache.liveStatuses[channelId] = wsEntry;
        cache.lastLiveCheck = Date.now();
        rSet('wt:live:' + channelId, wsEntry, REDIS_TTL.liveStatus);
        rSet('wt:lastLive', cache.lastLiveCheck);
        if (isLive) updateChannelActivity(channelId, { lastLiveDate: Date.now() });
        if (isLive && !wasLive)  console.log('[WebSub] LIVE CONFIRMED (1 unit): ' + channelId);
        else if (!isLive && wasLive) console.log('[WebSub] OFFLINE: ' + channelId + ' stream ended');
        else console.log('[WebSub] ' + channelId + ' posted content (not live)');
      }).catch(e => console.error('[WebSub] Detail check error for ' + channelId + ':', e.message));
    } else if (!feedVideoId) {
      // No video ID in notification — fall back to search (100 units) as last resort
      const key = getApiKey();
      if (key && key !== 'YOUR_YOUTUBE_API_KEY') {
        websubLastCheck[channelId] = Date.now();
        recordLiveCheck();
        trackBurn(true, 100);
        console.log('[WebSub] No video ID — fallback search check for ' + channelId);
        const url = 'https://www.googleapis.com/youtube/v3/search?key=' + key +
          '&channelId=' + channelId + '&part=id&eventType=live&type=video';
        ytFetch(url).then(data => {
          if (checkQuotaError(data)) { markQuotaExceeded(true); return; }
          const isLive = !!(data.items && data.items.length > 0);
          const videoId = isLive && data.items[0].id ? data.items[0].id.videoId : null;
          const wasLive = cache.liveStatuses[channelId] && cache.liveStatuses[channelId].isLive;
          const wsEntry = { isLive, videoId, checkedAt: Date.now(), source: 'websub_search' };
          cache.liveStatuses[channelId] = wsEntry;
          cache.lastLiveCheck = Date.now();
          rSet('wt:live:' + channelId, wsEntry, REDIS_TTL.liveStatus);
          rSet('wt:lastLive', cache.lastLiveCheck);
          if (isLive) updateChannelActivity(channelId, { lastLiveDate: Date.now() });
          if (isLive && !wasLive) console.log('[WebSub] LIVE CONFIRMED (search): ' + channelId);
          else if (!isLive && wasLive) console.log('[WebSub] OFFLINE: ' + channelId);
        }).catch(e => console.error('[WebSub] Search error for ' + channelId + ':', e.message));
      }
    }
  } else {
    console.log('[WebSub] ' + channelId + ' posted — skipping check (daily limit reached or quota exceeded)');
  }
});

// Re-subscribe all channels every 8 days (before 9-day lease expires)
setInterval(() => {
  if (process.env.APP_URL) {
    console.log('[WebSub] Renewing subscriptions...');
    subscribeAllChannels();
  }
}, 8 * 24 * 60 * 60 * 1000);

// Admin endpoint to manually trigger re-subscription
app.post('/api/admin/websub/subscribe', async (req, res) => {
  if (!process.env.APP_URL) {
    return res.status(400).json({ error: 'APP_URL not configured — WebSub requires a public URL' });
  }
  await subscribeAllChannels();
  res.json({ ok: true, message: 'WebSub subscriptions renewed for all channels' });
});

// Admin endpoint to resubscribe a single channel — for fixing one FAILED row
// in the WebSub Health panel without resubscribing all 200+ channels (each
// full resubscribe takes ~500ms/channel and risks rate limiting from the hub).
app.post('/api/admin/websub/subscribe/:channelId', async (req, res) => {
  if (!process.env.APP_URL) {
    return res.status(400).json({ error: 'APP_URL not configured — WebSub requires a public URL' });
  }
  const { channelId } = req.params;
  try {
    const statusCode = await websubSubscribe(channelId);
    const lease = websubLeases[channelId];
    res.json({ ok: true, statusCode, status: lease ? lease.status : 'unknown' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Start WebSub subscriptions after boot (10s delay)
setTimeout(subscribeAllChannels, 10000);

// ════════════════════════════════════════════
// SCHEDULED RECENT VIDEO FETCHER
// Runs twice daily (noon + 6pm EST) — fetches recent videos for all channels.
// Uses playlistItems.list at 1 unit/channel (vs. search.list at 100 units).
// At 146 channels: ~146 units per run × 2 runs = ~292 units/day on primary.
// Archive key (YOUTUBE_API_KEY_2) activates only if primary quota is exceeded.
// All users served from cache — zero additional quota per request.
// ════════════════════════════════════════════

// Derive a channel's uploads playlist ID from its channel ID.
// YouTube uploads playlist is always 'UU' + channelId.slice(2)
// e.g. UCxxxxxx → UUxxxxxx — no extra API call required.
function getUploadsPlaylistId(channelId) {
  if (!channelId || !channelId.startsWith('UC')) return null;
  return 'UU' + channelId.slice(2);
}

async function fetchAllRecentVideos() {
  // Each key's quotaExceeded flag auto-clears via its own midnight-Pacific
  // timer (set in markQuotaExceeded). If BOTH keys are currently exhausted,
  // there's nothing this cycle can do -- reschedule for next time.
  if (primaryQuotaExceeded && archiveQuotaExceeded) {
    console.log('[WeatherTV] Skipping recent video fetch -- both API keys exhausted');
    scheduleNextRecentFetch();
    return;
  }

  const primaryKey = getApiKey();
  const archiveKey = getArchiveApiKey();

  const allChannels = getAllChannels();
  if (allChannels.length === 0) return;

  // Assign tiers
  const tier1 = [], tier2 = [], tier3 = [];
  for (const ch of allChannels) {
    const tier = getChannelTier(ch);
    if (tier === 1) tier1.push(ch);
    else if (tier === 2) tier2.push(ch);
    else tier3.push(ch);
  }

  // Stagger Tier 2 and Tier 3 using day of year -- 7-day natural offset between them
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  const fetchTier2Today = dayOfYear % 2 === 0;
  const fetchTier3Today = dayOfYear % 2 === 1;

  const tier2Due = fetchTier2Today ? tier2.filter(ch => shouldFetchTodayByTier(ch, 2)) : [];
  const tier3Due = fetchTier3Today ? tier3.filter(ch => shouldFetchTodayByTier(ch, 3)) : [];

  // Extend TTL on inactive channels not being fetched today
  const notFetchingToday = [
    ...(fetchTier2Today ? [] : tier2),
    ...(fetchTier3Today ? [] : tier3),
    ...(fetchTier2Today ? tier2.filter(ch => !shouldFetchTodayByTier(ch, 2)) : []),
    ...(fetchTier3Today ? tier3.filter(ch => !shouldFetchTodayByTier(ch, 3)) : []),
  ];
  for (const ch of notFetchingToday) {
    if (cache.recentVideos[ch.id] && cache.recentVideos[ch.id].items) {
      await rSet('wt:recent:' + ch.id, cache.recentVideos[ch.id], REDIS_TTL.recentVideosInactive);
    }
  }

  // Tier 1 first (priority), then due Tier 2 and 3 -- alternate A-Z / Z-A daily
  const priorityChannels = getChannelFetchOrder([...tier1, ...tier2Due, ...tier3Due]);

  console.log('[WeatherTV] Fetch -- Tier1: ' + tier1.length +
    ', Tier2 today: ' + tier2Due.length + '/' + tier2.length +
    ', Tier3 today: ' + tier3Due.length + '/' + tier3.length +
    ' | Order: ' + (dayOfYear % 2 === 0 ? 'A to Z' : 'Z to A'));

  let fetched = 0, skipped = 0;
  const fetchedIds = new Set();

  for (let i = 0; i < priorityChannels.length; i++) {
    const ch = priorityChannels[i];

    // Use primary key; fall back to archive key if primary is exhausted
    let useKey = null;
    let isPrimary = true;
    if (!primaryQuotaExceeded && primaryKey && primaryKey !== 'YOUR_YOUTUBE_API_KEY') {
      useKey = primaryKey;
      isPrimary = true;
    } else if (!archiveQuotaExceeded && archiveKey && archiveKey !== 'YOUR_YOUTUBE_API_KEY' && archiveKey !== primaryKey) {
      useKey = archiveKey;
      isPrimary = false;
      if (i === 0) console.warn('[WeatherTV] Primary key exhausted — falling back to archive key for recent fetch');
    }

    if (!useKey) {
      skipped++;
      continue;
    }

    // Use playlistItems.list (1 unit) via the channel's uploads playlist
    // instead of search.list (100 units) — 100x more efficient.
    const playlistId = getUploadsPlaylistId(ch.id);
    if (!playlistId) {
      skipped++;
      console.warn('[WeatherTV] Cannot derive uploads playlist for ' + ch.id + ' — skipping');
      continue;
    }

    try {
      const url = 'https://www.googleapis.com/youtube/v3/playlistItems?key=' + useKey +
        '&playlistId=' + playlistId + '&part=snippet&maxResults=10';
      const data = await ytFetch(url);

      if (checkQuotaError(data)) {
        markQuotaExceeded(isPrimary);
        skipped++;
        console.warn('[WeatherTV] ' + (isPrimary ? 'Primary' : 'Archive') + ' key quota hit at channel ' + (i + 1) + '/' + priorityChannels.length);
        continue;
      }

      trackBurn(isPrimary, 1); // playlistItems.list costs 1 unit (vs. 100 for search.list)

      const rawItems = data.items || [];

      // Normalize playlistItems snippet to match the shape search.list returned,
      // so downstream cache consumers (recent video panel, etc.) don't need changes.
      // playlistItems snippet.resourceId.videoId → simulate id.videoId
      const newItems = rawItems.map(item => ({
        id: { videoId: item.snippet?.resourceId?.videoId || '' },
        snippet: {
          title: item.snippet?.title || '',
          description: item.snippet?.description || '',
          publishedAt: item.snippet?.publishedAt || '',
          channelTitle: item.snippet?.channelTitle || '',
          channelId: item.snippet?.channelId || ch.id,
          liveBroadcastContent: item.snippet?.liveBroadcastContent || 'none',
          thumbnails: item.snippet?.thumbnails || {},
        },
      }));

      // Free live detection from snippet data (same as before)
      const liveItem = newItems.find(item => item.snippet && item.snippet.liveBroadcastContent === 'live');
      if (liveItem) {
        const videoId = liveItem.id && liveItem.id.videoId ? liveItem.id.videoId : null;
        const liveEntry = { isLive: true, videoId, checkedAt: Date.now(), source: 'recent_fetch' };
        cache.liveStatuses[ch.id] = liveEntry;
        rSet('wt:live:' + ch.id, liveEntry, REDIS_TTL.liveStatus);
        updateChannelActivity(ch.id, { lastLiveDate: Date.now() });
        console.log('[WeatherTV] Live detected during fetch: ' + ch.id + (videoId ? ' (' + videoId + ')' : ''));
      }

      // Update last video date for tier tracking
      if (newItems.length > 0 && newItems[0].snippet && newItems[0].snippet.publishedAt) {
        const lastVideoDate = new Date(newItems[0].snippet.publishedAt).getTime();
        await updateChannelActivity(ch.id, { lastVideoDate });
      }

      const tier = getChannelTier(ch);
      const ttl = tier === 1 ? REDIS_TTL.recentVideos : REDIS_TTL.recentVideosInactive;

      if (newItems.length > 0) {
        cache.recentVideos[ch.id] = { items: newItems, cachedAt: Date.now() };
        await rSet('wt:recent:' + ch.id, cache.recentVideos[ch.id], ttl);
        if (tier !== 1) await updateChannelActivity(ch.id, { nextFetchDue: Date.now() + 14 * 86400000 });
        fetched++;
        fetchedIds.add(ch.id);
      } else if (cache.recentVideos[ch.id] && cache.recentVideos[ch.id].items && cache.recentVideos[ch.id].items.length > 0) {
        cache.recentVideos[ch.id].cachedAt = Date.now();
        await rSet('wt:recent:' + ch.id, cache.recentVideos[ch.id], ttl);
        if (tier !== 1) await updateChannelActivity(ch.id, { nextFetchDue: Date.now() + 14 * 86400000 });
        fetched++;
        fetchedIds.add(ch.id);
      } else {
        console.log('[WeatherTV] No videos found for ' + ch.id + ' -- may have wrong channel ID or empty uploads playlist');
        fetchedIds.add(ch.id);
      }

      await new Promise(r => setTimeout(r, 100)); // lighter stagger since 1-unit calls are far cheaper
    } catch(e) {
      console.error('[WeatherTV] Fetch error for ' + ch.id + ':', e.message);
      logFetchError(ch.id, ch.name, e.message);
    }
  }

  cache.lastRecentFetch = Date.now();
  await rSet('wt:lastFetch', cache.lastRecentFetch);

  // Preserve caches for any channel we didn't reach this cycle
  for (const ch of priorityChannels) {
    if (!fetchedIds.has(ch.id)) {
      const cached = cache.recentVideos[ch.id];
      if (cached && cached.items && cached.items.length > 0) {
        await rSet('wt:recent:' + ch.id, cached, REDIS_TTL.recentVideosInactive);
      }
    }
  }

  if (skipped > 0) {
    console.log('[WeatherTV] Fetch complete -- ' + fetched + '/' + priorityChannels.length + ' updated, ' + skipped + ' skipped (key quota), caches preserved');
  } else {
    console.log('[WeatherTV] Fetch complete -- ' + fetched + '/' + priorityChannels.length + ' channels updated (~' + fetched + ' units used)');
  }

  scheduleNextRecentFetch();
}
function getSecondFetchHour() {
  try {
    const cfg = loadData().config;
    if (cfg.recentFetchHour2EST !== undefined) return cfg.recentFetchHour2EST;
  } catch(e) {}
  return 18; // 6pm EST default -- catches afternoon/evening storm content and late daily forecasts
}

function scheduleNextRecentFetch() {
  const fetchHour1 = getRecentFetchHour();  // noon EST (default)
  const fetchHour2 = getSecondFetchHour();  // 6pm EST (default)

  const now = new Date();
  const estNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

  // Build candidate times for today
  const next1 = new Date(estNow); next1.setHours(fetchHour1, 0, 0, 0);
  const next2 = new Date(estNow); next2.setHours(fetchHour2, 0, 0, 0);

  // Find the next upcoming fetch time; if both have passed today, use noon tomorrow
  let nextFetch = null;
  if (estNow < next1) {
    nextFetch = next1;
  } else if (estNow < next2) {
    nextFetch = next2;
  } else {
    nextFetch = new Date(next1);
    nextFetch.setDate(nextFetch.getDate() + 1);
  }

  const msUntilNext = nextFetch - estNow;
  const minsUntilNext = Math.round(msUntilNext / 60000);
  console.log('[WeatherTV] Next recent video fetch in ' + minsUntilNext + ' minutes (' + nextFetch.getHours() + ':00 EST)');
  setTimeout(fetchAllRecentVideos, msUntilNext);
}



// ── API Routes ──

// Live status — served from cache, no API call per request
app.get('/api/yt/live/:channelId', (req, res) => {
  const cached = cache.liveStatuses[req.params.channelId];
  if (cached) {
    return res.json({
      items: cached.isLive ? [{ id: cached.videoId || 'live' }] : [],
      _cached: true,
      _checkedAt: cached.checkedAt
    });
  }
  res.json({ items: [], _cached: false });
});

// All live statuses at once — lets frontend get everything in one call
app.get('/api/yt/live-all', (req, res) => {
  const LIVE_STATUS_MAX_AGE = 12 * 60 * 60 * 1000; // 12 hours
  const now = Date.now();

  // Auto-expire stale live statuses — YouTube does not notify us when streams end.
  // Any isLive:true status older than 12 hours is assumed ended.
  // Active streams get checkedAt refreshed by WebSub notifications and the daily recent-videos fetch.
  Object.entries(cache.liveStatuses).forEach(([channelId, status]) => {
    if (status.isLive && status.checkedAt && (now - status.checkedAt) > LIVE_STATUS_MAX_AGE) {
      const hoursOld = Math.round((now - status.checkedAt) / 3600000);
      console.log('[WeatherTV] Auto-expiring stale live status for ' + channelId + ' (' + hoursOld + 'h old)');
      const expired = { isLive: false, videoId: null, checkedAt: now, source: 'auto_expired' };
      cache.liveStatuses[channelId] = expired;
      rSet('wt:live:' + channelId, expired, REDIS_TTL.liveStatus);
    }
  });

  res.json({
    statuses: cache.liveStatuses,
    lastChecked: cache.lastLiveCheck,
    lastNotification: cache.lastNotificationReceived,
    quotaExceeded: primaryQuotaExceeded // live status uses the primary key
  });
});

// Recent videos — serve from cache whenever possible; only fetch when cache is empty and quota is available
app.get('/api/yt/recent/:channelId', async (req, res) => {
  const channelId = req.params.channelId;
  const cached = cache.recentVideos[channelId];

  // Rule: old data is always better than no data.
  // Serve cached data immediately if we have it, regardless of age or quota status.
  if (cached && cached.items && cached.items.length > 0) {
    const cacheAge = Date.now() - cached.cachedAt;
    const stale = cacheAge > CACHE_TTL.recentVideos;
    // If cache is fresh or quota is exceeded, just serve it — no API call needed
    if (!stale || archiveQuotaExceeded) {
      return res.json({ items: cached.items, _cached: true, _stale: stale });
    }
    // Cache is stale but quota is available — fall through to fetch fresh data below
    // We'll still serve stale if the fresh fetch fails
  }

  // No usable cache or stale cache with quota available — try fetching fresh
  if (archiveQuotaExceeded) {
    // Empty cache, quota exceeded — nothing we can do
    return res.status(429).json({ error: 'quota_exceeded', message: 'Daily YouTube quota reached — resets at midnight Pacific' });
  }

  const key = getArchiveApiKey();
  if (!key) return res.status(500).json({ error: 'No API key configured' });

  try {
    const url = `https://www.googleapis.com/youtube/v3/search?key=${key}&channelId=${channelId}&part=snippet&order=date&type=video&maxResults=10`;
    const data = await ytFetch(url);
    if (checkQuotaError(data)) {
      markQuotaExceeded();
      // Serve stale cache if available rather than returning an error
      if (cached && cached.items && cached.items.length > 0) {
        return res.json({ items: cached.items, _cached: true, _stale: true });
      }
      return res.status(429).json({ error: 'quota_exceeded', message: 'Daily YouTube quota reached — resets at midnight Pacific' });
    }
    const newItems = data.items || [];
    if (newItems.length > 0) {
      const entry = { items: newItems, cachedAt: Date.now() };
      cache.recentVideos[channelId] = entry;
      await rSet('wt:recent:' + channelId, entry, REDIS_TTL.recentVideos);
      res.json(data);
    } else if (cached && cached.items && cached.items.length > 0) {
      res.json({ items: cached.items, _cached: true, _preserved: true });
    } else {
      res.json({ items: [] });
    }
  } catch(e) {
    // Serve stale cache on any error rather than failing completely
    if (cached && cached.items && cached.items.length > 0) {
      return res.json({ items: cached.items, _cached: true, _stale: true });
    }
    res.status(500).json({ error: e.message });
  }
});

// Playlist items — cached for 6 hours
app.get('/api/yt/playlist/:playlistId', async (req, res) => {
  const playlistId = req.params.playlistId;

  // Serve from cache if fresh
  const cached = cache.playlist[playlistId];
  if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL.playlist) {
    return res.json({ items: cached.items, _cached: true });
  }

  if (archiveQuotaExceeded) {
    return res.status(429).json({ error: 'quota_exceeded', message: 'Daily YouTube quota reached — resets at midnight Pacific' });
  }

  const key = getApiKey();
  if (!key) return res.status(500).json({ error: 'No API key configured' });

  try {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?key=${key}&playlistId=${playlistId}&part=snippet&maxResults=50`;
    const data = await ytFetch(url);
    if (checkQuotaError(data)) {
      markQuotaExceeded();
      return res.status(429).json({ error: 'quota_exceeded', message: 'Daily YouTube quota reached — resets at midnight Pacific' });
    }
    // Filter out deleted and private videos — they return with generic titles
    const allItems = data.items || [];
    const validItems = allItems.filter(item => {
      const title = item.snippet && item.snippet.title;
      if (!title) return false;
      if (title === 'Deleted video' || title === 'Private video') return false;
      // Also filter if thumbnail is missing (another sign of deleted/private)
      const thumb = item.snippet && item.snippet.thumbnails;
      if (!thumb || Object.keys(thumb).length === 0) return false;
      return true;
    });
    if (allItems.length !== validItems.length) {
      console.log('[WeatherTV] Playlist: filtered ' + (allItems.length - validItems.length) + ' deleted/private videos (' + validItems.length + ' valid)');
    }
    const plEntry = { items: validItems, cachedAt: Date.now() };
    cache.playlist[playlistId] = plEntry;
    rSet('wt:playlist:' + playlistId, plEntry, REDIS_TTL.playlist);
    res.json({ ...data, items: validItems });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Quota status
app.get('/api/yt/quota-status', (req, res) => {
  res.json({
    quotaExceeded: primaryQuotaExceeded || archiveQuotaExceeded, // combined, for back-compat
    primaryQuotaExceeded,
    archiveQuotaExceeded,
    lastLiveCheck: cache.lastLiveCheck,
    lastNotificationReceived: cache.lastNotificationReceived,
    lastRecentFetch: cache.lastRecentFetch,
    liveChecksToday: getLiveChecksToday(),
    liveCheckLimit: DAILY_LIVE_CHECK_LIMIT,
    archiveKeyConfigured: !!(process.env.YOUTUBE_API_KEY_2),
    archiveKeyRole: 'emergency-standby',
    primaryQuotaLimit: 60000,
    archiveQuotaLimit: 10000,
  });
});

// Manual trigger for live check — for diagnostics
app.post('/api/admin/trigger-live-check', async (req, res) => {
  res.json({ ok: true, message: 'Live check triggered' });
  await scheduledLiveCheck();
});

// Manual trigger for live status check
app.post('/api/admin/trigger-live-check', async (req, res) => {
  if (primaryQuotaExceeded) {
    return res.status(429).json({ error: 'quota_exceeded', message: 'Primary key quota exceeded — resets at midnight Pacific' });
  }
  const channels = getLiveChannels();
  const cost = channels.length * 100;
  res.json({ ok: true, message: 'Live check started for ' + channels.length + ' channels (~' + cost + ' units)' });
  scheduledLiveCheck(); // run in background, don't await
});

// Manual trigger for recent video fetch — use from admin panel after deploys
app.post('/api/admin/trigger-recent-fetch', async (req, res) => {
  if (primaryQuotaExceeded && archiveQuotaExceeded) {
    return res.status(429).json({ error: 'quota_exceeded', message: 'Both API keys exhausted — resets at midnight Pacific. Try again tomorrow.' });
  }
  // Double-check by testing a single API call before committing to full fetch
  const key = getApiKey();
  if (!key || key === 'YOUR_YOUTUBE_API_KEY') {
    return res.status(500).json({ error: 'No API key configured' });
  }
  logEvent({ type: 'admin', severity: 'info', source: 'admin-panel', message: 'Manual recent video fetch triggered via admin panel' });
  res.json({ ok: true, message: 'Recent video fetch started — check cache status in ~1 minute' });
  fetchAllRecentVideos(); // don't await — let it run in background
});

// Manual live override — mark a channel live when you know the video ID
// Use when a stream has been live for hours and WebSub didn't catch it

// ── Diagnostic endpoints ──────────────────────────────────────────────────────

// Server info — uptime, start time, Node version
app.get('/api/admin/server-info', (req, res) => {
  res.json({
    startTime: SERVER_START_TIME,
    uptimeMs: Date.now() - SERVER_START_TIME,
    nodeVersion: process.version,
    platform: process.platform,
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
  });
});

// Quota burn rate — units used today per key
app.get('/api/admin/quota-burn', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  res.json({
    date: burnTracker.date || today,
    primaryUnits: burnTracker.date === today ? burnTracker.primaryUnits : 0,
    archiveUnits: burnTracker.date === today ? burnTracker.archiveUnits : 0,
    primaryLimit: 10000,
    archiveLimit: process.env.YOUTUBE_API_KEY_2 ? 10000 : 0,
    liveChecksToday: getLiveChecksToday(),
    liveCheckLimit: DAILY_LIVE_CHECK_LIMIT,
  });
});

// WebSub health — per-channel subscription status and lease expiry
app.get('/api/admin/websub-health', (req, res) => {
  const channels = getAllChannels().filter(ch => ch.hasLive);
  const now = Date.now();
  const leases = channels.map(ch => {
    const lease = websubLeases[ch.id];
    const hoursUntilExpiry = lease && lease.expiresAt ? (lease.expiresAt - now) / 3600000 : null;
    return {
      id: ch.id, name: ch.name,
      status: lease ? lease.status : 'unknown',
      subscribedAt: lease ? lease.subscribedAt : null,
      expiresAt: lease ? lease.expiresAt : null,
      hoursUntilExpiry: hoursUntilExpiry !== null ? Math.round(hoursUntilExpiry * 10) / 10 : null,
      expiringSoon: hoursUntilExpiry !== null && hoursUntilExpiry < 24,
      expired: hoursUntilExpiry !== null && hoursUntilExpiry < 0,
    };
  });
  leases.sort((a, b) => (a.hoursUntilExpiry ?? 999) - (b.hoursUntilExpiry ?? 999));
  res.json({
    total: channels.length,
    active: leases.filter(l => l.status === 'active').length,
    failed: leases.filter(l => l.status === 'failed' || l.status === 'error').length,
    unknown: leases.filter(l => l.status === 'unknown').length,
    expiringSoon: leases.filter(l => l.expiringSoon && !l.expired).length,
    leases,
  });
});

// Event log (errors, quota hits, fetches, admin actions)
app.get('/api/admin/fetch-errors', (req, res) => {
  const { type, severity } = req.query;
  let entries = eventLog;
  if (type) entries = entries.filter(e => e.type === type);
  if (severity) entries = entries.filter(e => e.severity === severity);
  // Back-compat: also expose as `errors` for old callers
  res.json({ errors: entries, events: entries, total: entries.length });
});

// View recent videos cache without triggering a fetch
app.get('/api/admin/cache/recent/view', (req, res) => {
  const summary = [];
  for (const [channelId, data] of Object.entries(cache.recentVideos)) {
    if (!data || !data.items) continue;
    const ch = getAllChannels().find(c => c.id === channelId);
    summary.push({
      channelId,
      channelName: ch ? ch.name : channelId,
      group: ch ? ch.group : 'unknown',
      videoCount: data.items.length,
      cachedAt: data.cachedAt || null,
      videos: data.items.slice(0, 3).map(v => ({ id: v.id?.videoId || v.id, title: v.snippet?.title, published: v.snippet?.publishedAt })),
    });
  }
  summary.sort((a, b) => (b.cachedAt || 0) - (a.cachedAt || 0));
  res.json({ channels: summary, total: summary.length, generatedAt: Date.now() });
});

// Redis memory usage
app.get('/api/admin/redis-memory', async (req, res) => {
  if (!redis) return res.json({ available: false, message: 'Redis not configured' });
  try {
    const info = await redis.info('memory');
    const lines = info.split('\r\n');
    const get = key => { const l = lines.find(x => x.startsWith(key + ':')); return l ? l.split(':')[1].trim() : null; };
    res.json({
      available: true,
      usedMemoryHuman: get('used_memory_human'),
      usedMemoryPeakHuman: get('used_memory_peak_human'),
      usedMemoryBytes: parseInt(get('used_memory') || '0'),
      maxMemoryBytes: parseInt(get('maxmemory') || '0'),
      maxMemoryHuman: get('maxmemory_human'),
      keyCount: await redis.dbsize(),
    });
  } catch(e) { res.json({ available: false, error: e.message }); }
});

// Channel ID validator
app.post('/api/admin/validate-channel', async (req, res) => {
  const { channelId } = req.body || {};
  if (!channelId) return res.status(400).json({ error: 'channelId required' });
  const key = getApiKey();
  if (!key || key === 'YOUR_YOUTUBE_API_KEY') return res.status(500).json({ error: 'No API key configured' });
  try {
    trackBurn(true, 1);
    const url = 'https://www.googleapis.com/youtube/v3/channels?key=' + key +
      '&id=' + channelId + '&part=snippet&fields=items/snippet/title,items/snippet/thumbnails,items/snippet/customUrl';
    const data = await ytFetch(url);
    if (checkQuotaError(data)) { markQuotaExceeded(); return res.status(429).json({ error: 'quota_exceeded' }); }
    if (!data.items || data.items.length === 0) return res.json({ valid: false, error: 'Channel not found — check the channel ID' });
    const s = data.items[0].snippet;
    res.json({ valid: true, name: s.title, customUrl: s.customUrl || null,
      thumbnail: s.thumbnails ? (s.thumbnails.default || s.thumbnails.medium || {}).url : null });
  } catch(e) { res.json({ valid: false, error: e.message }); }
});

// Live stream lookup — check if a channel is currently live and optionally mark it
app.post('/api/admin/lookup-live', async (req, res) => {
  const { channelId, markLive } = req.body || {};
  if (!channelId) return res.status(400).json({ error: 'channelId required' });
  const key = getApiKey();
  if (!key || key === 'YOUR_YOUTUBE_API_KEY') return res.status(500).json({ error: 'No API key configured' });
  if (primaryQuotaExceeded) return res.status(429).json({ error: 'quota_exceeded' });
  try {
    trackBurn(true, 100);
    recordLiveCheck();
    const url = 'https://www.googleapis.com/youtube/v3/search?key=' + key +
      '&channelId=' + channelId + '&part=id,snippet&eventType=live&type=video&maxResults=1';
    const data = await ytFetch(url);
    if (checkQuotaError(data)) { markQuotaExceeded(); return res.status(429).json({ error: 'quota_exceeded' }); }
    const isLive = !!(data.items && data.items.length > 0);
    const videoId = isLive && data.items[0].id ? data.items[0].id.videoId : null;
    const title = isLive && data.items[0].snippet ? data.items[0].snippet.title : null;
    if (markLive && isLive && videoId) {
      const entry = { isLive: true, videoId, checkedAt: Date.now(), source: 'admin_lookup' };
      cache.liveStatuses[channelId] = entry;
      await rSet('wt:live:' + channelId, entry, REDIS_TTL.liveStatus);
      await updateChannelActivity(channelId, { lastLiveDate: Date.now() });
      cache.lastLiveCheck = Date.now();
      rSet('wt:lastLive', cache.lastLiveCheck);
    } else if (!isLive) {
      const entry = { isLive: false, videoId: null, checkedAt: Date.now(), source: 'admin_lookup' };
      cache.liveStatuses[channelId] = entry;
      await rSet('wt:live:' + channelId, entry, REDIS_TTL.liveStatus);
      cache.lastLiveCheck = Date.now();
      rSet('wt:lastLive', cache.lastLiveCheck);
    }
    res.json({ isLive, videoId, title, channelId, marked: !!(markLive && isLive) });
  } catch(e) { res.json({ isLive: false, error: e.message }); }
});

app.post('/api/admin/mark-live', async (req, res) => {
  const { channelId, videoId } = req.body || {};
  if (!channelId) return res.status(400).json({ error: 'channelId required' });
  const entry = { isLive: true, videoId: videoId || null, checkedAt: Date.now(), source: 'manual' };
  cache.liveStatuses[channelId] = entry;
  await rSet('wt:live:' + channelId, entry, REDIS_TTL.liveStatus);
  await updateChannelActivity(channelId, { lastLiveDate: Date.now() });
  console.log('[Admin] Manually marked live: ' + channelId + (videoId ? ' video: ' + videoId : ''));
  res.json({ ok: true, channelId, videoId, message: 'Channel marked live' });
});

// Manual clear-live — mark a channel offline
app.post('/api/admin/mark-offline', async (req, res) => {
  const { channelId } = req.body || {};
  if (!channelId) return res.status(400).json({ error: 'channelId required' });
  const entry = { isLive: false, videoId: null, checkedAt: Date.now(), source: 'manual' };
  cache.liveStatuses[channelId] = entry;
  await rSet('wt:live:' + channelId, entry, REDIS_TTL.liveStatus);
  console.log('[Admin] Manually marked offline: ' + channelId);
  res.json({ ok: true, channelId, message: 'Channel marked offline' });
});

// Channel health report — full per-channel diagnostic for admin panel
app.get('/api/admin/channel-health', (req, res) => {
  const channels = getAllChannels();
  const now = Date.now();

  const report = channels.map(ch => {
    const act = cache.channelActivity[ch.id] || {};
    const live = cache.liveStatuses[ch.id] || {};
    const recent = cache.recentVideos[ch.id] || {};
    const tier = getChannelTier(ch);
    const onSkip = tier !== 1 && act.nextFetchDue && now < act.nextFetchDue;

    return {
      id: ch.id,
      name: ch.name,
      group: ch.group || '',
      hasLive: !!ch.hasLive,
      tier,
      lastLiveDate: act.lastLiveDate || null,
      lastVideoDate: act.lastVideoDate || null,
      lastFetchDate: recent.cachedAt || null,
      lastLiveCheck: live.checkedAt || null,
      liveCheckSource: live.source || null,
      nextFetchDue: act.nextFetchDue || null,
      isCurrentlyLive: !!live.isLive,
      onLiveSkip: tier === 2 && onSkip,
      onVideoSkip: tier === 3 && onSkip,
      hasRecentCache: !!(recent.items && recent.items.length > 0),
    };
  });

  report.sort((a, b) => a.name.localeCompare(b.name));
  res.json({
    channels: report,
    generatedAt: now,
    summary: {
      total: report.length,
      tier1: report.filter(c => c.tier === 1).length,
      tier2: report.filter(c => c.tier === 2).length,
      tier3: report.filter(c => c.tier === 3).length,
      live: report.filter(c => c.isCurrentlyLive).length,
      noCache: report.filter(c => !c.hasRecentCache).length,
      liveChecksToday: getLiveChecksToday(),
      liveCheckLimit: DAILY_LIVE_CHECK_LIMIT,
      quotaExceeded: primaryQuotaExceeded || archiveQuotaExceeded,
      primaryQuotaExceeded,
      archiveQuotaExceeded,
      lastNotification: cache.lastNotificationReceived,
      lastLiveCheck: cache.lastLiveCheck,
      lastVideoFetch: cache.lastRecentFetch,
      archiveKeyConfigured: !!(process.env.YOUTUBE_API_KEY_2),
    }
  });
});
app.get('/api/admin/test-connectivity', async (req, res) => {
  const testUrl = key => 'https://www.googleapis.com/youtube/v3/channels?key=' + key +
    '&id=UCvBVK2ymNzPLRJrgip2GeQQ&part=snippet&fields=items/snippet/title';
  const primaryKey = getApiKey();
  const archiveKey = process.env.YOUTUBE_API_KEY_2;
  const testKey = async (key, label) => {
    if (!key || key === 'YOUR_YOUTUBE_API_KEY') return { ok: false, label, error: 'Not configured' };
    try {
      const data = await ytFetch(testUrl(key));
      if (checkQuotaError(data)) return { ok: false, label, error: 'Quota exceeded' };
      const title = data.items && data.items[0] && data.items[0].snippet && data.items[0].snippet.title;
      return { ok: true, label, channel: title || 'Connected' };
    } catch(e) { return { ok: false, label, error: e.message }; }
  };
  const [primary, archive] = await Promise.all([
    testKey(primaryKey, 'Primary (Live)'),
    archiveKey
      ? testKey(archiveKey, 'Archive (Videos)')
      : Promise.resolve({ ok: null, label: 'Archive (Videos)', error: 'YOUTUBE_API_KEY_2 not set — using primary key as fallback' }),
  ]);
  res.json({ primary, archive });
});

// Cache management — admin only
app.post('/api/admin/cache/clear-playlist', async (req, res) => {
  cache.playlist = {};
  const plKeys = await rKeys('wt:playlist:*');
  for (const key of plKeys) await rDel(key);
  console.log('[WeatherTV] Playlist cache cleared by admin');
  res.json({ ok: true, message: 'Playlist cache cleared — will fetch fresh on next request' });
});

app.post('/api/admin/cache/clear-recent', async (req, res) => {
  cache.recentVideos = {};
  const keys = await rKeys('wt:recent:*');
  for (const key of keys) await rDel(key);
  console.log('[WeatherTV] Recent videos cache cleared by admin');
  res.json({ ok: true, message: 'Recent videos cache cleared — will fetch fresh on next request' });
});

function getCacheStatus() {
  const playlistCached = Object.keys(cache.playlist).length;
  const recentCached = Object.keys(cache.recentVideos).length;
  const liveCached = Object.keys(cache.liveStatuses).length;

  // Derive lastFetch from most recently cached video if global timestamp is missing
  let lastFetch = cache.lastRecentFetch;
  if (!lastFetch && recentCached > 0) {
    const timestamps = Object.values(cache.recentVideos)
      .map(v => v.cachedAt).filter(Boolean);
    if (timestamps.length > 0) lastFetch = Math.max(...timestamps);
  }

  // Derive lastLiveCheck from most recently checked live status if global is missing
  let lastLiveCheck = cache.lastLiveCheck;
  if (!lastLiveCheck && liveCached > 0) {
    const timestamps = Object.values(cache.liveStatuses)
      .map(v => v.checkedAt).filter(Boolean);
    if (timestamps.length > 0) lastLiveCheck = Math.max(...timestamps);
  }

  return {
    playlist: { entries: playlistCached, ttlHours: 48 },
    recentVideos: { entries: recentCached, ttlHours: 168, lastFetch },
    liveStatuses: {
      entries: liveCached,
      lastChecked: lastLiveCheck,
      lastNotification: cache.lastNotificationReceived,
    },
    websubActive: cache.websubActive,
    quotaExceeded: primaryQuotaExceeded || archiveQuotaExceeded,
    primaryQuotaExceeded,
    archiveQuotaExceeded,
    liveChecksToday: getLiveChecksToday(),
    liveCheckLimit: DAILY_LIVE_CHECK_LIMIT,
    archiveKeyConfigured: !!(process.env.YOUTUBE_API_KEY_2),
  };
}

app.get('/api/admin/cache/status', (req, res) => {
  res.json(getCacheStatus());
});

// Public, read-only mirror of the cache status above — the main site's
// status bar (live/video update times, notification time) polls this on
// every page load. It MUST NOT be under /api/admin: that path requires
// HTTP Basic Auth, and a 401 response with WWW-Authenticate triggers the
// browser's native login prompt on first page load for ALL visitors.
// Same read-only data, no admin actions exposed.
app.get('/api/cache/status', (req, res) => {
  res.json(getCacheStatus());
});

// ── WS4KP static data — must be before catch-all ──
// WS4KP fetches these as absolute paths (/data/..., /scripts/...)
// regardless of where it's hosted, so we intercept here.
app.use('/data', express.static(path.join(__dirname, 'public', 'weatherstar', 'data')));
app.use('/scripts', express.static(path.join(__dirname, 'public', 'weatherstar', 'scripts')));

// ── WS4KP Local Radar background tiles ─────────────────────────────────────
// radar-tiles.mjs is the ONE place in WS4KP that uses an ABSOLUTE path
// (`/images/maps/radar/...`) instead of a relative one. Every other image
// reference is relative (resolves correctly to /weatherstar/images/...).
// This absolute path resolves to the site ROOT instead, hitting the
// ── Lightning Strike Relay ─────────────────────────────────────────────────────
// Maintains a single persistent WebSocket connection to lightningmaps.org
// (Blitzortung network). Clients poll /api/lightning — no Blitzortung servers
// are ever hit by browsers. Rolling 10-minute buffer, max 10,000 strikes.
// Attribution: Lightning data © Blitzortung.org and contributors (CC BY-SA 4.0)

// Blitzortung WebSocket relay — updated protocol (2024+):
//   URL:       wss://ws{N}.blitzortung.org  (port 443, standard)
//   Handshake: send {"a": 111} on open — without this, server sends nothing
//   Encoding:  LZW-compressed — must decode before JSON.parse
// Server IDs confirmed active: 1, 2, 7, 8
// Source: https://www.gkbrk.com/blitzortung + https://www.limaps.org/live-data.html
const LIGHTNING_SERVER_IDS = [1, 2, 7, 8];
const LIGHTNING_MAX_AGE_MS = 10 * 60 * 1000;
const LIGHTNING_MAX_STRIKES = 10000;

let _lightningBuffer = [];
let _lightningConnected = false;
let _lightningWS = null;

// LZW decompression — Blitzortung obfuscates their WebSocket stream with this.
// Ported from the Python decoder at https://www.gkbrk.com/blitzortung
function blitzortungDecode(raw) {
  const str = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
  if (!str.length) return null;
  const d = [...str];
  const e = {};
  let c = d[0], f = c;
  const g = [c];
  const h = 256;
  let o = h;
  for (let i = 1; i < d.length; i++) {
    const code = d[i].charCodeAt(0);
    let a = code < h ? d[i] : (e[code] !== undefined ? e[code] : f + c);
    g.push(a);
    c = a[0];
    e[o++] = f + c;
    f = a;
  }
  return g.join('');
}

function startLightningRelay() {
  function connect() {
    const id = LIGHTNING_SERVER_IDS[Math.floor(Math.random() * LIGHTNING_SERVER_IDS.length)];
    const url = `wss://ws${id}.blitzortung.org/`;
    console.log(`[Lightning] Connecting to ${url}`);

    _lightningWS = new WebSocket(url, {
      headers: {
        'User-Agent': 'WeatherTV/1.0 (+https://watchweathertv.com)',
        'Origin': 'https://www.blitzortung.org',
      },
    });

    _lightningWS.on('open', () => {
      _lightningConnected = true;
      console.log('[Lightning] Connected — streaming strikes');
      // Required handshake — server sends nothing until it receives this
      _lightningWS.send(JSON.stringify({ a: 111 }));
    });

    _lightningWS.on('message', raw => {
      try {
        const decoded = blitzortungDecode(raw);
        if (!decoded) return;
        const msg = JSON.parse(decoded);
        const now = Date.now();

        if (msg.lat !== undefined && msg.lon !== undefined) {
          const lat = +msg.lat, lon = +msg.lon;
          if (!isNaN(lat) && !isNaN(lon)) {
            _lightningBuffer.push({ ts: now, lat, lon });
            const cutoff = now - LIGHTNING_MAX_AGE_MS;
            if (_lightningBuffer.length > LIGHTNING_MAX_STRIKES ||
                (_lightningBuffer[0]?.ts ?? now) < cutoff) {
              _lightningBuffer = _lightningBuffer.filter(s => s.ts > cutoff);
              if (_lightningBuffer.length > LIGHTNING_MAX_STRIKES) {
                _lightningBuffer = _lightningBuffer.slice(-LIGHTNING_MAX_STRIKES);
              }
            }
          }
        }
      } catch(e) { /* ignore malformed / non-strike messages */ }
    });

    _lightningWS.on('close', (code, reason) => {
      _lightningConnected = false;
      const delay = 5000 + Math.random() * 5000;
      console.log(`[Lightning] Disconnected (code=${code}) from ${url} — retrying in ${Math.round(delay / 1000)}s`);
      setTimeout(connect, delay);
    });

    _lightningWS.on('error', e => {
      console.warn(`[Lightning] WS error on ${url}:`, e.message, e.code || '');
    });
  }

  connect();
}

// Start relay immediately on server startup
startLightningRelay();

// GET /api/lightning — GeoJSON FeatureCollection of recent strikes
// Each feature's `age` property (ms) drives the client-side fade animation.
app.get('/api/lightning', (req, res) => {
  const now = Date.now();
  const cutoff = now - LIGHTNING_MAX_AGE_MS;
  const strikes = _lightningBuffer.filter(s => s.ts > cutoff);

  res.set('Cache-Control', 'no-store');
  res.json({
    type: 'FeatureCollection',
    connected: _lightningConnected,
    count: strikes.length,
    generatedAt: now,
    features: strikes.map(s => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { ts: s.ts, age: now - s.ts },
    })),
  });
});

// catch-all and returning index.html — hence the broken map tiles on the
// Local Radar display. Map it directly to where the files actually live.
app.use('/images/maps/radar', express.static(path.join(__dirname, 'public', 'weatherstar', 'images', 'maps', 'radar')));

// ── WS4KP icon fallback ───────────────────────────────────────────────────────
// Weather condition GIFs are large binary assets; if missing locally, redirect to
// Matt's server. Strip the /weatherstar/ path prefix — Matt serves at /images/...
app.get('/weatherstar/images/*', (req, res) => {
  const imagePath = req.path.replace(/^\/weatherstar/, '');
  res.redirect(302, `https://weatherstar.netbymatt.com${imagePath}`);
});

// ── Serve index for all other routes ──
// Mount radar push notification routes BEFORE the catch-all —
// radar.js registers GET routes that would otherwise be swallowed by app.get('*')
radar.routes(app);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── HTTP server + Lightning WebSocket proxy ────────────────────────────────
// Blitzortung's policy requires third-party apps to proxy data through their
// own server rather than having browsers connect to Blitzortung directly.
// We maintain ONE upstream Blitzortung connection and fan strike data out to
// all connected WeatherTV browsers simultaneously.
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/lightning' });

let blitzSocket = null;
let blitzPending = false;
let blitzClients = new Set();
let blitzEndpointIdx = 0;
let blitzRetryTimer = null;

const BLITZ_ENDPOINTS = [
  'wss://ws.blitzortung.org/',
  'wss://ws1.blitzortung.org/',
  'wss://ws8.blitzortung.org/',
];

function connectBlitz() {
  if (blitzSocket || blitzPending) return;
  if (blitzClients.size === 0) return;
  blitzPending = true;
  const url = BLITZ_ENDPOINTS[blitzEndpointIdx % BLITZ_ENDPOINTS.length];
  console.log(`[Lightning] Connecting to ${url} (${blitzClients.size} clients waiting)`);
  try {
    const ws = new WebSocket(url);
    ws.on('open', () => {
      blitzPending = false;
      blitzSocket = ws;
      blitzEndpointIdx = 0;
      ws.send(JSON.stringify({ a: 111 }));
      console.log('[Lightning] Connected to Blitzortung');
    });
    ws.on('message', (data) => {
      const msg = data.toString();
      blitzClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          try { client.send(msg); } catch(e) {}
        }
      });
    });
    ws.on('error', (err) => {
      blitzPending = false;
      blitzSocket = null;
      console.warn('[Lightning] Blitzortung error:', err.message);
      scheduleBlitzReconnect();
    });
    ws.on('close', () => {
      blitzPending = false;
      blitzSocket = null;
      if (blitzClients.size > 0) {
        console.log('[Lightning] Blitzortung disconnected — reconnecting');
        scheduleBlitzReconnect();
      }
    });
  } catch(e) {
    blitzPending = false;
    scheduleBlitzReconnect();
  }
}

function scheduleBlitzReconnect() {
  if (blitzRetryTimer) return;
  blitzEndpointIdx++;
  const delay = Math.min(30000, 3000 * Math.pow(1.5, Math.min(blitzEndpointIdx, 8)));
  blitzRetryTimer = setTimeout(() => { blitzRetryTimer = null; connectBlitz(); }, delay);
}

function disconnectBlitz() {
  if (blitzRetryTimer) { clearTimeout(blitzRetryTimer); blitzRetryTimer = null; }
  if (blitzSocket) { try { blitzSocket.close(); } catch(e) {} blitzSocket = null; }
  blitzPending = false;
}

wss.on('connection', (clientWs) => {
  blitzClients.add(clientWs);
  console.log(`[Lightning] Browser connected (${blitzClients.size} total)`);
  connectBlitz();
  clientWs.on('close', () => {
    blitzClients.delete(clientWs);
    console.log(`[Lightning] Browser disconnected (${blitzClients.size} remaining)`);
    if (blitzClients.size === 0) {
      console.log('[Lightning] No clients — closing Blitzortung connection');
      disconnectBlitz();
    }
  });
  clientWs.on('error', () => blitzClients.delete(clientWs));
});

// Listen on 0.0.0.0 so Railway can reach the server
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`WeatherTV server running on port ${PORT}`);
  console.log(`App: http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);

  // Init radar module with Redis client once server is up
  if (redis) {
    radar.init(redis);
  } else {
    console.warn('[Radar] Redis not available — push notifications disabled');
  }
});
