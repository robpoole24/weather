// WeatherTV — 3D hodograph (radar page) — build.1792700000
//
// The wind profile above any spot, from the HRRR model (GFS outside the US),
// drawn as a hodograph that opens top-down, lifts into 3D (height rising from
// the ground) and slowly turns. Underneath: shear, helicity, storm motion,
// CAPE, lapse rate, STP, a tornado-favorability badge and a plain-language
// read of the hodograph's shape.
//
// Ways in (all go through WTV_HODO.openAt / setMode):
//   Layers › Mesoscale › Hodograph        crosshair you can drag; card follows it
//   "🌀 Storm environment" in warning and storm-cell popups
//   Right-click / long-press the map       "Hodograph here"
//   H key (computers)                      at the mouse
//   TV & Xbox: OK moves the crosshair · Red/Green (TV) or LT/RT (Xbox) jump
//   storm to storm · Back closes. Buttons in the card do the same.
//
// Data: GET {WXTILES_BASE}/meta/hodograph?lat=&lon=&fh= (wxtiles sidecar)
(function () {
  'use strict';
  if (typeof map === 'undefined' || !window.L) return;

  const TV = !!(window.WTV_TV && WTV_TV.active);
  const BASE = (typeof WXTILES_BASE !== 'undefined' ? WXTILES_BASE : 'https://tiles.watchweathertv.com');
  const REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const LAYERS = [                                  // height bands (km) and colors
    { top: 1, color: '#ff4fd8', label: '0–1 km' },
    { top: 3, color: '#ff3b30', label: '1–3' },
    { top: 6, color: '#30d158', label: '3–6' },
    { top: 9, color: '#ffd60a', label: '6–9' },
    { top: 99, color: '#40e0ff', label: '9+' },
  ];
  const bandColor = (km) => (LAYERS.find(l => km <= l.top + 1e-6) || LAYERS[LAYERS.length - 1]).color;
  const CONVECTIVE = /Tornado|Severe Thunderstorm|Extreme Wind|Special Weather Statement|Severe Weather Statement/;

  // Testers: radar.html?hodotest=<DEBUG_KEY> → past HRRR runs + a self-check against HRRR's own numbers
  let TEST_KEY = '';
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('hodotest')) {
      sessionStorage.setItem('wtv-hodo-test', q.get('hodotest'));
      q.delete('hodotest');
      history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
    }
    TEST_KEY = sessionStorage.getItem('wtv-hodo-test') || '';
  } catch (_) {}

  const S = { cycle: null, on: false, lat: null, lng: null, label: '', fh: 0, data: null, marker: null, card: null,
    reqId: 0, retry: null, pending: null, storms: [], stormIdx: -1, stormsAt: 0, arrows: false, flat: false,
    mouse: null, idleTimer: null };

  // ── Styles ────────────────────────────────────────────────────────────────
  const css = document.createElement('style');
  css.textContent = `
  #hodo-card { position:fixed; z-index:1200; right:12px; top:64px; width:360px; max-height:calc(100% - 80px);
    overflow-y:auto; background:rgba(10,14,20,0.96); border:1px solid var(--border, rgba(0,180,216,0.25));
    border-radius:10px; color:#e8f4fd; font-family:'Barlow',system-ui,sans-serif; box-shadow:0 10px 30px rgba(0,0,0,0.5);
    display:none; transition:opacity .4s, max-height .25s; overscroll-behavior:contain; -webkit-overflow-scrolling:touch; touch-action:pan-y; }
  #hodo-card.open { display:block; }
  #hodo-card.dim { opacity:.35; }
  .hodo-head { display:flex; align-items:center; gap:8px; padding:10px 12px 6px; }
  .hodo-title { font:700 1rem 'Barlow Condensed',sans-serif; letter-spacing:.06em; text-transform:uppercase; }
  .hodo-storm { margin:0 10px 8px; padding:7px 10px; border-radius:6px; background:rgba(255,80,80,.10); border:1px solid rgba(255,120,120,.35); }
  .hodo-storm b { display:block; font:700 .95rem 'Barlow Condensed',sans-serif; letter-spacing:.03em; color:#fff; }
  .hodo-storm span { display:block; font-size:.7rem; color:#c8ddf0; margin-top:1px; }
  .hodo-storm[hidden] { display:none; }
  html.tv-mode .hodo-storm b { font-size:1.4rem; } html.tv-mode .hodo-storm span { font-size:1rem; }
  .hodo-where { flex:1; font-size:.72rem; color:#7a9bb5; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .hodo-x { background:none; border:1px solid rgba(255,255,255,.15); color:#e8f4fd; border-radius:6px; width:30px; height:30px; cursor:pointer; font-size:.9rem; }
  .hodo-stage { position:relative; margin:0 10px; background:radial-gradient(circle at 50% 60%, #1a1530 0%, #0d0b18 75%);
    border-radius:8px; overflow:hidden; aspect-ratio:1/1; touch-action:none; cursor:grab; }
  .hodo-stage canvas { width:100%; height:100%; display:block; }
  .hodo-status { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center;
    padding:24px; font-size:.82rem; color:#c8ddf0; background:rgba(10,14,20,.55); }
  .hodo-status[hidden] { display:none; }
  .hodo-legend { display:flex; justify-content:center; flex-wrap:wrap; gap:4px 10px; padding:6px 10px 2px; font:600 .68rem 'Barlow Condensed',sans-serif; letter-spacing:.04em; }
  .hodo-legend i { display:inline-block; width:14px; height:4px; border-radius:2px; vertical-align:middle; margin-right:4px; }
  .hodo-bar { display:flex; align-items:center; gap:6px; padding:6px 10px; }
  .hodo-bar button, .hodo-nav button { background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.14); color:#e8f4fd;
    border-radius:6px; padding:5px 9px; font:600 .74rem 'Barlow',sans-serif; cursor:pointer; }
  .hodo-bar button:disabled, .hodo-nav button:disabled { opacity:.35; cursor:default; }
  .hodo-bar button.on { border-color:#00b4d8; color:#00b4d8; }
  .hodo-time { flex:1; text-align:center; font-size:.76rem; color:#c8ddf0; }
  .hodo-tiles { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; padding:4px 10px; }
  .hodo-tile { background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08); border-radius:6px; padding:6px 4px; text-align:center; }
  .hodo-tile b { display:block; font:700 1.05rem 'Barlow Condensed',sans-serif; }
  .hodo-tile b small { font-size:.62rem; font-weight:600; color:#7a9bb5; margin-left:2px; }
  .hodo-tile span { display:block; font:600 .6rem 'Barlow Condensed',sans-serif; letter-spacing:.05em; text-transform:uppercase; color:#7a9bb5; }
  .hodo-fav { display:flex; align-items:center; justify-content:space-between; margin:6px 10px 2px; padding:7px 10px; border-radius:6px;
    background:rgba(255,255,255,.04); font:700 .78rem 'Barlow Condensed',sans-serif; letter-spacing:.05em; text-transform:uppercase; }
  .hodo-badge { padding:3px 10px; border-radius:5px; color:#fff; }
  .hodo-badge.low { background:#2e9e44; } .hodo-badge.moderate { background:#d98e04; } .hodo-badge.high { background:#d0342c; } .hodo-badge.very-high { background:#a1179e; }
  .hodo-read { padding:6px 12px 2px; font-size:.8rem; line-height:1.45; color:#d6e6f3; }
  .hodo-read b { color:#fff; }
  .hodo-nav { display:flex; gap:6px; padding:6px 10px; }
  .hodo-nav button { flex:1; }
  .hodo-foot { padding:4px 12px 10px; font-size:.66rem; color:#7a9bb5; line-height:1.4; }
  .hodo-test { margin:6px 10px; padding:8px; border:1px dashed rgba(244,162,97,.6); border-radius:6px; font-size:.74rem; }
  .hodo-test input { width:120px; background:#0a0e14; color:#e8f4fd; border:1px solid rgba(255,255,255,.2); border-radius:4px; padding:4px 6px; font:.74rem monospace; }
  .hodo-test button { background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.14); color:#e8f4fd; border-radius:5px; padding:3px 8px; cursor:pointer; font-size:.72rem; }
  .hodo-test table { width:100%; border-collapse:collapse; margin-top:6px; }
  .hodo-test td, .hodo-test th { padding:2px 4px; text-align:right; font-variant-numeric:tabular-nums; }
  .hodo-test td:first-child, .hodo-test th:first-child { text-align:left; }
  .hodo-test .v-match { color:#30d158; } .hodo-test .v-close { color:#ffd60a; } .hodo-test .v-check { color:#ff6b6b; }
  .hodo-btn { margin-top:8px; background:rgba(0,180,216,.12); border:1px solid rgba(0,180,216,.5); color:#7fdcff; border-radius:6px;
    padding:5px 10px; font:600 .75rem 'Barlow',sans-serif; cursor:pointer; }
  .hodo-cross { pointer-events:auto; }
  .hodo-grip { display:none; }
  @media (max-width: 700px) {
    /* Phones: a bottom sheet. Swipe up on it to scroll; tap the handle to make it taller. */
    #hodo-card { left:0; right:0; top:auto; bottom:0; width:auto; max-height:62%; border-radius:14px 14px 0 0;
      padding-bottom:env(safe-area-inset-bottom, 0); }
    #hodo-card.tall { max-height:calc(100% - 56px); }
    .hodo-grip { display:block; width:100%; height:18px; border:0; background:none; cursor:pointer; padding:6px 0 0; }
    .hodo-grip::before { content:''; display:block; width:42px; height:5px; border-radius:3px; margin:0 auto; background:rgba(255,255,255,.28); }
    .hodo-head { padding-top:2px; }
    .hodo-stage { width:min(280px, 34vh); max-width:none; margin:0 auto; }
  }
  @media (max-width: 700px) and (pointer: coarse) {
    .hodo-stage { touch-action:pan-y; }   /* side-to-side turns it; up/down scrolls the sheet */
  }
  html.tv-mode #hodo-card { width:34vw; right:1.5vw; top:9vh; max-height:86vh; font-size:1.25rem; }
  html.tv-mode .hodo-title { font-size:1.5rem; }
  html.tv-mode .hodo-stage { aspect-ratio:auto; height:42vh; }
  html.tv-mode .hodo-tile b { font-size:1.6rem; }
  html.tv-mode .hodo-tile span, html.tv-mode .hodo-legend { font-size:.95rem; }
  html.tv-mode .hodo-read { font-size:1.1rem; }
  html.tv-mode .hodo-fav { font-size:1.15rem; }
  html.tv-mode .hodo-bar button, html.tv-mode .hodo-nav button { font-size:1.05rem; padding:8px 14px; }
  html.tv-mode .hodo-where, html.tv-mode .hodo-time, html.tv-mode .hodo-foot { font-size:1rem; }`;
  document.head.appendChild(css);

  // ── Card ──────────────────────────────────────────────────────────────────
  function buildCard() {
    const c = document.createElement('div');
    c.id = 'hodo-card'; c.setAttribute('role', 'dialog'); c.setAttribute('aria-label', 'Hodograph');
    c.innerHTML = `
      <button class="hodo-grip" data-act="grow" aria-label="Make the hodograph panel taller or shorter"></button>
      <div class="hodo-head"><span class="hodo-title">🌀 Hodograph</span><span class="hodo-where"></span>
        <button class="hodo-x" data-act="close" aria-label="Close the hodograph">✕</button></div>
      <div class="hodo-storm" hidden aria-live="polite"></div>
      <div class="hodo-stage" data-tv-skip><canvas aria-label="3D hodograph"></canvas><div class="hodo-status"></div></div>
      <div class="hodo-legend">${LAYERS.map(l => `<span><i style="background:${l.color}"></i>${l.label}</span>`).join('')}</div>
      <div class="hodo-bar">
        <button data-act="hour-" aria-label="Earlier hour">◀</button>
        <span class="hodo-time"></span>
        <button data-act="hour+" aria-label="Later hour">▶</button>
        <button data-act="flat" aria-label="Switch between 3D and flat">2D</button>
        <button data-act="arrows" aria-label="Show wind arrows">Arrows</button>
      </div>
      <div class="hodo-tiles"></div>
      <div class="hodo-fav" hidden></div>
      <div class="hodo-read"></div>
      <div class="hodo-nav"><button data-act="prev">◀ Previous storm</button><button data-act="next">Next storm ▶</button></div>
      ${TEST_KEY ? `<div class="hodo-test">🧪 <b>Tester</b> · HRRR run <input class="hodo-run" placeholder="YYYYMMDDHH" maxlength="10" aria-label="HRRR run, UTC">
        <button data-act="run">Load</button> <button data-act="latest">Latest</button>
        <div style="opacity:.7;margin-top:3px">UTC, last 30 days — e.g. 2026102200 is 7 PM CDT Oct 21</div><div class="hodo-check"></div></div>` : ''}
      <div class="hodo-foot"></div>`;
    document.body.appendChild(c);
    c.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const a = b.dataset.act;
      if (a === 'close') close();
      else if (a === 'grow') c.classList.toggle('tall');
      else if (a === 'hour-') setHour(S.fh - 1);
      else if (a === 'hour+') setHour(S.fh + 1);
      else if (a === 'flat') { S.flat = !S.flat; view.setFlat(S.flat); b.textContent = S.flat ? '3D' : '2D'; }
      else if (a === 'arrows') { S.arrows = !S.arrows; b.classList.toggle('on', S.arrows); view.draw(); }
      else if (a === 'prev') jumpStorm(-1);
      else if (a === 'next') jumpStorm(1);
      else if (a === 'run') { const v = (S.card.querySelector('.hodo-run').value || '').trim(); if (/^\d{10}$/.test(v)) { S.cycle = v; S.fh = 0; S.data = null; load(); } else status('Type the run as YYYYMMDDHH (UTC).'); }
      else if (a === 'latest') { S.cycle = null; S.fh = 0; S.data = null; S.card.querySelector('.hodo-run').value = ''; load(); }
    });
    ['pointerdown', 'wheel', 'keydown'].forEach(ev => c.addEventListener(ev, wake, { passive: true }));
    // Phones: if the web view doesn't scroll the panel itself, scroll it by hand
    let sw = null;
    c.addEventListener('touchstart', (e) => { const t = e.touches[0]; sw = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, top: c.scrollTop, native: false, manual: false } : null; }, { passive: true });
    c.addEventListener('scroll', () => { if (sw && !sw.manual) sw.native = true; }, { passive: true });
    c.addEventListener('touchmove', (e) => {
      if (!sw || sw.native) return;
      const t = e.touches[0], dy = t.clientY - sw.y, dx = t.clientX - sw.x;
      if (!sw.manual && (Math.abs(dy) < 30 || Math.abs(dy) < Math.abs(dx) * 1.2)) return;
      sw.manual = true; c.scrollTop = sw.top - (dy - Math.sign(dy) * 30);
    }, { passive: true });
    c.addEventListener('touchend', () => { sw = null; }, { passive: true });
    L.DomEvent.disableClickPropagation(c); L.DomEvent.disableScrollPropagation(c);
    S.card = c;
    view.attach(c.querySelector('canvas'), c.querySelector('.hodo-stage'));
    return c;
  }

  const $ = (sel) => S.card.querySelector(sel);
  function status(msg) { const s = $('.hodo-status'); if (msg) { s.textContent = msg; s.hidden = false; } else s.hidden = true; }

  // ── Crosshair ─────────────────────────────────────────────────────────────
  const crossIcon = L.divIcon({ className: 'hodo-cross', iconSize: [40, 40], iconAnchor: [20, 20],
    html: '<svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="11" fill="none" stroke="#000" stroke-width="5" opacity=".55"/><circle cx="20" cy="20" r="11" fill="none" stroke="#40e0ff" stroke-width="2.5"/><path d="M20 2v10M20 28v10M2 20h10M28 20h10" stroke="#000" stroke-width="5" opacity=".55"/><path d="M20 2v10M20 28v10M2 20h10M28 20h10" stroke="#40e0ff" stroke-width="2.5"/><circle cx="20" cy="20" r="2.5" fill="#ff4fd8"/></svg>' });
  let dragT = 0;
  function placeMarker() {
    if (!S.marker) {
      S.marker = L.marker([S.lat, S.lng], { icon: crossIcon, draggable: !TV, interactive: !TV, keyboard: false, zIndexOffset: 2000, title: 'Drag to move the hodograph' }).addTo(map);
      S.marker.on('drag', () => {
        const p = S.marker.getLatLng(); S.lat = p.lat; S.lng = p.lng; S.label = '';
        if (Date.now() - dragT > 700) { dragT = Date.now(); load(); }
      });
      S.marker.on('dragend', () => { const p = S.marker.getLatLng(); S.lat = p.lat; S.lng = p.lng; load(); });
    } else S.marker.setLatLng([S.lat, S.lng]);
  }

  // ── Opening / closing ─────────────────────────────────────────────────────
  function startingPoint() {
    if (S.pending) { const p = S.pending; S.pending = null; return p; }
    const b = map.getBounds();
    const st = stormList(true).find(s => b.contains([s.lat, s.lng]));
    if (st) return st;
    try { if (typeof _place !== 'undefined' && _place && _place.lat != null) return { lat: _place.lat, lng: _place.lon, label: _place.label || 'Your location' }; } catch (_) {}
    try { if (userLat != null) return { lat: userLat, lng: userLng, label: 'Your location' }; } catch (_) {}
    const c = map.getCenter(); return { lat: c.lat, lng: c.lng, label: '' };
  }
  function setMode(on) {
    if (on === S.on) { if (on && S.pending) moveTo(S.pending.lat, S.pending.lng, S.pending.label), S.pending = null; return; }
    S.on = on;
    if (on) {
      if (!S.card) buildCard();
      S.card.classList.add('open');
      const p = startingPoint();
      S.lat = p.lat; S.lng = p.lng; S.label = p.label || '';
      const si = S.storms.indexOf(p);
      S.storm = p.title && si >= 0 ? { title: p.title, where: p.where || '', idx: si + 1, n: S.storms.length } : null;
      if (si >= 0) S.stormIdx = si;
      stormLine();
      if (S.storm) { map.setView([S.lat, S.lng], Math.max(map.getZoom(), 8), { animate: false }); flash(p); }
      placeMarker();
      if (!map.getBounds().contains([S.lat, S.lng])) map.panTo([S.lat, S.lng], { animate: false });
      keepVisible();
      view.intro();
      load();
      tvHint();
      if (TV) setTimeout(tvToMap, 250);
    } else {
      clearTimeout(S.retry); S.reqId++;
      if (S.card) S.card.classList.remove('open', 'dim');
      if (S.marker) { map.removeLayer(S.marker); S.marker = null; }
      view.stop();
    }
  }
  function close() {
    if (typeof overlayState !== 'undefined' && overlayState['hodograph'] && typeof toggleOverlayFromToolbar === 'function') toggleOverlayFromToolbar('hodograph');
    else setMode(false);
  }
  function openAt(lat, lng, label) {
    S.pending = { lat: +lat, lng: +lng, label: label || '' };
    map.closePopup();
    if (typeof overlayState !== 'undefined' && !overlayState['hodograph'] && typeof toggleOverlayFromToolbar === 'function') toggleOverlayFromToolbar('hodograph');
    else setMode(true);
  }
  function moveTo(lat, lng, label, storm) {
    S.lat = lat; S.lng = lng; S.label = label || '';
    S.storm = storm || null;
    stormLine();
    placeMarker(); keepVisible(); load();
  }
  // Which storm this is, in big type: what the warning is and where
  function stormLine() {
    const el = S.card && S.card.querySelector('.hodo-storm');
    if (!el) return;
    const st = S.storm;
    if (!st) {
      // Picked by hand: say which warning (if any) the crosshair is in
      let a = null;
      try { a = (activeAlertFeatures || []).filter(f => f.geometry && typeof pointInPolygon === 'function' && pointInPolygon(S.lat, S.lng, f.geometry))
        .sort((x, y) => (typeof alertPriorityRank === 'function' ? alertPriorityRank(x.event) - alertPriorityRank(y.event) : 0))[0]; } catch (_) {}
      if (!a) { el.hidden = true; return; }
      el.innerHTML = `<b>${escapeHtml(a.event)}</b><span>${escapeHtml(String(a.areaDesc || '').split(';').slice(0, 2).join(', '))}</span>`;
      el.hidden = false; return;
    }
    const keys = TV ? (/Xbox/i.test(navigator.userAgent) ? 'LT / RT' : 'RED / GREEN') : 'Previous / Next';
    el.innerHTML = `<b>${escapeHtml(st.title)}</b><span>${escapeHtml(st.where || '')}${st.where ? ' · ' : ''}Storm ${st.idx} of ${st.n} · ${keys} for the others</span>`;
    el.hidden = false;
  }
  // Briefly outline the warning (or ring the storm) being looked at
  let flashLayer = null, flashTimer = 0;
  function flash(st) {
    if (flashLayer) { map.removeLayer(flashLayer); flashLayer = null; }
    clearTimeout(flashTimer);
    try {
      flashLayer = st.geometry
        ? L.geoJSON(st.geometry, { interactive: false, style: { color: '#ffffff', weight: 4, dashArray: '8 6', fill: false, opacity: 1 } }).addTo(map)
        : L.circle([st.lat, st.lng], { radius: 9000, interactive: false, color: '#ffffff', weight: 3, dashArray: '6 6', fill: false }).addTo(map);
      flashTimer = setTimeout(() => { if (flashLayer) { map.removeLayer(flashLayer); flashLayer = null; } }, 6000);
    } catch (_) {}
  }
  // Pan so the crosshair isn't hidden behind the card (bottom sheet on phones, side panel elsewhere)
  function keepVisible() {
    if (!S.card || !S.marker) return;
    const pt = map.latLngToContainerPoint([S.lat, S.lng]), size = map.getSize();
    const r = S.card.getBoundingClientRect(), m = map.getContainer().getBoundingClientRect();
    const sheet = r.width >= m.width - 2;                         // phone bottom sheet
    let dx = 0, dy = 0;
    if (sheet) { const free = r.top - m.top; if (pt.y > free - 40 || pt.y < 40) dy = pt.y - free / 2; }
    else { const free = r.left - m.left; if (pt.x > free - 40 || pt.x < 40) dx = pt.x - free / 2; if (pt.y < 60 || pt.y > size.y - 40) dy = pt.y - size.y / 2; }
    if (dx || dy) map.panBy([dx, dy]);
  }
  function setHour(fh) {
    const hours = (S.data && S.data.hours) || [0];
    fh = Math.max(hours[0], Math.min(hours[hours.length - 1], fh));
    if (fh === S.fh) return;
    S.fh = fh; load();
  }

  // ── Data ──────────────────────────────────────────────────────────────────
  async function load(tries = 0) {
    if (!S.on) return;
    const id = ++S.reqId;
    clearTimeout(S.retry);
    $('.hodo-where').textContent = (S.label ? S.label + ' · ' : '') + `${Math.abs(S.lat).toFixed(2)}°${S.lat >= 0 ? 'N' : 'S'} ${Math.abs(S.lng).toFixed(2)}°${S.lng >= 0 ? 'E' : 'W'}`;
    if (!S.data) status('Loading the wind profile…');
    let d;
    try {
      const qs = `lat=${S.lat.toFixed(3)}&lon=${S.lng.toFixed(3)}&fh=${S.fh}`;
      const r = await fetch(TEST_KEY
        ? `${BASE}/meta/debug/hodograph?key=${encodeURIComponent(TEST_KEY)}&${qs}${S.cycle ? '&cycle=' + S.cycle : ''}`
        : `${BASE}/meta/hodograph?${qs}`);
      if (r.status === 404 && TEST_KEY) throw new Error('tester key not accepted');
      d = await r.json();
    } catch (e) { d = { status: 'error', error: /tester key/.test(e.message) ? 'Tester key not accepted (check DEBUG_KEY).' : 'Couldn\'t reach the wind data. Check your connection.' }; }
    if (id !== S.reqId || !S.on) return;
    if (d.status === 'preparing') {
      status(tries < 2 ? 'Getting this hour\'s winds from the HRRR model…' : 'Still preparing — the first look each hour takes about a minute…');
      if (tries < 25) S.retry = setTimeout(() => load(tries + 1), (d.retryAfter || 8) * 1000);
      else status('The model data is taking longer than usual. Close this and try again in a few minutes.');
      return;
    }
    if (d.status !== 'ok') { status(d.error || 'Wind data isn\'t available here right now.'); return; }
    S.data = d; status('');
    render(d);
    // Shown from the previous HRRR run (same valid time) while the newest one loads: swap it in quietly
    if (d.newerLoading && tries < 12) S.retry = setTimeout(() => load(tries + 1), (d.retryAfter || 20) * 1000);
  }

  const fmt = (v, unit) => (v == null ? '—' : `${v}<small>${unit}</small>`);
  const compass = (deg) => (typeof compassName === 'function' ? compassName(deg)
    : ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8]);
  function render(d) {
    const valid = new Date(d.validIso);
    const when = isNaN(valid) ? '' : valid.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const day = d.past && !isNaN(valid) ? valid.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' : '';
    $('.hodo-time').textContent = d.past ? `Run ${d.cycle} +${d.fh} h · ${day}${when}` : `${d.fh === 0 ? 'Now' : '+' + d.fh + ' h'} · ${when} · ${d.source}`;
    const chk = S.card.querySelector('.hodo-check');
    if (chk) {
      const c = d.check;
      chk.innerHTML = !c ? `<div style="margin-top:6px;opacity:.75">Self-check: HRRR's own numbers aren't available for this spot${d.source !== 'HRRR' ? ' (GFS area)' : ''}.</div>`
        : `<div style="margin-top:6px">Self-check vs HRRR's own numbers: <b class="v-${c.verdict}">${({ match: '✓ Match', close: '≈ Close', check: '✗ Check' })[c.verdict]}</b></div>
          <table><tr><th></th><th>Ours</th><th>HRRR</th><th></th></tr>${c.rows.map(r => `<tr><td>${r.name}</td><td>${r.ours}</td><td>${r.hrrr}</td><td class="v-${r.ok ? 'match' : 'check'}">${r.ok ? '✓' : '✗'}</td></tr>`).join('')}</table>
          <div style="opacity:.65;margin-top:4px">${escapeHtml(c.note)}</div>`;
    }
    $('[data-act="hour-"]').disabled = d.fh <= (d.hours || [0])[0];
    $('[data-act="hour+"]').disabled = d.fh >= (d.hours || [0]).slice(-1)[0];
    const rm = d.rm;
    const tiles = [
      ['0–6 km shear', fmt(d.shear['0-6'] && d.shear['0-6'].bulk, 'kt')],
      ['0–1 km SRH', fmt(d.srh['0-1'], 'm²/s²')],
      ['0–3 km SRH', fmt(d.srh['0-3'], 'm²/s²')],
      ['0–1 km shear', fmt(d.shear['0-1'] && d.shear['0-1'].bulk, 'kt')],
      ['Storm motion', rm ? `${compass((rm.dir + 180) % 360)} ${rm.kt}<small>kt</small>` : '—'],
      ['Critical angle', fmt(d.criticalAngle, '°')],
      [d.mlcape != null ? 'ML CAPE' : 'SB CAPE', fmt(d.mlcape != null ? d.mlcape : d.sbcape, 'J/kg')],
      ['0–3 km lapse', fmt(d.lapse03, '°C/km')],
      ['STP', d.stp == null ? '—' : `${d.stp}`],
    ];
    $('.hodo-tiles').innerHTML = tiles.map(([k, v]) => `<div class="hodo-tile"><b>${v}</b><span>${k}</span></div>`).join('');
    const fav = $('.hodo-fav');
    if (d.tornado) { fav.hidden = false; fav.innerHTML = `Tornado favorability <span class="hodo-badge ${d.tornado.level}">${d.tornado.label}</span>`; }
    else fav.hidden = true;
    const total = d.shear['0-6'] ? ` Bulk 0–6 km shear ${d.shear['0-6'].bulk} kt; total ${d.shear['0-6'].total} kt along the curve.` : '';
    const lead = d.summary.startsWith(d.shape.label) ? '' : `<b>${d.shape.label}.</b> `;
    $('.hodo-read').innerHTML = `${lead}${escapeHtml(d.summary)}${total}`;
    const touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    $('.hodo-foot').innerHTML = `${escapeHtml(d.credit)} · model estimate, not an observation.`
      + (d.fromCycle ? ' From the previous run while the newest one loads.' : '') + '<br>' + (TV
      ? (/Xbox/i.test(navigator.userAgent) ? 'A moves the hodograph to the pointer · LT/RT storm to storm · B closes'
        : 'OK moves the hodograph to the pointer · RED/GREEN storm to storm · BACK closes')
      : touch ? 'Tip: drag the crosshair, swipe the picture sideways to turn it, or long-press the map for a hodograph anywhere. Swipe up for more.'
      : 'Tip: drag the crosshair, drag the picture to turn it, or right-click the map for a hodograph anywhere. Press H at the mouse.');
    const s = stormList(false);
    $('[data-act="prev"]').disabled = $('[data-act="next"]').disabled = !s.length;
    view.setData(d);
    wake();
  }
  function escapeHtml(s) { return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ── Storm to storm ────────────────────────────────────────────────────────
  let _cells = [], _cellsAt = 0;
  async function refreshCells() {
    if (Date.now() - _cellsAt < 120000) return;
    _cellsAt = Date.now();
    try {
      const d = await (await fetch('https://mesonet.agron.iastate.edu/geojson/nexrad_attr.py')).json();
      const flag = (v) => v != null && v !== '' && v !== 0 && String(v).toUpperCase() !== 'NONE';
      _cells = (d.features || []).map(f => {
        const p = f.properties || {}, [lng, lat] = f.geometry.coordinates;
        const dbz = p.MAX_DBZ || p.max_dbz || 0, spd = p.SKNT || p.sknt || 0, from = p.DRCT || p.drct || 0;
        const tvs = flag(p.TVS ?? p.tvs), meso = flag(p.MESO ?? p.meso);
        if (!tvs && !meso && dbz < 55) return null;
        // A few miles ahead of the storm: the air it is about to take in
        const dir = (from + 180) % 360 * Math.PI / 180, dist = spd > 0 ? 10 / 111 : 0;
        return { lat: lat + dist * Math.cos(dir), lng: lng + dist * Math.sin(dir) / Math.cos(lat * Math.PI / 180),
          rank: tvs ? 1 : meso ? 3 : 5, label: tvs ? 'Storm with TVS' : meso ? 'Storm with mesocyclone' : `Strong storm (${dbz} dBZ)` };
      }).filter(Boolean).sort((a, b) => a.rank - b.rank).slice(0, 60);
    } catch (_) {}
  }
  function centroid(geom) {
    const rings = geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.type === 'MultiPolygon' ? geom.coordinates.map(p => p[0]) : [];
    let x = 0, y = 0, n = 0;
    rings.forEach(r => r.forEach(([lng, lat]) => { x += lng; y += lat; n++; }));
    return n ? { lat: y / n, lng: x / n } : null;
  }
  function stormList(rebuild) {
    if (!rebuild && S.storms.length && Date.now() - S.stormsAt < 120000) return S.storms;
    refreshCells();
    const rankOf = (ev) => /Tornado Warning/.test(ev) ? 0 : /Extreme Wind/.test(ev) ? 2 : /Severe Thunderstorm Warning/.test(ev) ? 4 : /Watch/.test(ev) ? 7 : 6;
    let list = [];
    try {
      (activeAlertFeatures || []).forEach(a => {
        if (!CONVECTIVE.test(a.event || '') || !a.geometry) return;
        const c = centroid(a.geometry); if (!c) return;
        const where = String(a.areaDesc || '').split(';').slice(0, 2).map(x => x.trim()).filter(Boolean).join(', ');
        list.push({ ...c, rank: rankOf(a.event), label: `${a.event} · ${where}`, title: a.event, where, geometry: a.geometry });
      });
    } catch (_) {}
    // Radar storms: name the warning or county they're in when there is one
    list = list.concat(_cells.map(cell => {
      let inside = null;
      try { inside = (activeAlertFeatures || []).find(a => a.geometry && typeof pointInPolygon === 'function' && pointInPolygon(cell.lat, cell.lng, a.geometry)); } catch (_) {}
      const where = inside ? String(inside.areaDesc || '').split(';')[0].trim()
        : `${Math.abs(cell.lat).toFixed(1)}°${cell.lat >= 0 ? 'N' : 'S'} ${Math.abs(cell.lng).toFixed(1)}°${cell.lng >= 0 ? 'E' : 'W'}`;
      return { ...cell, title: cell.label, where };
    }));
    const ref = S.lat != null ? L.latLng(S.lat, S.lng) : map.getCenter();
    list.forEach(s => { s.d = ref.distanceTo([s.lat, s.lng]); });
    list.sort((a, b) => a.rank - b.rank || a.d - b.d);
    // Drop near-duplicates (a warning and the cell inside it)
    const out = [];
    list.forEach(s => { if (!out.some(o => L.latLng(o.lat, o.lng).distanceTo([s.lat, s.lng]) < 15000)) out.push(s); });
    S.storms = out; S.stormsAt = Date.now(); S.stormIdx = -1;
    return out;
  }
  function jumpStorm(step) {
    const list = stormList(false);
    if (!list.length) { if (typeof showToast === 'function') showToast('No severe storms or warnings right now'); return; }
    S.stormIdx = (S.stormIdx + step + list.length) % list.length;
    const s = list[S.stormIdx];
    // Always bring the storm into view, close enough to see what it is
    map.setView([s.lat, s.lng], Math.max(map.getZoom(), 8), { animate: false });
    flash(s);
    moveTo(s.lat, s.lng, s.label, { title: s.title || s.label, where: s.where || '', idx: S.stormIdx + 1, n: list.length });
  }

  // ── TV: dim when idle, hints, keys ────────────────────────────────────────
  function wake() {
    if (!S.card) return;
    S.card.classList.remove('dim');
    clearTimeout(S.idleTimer);
    if (TV) S.idleTimer = setTimeout(() => { if (S.on) S.card.classList.add('dim'); }, 20000);
  }
  function tvHint() {
    if (!TV || typeof showToast !== 'function') return;
    showToast(/Xbox/i.test(navigator.userAgent)
      ? 'Hodograph: point at a storm, press A (or click the right stick) · LT/RT storm to storm · RB/LB zoom · B closes'
      : 'Hodograph: point at a storm and press OK · RED/GREEN storm to storm · CH ▲▼ zoom · BACK closes');
  }
  // TV: close the Layers panel and put the remote on the map, pointer showing
  function tvToMap() {
    try { if (typeof toggleLayerPanel === 'function') toggleLayerPanel(false); } catch (_) {}
    if (WTV_TV.focusEl) WTV_TV.focusEl(map.getContainer());
  }
  if (TV) {
    if (WTV_TV.onKey) WTV_TV.onKey((k, key) => {
      if (!S.on) return false;
      wake();
      if (k === 403 || k === 201 || key === 'ColorF0Red' || key === 'GamepadLeftTrigger') { jumpStorm(-1); return true; }
      if (k === 404 || k === 202 || key === 'ColorF1Green' || key === 'GamepadRightTrigger') { jumpStorm(1); return true; }
      // Right stick click: hodograph at the pointer
      if (k === 210 || key === 'GamepadRightThumbstick') { if (WTV_TV.pointerClick) WTV_TV.pointerClick(); return true; }
      return false;
    });
    // Back: Layers panel open → close it and go to the map; in the hodograph
    // panel → back to the map; on the map → close the hodograph
    WTV_TV.onBack(() => {
      if (!S.on) return false;
      const lp = document.getElementById('layer-panel');
      const cur = document.querySelector('.tv-focus');
      if ((lp && lp.classList.contains('open')) || (cur && S.card && S.card.contains(cur))) { tvToMap(); return true; }
      if (cur && !cur.classList.contains('leaflet-container')) return false;   // something else open: let it close
      close(); return true;
    });
  }

  // ── Map hooks: right-click / long-press, H key, TV pointer clicks ─────────
  map.on('contextmenu', (e) => {
    if (TV) return;
    L.popup({ maxWidth: 220, className: 'hodo-ctx' }).setLatLng(e.latlng)
      .setContent(`<button class="hodo-btn" style="margin:0" onclick="WTV_HODO.openAt(${e.latlng.lat.toFixed(4)},${e.latlng.lng.toFixed(4)})">🌀 Hodograph here</button>`)
      .openOn(map);
  });
  map.on('mousemove', (e) => { S.mouse = e.latlng; });
  document.addEventListener('keydown', (e) => {
    if (TV || e.ctrlKey || e.metaKey || e.altKey || (e.key !== 'h' && e.key !== 'H')) return;
    const t = document.activeElement && document.activeElement.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || (document.activeElement && document.activeElement.isContentEditable)) return;
    const p = S.mouse || map.getCenter();
    if (S.on && e.key === 'H') { close(); return; }
    openAt(p.lat, p.lng);
  });
  // On TV the pointer can't drag the crosshair: OK on the map moves it there
  map.on('click', (e) => { if (TV && S.on) moveTo(e.latlng.lat, e.latlng.lng, ''); });

  // One-time tip the first time someone opens a popup with the new button
  map.on('popupopen', (e) => {
    let seen = false; try { seen = localStorage.getItem('wtv-hodo-tip') === '1'; } catch (_) {}
    if (seen) return;
    const el = e.popup && e.popup.getElement && e.popup.getElement();
    if (!el || !el.querySelector('.hodo-env')) return;
    try { localStorage.setItem('wtv-hodo-tip', '1'); } catch (_) {}
    if (typeof showToast === 'function') {
      showToast('New: 🌀 Storm environment shows a 3D hodograph of the winds feeding this storm');
      try { clearTimeout(_toastTimer); _toastTimer = setTimeout(() => { const t = document.getElementById('wtv-toast'); if (t) t.style.display = 'none'; }, 7000); } catch (_) {}
    }
  });

  // Button HTML for popups (warnings, storm cells)
  function button(lat, lng, label) {
    const l = String(label || '').replace(/['"<>\\]/g, '');
    return `<button class="hodo-btn hodo-env" onclick="WTV_HODO.openAt(${(+lat).toFixed(4)},${(+lng).toFixed(4)},'${l}')">🌀 Storm environment</button>`;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 3D view — plain canvas, our own little projection
  //   ground plane: u (east, kt) → x, v (north, kt) → y; height (km) → z
  //   camera: yaw (turn) and elevation (90° = straight down)
  // ═════════════════════════════════════════════════════════════════════════
  const view = (() => {
    let cv, ctx, stage, W = 0, H = 0, dpr = 1;
    let d = null, R = 40;                       // data, outer ring (kt)
    let yaw = -0.35, elev = Math.PI / 2, lift = 0, grow = 1;
    let target = { elev: 0.42, lift: 1 }, raf = 0, t0 = 0, lastUser = 0, introAt = 0, introWaiting = false;
    const deg = Math.PI / 180;

    function attach(canvas, st) {
      cv = canvas; stage = st; ctx = cv.getContext('2d');
      const ro = window.ResizeObserver ? new ResizeObserver(size) : null;
      if (ro) ro.observe(stage); else window.addEventListener('resize', size);
      size();
      // Drag to turn (left/right) and tilt (up/down)
      let drag = null;
      stage.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, yaw, elev, panY: getComputedStyle(stage).touchAction === 'pan-y' }; stage.setPointerCapture(e.pointerId); stage.style.cursor = 'grabbing'; });
      stage.addEventListener('pointermove', (e) => {
        if (!drag) return;
        yaw = drag.yaw + (e.clientX - drag.x) * 0.01;
        if (!S.flat && !(e.pointerType === 'touch' && drag.panY)) elev = Math.max(8 * deg, Math.min(90 * deg, drag.elev + (e.clientY - drag.y) * 0.008));
        lastUser = performance.now(); kick();
      });
      const end = () => { drag = null; stage.style.cursor = 'grab'; lastUser = performance.now(); };
      stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
      stage.addEventListener('dblclick', () => { S.flat = !S.flat; setFlat(S.flat); const b = S.card.querySelector('[data-act="flat"]'); if (b) b.textContent = S.flat ? '3D' : '2D'; });
    }
    function size() {
      if (!stage) return;
      const r = stage.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = Math.max(50, r.width); H = Math.max(50, r.height);
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      draw();
    }
    function setData(nd) {
      d = nd;
      const maxKt = Math.max(20, ...d.points.map(p => Math.hypot(p.u, p.v)), d.rm ? d.rm.kt : 0);
      R = Math.ceil(maxKt / 20) * 20;
      if (introWaiting) { introWaiting = false; introAt = performance.now(); }   // the show starts when the data arrives
      kick();
    }
    function intro() {
      introAt = performance.now();
      if (REDUCED || S.flat) { elev = S.flat ? 90 * deg : 32 * deg; lift = S.flat ? 0 : 1; grow = 1; return; }
      elev = 90 * deg; lift = 0; grow = 0; yaw = -0.35; target = { elev: 0.42, lift: 1 };
      introWaiting = true;
      kick();
    }
    function setFlat(f) { target = f ? { elev: 90 * deg, lift: 0 } : { elev: 0.42, lift: 1 }; if (REDUCED) { elev = target.elev; lift = target.lift; draw(); } kick(); }
    function stop() { cancelAnimationFrame(raf); raf = 0; }
    function kick() { if (!raf) { t0 = performance.now(); raf = requestAnimationFrame(tick); } }

    function tick(now) {
      raf = 0;
      if (!S.on || !d) { draw(); return; }
      const dt = Math.min(0.05, (now - t0) / 1000); t0 = now;
      const since = (now - introAt) / 1000;
      let moving = false;
      if (grow < 1) { grow = Math.min(1, since / 0.9); moving = true; }                     // 1. draw the flat curve
      else if (since > 1.1) {                                                                  // 2. lift into 3D
        const k = 1 - Math.pow(0.02, dt);
        const de = target.elev - elev, dl = target.lift - lift;
        if (Math.abs(de) > 0.002 || Math.abs(dl) > 0.002) { elev += de * k * 1.6; lift += dl * k * 1.6; moving = true; }
        else { elev = target.elev; lift = target.lift; }
      }
      // 3. slow turn (after the lift; pauses a few seconds after you touch it)
      if (!REDUCED && !S.flat && since > 2.4 && now - lastUser > 6000) { yaw += dt * (TV ? 0.16 : 0.22); moving = true; }
      if (since < 2.6) moving = true;                                                        // keep going between the steps
      draw();
      if (moving && !document.hidden) raf = requestAnimationFrame(tick);
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.on) kick(); });

    // world (x, y, z in kt-units) -> screen
    function P(x, y, z) {
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const xr = x * cy - y * sy, yr = x * sy + y * cy;
      const se = Math.sin(elev), ce = Math.cos(elev);
      const depth = yr * ce - z * se;
      const sx = xr, syy = -(yr * se) - z * ce;
      const D = R * 4.5, f = D / (D + depth);
      const scale = (Math.min(W, H) * 0.42) / R;
      return [W / 2 + sx * f * scale, H * (0.5 + 0.12 * Math.cos(elev) * lift) + syy * f * scale, f];
    }
    const zOf = (h) => (h / 1000) / 10 * R * 0.95 * lift;     // 10 km tall ≈ the outer ring

    function draw() {
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      // Rings & axes on the ground
      ctx.lineWidth = 1.2;
      for (let r = 10; r <= R; r += 10) {
        ctx.beginPath();
        for (let a = 0; a <= 64; a++) { const t = a / 64 * Math.PI * 2; const [x, y] = P(r * Math.cos(t), r * Math.sin(t), 0); a ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.setLineDash(r % 20 === 0 ? [3, 4] : [1, 5]);
        ctx.strokeStyle = r % 20 === 0 ? 'rgba(220,225,240,.55)' : 'rgba(220,225,240,.22)';
        ctx.stroke();
        if (r % 20 === 0) { const [lx, ly] = P(r * 0.71, -r * 0.71, 0); ctx.setLineDash([]); ctx.fillStyle = 'rgba(200,210,230,.6)'; ctx.font = `${TV ? 13 : 10}px Barlow, sans-serif`; ctx.fillText(r + ' kt', lx + 3, ly); }
      }
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(230,235,245,.55)';
      [[-R, 0, R, 0], [0, -R, 0, R]].forEach(([a, b, c, e]) => { const p1 = P(a, b, 0), p2 = P(c, e, 0); ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke(); });
      ctx.fillStyle = 'rgba(200,210,230,.7)'; ctx.font = `600 ${TV ? 14 : 11}px Barlow Condensed, sans-serif`;
      [['N', 0, R * 1.08], ['E', R * 1.08, 0], ['S', 0, -R * 1.08], ['W', -R * 1.08, 0]].forEach(([t, x, y]) => { const [px, py] = P(x, y, 0); ctx.fillText(t, px - 4, py + 4); });
      if (!d) return;
      const pts = d.points.filter(p => p.h <= 10000);
      const n = Math.max(2, Math.round(pts.length * grow));
      const vis = pts.slice(0, n);
      // Height mast at the origin (only when tilted)
      if (lift > 0.05) {
        const top = P(0, 0, zOf(10000));
        const o = P(0, 0, 0);
        ctx.strokeStyle = `rgba(200,210,230,${0.35 * lift})`; ctx.beginPath(); ctx.moveTo(o[0], o[1]); ctx.lineTo(top[0], top[1]); ctx.stroke();
        ctx.fillStyle = `rgba(200,210,230,${0.7 * lift})`; ctx.font = `${TV ? 12 : 9}px Barlow, sans-serif`;
        [3000, 6000, 9000].forEach(h => { const q = P(0, 0, zOf(h)); ctx.fillText(h / 1000 + ' km', q[0] + 4, q[1] + 3); });
      }
      // Low-level inflow: the area between the storm motion and the 0–1 km winds (what 0–1 km SRH measures)
      if (d.rm) {
        const low = vis.filter(p => p.h <= 1000);
        if (low.length > 1) {
          ctx.beginPath();
          const s0 = P(d.rm.u, d.rm.v, 0); ctx.moveTo(s0[0], s0[1]);
          low.forEach(p => { const q = P(p.u, p.v, 0); ctx.lineTo(q[0], q[1]); });
          ctx.closePath(); ctx.fillStyle = 'rgba(32,201,201,.30)'; ctx.fill();
        }
      }
      // Wind arrows from the origin (ground-relative winds, 1 km apart)
      if (S.arrows) {
        vis.filter(p => p.h % 1000 === 0).forEach(p => {
          const o = P(0, 0, zOf(p.h)), q = P(p.u, p.v, zOf(p.h));
          ctx.strokeStyle = 'rgba(80,220,120,.75)'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(o[0], o[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
          const a = Math.atan2(q[1] - o[1], q[0] - o[0]);
          ctx.beginPath(); ctx.moveTo(q[0], q[1]); ctx.lineTo(q[0] - 7 * Math.cos(a - .4), q[1] - 7 * Math.sin(a - .4)); ctx.lineTo(q[0] - 7 * Math.cos(a + .4), q[1] - 7 * Math.sin(a + .4)); ctx.closePath(); ctx.fillStyle = 'rgba(80,220,120,.85)'; ctx.fill();
        });
      }
      // Shadow on the ground (the flat hodograph) once the curve has lifted
      if (lift > 0.02) {
        vis.forEach(p => { const q = P(p.u, p.v, 0); ctx.fillStyle = bandColor(p.h / 1000); ctx.globalAlpha = 0.8 * lift; ctx.beginPath(); ctx.arc(q[0], q[1], (TV ? 3.4 : 2.6) * q[2], 0, Math.PI * 2); ctx.fill(); });
        ctx.globalAlpha = 1;
        // stems every km, ground to curve
        ctx.lineWidth = 1;
        vis.filter(p => p.h % 1000 === 0 && p.h > 0).forEach(p => { const a = P(p.u, p.v, 0), b = P(p.u, p.v, zOf(p.h)); ctx.strokeStyle = `rgba(255,255,255,${0.12 * lift})`; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); });
      }
      // Storm motion markers on the ground
      const mark = (v, color, txt, square) => {
        if (!v) return; const [x, y] = P(v.u, v.v, 0);
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
        if (square) ctx.rect(x - 4, y - 4, 8, 8); else ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.stroke(); ctx.fillStyle = color; ctx.font = `700 ${TV ? 13 : 10}px Barlow Condensed, sans-serif`; ctx.fillText(txt, x + 7, y + 4);
      };
      mark(d.rm, '#ff6b6b', 'RM'); mark(d.lm, '#6bb8ff', 'LM'); mark(d.mean, '#c8a070', 'MEAN', true);
      // The hodograph itself, glowing, colored by height
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i < vis.length; i++) {
          const a = vis[i - 1], b = vis[i];
          const pa = P(a.u, a.v, zOf(a.h)), pb = P(b.u, b.v, zOf(b.h));
          ctx.strokeStyle = bandColor(b.h / 1000);
          ctx.lineWidth = (pass ? (TV ? 3.6 : 2.8) : (TV ? 9 : 7)) * pb[2];
          ctx.globalAlpha = pass ? 1 : 0.22;
          ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      // Height labels on the curve
      ctx.font = `700 ${TV ? 13 : 10}px Barlow Condensed, sans-serif`;
      [1000, 3000, 6000, 9000].forEach(h => {
        const p = vis.find(x => x.h === h); if (!p) return;
        const [x, y] = P(p.u, p.v, zOf(p.h));
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillText(h / 1000, x + 5, y - 4);
      });
      // Origin
      const o = P(0, 0, 0); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(o[0], o[1], 3.5, 0, Math.PI * 2); ctx.fill();
    }
    return { attach, setData, intro, setFlat, stop, draw };
  })();

  window.WTV_HODO = { setMode, openAt, close, button, active: () => S.on };
})();
