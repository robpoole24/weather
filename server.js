const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

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
app.use(express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// ── Load / Save data ──
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return getDefaultData();
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getDefaultData() {
  return {
    config: {
      playlistId: 'PLNDLR7JhLYhOdX-lSyjsgUSkwcd55UuiI',
      apiKey: process.env.YOUTUBE_API_KEY || ''
    },
    groups: [
      {
        id: 'forecasters',
        label: 'Weather Forecasters',
        icon: '⛅',
        channels: [
          { id: 'UCvBVK2ymNzPLRJrgip2GeQQ', name: 'Max Velocity',      hasLive: true,  enabled: true,
            collections: [
              { id: 'max-chasers', label: 'Exclusive Chasers', enabled: false }
            ]
          },
          { id: 'UCJHAT3Uvv-g3I8H3GhHWV7w', name: "Ryan Hall Y'all",   hasLive: true,  enabled: true,
            collections: [
              { id: 'ryan-chasers', label: 'Exclusive Chasers', enabled: false }
            ]
          },
          { id: 'UCp2G_jHO53yj2NVjv8zbDmQ', name: 'Evan Fryberger',    hasLive: true,  enabled: true },
          { id: 'UCBtR7ynKM9odz-PW_7uyzDw', name: 'Severe Studios',    hasLive: true,  enabled: true },
        ]
      },
      {
        id: 'chasers',
        label: 'Storm Chasers',
        icon: '🌪',
        channels: [
          { id: 'UC8QZ-OIqfWKek1CpMvs2O3g', name: 'Aaron Jayjack',          hasLive: true,  enabled: true },
          { id: 'UCXQYQMwU9wc584i7ecZzm_A', name: 'Adri Mozeris',           hasLive: false, enabled: true },
          { id: 'UCW-db9uRShMINgICqQeyt1Q', name: 'Alexander Spahn',        hasLive: false, enabled: true },
          { id: 'UCT1IIkU3Yafr6nfNxQlWuSQ', name: 'Andrew Pritchard',       hasLive: true,  enabled: true },
          { id: 'UCXZJRhrMbtXqjZCZUGp5CTg', name: 'Bamawxcom',              hasLive: false, enabled: true },
          { id: 'UCD3KREyo3IqCLBC-4khGgIw', name: 'Brandon Clement',        hasLive: true,  enabled: true },
          { id: 'UCJ_8JVFhFKEaFRqnv9kxKmA', name: 'Brandon Copic',          hasLive: true,  enabled: true },
          { id: 'UCMmlV4B6Bx2GuYtIaxpLcfw', name: 'Brittney Richardson',    hasLive: true,  enabled: true },
          { id: 'UCvIqVAaqpx1Q_e9DzIxgk1A', name: 'CF Productions',         hasLive: true,  enabled: true },
          { id: 'UCLfN3U2O0sEYabjo2lxIttw', name: 'Celton Henderson',       hasLive: false, enabled: true },
          { id: 'UCGpPbdVAtTUgW_w98lXC9nw', name: 'Chris Riske',            hasLive: true,  enabled: true },
          { id: 'UCb0U1g5r4kH_NDMGiGRhysA', name: 'Connor Croff',           hasLive: true,  enabled: true },
          { id: 'UCRYYy0UrfyGmMKQDU1N1R3g', name: 'Convective Chronicles',  hasLive: true,  enabled: true },
          { id: 'UCx5ex9rJumpj-oKgVJrP4hA', name: 'Corey Gerken',           hasLive: true,  enabled: true },
          { id: 'UCemyFpFfu55JvAP_eWW1NdA', name: 'Daniel Shaw',            hasLive: true,  enabled: true },
          { id: 'UChZ_VT3MrHB53bSqFiVf4eg', name: "Edgar O'Neal",           hasLive: true,  enabled: true },
          { id: 'UCFQfMFWHkIBFSxfS_kI4iKA', name: 'Freddy McKinney',        hasLive: true,  enabled: true },
          { id: 'UCPgskHnT1cT_hpfbq9nUK7w', name: 'Jakob McMillin',         hasLive: true,  enabled: true },
          { id: 'UCWcjww4Wz_UqxSPYCnc9T-A', name: 'Joey Krastel',           hasLive: false, enabled: true },
          { id: 'UCWMRFAo3Cvd7W8yQpQwsOQA', name: 'John McKinney',          hasLive: true,  enabled: true },
          { id: 'UCSoEfOMuGNjrrhD4iLTKo_A', name: 'Jonas Piontek',          hasLive: false, enabled: true },
          { id: 'UC86mOt7YnKgRUQxblDpsN-g', name: 'Jordan Hall',            hasLive: true,  enabled: true },
          { id: 'UCvRBXkjHG0vbDrO-03ZIWxw', name: 'Justin Noonan',          hasLive: false, enabled: true },
          { id: 'UClIZx2ESMJVocfMIbji_ujg', name: 'Justin Poublon',         hasLive: true,  enabled: true },
          { id: 'UCPtizAsfQaJktz0tw9YuKLQ', name: 'Kannon Kalton',          hasLive: true,  enabled: true },
          { id: 'UC1nJElGcVcTpeZJVyxEbzJw', name: 'Live Storms Media',      hasLive: true,  enabled: true },
          { id: 'UCeE90n3GWO1XZcwt8xpNRtw', name: 'Melanie Metz',           hasLive: true,  enabled: true },
          { id: 'UCy5cFthFcECu6DMSBcOX5AQ', name: 'Oklahoma Weather Couple', hasLive: false, enabled: true },
          { id: 'UCV6hWxB0-u_IX7e-h4fEBAw', name: 'Reed Timmer',            hasLive: true,  enabled: true },
          { id: 'UChxsy558HhpaqnB1Hk6tHkw', name: 'Reilly Dibble',          hasLive: true,  enabled: true },
          { id: 'UCqsI0A7OlQTnwPFOUZaISMA', name: 'Scott Currens',          hasLive: false, enabled: true },
          { id: 'UCqAWcfd0BJBgCW8iyOLOF3g', name: 'Scott Peake',            hasLive: true,  enabled: true },
          { id: 'UCdSMdTFOfqmOXP-1vD2cxAA', name: 'Storm Chase TV',         hasLive: true,  enabled: true },
          { id: 'UCAnSuGYTjwbGoBMgF_aBpnQ', name: 'Stormgasm',              hasLive: true,  enabled: true },
          { id: 'UCBmOfiL9LC3dT4Ps2veVCoQ', name: 'Stormrunner Media',      hasLive: true,  enabled: true },
          { id: 'UCm8EwVbQaGVkYnxZVQvCFAw', name: 'Tornado Paigeyy',        hasLive: true,  enabled: true },
          { id: 'UCuer9Sw2UAD5LWZpVXbgKTA', name: 'Tornado TRX',            hasLive: true,  enabled: true },
        ]
      },
      {
        id: 'creators',
        label: 'Other Weather Creators',
        icon: '🎬',
        channels: [
          { id: 'UCuFxM1HTY6SONb_FICAl6gQ', name: 'Carly Anna WX',          hasLive: false, enabled: true },
          { id: 'UCGEZlX4V82wv7_Z2LsXtjPA', name: 'June First',             hasLive: true,  enabled: true },
          { id: 'UCpYQmszu4IP37xyt3RQb2gw', name: 'More Max Velocity',      hasLive: true,  enabled: true },
          { id: 'UCTRPdC_jSFKsBVOUFQ52jGg', name: 'Out of the Whirlwind',   hasLive: false, enabled: true },
          { id: 'UCo-3ThNQmPmQSQL9WPjMaUQ', name: 'Pecos Hank',             hasLive: false, enabled: true },
          { id: 'UCCP12NYSDa9KL26PW1zokcA', name: 'Storm Channel Coaching', hasLive: false, enabled: true },
          { id: 'UCz2BWcrW-njx_py1FR0447A', name: 'Storm Reel',             hasLive: false, enabled: true },
          { id: 'UCZTme3vf6kXmXfSsIr06lvQ', name: 'Swegle Studios',         hasLive: false, enabled: true },
          { id: 'UCbxfONPDpv4r3IXwppgcTdA', name: 'The Twister Archives',   hasLive: false, enabled: true },
          { id: 'UC0CPqIPMHCELm208KiwBwdw', name: 'Tornado Forensics',      hasLive: false, enabled: true },
          { id: 'UC9c4E_DWmPMel1MelOBTznw', name: 'Tornado Video Library',  hasLive: false, enabled: true },
          { id: 'UCgGTo_tNrWxArxh3c3aI6bw', name: 'Tornado Warned',         hasLive: false, enabled: true },
          { id: 'UCCtYdNBm-8C_wZk0n6u8VnQ', name: 'Weatherbox Studios',     hasLive: false, enabled: true },
          { id: 'UCHf2fy0H-GJNrdVO3KxDV5Q', name: 'WorldStorm',             hasLive: false, enabled: true },
        ]
      }
    ],
    apps: [
      { name: 'WeatherFront',        img: 'images/weatherfront.webp',    ios: 'https://apps.apple.com/app/weatherfront/id1580596099',                           iosSoon: false, android: null,                                                                          androidSoon: true,  enabled: true },
      { name: 'Weather Wise',        img: 'images/weather-wise.webp',    ios: 'https://apps.apple.com/us/app/weatherwise-app/id6736407724',                     iosSoon: false, android: 'https://play.google.com/store/apps/details?id=com.interactiveweather.weatherwise', androidSoon: false, enabled: true },
      { name: 'Radar Omega',         img: 'images/radar-omega.webp',     ios: 'https://apps.apple.com/us/app/radaromega-doppler-radar-app/id1439881811',         iosSoon: false, android: 'https://play.google.com/store/apps/details?id=com.radarx.stormmapping.stormmapping', androidSoon: false, enabled: true },
      { name: 'Windy',               img: 'images/windy.webp',           ios: 'https://apps.apple.com/app/windy-wind-weather-forecast/id1161387262',             iosSoon: false, android: 'https://play.google.com/store/apps/details?id=com.windyty.android',          androidSoon: false, enabled: true },
      { name: 'The Weather Channel', img: 'images/weather-channel.webp', ios: 'https://apps.apple.com/app/the-weather-channel/id295646461',                     iosSoon: false, android: 'https://play.google.com/store/apps/details?id=com.weather.Weather',          androidSoon: false, enabled: true },
      { name: 'AccuWeather',         img: 'images/accuweather.webp',     ios: 'https://apps.apple.com/app/accuweather/id300048137',                              iosSoon: false, android: 'https://play.google.com/store/apps/details?id=com.accuweather.android',      androidSoon: false, enabled: true },
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

// Update a channel's collection membership
app.put('/api/admin/groups/:groupId/channels/:channelId/collection-membership', (req, res) => {
  const data = loadData();
  const group = data.groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const channel = group.channels.find(c => c.id === req.params.channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  // collectionId format: 'parentChannelId::colId' or null
  channel.collectionId = req.body.collectionId || null;
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

// ── Server-Side Cache ──
const cache = {
  liveStatuses: {},      // { channelId: { isLive, checkedAt, source } }
  recentVideos: {},      // { channelId: { items, cachedAt } }
  playlist: {},          // { playlistId: { items, cachedAt } }
  lastLiveCheck: null,
  lastRecentFetch: null,
  websubActive: false,   // true once Railway is deployed and webhooks are live
};

const CACHE_TTL = {
  recentVideos: 24 * 60 * 60 * 1000,  // 24 hours (fetched once daily at 6pm EST)
  playlist:     48 * 60 * 60 * 1000,  // 48 hours
  liveCheck:    15 * 60 * 1000,       // 15 min fallback polling (used only if WebSub inactive)
};

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
  const url = 'https://www.googleapis.com/youtube/v3/channels?key=' + key +
    '&id=' + channelId + '&part=snippet&fields=items/snippet/liveBroadcastContent';
  const data = await ytFetch(url);
  if (checkQuotaError(data)) { markQuotaExceeded(); throw new Error('quota_exceeded'); }
  if (!data.items || data.items.length === 0) return false;
  // liveBroadcastContent is 'live', 'upcoming', or 'none'
  return data.items[0].snippet.liveBroadcastContent === 'live';
}

// ── Scheduled Live Check ──
// Falls back to polling only when WebSub is not active (local dev)
// On Railway, WebSub push notifications handle live status instead
// Time-aware: chasers/creators stop at midnight EST, forecasters at 2am EST
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
  console.log('[WeatherTV] Running live check (' + channels.length + ' channels, 1 unit each) — EST hour: ' + estHour + '...');
  let liveCount = 0;

  for (const ch of channels) {
    try {
      const isLive = await checkLiveStatus(ch.id);
      cache.liveStatuses[ch.id] = { isLive, checkedAt: Date.now(), source: 'poll' };
      if (isLive) liveCount++;
      await new Promise(r => setTimeout(r, 100));
    } catch(e) {
      if (e.message === 'quota_exceeded') break;
      console.error('[WeatherTV] Live check error for ' + ch.id + ':', e.message);
    }
  }

  cache.lastLiveCheck = Date.now();
  console.log('[WeatherTV] Live check complete — ' + liveCount + ' channel(s) live (' + channels.length + ' units used)');
  setTimeout(scheduledLiveCheck, CACHE_TTL.liveCheck);
}

// Start live check 5s after boot
setTimeout(scheduledLiveCheck, 5000);

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
      console.log('[WebSub] Subscribe response for ' + channelId + ': ' + res.statusCode);
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

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
app.post('/websub/callback/:channelId', rawBodyParser, (req, res) => {
  res.status(200).send('OK'); // Always respond quickly

  const channelId = req.params.channelId;
  const body = req.body ? req.body.toString() : '';

  // Parse the Atom feed to detect live vs new video
  const isLive = body.includes('<yt:liveBroadcastContent>live</yt:liveBroadcastContent>') ||
                 body.includes('live_stream');

  const wasLive = cache.liveStatuses[channelId] && cache.liveStatuses[channelId].isLive;

  // Update live status from push notification
  cache.liveStatuses[channelId] = {
    isLive,
    checkedAt: Date.now(),
    source: 'websub'
  };
  cache.lastLiveCheck = Date.now();

  if (isLive && !wasLive) {
    console.log('[WebSub] LIVE: ' + channelId + ' just went live!');
  } else if (!isLive && wasLive) {
    console.log('[WebSub] OFFLINE: ' + channelId + ' stream ended');
  }

  // Also invalidate recent videos cache for this channel so next request gets fresh content
  delete cache.recentVideos[channelId];
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
  if (quotaExceeded) {
    console.log('[WeatherTV] Skipping recent video fetch — quota exceeded');
    return;
  }

  const key = getApiKey();
  if (!key || key === 'YOUR_YOUTUBE_API_KEY') return;

  const channels = getAllChannels();
  if (channels.length === 0) return;

  console.log('[WeatherTV] Fetching recent videos for ' + channels.length + ' channels...');
  let fetched = 0;

  for (const ch of channels) {
    try {
      const url = 'https://www.googleapis.com/youtube/v3/search?key=' + key +
        '&channelId=' + ch.id + '&part=snippet&order=date&type=video&maxResults=10';
      const data = await ytFetch(url);

      if (checkQuotaError(data)) {
        markQuotaExceeded();
        console.warn('[WeatherTV] Quota hit during recent video fetch after ' + fetched + ' channels');
        break;
      }

      cache.recentVideos[ch.id] = { items: data.items || [], cachedAt: Date.now() };
      fetched++;
      await new Promise(r => setTimeout(r, 200)); // be polite to the API
    } catch(e) {
      console.error('[WeatherTV] Recent fetch error for ' + ch.id + ':', e.message);
    }
  }

  cache.lastRecentFetch = Date.now();
  console.log('[WeatherTV] Recent video fetch complete — ' + fetched + '/' + channels.length + ' channels cached');
  scheduleNextRecentFetch();
}

function scheduleNextRecentFetch() {
  // Schedule for next 6pm EST
  const now = new Date();
  const estNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const next = new Date(estNow);
  next.setHours(18, 0, 0, 0); // 6pm EST

  // If 6pm EST has already passed today, schedule for tomorrow
  if (estNow >= next) {
    next.setDate(next.getDate() + 1);
  }

  // Convert back to UTC ms offset
  const msUntilNext = next - estNow;
  const minsUntilNext = Math.round(msUntilNext / 60000);
  console.log('[WeatherTV] Next recent video fetch in ' + minsUntilNext + ' minutes (6:00 PM EST)');
  setTimeout(fetchAllRecentVideos, msUntilNext);
}

// Schedule first fetch at 6pm EST — no fetch on startup to preserve quota across restarts
// On first deploy you'll see no recent videos until 6pm EST — this is intentional
scheduleNextRecentFetch();
console.log('[WeatherTV] Recent video fetch scheduled — no startup fetch to preserve quota');

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
  res.json({
    statuses: cache.liveStatuses,
    lastChecked: cache.lastLiveCheck,
    quotaExceeded
  });
});

// Recent videos — cached per channel for 1 hour
app.get('/api/yt/recent/:channelId', async (req, res) => {
  const channelId = req.params.channelId;

  // Serve from cache if fresh
  const cached = cache.recentVideos[channelId];
  if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL.recentVideos) {
    return res.json({ items: cached.items, _cached: true });
  }

  if (quotaExceeded) {
    return res.status(429).json({ error: 'quota_exceeded', message: 'Daily YouTube quota reached — resets at midnight Pacific' });
  }

  const key = getApiKey();
  if (!key) return res.status(500).json({ error: 'No API key configured' });

  try {
    const url = `https://www.googleapis.com/youtube/v3/search?key=${key}&channelId=${channelId}&part=snippet&order=date&type=video&maxResults=10`;
    const data = await ytFetch(url);
    if (checkQuotaError(data)) {
      markQuotaExceeded();
      return res.status(429).json({ error: 'quota_exceeded', message: 'Daily YouTube quota reached — resets at midnight Pacific' });
    }
    // Store in cache
    cache.recentVideos[channelId] = { items: data.items || [], cachedAt: Date.now() };
    res.json(data);
  } catch(e) {
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
    cache.playlist[playlistId] = { items: data.items || [], cachedAt: Date.now() };
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Quota status
app.get('/api/yt/quota-status', (req, res) => {
  res.json({ quotaExceeded, lastLiveCheck: cache.lastLiveCheck });
});

// Manual trigger for live check — for diagnostics
app.post('/api/admin/trigger-live-check', async (req, res) => {
  res.json({ ok: true, message: 'Live check triggered' });
  await scheduledLiveCheck();
});

// Manual trigger for recent video fetch — use from admin panel after deploys
app.post('/api/admin/trigger-recent-fetch', async (req, res) => {
  if (quotaExceeded) {
    return res.status(429).json({ error: 'quota_exceeded', message: 'Quota exceeded — resets at midnight Pacific' });
  }
  res.json({ ok: true, message: 'Recent video fetch started — check cache status in a minute' });
  fetchAllRecentVideos(); // don't await — let it run in background
});

// Test outbound connectivity to Google
app.get('/api/admin/test-connectivity', async (req, res) => {
  const key = getApiKey();
  try {
    const url = 'https://www.googleapis.com/youtube/v3/channels?key=' + key + '&id=UCvBVK2ymNzPLRJrgip2GeQQ&part=snippet&fields=items/snippet/title';
    const data = await ytFetch(url);
    res.json({ ok: true, response: data });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// Cache management — admin only
app.post('/api/admin/cache/clear-playlist', (req, res) => {
  cache.playlist = {};
  console.log('[WeatherTV] Playlist cache cleared by admin');
  res.json({ ok: true, message: 'Playlist cache cleared — will fetch fresh on next request' });
});

app.post('/api/admin/cache/clear-recent', (req, res) => {
  cache.recentVideos = {};
  console.log('[WeatherTV] Recent videos cache cleared by admin');
  res.json({ ok: true, message: 'Recent videos cache cleared — will fetch fresh on next request' });
});

app.get('/api/admin/cache/status', (req, res) => {
  const playlistCached = Object.keys(cache.playlist).length;
  const recentCached = Object.keys(cache.recentVideos).length;
  const liveCached = Object.keys(cache.liveStatuses).length;
  res.json({
    playlist: { entries: playlistCached, ttlHours: 48 },
    recentVideos: { entries: recentCached, ttlHours: 12, lastFetch: cache.lastRecentFetch },
    liveStatuses: { entries: liveCached, lastChecked: cache.lastLiveCheck },
    websubActive: cache.websubActive,
    quotaExceeded
  });
});

// ── Serve index for all other routes ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Listen on 0.0.0.0 so Railway can reach the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`WeatherTV server running on port ${PORT}`);
  console.log(`App: http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
});
