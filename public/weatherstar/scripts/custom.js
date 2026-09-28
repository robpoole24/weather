// WeatherTV custom WeatherStar 4000+ screens — build.1790679600
// Air Quality · Smoke & Wildfire · Tropical Storms · UV & Outdoor
//
// WHY THIS VERSION WORKS (and the old one didn't):
// The old screens imitated WeatherStar's display class. WeatherStar tracks
// status with unique Symbol values, runs a per-screen timer, and each screen
// tells the navigator "done, go next" — the imitation reported text statuses
// ('loaded' never equals WeatherStar's loaded Symbol) and had an empty "go
// next", so screens were skipped or froze the rotation.
//
// This file is loaded as a webpack chunk, which gives it WeatherStar's REAL
// internals: the WeatherDisplay base class (module 24), STATUS (592) and
// registerDisplay (211 → Kb) — exactly what the built-in screens use.
// If WeatherStar is ever rebuilt, re-check these module ids in shared.min.js.
//
// Screens with nothing to show (no smoke/fires nearby, no tropical storms, no
// AirNow key) report "no data" and WeatherStar simply skips them.
(self.webpackChunkws4kp = self.webpackChunkws4kp || []).push([[9001], {
  9001(module, exports, require) {
    const WeatherDisplay = require(24).A;
    const STATUS = require(592).Ay;
    const registerDisplay = require(211).Kb;

    const FONT = "'Star4000', monospace";
    const BLUE = '#7ec8e3', GOLD = '#f4d03f', RED = '#ff5a4a', GREEN = '#2ecc71', MUTED = '#a8c6d6', ORANGE = '#ff9a2e';
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const row = (label, value, color = BLUE) => `<div class="wtv-row"><span>${label}</span><span style="color:${color}">${value}</span></div>`;

    // ── Markup + styling for the four screens (same header as built-in screens)
    const SCREENS = [
      { id: 'aqi-ws', top: 'Air', bottom: 'Quality' },
      { id: 'smoke-ws', top: 'Smoke &amp;', bottom: 'Wildfire' },
      { id: 'hurricane-ws', top: 'Tropical', bottom: 'Storms' },
      { id: 'astronomy-ws', top: 'UV &amp;', bottom: 'Outdoor' },
    ];
    function injectMarkup() {
      const container = document.querySelector('#container');
      if (!container || document.querySelector('#aqi-ws-html')) return;
      const before = container.querySelector(':scope > .scroll');
      SCREENS.forEach((s) => {
        const div = document.createElement('div');
        div.id = `${s.id}-html`;
        div.className = 'weather-display';
        div.innerHTML = `<div class="header"><div class="logo"><img src="images/logos/logo-corner.png"></div>
          <div class="title dual"><div class="top">${s.top}</div><div class="bottom">${s.bottom}</div></div>
          <div class="date-time date"></div><div class="date-time time"></div></div>
          <div class="main has-box wtv-custom"><div class="wtv-content"></div></div>`;
        container.insertBefore(div, before || null);
      });
      const style = document.createElement('style');
      style.textContent = `
        .wtv-custom .wtv-content { font-family:${FONT}; color:#fff; font-size:20px; line-height:1.25; padding:8px 18px;
          height:100%; box-sizing:border-box; overflow:hidden; text-shadow:3px 3px 0 #000; }
        .wtv-custom .wtv-big { font-size:48px; text-align:center; margin:2px 0 0; }
        .wtv-custom .wtv-sub { text-align:center; font-size:20px; margin-bottom:6px; }
        .wtv-custom .wtv-label { color:${GOLD}; font-size:18px; margin:6px 0 2px; }
        .wtv-custom .wtv-row { display:flex; justify-content:space-between; gap:12px; padding:1px 0; }
        .wtv-custom .wtv-row span:first-child { color:${MUTED}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .wtv-custom .wtv-row span:last-child { white-space:nowrap; }
        .wtv-custom .wtv-src { font-size:14px; color:${MUTED}; text-align:center; margin-top:6px; }`;
      document.head.appendChild(style);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectMarkup);
    else injectMarkup();

    // ── Base class: fetch → store → report status → draw, the WeatherStar way
    class WTVScreen extends WeatherDisplay {
      constructor(navId, elemId, name) {
        super(navId, elemId, name, false);   // off by default; WeatherTV turns them on via URL
        this.timing.totalScreens = 1;
        this.refreshTime = 15 * 60 * 1000;    // these sources change slowly
      }

      async getData(weatherParameters, refresh) {
        const ok = super.getData(weatherParameters, refresh);   // handles enabled/disabled + loading status
        if (!ok) return;
        try {
          const data = await this.fetchData(this.weatherParameters);
          if (data == null) {                  // nothing worth a screen → WeatherStar skips it
            this.data = undefined;
            this.setStatus(STATUS.noData);
            return;
          }
          this.data = data;
          this.getDataCallback();
          this.setStatus(STATUS.loaded);
          if (this.active) this.drawCanvas();  // refresh in place if it's on screen now
        } catch (e) {
          console.error(`[WTV ${this.name}]`, e);
          if (this.isEnabled) this.setStatus(STATUS.failed);
        }
      }

      drawCanvas() {
        super.drawCanvas();
        const box = this.elem && this.elem.querySelector('.wtv-content');
        if (box && this.data) box.innerHTML = this.render(this.data);
        this.finishDraw();
      }
    }

    // ── Air Quality (AirNow via /api/aqi; needs AIRNOW_KEY on the server)
    const AQI = [[50, '#00e400', 'Good'], [100, '#ffff00', 'Moderate'], [150, '#ff7e00', 'Unhealthy for Sensitive Groups'],
      [200, '#ff0000', 'Unhealthy'], [300, '#8f3f97', 'Very Unhealthy'], [Infinity, '#7e0023', 'Hazardous']];
    const aqiInfo = (v) => AQI.find(([max]) => v <= max);
    class AirQuality extends WTVScreen {
      async fetchData({ latitude: lat, longitude: lon }) {
        const b = 0.5;
        const r = await fetch(`/api/aqi?south=${(lat - b).toFixed(4)}&west=${(lon - b).toFixed(4)}&north=${(lat + b).toFixed(4)}&east=${(lon + b).toFixed(4)}`);
        if (!r.ok) return null;                // no key configured, or AirNow down → skip screen
        const obs = await r.json();
        const byLoc = new Map();
        (Array.isArray(obs) ? obs : []).forEach((o) => {
          if (o.AQI == null || o.AQI < 0 || !o.Latitude) return;
          const k = `${(+o.Latitude).toFixed(3)},${(+o.Longitude).toFixed(3)}`;
          if (!byLoc.has(k) || o.AQI > byLoc.get(k).AQI) byLoc.set(k, o);
        });
        const stations = [...byLoc.values()].sort((a, b) => b.AQI - a.AQI);
        return stations.length ? stations : null;
      }
      render(st) {
        const top = st[0];
        const [, color, label] = aqiInfo(top.AQI);
        return `<div class="wtv-big" style="color:${color}">${top.AQI}</div>
          <div class="wtv-sub" style="color:${color}">${esc(label)}</div>
          <div class="wtv-label">Nearby stations</div>
          ${st.slice(0, 5).map((s) => row(esc(`${(s.ReportingArea || s.SiteName || '').slice(0, 18)} ${String(s.ParameterName || '').replace('PM2.5', 'PM2.5')}`), s.AQI, aqiInfo(s.AQI)[1])).join('')}
          <div class="wtv-src">AirNow / EPA · updated hourly</div>`;
      }
    }

    // ── Smoke & Wildfire (NOAA HMS smoke + NIFC fire perimeters)
    function bboxOf(geom) {
      let s = 90, w = 180, n = -90, e = -180;
      const walk = (c) => { if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else c.forEach(walk); };
      if (geom && geom.coordinates) walk(geom.coordinates);
      return [s, w, n, e];
    }
    const near = ([s, w, n, e], lat, lon, deg) => lat >= s - deg && lat <= n + deg && lon >= w - deg && lon <= e + deg;
    class SmokeFire extends WTVScreen {
      async fetchData({ latitude: lat, longitude: lon }) {
        const [smoke, fire] = await Promise.all([
          fetch('/api/hms-smoke').then((r) => (r.ok ? r.json() : null)).catch(() => null),
          fetch('/api/fire-perimeters').then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]);
        const counts = { Heavy: 0, Medium: 0, Light: 0 };
        ((smoke && smoke.features) || []).forEach((f) => {
          if (near(bboxOf(f.geometry), lat, lon, 0.5)) counts[f.properties?.Density || 'Light'] += 1;
        });
        const fires = ((fire && fire.features) || [])
          .filter((f) => near(bboxOf(f.geometry), lat, lon, 2.0))
          .map((f) => f.properties || {})
          .sort((a, b) => (b.GISAcres || 0) - (a.GISAcres || 0));
        if (!counts.Heavy && !counts.Medium && !counts.Light && !fires.length) return null;
        return { counts, fires };
      }
      render({ counts, fires }) {
        const worst = counts.Heavy ? ['Heavy smoke overhead', RED] : counts.Medium ? ['Moderate smoke overhead', ORANGE]
          : counts.Light ? ['Light smoke overhead', GOLD] : ['No smoke overhead', GREEN];
        return `<div class="wtv-sub" style="color:${worst[1]};font-size:26px;margin-top:6px">${worst[0]}</div>
          <div class="wtv-label">Active fires within ~120 miles</div>
          ${fires.length ? fires.slice(0, 5).map((p) => row(esc((p.IncidentName || 'Unnamed fire').slice(0, 20)),
            `${p.GISAcres ? Math.round(p.GISAcres).toLocaleString() + ' ac' : ''}${p.PercentContained != null ? ' · ' + p.PercentContained + '%' : ''}`, RED)).join('')
            : `<div class="wtv-sub" style="color:${GREEN}">None reported</div>`}
          <div class="wtv-src">NOAA HMS · NIFC</div>`;
      }
    }

    // ── Tropical Storms (NHC via /api/nhc-storms)
    class Tropical extends WTVScreen {
      async fetchData() {
        const r = await fetch('/api/nhc-storms');
        if (!r.ok) return null;
        const d = await r.json();
        const storms = d.activeStorms || [];
        return storms.length ? storms : null;   // quiet basins → skip the screen
      }
      render(storms) {
        return storms.slice(0, 3).map((s) => {
          const kt = s.maxWinds;
          const color = kt >= 96 ? RED : kt >= 64 ? ORANGE : GOLD;
          const mph = kt != null ? Math.round(kt * 1.15078) + ' mph' : '—';
          const move = [s.movementDir, s.movementSpeed != null ? Math.round(s.movementSpeed * 1.15078) + ' mph' : ''].filter(Boolean).join(' at ');
          return `<div style="margin:4px 0 8px"><div style="color:${color};font-size:24px">${esc(s.name || 'Unnamed')} <span style="color:${MUTED};font-size:18px">${esc(s.classification || s.type || '')}</span></div>
            ${row('Max winds', mph, color)}${move ? row('Moving', esc(move)) : ''}</div>`;
        }).join('') + `<div class="wtv-src">National Hurricane Center</div>`;
      }
    }

    // ── UV & Outdoor (Open-Meteo, straight from the viewer's browser)
    const uvInfo = (v) => (v >= 11 ? ['Extreme', RED] : v >= 8 ? ['Very High', ORANGE] : v >= 6 ? ['High', GOLD] : v >= 3 ? ['Moderate', GREEN] : ['Low', BLUE]);
    class Outdoor extends WTVScreen {
      async fetchData({ latitude: lat, longitude: lon }) {
        const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`
          + '&current=uv_index,cloud_cover,visibility,relative_humidity_2m,wind_speed_10m&daily=uv_index_max'
          + '&wind_speed_unit=mph&timezone=auto&forecast_days=3');
        if (!r.ok) return null;
        return r.json();
      }
      render(d) {
        const c = d.current || {}, day = d.daily || {};
        const uv = c.uv_index ?? 0;
        const [risk, color] = uvInfo(uv);
        const days = (day.time || []).slice(0, 3).map((t, i) => {
          const v = day.uv_index_max?.[i];
          const name = new Date(`${t}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
          return row(name, v != null ? `UV ${v.toFixed(0)} ${uvInfo(v)[0]}` : '—', v != null ? uvInfo(v)[1] : MUTED);
        }).join('');
        return `<div class="wtv-big" style="color:${color}">${uv.toFixed(0)}</div>
          <div class="wtv-sub" style="color:${color}">${risk} UV right now</div>
          ${row('Cloud cover', c.cloud_cover != null ? c.cloud_cover + '%' : '—')}
          ${row('Visibility', c.visibility != null ? (c.visibility / 1609.34).toFixed(0) + ' mi' : '—')}
          ${row('Humidity', c.relative_humidity_2m != null ? c.relative_humidity_2m + '%' : '—')}
          ${row('Wind', c.wind_speed_10m != null ? Math.round(c.wind_speed_10m) + ' mph' : '—')}
          <div class="wtv-label">Peak UV</div>${days}`;
      }
    }

    // navIds 13–16 follow WeatherStar's built-in screens; elemIds keep the
    // original names so saved choices and WeatherTV's URLs keep working.
    registerDisplay(new AirQuality(13, 'aqi-ws', 'Air Quality'));
    registerDisplay(new SmokeFire(14, 'smoke-ws', 'Smoke & Wildfire'));
    registerDisplay(new Tropical(15, 'hurricane-ws', 'Tropical Storms'));
    registerDisplay(new Outdoor(16, 'astronomy-ws', 'UV & Outdoor'));
  },
}, (rt) => rt(rt.s = 9001)]);
