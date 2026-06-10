// WeatherTV Server — updated 2026-05-31 build.1780105000
const express = require('express');
const cors = require('cors');
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

app.use(cors());
app.use(express.json());

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

app.use(express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

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
      recentFetchHourEST: 18,       // hour (0-23) in EST to fetch recent videos daily
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
app.post('/api/admin/restore', express.json({ limit: '5mb' }), async (req, res) => {
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
  const data = loadData();
  data.apps = req.body;
  saveData(data);
  res.json({ ok: true });
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
let quotaExceeded = false;
let quotaResetTimer = null;

function markQuotaExceeded() {
  if (quotaExceeded) return;
  quotaExceeded = true;
  console.warn('[WeatherTV] YouTube quota exceeded — pausing API calls until midnight Pacific');
  const now = new Date();
  const pacific = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const midnight = new Date(pacific);
  midnight.setHours(24, 0, 30, 0);
  const msUntilReset = midnight - pacific;
  console.log(`[WeatherTV] Quota will reset in ${Math.round(msUntilReset / 60000)} minutes`);
  if (quotaResetTimer) clearTimeout(quotaResetTimer);
  quotaResetTimer = setTimeout(() => {
    quotaExceeded = false;
    console.log('[WeatherTV] Quota reset — resuming API calls');
    // Kick off a fresh live check cycle after reset
    scheduledLiveCheck();
  }, msUntilReset);
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

// ── WebSub subscription lease tracker ───────────────────────────────────────
// Tracks per-channel subscription status and lease expiry.
const websubLeases = {}; // { channelId: { subscribedAt, expiresAt, status } }

// ── Failed fetch error log ────────────────────────────────────────────────────
// Circular buffer of last 50 fetch errors — visible in admin panel.
const fetchErrorLog = [];
const MAX_FETCH_ERRORS = 50;

function logFetchError(channelId, channelName, errorMsg) {
  fetchErrorLog.unshift({ channelId, channelName, error: errorMsg, timestamp: Date.now() });
  if (fetchErrorLog.length > MAX_FETCH_ERRORS) fetchErrorLog.pop();
}

// ── Daily live-check quota tracker ──────────────────────────────────────────
// Each WebSub-triggered check now uses videos.list (1 unit) not search (100 units).
// Cap raised to 500 checks/day = ~500 units max (vs old 40 × 100 = 4,000 units).
// The 100-unit search fallback (no video ID) still counts against this limit.
const quotaTracker = { date: "", liveChecks: 0 };
const DAILY_LIVE_CHECK_LIMIT = 500;

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
  return 18; // 6pm EST default
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
  if (checkQuotaError(data)) { markQuotaExceeded(); throw new Error('quota_exceeded'); }
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
  if (quotaExceeded) {
    console.log('[WeatherTV] Skipping live check — quota exceeded');
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
    if (quotaExceeded) return;
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
      if (quotaExceeded) break;
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
      websubLeases[channelId] = {
        subscribedAt: now,
        expiresAt: now + WEBSUB_LEASE * 1000,
        status,
        statusCode: res.statusCode,
      };
      console.log('[WebSub] Subscribe response for ' + channelId + ': ' + res.statusCode);
      resolve(res.statusCode);
    });
    req.on('error', e => {
      websubLeases[channelId] = { subscribedAt: Date.now(), expiresAt: null, status: 'error', error: e.message };
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
  console.log('[WebSub] Subscribing ' + channels.length + ' channels...');

  for (const ch of channels) {
    try {
      await websubSubscribe(ch.id);
      await new Promise(r => setTimeout(r, 500));
    } catch(e) {
      console.error('[WebSub] Subscribe error for ' + ch.name + ':', e.message);
    }
  }

  cache.websubActive = true;
  rSet('wt:websubActive', true);
  console.log('[WebSub] All channels subscribed — push notifications active');
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
  if (!quotaExceeded && liveChecksToday < DAILY_LIVE_CHECK_LIMIT) {
    const key = getApiKey();
    if (key && key !== 'YOUR_YOUTUBE_API_KEY' && feedVideoId) {
      websubLastCheck[channelId] = Date.now();
      recordLiveCheck();
      trackBurn(true, 1); // videos.list costs 1 unit, not 100
      console.log('[WebSub] Live detail check (1 unit) for ' + channelId + ' video: ' + feedVideoId);
      const url = 'https://www.googleapis.com/youtube/v3/videos?key=' + key +
        '&id=' + feedVideoId + '&part=liveStreamingDetails&fields=items/liveStreamingDetails';
      ytFetch(url).then(data => {
        if (checkQuotaError(data)) { markQuotaExceeded(); return; }
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
          if (checkQuotaError(data)) { markQuotaExceeded(); return; }
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

// Start WebSub subscriptions after boot (10s delay)
setTimeout(subscribeAllChannels, 10000);

// ════════════════════════════════════════════
// SCHEDULED RECENT VIDEO FETCHER
// Runs once daily at 6pm EST — fetches recent videos for all channels.
// Costs 100 units per channel, once daily = ~5,300 units/day for 53 channels.
// All users served from cache — zero additional quota per request.
// ════════════════════════════════════════════
async function fetchAllRecentVideos() {
  // Auto-clear quota flag if it is a new day
  if (quotaExceeded) {
    const today = new Date().toISOString().split('T')[0];
    if (quotaTracker.date && quotaTracker.date < today) {
      console.log('[WeatherTV] New day -- clearing quota exceeded flag');
      quotaExceeded = false;
    } else {
      console.log('[WeatherTV] Skipping recent video fetch -- quota exceeded');
      scheduleNextRecentFetch();
      return;
    }
  }

  const key = getArchiveApiKey();
  if (!key || key === 'YOUR_YOUTUBE_API_KEY') return;

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

  let fetched = 0, quotaHit = false;

  for (const ch of priorityChannels) {
    try {
      const url = 'https://www.googleapis.com/youtube/v3/search?key=' + key +
        '&channelId=' + ch.id + '&part=snippet&order=date&type=video&maxResults=10';
      const data = await ytFetch(url);

      if (checkQuotaError(data)) {
        markQuotaExceeded();
        quotaHit = true;
        console.warn('[WeatherTV] Quota hit after ' + fetched + ' channels -- preserving all existing caches');
        break;
      }

      trackBurn(false, 100); // archive key, 100 units per channel

      const newItems = data.items || [];

      // Free live detection from snippet data
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
      } else if (cache.recentVideos[ch.id] && cache.recentVideos[ch.id].items && cache.recentVideos[ch.id].items.length > 0) {
        cache.recentVideos[ch.id].cachedAt = Date.now();
        await rSet('wt:recent:' + ch.id, cache.recentVideos[ch.id], ttl);
        if (tier !== 1) await updateChannelActivity(ch.id, { nextFetchDue: Date.now() + 14 * 86400000 });
        fetched++;
      } else {
        console.log('[WeatherTV] No videos found for ' + ch.id + ' -- may have wrong channel ID');
      }

      await new Promise(r => setTimeout(r, 200));
    } catch(e) {
      console.error('[WeatherTV] Fetch error for ' + ch.id + ':', e.message);
      logFetchError(ch.id, ch.name, e.message);
    }
  }

  if (!quotaHit) {
    cache.lastRecentFetch = Date.now();
    await rSet('wt:lastFetch', cache.lastRecentFetch);
    console.log('[WeatherTV] Fetch complete -- ' + fetched + '/' + priorityChannels.length + ' channels updated');
  } else {
    // Preserve caches for channels we did not reach -- never let data expire due to quota cuts
    const fetchedIds = new Set(priorityChannels.slice(0, fetched).map(c => c.id));
    for (const ch of priorityChannels) {
      if (!fetchedIds.has(ch.id)) {
        const cached = cache.recentVideos[ch.id];
        if (cached && cached.items && cached.items.length > 0) {
          await rSet('wt:recent:' + ch.id, cached, REDIS_TTL.recentVideosInactive);
        }
      }
    }
    console.log('[WeatherTV] Partial fetch -- ' + fetched + '/' + priorityChannels.length + ' updated, remaining caches preserved');
  }

  scheduleNextRecentFetch();
}
function scheduleNextRecentFetch() {
  // Schedule for next fetch hour EST (default 6pm, configurable via admin)
  const fetchHour = getRecentFetchHour();
  const now = new Date();
  const estNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const next = new Date(estNow);
  next.setHours(fetchHour, 0, 0, 0);

  // If 6pm EST has already passed today, schedule for tomorrow
  if (estNow >= next) {
    next.setDate(next.getDate() + 1);
  }

  // Convert back to UTC ms offset
  const msUntilNext = next - estNow;
  const minsUntilNext = Math.round(msUntilNext / 60000);
  console.log('[WeatherTV] Next recent video fetch in ' + minsUntilNext + ' minutes (' + fetchHour + ':00 EST)');
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
  // Active streams get checkedAt refreshed by WebSub notifications and the 6pm fetch.
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
    quotaExceeded
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
    if (!stale || quotaExceeded) {
      return res.json({ items: cached.items, _cached: true, _stale: stale });
    }
    // Cache is stale but quota is available — fall through to fetch fresh data below
    // We'll still serve stale if the fresh fetch fails
  }

  // No usable cache or stale cache with quota available — try fetching fresh
  if (quotaExceeded) {
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

  if (quotaExceeded) {
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
    quotaExceeded,
    lastLiveCheck: cache.lastLiveCheck,
    lastNotificationReceived: cache.lastNotificationReceived,
    lastRecentFetch: cache.lastRecentFetch,
    liveChecksToday: getLiveChecksToday(),
    liveCheckLimit: DAILY_LIVE_CHECK_LIMIT,
    archiveKeyConfigured: !!(process.env.YOUTUBE_API_KEY_2),
  });
});

// Manual trigger for live check — for diagnostics
app.post('/api/admin/trigger-live-check', async (req, res) => {
  res.json({ ok: true, message: 'Live check triggered' });
  await scheduledLiveCheck();
});

// Manual trigger for live status check
app.post('/api/admin/trigger-live-check', async (req, res) => {
  if (quotaExceeded) {
    return res.status(429).json({ error: 'quota_exceeded', message: 'Quota exceeded — resets at midnight Pacific' });
  }
  const channels = getLiveChannels();
  const cost = channels.length * 100;
  res.json({ ok: true, message: 'Live check started for ' + channels.length + ' channels (~' + cost + ' units)' });
  scheduledLiveCheck(); // run in background, don't await
});

// Manual trigger for recent video fetch — use from admin panel after deploys
app.post('/api/admin/trigger-recent-fetch', async (req, res) => {
  if (quotaExceeded) {
    return res.status(429).json({ error: 'quota_exceeded', message: 'Quota exceeded — resets at midnight Pacific. Try again tomorrow.' });
  }
  // Double-check by testing a single API call before committing to full fetch
  const key = getApiKey();
  if (!key || key === 'YOUR_YOUTUBE_API_KEY') {
    return res.status(500).json({ error: 'No API key configured' });
  }
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

// Failed fetch log
app.get('/api/admin/fetch-errors', (req, res) => {
  res.json({ errors: fetchErrorLog, total: fetchErrorLog.length });
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
  if (quotaExceeded) return res.status(429).json({ error: 'quota_exceeded' });
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
      quotaExceeded,
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

app.get('/api/admin/cache/status', (req, res) => {
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

  res.json({
    playlist: { entries: playlistCached, ttlHours: 48 },
    recentVideos: { entries: recentCached, ttlHours: 168, lastFetch },
    liveStatuses: {
      entries: liveCached,
      lastChecked: lastLiveCheck,
      lastNotification: cache.lastNotificationReceived,
    },
    websubActive: cache.websubActive,
    quotaExceeded,
    liveChecksToday: getLiveChecksToday(),
    liveCheckLimit: DAILY_LIVE_CHECK_LIMIT,
    archiveKeyConfigured: !!(process.env.YOUTUBE_API_KEY_2),
  });
});

// ── WS4KP static data — must be before catch-all ──
// WS4KP fetches these as absolute paths (/data/..., /scripts/...)
// regardless of where it's hosted, so we intercept here.
app.use('/data', express.static(path.join(__dirname, 'public', 'weatherstar', 'data')));
app.use('/scripts', express.static(path.join(__dirname, 'public', 'weatherstar', 'scripts')));

// ── WS4KP icon fallback ───────────────────────────────────────────────────────
// Weather condition GIFs (icons/current-conditions/, icons/regional-maps/, etc.)
// are large binary assets not easily pushed via GitHub web UI. If they're missing
// locally, redirect to Matt's server so they load transparently in <img> tags.
app.get('/weatherstar/images/*', (req, res, next) => {
  // Only redirect if express.static didn't serve it (i.e. we reached this route)
  res.redirect(302, `https://weatherstar.netbymatt.com${req.path}`);
});

// ── Serve index for all other routes ──
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

  // Mount radar notification routes
  radar.routes(app);

  // Init radar module with Redis client once server is up
  if (redis) {
    radar.init(redis);
  } else {
    console.warn('[Radar] Redis not available — push notifications disabled');
  }
});
