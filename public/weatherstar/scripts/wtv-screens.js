// WeatherTV custom WeatherStar 4000+ screens (wtv-screens.js) — build.1791770000
// Air Quality · Smoke & Wildfire · Tropical Storms · UV & Outdoor · You're Watching WeatherTV
// Airport Conditions · Tides · Marine Forecast
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
    // WeatherStar's own small condition icons (the regional-map set, with night
    // moons) from a weather.gov icon link — module 900, export lL (smallIcon).
    // Re-check this id if WeatherStar is ever rebuilt.
    let smallIcon = null;
    try { smallIcon = require(900).lL; } catch (_) { /* icons fall back to none */ }

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
      { id: 'wtv-brand', top: '', bottom: '' },   // no yellow title — the logo + cyan tagline carry it
      { id: 'aqi-ws', top: 'Air', bottom: 'Quality' },
      { id: 'smoke-ws', top: 'Smoke &amp;', bottom: 'Wildfire' },
      { id: 'hurricane-ws', top: 'Tropical', bottom: 'Storms' },
      { id: 'astronomy-ws', top: 'UV &amp;', bottom: 'Outdoor' },
      { id: 'airport-ws', top: 'Airport', bottom: 'Conditions' },
      { id: 'tides-ws', top: 'Tides', bottom: 'Sun &amp; Moon' },
      { id: 'marine-ws', top: 'Marine', bottom: 'Forecast' },
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
        .wtv-custom .wtv-content.wtv-air { padding:0; }
        .wtv-air-band { display:block; width:100%; height:64px; image-rendering:pixelated; object-fit:cover; object-position:center bottom; }
        .wtv-air-grid { display:grid; grid-template-columns:1fr 50px 70px 112px; align-items:center; column-gap:6px; padding:0 14px 0 18px; }
        .wtv-air-head { font-family:'Star4000 Small', monospace; font-size:24px; color:#fff; padding-top:4px; }
        .wtv-air-head span:nth-child(n+3) { text-align:center; }
        .wtv-air-row { font-size:27px; height:58px; }
        .wtv-air-row .nm.long { font-size:23px; }
        .wtv-air-row .nm { white-space:nowrap; overflow:hidden; }
        .wtv-air-row img { width:50px; height:42px; object-fit:contain; image-rendering:pixelated; display:block; }
        .wtv-air-row .tp, .wtv-air-row .dl { text-align:center; white-space:nowrap; }
        .wtv-tide { padding:6px 16px 0; }
        .wtv-tide-name { color:${GOLD}; font-size:20px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .wtv-tide svg { display:block; width:100%; height:86px; overflow:visible; }
        .wtv-tide svg text { font-family:${FONT}; font-size:16px; fill:#fff; paint-order:stroke; stroke:#000; stroke-width:3px; }
        .wtv-tide svg text.h { fill:#9fe3ff; } .wtv-tide svg text.l { fill:#ffd27a; }
        .wtv-tide-foot { display:flex; align-items:center; justify-content:space-between; padding:4px 16px 0; font-size:19px; }
        .wtv-tide-foot img { width:42px; height:auto; image-rendering:pixelated; vertical-align:middle; margin-right:6px; }
        .wtv-tide-foot .sun span { color:${GOLD}; }
        .wtv-mar-zone { font-size:15px; color:${MUTED}; text-align:center; padding:3px 12px 0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .wtv-mar-grid { display:grid; grid-template-columns:96px 1fr 1fr; align-items:center; text-align:center; padding:0 14px; }
        .wtv-mar-grid .lbl { text-align:left; font-size:20px; }
        .wtv-mar-head { color:${GOLD}; font-size:24px; padding:2px 0 0; }
        .wtv-mar-wind { font-size:22px; line-height:1.15; }
        .wtv-mar-box { margin:6px 10px 0; border:2px solid #9aa0e6; box-shadow:2px 2px 0 #000; padding:2px 0 3px; font-size:22px; line-height:1.1; }
        .wtv-mar-box svg { display:block; width:78%; height:16px; margin:1px auto; }
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

    // ── Authentic Extended Forecast icons ──────────────────────────────────
    // The real WeatherSTAR 4000 drew its Extended Forecast with its own icon
    // set (Isolated T-Storms, Scattered Showers, Snow to Rain…). WeatherStar
    // 4000+ reuses the Current Conditions icons there; a one-line hook in
    // resources/displays.min.js calls this instead. Icons: WeatherSTAR 4000 icon
    // collection 1990–2014 by malekmasoud (DeviantArt).
    // Anything this set doesn't cover (smoke, blizzard…) falls back to
    // WeatherStar's own choice.
    const EF = (f) => `images/icons/extended-forecast/${f}.gif`;
    window.wtvEfIcon = (url, fallback) => {
      const back = () => { try { return fallback(url); } catch (_) { return undefined; } };
      const m = /\/icons\/\w+\/(day|night)\/([^?]+)/i.exec(url || '');
      if (!m) return back();
      const parts = m[2].split('/').map((c) => { const [name, p] = c.split(','); return { name, p: parseInt(p, 10) || 100 }; });
      const first = parts[0], last = parts[parts.length - 1];
      if (parts.length > 1 && /^snow/.test(first.name) && /^rain/.test(last.name)) return EF('Snow-to-Rain');
      const { name, p } = parts.length > 1 && last.name !== first.name ? last : first;
      switch (name) {
        case 'skc': case 'hot': case 'cold': case 'haze': return EF('Sunny');
        case 'few': case 'sct': return EF('Partly-Cloudy');
        case 'bkn': return EF('Mostly-Cloudy');
        case 'ovc': return EF('Cloudy');
        case 'fog': return EF('Fog');
        case 'wind_skc': case 'wind_few': case 'wind_sct': case 'wind_bkn': case 'wind_ovc': case 'wind_': return EF('Windy');
        case 'rain_showers': case 'rain_showers_hi': case 'rain_showers_high': return EF(p <= 50 ? 'Scattered-Showers' : 'Showers');
        case 'rain': return EF(p <= 40 ? 'Scattered-Showers' : 'Rain');
        case 'tsra_sct': return EF(p <= 20 ? 'Isolated-Tstorms' : 'Scattered-Tstorms');
        case 'tsra': return EF(p <= 20 ? 'Isolated-Tstorms' : p <= 50 ? 'Scattered-Tstorms' : 'Thunderstorms');
        case 'tsra_hi': case 'tornado': case 'hurricane': case 'tropical_storm': return EF('Thunderstorms');
        case 'snow': return EF(p <= 30 ? 'Scattered-Snow-Showers' : p > 70 ? 'Heavy-Snow' : 'Light-Snow');
        case 'rain_snow': return EF('Rain-Snow');
        case 'snow_fzra': case 'winter_mix': case 'rain_sleet': case 'snow_sleet': case 'sleet': return EF('Wintry-Mix');
        case 'fzra': case 'rain_fzra': return EF('Freezing-Rain');
        default: return back();
      }
    };

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

    // ── Airport Conditions — current weather at the 3 nearest airports, any
    // size (Mitchell, Timmerman, Wittman…). The server downloads every U.S.
    // airport weather report once every 10 minutes; this only reads that copy.
    // Same look as the original WeatherSTAR 4000 product: control-tower strip,
    // then the sky, TEMP and WIND for each airport.
    const AIR_BAND = 'images/airport-band.png';
    const airIcon = (a) => {
      if (!a.icon || !smallIcon) return '';
      try { return smallIcon(a.icon, a.night); } catch (_) { return ''; }
    };
    class AirportConditions extends WTVScreen {
      async fetchData({ latitude: lat, longitude: lon }) {
        const r = await fetch(`/api/airports/conditions?lat=${lat}&lon=${lon}`);
        if (!r.ok) return null;
        const list = (await r.json()).airports || [];
        return list.length ? list : null;      // no airport report within 150 mi → skip
      }
      render(list) {
        this.elem.querySelector('.wtv-content').classList.add('wtv-air');
        const rows = list.map((a) => {
          const icon = airIcon(a);
          return `<div class="wtv-air-grid wtv-air-row">
            <span class="nm${a.short.length > 14 ? ' long' : ''}">${esc(a.short)}</span>
            <span>${icon ? `<img src="${icon}" alt="">` : ''}</span>
            <span class="tp">${a.tempF == null ? 'N/A' : `${a.tempF}°`}</span>
            <span class="dl">${esc(a.wind)}</span></div>`;
        }).join('');
        return `<img class="wtv-air-band" src="${AIR_BAND}" alt="">
          <div class="wtv-air-grid wtv-air-head"><span></span><span></span><span>TEMP</span><span>WIND</span></div>${rows}`;
      }
    }

    // ── Tides — the 2 nearest NOAA tide stations (within 60 mi), drawn as a
    // tide curve for the next day with every high and low marked, plus sunrise,
    // sunset and the moon phase. Inland and Great Lakes locations skip it.
    // Times use the WeatherStar location's own time zone.
    const tzOf = (wp) => (wp && wp.timeZone) || undefined;
    const hm = (ms, tz) => {
      const t = new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
      return t.replace(/\s?(AM|PM)/, (m, ap) => ap[0].toLowerCase());
    };
    const moonInfo = (date) => {
      if (!window.SunCalc) return null;
      const { phase } = window.SunCalc.getMoonIllumination(date);
      const names = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];
      const name = names[Math.round(phase * 8) % 8];
      const icon = ['New-Moon', 'First-Quarter', 'Full-Moon', 'Last-Quarter'][Math.round(phase * 4) % 4];
      return { name, icon: `images/icons/moon-phases/${icon}.gif` };
    };
    function tideCurve(events, tz, width) {
      const W = Math.max(300, Math.round(width || 460)), H = 86, top = 20, bottom = H - 20;
      const now = Date.now(), t0 = now - 2 * 3600e3, t1 = now + 24 * 3600e3;
      const ev = events.filter((e) => e.t >= t0 - 14 * 3600e3 && e.t <= t1 + 14 * 3600e3).sort((a, b) => a.t - b.t);
      if (ev.length < 2) return '';
      const inWin = ev.filter((e) => e.t >= t0 && e.t <= t1);
      const lo = Math.min(...ev.map((e) => e.ft)), hi = Math.max(...ev.map((e) => e.ft));
      const y = (ft) => bottom - ((ft - lo) / ((hi - lo) || 1)) * (bottom - top);
      const x = (t) => ((t - t0) / (t1 - t0)) * W;
      const height = (t) => {                     // cosine between consecutive high/low tides
        for (let i = 0; i < ev.length - 1; i += 1) {
          const a = ev[i], b = ev[i + 1];
          if (t >= a.t && t <= b.t) { const f = (t - a.t) / (b.t - a.t); return a.ft + (b.ft - a.ft) * (1 - Math.cos(Math.PI * f)) / 2; }
        }
        return null;
      };
      const pts = [];
      for (let i = 0; i <= 120; i += 1) { const t = t0 + (t1 - t0) * i / 120; const h = height(t); if (h != null) pts.push([x(t), y(h)]); }
      if (pts.length < 2) return '';
      const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
      const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${H} L${pts[0][0].toFixed(1)},${H} Z`;
      const labels = inWin.map((e) => {
        const ex = Math.min(W - 34, Math.max(34, x(e.t))), ey = y(e.ft);
        return `<circle cx="${x(e.t).toFixed(1)}" cy="${ey.toFixed(1)}" r="4" fill="${e.hi ? '#9fe3ff' : '#ffd27a'}" stroke="#000" stroke-width="1.5"/>`
          + `<text class="${e.hi ? 'h' : 'l'}" x="${ex.toFixed(1)}" y="${(e.hi ? ey - 7 : ey + 17).toFixed(1)}" text-anchor="middle">${e.hi ? 'H' : 'L'} ${hm(e.t, tz)}</text>`;
      }).join('');
      const nx = x(now).toFixed(1);
      return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs><linearGradient id="tw" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#3fa3e6" stop-opacity=".85"/><stop offset="1" stop-color="#0b2a8a" stop-opacity=".9"/></linearGradient></defs>
        <path d="${area}" fill="url(#tw)"/><path d="${line}" fill="none" stroke="#bfe9ff" stroke-width="2"/>
        <line x1="${nx}" y1="2" x2="${nx}" y2="${H}" stroke="#fff" stroke-width="1.5" stroke-dasharray="3 3"/>
        <text x="${nx}" y="12" text-anchor="middle" style="font-size:13px">NOW</text>${labels}</svg>`;
    }
    class Tides extends WTVScreen {
      async fetchData({ latitude: lat, longitude: lon }) {
        const r = await fetch(`/api/marine/tides?lat=${lat}&lon=${lon}`);
        if (!r.ok) return null;
        const d = await r.json();
        return d.stations && d.stations.length ? d : null;   // inland → skip
      }
      render(d) {
        const tz = tzOf(this.weatherParameters);
        const wp = this.weatherParameters || {};
        const blocks = d.stations.map((s) => `<div class="wtv-tide">
            <div class="wtv-tide-name">${esc(s.name)}${s.state ? `, ${esc(s.state)}` : ''}</div>
            ${tideCurve(s.events, tz, this.boxWidth)}</div>`).join('');
        let foot = '';
        if (window.SunCalc && wp.latitude != null) {
          const times = window.SunCalc.getTimes(new Date(), wp.latitude, wp.longitude);
          const moon = moonInfo(new Date());
          foot = `<div class="wtv-tide-foot">
            <span class="sun">Sunrise <span>${hm(times.sunrise, tz)}</span> · Set <span>${hm(times.sunset, tz)}</span></span>
            ${moon ? `<span><img src="${moon.icon}" alt="">${esc(moon.name)}</span>` : ''}</div>`;
        }
        return blocks + foot;
      }
    }

    // ── Marine Forecast — nearest NWS marine zone (within 40 mi): wind and
    // seas (or Great Lakes waves) for the next two periods, like the original.
    const MARINE_BAND = 'images/marine-band.png';
    const waveSvg = (state) => {
      const amp = { CALM: 0.6, SMOOTH: 1.5, 'LGT CHOP': 3, 'MOD CHOP': 4.5, ROUGH: 6, 'VERY ROUGH': 7, 'HIGH SEAS': 7.5 }[state] || 3;
      const n = state === 'ROUGH' || /VERY|HIGH/.test(state || '') ? 5 : 3;
      let d = 'M0,8';
      for (let i = 0; i < n; i += 1) { const w = 100 / n, x0 = i * w; d += ` Q${(x0 + w / 4).toFixed(1)},${(8 + amp).toFixed(1)} ${(x0 + w / 2).toFixed(1)},8 T${(x0 + w).toFixed(1)},8`; }
      return `<svg viewBox="0 0 100 16" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="#a9a3ee" stroke-width="2.6" stroke-linecap="round"/></svg>`;
    };
    const windCell = (w) => {
      if (!w) return '—';
      const spd = w.hi ? `${w.lo}-${w.hi}kts` : `${w.lo}kts`;
      return `${esc(w.dir)}<br>${spd}${w.gust ? `<span style="font-size:16px;color:${GOLD}"> G${w.gust}</span>` : ''}`;
    };
    const seasCell = (p) => {
      if (!p.seas) return `<div class="wtv-mar-box" style="color:${MUTED}">—<br><span style="font-size:16px">no sea forecast</span></div>`;
      const s = p.seas, ft = s.hi === 0 ? '0\'' : s.lo && s.lo !== s.hi ? `${s.lo}-${s.hi}'` : `${s.hi}'`;
      return `<div class="wtv-mar-box">${ft}${waveSvg(p.state)}${esc(p.state || '')}</div>`;
    };
    class MarineForecast extends WTVScreen {
      async fetchData({ latitude: lat, longitude: lon }) {
        const r = await fetch(`/api/marine/forecast?lat=${lat}&lon=${lon}`);
        if (!r.ok) return null;
        const d = await r.json();
        return d.zone && d.periods && d.periods.length ? d : null;   // inland → skip
      }
      render(d) {
        this.elem.querySelector('.wtv-content').classList.add('wtv-air');
        const ps = d.periods.slice(0, 2);
        const lakes = ps.some((p) => p.seas && p.seas.kind === 'waves');
        const cols = (fn) => ps.map(fn).join('') + (ps.length < 2 ? '<span></span>' : '');
        return `<img class="wtv-air-band" src="${MARINE_BAND}" alt="">
          <div class="wtv-mar-zone">${esc(d.zone.name)}</div>
          <div class="wtv-mar-grid wtv-mar-head"><span></span>${cols((p) => `<span>${esc(p.name)}</span>`)}</div>
          <div class="wtv-mar-grid"><span class="lbl">WINDS:</span>${cols((p) => `<span class="wtv-mar-wind">${windCell(p.wind)}</span>`)}</div>
          <div class="wtv-mar-grid"><span class="lbl">${lakes ? 'WAVES:' : 'SEAS:'}</span>${cols((p) => `<span>${seasCell(p)}</span>`)}</div>`;
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
    registerDisplay(new AirportConditions(freeId(), 'airport-ws', 'Airport Conditions'));
    registerDisplay(new Tides(freeId(), 'tides-ws', 'Tides'));
    registerDisplay(new MarineForecast(freeId(), 'marine-ws', 'Marine Forecast'));
  },
}, (rt) => rt(rt.s = 9001)]);
