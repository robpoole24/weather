// Weather TV glue for Weatherscan v2 — updated 2026-11-26T23:25:00Z build.1795740000
// Loaded before Weatherscan's own scripts. Weatherscan was written for weather.com's paid
// services and Mapbox; this file gives it Weather TV's instead:
//   • maps: our own self-hosted style (Natural Earth land/coast/borders, Census states/counties)
//   • radar: Iowa State (IEM) NEXRAD frames, the same ones Weather TV's Live Radar uses
//   • satellite: IEM GOES-East infrared under the radar
//   • music: Weather TV's WeatherStar music list
// (Weather data itself goes to /wxapi on our server — see weatherscan-api.js.)
(function () {
  var ORIGIN = location.origin, GEO = ORIGIN + '/weatherscan/geo/';
  var line = function (id, src, color, width, vis) {
    return { id: id, type: 'line', source: src, layout: { visibility: vis || 'visible', 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': color, 'line-width': width } };
  };
  var fill = function (id, color, vis) { return { id: id, type: 'fill', source: 'land', layout: { visibility: vis || 'visible' }, paint: { 'fill-color': color, 'fill-antialias': true } }; };
  // Same layer names as the Mapbox style Weatherscan was built with, so its show/hide calls still work
  window.WTV_MAP_STYLE = {
    version: 8,
    sources: {
      land: { type: 'geojson', data: GEO + 'land.json' },
      states: { type: 'geojson', data: GEO + 'states.json' },
      counties: { type: 'geojson', data: GEO + 'counties.json' },
      countries: { type: 'geojson', data: GEO + 'countries.json' },
      lakes: { type: 'geojson', data: GEO + 'lakes.json' },        // the Great Lakes and others (OpenStreetMap, via geo-maps; coarse)
      usland: { type: 'geojson', data: GEO + 'us-land.json' },      // US land with Census shorelines (sharp Great Lakes edges)
      usshore: { type: 'geojson', data: GEO + 'us-shore.json' },
      none: { type: 'geojson', data: GEO + 'empty.json' },
      goes: { type: 'raster', tileSize: 256, attribution: 'GOES-East: IEM',
        tiles: ['https://mesonet.agron.iastate.edu/cgi-bin/wms/goes_east.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=conus_ch13&STYLES=&FORMAT=image/png&TRANSPARENT=true&SRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}'] },
    },
    layers: [
      { id: 'background', type: 'background', layout: { visibility: 'visible' }, paint: { 'background-color': '#16335f' } },   // ocean
      fill('conus merc', '#5f7c48'),                                // land
      fill('conus sat', '#2b3b2a', 'none'),                         // land under satellite (darker)
      fill('alaska', '#5f7c48', 'none'),
      fill('hawaii local', '#5f7c48', 'none'),
      fill('hawaii regional', '#5f7c48', 'none'),
      { id: 'wtv-lakes', type: 'fill', source: 'lakes', layout: { visibility: 'visible' }, paint: { 'fill-color': '#16335f' } },   // water, shown with the land
      { id: 'wtv-us-land', type: 'fill', source: 'usland', layout: { visibility: 'visible' }, paint: { 'fill-color': '#5f7c48' } },
      { id: 'wtv-goes', type: 'raster', source: 'goes', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 } },
      line('i2-county-lines-conus-ak-hi-81h5x4', 'counties', 'rgba(232,236,220,0.35)', 0.6),
      line('cb-2019-us-state-20m-nocoast-7m1rrd', 'states', '#eef1e6', 1.4),
      line('country-boundaries', 'countries', '#eef1e6', 1.4),
      line('i2-coastlines-conus-ak-hi-06wtga', 'usshore', '#0b1d38', 1.2),   // US coasts and Great Lakes shores (Census)
      line('i2-road-vectors-conus-ak-hi-4r25d3', 'none', '#000', 1, 'none'),
      line('i2-road-vectors-conus-ak-hi-4r25d3 copy', 'none', '#777', 1, 'none'),
      line('i2-road-vectors-conus-ak-hi-4r25d3 (2)', 'none', '#777', 1, 'none'),
      line('i2-road-vectors-conus-ak-hi-4r25d3 (4)', 'none', '#777', 1, 'none'),
      line('place-label', 'none', '#fff', 1, 'none'),
      line('place-label copy', 'none', '#fff', 1, 'none'),
      line('airport-label', 'none', '#fff', 1, 'none'),
    ],
  };

  // Weatherscan starts drawing radar on its maps right away. Mapbox's hosted style was usually
  // ready by then; ours loads its outlines first, so radar waits until every map is ready.
  window.WTV_MAPS = [];
  // Which drawer: MapLibre (WebGL) normally; our light 2D drawer (wtv-lite.js) on Xbox and TVs,
  // where the graphics can't hold Weatherscan's 11+ maps, on any device without WebGL, and on a
  // device whose graphics dropped the maps before (remembered). #gl / #lite in the address force one.
  window.WTV_LITE = (function () {
    if (!window.WTVLiteMap) return false;
    if (/#gl\b/.test(location.hash)) return false;
    if (/#lite\b/.test(location.hash)) return true;
    var ua = navigator.userAgent || '';
    if (/Xbox|WeatherTVXbox|Tizen|SMART-TV|SmartTV|Web0S|WebOS|NetCast|HbbTV|BRAVIA|AFT[A-Z]|Android TV|GoogleTV|CrKey/i.test(ua)) return true;
    try { if (localStorage.getItem('wtvLiteMaps') === '1') return true; } catch (e) {}
    try { var c = document.createElement('canvas'); if (!(c.getContext('webgl') || c.getContext('experimental-webgl'))) return true; } catch (e) { return true; }
    return false;
  })();
  if (window.maplibregl) {
    var Base = maplibregl.Map;
    var Tracked = function (opts) {
      var m = window.WTV_LITE ? new WTVLiteMap(opts) : new Base(opts);
      // Wait for the map style itself; a slow device (Xbox) can take well over 20 seconds on the first visit
      m._wtvReady = new Promise(function (ok) { m.once('load', ok); setTimeout(ok, 120000); });
      // Health notes for the map check below
      m._wtv = { loaded: false, lost: false, err: '' };
      m.once('load', function () { m._wtv.loaded = true; });
      m.on('error', function (e) { var t = String((e && e.error && e.error.message) || 'error'); if (!m._wtv.err && !/non-existing layer|Failed to fetch|404/i.test(t)) m._wtv.err = t.slice(0, 80); });   // skip Weatherscan's own harmless slips and missing tiles
      try {
        var cv = m.getCanvas();
        cv.addEventListener('webglcontextlost', function () { m._wtv.lost = true; try { localStorage.setItem('wtvLiteMaps', '1'); } catch (e) {} });   // next visit uses the light drawer
        cv.addEventListener('webglcontextrestored', function () { m._wtv.lost = false; });
      } catch (e) {}
      window.WTV_MAPS.push(m);
      return m;
    };
    Tracked.prototype = Base.prototype;
    maplibregl.Map = Tracked;
  }
  // Map check: if any map hasn't drawn 45 seconds in (or the device's graphics dropped one),
  // show one small line at the top left saying what's wrong, so a photo of the screen tells us.
  // Add #diag to the address to always show it.
  // Remember the last few script errors, for the check line below
  var lastErrs = [];
  addEventListener('error', function (e) { lastErrs.push(String(e.message || e.error || 'error').slice(0, 90)); lastErrs = lastErrs.slice(-2); });
  addEventListener('unhandledrejection', function (e) { var r = e.reason; lastErrs.push(String((r && (r.message || r.statusText)) || r || 'rejected').slice(0, 90)); lastErrs = lastErrs.slice(-2); });
  function mapCheck(force) {
    var M = window.WTV_MAPS || [], loaded = 0, lost = 0, errs = [];
    M.forEach(function (m) { if (m._wtv) { if (m._wtv.loaded) loaded++; if (m._wtv.lost) lost++; if (m._wtv.err && errs.indexOf(m._wtv.err) < 0) errs.push(m._wtv.err); } });
    var st = document.getElementById('startup'), stuck = st && getComputedStyle(st).display !== 'none';
    if (!force && !stuck && loaded === M.length && !lost && !errs.length) { var old = document.getElementById('wtv-diag'); if (old) old.remove(); return; }
    var gpu = '';
    try { var c = document.createElement('canvas').getContext('webgl'); var d = c && c.getExtension('WEBGL_debug_renderer_info'); gpu = c ? (d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'webgl ok') : 'NO WEBGL'; } catch (e) { gpu = 'webgl error'; }
    var el = document.getElementById('wtv-diag') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'wtv-diag' }));
    el.style.cssText = 'position:fixed;left:8px;top:8px;z-index:100001;max-width:70%;padding:6px 10px;border-radius:6px;background:rgba(0,0,0,.8);color:#ffd000;font:600 14px/1.3 Barlow,system-ui,sans-serif';
    el.textContent = (stuck ? 'Still starting (step: ' + (window.wtvStep || '?') + ')' + (lastErrs.length ? ' · error: ' + lastErrs.join(' | ') : '') + ' · ' : '')
      + 'Map check' + (window.WTV_LITE ? ' (light maps)' : '') + ': ' + loaded + '/' + M.length + ' drawn' + (lost ? ', ' + lost + ' dropped by graphics' : '') + (errs.length ? ' · ' + errs.join(' | ') : '') + ' · ' + gpu;
  }
  setTimeout(function () { mapCheck(/diag/.test(location.hash)); setInterval(function () { mapCheck(/diag/.test(location.hash)); }, 10000); }, 40000);

  // Our extra layers follow Weatherscan's own switches: lakes show when any land layer shows;
  // lake shores show with the coastlines.
  var LAND = ['conus merc', 'conus sat', 'alaska', 'hawaii local', 'hawaii regional'];
  function patchMaps(Proto) {
    var setLP = Proto.setLayoutProperty;
    // Radar loops: a hidden map layer never loads its pictures, so every frame used to start
    // loading only when its turn came and flashed blank. Frames now stay "on" at zero opacity
    // (loaded and ready) and showing/hiding one just changes its opacity.
    var RADAR = /^radarlayer_/, addL = Proto.addLayer, getLP = Proto.getLayoutProperty;
    Proto.addLayer = function (layer) {
      if (layer && RADAR.test(layer.id) && layer.type === 'raster') {
        var hidden = layer.layout && layer.layout.visibility === 'none';
        layer.layout = Object.assign({}, layer.layout, { visibility: 'visible' });
        layer.paint = Object.assign({}, layer.paint, { 'raster-opacity': hidden ? 0 : 1, 'raster-opacity-transition': { duration: 0 } });
        (this._wtvVis = this._wtvVis || {})[layer.id] = hidden ? 'none' : 'visible';
      }
      return addL.apply(this, arguments);
    };
    Proto.getLayoutProperty = function (id, name) {
      if (name === 'visibility' && this._wtvVis && this._wtvVis[id]) return this._wtvVis[id];
      return getLP.apply(this, arguments);
    };
    Proto.setLayoutProperty = function (id, name, value) {
      if (name === 'visibility' && this._wtvVis && this._wtvVis[id]) {
        this._wtvVis[id] = value;
        this.setPaintProperty(id, 'raster-opacity', value === 'none' ? 0 : 1);
        return this;
      }
      var r = setLP.apply(this, arguments);
      try {
        if (name === 'visibility' && LAND.indexOf(id) >= 0) {
          var self = this, on = LAND.some(function (l) { return self.getLayer(l) && self.getLayoutProperty(l, 'visibility') !== 'none'; });
          var map = this, sat = this.getLayer('conus sat') && this.getLayoutProperty('conus sat', 'visibility') !== 'none';
          ['wtv-lakes', 'wtv-us-land'].forEach(function (l) { if (map.getLayer(l)) setLP.call(map, l, 'visibility', on ? 'visible' : 'none'); });
          if (this.getLayer('wtv-us-land')) this.setPaintProperty('wtv-us-land', 'fill-color', sat ? '#2b3b2a' : '#5f7c48');   // match the satellite map's darker land
        }
      } catch (e) {}
      return r;
    };
  }
  if (window.maplibregl) patchMaps(Base.prototype);
  if (window.WTVLiteMap) patchMaps(WTVLiteMap.prototype);

  // Mapbox-only: Weatherscan switches maps between Mercator and Lambert/globe. MapLibre 2 only
  // draws Mercator, so this is a no-op (without it the radar map never centred on you).
  if (window.maplibregl && !maplibregl.Map.prototype.setProjection) maplibregl.Map.prototype.setProjection = function () { return this; };
  window.wtvMapsReady = function () { return Promise.all(window.WTV_MAPS.map(function (m) { return m._wtvReady; })); };

  // Radar frames: IEM keeps the national NEXRAD mosaic every 5 minutes for the last hour.
  // Weatherscan asks for a "series" of frames with timestamps; we hand it the last 55 minutes.
  // A frame's timestamp is its real time (seconds), so the map reloads tiles as time moves on.
  var STEP = 300;
  window.wtvSeries = function (product) {
    return Promise.resolve({
      json: function () {
        if (!/twcRadarMosaic|satrad/.test(product)) return Promise.reject(new Error(product + ' is not available'));
        var now = Math.floor(Date.now() / 1000 / STEP) * STEP, series = [];
        for (var m = 55; m >= 0; m -= 5) series.push({ ts: now - m * 60 });
        var info = {}; info[product] = { series: series };
        return Promise.resolve({ seriesInfo: info });
      },
    });
  };
  window.wtvTile = function (ts) {
    var now = Math.floor(Date.now() / 1000 / STEP) * STEP, m = Math.max(0, Math.min(55, Math.round((now - ts) / 60 / 5) * 5));
    return 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913' + (m ? '-m' + String(m).padStart(2, '0') + 'm' : '') + '/{z}/{x}/{y}.png';
  };
  // ── Data maps ──
  // Weatherscan v2 never finished its four data maps (they always said "Temporarily
  // Unavailable"), so we draw them here, each on our own base map:
  //   travel   Travel Weather — Weather TV's precipitation-type map (rain, snow, mix, ice) from
  //            tiles.watchweathertv.com when a scan is ready; otherwise live NEXRAD radar (IEM)
  //   precip   Estimated Precip — MRMS rain and melted snow over the past 24 hours (IEM)
  //   qpf      Precip Forecast — NWS Weather Prediction Center rain/snow-water for the next 3 days
  //   drought  Drought Monitor — this week's U.S. Drought Monitor (via IEM)
  // Each slide calls wtvDataMap(kind) as it opens.
  var WXTILES = 'https://tiles.watchweathertv.com', IEM = 'https://mesonet.agron.iastate.edu';
  var DM = {
    travel: { el: 'travel-weather-map', flag: 'travelMapUnavailable', center: [-97.5, 39.4], zoom: 3.55, national: true },
    precip: { el: 'estimated-precip-map', flag: 'estimatedPrecipMapUnavailable', zoom: 4.7 },
    qpf: { el: 'precip-forecast-map', flag: 'precipForecastMapUnavailable', zoom: 4.7 },
    drought: { el: 'drought-monitor-map', flag: 'droughtMonitorMapUnavailable', zoom: 4.7 },
  };
  var USDM = ['#FFFF00', '#FCD37F', '#FFAA00', '#E60000', '#730000'];   // D0 abnormally dry … D4 exceptional
  function legendStyle() {
    if (document.getElementById('wtv-dm-css')) return;
    var c = document.createElement('style'); c.id = 'wtv-dm-css';
    // The precip legends were drawn for weather.com's colors, so only their time labels stay
    c.textContent = '.estimated-precip .legend .box,.estimated-precip .legend .number,.estimated-precip .legend .label,'
      + '.precip-forecast .legend .box,.precip-forecast .legend .number,.precip-forecast .legend .label{visibility:hidden}'
      + '.drought-monitor .box.six{visibility:hidden}'
      + USDM.slice().reverse().map(function (col, k) { return '.drought-monitor .box.' + ['one', 'two', 'three', 'four', 'five'][k] + '{background-color:' + col + ' !important}'; }).join('');
    document.head.appendChild(c);
  }
  function rasterTiles(kind) {
    if (kind === 'precip') return Promise.resolve(IEM + '/cache/tile.py/1.0.0/q2-p24h-900913/{z}/{x}/{y}.png');
    if (kind === 'qpf') return Promise.resolve('https://mapservices.weather.noaa.gov/vector/rest/services/precip/wpc_qpf/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&dpi=96&format=png32&transparent=true&layers=show:9&f=image');
    return fetch(WXTILES + '/meta/ptype', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
      .then(function (m) {
        var ok = m && m.available && m.scan;
        var lg = document.querySelector('.travel-weather .legend'); if (lg) lg.style.visibility = ok ? '' : 'hidden';   // rain/snow/mix legend fits only the ptype map
        return ok ? WXTILES + '/tiles/ptype/' + encodeURIComponent(m.scan) + '/{z}/{x}/{y}.png' : window.wtvTile(Math.floor(Date.now() / 1000));
      });
  }
  function setData(map, kind) {
    var before = 'i2-county-lines-conus-ak-hi-81h5x4';
    if (kind === 'drought') {
      if (map.getSource('wtv-data')) return;
      fetch(IEM + '/geojson/usdm.py').then(function (r) { return r.json(); }).then(function (g) {
        map.addSource('wtv-data', { type: 'geojson', data: g });
        map.addLayer({ id: 'wtv-data', type: 'fill', source: 'wtv-data', paint: { 'fill-color': ['match', ['get', 'dm'], 0, USDM[0], 1, USDM[1], 2, USDM[2], 3, USDM[3], 4, USDM[4], 'rgba(0,0,0,0)'], 'fill-opacity': 0.8 } }, before);
        var d = g.features && g.features[0] && g.features[0].properties.date;
        if (d) $('.drought-monitor .legend .timestamp').text('Valid ' + dateFns.format(new Date(d + 'T12:00:00'), 'MMM d'));
      }).catch(function (e) { console.warn('drought map', e); });
      $('.drought-monitor .legend .exceptional').html('Exceptional<br>Drought'); $('.drought-monitor .legend .dry').html('Abnormally<br>Dry');
      return;
    }
    if (kind === 'qpf') $('.precip-forecast .legend .timestamp').text('Next 3 Days');
    rasterTiles(kind).then(function (url) {
      if (map._wtvUrl === url) return;
      map._wtvUrl = url;
      if (map.getLayer('wtv-data')) map.removeLayer('wtv-data');
      if (map.getSource('wtv-data')) map.removeSource('wtv-data');
      map.addSource('wtv-data', { type: 'raster', tiles: [url], tileSize: 256 });
      map.addLayer({ id: 'wtv-data', type: 'raster', source: 'wtv-data', paint: { 'raster-opacity': kind === 'travel' ? 0.9 : 0.85, 'raster-fade-duration': 0 } }, before);
    });
  }
  window.wtvDataMap = function (kind) {
    var d = DM[kind]; if (!d || !window.maplibregl) return;
    try { weatherData[d.flag] = false; } catch (e) {}
    legendStyle();
    setTimeout(function () {                      // after the slide is showing, so the map can measure itself
      try {
        var el = document.getElementById(d.el); if (!el) return;
        el.style.backgroundImage = 'none';
        if (!d.map) {
          var c = systemSettings.mainCity || {};
          d.map = new maplibregl.Map({ container: d.el, style: window.WTV_MAP_STYLE, trackResize: false, interactive: false, attributionControl: false,
            center: d.center || [+c.lon || -96, +c.lat || 39], zoom: d.zoom });
          d.map.on('load', function () {
            d.map.setLayoutProperty('i2-county-lines-conus-ak-hi-81h5x4', 'visibility', 'none');
            d.map.setPaintProperty('cb-2019-us-state-20m-nocoast-7m1rrd', 'line-width', d.national ? 2 : 1.8);
            setData(d.map, kind);
          });
        } else { d.map.resize(); if (d.map.loaded()) setData(d.map, kind); }
      } catch (e) { console.warn('data map', kind, e); }
    }, 80);
  };

  // Show the satellite picture whenever a map turns on its satellite land layer
  window.wtvSatOn = function (map) { try { map.setLayoutProperty('wtv-goes', 'visibility', 'visible'); } catch (e) {} };

  // Music: the same list WeatherStar plays (public/weatherstar/music/default)
  window.WTV_MUSIC = [];
  fetch('/weatherstar/playlist.json').then(function (r) { return r.json(); }).then(function (j) {
    window.WTV_MUSIC = (j.availableFiles || []).map(function (f) { return '/weatherstar/music/' + f.split('/').map(encodeURIComponent).join('/'); });
  }).catch(function () {});

  // ── Sound: our own announcer and switches ──
  // Weatherscan's narration clips and music are recordings from The Weather Channel, so we don't
  // host them. Instead the browser's own speech voice announces each screen, and the music dips
  // while it talks (Weatherscan's own playVoice() calls this). Music and voice can each be
  // switched off with the small control that appears when you move the mouse or tap; the choice
  // is remembered on this device.
  var LSget = function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch (e) { return d; } };
  var LSset = function (k, v) { try { localStorage.setItem(k, v ? '1' : '0'); } catch (e) {} };
  var musicOn = LSget('wtvScanMusic', true), voiceOn = LSget('wtvScanVoice', true), talking = false;
  window.wtvMusicVol = function () { return musicOn ? (talking ? 0.18 : 0.8) : 0; };
  var LINES = {
    CurrentConditions: 'Here are your current conditions.',
    TextForecast: "Here's your local forecast.",
    DaypartForecast: "Here's your forecast for the next few hours.",
    LocalDoppler: "Here's your local Doppler radar.",
    RegionalForecastConditions: "Here's a look at the regional forecast.",
    LocalAirportConditions: "Here's a look at conditions at area airports.",
    TrafficOverview: "Here's your local traffic.", TrafficFlow: "Here's your local traffic flow.", AllergyReport: "Here's your allergy report.",
  };
  // One voice for every screen: chosen once, then kept (and remembered on this device). Before,
  // screens spoken before the browser had listed its voices used its default voice instead.
  var voice = null, VKEY = 'wtvScanVoiceName';
  function pickVoice() {
    try {
      if (voice) return;                                         // already chosen: never switch mid-show
      var all = speechSynthesis.getVoices(), kept = null;
      try { kept = localStorage.getItem(VKEY); } catch (e) {}
      if (kept) voice = all.find(function (v) { return v.name === kept; }) || null;
      if (voice) return;
      var vs = speechSynthesis.getVoices().filter(function (v) { return /^en(-|_)US/i.test(v.lang); });
      // Best first: the neural "Natural"/"Online" voices (Edge, Windows 11), then Google's own
      // voice in Chrome, then the better Mac voices. The old Windows voices (David, Zira, Mark)
      // sound robotic, so they're only used if nothing else is installed.
      var rank = [/(Andrew|Brian|Guy|Christopher|Eric|Roger|Steffan).*(Natural|Online)/i, /(Natural|Online)/i, /^Google US English/i,
        /(Evan|Nathan|Tom|Aaron).*(Enhanced|Premium)|(Enhanced|Premium)/i, /Samantha|Alex/i];
      voice = null;
      for (var r = 0; r < rank.length && !voice; r++) voice = vs.find(function (v) { return rank[r].test(v.name); }) || null;
      if (!voice) voice = vs.find(function (v) { return !/David|Zira|Mark/i.test(v.name); }) || vs[0] || null;
      if (voice) try { localStorage.setItem(VKEY, voice.name); } catch (e) {}
    } catch (e) {}
  }
  if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  function duck(mgr, on) { talking = on; try { mgr.musicPlayer.jPlayer('volume', wtvMusicVol()); } catch (e) {} }
  function beeps(mgr) {                                           // the warning tone, made here (no audio file)
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)(), t = ctx.currentTime + 0.05;
      duck(mgr, true);
      for (var i = 0; i < 4; i++) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = 960; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
        o.start(t); o.stop(t + 0.4); t += 0.55;
      }
      setTimeout(function () { duck(mgr, false); ctx.close(); }, 2400);
    } catch (e) {}
  }
  // Recorded announcer clips: put an MP3 named after a line (CurrentConditions.mp3, …) in
  // weatherscan/voice/ and list its name in voice/clips.json; it plays instead of the browser voice.
  var CLIPS = {};
  fetch('voice/clips.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : []; })
    .then(function (a) { (a || []).forEach(function (k) { CLIPS[k] = 1; }); }).catch(function () {});
  function playClip(key, mgr) {
    try {
      var a = new Audio('voice/' + key + '.mp3'); a.volume = 1;
      a.onplay = function () { duck(mgr, true); };
      a.onended = a.onerror = function () { setTimeout(function () { duck(mgr, false); }, 300); };
      a.play().catch(function () { duck(mgr, false); });
      return true;
    } catch (e) { return false; }
  }
  // Weatherscan's playVoice(files) → speak it instead. Returns true when handled.
  window.wtvSpeak = function (files, mgr) {
    var names = (files || []).map(function (f) { return String(f).replace(/^.*\//, '').replace(/\.\w+$/, ''); });
    if (names.length && names.every(function (n) { return n === 'beep'; })) { beeps(mgr); return true; }
    var key = (names[0] || '').replace(/^Local[-_]/, '').replace(/_Default\d*$/, '');
    var line = LINES[key];
    if (!voiceOn) return true;
    if (CLIPS[key] && playClip(key, mgr)) return true;
    if (!line || !window.speechSynthesis) return true;
    try {
      speechSynthesis.cancel();
      pickVoice();
      if (!voice && speechSynthesis.getVoices().length === 0) return true;   // voices not listed yet: skip this one line rather than use a different voice
      var u = new SpeechSynthesisUtterance(line);
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      u.rate = 0.98; u.pitch = 1; u.volume = 1;
      u.onstart = function () { duck(mgr, true); };
      u.onend = u.onerror = function () { setTimeout(function () { duck(mgr, false); }, 300); };
      speechSynthesis.speak(u);
    } catch (e) {}
    return true;
  };

  // 📍 Location: look up a city, ZIP code or "City, ST" and restart Weatherscan there. The choice
  // is saved as Weather TV's own location on this device, so the radar, forecast and next visit
  // all use it too (the start place otherwise comes from Weather TV or a guess from the network).
  function placePicker(keepShown) {
    var pane = document.createElement('div'); pane.id = 'wtv-loc'; pane.setAttribute('role', 'dialog'); pane.setAttribute('aria-label', 'Change location');
    pane.innerHTML = '<div style="margin-bottom:8px">Show the weather for…</div>'
      + '<form class="row"><input type="search" placeholder="City, ZIP code or City, ST" aria-label="City or ZIP code" autocomplete="off"><button type="submit">Search</button></form>'
      + '<div class="hits"></div><div class="msg"></div>';
    document.body.appendChild(pane);
    var btn = document.getElementById('wtv-place'), form = pane.querySelector('form'), input = pane.querySelector('input'),
      hits = pane.querySelector('.hits'), msg = pane.querySelector('.msg');
    function open(on) {
      pane.classList.toggle('open', on); keepShown();
      var tv = window.WTV_TV && WTV_TV.active;                    // TV / Xbox: move the remote's highlight instead
      if (on) { hits.innerHTML = ''; msg.textContent = ''; setTimeout(function () { if (tv) WTV_TV.focusEl(input); else { input.focus(); input.select(); } }, 30); }
      else if (tv) WTV_TV.focusEl(btn); else btn.focus();
    }
    btn.onclick = function () { open(!pane.classList.contains('open')); };
    // No place known yet (opened without one and nothing saved): ask, instead of showing the middle of the US
    var saved = null; try { saved = JSON.parse(localStorage.getItem('wtv-radar-place') || 'null'); } catch (e) {}
    if (!location.search.slice(1) && !(saved && isFinite(saved.lat))) setTimeout(function () {
      open(true); msg.textContent = "Where are you? Until you pick a place, Weatherscan shows the middle of the U.S.";
    }, 2500);
    pane.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); open(false); } });
    function go(lat, lon, name, label) {
      // Weather TV's one shared location (radar, forecast, WeatherStar, alerts, the guide's bottom bar).
      // Inside Weather TV, let the page set it so alerts and WeatherStar follow right away.
      var done = false;
      try { if (window.parent !== window && parent.wtvSetSharedPlace) { parent.wtvSetSharedPlace(+lat, +lon, label || name, input.value.trim()); done = true; } } catch (e) {}
      if (!done) try { localStorage.setItem('wtv-radar-place', JSON.stringify({ lat: +lat, lon: +lon, label: label || name, query: input.value.trim(), source: 'search' })); } catch (e) {}
      location.replace(location.pathname + '?' + (+lat).toFixed(3) + ',' + (+lon).toFixed(3) + ';' + encodeURIComponent(name));
    }
    form.onsubmit = function (e) {
      e.preventDefault();
      var q = input.value.trim(); if (!q) return;
      hits.innerHTML = ''; msg.textContent = 'Looking up ' + q + '…';
      fetch('/wxapi/v3/location/search?query=' + encodeURIComponent(q) + '&language=en-US&format=json')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          var L = j && j.location, n = L && L.latitude ? L.latitude.length : 0;
          if (!n) { msg.textContent = 'No place found for "' + q + '". Try a ZIP code or "City, ST".'; return; }
          msg.textContent = n > 1 ? 'Pick one:' : '';
          for (var i = 0; i < n; i++) (function (i) {
            var name = L.city[i] || L.displayName[i] || q, where = L.address[i] || [name, L.adminDistrictCode[i] || L.country[i]].filter(Boolean).join(', ');
            var b = document.createElement('button'); b.type = 'button'; b.textContent = where;
            b.onclick = function () { msg.textContent = 'Switching to ' + where + '…'; go(L.latitude[i], L.longitude[i], name, where); };
            hits.appendChild(b);
          })(i);
          if (n === 1) hits.firstChild.focus();
        })
        .catch(function () { msg.textContent = "Couldn't look that up just now. Try again in a moment."; });
    };
  }

  // The small control (bottom right; shows when you move the mouse, tap or press a key)
  function controls() {
    var css = document.createElement('style');
    css.textContent = '#wtv-ctl{position:fixed;right:14px;bottom:14px;z-index:99999;display:flex;gap:8px;opacity:0;transition:opacity .4s;font:700 15px/1 Barlow,system-ui,sans-serif}'
      + '#wtv-ctl.on,html.tv-mode #wtv-ctl{opacity:1}#wtv-ctl button{font:inherit;letter-spacing:.04em;padding:8px 12px;border-radius:8px;border:2px solid #9fc4ff;background:rgba(10,25,60,.85);color:#fff;cursor:pointer}'
      + '#wtv-ctl button.off{opacity:.55;text-decoration:line-through}'
      + '#wtv-note{position:fixed;left:50%;bottom:7%;transform:translateX(-50%);z-index:99998;max-width:80%;padding:10px 18px;border-radius:10px;background:rgba(10,25,60,.9);color:#fff;'
      + 'font:600 18px/1.3 Barlow,system-ui,sans-serif;text-align:center;box-shadow:0 4px 18px rgba(0,0,0,.4);transition:opacity .8s}#wtv-note.gone{opacity:0}'
      + '#wtv-loc{position:fixed;right:14px;bottom:64px;z-index:100000;width:min(420px,92vw);padding:14px;border-radius:12px;border:2px solid #9fc4ff;background:rgba(10,25,60,.96);color:#fff;'
      + 'font:600 16px/1.3 Barlow,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5);display:none}#wtv-loc.open{display:block}'
      + '#wtv-loc .row{display:flex;gap:8px}#wtv-loc input{flex:1;min-width:0;font:inherit;padding:8px 10px;border-radius:8px;border:2px solid #9fc4ff;background:#fff;color:#0a193c}'
      + '#wtv-loc button{font:inherit;padding:8px 12px;border-radius:8px;border:2px solid #9fc4ff;background:#16335f;color:#fff;cursor:pointer}'
      + '#wtv-loc .hits{margin-top:10px;display:flex;flex-direction:column;gap:6px}#wtv-loc .hits button{text-align:left;width:100%}'
      + '#wtv-loc .msg{margin-top:8px;opacity:.85;font-weight:500}#wtv-loc button:focus,#wtv-loc input:focus,#wtv-ctl button:focus{outline:3px solid #ffd000;outline-offset:2px}';
    document.head.appendChild(css);
    var box = document.createElement('div'); box.id = 'wtv-ctl';
    box.innerHTML = '<button type="button" id="wtv-place" aria-haspopup="dialog">📍 Location</button><button type="button" id="wtv-mus" aria-pressed="true">♪ Music</button><button type="button" id="wtv-voi" aria-pressed="true">🗣 Voice</button>';
    document.body.appendChild(box);
    placePicker(show);
    var mus = document.getElementById('wtv-mus'), voi = document.getElementById('wtv-voi');
    function paint() {
      mus.classList.toggle('off', !musicOn); mus.setAttribute('aria-pressed', musicOn);
      voi.classList.toggle('off', !voiceOn); voi.setAttribute('aria-pressed', voiceOn);
      try { if (window.audioPlayer) audioPlayer.musicPlayer.jPlayer('volume', wtvMusicVol()); } catch (e) {}
    }
    mus.onclick = function () { musicOn = !musicOn; LSset('wtvScanMusic', musicOn); paint(); show(); };
    voi.onclick = function () { voiceOn = !voiceOn; LSset('wtvScanVoice', voiceOn); if (!voiceOn) try { speechSynthesis.cancel(); } catch (e) {} paint(); show(); };
    var hideT = null;
    function show() {
      box.classList.add('on'); clearTimeout(hideT);
      hideT = setTimeout(function () { if (!document.getElementById('wtv-loc').classList.contains('open')) box.classList.remove('on'); }, 3500);
    }
    ['mousemove', 'touchstart', 'keydown', 'click'].forEach(function (ev) { addEventListener(ev, show, { passive: true }); });
    paint();

    // Once the show starts, a brief pointer to 📍 Location (in case we guessed the wrong place)
    var q = decodeURIComponent(location.search.slice(1)).split(';')[1];
    var t0 = Date.now(), seen = false, poll = setInterval(function () {
      var st = document.getElementById('startup'), up = st && getComputedStyle(st).display !== 'none';
      if (up) seen = true;
      if (!(seen && !up) && Date.now() - t0 < 60000) return;
      clearInterval(poll);
      if (!q || (seen && up)) return;
      var note = document.createElement('div'); note.id = 'wtv-note';
      note.textContent = 'Weather for ' + q + '. Wrong place? Use 📍 Location at the bottom right.';
      document.body.appendChild(note);
      setTimeout(function () { note.classList.add('gone'); setTimeout(function () { note.remove(); }, 900); }, 6000);
    }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', controls); else controls();

  // Where to start: Weather TV passes "?lat,lon;Name". Opened on its own, use the place saved
  // on this device by Weather TV, else the middle of the US.
  window.wtvDefaultQuery = function () {
    try {
      var p = JSON.parse(localStorage.getItem('wtv-radar-place') || 'null');
      if (p && isFinite(p.lat) && isFinite(p.lon)) return (+p.lat).toFixed(3) + ',' + (+p.lon).toFixed(3) + ';' + String(p.label || '').split(',')[0];
    } catch (e) {}
    return '39.833,-98.585;United States';
  };
})();
