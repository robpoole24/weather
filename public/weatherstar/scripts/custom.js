// WeatherTV custom displays for WS4KP
// Displays: AQI (navId 13), Smoke & Wildfire (navId 14), Tropical Storms (navId 15), UV & Outdoor (navId 16)
// Deploy order in weatherstar/index.html must match navId order.

(function () {
  'use strict';

  // ── WTVDisplay base class ────────────────────────────────────────────────
  // Minimum interface required by WS4KP. All custom displays extend this.
  class WTVDisplay {
    constructor(navId, elemId) {
      this.navId  = navId;
      this.elemId = elemId;
      this.elem   = document.getElementById(elemId);
      this.status = 'loading'; // loading | loaded | disabled | failed
      this.timing = { totalScreens: 1, screenIndex: -1, screenDelay: 0 };
      this._data  = null;
    }

    // Called by WS4KP when the user navigates to a location.
    // weatherParameters contains { latitude, longitude, ... }
    // reload forces a data refresh even if cached.
    getData(weatherParameters, reload) {
      this._params = weatherParameters;
      this._fetch(weatherParameters);
    }

    // REQUIRED — WS4KP calls this when navigating away from this display.
    // Must exist or WS4KP throws and breaks navigation for all displays.
    hideCanvas() {
      if (this.elem) this.elem.style.display = 'none';
    }

    // Show this display and render current data.
    showCanvas(cmd) {
      if (this.elem) this.elem.style.display = '';
      if (this._data) this._render(this._data);
    }

    // Builds the checkbox entry in WS4KP's display list.
    // MUST NOT call _fetch() or getData() here — data loading is triggered
    // by WS4KP calling getData() after location is set.
    generateCheckbox(defaultEnabled) {
      return defaultEnabled !== false;
    }

    setStatus(s) {
      this.status = s;
    }

    navNext() { return false; }       // single-screen display
    sendNavDisplayMessage() {}        // stub — not used for single-screen

    // Subclasses implement these:
    async _fetch(params) {}
    _render(data) {}

    // Helper: write HTML into the content div
    _setContent(html) {
      // elemId is e.g. 'aqi-ws-html' — the content div is 'aqi-ws-content' (no '-html')
      const baseId = this.elemId.replace(/-html$/, '');
      const el = document.getElementById(baseId + '-content');
      if (el) el.innerHTML = html;
    }

    // Helper: render a simple status/loading message
    _setMessage(msg, color) {
      color = color || '#7ec8e3';
      this._setContent(
        `<div style="font-family:'Star4000',monospace;color:${color};font-size:1.1em;
          padding:1.5em 1em;text-align:center;line-height:1.7">${msg}</div>`
      );
    }
  }

  // ── Shared style helpers ─────────────────────────────────────────────────
  const WS_FONT  = "'Star4000', monospace";
  const WS_BLUE  = '#7ec8e3';
  const WS_GOLD  = '#f4d03f';
  const WS_RED   = '#e74c3c';
  const WS_GREEN = '#2ecc71';
  const WS_MUTED = '#8ab0c2';

  function wsRow(label, value, valueColor) {
    valueColor = valueColor || WS_BLUE;
    return `<div style="display:flex;justify-content:space-between;padding:0.18em 0.6em;
      font-family:${WS_FONT};font-size:1em;border-bottom:1px solid rgba(126,200,227,0.12)">
      <span style="color:${WS_MUTED}">${label}</span>
      <span style="color:${valueColor};font-weight:bold">${value}</span>
    </div>`;
  }

  function wsHeader(title, subtitle) {
    return `<div style="font-family:${WS_FONT};text-align:center;padding:0.5em 0 0.3em;
      border-bottom:2px solid ${WS_BLUE};margin-bottom:0.4em">
      <div style="color:${WS_GOLD};font-size:1.25em;font-weight:bold">${title}</div>
      ${subtitle ? `<div style="color:${WS_MUTED};font-size:0.8em;margin-top:0.15em">${subtitle}</div>` : ''}
    </div>`;
  }

  // ── AQI color scale ──────────────────────────────────────────────────────
  const AQI_SCALE = [
    { max: 50,  color: '#00e400', label: 'Good'                         },
    { max: 100, color: '#ffff00', label: 'Moderate'                     },
    { max: 150, color: '#ff7e00', label: 'Unhealthy for Sensitive Groups'},
    { max: 200, color: '#ff0000', label: 'Unhealthy'                    },
    { max: 300, color: '#8f3f97', label: 'Very Unhealthy'               },
    { max: 500, color: '#7e0023', label: 'Hazardous'                    },
  ];
  function aqiColor(v) { for (const s of AQI_SCALE) if (v <= s.max) return s.color; return '#7e0023'; }
  function aqiLabel(v) { for (const s of AQI_SCALE) if (v <= s.max) return s.label; return 'Hazardous'; }

  // ════════════════════════════════════════════════════════════════════════
  // Display 1 — Air Quality Index (navId 13, key: aqi-ws)
  // ════════════════════════════════════════════════════════════════════════
  class AQIDisplay extends WTVDisplay {
    constructor() { super(13, 'aqi-ws-html'); }

    async _fetch(params) {
      this.setStatus('loading');
      this._setMessage('Loading air quality data…');
      try {
        const b = 0.5; // half-degree bounding box
        const url = `/api/aqi?south=${(params.latitude - b).toFixed(4)}&west=${(params.longitude - b).toFixed(4)}&north=${(params.latitude + b).toFixed(4)}&east=${(params.longitude + b).toFixed(4)}`;
        const res  = await fetch(url);
        const data = await res.json();

        // Deduplicate — keep highest AQI per location (PM2.5 + Ozone both appear)
        const byLoc = new Map();
        (Array.isArray(data) ? data : []).forEach(obs => {
          if (!obs.Latitude || !obs.Longitude || obs.AQI == null) return;
          const key = `${Number(obs.Latitude).toFixed(3)},${Number(obs.Longitude).toFixed(3)}`;
          const ex  = byLoc.get(key);
          if (!ex || obs.AQI > ex.AQI) byLoc.set(key, obs);
        });

        const stations = [...byLoc.values()].sort((a, b) => b.AQI - a.AQI);
        if (!stations.length) {
          this._setMessage('No AQI data available\nfor this area.', WS_MUTED);
          this.setStatus('no-data');
          return;
        }

        this._data = stations;
        this._render(stations);
        this.setStatus('loaded');
      } catch (e) {
        console.error('[AQI Display]', e);
        this._setMessage('Air quality data\nunavailable.', WS_RED);
        this.setStatus('failed');
      }
    }

    _render(stations) {
      const top = stations[0];
      const color = aqiColor(top.AQI);
      const label = aqiLabel(top.AQI);

      let rows = '';
      stations.slice(0, 6).forEach(s => {
        const c = aqiColor(s.AQI);
        const area = (s.ReportingArea || s.SiteName || '').slice(0, 22);
        const param = (s.ParameterName || '').replace('PM2.5', 'PM₂.₅');
        rows += wsRow(`${area} (${param})`, s.AQI, c);
      });

      this._setContent(`
        <div style="padding:0.3em 0.4em;font-family:${WS_FONT}">
          ${wsHeader('Air Quality Index', new Date().toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}))}
          <div style="text-align:center;padding:0.4em 0 0.5em">
            <div style="font-size:2.4em;font-weight:bold;color:${color}">${top.AQI}</div>
            <div style="font-size:0.95em;color:${color};margin-top:0.1em">${label}</div>
            <div style="font-size:0.75em;color:${WS_MUTED};margin-top:0.2em">${top.ReportingArea || ''}${top.StateCode ? ', ' + top.StateCode : ''}</div>
          </div>
          <div style="font-size:0.78em;color:${WS_MUTED};padding:0 0.6em 0.3em;text-align:center">Nearby Stations</div>
          ${rows}
          <div style="font-size:0.7em;color:${WS_MUTED};text-align:center;padding:0.4em 0 0.1em">AirNow / EPA · Updated hourly</div>
        </div>
      `);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Display 2 — Smoke & Wildfire (navId 14, key: smoke-ws)
  // ════════════════════════════════════════════════════════════════════════
  class SmokeDisplay extends WTVDisplay {
    constructor() { super(14, 'smoke-ws-html'); }

    async _fetch(params) {
      this.setStatus('loading');
      this._setMessage('Loading smoke & fire data…');
      try {
        const [smokeRes, fireRes] = await Promise.allSettled([
          fetch('/api/hms-smoke').then(r => r.json()),
          fetch('/api/fire-perimeters').then(r => r.json()),
        ]);

        const smokeData = smokeRes.status === 'fulfilled' ? smokeRes.value : null;
        const fireData  = fireRes.status  === 'fulfilled' ? fireRes.value  : null;

        // Count smoke plumes near the user (within ~3 degrees)
        const LAT = params.latitude, LNG = params.longitude;
        const RANGE = 3.0;

        const smokeCounts = { Light: 0, Medium: 0, Heavy: 0 };
        if (smokeData?.features) {
          smokeData.features.forEach(f => {
            const d = f.properties?.Density || 'Light';
            // Rough bbox check on first coordinate of polygon
            const coords = f.geometry?.coordinates?.[0]?.[0];
            if (!coords) return;
            const [lng, lat] = coords;
            if (Math.abs(lat - LAT) < RANGE && Math.abs(lng - LNG) < RANGE) {
              smokeCounts[d] = (smokeCounts[d] || 0) + 1;
            }
          });
        }

        const nearbyFires = [];
        if (fireData?.features) {
          fireData.features.forEach(f => {
            const p = f.properties || {};
            const coords = f.geometry?.coordinates?.[0]?.[0];
            if (!coords) return;
            const [lng, lat] = Array.isArray(coords[0]) ? coords[0] : coords;
            if (Math.abs(lat - LAT) < RANGE * 2 && Math.abs(lng - LNG) < RANGE * 2) {
              nearbyFires.push(p);
            }
          });
        }

        this._data = { smokeCounts, nearbyFires, smokeData, fireData };
        this._render(this._data);
        this.setStatus('loaded');
      } catch (e) {
        console.error('[Smoke Display]', e);
        this._setMessage('Smoke & fire data\nunavailable.', WS_RED);
        this.setStatus('failed');
      }
    }

    _render({ smokeCounts, nearbyFires }) {
      const totalSmoke = smokeCounts.Light + smokeCounts.Medium + smokeCounts.Heavy;
      const smokeColor = smokeCounts.Heavy > 0 ? WS_RED : smokeCounts.Medium > 0 ? '#ff7e00' : smokeCounts.Light > 0 ? '#f4d03f' : WS_GREEN;
      const smokeStatus = totalSmoke === 0 ? 'None detected nearby' : `${totalSmoke} plume${totalSmoke !== 1 ? 's' : ''} nearby`;

      let fireRows = '';
      if (nearbyFires.length === 0) {
        fireRows = `<div style="font-family:${WS_FONT};color:${WS_GREEN};text-align:center;padding:0.3em">No active fires nearby</div>`;
      } else {
        nearbyFires.slice(0, 5).forEach(p => {
          const name  = (p.IncidentName || 'Unknown Fire').slice(0, 20);
          const acres = p.GISAcres ? Math.round(p.GISAcres).toLocaleString() + ' ac' : '—';
          const pct   = p.PercentContained != null ? p.PercentContained + '% contained' : '';
          fireRows += wsRow(name, `${acres}${pct ? ' · ' + pct : ''}`, WS_RED);
        });
      }

      this._setContent(`
        <div style="padding:0.3em 0.4em;font-family:${WS_FONT}">
          ${wsHeader('Smoke & Wildfire', new Date().toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}))}
          <div style="padding:0.3em 0.5em 0.4em">
            <div style="font-size:0.78em;color:${WS_MUTED};margin-bottom:0.2em">SMOKE PLUMES NEARBY</div>
            <div style="color:${smokeColor};font-size:1.05em;font-weight:bold;margin-bottom:0.3em">${smokeStatus}</div>
            ${totalSmoke > 0 ? `
              ${smokeCounts.Heavy  > 0 ? wsRow('Heavy smoke',  smokeCounts.Heavy  + ' plume(s)', WS_RED)    : ''}
              ${smokeCounts.Medium > 0 ? wsRow('Medium smoke', smokeCounts.Medium + ' plume(s)', '#ff7e00') : ''}
              ${smokeCounts.Light  > 0 ? wsRow('Light smoke',  smokeCounts.Light  + ' plume(s)', '#f4d03f') : ''}
            ` : ''}
          </div>
          <div style="font-size:0.78em;color:${WS_MUTED};padding:0.2em 0.5em 0.2em">ACTIVE FIRES NEARBY</div>
          ${fireRows}
          <div style="font-size:0.7em;color:${WS_MUTED};text-align:center;padding:0.4em 0 0.1em">NOAA HMS / NIFC · Updated daily</div>
        </div>
      `);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Display 3 — Tropical Storms (navId 15, key: hurricane-ws)
  // ════════════════════════════════════════════════════════════════════════
  class HurricaneDisplay extends WTVDisplay {
    constructor() { super(15, 'hurricane-ws-html'); }

    async _fetch(params) {
      this.setStatus('loading');
      this._setMessage('Loading tropical storm data…');
      try {
        // Must go through server proxy — direct fetch to nhc.noaa.gov is CORS-blocked
        const res  = await fetch('/api/nhc-storms');
        const data = await res.json();
        this._data = data;
        this._render(data);
        this.setStatus('loaded');
      } catch (e) {
        console.error('[Hurricane Display]', e);
        this._setMessage('Tropical storm data\nunavailable.', WS_RED);
        this.setStatus('failed');
      }
    }

    _render(data) {
      const storms = data.activeStorms || [];
      if (!storms.length) {
        this._setContent(`
          <div style="padding:0.3em 0.4em;font-family:${WS_FONT}">
            ${wsHeader('Tropical Storms', 'NHC Active Storms')}
            <div style="text-align:center;padding:1.2em 0.5em;color:${WS_GREEN};font-size:1.05em">
              No active tropical storms
            </div>
            <div style="text-align:center;font-size:0.78em;color:${WS_MUTED};padding:0.3em">
              The Atlantic and Pacific basins<br>have no active named storms.
            </div>
            <div style="font-size:0.7em;color:${WS_MUTED};text-align:center;padding:0.5em 0 0.1em">NHC / NOAA · Updated every 6 hours</div>
          </div>
        `);
        return;
      }

      let rows = '';
      storms.forEach(s => {
        const name  = s.name || 'Unknown';
        const type  = s.classification || s.type || '';
        const winds = s.maxWinds != null ? s.maxWinds + ' kt' : '—';
        const move  = [s.movementDir, s.movementSpeed != null ? s.movementSpeed + ' kt' : ''].filter(Boolean).join(' @ ');
        const color = (s.maxWinds >= 96) ? WS_RED : (s.maxWinds >= 64) ? '#ff7e00' : WS_GOLD;
        rows += `
          <div style="border:1px solid rgba(126,200,227,0.2);border-radius:3px;margin:0.3em 0.2em;padding:0.3em 0.5em">
            <div style="color:${color};font-weight:bold;font-size:1.05em">${name} <span style="font-size:0.8em;font-weight:normal;color:${WS_MUTED}">${type}</span></div>
            ${wsRow('Max winds', winds, color)}
            ${move ? wsRow('Movement', move, WS_BLUE) : ''}
          </div>`;
      });

      this._setContent(`
        <div style="padding:0.3em 0.4em;font-family:${WS_FONT}">
          ${wsHeader('Tropical Storms', `${storms.length} Active Storm${storms.length !== 1 ? 's' : ''}`)}
          ${rows}
          <div style="font-size:0.7em;color:${WS_MUTED};text-align:center;padding:0.4em 0 0.1em">NHC / NOAA · Updated every 6 hours</div>
        </div>
      `);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Display 4 — UV & Outdoor (navId 16, key: astronomy-ws)
  // Note: key stays astronomy-ws to match DOM id and URL params from prior sessions
  // ════════════════════════════════════════════════════════════════════════
  class OutdoorDisplay extends WTVDisplay {
    constructor() { super(16, 'astronomy-ws-html'); }

    async _fetch(params) {
      this.setStatus('loading');
      this._setMessage('Loading UV & outdoor data…');
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${params.latitude.toFixed(4)}&longitude=${params.longitude.toFixed(4)}&current=uv_index,cloud_cover,visibility,precipitation,wind_speed_10m,temperature_2m,relative_humidity_2m&daily=uv_index_max,precipitation_sum&timezone=auto&forecast_days=3`;
        const res  = await fetch(url);
        const data = await res.json();
        this._data = data;
        this._render(data);
        this.setStatus('loaded');
      } catch (e) {
        console.error('[Outdoor Display]', e);
        this._setMessage('UV & outdoor data\nunavailable.', WS_RED);
        this.setStatus('failed');
      }
    }

    _render(data) {
      const c = data.current || {};
      const d = data.daily   || {};

      const uv      = c.uv_index != null ? c.uv_index.toFixed(1) : '—';
      const uvMax   = d.uv_index_max?.[0] != null ? d.uv_index_max[0].toFixed(1) : '—';
      const cloud   = c.cloud_cover != null ? c.cloud_cover + '%' : '—';
      const vis     = c.visibility  != null ? (c.visibility / 1000).toFixed(1) + ' km' : '—';
      const precip  = c.precipitation != null ? c.precipitation + ' mm' : '—';
      const wind    = c.wind_speed_10m != null ? c.wind_speed_10m + ' km/h' : '—';
      const humid   = c.relative_humidity_2m != null ? c.relative_humidity_2m + '%' : '—';

      const uvNum   = parseFloat(uv);
      const uvColor = isNaN(uvNum) ? WS_MUTED
        : uvNum >= 11 ? WS_RED
        : uvNum >= 8  ? '#ff7e00'
        : uvNum >= 6  ? '#f4d03f'
        : uvNum >= 3  ? WS_GREEN
        : WS_BLUE;
      const uvRisk  = isNaN(uvNum) ? '—'
        : uvNum >= 11 ? 'Extreme'
        : uvNum >= 8  ? 'Very High'
        : uvNum >= 6  ? 'High'
        : uvNum >= 3  ? 'Moderate'
        : 'Low';

      // 3-day UV outlook
      let uvForecast = '';
      if (d.uv_index_max && d.time) {
        d.time.slice(0, 3).forEach((t, i) => {
          const dayUV  = d.uv_index_max[i];
          const dayStr = new Date(t + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
          const dayCol = dayUV == null ? WS_MUTED : dayUV >= 8 ? WS_RED : dayUV >= 6 ? '#ff7e00' : dayUV >= 3 ? WS_GOLD : WS_GREEN;
          uvForecast += wsRow(dayStr, dayUV != null ? 'UV ' + dayUV.toFixed(1) : '—', dayCol);
        });
      }

      this._setContent(`
        <div style="padding:0.3em 0.4em;font-family:${WS_FONT}">
          ${wsHeader('UV & Outdoor Conditions', new Date().toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}))}
          <div style="text-align:center;padding:0.35em 0 0.4em">
            <div style="font-size:2.2em;font-weight:bold;color:${uvColor}">${uv}</div>
            <div style="font-size:0.9em;color:${uvColor}">${uvRisk} UV Risk</div>
            <div style="font-size:0.72em;color:${WS_MUTED};margin-top:0.15em">Today's Max: ${uvMax}</div>
          </div>
          ${wsRow('Cloud cover', cloud, WS_BLUE)}
          ${wsRow('Visibility', vis, WS_BLUE)}
          ${wsRow('Humidity', humid, WS_BLUE)}
          ${wsRow('Wind', wind, WS_BLUE)}
          ${wsRow('Precip (1h)', precip, WS_BLUE)}
          <div style="font-size:0.78em;color:${WS_MUTED};padding:0.4em 0.5em 0.2em">3-DAY UV FORECAST</div>
          ${uvForecast}
          <div style="font-size:0.7em;color:${WS_MUTED};text-align:center;padding:0.4em 0 0.1em">Open-Meteo · Updated hourly</div>
        </div>
      `);
    }
  }

  // ── Register all displays with WS4KP ────────────────────────────────────
  // window.wtvRegisterDisplay is injected into shared.min.js via the manual
  // edit to shared.min.js (after window.applyScanlineScaling = F).
  // WS4KP may have already processed location by the time this script runs,
  // so after registration we manually trigger getData() if lat/lng are
  // already in the URL params.

  function registerDisplays() {
    if (typeof window.wtvRegisterDisplay !== 'function') {
      console.error('[WTV] wtvRegisterDisplay not found — check shared.min.js injection');
      return;
    }

    const displays = [
      new AQIDisplay(),
      new SmokeDisplay(),
      new HurricaneDisplay(),
      new OutdoorDisplay(),
    ];

    displays.forEach(d => window.wtvRegisterDisplay(d));

    // If location is already set in URL params, WS4KP may have fired getData
    // before our displays were registered. Trigger it manually so they load.
    // WS4KP encodes location as latLon={"lat":...,"lon":...} JSON param
    // Also try separate lat/lon params as fallback
    const params = new URLSearchParams(window.location.search);
    let lat = NaN, lon = NaN;
    const latLonRaw = params.get('latLon');
    if (latLonRaw) {
      try {
        const parsed = JSON.parse(decodeURIComponent(latLonRaw));
        lat = parseFloat(parsed.lat);
        lon = parseFloat(parsed.lon);
      } catch(e) {}
    }
    if (isNaN(lat)) lat = parseFloat(params.get('lat'));
    if (isNaN(lon)) lon = parseFloat(params.get('lon') || params.get('lng'));

    if (!isNaN(lat) && !isNaN(lon)) {
      const weatherParameters = { latitude: lat, longitude: lon };
      displays.forEach(d => {
        try { d.getData(weatherParameters, false); } catch (e) {}
      });
    }
  }

  // Register after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', registerDisplays);
  } else {
    registerDisplays();
  }

})();
