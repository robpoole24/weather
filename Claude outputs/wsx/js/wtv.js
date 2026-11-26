// Weather TV glue for Weatherscan v2 — updated 2026-11-26T19:00:00Z build.1795719600
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
      coast: { type: 'geojson', data: GEO + 'coast.json' },
      states: { type: 'geojson', data: GEO + 'states.json' },
      counties: { type: 'geojson', data: GEO + 'counties.json' },
      countries: { type: 'geojson', data: GEO + 'countries.json' },
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
      { id: 'wtv-goes', type: 'raster', source: 'goes', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 } },
      line('i2-county-lines-conus-ak-hi-81h5x4', 'counties', 'rgba(232,236,220,0.35)', 0.6),
      line('cb-2019-us-state-20m-nocoast-7m1rrd', 'states', '#eef1e6', 1.4),
      line('country-boundaries', 'countries', '#eef1e6', 1.4),
      line('i2-coastlines-conus-ak-hi-06wtga', 'coast', '#0b1d38', 1.2),
      line('i2-road-vectors-conus-ak-hi-4r25d3', 'none', '#000', 1, 'none'),
      line('i2-road-vectors-conus-ak-hi-4r25d3 copy', 'none', '#777', 1, 'none'),
      line('i2-road-vectors-conus-ak-hi-4r25d3 (2)', 'none', '#777', 1, 'none'),
      line('i2-road-vectors-conus-ak-hi-4r25d3 (4)', 'none', '#777', 1, 'none'),
      line('place-label', 'none', '#fff', 1, 'none'),
      line('place-label copy', 'none', '#fff', 1, 'none'),
      line('airport-label', 'none', '#fff', 1, 'none'),
    ],
  };

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
  // Show the satellite picture whenever a map turns on its satellite land layer
  window.wtvSatOn = function (map) { try { map.setLayoutProperty('wtv-goes', 'visibility', 'visible'); } catch (e) {} };

  // Music: the same list WeatherStar plays (public/weatherstar/music/default)
  window.WTV_MUSIC = [];
  fetch('/weatherstar/playlist.json').then(function (r) { return r.json(); }).then(function (j) {
    window.WTV_MUSIC = (j.availableFiles || []).map(function (f) { return '/weatherstar/music/' + f.split('/').map(encodeURIComponent).join('/'); });
  }).catch(function () {});

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
