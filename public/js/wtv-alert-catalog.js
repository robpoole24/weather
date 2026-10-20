// WeatherTV alert catalog — every land-based alert type the National Weather
// Service issues (api.weather.gov/alerts/types), in priority order.
// ONE list shared by the push-notification server (radar.js) and the radar map
// (radar.html), so the two can't drift apart.
//
//   code      3 letters, used in push topic names (a_<zone>_<code>). NEVER change
//             an existing code: phones are subscribed by it.
//   group     section in the settings and in the map's Alert Types list
//   tier      sound on phones (set by the rule under the list):
//               'siren'  — Tornado Warning only
//               'urgent' — every other warning, Tornado/Severe Thunderstorm/tropical watches, emergencies
//               'soft'   — everything else (watches, advisories, statements)
//   always    life-safety: every phone gets it, can't be turned off
//   defaultOn on for new users (can be turned off)
//
// Marine-only alerts (Small Craft, Gale, Special Marine…) aren't listed: they're
// issued for offshore zones, which neither the map nor push notifications use.
(function (root) {
  const G = {
    severe: 'Severe storms', tropical: 'Tropical & coastal', flood: 'Flooding', winter: 'Winter & cold',
    wind: 'Wind, fog & dust', heat: 'Heat, fire & air', mountain: 'Mountains & volcanoes',
    emergency: 'Emergencies', statement: 'Statements & outlooks',
  };
  const T = (event, code, group, icon, color, tier, opts) => Object.assign({ event, code, group: G[group], icon, color, tier: tier || 'quiet', always: false, defaultOn: false }, opts || {});
  const ALWAYS = { always: true }, ON = { defaultOn: true };

  const ALERT_CATALOG = [
    // ── Life-safety warnings ──
    T('Tornado Warning',              'TOR', 'severe',    '🌪️', '#ff0000', 'siren', ALWAYS),
    T('Extreme Wind Warning',         'EWW', 'severe',    '💨', '#ff4500', 'siren', ALWAYS),
    T('Tsunami Warning',              'TSW', 'tropical',  '🌊', '#fd6347', 'siren', ALWAYS),
    T('Severe Thunderstorm Warning',  'SVR', 'severe',    '⛈️', '#ff8c00', 'chime', ALWAYS),
    T('Flash Flood Warning',          'FFW', 'flood',     '🌊', '#00ff00', 'chime', ON),
    T('Snow Squall Warning',          'SQW', 'winter',    '🌨️', '#c71585', 'chime', ON),
    T('Hurricane Warning',            'HUW', 'tropical',  '🌀', '#dc143c', 'chime', ON),
    T('Typhoon Warning',              'TYW', 'tropical',  '🌀', '#dc143c', 'chime', ON),
    T('Storm Surge Warning',          'SSW', 'tropical',  '🌊', '#b524f7', 'chime', ON),
    T('Tropical Storm Warning',       'TRW', 'tropical',  '🌀', '#b22222', 'chime', ON),
    T('Earthquake Warning',           'EQW', 'emergency', '🫨', '#8b4513', 'chime', ON),
    T('Evacuation Immediate',         'EVI', 'emergency', '🚨', '#7fff00', 'chime', ON),
    T('Shelter In Place Warning',     'SPW', 'emergency', '🏠', '#fa8072', 'chime', ON),
    T('Civil Danger Warning',         'CDW', 'emergency', '🚨', '#ffb6c1', 'chime', ON),
    T('Civil Emergency Message',      'CEM', 'emergency', '🚨', '#ffb6c1', 'chime', ON),
    T('Nuclear Power Plant Warning',  'NUW', 'emergency', '☢️', '#4b0082', 'chime', ON),
    T('Radiological Hazard Warning',  'RHW', 'emergency', '☢️', '#4b0082', 'chime', ON),
    T('Hazardous Materials Warning',  'HMW', 'emergency', '☣️', '#4b0082', 'chime', ON),
    T('Fire Warning',                 'FRW', 'heat',      '🔥', '#a0522d', 'chime', ON),
    T('Dust Storm Warning',           'DSW', 'wind',      '🌪️', '#ffe4c4', 'chime', ON),
    T('Blowing Dust Warning',         'BDW', 'wind',      '🌪️', '#ffe4c4', 'chime', ON),
    // ── Watches (storms & tropical) ──
    T('Tornado Watch',                'TOA', 'severe',    '🌪️', '#ffff00', 'quiet', ON),
    T('Severe Thunderstorm Watch',    'SVA', 'severe',    '⛈️', '#db8d00', 'quiet', ON),
    T('Hurricane Watch',              'HUA', 'tropical',  '🌀', '#ff00ff', 'quiet', ON),
    T('Typhoon Watch',                'TYA', 'tropical',  '🌀', '#ff00ff', 'quiet', ON),
    T('Storm Surge Watch',            'SSA', 'tropical',  '🌊', '#db7ff7', 'quiet', ON),
    T('Tropical Storm Watch',         'TRA', 'tropical',  '🌀', '#f08080', 'quiet', ON),
    T('Tsunami Watch',                'TSA', 'tropical',  '🌊', '#ff00ff', 'quiet', ON),
    // ── Other warnings ──
    T('Flood Warning',                'FLW', 'flood',     '🌊', '#2e8b57'),
    T('Coastal Flood Warning',        'CFW', 'tropical',  '🌊', '#228b22'),
    T('Lakeshore Flood Warning',      'LSW', 'flood',     '🌊', '#228b22'),
    T('High Surf Warning',            'SUW', 'tropical',  '🌊', '#228b22'),
    T('Blizzard Warning',             'BZW', 'winter',    '❄️', '#ff69b4', 'chime', ON),
    T('Ice Storm Warning',            'ISW', 'winter',    '🧊', '#8b008b', 'chime', ON),
    T('Winter Storm Warning',         'WSW', 'winter',    '❄️', '#9370db', 'chime', ON),
    T('Lake Effect Snow Warning',     'LEW', 'winter',    '❄️', '#008b8b', 'chime', ON),
    T('Extreme Cold Warning',         'ECW', 'winter',    '🥶', '#0000ff', 'quiet', ON),
    T('Freeze Warning',               'FZW', 'winter',    '🥶', '#483d8b'),
    T('High Wind Warning',            'HWW', 'wind',      '💨', '#daa520', 'chime', ON),
    T('Extreme Heat Warning',         'EHW', 'heat',      '🌡️', '#c71585'),
    T('Red Flag Warning',             'FWW', 'heat',      '🔥', '#ff1493'),
    T('Avalanche Warning',            'AVW', 'mountain',  '🏔️', '#1e90ff'),
    T('Ashfall Warning',              'AFW', 'mountain',  '🌋', '#a9a9a9'),
    T('Volcano Warning',              'VOW', 'mountain',  '🌋', '#2f4f4f'),
    // ── Other watches ──
    T('Flash Flood Watch',            'FFA', 'flood',     '🌊', '#2e8b57'),
    T('Flood Watch',                  'FAA', 'flood',     '🌊', '#2e8b57'),
    T('Coastal Flood Watch',          'CFA', 'tropical',  '🌊', '#66cdaa'),
    T('Lakeshore Flood Watch',        'LSA', 'flood',     '🌊', '#66cdaa'),
    T('Winter Storm Watch',           'WSA', 'winter',    '❄️', '#4682b4', 'quiet', ON),
    T('Extreme Cold Watch',           'ECA', 'winter',    '🥶', '#5f9ea0'),
    T('Freeze Watch',                 'FZA', 'winter',    '🥶', '#00ffff'),
    T('High Wind Watch',              'HWA', 'wind',      '💨', '#b8860b'),
    T('Extreme Heat Watch',           'EHA', 'heat',      '🌡️', '#800000'),
    T('Fire Weather Watch',           'FWA', 'heat',      '🔥', '#ffdead'),
    T('Avalanche Watch',              'AVA', 'mountain',  '🏔️', '#f4a460'),
    // ── Advisories ──
    T('Tsunami Advisory',             'TSY', 'tropical',  '🌊', '#d2691e'),
    T('Dense Fog Advisory',           'FGY', 'wind',      '🌫️', '#708090', 'chime', ON),
    T('Freezing Fog Advisory',        'ZFY', 'wind',      '🌫️', '#008080', 'chime', ON),
    T('Winter Weather Advisory',      'WWY', 'winter',    '🌨️', '#7b68ee', 'quiet', ON),
    T('Cold Weather Advisory',        'CWY', 'winter',    '🥶', '#afeeee'),
    T('Frost Advisory',               'FRY', 'winter',    '❄️', '#6495ed'),
    T('Wind Advisory',                'WIY', 'wind',      '💨', '#d2b48c', 'quiet', ON),
    T('Lake Wind Advisory',           'LWY', 'wind',      '💨', '#d2b48c'),
    T('Dust Advisory',                'DUY', 'wind',      '🌫️', '#bdb76b'),
    T('Blowing Dust Advisory',        'BDY', 'wind',      '🌫️', '#bdb76b'),
    T('Heat Advisory',                'HTY', 'heat',      '🌡️', '#ff7f50'),
    T('Air Quality Alert',            'AQA', 'heat',      '😷', '#c97a1e'),
    T('Dense Smoke Advisory',         'DSA', 'heat',      '💨', '#b05a00'),
    T('Air Stagnation Advisory',      'ASY', 'heat',      '😷', '#808080'),
    T('Extreme Fire Danger',          'EFD', 'heat',      '🔥', '#e9967a'),
    T('Flood Advisory',               'FLY', 'flood',     '🌊', '#00ff7f'),
    T('Coastal Flood Advisory',       'CFY', 'tropical',  '🌊', '#7cfc00'),
    T('Lakeshore Flood Advisory',     'LSY', 'flood',     '🌊', '#7cfc00'),
    T('High Surf Advisory',           'SUY', 'tropical',  '🌊', '#ba55d3'),
    T('Avalanche Advisory',           'AVY', 'mountain',  '🏔️', '#cd853f'),
    T('Ashfall Advisory',             'AFY', 'mountain',  '🌋', '#696969'),
    // ── Emergency notices ──
    T('Local Area Emergency',         'LAE', 'emergency', '⚠️', '#c0c0c0'),
    T('Law Enforcement Warning',      'LAW', 'emergency', '🚓', '#c0c0c0'),
    T('Child Abduction Emergency',    'CAE', 'emergency', '🧒', '#ffffff'),
    T('Blue Alert',                   'BLU', 'emergency', '🚓', '#4169e1'),
    T('911 Telephone Outage',         'TOE', 'emergency', '📞', '#c0c0c0'),
    // ── Statements & outlooks ──
    T('Special Weather Statement',    'SPS', 'statement', '⚠️', '#a0a0a0'),
    T('Severe Weather Statement',     'SVS', 'statement', '⛈️', '#00ffff'),
    T('Flash Flood Statement',        'FFS', 'flood',     '🌊', '#8b0000'),
    T('Flood Statement',              'FLS', 'flood',     '🌊', '#00ff00'),
    T('Coastal Flood Statement',      'CFS', 'tropical',  '🌊', '#6b8e23'),
    T('Lakeshore Flood Statement',    'LSS', 'flood',     '🌊', '#6b8e23'),
    T('Tropical Cyclone Local Statement', 'HLS', 'tropical', '🌀', '#ffe4b5'),
    T('Rip Current Statement',        'RPS', 'tropical',  '🌊', '#40e0d0'),
    T('Beach Hazards Statement',      'BHS', 'tropical',  '🏖️', '#40e0d0'),
    T('Hydrologic Outlook',           'ESF', 'statement', '🌊', '#90ee90'),
    T('Hazardous Weather Outlook',    'HWO', 'statement', '📋', '#eee8aa'),
    T('Short Term Forecast',          'NOW', 'statement', '📋', '#98fb98'),
  ];

  // Three sounds. The siren is ONLY for tornado warnings, so it always means "take cover".
  const URGENT_ALSO = new Set(['Tornado Watch', 'Severe Thunderstorm Watch', 'Hurricane Watch', 'Typhoon Watch',
    'Storm Surge Watch', 'Tropical Storm Watch', 'Tsunami Watch', 'Evacuation Immediate', 'Civil Emergency Message',
    'Local Area Emergency']);
  ALERT_CATALOG.forEach(t => {
    t.tier = t.event === 'Tornado Warning' ? 'siren'
      : (/Warning$/.test(t.event) || URGENT_ALSO.has(t.event)) ? 'urgent' : 'soft';
  });

  // Old or renamed NWS event names → the current name, so nothing is missed
  // while offices switch over (NWS renamed several in 2024–25).
  const ALERT_ALIASES = {
    'Excessive Heat Warning': 'Extreme Heat Warning', 'Excessive Heat Watch': 'Extreme Heat Watch',
    'Wind Chill Warning': 'Extreme Cold Warning', 'Wind Chill Watch': 'Extreme Cold Watch',
    'Wind Chill Advisory': 'Cold Weather Advisory', 'Hard Freeze Warning': 'Freeze Warning', 'Hard Freeze Watch': 'Freeze Watch',
    'Freezing Rain Advisory': 'Winter Weather Advisory', 'Lake Effect Snow Advisory': 'Winter Weather Advisory',
    'Lake Effect Snow Watch': 'Winter Storm Watch', 'Hurricane Local Statement': 'Tropical Cyclone Local Statement',
    'Typhoon Local Statement': 'Tropical Cyclone Local Statement',
  };
  const ALERT_GROUPS = Object.values(G);
  const api = { ALERT_CATALOG, ALERT_ALIASES, ALERT_GROUPS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WTV_ALERT_CATALOG = api;
})(typeof window !== 'undefined' ? window : globalThis);
