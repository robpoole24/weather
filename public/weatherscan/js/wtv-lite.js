// Weather TV — light map drawer for Weatherscan — updated 2026-11-27T00:10:00Z build.1795741800
//
// Weatherscan draws its radar, satellite and data screens with 11–15 MapLibre maps. Each one
// needs its own WebGL graphics context, and the Xbox (and some TVs) can't hold that many: they
// drop every map and the screen goes white or black. This file is a small stand-in that draws
// the same maps on a plain 2D canvas instead (no WebGL at all). It understands just the parts of
// MapLibre that Weatherscan and wtv.js use: GeoJSON land/lines/fills, raster tile layers (radar,
// satellite, data maps), show/hide, line widths and colors, centering and zoom.
//
// wtv.js decides which drawer to use (see WTV_LITE there).
(function () {
  'use strict';
  var TAU = Math.PI * 2, D2R = Math.PI / 180;
  // Web Mercator: 0..1 across the world
  function mx(lng) { return (lng + 180) / 360; }
  function my(lat) { lat = Math.max(-85.05, Math.min(85.05, lat)); var s = Math.sin(lat * D2R); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); }
  function lngOf(x) { return x * 360 - 180; }
  function latOf(y) { var n = Math.PI - TAU * y; return Math.atan(Math.sinh(n)) / D2R; }

  // ── GeoJSON: fetched and converted once per address, shared by every map ──
  var geoCache = {};
  function prepGeo(g) {
    var out = [];   // [{ props, kind: 'poly'|'line', parts: [[Float64Array xy...]], bbox:[x0,y0,x1,y1] }]
    function ring(coords) {
      var a = new Float64Array(coords.length * 2), x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      for (var i = 0; i < coords.length; i++) {
        var x = mx(coords[i][0]), y = my(coords[i][1]); a[i * 2] = x; a[i * 2 + 1] = y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      return { a: a, b: [x0, y0, x1, y1] };
    }
    function add(geom, props) {
      if (!geom) return;
      var t = geom.type, c = geom.coordinates;
      if (t === 'Polygon') out.push({ props: props, kind: 'poly', parts: c.map(ring) });
      else if (t === 'MultiPolygon') c.forEach(function (p) { out.push({ props: props, kind: 'poly', parts: p.map(ring) }); });
      else if (t === 'LineString') out.push({ props: props, kind: 'line', parts: [ring(c)] });
      else if (t === 'MultiLineString') out.push({ props: props, kind: 'line', parts: c.map(ring) });
      else if (t === 'GeometryCollection') geom.geometries.forEach(function (x) { add(x, props); });
    }
    var feats = g && g.type === 'FeatureCollection' ? g.features : g && g.type === 'Feature' ? [g] : g ? [{ geometry: g, properties: {} }] : [];
    feats.forEach(function (f) { add(f.geometry, f.properties || {}); });
    out.forEach(function (f) {
      var b = [1, 1, 0, 0]; f.parts.forEach(function (p) { b[0] = Math.min(b[0], p.b[0]); b[1] = Math.min(b[1], p.b[1]); b[2] = Math.max(b[2], p.b[2]); b[3] = Math.max(b[3], p.b[3]); });
      f.bbox = b;
    });
    return out;
  }
  function loadGeo(data) {
    if (data && typeof data === 'object') return Promise.resolve(prepGeo(data));
    var url = String(data || '');
    if (!geoCache[url]) geoCache[url] = fetch(url).then(function (r) { return r.ok ? r.json() : null; }).then(prepGeo).catch(function () { return []; });
    return geoCache[url];
  }

  // ── Raster tiles: one picture per address, shared by every map ──
  var tileCache = {}, tileCount = 0;
  function tileImg(url, onload) {
    var t = tileCache[url];
    if (t) { t.used = Date.now(); if (!t.ok && onload && t.waiting.indexOf(onload) < 0) t.waiting.push(onload); return t; }
    t = tileCache[url] = { img: new Image(), ok: false, bad: false, used: Date.now(), waiting: onload ? [onload] : [] };
    t.img.decoding = 'async';
    t.img.onload = function () { t.ok = true; var w = t.waiting; t.waiting = []; w.forEach(function (f) { try { f(); } catch (e) {} }); };
    t.img.onerror = function () { t.bad = true; t.waiting = []; };
    t.img.src = url;
    if (++tileCount % 200 === 0) prune();
    return t;
  }
  function prune() {   // keep memory in check on small devices: forget the oldest pictures
    var keys = Object.keys(tileCache); if (keys.length < 900) return;
    keys.sort(function (a, b) { return tileCache[a].used - tileCache[b].used; }).slice(0, keys.length - 700).forEach(function (k) { delete tileCache[k]; });
  }
  function tileUrl(tpl, z, x, y) {
    var n = Math.pow(2, z), R = 20037508.342789244, size = 2 * R / n;
    var bbox = [-R + x * size, R - (y + 1) * size, -R + (x + 1) * size, R - y * size].join(',');
    return tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{bbox-epsg-3857}', bbox);
  }

  // Colors: plain strings, or a ['match', ['get', key], v1, c1, …, fallback] expression
  function colorFor(val, props) {
    if (!Array.isArray(val)) return val;
    if (val[0] === 'match' && Array.isArray(val[1]) && val[1][0] === 'get') {
      var v = props ? props[val[1][1]] : undefined;
      for (var i = 2; i < val.length - 1; i += 2) if (val[i] === v || (Array.isArray(val[i]) && val[i].indexOf(v) >= 0)) return val[i + 1];
      return val[val.length - 1];
    }
    return '#000';
  }
  var num = function (v, d) { return typeof v === 'number' ? v : d; };
  // Maps skipped while hidden get drawn as soon as their slide shows
  var LIVE = new Set();
  setInterval(function () { LIVE.forEach(function (m) { if (!m._dirty) { LIVE.delete(m); return; } if (m._el.offsetParent) { LIVE.delete(m); m._paint(); } }); }, 250);

  function LiteMap(opts) {
    var self = this;
    this._ev = {};
    this._el = typeof opts.container === 'string' ? document.getElementById(opts.container) : opts.container;
    this._el.classList.add('maplibregl-map', 'mapboxgl-map', 'wtv-lite-map');
    if (getComputedStyle(this._el).position === 'static') this._el.style.position = 'relative';
    this._cv = document.createElement('canvas');
    this._cv.className = 'maplibregl-canvas mapboxgl-canvas';
    this._cv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%';
    this._el.appendChild(this._cv);
    this._ctx = this._cv.getContext('2d');
    var c = opts.center || [0, 0];
    this._center = Array.isArray(c) ? [+c[0] || 0, +c[1] || 0] : [+c.lng || 0, +c.lat || 0];
    this._zoom = +opts.zoom || 0;
    this._w = 0; this._h = 0;
    this._sources = {}; this._layers = []; this._geo = {};
    this._vecVer = 0; this._vecKey = ''; this._vecCanvas = null;
    this._loaded = false; this._raf = 0;
    var st = opts.style || { version: 8, sources: {}, layers: [] };
    Object.keys(st.sources || {}).forEach(function (id) { self.addSource(id, st.sources[id], true); });
    (st.layers || []).forEach(function (l) { self.addLayer(l, undefined, true); });
    // "load" once the outlines are in (every map shares the same downloads)
    var geoIds = Object.keys(this._sources).filter(function (id) { return self._sources[id].type === 'geojson'; });
    Promise.all(geoIds.map(function (id) { return self._geoReady(id); })).then(function () {
      self._loaded = true; self.resize(); self._fire('load', {}); self._fire('idle', {});
    });
  }
  var P = LiteMap.prototype;
  // events
  P.on = function (t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); if (t === 'load' && this._loaded) setTimeout(function () {}, 0); return this; };
  P.once = function (t, fn) { var self = this; var w = function (e) { self.off(t, w); fn.call(self, e); }; return this.on(t, w); };
  P.off = function (t, fn) { var a = this._ev[t]; if (a) { var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } return this; };
  P._fire = function (t, e) { var self = this; (this._ev[t] || []).slice().forEach(function (fn) { try { fn.call(self, e || {}); } catch (err) { console.error(err); } }); };
  // state
  P.loaded = function () { return this._loaded; };
  P.isStyleLoaded = function () { return true; };
  P.getContainer = function () { return this._el; };
  P.getCanvas = function () { return this._cv; };
  P.getCanvasContainer = function () { return this._el; };
  P.remove = function () { cancelAnimationFrame(this._raf); try { this._cv.remove(); } catch (e) {} this._layers = []; };
  P.setProjection = function () { return this; };
  P.getCenter = function () { return { lng: this._center[0], lat: this._center[1] }; };
  P.getZoom = function () { return this._zoom; };
  P.getMinZoom = function () { return 0; };
  P.getMaxZoom = function () { return 22; };
  P.setZoom = function (z) { this._zoom = +z; this._vecVer++; this._paint(); return this; };
  P.setCenter = function (c) { this._center = Array.isArray(c) ? [+c[0], +c[1]] : [+c.lng, +c.lat]; this._vecVer++; this._paint(); return this; };
  P.jumpTo = function (o) { if (o.center) this.setCenter(o.center); if (o.zoom != null) this.setZoom(o.zoom); return this; };
  P.flyTo = P.easeTo = P.jumpTo;
  P.resize = function () {
    var w = this._el.clientWidth, h = this._el.clientHeight;
    if (w && h && (w !== this._w || h !== this._h)) { this._w = w; this._h = h; this._cv.width = w; this._cv.height = h; this._vecVer++; }
    this._paint(); return this;
  };
  P.triggerRepaint = function () { this._paint(); };
  // style
  P.getStyle = function () {
    var self = this, src = {};
    Object.keys(this._sources).forEach(function (k) { src[k] = self._sources[k]; });
    return { version: 8, sources: src, layers: this._layers.map(function (l) { return { id: l.id, type: l.type, source: l.source, layout: Object.assign({}, l.layout), paint: Object.assign({}, l.paint) }; }) };
  };
  P.addSource = function (id, s, quiet) {
    var src = Object.assign({}, s);
    this._sources[id] = src;
    if (src.type === 'geojson') this._geoReady(id);
    if (!quiet) { this._vecVer++; this._paint(); }
    var self = this;
    src.setData = function (d) { src.data = d; delete self._geo[id]; self._geoReady(id); };
    return this;
  };
  P.getSource = function (id) { return this._sources[id]; };
  P.removeSource = function (id) { delete this._sources[id]; delete this._geo[id]; return this; };
  P._geoReady = function (id) {
    var self = this, s = this._sources[id];
    if (!s) return Promise.resolve();
    if (!this._geo[id]) this._geo[id] = loadGeo(s.data).then(function (f) { self._geo[id] = Promise.resolve(f); self._geoData = self._geoData || {}; self._geoData[id] = f; self._vecVer++; self._paint(); return f; });
    return this._geo[id];
  };
  P.addLayer = function (l, before, quiet) {
    var layer = { id: l.id, type: l.type, source: l.source, layout: Object.assign({}, l.layout), paint: Object.assign({}, l.paint) };
    if (typeof l.source === 'object') { this.addSource(l.id, l.source, true); layer.source = l.id; }
    var i = before ? this._layers.findIndex(function (x) { return x.id === before; }) : -1;
    if (i >= 0) this._layers.splice(i, 0, layer); else this._layers.push(layer);
    if (!quiet) { this._vecVer++; this._paint(); }
    return this;
  };
  P.getLayer = function (id) { return this._layers.find(function (l) { return l.id === id; }); };
  P.removeLayer = function (id) { this._layers = this._layers.filter(function (l) { return l.id !== id; }); this._vecVer++; this._paint(); return this; };
  P.moveLayer = function (id, before) { var l = this.getLayer(id); if (!l) return this; this._layers = this._layers.filter(function (x) { return x !== l; }); var i = before ? this._layers.findIndex(function (x) { return x.id === before; }) : -1; if (i >= 0) this._layers.splice(i, 0, l); else this._layers.push(l); this._vecVer++; this._paint(); return this; };
  P.setLayoutProperty = function (id, k, v) {
    var l = this.getLayer(id);
    if (!l) { this._fire('error', { error: new Error('Cannot style non-existing layer "' + id + '".') }); return this; }
    if (l.layout[k] === v) return this;
    l.layout[k] = v; if (l.type !== 'raster') this._vecVer++; this._paint(); return this;
  };
  P.getLayoutProperty = function (id, k) { var l = this.getLayer(id); return l ? (k === 'visibility' && l.layout[k] == null ? 'visible' : l.layout[k]) : undefined; };
  P.setPaintProperty = function (id, k, v) {
    var l = this.getLayer(id); if (!l) return this;
    if (l.paint[k] === v) return this;
    l.paint[k] = v; if (l.type !== 'raster') this._vecVer++; this._paint(); return this;
  };
  P.getPaintProperty = function (id, k) { var l = this.getLayer(id); return l ? l.paint[k] : undefined; };
  P.project = function (ll) {
    var lng = Array.isArray(ll) ? ll[0] : ll.lng, lat = Array.isArray(ll) ? ll[1] : ll.lat, W = 512 * Math.pow(2, this._zoom);
    return { x: (mx(lng) - mx(this._center[0])) * W + this._w / 2, y: (my(lat) - my(this._center[1])) * W + this._h / 2 };
  };
  P.unproject = function (p) {
    var W = 512 * Math.pow(2, this._zoom), x = mx(this._center[0]) + ((p.x != null ? p.x : p[0]) - this._w / 2) / W, y = my(this._center[1]) + ((p.y != null ? p.y : p[1]) - this._h / 2) / W;
    return { lng: lngOf(x), lat: latOf(y) };
  };

  // ── drawing (batched to one frame) ──
  P._paint = function () { var self = this; if (!this._raf) this._raf = requestAnimationFrame(function () { self._raf = 0; self._draw(); }); };
  P._view = function () {
    var W = 512 * Math.pow(2, this._zoom), cx = mx(this._center[0]) * W, cy = my(this._center[1]) * W;
    return { W: W, ox: cx - this._w / 2, oy: cy - this._h / 2 };
  };
  P._draw = function () {
    if (!this._w || !this._h) { this.resize(); if (!this._w) return; }
    // Hidden map (its slide isn't on screen): don't draw; it's redrawn when Weatherscan resizes or changes it
    if (!this._el.offsetParent && getComputedStyle(this._el).position !== 'fixed') {
      this._dirty = true; LIVE.add(this);
      var v0 = this._view(), self0 = this;   // still fetch the radar pictures, so the loop is ready when it shows
      this._layers.forEach(function (l) { if (l.type === 'raster') self0._drawRaster(null, l, v0); });
      return;
    }
    this._dirty = false;
    var ctx = this._ctx, v = this._view(), self = this;
    ctx.clearRect(0, 0, this._w, this._h);
    // Runs of vector layers are drawn once into a cached picture; radar frames on top/between
    var run = [];
    var flush = function () { if (run.length) { self._drawVectors(ctx, run, v); run = []; } };
    this._layers.forEach(function (l, idx) {
      if (l.type === 'raster') { flush(); self._drawRaster(ctx, l, v); }
      else run.push(idx);
    });
    flush();
  };
  P._drawVectors = function (ctx, idxs, v) {
    var self = this, vis = idxs.map(function (i) { return self._layers[i]; }).filter(function (l) { return l.layout.visibility !== 'none'; });
    if (!vis.length) return;
    // No radar showing on this map: draw the outlines straight onto it (no second picture kept in
    // memory; the Xbox's graphics memory is small, and running out shows as a black flash)
    var self2 = this;
    if (!this._layers.some(function (l) { return l.type === 'raster' && self2._showsLayer(l.id); })) {
      if (this._vc) this._vc = null;
      vis.forEach(function (l) { self._drawVecLayer(ctx, l, v); });
      return;
    }
    var key = this._vecVer + '|' + idxs.join(',') + '|' + this._w + 'x' + this._h;
    this._vc = this._vc || {};
    var c = this._vc[idxs.join(',')];
    if (!c || c.key !== key) {
      c = c || { cv: document.createElement('canvas') };
      c.cv.width = this._w; c.cv.height = this._h; c.key = key;
      var g = c.cv.getContext('2d');
      vis.forEach(function (l) { self._drawVecLayer(g, l, v); });
      this._vc[idxs.join(',')] = c;
    }
    ctx.drawImage(c.cv, 0, 0);
  };
  P._drawVecLayer = function (g, l, v) {
    var p = l.paint, w = this._w, h = this._h;
    if (l.type === 'background') { g.globalAlpha = num(p['background-opacity'], 1); g.fillStyle = p['background-color'] || '#000'; g.fillRect(0, 0, w, h); g.globalAlpha = 1; return; }
    var feats = this._geoData && this._geoData[l.source];
    if (!feats || !feats.length) return;
    var W = v.W, ox = v.ox, oy = v.oy, x0 = ox / W, y0 = oy / W, x1 = (ox + w) / W, y1 = (oy + h) / W, pad = 2 / W;
    var isFill = l.type === 'fill', lw = num(p['line-width'], 1);
    var colorProp = isFill ? p['fill-color'] : p['line-color'], perFeature = Array.isArray(colorProp);
    g.globalAlpha = num(isFill ? p['fill-opacity'] : p['line-opacity'], 1);
    g.lineJoin = 'round'; g.lineCap = 'round'; g.lineWidth = lw;
    var path = function (f) {
      f.parts.forEach(function (r) {
        if (r.b[2] < x0 - pad || r.b[0] > x1 + pad || r.b[3] < y0 - pad || r.b[1] > y1 + pad) return;
        var a = r.a, n = a.length, lx = -1e9, ly = -1e9;
        for (var i = 0; i < n; i += 2) {
          var px = a[i] * W - ox, py = a[i + 1] * W - oy;
          if (i === 0) g.moveTo(px, py); else if (Math.abs(px - lx) + Math.abs(py - ly) < 0.6 && i < n - 2) continue; else g.lineTo(px, py);
          lx = px; ly = py;
        }
        if (f.kind === 'poly') g.closePath();
      });
    };
    var visible = function (f) { return !(f.bbox[2] < x0 - pad || f.bbox[0] > x1 + pad || f.bbox[3] < y0 - pad || f.bbox[1] > y1 + pad); };
    if (!perFeature) {
      g.beginPath();
      feats.forEach(function (f) { if (visible(f)) path(f); });
      if (isFill) { g.fillStyle = colorProp || '#000'; g.fill('evenodd'); } else { g.strokeStyle = colorProp || '#000'; g.stroke(); }
    } else {
      feats.forEach(function (f) {
        if (!visible(f)) return;
        var col = colorFor(colorProp, f.props); if (!col || col === 'rgba(0,0,0,0)') return;
        g.beginPath(); path(f);
        if (isFill) { g.fillStyle = col; g.fill('evenodd'); } else { g.strokeStyle = col; g.stroke(); }
      });
    }
    g.globalAlpha = 1;
  };
  P._drawRaster = function (ctx, l, v) {
    var s = this._sources[l.source]; if (!s || !s.tiles || !s.tiles.length) return;
    var ts = s.tileSize || 512, minz = s.minzoom != null ? s.minzoom : 0, maxz = s.maxzoom != null ? s.maxzoom : 22;
    var z = Math.round(this._zoom + Math.log(512 / ts) / Math.LN2);
    z = Math.max(minz, Math.min(maxz, z, 22));
    var n = Math.pow(2, z), size = v.W / n;
    var tx0 = Math.floor(v.ox / size), ty0 = Math.max(0, Math.floor(v.oy / size)), tx1 = Math.floor((v.ox + this._w) / size), ty1 = Math.min(n - 1, Math.floor((v.oy + this._h) / size));
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 80) return;   // way too zoomed out for this layer
    var op = num(l.paint['raster-opacity'], 1), show = l.layout.visibility !== 'none' && op > 0, self = this;
    var redraw = function () { if (show || self._showsLayer(l.id)) self._paint(); };
    if (!ctx) show = false;
    if (ctx) ctx.globalAlpha = op;
    for (var ty = ty0; ty <= ty1; ty++) for (var tx = tx0; tx <= tx1; tx++) {
      var wx = ((tx % n) + n) % n;
      var t = tileImg(tileUrl(s.tiles[0], z, wx, ty), redraw);   // always load (keeps radar loops ready), draw only when shown
      if (show && t.ok) {
        try { ctx.drawImage(t.img, Math.round(tx * size - v.ox), Math.round(ty * size - v.oy), Math.ceil(size) + 1, Math.ceil(size) + 1); } catch (e) {}
      }
    }
    if (ctx) ctx.globalAlpha = 1;
  };
  P._showsLayer = function (id) { var l = this.getLayer(id); return l && l.layout.visibility !== 'none' && num(l.paint['raster-opacity'], 1) > 0; };

  window.WTVLiteMap = LiteMap;
})();
