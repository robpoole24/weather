// WeatherTV custom WeatherStar 4000+ screens (wtv-screens.js) — build.1791610000
// Air Quality · Smoke & Wildfire · Tropical Storms · UV & Outdoor · You're Watching WeatherTV
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
// 🎃 Haddonfield easter egg (only when WeatherTV sets wtvTown=haddonfield):
//  • music: ask for the Haddonfield-only playlist (music/haddonfield/)
//  • alerts: add the Sheriff's emergency message to the Weather Service alert
//    list, so WeatherStar shows it on its OWN red hazard screen (with its
//    scroll, alert indicator and scanlines) — Extreme + Immediate puts it first
if (new URLSearchParams(location.search).get('wtvTown') === 'haddonfield' && window.fetch) {
  const realFetch = window.fetch.bind(window);
  const SHERIFF = {
    id: 'wtv-haddonfield-sheriff', type: 'Feature', geometry: null,
    properties: {
      id: 'wtv-haddonfield-sheriff', event: 'Law Enforcement Warning', severity: 'Extreme', urgency: 'Immediate', certainty: 'Observed',
      headline: "Sheriff's emergency message for Haddonfield",
      description: "THE HADDONFIELD SHERIFF'S OFFICE REPORTS A MASKED KILLER HAS BEEN SPOTTED IN HADDONFIELD AFTER ESCAPING FROM "
        + "SMITH'S GROVE SANITARIUM.\n\nSHERIFF BRACKETT AND DEPUTY MEEKER HAVE DECLARED TONIGHT'S TRICK-OR-TREAT EVENT OFFICIALLY "
        + "OVER. ALL RESIDENTS SHOULD RETURN TO THEIR HOMES AND LOCK THEIR DOORS UNTIL OFFICIALS GIVE THE ALL CLEAR.\n\nTHE SUSPECT "
        + "HAS BEEN IDENTIFIED AS MICHAEL MYERS. HE WAS LAST SEEN WEARING A BLACK AUTO MECHANIC'S OUTFIT AND A WHITE HALLOWEEN MASK. "
        + "HE IS EXTREMELY DANGEROUS. DO NOT ATTEMPT TO INTERACT WITH HIM.\n\nIF YOU SPOT HIM, OR A STOLEN GREEN STATION WAGON HE "
        + "MAY BE DRIVING, CONTACT THE SHERIFF'S OFFICE IMMEDIATELY.",
    },
  };
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (/(^|\/)playlist\.json$/.test(url)) return realFetch(url + '?town=haddonfield', init);
    if (/api\.weather\.gov\/alerts\/active/.test(url)) {
      let data = { type: 'FeatureCollection', features: [] };
      try { const r = await realFetch(input, init); if (r.ok) data = await r.json(); } catch (_) { /* offline: just the Sheriff */ }
      data.features = [SHERIFF, ...(data.features || []).filter(f => f && f.id !== SHERIFF.id)];
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/geo+json' } });
    }
    return realFetch(input, init);
  };
}

(self.webpackChunkws4kp = self.webpackChunkws4kp || []).push([[9001], {
  9001(module, exports, require) {
    const WeatherDisplay = require(24).A;
    const STATUS = require(592).Ay;
    const nav = require(211);
    const registerDisplay = nav.Kb;
    const getDisplay = nav.pv;

    // ── Neutralize the OLD custom screens if the page still loads them ───────
    // They register through window.wtvRegisterDisplay at page load, AFTER this
    // file runs — and WeatherStar lets a later registration overwrite an earlier
    // one ("nav ID 13 already in use"), so they silently replaced these screens.
    // Only real WeatherStar displays get through now; the imitations are ignored.
    if (typeof window.wtvRegisterDisplay === 'function') {
      const passThrough = window.wtvRegisterDisplay;
      window.wtvRegisterDisplay = (d) => {
        if (d instanceof WeatherDisplay) return passThrough(d);
        console.info('[WTV] Ignored legacy custom screen:', d && d.elemId);
        return undefined;
      };
    }

    const FONT = "'Star4000', monospace";
    const BLUE = '#7ec8e3', GOLD = '#f4d03f', RED = '#ff5a4a', GREEN = '#2ecc71', MUTED = '#a8c6d6', ORANGE = '#ff9a2e';
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const row = (label, value, color = BLUE) => `<div class="wtv-row"><span>${label}</span><span style="color:${color}">${value}</span></div>`;
    // WeatherStar's own weather icons (shipped in images/icons/)
    const ICON = {
      haze: 'images/icons/regional-maps/Haze.gif', smoke: 'images/icons/current-conditions/Smoke.gif',
      sunny: 'images/icons/current-conditions/Sunny.gif', hot: 'images/icons/regional-maps/Hot.gif',
      cloudy: 'images/icons/current-conditions/Partly-Cloudy.gif', clear: 'images/icons/current-conditions/Clear.gif',
    };
    // A segmented color scale with a pointer — WeatherStar-style gauge
    function gauge(value, bands, max, labels) {
      const pct = Math.max(0, Math.min(100, (value / max) * 100));
      let at = 0;
      const segs = bands.map(([upTo, color]) => {
        const w = ((Math.min(upTo, max) - at) / max) * 100; at = Math.min(upTo, max);
        return `<span style="width:${w}%;background:${color}"></span>`;
      }).join('');
      return `<div class="wtv-gauge"><div class="wtv-gauge-bar">${segs}</div>
        <div class="wtv-gauge-ptr" style="left:${pct}%"></div>
        <div class="wtv-gauge-labels">${labels.map((l) => `<span>${l}</span>`).join('')}</div></div>`;
    }

    // ── Markup + styling for the four screens (same header as built-in screens)
    const SCREENS = [
      { id: 'wtv-brand', top: "You're", bottom: 'Watching' },
      { id: 'aqi-ws', top: 'Air', bottom: 'Quality' },
      { id: 'smoke-ws', top: 'Smoke &amp;', bottom: 'Wildfire' },
      { id: 'hurricane-ws', top: 'Tropical', bottom: 'Storms' },
      { id: 'astronomy-ws', top: 'UV &amp;', bottom: 'Outdoor' },
    ];
    function injectMarkup() {
      const container = document.querySelector('#container');
      if (!container || document.getElementById('wtv-screens-style')) return;
      const before = container.querySelector(':scope > .scroll');
      SCREENS.forEach((s) => {
        // Reuse a container left over from the old custom screens if the page
        // still has one; otherwise create it. Either way, give it our layout.
        let div = document.getElementById(`${s.id}-html`);
        if (!div) { div = document.createElement('div'); container.insertBefore(div, before || null); }
        div.id = `${s.id}-html`;
        div.className = 'weather-display';
        div.innerHTML = `<div class="header"><div class="logo"><img src="images/logos/logo-corner.png"></div>
          <div class="title dual"><div class="top">${s.top}</div><div class="bottom">${s.bottom}</div></div>
          <div class="date-time date"></div><div class="date-time time"></div></div>
          <div class="main has-box wtv-custom"><div class="wtv-content"></div></div>`;
      });
      const style = document.createElement('style');
      style.id = 'wtv-screens-style';
      style.textContent = `
        .wtv-custom .wtv-content { font-family:${FONT}; color:#fff; font-size:20px; line-height:1.25; padding:8px 18px;
          height:100%; box-sizing:border-box; overflow:hidden; text-shadow:3px 3px 0 #000; }
        .wtv-custom .wtv-big { font-size:48px; text-align:center; margin:2px 0 0; }
        .wtv-custom .wtv-sub { text-align:center; font-size:20px; margin-bottom:6px; }
        .wtv-custom .wtv-label { color:${GOLD}; font-size:18px; margin:6px 0 2px; }
        .wtv-custom .wtv-row { display:flex; justify-content:space-between; gap:12px; padding:1px 0; }
        .wtv-custom .wtv-row span:first-child { color:${MUTED}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .wtv-custom .wtv-row span:last-child { white-space:nowrap; }
        .wtv-custom .wtv-src { font-size:14px; color:${MUTED}; text-align:center; margin-top:6px; }
        .wtv-custom .wtv-hero { display:flex; align-items:center; gap:18px; margin:4px 0 6px; }
        .wtv-custom .wtv-hero img { width:96px; height:auto; image-rendering:pixelated; }
        .wtv-custom .wtv-hero .num { font-size:56px; line-height:1; }
        .wtv-custom .wtv-hero .cap { font-size:22px; }
        .wtv-custom .wtv-gauge { position:relative; margin:8px 4px 16px; }
        .wtv-custom .wtv-gauge-bar { display:flex; height:16px; border:2px solid #000; box-shadow:2px 2px 0 #000; }
        .wtv-custom .wtv-gauge-bar span { display:block; height:100%; }
        .wtv-custom .wtv-gauge-ptr { position:absolute; top:-9px; width:0; height:0; margin-left:-8px;
          border-left:8px solid transparent; border-right:8px solid transparent; border-top:10px solid #fff; filter:drop-shadow(2px 2px 0 #000); }
        .wtv-custom .wtv-gauge-labels { display:flex; justify-content:space-between; font-size:14px; color:${MUTED}; margin-top:2px; }
        .wtv-custom .wtv-days { display:flex; justify-content:space-around; margin-top:4px; }
        .wtv-custom .wtv-day { text-align:center; font-size:18px; }
        .wtv-custom .wtv-day img { width:56px; height:auto; image-rendering:pixelated; display:block; margin:2px auto; }
        .wtv-custom .wtv-map { position:relative; height:172px; border:2px solid #000; overflow:hidden; box-sizing:content-box; margin-bottom:4px;
          background-repeat:no-repeat; image-rendering:auto; }
        .wtv-custom .wtv-storm { position:absolute; transform:translate(-50%,-50%); }
        .wtv-custom .wtv-storm-lbl { position:absolute; left:16px; top:-12px; white-space:nowrap; font-size:16px; }
        .wtv-custom .wtv-track { position:absolute; left:0; top:0; width:100%; height:100%; pointer-events:none; }
        .wtv-brand-wrap { display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:0; }
        .wtv-brand-logo { max-width:92%; max-height:70%; image-rendering:pixelated; display:block; filter:drop-shadow(3px 3px 0 #000); }
        .wtv-brand-tagline { font-family:${FONT}; color:#00d4f5; font-size:22px; letter-spacing:0.08em; text-align:center;
          text-shadow:2px 2px 0 #000, 0 0 18px rgba(0,212,245,0.5); margin-top:10px; }`;
      document.head.appendChild(style);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectMarkup);
    else injectMarkup();

    // Bottom-scroll text is handled by WeatherStar's own "custom text" setting
    // (set in public/index.html → buildWSUrl), which rotates one line into the
    // scroll now and then. Nothing here touches the scroll.

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
        if (box) this.boxWidth = box.clientWidth - 36;   // content width inside the padding (normal or widescreen)
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
        return `<div class="wtv-hero"><img src="${ICON.haze}" alt="">
            <div><div class="num" style="color:${color}">${top.AQI}</div><div class="cap" style="color:${color}">${esc(label)}</div>
            <div style="font-size:16px;color:${MUTED}">Worst nearby · ${esc(top.ParameterName || '')}</div></div></div>
          ${gauge(top.AQI, [[50, '#00e400'], [100, '#ffff00'], [150, '#ff7e00'], [200, '#ff0000'], [300, '#8f3f97'], [500, '#7e0023']], 300, ['0', '50', '100', '150', '200', '300+'])}
          ${st.slice(0, 3).map((s) => row(esc(`${(s.ReportingArea || s.SiteName || '').slice(0, 20)} ${s.ParameterName || ''}`), s.AQI, aqiInfo(s.AQI)[1])).join('')}
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
        return `<div class="wtv-hero"><img src="${counts.Heavy || counts.Medium || counts.Light ? ICON.smoke : ICON.hot}" alt="">
            <div><div class="cap" style="color:${worst[1]};font-size:28px">${worst[0]}</div>
            <div style="font-size:16px;color:${MUTED}">NOAA satellite smoke analysis</div></div></div>
          <div class="wtv-label">Active fires within ~120 miles</div>
          ${fires.length ? fires.slice(0, 5).map((p) => row(esc((p.IncidentName || 'Unnamed fire').slice(0, 20)),
            `${p.GISAcres ? Math.round(p.GISAcres).toLocaleString() + ' ac' : ''}${p.PercentContained != null ? ' · ' + p.PercentContained + '%' : ''}`, RED)).join('')
            : `<div class="wtv-sub" style="color:${GREEN}">None reported</div>`}
          <div class="wtv-src">NOAA HMS · NIFC</div>`;
      }
    }

    // ── Tropical Storms (NHC via /api/nhc-storms) — plotted on a tropics map
    // Map: images/maps/wtv-tropics.webp, WeatherStar colors, equirectangular,
    // lon -180..-5, lat -5..60 at 12 px per degree.
    const TROP = { src: 'images/maps/wtv-tropics.webp', W: -180, E: -5, S: -5, N: 60 };
    const catOf = (kt) => (kt >= 137 ? ['Cat 5', '#ff00ff'] : kt >= 113 ? ['Cat 4', '#ff2020'] : kt >= 96 ? ['Cat 3', '#ff6a00']
      : kt >= 83 ? ['Cat 2', '#ffa500'] : kt >= 64 ? ['Cat 1', '#ffd000'] : kt >= 34 ? ['Tropical Storm', '#2ecc71'] : ['Depression', '#7ec8e3']);
    const CLASS = { HU: 'Hurricane', TS: 'Tropical Storm', TD: 'Tropical Depression', STS: 'Subtropical Storm',
      SD: 'Subtropical Depression', PTC: 'Potential Tropical Cyclone', PT: 'Post-Tropical', TY: 'Typhoon' };
    const stormPos = (s) => {
      const lat = s.latitudeNumeric ?? parseFloat(s.latitude), lon = s.longitudeNumeric ?? parseFloat(s.longitude);
      const latN = typeof s.latitude === 'string' && /S$/i.test(s.latitude) ? -Math.abs(lat) : lat;
      const lonW = typeof s.longitude === 'string' && /W$/i.test(s.longitude) ? -Math.abs(lon) : lon;
      return Number.isFinite(latN) && Number.isFinite(lonW) ? [latN, lonW] : null;
    };
    const stormSvg = (color) => `<svg width="26" height="26" viewBox="-13 -13 26 26"><g stroke="#000" stroke-width="1.5">
      <path d="M0,-11 C7,-11 9,-5 5,-3 M0,11 C-7,11 -9,5 -5,3" fill="none" stroke="${color}" stroke-width="3.5"/>
      <circle r="5.5" fill="${color}"/></g></svg>`;
    class Tropical extends WTVScreen {
      async fetchData() {
        const r = await fetch('/api/nhc-storms');
        if (!r.ok) return null;
        const d = await r.json();
        const storms = (d.activeStorms || []).map((st) => ({ ...st, pos: stormPos(st), kt: +(st.intensity ?? st.maxWinds ?? 0) }))
          .filter((st) => st.pos);
        return storms.length ? storms : null;   // quiet basins → skip the screen
      }
      render(storms) {
        // Frame the storms: at least 40° x 16°, padded, kept inside the map image
        const box = { w: Math.max(320, Math.round(this.boxWidth || 480)), h: 172 };
        const lats = storms.map((st) => st.pos[0]), lons = storms.map((st) => st.pos[1]);
        let lonW = Math.min(...lons) - 8, lonE = Math.max(...lons) + 8;
        let latS = Math.min(...lats) - 5, latN = Math.max(...lats) + 5;
        const cx = (lonW + lonE) / 2, cy = (latS + latN) / 2;
        let spanX = Math.max(40, lonE - lonW), spanY = Math.max(16, latN - latS);
        if (spanX / spanY > box.w / box.h) spanY = spanX * box.h / box.w; else spanX = spanY * box.w / box.h;
        spanX = Math.min(spanX, TROP.E - TROP.W); spanY = Math.min(spanY, TROP.N - TROP.S);
        lonW = Math.max(TROP.W, Math.min(cx - spanX / 2, TROP.E - spanX)); lonE = lonW + spanX;
        latN = Math.min(TROP.N, Math.max(cy + spanY / 2, TROP.S + spanY)); latS = latN - spanY;
        const k = box.w / spanX;                       // px per degree
        const px = (lat, lon) => [(lon - lonW) * k, (latN - lat) * k];
        const bg = `background-image:url(${TROP.src});background-size:${(TROP.E - TROP.W) * k}px ${(TROP.N - TROP.S) * k}px;`
          + `background-position:${-(lonW - TROP.W) * k}px ${-(TROP.N - latN) * k}px;`;
        let tracks = '', marks = '';
        storms.forEach((st) => {
          const [cat, color] = catOf(st.kt);
          const [x, y] = px(...st.pos);
          // 24-hour motion arrow from direction (heading) and speed (mph)
          if (st.movementDir != null && +st.movementSpeed > 0) {
            const dist = (+st.movementSpeed * 24) / 69;   // degrees of latitude travelled in 24 h
            const h = (+st.movementDir * Math.PI) / 180;
            const lat2 = st.pos[0] + dist * Math.cos(h), lon2 = st.pos[1] + (dist * Math.sin(h)) / Math.cos((st.pos[0] * Math.PI) / 180);
            const [x2, y2] = px(lat2, lon2);
            tracks += `<line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="5"/>`
              + `<line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}" stroke="#fff" stroke-width="2.5" stroke-dasharray="6 5" marker-end="url(#wtvArrow)"/>`;
          }
          marks += `<div class="wtv-storm" style="left:${x}px;top:${y}px">${stormSvg(color)}
            <div class="wtv-storm-lbl" style="color:${color};${x > box.w - 120 ? 'left:auto;right:16px;' : ''}${y < 24 ? 'top:6px;' : ''}">${esc((st.name || '').toUpperCase())}</div></div>`;
        });
        const svg = `<svg class="wtv-track" viewBox="0 0 ${box.w} ${box.h}" preserveAspectRatio="none"><defs><marker id="wtvArrow" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#fff"/></marker></defs>${tracks}</svg>`;
        const lines = storms.slice(0, 3).map((st) => {
          const [cat, color] = catOf(st.kt);
          const mph = st.kt ? `${Math.round(st.kt * 1.15078)} mph` : '';
          const kind = st.classification === 'HU' ? cat : (CLASS[st.classification] || cat);
          return row(`<span style="color:${color}">${esc(st.name || '')}</span> ${esc(kind)}`, [mph, st.pressure ? `${st.pressure} mb` : ''].filter(Boolean).join(' · '), color);
        }).join('');
        return `<div class="wtv-map" style="${bg}width:${box.w}px">${svg}${marks}</div>${lines}
          <div class="wtv-src">National Hurricane Center · arrows show 24-hour motion</div>`;
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
        const icon = uv < 0.5 ? ICON.clear : uv >= 8 ? ICON.hot : (c.cloud_cover ?? 0) > 60 ? ICON.cloudy : ICON.sunny;
        const dayCols = (day.time || []).slice(0, 3).map((t, i) => {
          const v = day.uv_index_max?.[i];
          const [lvl, col] = v != null ? uvInfo(v) : ['—', MUTED];
          const name = new Date(`${t}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
          return `<div class="wtv-day">${name}<img src="${v >= 8 ? ICON.hot : ICON.sunny}" alt=""><span style="color:${col}">UV ${v != null ? v.toFixed(0) : '—'}</span><br><span style="color:${col};font-size:15px">${lvl}</span></div>`;
        }).join('');
        return `<div class="wtv-hero"><img src="${icon}" alt="">
            <div><div class="num" style="color:${color}">UV ${uv.toFixed(0)}</div><div class="cap" style="color:${color}">${risk}</div>
            <div style="font-size:16px;color:${MUTED}">Clouds ${c.cloud_cover ?? '—'}% · Humidity ${c.relative_humidity_2m ?? '—'}%</div></div></div>
          ${gauge(uv, [[3, '#3ea72d'], [6, '#fff300'], [8, '#f18b00'], [11, '#e53210'], [14, '#b567a4']], 12, ['0', '3', '6', '8', '11+'])}
          <div class="wtv-days">${dayCols}</div>`;
      }
    }

    // ── You're Watching WeatherTV (always on — can't be disabled via URL or UI)
    class WatchingWTV extends WTVScreen {
      constructor(navId, elemId, name) {
        super(navId, elemId, name);
        this.refreshTime = 60 * 60 * 1000;
        this._wtvAlwaysOn = true;
      }
      get isEnabled() { return true; }
      set isEnabled(_) { /* locked on */ }

      // Override getData entirely to bypass the base-class enabled/status gate
      async getData(weatherParameters, refresh) {
        this.weatherParameters = weatherParameters;
        if (!refresh && this.data) {
          this.setStatus(STATUS.loaded);
          return;
        }
        this.data = { ready: true };
        this.setStatus(STATUS.loading);
        this.getDataCallback();
        this.setStatus(STATUS.loaded);
      }

      // fetchData never called (getData overrides the whole flow), but satisfy the base class
      async fetchData() { return { ready: true }; }

      render() {
        return `<div class="wtv-brand-wrap">
          <img class="wtv-brand-logo" src="images/weathertv-pixel.png?v=2" alt="WeatherTV"
            onerror="this.style.display='none'">
          <div class="wtv-brand-tagline">YOU&rsquo;RE WATCHING WEATHERTV</div>
        </div>`;
      }
    }

    // Slots right after WeatherStar's built-in screens (13+). If an older copy of
    // the custom screens already took some (WeatherStar refuses duplicate slots
    // — "nav ID 13 already in use"), take the next free ones. Slots stay
    // back-to-back: a gap in the list breaks WeatherStar's rotation.
    let nextId = 13;
    const freeId = () => { while (getDisplay(nextId)) nextId += 1; return nextId++; };
    // WatchingWTV is first so it plays at load and at the top of each rotation cycle
    registerDisplay(new WatchingWTV(freeId(), 'wtv-brand', "You're Watching WeatherTV"));
    registerDisplay(new AirQuality(freeId(), 'aqi-ws', 'Air Quality'));
    registerDisplay(new SmokeFire(freeId(), 'smoke-ws', 'Smoke & Wildfire'));
    registerDisplay(new Tropical(freeId(), 'hurricane-ws', 'Tropical Storms'));
    registerDisplay(new Outdoor(freeId(), 'astronomy-ws', 'UV & Outdoor'));
  },
}, (rt) => rt(rt.s = 9001)]);
