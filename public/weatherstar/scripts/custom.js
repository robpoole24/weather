// WeatherTV Custom WeatherStar Displays
// Registers AQI, Smoke/Wildfire, Tropical Storms, and Astronomy screens
// into the WS4KP rotation using the exposed wtvRegisterDisplay hook.
// Requires: resources/suncalc.js (loaded before this file)
// Data sources: WeatherTV's own server-side APIs + NHC public JSON

(function() {
  'use strict';

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function getLatLon() {
    try {
      const raw = new URLSearchParams(window.location.search).get('latLon');
      if (!raw) return null;
      return JSON.parse(raw); // { lat, lon }
    } catch(_) { return null; }
  }

  function fmt12(date) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  // Point-in-polygon (ray casting)
  function pointInPoly(lat, lng, geometry) {
    if (!geometry) return false;
    const polys = geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.coordinates;
    for (const poly of polys) {
      const ring = poly[0];
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi))
          inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  // ── Base class for WTV custom displays ───────────────────────────────────────
  // Implements the minimum WS4KP display interface so screens appear
  // in the rotation and in the Selected Displays panel.
  class WTVDisplay {
    constructor(navId, elemId, name, defaultEnabled) {
      this.navId          = navId;
      this.elemId         = elemId;
      this.name           = name;
      this.defaultEnabled = defaultEnabled;
      this.isEnabled      = false;
      this.status         = 'loading';
      this._totalScreens  = 0;
      this._data          = null;
      this._weatherParams = null;
      this.checkbox       = null;
    }

    get timing() {
      return { totalScreens: this._totalScreens, screenIndex: -1 };
    }

    // Called by WS4KP's checkbox panel builder
    generateCheckbox(defaultEnabled) {
      const def = defaultEnabled !== undefined ? defaultEnabled : this.defaultEnabled;
      const params  = new URLSearchParams(window.location.search);
      const urlVal  = params.get(this.elemId) ?? params.get(this.elemId + '-checkbox');
      let enabled;
      if (urlVal !== null && urlVal !== undefined) {
        enabled = (urlVal === 'true');
      } else {
        const lsVal = window.localStorage.getItem('display-enabled: ' + this.elemId);
        enabled = lsVal !== null ? (lsVal === 'true') : Boolean(def);
      }
      this.isEnabled = enabled;
      window.localStorage.setItem('display-enabled: ' + this.elemId, enabled);

      if (!this.isEnabled) {
        this.status = 'disabled';
        return false;
      }

      // Data loads via getData() when WS4KP provides location — NOT here

      const label = document.createElement('label');
      label.id = 'label-' + this.elemId;
      const cb = document.createElement('input');
      cb.type    = 'checkbox';
      cb.id      = 'checkbox-' + this.elemId;
      cb.checked = true;
      cb.addEventListener('change', e => {
        this.isEnabled = e.target.checked;
        window.localStorage.setItem('display-enabled: ' + this.elemId, this.isEnabled);
        if (!this.isEnabled) { this.status = 'disabled'; this._totalScreens = 0; }
        else if (this._weatherParams) this.getData(this._weatherParams);
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode('\u00a0' + this.name));
      this.checkbox = label;
      return label;
    }

    // Called by WS4KP when user sets location — THIS is the correct trigger
    // for data loading. weatherParameters contains { latLon:{lat,lon}, ... }.
    getData(weatherParameters, reload) {
      if (!this.isEnabled) { this.setStatus('disabled'); return false; }
      this._weatherParams = weatherParameters;
      this.setStatus('loading');
      this._load(weatherParameters);
      return true;
    }

    async _load(weatherParameters) {
      this.status = 'loading';
      try {
        await this.fetchData(weatherParameters);
        this._totalScreens = 1;
        this.status = 'loaded';
      } catch(e) {
        console.warn('[WTV:' + this.name + '] load failed:', e.message);
        this.status = 'failed';
      }
    }

    // Override in subclasses
    async fetchData() {}
    renderContent(el) {}

    // Called by WS4KP navigation when this display becomes active
    hideCanvas() {
      // Called by WS4KP navigation when leaving this display
      const el = document.getElementById(this.elemId + '-html');
      if (el) el.style.display = 'none';
    }

    showCanvas(cmd) {
      const el = document.getElementById(this.elemId + '-html');
      if (!el) return;
      el.style.display = '';
      // Re-fetch on each show so data stays fresh
      this._load().then(() => {
        const contentEl = el.querySelector('.wtv-content');
        if (contentEl) this.renderContent(contentEl);
      });
    }

    setStatus(s) { this.status = s; }
    sendNavDisplayMessage() {}
    navNext() { return false; }
    navPrev() { return false; }
  }

  // ── Shared WS4KP visual style helpers ────────────────────────────────────────
  const WS = {
    // Amber = WS4KP's primary data color
    amber:  '#ffcc00',
    white:  '#ffffff',
    red:    '#ff4444',
    orange: '#ff8c00',
    green:  '#00cc44',
    muted:  '#aaaacc',
    bg:     'transparent',

    // Render a simple data row: label + value
    row(label, value, color) {
      return '<div class="wtv-row">'
        + '<span class="wtv-label">' + label + '</span>'
        + '<span class="wtv-value" style="color:' + (color || WS.amber) + '">' + value + '</span>'
        + '</div>';
    },

    // Render a section header
    heading(text, color) {
      return '<div class="wtv-heading" style="color:' + (color || WS.white) + '">' + text + '</div>';
    },

    bigValue(value, label, color) {
      return '<div class="wtv-big">'
        + '<div class="wtv-big-num" style="color:' + (color || WS.amber) + '">' + value + '</div>'
        + '<div class="wtv-big-label">' + label + '</div>'
        + '</div>';
    },

    // Source attribution line
    source(text) {
      return '<div class="wtv-source">' + text + '</div>';
    },

    css: `
      .wtv-custom { padding:0; overflow:hidden; }
      .wtv-content {
        font-family: 'Star4000', Arial, sans-serif;
        padding: 8px 16px;
        height: 100%;
        display: flex;
        flex-direction: column;
        gap: 4px;
        box-sizing: border-box;
      }
      .wtv-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        padding: 2px 0;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        font-size: 1em;
      }
      .wtv-label { color: #aaaacc; font-size: 0.85em; }
      .wtv-value { font-size: 1em; }
      .wtv-heading {
        font-family: 'Star4000 Large', 'Star4000', Arial, sans-serif;
        font-size: 1.1em;
        margin: 6px 0 2px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }
      .wtv-big {
        text-align: center;
        margin: 8px 0;
      }
      .wtv-big-num {
        font-family: 'Star4000 Large', 'Star4000', Arial, sans-serif;
        font-size: 3em;
        line-height: 1;
      }
      .wtv-big-label {
        font-family: 'Star4000', Arial, sans-serif;
        font-size: 0.9em;
        color: #aaaacc;
        margin-top: 2px;
      }
      .wtv-source {
        margin-top: auto;
        font-size: 0.65em;
        color: #888899;
        text-align: right;
        padding-top: 4px;
      }
      .wtv-alert-box {
        border: 2px solid;
        padding: 6px 10px;
        border-radius: 4px;
        margin: 6px 0;
        font-size: 0.85em;
        line-height: 1.4;
      }
      .wtv-loc {
        font-family: 'Star4000 Large', 'Star4000', Arial, sans-serif;
        font-size: 1em;
        color: #aaaacc;
        margin-bottom: 4px;
      }
    `,
  };

  // Inject shared CSS once
  const styleEl = document.createElement('style');
  styleEl.textContent = WS.css;
  document.head.appendChild(styleEl);

  // ── 1. Air Quality Index Display ─────────────────────────────────────────────
  class AQIDisplay extends WTVDisplay {
    constructor() { super(13, 'aqi-ws', 'Air Quality', false); }

    async fetchData(wp) {
      const ll = (wp && wp.latLon) ? wp.latLon : getLatLon();
      if (!ll) throw new Error('no location');
      const res = await fetch('/api/aqi?lat=' + ll.lat.toFixed(4) + '&lng=' + ll.lon.toFixed(4));
      const data = await res.json();
      // Deduplicate by location, keep highest AQI
      const byLoc = new Map();
      (Array.isArray(data) ? data : []).forEach(o => {
        const key = (o.Latitude||0).toFixed(2) + ',' + (o.Longitude||0).toFixed(2);
        if (!byLoc.has(key) || o.AQI > byLoc.get(key).AQI) byLoc.set(key, o);
      });
      // Sort by proximity to user location, take closest 3
      const obs = [...byLoc.values()].sort((a, b) => {
        const da = Math.hypot((a.Latitude||0)-ll.lat, (a.Longitude||0)-ll.lon);
        const db = Math.hypot((b.Latitude||0)-ll.lat, (b.Longitude||0)-ll.lon);
        return da - db;
      });
      this._data = obs.slice(0, 3);
      if (!this._data.length) throw new Error('no observations');
    }

    aqiColor(aqi) {
      if (aqi <= 50)  return '#00e400';
      if (aqi <= 100) return '#ffff00';
      if (aqi <= 150) return '#ff7e00';
      if (aqi <= 200) return '#ff0000';
      if (aqi <= 300) return '#8f3f97';
      return '#7e0023';
    }

    aqiLabel(aqi) {
      if (aqi <= 50)  return 'Good';
      if (aqi <= 100) return 'Moderate';
      if (aqi <= 150) return 'Unhealthy for Sensitive Groups';
      if (aqi <= 200) return 'Unhealthy';
      if (aqi <= 300) return 'Very Unhealthy';
      return 'Hazardous';
    }

    renderContent(el) {
      if (!this._data || !this._data.length) {
        el.innerHTML = '<div style="color:#aaa;padding:20px;text-align:center">No AQI data available for this location</div>';
        return;
      }
      const top = this._data[0];
      const aqi = top.AQI;
      const color = this.aqiColor(aqi);
      const cat = top.Category?.Name || this.aqiLabel(aqi);
      const param = top.ParameterName || top.Parameter || '';
      const area = top.ReportingArea || top.SiteName || '';
      const state = top.StateCode || '';

      const health = aqi <= 50 ? 'Air quality is satisfactory and poses little or no risk.'
        : aqi <= 100 ? 'Unusually sensitive individuals should consider limiting prolonged outdoor activity.'
        : aqi <= 150 ? 'Members of sensitive groups may experience health effects. The general public is less likely to be affected.'
        : aqi <= 200 ? 'Everyone may begin to experience health effects. Sensitive groups may experience more serious effects.'
        : aqi <= 300 ? 'Health alert: everyone may experience more serious health effects.'
        : 'Health warning of emergency conditions — entire population more likely to be affected.';

      let html = WS.bigValue(aqi, cat, color);
      if (area) html += '<div class="wtv-loc">' + area + (state ? ', ' + state : '') + '</div>';
      if (param) html += WS.row('Primary Pollutant', param, WS.white);

      // Additional nearby stations
      if (this._data.length > 1) {
        html += WS.heading('Nearby Stations', WS.muted);
        this._data.slice(1).forEach(o => {
          const c2 = this.aqiColor(o.AQI);
          const a2 = o.ReportingArea || o.SiteName || '';
          html += WS.row(a2, 'AQI ' + o.AQI, c2);
        });
      }

      html += '<div class="wtv-alert-box" style="border-color:' + color + ';color:' + WS.white + ';font-size:0.72em;margin-top:6px">'
        + health + '</div>';
      html += WS.source('AirNow / EPA · Updated hourly');
      el.innerHTML = html;
    }
  }

  // ── 2. Smoke & Wildfire Display ───────────────────────────────────────────────
  class SmokeDisplay extends WTVDisplay {
    constructor() { super(14, 'smoke-ws', 'Smoke && Wildfire', false); }

    async fetchData(wp) {
      const ll = (wp && wp.latLon) ? wp.latLon : getLatLon();
      if (!ll) throw new Error('no location');
      const [smokeRes, fireRes] = await Promise.allSettled([
        fetch('/api/hms-smoke').then(r => r.json()),
        fetch('/api/fire-perimeters').then(r => r.json()),
      ]);
      const smoke = smokeRes.status === 'fulfilled' ? smokeRes.value : { features: [] };
      const fires = fireRes.status  === 'fulfilled' ? fireRes.value  : { features: [] };

      // Find smoke density at user location
      let density = null;
      for (const f of (smoke.features || [])) {
        if (pointInPoly(ll.lat, ll.lon, f.geometry)) {
          density = f.properties?.Density || 'Light';
          break;
        }
      }

      // Count smoke features by density
      const counts = { Heavy: 0, Medium: 0, Light: 0 };
      (smoke.features || []).forEach(f => {
        const d = f.properties?.Density || 'Light';
        counts[d] = (counts[d] || 0) + 1;
      });

      // Nearest fires
      const nearFires = (fires.features || [])
        .map(f => {
          const coords = f.geometry?.coordinates;
          if (!coords) return null;
          // Approximate centroid from first ring
          const ring = f.geometry.type === 'Polygon' ? coords[0] : coords[0]?.[0];
          if (!ring || !ring.length) return null;
          const cx = ring.reduce((s,c) => s+c[0], 0) / ring.length;
          const cy = ring.reduce((s,c) => s+c[1], 0) / ring.length;
          const dist = Math.hypot(cx - ll.lon, cy - ll.lat) * 69; // rough miles
          return { ...f.properties, dist: Math.round(dist) };
        })
        .filter(Boolean)
        .sort((a,b) => a.dist - b.dist)
        .slice(0, 3);

      this._data = { density, counts, nearFires, ll };
    }

    smokeColor(density) {
      if (density === 'Heavy')  return '#8b3a3a';
      if (density === 'Medium') return '#c8773a';
      return '#d4a857';
    }

    renderContent(el) {
      const d = this._data;
      if (!d) { el.innerHTML = '<div style="color:#aaa;padding:20px;text-align:center">No smoke data available</div>'; return; }

      let html = '';
      if (d.density) {
        const color = this.smokeColor(d.density);
        html += WS.bigValue(d.density.toUpperCase(), 'Smoke Density at Your Location', color);
        const advice = d.density === 'Heavy'
          ? 'Limit all outdoor activity. Wear N95 if going outside.'
          : d.density === 'Medium'
          ? 'Sensitive groups should limit outdoor exposure.'
          : 'Air quality may be affected. Monitor for changes.';
        html += '<div class="wtv-alert-box" style="border-color:' + color + ';color:' + WS.white + ';font-size:0.75em">' + advice + '</div>';
      } else {
        html += '<div class="wtv-big"><div class="wtv-big-num" style="color:' + WS.green + '">CLEAR</div>'
          + '<div class="wtv-big-label">No smoke detected at your location</div></div>';
      }

      // National smoke summary
      const total = (d.counts.Heavy || 0) + (d.counts.Medium || 0) + (d.counts.Light || 0);
      if (total > 0) {
        html += WS.heading('National Smoke Plumes Today', WS.muted);
        if (d.counts.Heavy)  html += WS.row('Heavy',  d.counts.Heavy  + ' region' + (d.counts.Heavy  > 1 ? 's' : ''), '#8b3a3a');
        if (d.counts.Medium) html += WS.row('Medium', d.counts.Medium + ' region' + (d.counts.Medium > 1 ? 's' : ''), '#c8773a');
        if (d.counts.Light)  html += WS.row('Light',  d.counts.Light  + ' region' + (d.counts.Light  > 1 ? 's' : ''), '#d4a857');
      }

      // Nearest active fires
      if (d.nearFires.length) {
        html += WS.heading('Nearest Active Fires', WS.muted);
        d.nearFires.forEach(f => {
          const name = f.IncidentName || 'Active Fire';
          const acres = f.GISAcres ? Math.round(f.GISAcres).toLocaleString() + ' ac' : '—';
          html += WS.row(name + ' · ' + f.dist + ' mi', acres, WS.orange);
        });
      }

      html += WS.source('NOAA HMS Smoke · NIFC WFIGS · Updated daily');
      el.innerHTML = html;
    }
  }

  // ── 3. Tropical Storms Display ────────────────────────────────────────────────
  class HurricaneDisplay extends WTVDisplay {
    constructor() { super(15, 'hurricane-ws', 'Tropical Storms', false); }

    async fetchData(wp) {
      // NHC blocks direct browser requests (no CORS headers) — use server proxy
      const res = await fetch('/api/nhc-storms');
      const data = await res.json();
      this._data = data.activeStorms || data.storms || [];
    }

    catColor(winds) {
      const w = parseInt(winds) || 0;
      if (w >= 137) return '#ff00ff'; // Cat 5
      if (w >= 113) return '#ff4500'; // Cat 4
      if (w >= 96)  return '#ff8c00'; // Cat 3
      if (w >= 83)  return '#ffff00'; // Cat 2
      if (w >= 64)  return '#00bfff'; // Cat 1
      if (w >= 34)  return '#00cc44'; // TS
      return WS.muted; // TD
    }

    catLabel(winds) {
      const w = parseInt(winds) || 0;
      if (w >= 137) return 'Cat 5 Hurricane';
      if (w >= 113) return 'Cat 4 Hurricane';
      if (w >= 96)  return 'Cat 3 Hurricane';
      if (w >= 83)  return 'Cat 2 Hurricane';
      if (w >= 64)  return 'Cat 1 Hurricane';
      if (w >= 34)  return 'Tropical Storm';
      return 'Tropical Depression';
    }

    renderContent(el) {
      if (!this._data || !this._data.length) {
        el.innerHTML = WS.bigValue('NONE', 'No Active Tropical Storms', WS.green)
          + '<div style="color:#aaa;text-align:center;font-size:0.85em;margin-top:8px">'
          + 'Atlantic &amp; Pacific basins are quiet.</div>'
          + WS.source('NOAA / NHC');
        return;
      }

      let html = WS.heading('Active Storms — ' + this._data.length + ' system' + (this._data.length > 1 ? 's' : ''), WS.white);

      this._data.forEach(s => {
        const winds = s.maxWinds || s.MaxWinds || '0';
        const color = this.catColor(winds);
        const type  = this.catLabel(winds);
        const name  = s.name || s.Name || 'Storm';
        const basin = s.basinId || s.BasinId || '';
        const movement = s.movementDir && s.movementSpeed
          ? s.movementDir + ' at ' + s.movementSpeed + ' kt'
          : '—';
        const pressure = s.minimumPressure ? s.minimumPressure + ' mb' : '—';

        html += '<div style="margin:8px 0;padding:6px 8px;border-left:3px solid ' + color + '">';
        html += '<div style="font-family:Star4000 Large,Star4000,Arial;font-size:1.1em;color:' + color + '">'
          + name.toUpperCase() + '</div>';
        html += '<div style="font-size:0.78em;color:' + WS.muted + '">' + type
          + (basin ? ' · ' + basin.toUpperCase() : '') + '</div>';
        html += WS.row('Max Winds', winds + ' kt', color);
        html += WS.row('Movement', movement, WS.white);
        html += WS.row('Pressure', pressure, WS.white);
        html += '</div>';
      });

      html += WS.source('NOAA / National Hurricane Center');
      el.innerHTML = html;
    }
  }

  // ── 4. UV & Outdoor Conditions Display ──────────────────────────────────────
  // Shows UV index, cloud cover, visibility and outdoor advisories —
  // none of which appear on the WS4KP Almanac screen.
  class OutdoorDisplay extends WTVDisplay {
    constructor() { super(16, 'astronomy-ws', 'UV & Outdoor', false); }

    async fetchData(wp) {
      const ll = (wp && wp.latLon) ? wp.latLon : getLatLon();
      if (!ll) throw new Error('no location');
      const url = 'https://api.open-meteo.com/v1/forecast'
        + '?latitude=' + ll.lat.toFixed(4)
        + '&longitude=' + ll.lon.toFixed(4)
        + '&current=uv_index,cloud_cover,visibility,weather_code'
        + '&hourly=uv_index&forecast_days=1&timezone=auto';
      const data = await (await fetch(url)).json();
      // Sun times for solar noon (not on Almanac)
      let solarNoon = null;
      if (typeof SunCalc !== 'undefined') {
        const pos = SunCalc.getTimes(new Date(), ll.lat, ll.lon);
        solarNoon = pos.solarNoon;
      }
      this._data = { current: data.current, hourly: data.hourly, solarNoon, ll };
    }

    uvLabel(uv) {
      if (uv < 3)  return { label:'Low',       color: WS.green  };
      if (uv < 6)  return { label:'Moderate',   color: WS.amber  };
      if (uv < 8)  return { label:'High',       color: WS.orange };
      if (uv < 11) return { label:'Very High',  color: WS.red    };
      return              { label:'Extreme',    color: '#ff00ff' };
    }

    cloudDesc(pct) {
      if (pct < 10) return 'Clear';
      if (pct < 30) return 'Mostly Clear';
      if (pct < 60) return 'Partly Cloudy';
      if (pct < 85) return 'Mostly Cloudy';
      return 'Overcast';
    }

    renderContent(el) {
      const d = this._data;
      if (!d || !d.current) {
        el.innerHTML = '<div style="color:#aaa;padding:20px;text-align:center">Location required for outdoor data</div>';
        return;
      }
      const c  = d.current;
      const uv = c.uv_index ?? 0;
      const uvInfo = this.uvLabel(uv);
      const cloud = c.cloud_cover ?? 0;
      const vis = c.visibility != null ? (c.visibility / 1000).toFixed(1) + ' km' : '—';

      // Peak UV today from hourly
      let peakUV = uv;
      if (d.hourly && d.hourly.uv_index) {
        peakUV = Math.max(...d.hourly.uv_index);
      }
      const peakInfo = this.uvLabel(peakUV);

      let html = '';
      html += WS.bigValue(uv.toFixed(1), 'UV Index — ' + uvInfo.label, uvInfo.color);

      html += WS.heading('UV CONDITIONS', uvInfo.color);
      html += WS.row('Current UV',  uv.toFixed(1),         uvInfo.color);
      html += WS.row('Peak UV Today', peakUV.toFixed(1),   peakInfo.color);
      if (d.solarNoon) html += WS.row('Solar Noon', fmt12(d.solarNoon), WS.amber);

      // Protection advice
      const advice = uv < 3 ? 'No protection needed for most.'
        : uv < 6  ? 'Wear sunscreen SPF 30+ when outdoors.'
        : uv < 8  ? 'Reduce midday sun exposure. SPF 30+ required.'
        : uv < 11 ? 'Minimize sun exposure 10am–4pm. SPF 50+ required.'
        : 'Avoid sun exposure during peak hours.';
      html += '<div class="wtv-alert-box" style="border-color:' + uvInfo.color + ';color:' + WS.white + ';font-size:0.75em;margin:6px 0">' + advice + '</div>';

      html += WS.heading('SKY CONDITIONS', WS.white);
      html += WS.row('Cloud Cover', cloud + '%  — ' + this.cloudDesc(cloud), WS.white);
      html += WS.row('Visibility',  vis, WS.white);

      html += WS.source('Open-Meteo · Updated hourly');
      el.innerHTML = html;
    }
  }

  // ── Register displays after all WS4KP scripts have loaded ────────────────────
  function registerWTVDisplays() {
    if (typeof window.wtvRegisterDisplay !== 'function') {
      console.warn('[WTV] wtvRegisterDisplay not available — retrying in 500ms');
      setTimeout(registerWTVDisplays, 500);
      return;
    }
    const displays = [
      new AQIDisplay(),
      new SmokeDisplay(),
      new HurricaneDisplay(),
      new OutdoorDisplay(),
    ];
    displays.forEach(d => window.wtvRegisterDisplay(d));
    console.log('[WTV] Custom displays registered: AQI, Smoke, Tropical, UV & Outdoor');

    // WS4KP may have already called getData() on existing displays before our
    // DOMContentLoaded handler fired — manually trigger it on our displays now
    // so they load data immediately rather than waiting for the next location update.
    const ll = getLatLon();
    if (ll) {
      const weatherParameters = { latLon: ll };
      displays.forEach(d => {
        if (d.isEnabled) {
          console.log('[WTV] Triggering getData for:', d.name);
          d.getData(weatherParameters);
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', registerWTVDisplays);
  } else {
    registerWTVDisplays();
  }

})();
