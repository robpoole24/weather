// WeatherTV — free cursor for the Xbox app — updated 2026-11-28T01:10:00Z build.1795914000
//
// A mouse-style cursor that goes anywhere on the screen, so a controller can
// do what a mouse does: point at any button, click the radar, open menus.
//
//   Left stick / D-pad → move the cursor (faster the longer you hold)
//   A on a scroll bar → grab it: the bar follows the cursor up and down; A or B lets go
//   A                 → click what's under it (the radar opens a hodograph, a
//                       text box opens the Xbox keyboard, a list opens a picker)
//   Right stick       → scroll whatever is under it (About, Help, lists…)
//   RB / LB           → over a map: zoom in/out around the cursor; elsewhere:
//                       a page down/up
//   Right stick click → same as A
//   B                 → back (closes what's open, top-most first)
//   X                 → switch between the cursor and the old highlight
//                       (main screen; the guide keeps X for its block list)
//
// On by default in the Xbox app (WeatherTVXbox in the user agent). ?cursor=1
// turns it on in any browser for testing (arrows, Enter, Escape, +/-).
//
// Runs in the top page and draws the cursor there. Pages inside it (the
// radar frame) load this file too and only pass their keys up to the top page.
(function () {
  'use strict';
  if (window.WTV_CURSOR) return;
  const ua = navigator.userAgent || '';
  const params = new URLSearchParams(location.search);
  const XBOX_APP = /WeatherTVXbox/.test(ua);
  const TEST = params.get('cursor') === '1';
  let topWin = null; try { topWin = window.top; void topWin.document; } catch (_) { topWin = null; }
  const isTop = window === window.top;

  // ── Inside a frame: hand the keys to the top page's cursor ────────────────
  if (!isTop) {
    window.WTV_CURSOR = { relay: true };
    const topC = () => { try { const C = topWin && topWin.WTV_CURSOR; return C && C.handleKey ? C : null; } catch (_) { return null; } };
    window.addEventListener('keydown', (e) => {
      const C = topC();
      if (C && C.handleKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    return;
  }
  if (!XBOX_APP && !TEST) { window.WTV_CURSOR = { on: false, handleKey: () => false }; return; }

  // ── State ─────────────────────────────────────────────────────────────────
  const C = { on: false, x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2), el: null, hover: null, hot: null, wakeT: 0 };
  window.WTV_CURSOR = C;
  try { const s = JSON.parse(sessionStorage.getItem('wtvCursorAt') || 'null'); if (s && s.x >= 0 && s.y >= 0) { C.x = Math.min(innerWidth - 4, s.x); C.y = Math.min(innerHeight - 4, s.y); } } catch (_) {}
  let saved = null; try { saved = localStorage.getItem('wtvCursor'); } catch (_) {}
  const hasTV = (w) => { try { return !!(w && w.WTV_TV && w.WTV_TV.active !== undefined); } catch (_) { return false; } };

  // ── Drawing ───────────────────────────────────────────────────────────────
  const CSS = '#wtv-cursor{position:fixed;left:0;top:0;width:40px;height:40px;margin:-3px 0 0 -4px;z-index:2147483647;pointer-events:none;display:none;transition:opacity .4s;filter:drop-shadow(0 2px 3px rgba(0,0,0,.7))}'
    + '#wtv-cursor.idle{opacity:0}#wtv-cursor .hand{display:none}#wtv-cursor.hot .arrow{display:none}#wtv-cursor.hot .hand{display:block}'
    + '.wtvc-hot{outline:3px solid #ffd000!important;outline-offset:2px!important}'
    + 'html.wtv-free-cursor .tv-focus{outline:none!important;box-shadow:none!important}'
    + '#wtv-cursor-tip{position:fixed;left:50%;bottom:6%;transform:translateX(-50%);z-index:2147483646;background:rgba(0,0,0,.88);color:#fff;font:600 18px/1.35 system-ui,sans-serif;padding:12px 20px;border-radius:10px;border:1px solid #ffd000;max-width:80%;text-align:center;pointer-events:none;display:none}';
  function styleIn(doc) {
    try { if (!doc.getElementById('wtv-cursor-css')) { const st = doc.createElement('style'); st.id = 'wtv-cursor-css'; st.textContent = CSS; (doc.head || doc.documentElement).appendChild(st); } } catch (_) {}
  }
  function draw() {
    if (!C.el) {
      styleIn(document);
      C.el = document.createElement('div'); C.el.id = 'wtv-cursor'; C.el.setAttribute('aria-hidden', 'true');
      C.el.innerHTML = '<svg class="arrow" viewBox="0 0 32 32" width="40" height="40"><path d="M3 2 L3 26 L9.5 20 L14 30 L18.5 28 L14 18.5 L23 18.5 Z" fill="#ffd000" stroke="#000" stroke-width="2" stroke-linejoin="round"/></svg>'
        + '<svg class="hand" viewBox="0 0 32 32" width="40" height="40"><path d="M11 3.5c1.4 0 2.5 1.1 2.5 2.5v8.2l.6-.1c.3-1.2 1.3-2 2.5-2 1.3 0 2.3.9 2.5 2.1.4-.5 1.1-.8 1.9-.8 1.3 0 2.4 1 2.5 2.3.4-.3.9-.4 1.4-.4 1.4 0 2.5 1.1 2.5 2.5v5.2c0 4.6-3.5 8.5-8.5 8.5h-2c-2.6 0-4.7-1.2-6.2-3.3l-4.6-6.6c-.8-1.1-.5-2.6.6-3.4 1-.7 2.4-.5 3.2.4l.6.7V6c0-1.4 1.1-2.5 2.5-2.5z" fill="#ffd000" stroke="#000" stroke-width="1.8" stroke-linejoin="round"/></svg>';
      (document.body || document.documentElement).appendChild(C.el);
    }
    C.el.style.transform = 'translate(' + C.x + 'px,' + C.y + 'px)';
  }
  // The cursor fades away when it's left alone (it shouldn't sit on a stream)
  function wake() {
    if (!C.el) return;
    C.el.classList.remove('idle');
    clearTimeout(C.wakeT); C.wakeT = setTimeout(() => { if (C.el) C.el.classList.add('idle'); }, 5000);
  }
  let tipT = 0;
  function tip(text, ms) {
    styleIn(document);
    let t = document.getElementById('wtv-cursor-tip');
    if (!t) { t = document.createElement('div'); t.id = 'wtv-cursor-tip'; (document.body || document.documentElement).appendChild(t); }
    t.textContent = text; t.style.display = 'block';
    clearTimeout(tipT); tipT = setTimeout(() => { t.style.display = 'none'; }, ms || 5000);
  }

  // ── What's under the cursor, looking inside same-site frames ──────────────
  function deepAt(x, y) {
    let win = window, doc = document, lx = x, ly = y, el = null;
    for (let i = 0; i < 6; i++) {
      el = doc.elementFromPoint(lx, ly);
      if (!el) return null;
      if (el.tagName !== 'IFRAME') break;
      let cd = null; try { cd = el.contentDocument; } catch (_) {}
      if (!cd || !cd.documentElement) break;                                // another site's frame: stop at it
      const r = el.getBoundingClientRect();
      lx -= r.left + el.clientLeft; ly -= r.top + el.clientTop;
      win = el.contentWindow; doc = cd;
    }
    return { el, win, doc, x: lx, y: ly };
  }
  const HOT = '.leaflet-interactive, .leaflet-marker-icon, a[href], button, [role="button"], [role="tab"], [role="option"], [onclick], .lp-row, select, input, textarea, label, summary, [tabindex]:not([tabindex="-1"])';
  function hotOf(el, win) {
    if (!el || !el.closest) return null;
    const h = el.closest(HOT);
    if (h && !h.classList.contains('leaflet-container')) return h;
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 5; n = n.parentElement, i++) {   // plain boxes with a click handler
      if (n.classList && n.classList.contains('leaflet-container')) break;
      try { if (win.getComputedStyle(n).cursor === 'pointer') return n; } catch (_) { break; }
    }
    return null;
  }
  // The thing a click would hit. Small dots on the map get a little help: a near miss counts.
  function target() {
    const d = deepAt(C.x, C.y); if (!d) return null;
    d.hot = hotOf(d.el, d.win);
    if (d.hot) return d;
    let best = null, bestD = 22;
    try {
      d.doc.querySelectorAll('.leaflet-marker-icon').forEach(mk => {
        if (mk.style.display === 'none') return;
        const r = mk.getBoundingClientRect(); if (r.width < 1) return;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2, dist = Math.hypot(cx - d.x, cy - d.y);
        if (dist < bestD) { bestD = dist; best = { el: d.doc.elementFromPoint(cx, cy) || mk, win: d.win, doc: d.doc, x: cx, y: cy, hot: mk }; }
      });
    } catch (_) {}
    return best || d;
  }
  function fire(t, type, related) {
    try {
      const ME = t.win.MouseEvent || MouseEvent;
      t.el.dispatchEvent(new ME(type, { bubbles: true, cancelable: true, view: t.win, clientX: t.x, clientY: t.y, screenX: t.x, screenY: t.y,
        button: 0, buttons: type === 'mousedown' ? 1 : 0, relatedTarget: related || null }));
    } catch (_) {}
  }
  function hover() {
    const t = target();
    const el = t && t.el;
    if (el !== C.hover) {
      if (C.hover && C.hover.isConnected) { try { const w = C.hover.ownerDocument.defaultView; C.hover.dispatchEvent(new w.MouseEvent('mouseout', { bubbles: true, view: w, clientX: t ? t.x : 0, clientY: t ? t.y : 0, relatedTarget: el || null })); } catch (_) {} }
      if (t) fire(t, 'mouseover', C.hover);
      C.hover = el;
    }
    if (t) fire(t, 'mousemove');
    // Show what's clickable: a hand, and an outline on buttons and links
    let ring = t && t.hot;
    if (ring) {
      const r = ring.getBoundingClientRect(), vw = t.win.innerWidth, vh = t.win.innerHeight;
      if (ring.namespaceURI === 'http://www.w3.org/2000/svg' || ring.classList.contains('leaflet-marker-icon') || r.width * r.height > vw * vh * 0.35) ring = null;
    }
    if (ring !== C.hot) {
      if (C.hot) C.hot.classList.remove('wtvc-hot');
      if (ring) { styleIn(ring.ownerDocument); ring.classList.add('wtvc-hot'); }
      C.hot = ring;
    }
    if (C.el) C.el.classList.toggle('hot', !!(t && t.hot));
  }

  // ── Moving ────────────────────────────────────────────────────────────────
  function mapAt(x, y) {
    const d = deepAt(x, y); if (!d || !d.el.closest) return null;
    const box = d.el.closest('.leaflet-container'); if (!box) return null;
    let m = null; try { m = d.win.WTV_TV && d.win.WTV_TV.mapFor ? d.win.WTV_TV.mapFor(box) : null; } catch (_) {}
    return m ? { m, d } : null;
  }
  function shift(dx, dy) {
    const W = innerWidth - 3, H = innerHeight - 3;
    let nx = C.x + dx, ny = C.y + dy, px = 0, py = 0;
    if (nx < 2) { px = nx - 2; nx = 2; } if (nx > W) { px = nx - W; nx = W; }
    if (ny < 2) { py = ny - 2; ny = 2; } if (ny > H) { py = ny - H; ny = H; }
    if (C.grab) { grabMove(nx, ny); return; }
    C.x = nx; C.y = ny; draw(); wake();
    if (px || py) { const ma = mapAt(C.x, C.y); if (ma) { try { ma.m.panBy([px * 2.5, py * 2.5], { animate: false }); } catch (_) {} } }   // pushed past the edge over a map: move the map
    clearTimeout(shift.save); shift.save = setTimeout(() => { try { sessionStorage.setItem('wtvCursorAt', JSON.stringify({ x: Math.round(C.x), y: Math.round(C.y) })); } catch (_) {} }, 400);
  }
  // A tap nudges it; holding glides it and speeds up the longer you hold
  // (the controller only says "still held" by repeating the press).
  const glide = { dirs: {}, raf: 0, start: 0, last: 0, hoverAt: 0 };
  function glideFrame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - (glide.last || now)) / 1000); glide.last = now;
    let vx = 0, vy = 0, any = false;
    for (const dir in glide.dirs) {
      const d = glide.dirs[dir];
      if (now - d.at > d.wait) { delete glide.dirs[dir]; continue; }
      if (!d.repeating) continue;
      any = true;
      if (dir === 'left') vx -= 1; if (dir === 'right') vx += 1; if (dir === 'up') vy -= 1; if (dir === 'down') vy += 1;
    }
    if (!Object.keys(glide.dirs).length || !C.on) { glide.raf = 0; glide.last = 0; hover(); return; }
    if (any) {
      const held = (now - glide.start) / 1000;
      const speed = Math.min(1000, 260 + held * 520);                  // px per second
      const len = Math.hypot(vx, vy) || 1;
      shift(vx / len * speed * dt, vy / len * speed * dt);
      if (now - glide.hoverAt > 70) { glide.hoverAt = now; hover(); }
    }
    glide.raf = requestAnimationFrame(glideFrame);
  }
  function move(dir) {
    const now = performance.now();
    const d = glide.dirs[dir];
    if (d && now - d.at < 900) {
      const gap = now - d.at;
      d.repeating = true; d.wait = Math.min(450, Math.max(170, gap * 1.8)); d.at = now;
    } else {
      if (!Object.keys(glide.dirs).length) glide.start = now;
      glide.dirs[dir] = { at: now, wait: 900, repeating: false };
      const hop = 16;
      shift({ left: -hop, right: hop }[dir] || 0, { up: -hop, down: hop }[dir] || 0);
      hover();
    }
    if (!glide.raf) { glide.last = 0; glide.raf = requestAnimationFrame(glideFrame); }
  }
  // Where the browser can read the stick itself, use it: push a little to creep, all the way to fly
  let padAt = 0, padRaf = 0, padLast = 0, padHoverAt = 0;
  function padPoll() {
    padRaf = 0;
    if (!C.on) return;
    let gp = null;
    try { gp = [...(navigator.getGamepads ? navigator.getGamepads() : [])].find(g => g && g.connected && g.axes && g.axes.length >= 2); } catch (_) {}
    if (!gp) { padLast = 0; setTimeout(() => { if (!padRaf) padRaf = requestAnimationFrame(padPoll); }, 600); return; }
    const now = performance.now(), dt = Math.min(0.05, (now - (padLast || now)) / 1000); padLast = now;
    const ax = gp.axes[0], ay = gp.axes[1], mag = Math.hypot(ax, ay);
    if (mag > 0.2) {
      padAt = now;
      const k = (Math.min(1, (mag - 0.2) / 0.8)) ** 2;
      shift(ax / mag * k * 1100 * dt, ay / mag * k * 1100 * dt);
      if (now - padHoverAt > 70) { padHoverAt = now; hover(); }
    }
    padRaf = requestAnimationFrame(padPoll);
  }

  // ── Scrolling ─────────────────────────────────────────────────────────────
  function canScrollEl(n, win) {
    if (!n || n.nodeType !== 1 || (n.classList && n.classList.contains('leaflet-container'))) return false;
    const doc = n.ownerDocument;
    if (n === doc.documentElement || n === doc.body) {
      const se = doc.scrollingElement || doc.documentElement;
      try { if (/hidden|clip/.test(win.getComputedStyle(doc.body).overflowY) && /hidden|clip/.test(win.getComputedStyle(doc.documentElement).overflowY)) return false; } catch (_) {}
      return se.scrollHeight - win.innerHeight > 4;
    }
    if (n.scrollHeight - n.clientHeight < 6) return false;
    try { return /(auto|scroll|overlay)/.test(win.getComputedStyle(n).overflowY); } catch (_) { return false; }
  }
  const pageEl = (n) => (n === n.ownerDocument.body || n === n.ownerDocument.documentElement) ? (n.ownerDocument.scrollingElement || n.ownerDocument.documentElement) : n;
  // The scrolling box under the cursor; if there's none, the biggest one on screen that isn't covered
  let bigCache = { t: 0, el: null };
  function biggest() {
    const now = performance.now();
    if (now - bigCache.t < 500 && bigCache.el && bigCache.el.isConnected) return bigCache.el;
    let win = null, area = 0;
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    for (let i = 0; i < all.length && i < 6000; i++) {
      const el = all[i];
      if (el.scrollHeight - el.clientHeight < 6 || !canScrollEl(el, window)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 60 || r.bottom < 0 || r.top > innerHeight) continue;
      const mid = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)));
      if (!mid || !(el === mid || el.contains(mid))) continue;          // under something else
      if (r.width * r.height > area) { area = r.width * r.height; win = el; }
    }
    bigCache = { t: now, el: win };
    return win;
  }
  function scrollerAtCursor(noFallback) {
    const d = deepAt(C.x, C.y);
    if (d) {
      let el = d.el, win = d.win;
      for (let hop = 0; hop < 6 && el; hop++) {
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          if (n.classList && n.classList.contains('leaflet-container')) return null;   // over a map: the stick doesn't scroll something else
          if (canScrollEl(n, win)) return pageEl(n);
        }
        if (win === window) break;
        let fe = null; try { fe = win.frameElement; } catch (_) {}
        if (!fe) break;
        el = fe.parentElement; win = fe.ownerDocument.defaultView;      // up out of the frame
      }
    }
    return noFallback ? null : biggest();
  }
  C.scrollBy = (dy) => {
    const sc = scrollerAtCursor();
    if (!sc) return false;
    sc.scrollTop += dy; bigCache.t = 0;
    clearTimeout(C.scrollHover); C.scrollHover = setTimeout(hover, 80);
    return true;
  };
  // The Xbox app calls WTV_TV.stick(v) ~30×/s with the right stick (v = -1…1)
  C.stick = (v) => { if (Math.abs(v) < 0.15) return; C.scrollBy(Math.sign(v) * ((Math.abs(v) - 0.15) / 0.85) ** 1.5 * 42); };
  C.move = (dx, dy) => { if (C.on) { shift(dx, dy); hover(); } };     // for a later app that sends the left stick directly

  // ── Scroll bars: A grabs the bar, it then follows the cursor, A or B lets go ──
  // (works on the page and inside the radar frame; positions are in the top page)
  function offsetOf(win) {
    let x = 0, y = 0;
    for (let w = win; w && w !== window; ) {
      let fe = null; try { fe = w.frameElement; } catch (_) {}
      if (!fe) break;
      const r = fe.getBoundingClientRect(); x += r.left + fe.clientLeft; y += r.top + fe.clientTop;
      w = fe.ownerDocument.defaultView;
    }
    return { x, y };
  }
  function boxOf(sc) {
    const doc = sc.ownerDocument, win = doc.defaultView, o = offsetOf(win);
    if (sc === doc.scrollingElement || sc === doc.documentElement || sc === doc.body)
      return { left: o.x, top: o.y, right: o.x + win.innerWidth, bottom: o.y + win.innerHeight, bar: Math.max(0, win.innerWidth - doc.documentElement.clientWidth) };
    const r = sc.getBoundingClientRect(), cs = win.getComputedStyle(sc);
    const bar = Math.max(0, sc.offsetWidth - sc.clientWidth - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0));
    return { left: r.left + o.x, top: r.top + o.y, right: r.right + o.x, bottom: r.bottom + o.y, bar };
  }
  function scrollbarAt(x, y) {
    for (const dx of [0, -12, 12]) {
      const saveX = C.x; C.x = x + dx;
      let sc = null; try { sc = scrollerAtCursor(true); } finally { C.x = saveX; }
      if (!sc) continue;
      const b = boxOf(sc), zone = Math.max(b.bar, 8) + 16;              // the bar, or the strip just inside it
      if (x >= b.right - zone && x <= b.right + 8 && y >= b.top && y <= b.bottom) return sc;
    }
    return null;
  }
  function grabTo(y) {
    const sc = C.grab; if (!sc || !sc.isConnected) return grabEnd();
    const b = boxOf(sc), track = b.bottom - b.top, total = sc.scrollHeight, view = sc.clientHeight || track;
    const thumb = Math.max(24, track * view / Math.max(1, total));
    const f = Math.max(0, Math.min(1, (y - b.top - thumb / 2) / Math.max(1, track - thumb)));
    sc.scrollTop = f * (total - view);
  }
  function grabMove(nx, ny) {
    const b = boxOf(C.grab);
    C.x = Math.min(b.right - 4, Math.max(b.right - 18, nx)); C.y = Math.max(b.top + 2, Math.min(b.bottom - 2, ny));
    draw(); wake(); grabTo(C.y);
  }
  function grabStart(sc) {
    C.grab = sc; if (C.el) C.el.classList.add('hot');
    tip('Scroll bar: move up/down to scroll · A or B to let go', 4000);
    grabMove(C.x, C.y);
  }
  function grabEnd() {
    C.grab = null;
    const t = document.getElementById('wtv-cursor-tip'); if (t) t.style.display = 'none';
    setTimeout(hover, 50);
    return true;
  }

  // ── Clicking ──────────────────────────────────────────────────────────────
  const isTextField = (el) => !!el && !el.disabled && !el.readOnly && (el.tagName === 'TEXTAREA'
    || (el.tagName === 'INPUT' && /^(text|search|url|email|tel|number|)$/i.test(el.getAttribute('type') || '')));
  function click() {
    wake();
    if (C.grab) { grabEnd(); return; }                                   // A again: let go of the bar
    const bar = scrollbarAt(C.x, C.y);
    if (bar) { grabStart(bar); return; }
    const t = target(); if (!t || !t.el) return;
    const el = t.el;
    const sel = el.closest && el.closest('select');
    if (sel && !sel.disabled) {
      if (t.win.WTV_TV && t.win.WTV_TV.openPicker) t.win.WTV_TV.openPicker(sel);
      else { const opts = [...sel.options].filter(o => !o.disabled && !o.hidden); const i = opts.indexOf(sel.selectedOptions[0]); if (opts.length) { sel.value = opts[(i + 1) % opts.length].value; sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); } }
      setTimeout(hover, 200); return;
    }
    if (XBOX_APP && isTextField(el) && !hasTV(t.win)) { askText(el); return; }   // pages without wtv-tv.js (the guide)
    fire(t, 'mousedown'); fire(t, 'mouseup'); fire(t, 'click');
    if (/^(INPUT|TEXTAREA)$/.test(el.tagName) && !XBOX_APP) { try { el.focus(); } catch (_) {} }
    setTimeout(hover, 250);
  }

  // ── Back: close the top-most open thing, in the radar frame or the page ───
  let lastBack = 0;
  function back() {
    if (Date.now() - lastBack < 350) return true;                      // one press can arrive twice on Xbox
    const topTV = window.WTV_TV;
    if (!topTV || !topTV.back) return false;                            // the guide: let it handle Back itself
    lastBack = Date.now();
    const frames = [];
    const under = deepAt(C.x, C.y);
    if (under && under.win !== window) frames.push(under.win);
    try {
      document.querySelectorAll('iframe').forEach(f => {
        try { const w = f.contentWindow; if (w && w.WTV_TV && w.WTV_TV.closeTop && f.getBoundingClientRect().width > 0 && frames.indexOf(w) < 0) frames.push(w); } catch (_) {}
      });
    } catch (_) {}
    for (const w of frames) { try { if (w.WTV_TV && w.WTV_TV.closeTop && w.WTV_TV.closeTop()) { setTimeout(hover, 250); return true; } } catch (_) {} }
    try { if (topTV.closeTop && topTV.closeTop()) { setTimeout(hover, 250); return true; } } catch (_) {}
    try { topTV.back(); } catch (_) {}
    setTimeout(hover, 250);
    return true;
  }

  // ── Zoom ──────────────────────────────────────────────────────────────────
  function zoom(dir) {
    const d = deepAt(C.x, C.y);
    if (d && d.el.closest && d.el.closest('.leaflet-container')) {
      try { if (d.win.WTV_TV && d.win.WTV_TV.zoomAt && d.win.WTV_TV.zoomAt(d.x, d.y, dir)) { wake(); return true; } } catch (_) {}
    }
    return false;
  }

  // ── On / off ──────────────────────────────────────────────────────────────
  let origCursorMode = null;
  function setOn(on, announce) {
    C.on = !!on;
    try { localStorage.setItem('wtvCursor', C.on ? '1' : '0'); } catch (_) {}
    document.documentElement.classList.toggle('wtv-free-cursor', C.on);
    draw(); C.el.style.display = C.on ? 'block' : 'none';
    if (C.on) { wake(); hover(); if (!padRaf) { padLast = 0; padRaf = requestAnimationFrame(padPoll); } }
    else { if (C.hot) { C.hot.classList.remove('wtvc-hot'); C.hot = null; } }
    // The highlight and the radar's own map pointer step aside while the cursor is on
    try { if (origCursorMode) origCursorMode(C.on, false); } catch (_) {}
    if (announce) tip(C.on ? 'Cursor on · stick moves it · A clicks · right stick scrolls · RB/LB zoom the map · X for the highlight'
      : 'Highlight on · the D-pad moves between buttons · X for the cursor', 5500);
    if (!C.on) { try { if (window.WTV_TV && window.WTV_TV.focusFirst) window.WTV_TV.focusFirst(); } catch (_) {} }
  }
  C.setOn = setOn;
  function hookTV() {
    const tv = window.WTV_TV;
    if (!tv || tv.__cursorHooked) return;
    tv.__cursorHooked = true;
    if (tv.cursorMode) {
      origCursorMode = tv.cursorMode;
      // The app's View button (system cursor) still calls this: a real "on" wins, an "off" is ignored
      tv.cursorMode = (on, announce) => {
        if (on) { C.on = false; if (C.el) C.el.style.display = 'none'; document.documentElement.classList.remove('wtv-free-cursor'); return origCursorMode(true, announce); }
        if (C.on) return;
        return origCursorMode(false, announce);
      };
    }
  }

  // ── Keys ──────────────────────────────────────────────────────────────────
  const DIRS = { ArrowLeft: 'left', ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down' };
  const DIRCODE = { 37: 'left', 38: 'up', 39: 'right', 40: 'down', 203: 'up', 204: 'down', 205: 'left', 206: 'right', 211: 'up', 212: 'down', 213: 'right', 214: 'left' };
  C.handleKey = (e) => {
    const key = e.key, k = e.keyCode || 0;
    const isX = key === 'GamepadX' || k === 197;
    // X on the main screen switches cursor ↔ highlight (the guide keeps X for itself)
    if (isX && hasTV(window)) { setOn(!C.on, true); return true; }
    if (!C.on) return false;
    const dir = DIRS[key] || DIRCODE[k];
    if (dir) {
      if (performance.now() - padAt < 250) return true;                // the stick is being read directly
      move(dir); return true;
    }
    if (key === 'GamepadA' || k === 195 || key === 'GamepadRightThumbstick' || k === 210 || (TEST && key === 'Enter' && e.isTrusted)) { click(); return true; }
    if (key === '+' || key === '-' || k === 199 || k === 200 || (TEST && (key === 'PageUp' || key === 'PageDown'))) {
      const dirZ = (key === '+' || k === 199 || key === 'PageDown') ? 1 : -1;
      if (zoom(dirZ)) return true;
      const sc = scrollerAtCursor();
      if (sc && hasTV(window)) { sc.scrollTop += dirZ * Math.max(60, sc.clientHeight * 0.85); setTimeout(hover, 120); return true; }
      return false;                                                     // the guide: RB/LB = next/previous block
    }
    if (key === 'GamepadB' || k === 196 || key === 'GoBack' || (TEST && key === 'Escape' && e.isTrusted)) { if (C.grab) { lastBack = Date.now(); return grabEnd(); } return back(); }
    return false;
  };
  window.addEventListener('keydown', (e) => {
    if (C.handleKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  // A real mouse (testing on a computer) moves our cursor too
  if (TEST) document.addEventListener('mousemove', (e) => { if (C.on && e.isTrusted) { C.x = e.clientX; C.y = e.clientY; draw(); wake(); } }, true);

  // The app sends key presses to whatever has focus: keep focus out of frames
  // that can't pass them up (another site's frame passes them up by itself).
  setInterval(() => {
    if (!C.on) return;
    const a = document.activeElement;
    if (!a || a.tagName !== 'IFRAME') return;
    let ok = true; try { const w = a.contentWindow; ok = !w.document || !!w.WTV_CURSOR; } catch (_) { ok = true; }
    if (!ok) { try { a.blur(); } catch (_) {} }
  }, 500);
  addEventListener('resize', () => { C.x = Math.min(C.x, innerWidth - 4); C.y = Math.min(C.y, innerHeight - 4); if (C.on) draw(); });

  // ── Pages without wtv-tv.js (the guide): the right stick, and typing ──────
  function lite() {
    if (window.WTV_TV) return;
    window.WTV_TV = { stick: (v) => C.stick(v), cursorMode: () => {} };
    if (!XBOX_APP) return;
    // The web page's text boxes can't take the Xbox keyboard: ask the app for its box
    const noKb = () => { try { document.querySelectorAll('input, textarea').forEach(i => { if (isTextField(i)) i.setAttribute('inputmode', 'none'); }); } catch (_) {} };
    noKb(); try { new MutationObserver(() => { clearTimeout(noKb.t); noKb.t = setTimeout(noKb, 400); }).observe(document.body, { childList: true, subtree: true }); } catch (_) {}
    document.addEventListener('focusin', (e) => {
      const el = e.target; if (!isTextField(el)) return;
      el.setAttribute('inputmode', 'none');
      if (Date.now() - lastAsk < 1500) { try { el.blur(); } catch (_) {} return; }
      if (Date.now() - (window.__wtvCommitAt || 0) > 1500) askText(el);
    }, true);
    window.__wtvTextCommit = function (v) {
      const el = window.__wtvTextTarget; window.__wtvTextTarget = null; window.__wtvAsking = null;
      window.__wtvCommitAt = Date.now();
      if (!el || !el.isConnected) return;
      try { el.focus(); } catch (_) {}
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (!String(v).trim()) return;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
      if (el.form) { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }
    };
    window.addEventListener('focus', () => {
      const el = window.__wtvAsking; if (!el) return;
      setTimeout(() => { if (window.__wtvAsking !== el) return; window.__wtvAsking = null; window.__wtvTextTarget = null; window.__wtvClosedAt = Date.now(); }, 250);
    });
  }
  let lastAsk = 0;
  function askText(el) {
    if (Date.now() - lastAsk < 700) return true;
    const wv = window.chrome && chrome.webview;
    if (!wv || !wv.postMessage) return false;
    if (Date.now() - (window.__wtvCommitAt || 0) < 1000 || Date.now() - (window.__wtvClosedAt || 0) < 1000) return true;
    lastAsk = Date.now();
    window.__wtvTextTarget = el; window.__wtvAsking = el;
    try { el.focus(); } catch (_) {}                                   // the page knows which box it is (e.g. the guide's search)
    setTimeout(() => { try { el.blur(); } catch (_) {} }, 30);
    wv.postMessage('wtv-text ' + JSON.stringify({ value: el.value || '', hint: el.getAttribute('aria-label') || el.placeholder || 'Type here', max: el.maxLength > 0 ? el.maxLength : 0 }));
    return true;
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  const start = () => {
    lite(); hookTV();
    const want = saved === null ? true : saved === '1';
    setOn(want, false);
    if (want) { try { if (!sessionStorage.getItem('wtvCursorTip2')) { sessionStorage.setItem('wtvCursorTip2', '1'); setTimeout(() => tip(hasTV(window) ? 'Cursor: stick moves it · A clicks · right stick scrolls · RB/LB zoom the map · X switches to the highlight' : 'Cursor: stick moves it · A clicks · right stick scrolls', 7000), 2500); } } catch (_) {} }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
