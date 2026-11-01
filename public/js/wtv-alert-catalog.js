// WeatherTV alert catalog — the weather alert types the National Weather
// Service issues (api.weather.gov/alerts/types), grouped into sections and
// ordered worst-first within each section.
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
//   mapOnly   shown on the map but not offered for push (see MAP below)
//
// Marine alerts (Gale, Storm, Small Craft…) cover the Great Lakes and coastal/offshore
// waters. They're shown on the map only (the server attaches the marine zone outlines,
// /api/alerts/marine) and aren't offered for push. mapOff ones start hidden on the map
// because they cover huge areas; anyone can turn them on in Alert Types.
(function (root) {
  // Sections, in the order people look for them (map's Alert Types list and phone settings)
  const G = {
    severe: 'Tornadoes & thunderstorms', flood: 'Flooding', tropical: 'Tropical & coastal', marine: 'Marine (lakes & coastal waters)', winter: 'Winter & cold',
    wind: 'Wind, fog & dust', heat: 'Heat, fire & air quality', mountain: 'Mountains & volcanoes',
    emergency: 'Non-weather emergencies', statement: 'Statements & other warnings',
  };
  const T = (event, code, group, icon, color, tier, opts) => Object.assign({ event, code, group: G[group], icon, color, tier: tier || 'quiet', always: false, defaultOn: false }, opts || {});
  const ALWAYS = { always: true }, ON = { defaultOn: true };
  // On the map only: not separate alerts you can subscribe to (a Flash Flood
  // Emergency arrives as a Flash Flood Warning; Special Marine Warnings cover
  // offshore zones), so they never appear in the phone settings.
  const MAP = { mapOnly: true };
  const MAP_OFF = { mapOnly: true, mapOff: true };       // map only, and hidden until turned on

  // Within each section: worst first — emergencies, warnings, watches,
  // advisories, then statements and outlooks.
  const ALERT_CATALOG = [
    // ── Tornadoes & thunderstorms ──
    T('Tornado Warning',              'TOR', 'severe',    '🌪️', '#ff0000', 'siren', ALWAYS),
    T('Severe Thunderstorm Warning',  'SVR', 'severe',    '⛈️', '#ff8c00', 'chime', ALWAYS),
    T('Tornado Watch',                'TOA', 'severe',    '🌪️', '#ffff00', 'quiet', ON),
    T('Severe Thunderstorm Watch',    'SVA', 'severe',    '⛈️', '#db8d00', 'quiet', ON),
    // ── Flooding ──
    T('Flash Flood Emergency',        'FFE', 'flood',     '🌊', '#00ff00', 'chime', MAP),
    T('Flash Flood Warning',          'FFW', 'flood',     '🌊', '#00ff00', 'chime', ON),
    T('Flood Warning',                'FLW', 'flood',     '🌊', '#2e8b57'),
    T('Lakeshore Flood Warning',      'LSW', 'flood',     '🌊', '#228b22'),
    T('Flash Flood Watch',            'FFA', 'flood',     '🌊', '#2e8b57'),
    T('Flood Watch',                  'FAA', 'flood',     '🌊', '#2e8b57'),
    T('Lakeshore Flood Watch',        'LSA', 'flood',     '🌊', '#66cdaa'),
    T('Flood Advisory',               'FLY', 'flood',     '🌊', '#00ff7f'),
    T('Lakeshore Flood Advisory',     'LSY', 'flood',     '🌊', '#7cfc00'),
    T('Flash Flood Statement',        'FFS', 'flood',     '🌊', '#8b0000'),
    T('Flood Statement',              'FLS', 'flood',     '🌊', '#00ff00'),
    T('Lakeshore Flood Statement',    'LSS', 'flood',     '🌊', '#6b8e23'),
    // ── Tropical & coastal ──
    T('Tsunami Warning',              'TSW', 'tropical',  '🌊', '#fd6347', 'siren', ALWAYS),
    T('Hurricane Warning',            'HUW', 'tropical',  '🌀', '#dc143c', 'chime', ON),
    T('Typhoon Warning',              'TYW', 'tropical',  '🌀', '#dc143c', 'chime', ON),
    T('Storm Surge Warning',          'SSW', 'tropical',  '🌊', '#b524f7', 'chime', ON),
    T('Tropical Storm Warning',       'TRW', 'tropical',  '🌀', '#b22222', 'chime', ON),
    T('Coastal Flood Warning',        'CFW', 'tropical',  '🌊', '#228b22'),
    T('High Surf Warning',            'SUW', 'tropical',  '🌊', '#228b22'),
    T('Hurricane Watch',              'HUA', 'tropical',  '🌀', '#ff00ff', 'quiet', ON),
    T('Typhoon Watch',                'TYA', 'tropical',  '🌀', '#ff00ff', 'quiet', ON),
    T('Storm Surge Watch',            'SSA', 'tropical',  '🌊', '#db7ff7', 'quiet', ON),
    T('Tropical Storm Watch',         'TRA', 'tropical',  '🌀', '#f08080', 'quiet', ON),
    T('Tsunami Watch',                'TSA', 'tropical',  '🌊', '#ff00ff', 'quiet', ON),
    T('Coastal Flood Watch',          'CFA', 'tropical',  '🌊', '#66cdaa'),
    T('Tsunami Advisory',             'TSY', 'tropical',  '🌊', '#d2691e'),
    T('Coastal Flood Advisory',       'CFY', 'tropical',  '🌊', '#7cfc00'),
    T('High Surf Advisory',           'SUY', 'tropical',  '🌊', '#ba55d3'),
    T('Tropical Cyclone Local Statement', 'HLS', 'tropical', '🌀', '#ffe4b5'),
    T('Coastal Flood Statement',      'CFS', 'tropical',  '🌊', '#6b8e23'),
    T('Rip Current Statement',        'RPS', 'tropical',  '🌊', '#40e0d0'),
    // ── Marine (Great Lakes & coastal waters) ── NWS hues, made stronger to stand out on the map
    T('Special Marine Warning',       'SMW', 'marine',    '⛈️', '#ff8c00', 'chime', MAP),
    T('Hurricane Force Wind Warning', 'HFW', 'marine',    '⚓', '#dc2626', 'quiet', MAP),
    T('Storm Warning',                'SRW', 'marine',    '⚓', '#9400d3', 'quiet', MAP),
    T('Gale Warning',                 'GLW', 'marine',    '⚓', '#d946ef', 'quiet', MAP),
    T('Hazardous Seas Warning',       'SEW', 'marine',    '⚓', '#7c3aed', 'quiet', MAP),
    T('Heavy Freezing Spray Warning', 'UPW', 'marine',    '🧊', '#0284c7', 'quiet', MAP),
    T('Hurricane Force Wind Watch',   'HFA', 'marine',    '⚓', '#f87171', 'quiet', MAP),
    T('Storm Watch',                  'SRA', 'marine',    '⚓', '#c084fc', 'quiet', MAP),
    T('Gale Watch',                   'GLA', 'marine',    '⚓', '#f0abfc', 'quiet', MAP),
    T('Hazardous Seas Watch',         'SEA', 'marine',    '⚓', '#a78bfa', 'quiet', MAP),
    T('Heavy Freezing Spray Watch',   'UPA', 'marine',    '🧊', '#7dd3fc', 'quiet', MAP),
    T('Small Craft Advisory',         'SCY', 'marine',    '⛵', '#e879f9', 'quiet', MAP_OFF),
    T('Brisk Wind Advisory',          'BWY', 'marine',    '⛵', '#f5d0fe', 'quiet', MAP_OFF),
    T('Freezing Spray Advisory',      'UPY', 'marine',    '🧊', '#38bdf8', 'quiet', MAP_OFF),
    T('Low Water Advisory',           'LOY', 'marine',    '⚓', '#a16207', 'quiet', MAP_OFF),
    T('Marine Weather Statement',     'MWS', 'marine',    '⚓', '#fdba74', 'quiet', MAP_OFF),
    // ── Winter & cold ──
    T('Blizzard Warning',             'BZW', 'winter',    '❄️', '#ff69b4', 'chime', ON),
    T('Ice Storm Warning',            'ISW', 'winter',    '🧊', '#8b008b', 'chime', ON),
    T('Snow Squall Warning',          'SQW', 'winter',    '🌨️', '#c71585', 'chime', ON),
    T('Winter Storm Warning',         'WSW', 'winter',    '❄️', '#9370db', 'chime', ON),
    T('Lake Effect Snow Warning',     'LEW', 'winter',    '❄️', '#008b8b', 'chime', ON),
    T('Extreme Cold Warning',         'ECW', 'winter',    '🥶', '#0000ff', 'quiet', ON),
    T('Freeze Warning',               'FZW', 'winter',    '🥶', '#483d8b'),
    T('Winter Storm Watch',           'WSA', 'winter',    '❄️', '#4682b4', 'quiet', ON),
    T('Extreme Cold Watch',           'ECA', 'winter',    '🥶', '#5f9ea0'),
    T('Freeze Watch',                 'FZA', 'winter',    '🥶', '#00ffff'),
    T('Winter Weather Advisory',      'WWY', 'winter',    '🌨️', '#7b68ee', 'quiet', ON),
    T('Freezing Rain Advisory',       'ZRY', 'winter',    '🧊', '#da70d6'),
    T('Cold Weather Advisory',        'CWY', 'winter',    '🥶', '#afeeee'),
    T('Frost Advisory',               'FRY', 'winter',    '❄️', '#6495ed'),
    // ── Wind, fog & dust ──
    T('Extreme Wind Warning',         'EWW', 'wind',      '💨', '#ff4500', 'siren', ALWAYS),
    T('High Wind Warning',            'HWW', 'wind',      '💨', '#daa520', 'chime', ON),
    T('Dust Storm Warning',           'DSW', 'wind',      '🌪️', '#ffe4c4', 'chime', ON),
    T('Blowing Dust Warning',         'BDW', 'wind',      '🌪️', '#ffe4c4', 'chime', ON),
    T('High Wind Watch',              'HWA', 'wind',      '💨', '#b8860b'),
    T('Wind Advisory',                'WIY', 'wind',      '💨', '#d2b48c', 'quiet', ON),
    T('Dense Fog Advisory',           'FGY', 'wind',      '🌫️', '#708090', 'chime', ON),
    T('Freezing Fog Advisory',        'ZFY', 'wind',      '🌫️', '#008080', 'chime', ON),
    T('Dust Advisory',                'DUY', 'wind',      '🌫️', '#bdb76b'),
    T('Blowing Dust Advisory',        'BDY', 'wind',      '🌫️', '#bdb76b'),
    T('Lake Wind Advisory',           'LWY', 'wind',      '💨', '#d2b48c'),
    // ── Heat, fire & air quality ──
    T('Fire Warning',                 'FRW', 'heat',      '🔥', '#a0522d', 'chime', ON),
    T('Extreme Heat Warning',         'EHW', 'heat',      '🌡️', '#c71585'),
    T('Red Flag Warning',             'FWW', 'heat',      '🔥', '#ff1493'),
    T('Hazardous Air Quality Warning','HQW', 'heat',      '😷', '#cc0000'),
    T('Extreme Heat Watch',           'EHA', 'heat',      '🌡️', '#800000'),
    T('Fire Weather Watch',           'FWA', 'heat',      '🔥', '#ffdead'),
    T('Extreme Fire Danger',          'EFD', 'heat',      '🔥', '#e9967a'),
    T('Heat Advisory',                'HTY', 'heat',      '🌡️', '#ff7f50'),
    T('Air Quality Alert',            'AQA', 'heat',      '😷', '#c97a1e'),
    T('Dense Smoke Advisory',         'DSA', 'heat',      '💨', '#b05a00'),
    T('Smoke Advisory',               'SMY', 'heat',      '💨', '#e09a30'),
    T('Air Stagnation Advisory',      'ASY', 'heat',      '😷', '#808080'),
    // ── Mountains & volcanoes ──
    T('Avalanche Warning',            'AVW', 'mountain',  '🏔️', '#1e90ff'),
    T('Volcano Warning',              'VOW', 'mountain',  '🌋', '#2f4f4f'),
    T('Ashfall Warning',              'AFW', 'mountain',  '🌋', '#a9a9a9'),
    T('Avalanche Watch',              'AVA', 'mountain',  '🏔️', '#f4a460'),
    T('Avalanche Advisory',           'AVY', 'mountain',  '🏔️', '#cd853f'),
    T('Ashfall Advisory',             'AFY', 'mountain',  '🌋', '#696969'),
    // ── Non-weather emergencies ──
    T('Earthquake Warning',           'EQW', 'emergency', '🫨', '#8b4513', 'chime', ON),
    // ── Statements & other warnings ──

    T('Severe Weather Statement',     'SVS', 'statement', '⛈️', '#00ffff'),
    T('Special Weather Statement',    'SPS', 'statement', '⚠️', '#a0a0a0'),
    T('Beach Hazards Statement',      'BHS', 'statement', '🏖️', '#40e0d0'),
    T('Short Term Forecast',          'NOW', 'statement', '📋', '#98fb98'),
    T('Hazardous Weather Outlook',    'HWO', 'statement', '📋', '#eee8aa'),
    T('Hydrologic Outlook',           'ESF', 'statement', '🌊', '#90ee90'),
  ];

  // Not shown or sent at all: civil and law-enforcement notices that aren't
  // weather. Phones already get these through Wireless Emergency Alerts.
  const ALERT_EXCLUDED = ['Evacuation Immediate', 'Shelter In Place Warning', 'Civil Danger Warning',
    'Civil Emergency Message', 'Nuclear Power Plant Warning', 'Radiological Hazard Warning',
    'Hazardous Materials Warning', 'Local Area Emergency', 'Law Enforcement Warning',
    'Child Abduction Emergency', 'Blue Alert', '911 Telephone Outage'];

  // Three sounds. The siren is ONLY for tornado warnings, so it always means "take cover".
  const URGENT_ALSO = new Set(['Tornado Watch', 'Severe Thunderstorm Watch', 'Hurricane Watch', 'Typhoon Watch',
    'Storm Surge Watch', 'Tropical Storm Watch', 'Tsunami Watch', 'Flash Flood Emergency']);
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
    'Lake Effect Snow Advisory': 'Winter Weather Advisory',
    'Lake Effect Snow Watch': 'Winter Storm Watch', 'Hurricane Local Statement': 'Tropical Cyclone Local Statement',
    'Typhoon Local Statement': 'Tropical Cyclone Local Statement',
  };
  const ALERT_GROUPS = Object.values(G);
  const api = { ALERT_CATALOG, ALERT_ALIASES, ALERT_GROUPS, ALERT_EXCLUDED };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WTV_ALERT_CATALOG = api;
})(typeof window !== 'undefined' ? window : globalThis);
