// WeatherTV — TV remote navigation (Samsung Tizen + other smart TVs) — build.1792143000
//
// Loaded by index.html and radar.html. Only switches on for TVs (or ?tv=1 for
// testing on a computer), so phones and desktops are unaffected.
//
//   Arrows   → move the highlight to the nearest control in that direction
//   OK/Enter → press it
//   Back     → close whatever is open on top; otherwise go back; at the home
//              screen, exit the app (Samsung requirement)
//   Map      → when the radar map is highlighted: arrows pan it, Channel ▲/▼
//              zoom, Back returns to the toolbar
//   ▶❚❚      → play/pause (radar loop, WeatherStar rotation)
//
// Pages can hook in:
//   WTV_TV.onBack(fn)   fn() returns true if it closed something
//   WTV_TV.onMedia(fn)  fn(action) — 'playpause' | 'play' | 'pause' | 'stop' | 'next' | 'prev'
//   data-tv-skip        on any element: never highlight it
//   data-tv-initial     on one element: where the highlight starts
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const ua = navigator.userAgent || '';
  const isTV = params.get('tv') === '1'
    || /Tizen|SMART-TV|SmartTV|SMARTTV|Web0S|WebOS|NetCast|HbbTV|BRAVIA|AFT[A-Z]|Android TV|GoogleTV|CrKey|Xbox/i.test(ua)
    || (window.parent !== window && (() => { try { return !!window.parent.WTV_TV && window.parent.WTV_TV.active; } catch (_) { return false; } })());
  const api = { active: isTV, onBack, onMedia, focusFirst };
  window.WTV_TV = api;
  if (!isTV) return;

  document.documentElement.classList.add('tv-mode');
  // Xbox: have the controller send key presses (D-pad, A, B…) instead of
  // driving a mouse cursor, so the same highlight navigation works.
  if (/Xbox/i.test(ua)) { try { navigator.gamepadInputEmulation = 'keyboard'; } catch (_) {} }
  // Xbox app: the web page's text boxes can't take typing from the Xbox
  // keyboard, so A on a text box asks the app for its own text box (where the
  // Xbox keyboard works) and the app hands the text back here.
  const XBOX_APP = /WeatherTVXbox/.test(ua);
  const isTextField = (el) => !!el && !el.disabled && !el.readOnly && (el.tagName === 'TEXTAREA'
    || (el.tagName === 'INPUT' && /^(text|search|url|email|tel|number|)$/i.test(el.getAttribute('type') || '')));
  let lastTextAsk = 0;
  function askText(el) {
    if (Date.now() - lastTextAsk < 700) return true;
    let top; try { top = window.top; void top.document.body; } catch (_) { return false; }
    const wv = top.chrome && top.chrome.webview;
    if (!wv || !wv.postMessage) return false;
    lastTextAsk = Date.now();
    top.__wtvTextTarget = el;
    try { el.blur(); } catch (_) {}
    wv.postMessage('wtv-text ' + JSON.stringify({
      value: el.value || '',
      hint: el.getAttribute('aria-label') || el.placeholder || 'Type here',
      max: el.maxLength > 0 ? el.maxLength : 0
    }));
    return true;
  }
  if (XBOX_APP) {
    // Keep the web view's own keyboard from popping up on top of ours
    document.addEventListener('focusin', (e) => { if (isTextField(e.target)) e.target.setAttribute('inputmode', 'none'); }, true);
    // Cursor mode: clicking a text box opens the app's text box too
    document.addEventListener('click', (e) => { if (isTextField(e.target)) askText(e.target); }, true);
    if (window === window.top) {
      // Called by the Xbox app with what was typed: fill the box and search
      window.__wtvTextCommit = function (v) {
        const el = window.__wtvTextTarget; window.__wtvTextTarget = null;
        if (!el || !el.isConnected) return;
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if (!String(v).trim()) return;
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
        if (el.form) {
          if (el.form.requestSubmit) el.form.requestSubmit();
          else el.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
      };
    }
  }
  // "In a frame" means OUR page framing us (the radar inside the main page).
  // An app shell from another origin (the Samsung TV wrapper) doesn't count:
  // we act as the top page and ask the shell to exit at the home screen.
  let sameOriginParent = false;
  try { sameOriginParent = window.parent !== window && !!window.parent.location.href; } catch (_) { sameOriginParent = false; }
  const inFrame = sameOriginParent;
  const inShell = window.parent !== window && !sameOriginParent;

  // Samsung: media / channel / color keys must be registered to be delivered
  try {
    if (window.tizen && tizen.tvinputdevice) {
      ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
       'ChannelUp', 'ChannelDown', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue']
        .forEach(k => { try { tizen.tvinputdevice.registerKey(k); } catch (_) {} });
    }
  } catch (_) {}

  // Big, high-contrast highlight you can see from the couch
  const style = document.createElement('style');
  style.textContent = `
    html.tv-mode :focus { outline: none; }
    html.tv-mode .tv-focus {
      outline: 4px solid #ffd000 !important; outline-offset: 3px !important;
      box-shadow: 0 0 0 7px rgba(255,208,0,0.28), 0 0 22px rgba(255,208,0,0.55) !important;
      position: relative; z-index: 5; transition: outline-color .1s;
    }
    html.tv-mode .leaflet-container.tv-focus { outline-offset: -6px !important; }
    html.tv-mode #tv-map-hint {
      position: fixed; left: 50%; bottom: 3.5rem; transform: translateX(-50%); z-index: 99999;
      background: rgba(0,0,0,0.82); color: #fff; font: 600 15px 'Barlow', system-ui, sans-serif;
      padding: 0.45rem 0.9rem; border-radius: 6px; border: 1px solid #ffd000; pointer-events: none;
    }`;
  document.head.appendChild(style);

  const backHandlers = [], mediaHandlers = [];
  function onBack(fn) { backHandlers.push(fn); }
  function onMedia(fn) { mediaHandlers.push(fn); }

  // ── What can be highlighted ───────────────────────────────────────────────
  const SELECTOR = 'a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"]), [onclick], .leaflet-container, iframe[data-tv-frame]';
  function visible(el) {
    if (el.hasAttribute('data-tv-skip') || el.closest('[data-tv-skip]') || el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const onScreen = (q) => q.bottom > 0 && q.right > 0 && q.top < innerHeight && q.left < innerWidth;
    if (!onScreen(r)) {
      // Off-screen is only OK inside a scrolling area that is itself on screen
      // (it scrolls into view). A panel slid off-screen when closed doesn't count.
      let sc = el.parentElement, ok = false;
      for (; sc && sc !== document.body; sc = sc.parentElement) {
        const cs = getComputedStyle(sc);
        if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX)) { ok = onScreen(sc.getBoundingClientRect()); break; }
      }
      if (!ok) return false;
    }
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    }
    // Covered by something else (e.g. a link sitting under the toolbar)? Check
    // what's actually on top at a few points inside it.
    if (onScreen(r)) {
      const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 6, r.top + r.height / 2], [r.right - 6, r.top + r.height / 2]];
      const seen = pts.some(([x, y]) => {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
        const top = document.elementFromPoint(x, y);
        return top && (top === el || el.contains(top) || top.contains(el) || (top.closest && top.closest('label') && top.closest('label').contains(el)));
      });
      if (!seen) return false;
    }
    // YouTube and other cross-origin players swallow every key — never enter them
    if (el.tagName === 'IFRAME' && !el.hasAttribute('data-tv-frame')) return false;
    return true;
  }
  const candidates = () => [...document.querySelectorAll(SELECTOR)].filter(visible);

  // Prefer controls inside the topmost open overlay (popup, panel, dialog)
  function scopeOf(list) {
    const overlays = [...document.querySelectorAll('[role="dialog"], .modal, #camera-overlay, #layer-panel, #forecast-panel, #lnw-panel, #meso-menu')]
      .filter(o => { const cs = getComputedStyle(o); return cs.display !== 'none' && cs.visibility !== 'hidden' && o.getBoundingClientRect().width > 0; });
    if (!overlays.length) return list;
    const cur = document.querySelector('.tv-focus');
    if (cur && overlays.some(o => o.contains(cur))) return list;   // already inside one: move freely
    return list;
  }

  let current = null;
  function setFocus(el, opts) {
    if (!el) return false;
    if (current) current.classList.remove('tv-focus');
    current = el;
    el.classList.add('tv-focus');
    try { el.focus({ preventScroll: true }); } catch (_) {}
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {}
    if (el.classList.contains('leaflet-container')) showMapHint(); else hideMapHint();
    if (el.tagName === 'IFRAME' && !(opts && opts.noEnter)) enterFrame(el, (opts && opts.dir) || 'down');
    return true;
  }
  function focusFirst() {
    const list = candidates();
    return setFocus(document.querySelector('[data-tv-initial]') && visible(document.querySelector('[data-tv-initial]'))
      ? document.querySelector('[data-tv-initial]') : list[0]);
  }

  // ── Spatial navigation ────────────────────────────────────────────────────
  function rectOf(el) { return el.getBoundingClientRect(); }
  function best(from, dir, list) {
    const a = from ? rectOf(from) : { left: innerWidth / 2, right: innerWidth / 2, top: 0, bottom: 0, width: 0, height: 0 };
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let win = null, winScore = Infinity;
    for (const el of list) {
      if (el === from || (from && (el.contains(from) || from.contains(el)))) continue;
      const b = rectOf(el), bx = b.left + b.width / 2, by = b.top + b.height / 2;
      let primary, cross;
      if (dir === 'right') { primary = b.left - a.right; cross = Math.abs(by - ay); if (bx <= ax + 1) continue; }
      if (dir === 'left')  { primary = a.left - b.right; cross = Math.abs(by - ay); if (bx >= ax - 1) continue; }
      if (dir === 'down')  { primary = b.top - a.bottom; cross = Math.abs(bx - ax); if (by <= ay + 1) continue; }
      if (dir === 'up')    { primary = a.top - b.bottom; cross = Math.abs(bx - ax); if (by >= ay - 1) continue; }
      const overlap = (dir === 'left' || dir === 'right')
        ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        : Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const score = Math.max(primary, 0) + cross * (overlap > 0 ? 0.3 : 2.2) - (overlap > 0 ? 40 : 0);
      if (score < winScore) { winScore = score; win = el; }
    }
    return win;
  }
  function move(dir) {
    const list = scopeOf(candidates());
    if (!current || !document.contains(current) || !visible(current)) return focusFirst();
    const next = best(current, dir, list);
    if (next) return setFocus(next, { dir });
    if (inFrame) { window.parent.postMessage({ wtvTv: 'exit', dir }, location.origin); if (current) current.classList.remove('tv-focus'); current = null; return true; }
    return false;
  }

  // ── Same-origin frames (the radar inside the main page) ───────────────────
  function enterFrame(frame, dir) {
    try { frame.contentWindow.postMessage({ wtvTv: 'enter', dir }, location.origin); } catch (_) {}
  }
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || !e.data.wtvTv) return;
    const m = e.data;
    if (m.wtvTv === 'enter') {           // parent handed us the highlight: start at the edge we came in from
      const list = candidates();
      const edge = { down: (r) => r.top, up: (r) => -r.bottom, right: (r) => r.left, left: (r) => -r.right }[m.dir] || ((r) => r.top);
      list.sort((x, y) => edge(rectOf(x)) - edge(rectOf(y)));
      setFocus(list[0]);
    } else if (m.wtvTv === 'exit') {     // child ran out of controls: continue from the frame
      const frame = [...document.querySelectorAll('iframe[data-tv-frame]')].find(f => f.contentWindow === e.source);
      if (frame) { setFocus(frame, { noEnter: true }); const next = best(frame, m.dir, candidates()); if (next) setFocus(next, { dir: m.dir }); }
    } else if (m.wtvTv === 'back') {
      // Back inside the embedded radar with nothing left to close: step OUT of
      // the radar to the main page's buttons (never exit the app from here)
      const frame = [...document.querySelectorAll('iframe[data-tv-frame]')].find(f => f.contentWindow === e.source);
      for (let i = backHandlers.length - 1; i >= 0; i--) { try { if (backHandlers[i]()) return; } catch (_) {} }
      if (closeTopOverlay()) return;
      if (frame) {
        const list = candidates().filter(el => el !== frame);
        setFocus(best(frame, 'down', list) || best(frame, 'up', list) || list[0], { noEnter: true });
      }
    } else if (m.wtvTv === 'media') {
      mediaHandlers.forEach(fn => { try { fn(m.action); } catch (_) {} });
    }
  });

  // ── Back ──────────────────────────────────────────────────────────────────
  function closeTopOverlay() {
    // A visible close button in a popup/panel: press the topmost one
    const closers = [...document.querySelectorAll('button, [role="button"], .cam-close, [onclick]')].filter(b => {
      if (!visible(b)) return false;
      const t = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim();
      return /^(✕|×|x|close)$/i.test(t) || /^close\b/i.test(t) || /close/i.test(b.getAttribute('aria-label') || '');
    });
    if (!closers.length) return false;
    const z = (el) => { let v = 0; for (let n = el; n && n !== document.body; n = n.parentElement) { const zi = parseInt(getComputedStyle(n).zIndex, 10); if (zi > v) v = zi; } return v; };
    closers.sort((a, b) => z(b) - z(a));
    closers[0].click();
    return true;
  }
  function handleBack(fromChild) {
    // 1) Close whatever is open on top (popups, panels, menus)
    for (let i = backHandlers.length - 1; i >= 0; i--) { try { if (backHandlers[i]()) { refocusSoon(); return; } } catch (_) {} }
    if (closeTopOverlay()) { refocusSoon(); return; }
    // 2) On the map: hand the remote back to the buttons
    if (current && current.classList.contains('leaflet-container')) {
      const tool = best(current, 'up', candidates().filter(el => !el.classList.contains('leaflet-container')));
      if (tool) { setFocus(tool); return; }
    }
    if (inFrame) {
      if (current) current.classList.remove('tv-focus');
      current = null;
      window.parent.postMessage({ wtvTv: 'back' }, location.origin);
      return;
    }
    if (!fromChild && history.length > 1 && location.pathname !== '/' && location.pathname !== '/index.html') { history.back(); return; }
    try { if (window.tizen && tizen.application) { tizen.application.getCurrentApplication().exit(); return; } } catch (_) {}
    // Samsung TV app shell: ask the wrapper to close the app
    if (inShell) { try { window.parent.postMessage({ wtvTv: 'shell-exit' }, '*'); return; } catch (_) {} }
    // Xbox app (WebView2 host): ask the app to close, back to the Xbox home
    try { if (window.chrome && chrome.webview && chrome.webview.postMessage) { chrome.webview.postMessage('wtv-exit'); return; } } catch (_) {}
    try { window.close(); } catch (_) {}
  }
  function refocusSoon() { setTimeout(() => { if (!current || !document.contains(current) || !visible(current)) focusFirst(); }, 120); }

  // ── Map hint (radar) ──────────────────────────────────────────────────────
  let hintTimer = null;
  function showMapHint() {
    let h = document.getElementById('tv-map-hint');
    if (!h) { h = document.createElement('div'); h.id = 'tv-map-hint'; document.body.appendChild(h); }
    h.textContent = /Xbox/i.test(ua)
      ? 'D-pad or stick moves the map · RB/LB zoom · B returns to the buttons'
      : 'Arrows move the map · CH ▲/▼ zoom · BACK returns to the buttons';
    h.style.display = 'block';
    clearTimeout(hintTimer); hintTimer = setTimeout(() => { h.style.display = 'none'; }, 5000);
  }
  function hideMapHint() { const h = document.getElementById('tv-map-hint'); if (h) h.style.display = 'none'; }
  function mapOf(el) { const m = window.WTV_TV_MAP; return el && el.classList.contains('leaflet-container') && m && m.getContainer && m.getContainer() === el ? m : null; }

  // ── Keys ──────────────────────────────────────────────────────────────────
  // Arrows, plus the Xbox controller's D-pad (203–206) and left stick (211–214)
  const DIRS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down', 203: 'up', 204: 'down', 205: 'left', 206: 'right', 211: 'up', 212: 'down', 213: 'right', 214: 'left' };
  const PAD_A = 195, PAD_B = 196, PAD_LB = 200, PAD_RB = 199, PAD_MENU = 207;
  let lastBackAt = 0;
  const MEDIA = { 10252: 'playpause', 415: 'play', 19: 'pause', 413: 'stop', 417: 'next', 412: 'prev', 179: 'playpause' };
  document.addEventListener('keydown', (e) => {
    // Apps that pass the remote/controller in as key names (Xbox) have no keyCode
    const KEYNAME = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, GamepadA: PAD_A, GamepadB: PAD_B };
    const key = e.key, k = e.keyCode || KEYNAME[key] || 0;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    const typing = tag === 'TEXTAREA' || (tag === 'INPUT' && !/^(button|checkbox|radio|range|submit|reset)$/i.test(document.activeElement.type));

    // Back: Samsung 10009, other TVs XF86Back/GoBack/BrowserBack; Escape for testing
    if (k === 10009 || k === PAD_B || key === 'GamepadB' || key === 'XF86Back' || key === 'GoBack' || key === 'BrowserBack' || (key === 'Escape' && !typing) || (key === 'Backspace' && !typing)) {
      e.preventDefault(); e.stopPropagation();
      if (Date.now() - lastBackAt < 350) return;          // one press can arrive twice on Xbox (key + system Back)
      lastBackAt = Date.now(); handleBack(false); return;
    }
    if (MEDIA[k] || /^Media/.test(key)) {
      e.preventDefault();
      const action = MEDIA[k] || ({ MediaPlayPause: 'playpause', MediaPlay: 'play', MediaPause: 'pause', MediaStop: 'stop', MediaTrackNext: 'next', MediaFastForward: 'next', MediaTrackPrevious: 'prev', MediaRewind: 'prev' }[key]);
      if (inFrame) window.parent.postMessage({ wtvTv: 'media', action }, location.origin);
      mediaHandlers.forEach(fn => { try { fn(action); } catch (_) {} });
      return;
    }
    const m = mapOf(current);
    if (m && (k === 427 || k === 428 || k === PAD_RB || k === PAD_LB || key === 'ChannelUp' || key === 'ChannelDown' || key === '+' || key === '-')) {
      e.preventDefault(); (k === 427 || k === PAD_RB || key === 'ChannelUp' || key === '+') ? m.zoomIn() : m.zoomOut(); return;
    }
    if (DIRS[k]) {
      if (m) {                                                            // the map is highlighted: pan it
        e.preventDefault(); e.stopPropagation(); showMapHint();
        const step = Math.round(Math.min(innerWidth, innerHeight) / 4);
        m.panBy({ left: [-step, 0], right: [step, 0], up: [0, -step], down: [0, step] }[DIRS[k]], { animate: true });
        return;
      }
      if (typing && (k === 37 || k === 39)) {                             // text box: move the cursor, and
        const el = document.activeElement;                                // leave once it's at the start/end
        const atStart = (el.selectionStart || 0) === 0 && (el.selectionEnd || 0) === 0;
        const atEnd = (el.selectionStart || 0) >= (el.value || '').length;
        if (!(k === 37 ? atStart : atEnd)) return;
      }
      if (tag === 'SELECT' && (k === 38 || k === 40) && document.activeElement.size > 1) return;
      e.preventDefault();
      move(DIRS[k]);
      return;
    }
    if (XBOX_APP && (k === PAD_A || key === 'GamepadA')) {             // Xbox A on a text box: type in the app's box
      const tf = isTextField(current) ? current : (typing ? document.activeElement : null);
      if (tf && askText(tf)) { e.preventDefault(); return; }
    }
    if ((k === PAD_A || key === 'GamepadA') && current && !typing) {     // Xbox A = OK
      e.preventDefault();
      if (current.classList.contains('leaflet-container')) return;
      current.click(); if (/^(INPUT|SELECT)$/.test(current.tagName)) current.focus();
      return;
    }
    if (k === 13 && current && !typing) {
      const t = current.tagName;
      if (current.classList.contains('leaflet-container')) { e.preventDefault(); return; }
      if (t !== 'BUTTON' && t !== 'A' && t !== 'SELECT' && t !== 'INPUT') { e.preventDefault(); current.click(); }
    }
  }, true);

  // Mouse/touch still works: follow what the user clicks
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el && el !== current && el.matches && el.matches(SELECTOR) && visible(el)) {
      if (current) current.classList.remove('tv-focus');
      current = el; el.classList.add('tv-focus');
    }
  });

  // Start with something highlighted (skip in a frame: the parent hands focus in)
  const start = () => { if (!inFrame) setTimeout(focusFirst, 400); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
