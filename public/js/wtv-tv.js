// WeatherTV — TV remote navigation (Samsung Tizen + other smart TVs) — build.1792700000
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
//   WTV_TV.onKey(fn)    fn(keyCode, key) — return true to use the key (checked before anything else)
//   data-tv-skip        on any element: never highlight it
//   data-tv-initial     on one element: where the highlight starts
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const ua = navigator.userAgent || '';
  const isTV = params.get('tv') === '1'
    || /Tizen|SMART-TV|SmartTV|SMARTTV|Web0S|WebOS|NetCast|HbbTV|BRAVIA|AFT[A-Z]|Android TV|GoogleTV|CrKey|Xbox/i.test(ua)
    || (window.parent !== window && (() => { try { return !!window.parent.WTV_TV && window.parent.WTV_TV.active; } catch (_) { return false; } })());
  const keyHooks = [];
  const onKey = (fn) => keyHooks.push(fn);   // fn(keyCode, key) returns true when it used the key
  const api = { active: isTV, onBack, onMedia, onKey, focusFirst, focusEl: (el) => setFocus(el) };   // focusEl: move the highlight only
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
  let tvFocusing = false;              // true while the D-pad highlight moves focus
  function askText(el) {
    if (Date.now() - lastTextAsk < 700) return true;
    let top; try { top = window.top; void top.document.body; } catch (_) { return false; }
    const wv = top.chrome && top.chrome.webview;
    if (!wv || !wv.postMessage) return false;
    // The A press that closes the app's box can reach the page too: don't
    // let it open the box again straight away.
    if (Date.now() - (top.__wtvCommitAt || 0) < 1000 || Date.now() - (top.__wtvClosedAt || 0) < 1000) return true;
    lastTextAsk = Date.now();
    top.__wtvTextTarget = el;
    top.__wtvAsking = el;
    try { el.blur(); } catch (_) {}
    // The site may put the cursor back right away (e.g. search calls select()
    // after focus), which would bring up the web view's own keyboard over ours
    [60, 200, 450].forEach(t => setTimeout(() => { if (document.activeElement === el) { try { el.blur(); } catch (_) {} } }, t));
    wv.postMessage('wtv-text ' + JSON.stringify({
      value: el.value || '',
      hint: el.getAttribute('aria-label') || el.placeholder || 'Type here',
      max: el.maxLength > 0 ? el.maxLength : 0
    }));
    return true;
  }
  if (XBOX_APP) {
    // Keep the web view's own keyboard from popping up on top of ours
    // and when the site itself puts the cursor in a box (e.g. opening channel
    // search), open the app's text box right away. Moving the highlight onto a
    // box with the D-pad doesn't count: that only opens on A.
    document.addEventListener('focusin', (e) => {
      const el = e.target;
      if (!isTextField(el)) return;
      el.setAttribute('inputmode', 'none');
      // Just asked the app for this box: keep the cursor out of the web page
      if (Date.now() - lastTextAsk < 1500) { try { el.blur(); } catch (_) {} return; }
      let committedAt = 0; try { committedAt = window.top.__wtvCommitAt || 0; } catch (_) {}
      if (!tvFocusing && Date.now() - committedAt > 1500) askText(el);
    }, true);
    // No web keyboard for any text box, including ones added later
    const noWebKeyboard = (root) => { try { root.querySelectorAll('input, textarea').forEach(i => { if (isTextField(i)) i.setAttribute('inputmode', 'none'); }); } catch (_) {} };
    const watchBoxes = () => { noWebKeyboard(document); try { new MutationObserver(() => { if (watchBoxes.t) return; watchBoxes.t = setTimeout(() => { watchBoxes.t = 0; noWebKeyboard(document); }, 500); }).observe(document.body, { childList: true, subtree: true }); } catch (_) {} };
    if (document.body) watchBoxes(); else document.addEventListener('DOMContentLoaded', watchBoxes);
    // Cursor mode: clicking a text box opens the app's text box too
    document.addEventListener('click', (e) => { if (isTextField(e.target)) askText(e.target); }, true);
    if (window === window.top) {
      // Called by the Xbox app with what was typed: fill the box and search
      window.__wtvTextCommit = function (v) {
        const el = window.__wtvTextTarget; window.__wtvTextTarget = null; window.__wtvAsking = null;
        window.__wtvCommitAt = Date.now();
        if (!el || !el.isConnected) return;
        setTimeout(() => afterTextBox(el), 60);
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
  // After the app's text box closes (Search or Cancel): on the radar, go back
  // to the map pointer; elsewhere stay on the box that was typed into.
  function afterTextBox(el) {
    try {
      const w = el.ownerDocument.defaultView;
      if (w && w.WTV_TV && w.WTV_TV.textDone) w.WTV_TV.textDone(el);
    } catch (_) {}
  }
  if (XBOX_APP && window === window.top) {
    // Cancel: the app's box closes and the page gets the focus back without
    // any text. That's how we know it was cancelled.
    window.addEventListener('focus', () => {
      const el = window.__wtvAsking;
      if (!el) return;
      setTimeout(() => {
        if (window.__wtvAsking !== el) return;                          // Search arrived instead
        window.__wtvAsking = null; window.__wtvTextTarget = null;
        window.__wtvClosedAt = Date.now();
        if (el.isConnected) afterTextBox(el);
      }, 250);
    });
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
    html.tv-mode #tv-zoom-badge {
      position: fixed; right: 1.2rem; top: 50%; transform: translateY(-50%); z-index: 2147482500; display: none;
      background: rgba(0,0,0,0.85); color: #ffd000; border: 2px solid #ffd000; border-radius: 8px;
      padding: 0.4rem 0.8rem; font: 700 1.3rem 'Barlow Condensed', 'Barlow', system-ui, sans-serif; pointer-events: none;
    }
    html.tv-mode #tv-pointer {
      position: fixed; z-index: 2147482000; pointer-events: none; display: none;
      width: 38px; height: 38px; margin: -2px 0 0 -2px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.7));
    }
    html.tv-mode #tv-pointer::after {
      content: ''; position: absolute; left: -9px; top: -9px; width: 22px; height: 22px; border-radius: 50%;
      border: 3px solid #ffd000; opacity: 0; transition: opacity .12s;
    }
    html.tv-mode #tv-pointer.hot::after { opacity: 1; }
    html.tv-mode #tv-picker {
      position: fixed; inset: 0; z-index: 2147483000; background: rgba(0,0,0,0.72);
      display: flex; align-items: center; justify-content: center;
    }
    html.tv-mode #tv-picker .tv-picker-box {
      width: min(560px, 90vw); max-height: 82vh; display: flex; flex-direction: column; gap: 0.6rem;
      background: #0f1724; border: 2px solid #00b4d8; border-radius: 12px; padding: 1.1rem 1.2rem;
      box-shadow: 0 16px 50px rgba(0,0,0,0.7); font-family: 'Barlow', system-ui, sans-serif;
    }
    html.tv-mode #tv-picker .tv-picker-title { color: #e8f4fd; font-size: 1.35rem; font-weight: 700; }
    html.tv-mode #tv-picker .tv-picker-list { overflow-y: auto; display: flex; flex-direction: column; gap: 0.35rem; padding: 6px; }
    html.tv-mode #tv-picker .tv-picker-group { color: #7d97b3; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.08em; margin: 0.5rem 0 0.1rem; }
    html.tv-mode #tv-picker button {
      text-align: left; font: 500 1.1rem 'Barlow', system-ui, sans-serif; color: #e8f4fd; cursor: pointer;
      background: #16212f; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 0.6rem 0.9rem;
    }
    html.tv-mode #tv-picker button.on { border-color: #00b4d8; color: #00b4d8; }
    html.tv-mode #tv-picker button.on::after { content: '  ✓'; }
    html.tv-mode #tv-picker button[disabled] { opacity: 0.4; }
    html.tv-mode #tv-picker .tv-picker-tip { color: #7d97b3; font-size: 0.85rem; text-align: center; }
    html.tv-mode #tv-picker .tv-picker-cancel { text-align: center; background: transparent; color: #7d97b3; }
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
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0 || n.style.opacity === '0') return false;   // inline 0 = fading out
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
  const candidates = () => {
    const pk = document.getElementById('tv-picker');
    return [...(pk ? pk : document).querySelectorAll(SELECTOR)].filter(visible);
  };

  // ── Drop-down menus ───────────────────────────────────────────────────────
  // The browser's own drop-down list can't be driven by a TV remote or the
  // Xbox controller inside an app, so on TVs a <select> opens this list instead.
  function labelOf(sel) {
    let t = sel.getAttribute('aria-label') || sel.title || '';
    if (!t && sel.id) { const l = document.querySelector('label[for="' + sel.id + '"]'); if (l) t = l.textContent; }
    if (!t) { const l = sel.closest('label'); if (l) t = l.textContent; }
    if (!t) { const p = sel.previousElementSibling; if (p && p.tagName === 'LABEL') t = p.textContent; }
    return (t || 'Choose one').replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  function closePicker(refocus) {
    const pk = document.getElementById('tv-picker');
    if (!pk) return false;
    const sel = pk.__sel; pk.remove();
    if (refocus !== false && sel && document.contains(sel)) setFocus(sel); else refocusSoon();
    return true;
  }
  function openPicker(sel) {
    closePicker(false);
    const pk = document.createElement('div');
    pk.id = 'tv-picker'; pk.setAttribute('role', 'dialog'); pk.setAttribute('aria-label', labelOf(sel));
    pk.__sel = sel;
    const box = document.createElement('div'); box.className = 'tv-picker-box';
    const h = document.createElement('div'); h.className = 'tv-picker-title'; h.textContent = labelOf(sel);
    const list = document.createElement('div'); list.className = 'tv-picker-list';
    let chosen = null;
    [...sel.children].forEach(node => {
      const opts = node.tagName === 'OPTGROUP' ? [...node.children] : [node];
      if (node.tagName === 'OPTGROUP') { const g = document.createElement('div'); g.className = 'tv-picker-group'; g.textContent = node.label; list.appendChild(g); }
      opts.forEach(o => {
        if (o.tagName !== 'OPTION' || o.hidden) return;
        const b = document.createElement('button'); b.type = 'button'; b.className = 'tv-picker-opt';
        b.textContent = o.textContent.trim() || o.value;
        if (o.disabled) b.disabled = true;
        if (o.selected) { b.classList.add('on'); b.setAttribute('aria-current', 'true'); chosen = b; }
        b.addEventListener('click', () => {
          const changed = sel.value !== o.value;
          sel.value = o.value;
          closePicker();
          if (changed) {
            sel.dispatchEvent(new Event('input', { bubbles: true }));
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
        list.appendChild(b);
      });
    });
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'tv-picker-cancel';
    cancel.textContent = 'Cancel'; cancel.setAttribute('data-tv-picker-cancel', '');
    cancel.addEventListener('click', () => closePicker());
    const tip = document.createElement('div'); tip.className = 'tv-picker-tip';
    tip.textContent = /Xbox/i.test(ua) ? 'D-pad to move · RB/LB jump a page · A to choose · B to cancel'
                                       : 'Arrows to move · CH ▲/▼ jump a page · OK to choose · BACK to cancel';
    box.append(h, list, cancel, tip); pk.appendChild(box);
    pk.addEventListener('click', (e) => { if (e.target === pk) closePicker(); });
    document.body.appendChild(pk);
    const first = chosen || list.querySelector('.tv-picker-opt:not([disabled])') || cancel;
    setTimeout(() => { setFocus(first); try { first.scrollIntoView({ block: 'center' }); } catch (_) {} }, 0);
  }
  api.openPicker = openPicker;
  api.textDone = (el) => {
    const m = window.WTV_TV_MAP;
    if (m && m.getContainer && document.contains(m.getContainer()) && visible(m.getContainer())) setFocus(m.getContainer());
    else if (el && document.contains(el) && visible(el)) setFocus(el);
  };

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
    tvFocusing = true;
    if (XBOX_APP && isTextField(el)) {
      // Xbox app: only highlight a text box, never put the cursor in it. A
      // focused web box brings up the web view's keyboard, which can't type
      // here and swallows the controller; A opens the app's box instead.
      const a = document.activeElement;
      if (a && a !== document.body && a.blur) { try { a.blur(); } catch (_) {} }
    } else {
      try { el.focus({ preventScroll: true }); } catch (_) {}
    }
    tvFocusing = false;
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {}
    if (el.classList.contains('leaflet-container')) { showMapHint(); const pm = mapOf(el); if (pm) ptrShow(pm); }
    else { hideMapHint(); ptrHide(); }
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
  // Inside the drop-down list: step through the choices in order. Choices
  // scrolled out of the list's box still count; each step scrolls the list.
  function pickerItems() {
    const pk = document.getElementById('tv-picker');
    return pk ? [...pk.querySelectorAll('.tv-picker-opt:not([disabled]), .tv-picker-cancel')] : null;
  }
  function pickerStep(n) {
    const items = pickerItems();
    if (!items || !items.length) return false;
    let i = items.indexOf(current);
    const opts = items.length - 1;                      // the last item is Cancel
    if (i < 0) i = 0;
    else if (Math.abs(n) > 1) i = i >= opts ? (n > 0 ? opts : Math.max(0, opts - 1)) : Math.max(0, Math.min(opts - 1, i + n));
    else i = Math.max(0, Math.min(items.length - 1, i + n));
    setFocus(items[i]);
    try { items[i].scrollIntoView({ block: 'nearest' }); } catch (_) {}
    return true;
  }
  function move(dir) {
    if (pickerItems()) {
      if (dir === 'down' || dir === 'up') pickerStep(dir === 'down' ? 1 : -1);
      return true;
    }
    const list = scopeOf(candidates());
    if (!current || !document.contains(current) || !visible(current)) return focusFirst();
    const next = best(current, dir, list);
    if (next) return setFocus(next, { dir });
    if (inFrame) { window.parent.postMessage({ wtvTv: 'exit', dir }, location.origin); if (current) current.classList.remove('tv-focus'); current = null; return true; }
    return false;
  }

  // ── Shortcuts: X / blue key = the radar map pointer, Y / yellow key = the
  // radar's top buttons (or the top of the page when there's no radar) ─────────
  // The Xbox app sends X and Y from version 1.1 (it says so in its user agent).
  const XY_OK = !XBOX_APP || /WeatherTVXbox\/(1\.[1-9]|[2-9])/.test(ua);
  function topControl() {
    const list = candidates().filter(el => !el.classList.contains('leaflet-container') && !el.hasAttribute('data-tv-notop'));
    list.sort((a, b) => { const ra = rectOf(a), rb = rectOf(b); return (Math.round(ra.top / 24) - Math.round(rb.top / 24)) || (ra.left - rb.left); });
    return list[0] || null;
  }
  function jumpTo(where) {
    closePicker(false);
    const m = window.WTV_TV_MAP;
    if (m && m.getContainer && document.contains(m.getContainer())) {       // this page is the radar
      if (where === 'map') return setFocus(m.getContainer());
      const t = topControl(); return t ? setFocus(t) : false;
    }
    const frame = [...document.querySelectorAll('iframe[data-tv-frame]')].find(visible);
    if (frame) {                                                            // the radar is showing in a frame
      setFocus(frame, { noEnter: true });
      try { frame.contentWindow.postMessage({ wtvTv: 'jump', where }, location.origin); } catch (_) {}
      return true;
    }
    return where === 'top' ? focusFirst() : false;
  }
  let tipTimer = null;
  function showTip(text, ms) {
    let h = document.getElementById('tv-map-hint');
    if (!h) { h = document.createElement('div'); h.id = 'tv-map-hint'; document.body.appendChild(h); }
    h.textContent = text; h.style.display = 'block';
    clearTimeout(hintTimer); clearTimeout(tipTimer); tipTimer = setTimeout(() => { h.style.display = 'none'; }, ms || 6000);
  }
  function radarTip() {
    if (/Xbox/i.test(ua)) { if (XY_OK) showTip('Tip: press X to use the map pointer · Y for the top buttons'); }
    else showTip('Tip: BLUE key for the map pointer · YELLOW key for the top buttons');
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
    } else if (m.wtvTv === 'jump') {
      jumpTo(m.where);
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
    if (closePicker()) return;
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
  function refocusSoon() {
    // Checked twice: some boxes (map popups) fade out before they're removed
    const check = (last) => {
      if (current && document.contains(current) && visible(current)) { if (!last) setTimeout(() => check(true), 350); return; }
      if (mapReturn && document.contains(mapReturn.el) && visible(mapReturn.el)) setFocus(mapReturn.el);   // back to the pointer
      else focusFirst();
      mapReturn = null;
    };
    setTimeout(() => check(false), 150);
  }

  // ── Map hint (radar) ──────────────────────────────────────────────────────
  let hintTimer = null;
  function showMapHint() {
    let h = document.getElementById('tv-map-hint');
    if (!h) { h = document.createElement('div'); h.id = 'tv-map-hint'; document.body.appendChild(h); }
    h.textContent = /Xbox/i.test(ua)
      ? 'Stick moves the pointer · A clicks · RB/LB zoom · ' + (XY_OK ? 'Y top buttons' : 'B back to the buttons')
      : 'Arrows move the pointer · OK clicks · CH ▲/▼ zoom · YELLOW key: top buttons';
    h.style.display = 'block';
    clearTimeout(hintTimer); hintTimer = setTimeout(() => { h.style.display = 'none'; }, 5000);
  }
  function hideMapHint() { const h = document.getElementById('tv-map-hint'); if (h) h.style.display = 'none'; }
  function mapOf(el) { const m = window.WTV_TV_MAP; return el && el.classList.contains('leaflet-container') && m && m.getContainer && m.getContainer() === el ? m : null; }

  // ── Pointer on the map ────────────────────────────────────────────────────
  // With the map highlighted, a big pointer works like a mouse: the stick or
  // D-pad moves it (faster the longer you hold), pushing past the edge moves
  // the map, hovering shows names, A clicks whatever is under it (dots, areas,
  // the legend, the Layers button…), RB/LB zoom around it, B goes back to the
  // buttons. Opening a camera, popup or panel moves the highlight into it;
  // closing it brings the pointer back where it was.
  const ptr = { el: null, x: 0, y: 0, on: false, hover: null, lastAt: 0, streak: 0, set: false };
  let mapReturn = null;
  function ptrShow(m) {
    if (!ptr.el) {
      ptr.el = document.createElement('div'); ptr.el.id = 'tv-pointer';
      ptr.el.innerHTML = '<svg viewBox="0 0 32 32" width="38" height="38" aria-hidden="true"><path d="M3 2 L3 26 L9.5 20 L14 30 L18.5 28 L14 18.5 L23 18.5 Z" fill="#ffd000" stroke="#000" stroke-width="2" stroke-linejoin="round"/></svg>';
      document.body.appendChild(ptr.el);
    }
    if (!ptr.set) {                                       // first time: middle of the map
      const r = m.getContainer().getBoundingClientRect();
      ptr.x = Math.round(r.left + r.width / 2); ptr.y = Math.round(r.top + r.height / 2); ptr.set = true;
    }
    ptr.on = true; ptr.el.style.display = 'block';
    if (!padRaf) { padLast = 0; padRaf = requestAnimationFrame(padPoll); }
    ptrPlace(); ptrHover();
  }
  function ptrHide() {
    if (!ptr.on) return;
    ptr.on = false; if (ptr.el) ptr.el.style.display = 'none';
    if (ptr.hover) { mouse(ptr.hover, 'mouseout', ptr.x, ptr.y); ptr.hover = null; }
  }
  function ptrPlace() { if (ptr.el) { ptr.el.style.left = ptr.x + 'px'; ptr.el.style.top = ptr.y + 'px'; } }
  function mouse(el, type, x, y, related) {
    try {
      el.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'mouseenter' && type !== 'mouseleave', cancelable: true, view: window,
        clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: /down|move/.test(type) && ptr.down ? 1 : 0, relatedTarget: related || null }));
    } catch (_) {}
  }
  const HOT = '.leaflet-interactive, .leaflet-marker-icon, a[href], button, [role="button"], [onclick], .lp-row, select, input, label, [tabindex]:not([tabindex="-1"])';
  // What's under the pointer. Small dots get a little help: a near miss counts.
  function ptrTarget() {
    let el = document.elementFromPoint(ptr.x, ptr.y);
    if (!el) return null;
    const hot = el.closest && el.closest(HOT);
    if (hot && !hot.classList.contains('leaflet-container') && !el.closest('.leaflet-tile-pane')) return { el, x: ptr.x, y: ptr.y };
    let best = null, bestD = 24;
    document.querySelectorAll('.leaflet-marker-icon').forEach(mk => {
      if (mk.style.display === 'none') return;
      const r = mk.getBoundingClientRect(); if (r.width < 1) return;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2, d = Math.hypot(cx - ptr.x, cy - ptr.y);
      if (d < bestD) { bestD = d; best = { el: document.elementFromPoint(cx, cy) || mk, x: cx, y: cy }; }
    });
    return best || { el, x: ptr.x, y: ptr.y };
  }
  function ptrHover() {
    const t = ptrTarget(); const el = t && t.el;
    if (el !== ptr.hover) {
      if (ptr.hover) { mouse(ptr.hover, 'mouseout', t ? t.x : ptr.x, t ? t.y : ptr.y, el); }
      if (el) mouse(el, 'mouseover', t.x, t.y, ptr.hover);
      ptr.hover = el;
    }
    if (el) mouse(el, 'mousemove', t.x, t.y);
    const hot = el && el.closest && el.closest(HOT);
    if (ptr.el) ptr.el.classList.toggle('hot', !!(hot && !hot.classList.contains('leaflet-container')));
  }
  // Moving the pointer. A tap nudges it; holding glides it smoothly and
  // speeds up the longer you hold (the controller only reports "still held"
  // by repeating the press, so the glide keeps going between repeats).
  const glide = { dirs: {}, raf: 0, start: 0, last: 0, hoverAt: 0, map: null };
  function ptrShift(m, dx, dy) {
    const W = innerWidth - 3, H = innerHeight - 3;
    let nx = ptr.x + dx, ny = ptr.y + dy, px = 0, py = 0;
    if (nx < 2) { px = nx - 2; nx = 2; } if (nx > W) { px = nx - W; nx = W; }
    if (ny < 2) { py = ny - 2; ny = 2; } if (ny > H) { py = ny - H; ny = H; }
    ptr.x = nx; ptr.y = ny; ptrPlace();
    if (px || py) { try { m.panBy([px * 2.5, py * 2.5], { animate: false }); } catch (_) {} }   // pushed past the edge: move the map
  }
  function glideFrame(t) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - (glide.last || now)) / 1000); glide.last = now;
    let vx = 0, vy = 0, any = false;
    for (const dir in glide.dirs) {
      const d = glide.dirs[dir];
      if (now - d.at > d.wait) { delete glide.dirs[dir]; continue; }   // let go
      if (!d.repeating) continue;                                       // a single tap: no glide
      any = true;
      if (dir === 'left') vx -= 1; if (dir === 'right') vx += 1; if (dir === 'up') vy -= 1; if (dir === 'down') vy += 1;
    }
    if (!Object.keys(glide.dirs).length || !ptr.on) { glide.raf = 0; glide.last = 0; ptrHover(); return; }
    if (any && glide.map) {
      const held = (now - glide.start) / 1000;
      const speed = Math.min(650, 220 + held * 380);                    // px per second: easy to stop on a dot
      const len = Math.hypot(vx, vy) || 1;
      ptrShift(glide.map, vx / len * speed * dt, vy / len * speed * dt);
      if (now - glide.hoverAt > 70) { glide.hoverAt = now; ptrHover(); }
    }
    glide.raf = requestAnimationFrame(glideFrame);
  }
  function ptrMove(m, dir) {
    const now = performance.now();
    glide.map = m;
    const d = glide.dirs[dir];
    if (d && now - d.at < 900) {                                        // the press is repeating: it's being held
      const gap = now - d.at;
      d.repeating = true; d.wait = Math.min(450, Math.max(170, gap * 1.8)); d.at = now;
    } else {
      if (!Object.keys(glide.dirs).length) glide.start = now;
      glide.dirs[dir] = { at: now, wait: 900, repeating: false };
      const hop = 14;                                                   // a tap: one small step right away
      ptrShift(m, { left: -hop, right: hop }[dir] || 0, { up: -hop, down: hop }[dir] || 0);
      ptrHover();
    }
    if (!glide.raf) { glide.last = 0; glide.raf = requestAnimationFrame(glideFrame); }
  }
  // If the browser can read the controller's stick directly, use it: push a
  // little to creep, all the way to fly (the repeated presses are then ignored).
  let padAt = 0, padRaf = 0, padLast = 0;
  function padPoll() {
    padRaf = 0;
    if (!ptr.on) return;
    let gp = null;
    try { gp = [...(navigator.getGamepads ? navigator.getGamepads() : [])].find(g => g && g.connected && g.axes && g.axes.length >= 2); } catch (_) {}
    const now = performance.now(), dt = Math.min(0.05, (now - (padLast || now)) / 1000); padLast = now;
    if (gp) {
      const ax = gp.axes[0], ay = gp.axes[1], mag = Math.hypot(ax, ay);
      if (mag > 0.18) {
        padAt = now;
        const m = mapOf(current);
        const k = (Math.min(1, (mag - 0.18) / 0.82)) ** 2;              // gentle near the middle, faster at the edge
        if (m) { ptrShift(m, ax / mag * k * 700 * dt, ay / mag * k * 700 * dt); ptrHover(); }
      }
    }
    padRaf = requestAnimationFrame(padPoll);
  }
  // Zoom: each press counts right away (the level shows on screen); presses
  // made while the map is still zooming are added up into one smooth zoom.
  const zoomQ = { target: null, busy: false, guard: 0 };
  function zoomBadge(z) {
    let b = document.getElementById('tv-zoom-badge');
    if (!b) { b = document.createElement('div'); b.id = 'tv-zoom-badge'; document.body.appendChild(b); }
    b.textContent = 'Zoom ' + z; b.style.display = 'block';
    clearTimeout(zoomBadge.t); zoomBadge.t = setTimeout(() => { b.style.display = 'none'; }, 1200);
  }
  function zoomStep(m, dir) {
    const base = zoomQ.target != null ? zoomQ.target : m.getZoom();
    zoomQ.target = Math.max(m.getMinZoom(), Math.min(m.getMaxZoom(), Math.round(base) + dir));
    zoomBadge(zoomQ.target);
    if (!zoomQ.busy) zoomApply(m);
  }
  function zoomApply(m) {
    const z = zoomQ.target;
    if (z == null || z === m.getZoom()) { zoomQ.target = null; zoomQ.busy = false; return; }
    zoomQ.busy = true;
    const done = () => {
      clearTimeout(zoomQ.guard);
      if (!zoomQ.busy) return;
      zoomQ.busy = false;
      if (zoomQ.target != null && zoomQ.target !== z) zoomApply(m); else zoomQ.target = null;
      ptrHover();
    };
    m.once('zoomend', done);
    zoomQ.guard = setTimeout(done, 900);                                 // never get stuck waiting
    const r = m.getContainer().getBoundingClientRect();
    try { if (ptr.on) m.setZoomAround(L.point(ptr.x - r.left, ptr.y - r.top), z); else m.setZoom(z); }
    catch (_) { try { m.setZoom(z); } catch (__) { done(); } }
  }
  function openOverlays() {
    const shown = (el) => el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
    const out = [];
    const cam = document.getElementById('camera-overlay'); if (shown(cam)) out.push(cam);
    document.querySelectorAll('.leaflet-popup, #tv-picker, [role="dialog"], .modal, #lnw-panel, #meso-menu, #layer-panel.open, #forecast-panel.open, #alert-types-panel').forEach(o => { if (shown(o)) out.push(o); });
    return out;
  }
  function ptrClick(m) {
    const t = ptrTarget(); if (!t || !t.el) return;
    const el = t.el;
    const before = openOverlays();
    const sel = el.closest && el.closest('select');
    if (sel) { openPicker(sel); return; }
    if (isTextField(el) && XBOX_APP) { mapReturn = { el: m.getContainer() }; askText(el); return; }
    ptr.down = true;
    mouse(el, 'mousedown', t.x, t.y);
    ptr.down = false;
    mouse(el, 'mouseup', t.x, t.y);
    mouse(el, 'click', t.x, t.y);
    setTimeout(() => {
      const opened = openOverlays().filter(o => !before.includes(o));
      if (opened.length) { mapReturn = { el: m.getContainer() }; jumpInto(opened[opened.length - 1]); }
      else ptrHover();
    }, 300);
  }
  // Move the highlight into something that just opened: a camera's ✕, the
  // first link in a map popup, the first control in a panel.
  function jumpInto(box) {
    const items = [...box.querySelectorAll(SELECTOR)].filter(visible);
    if (!items.length) return;
    const isClose = (b) => /close/i.test(b.getAttribute('aria-label') || '') || /^(✕|×)$/.test((b.textContent || '').trim());
    const close = items.find(isClose);
    const content = items.find(b => b.classList.contains('lp-row'))
      || items.find(b => !isClose(b) && !b.classList.contains('cam-expand') && !b.classList.contains('lp-head-btn') && !b.classList.contains('rx-ibtn'));
    setFocus(box.id === 'camera-overlay' ? (close || items[0]) : (content || close || items[0]));
  }

  // ── Keys ──────────────────────────────────────────────────────────────────
  // Arrows, plus the Xbox controller's D-pad (203–206) and left stick (211–214)
  const DIRS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down', 203: 'up', 204: 'down', 205: 'left', 206: 'right', 211: 'up', 212: 'down', 213: 'right', 214: 'left' };
  const PAD_A = 195, PAD_B = 196, PAD_LB = 200, PAD_RB = 199, PAD_MENU = 207;
  let lastBackAt = 0;
  const MEDIA = { 10252: 'playpause', 415: 'play', 19: 'pause', 413: 'stop', 417: 'next', 412: 'prev', 179: 'playpause' };
  document.addEventListener('keydown', (e) => {
    // Apps that pass the remote/controller in as key names (Xbox) have no keyCode
    const KEYNAME = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, GamepadA: PAD_A, GamepadB: PAD_B, GamepadX: 197, GamepadY: 198, ColorF2Yellow: 405, ColorF3Blue: 406,
      ColorF0Red: 403, ColorF1Green: 404, GamepadLeftTrigger: 201, GamepadRightTrigger: 202 };
    const key = e.key, k = e.keyCode || KEYNAME[key] || 0;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    const typing = tag === 'TEXTAREA' || (tag === 'INPUT' && !/^(button|checkbox|radio|range|submit|reset)$/i.test(document.activeElement.type));
    // Pages can claim extra keys (e.g. the hodograph: red/green, LT/RT)
    if (!typing && keyHooks.some(fn => { try { return fn(k, key) === true; } catch (_) { return false; } })) {
      e.preventDefault(); e.stopPropagation(); return;
    }

    // Back: Samsung 10009, other TVs XF86Back/GoBack/BrowserBack; Escape for testing
    if (k === 10009 || k === PAD_B || key === 'GamepadB' || key === 'XF86Back' || key === 'GoBack' || key === 'BrowserBack' || (key === 'Escape' && !typing) || (key === 'Backspace' && !typing)) {
      e.preventDefault(); e.stopPropagation();
      if (Date.now() - lastBackAt < 350) return;          // one press can arrive twice on Xbox (key + system Back)
      lastBackAt = Date.now(); handleBack(false); return;
    }
    if (k === 197 || k === 198 || k === 405 || k === 406) {               // X / blue: map pointer · Y / yellow: top buttons
      if (typing) return;
      e.preventDefault(); e.stopPropagation();
      jumpTo((k === 197 || k === 406) ? 'map' : 'top');
      return;
    }
    if (MEDIA[k] || /^Media/.test(key)) {
      e.preventDefault();
      const action = MEDIA[k] || ({ MediaPlayPause: 'playpause', MediaPlay: 'play', MediaPause: 'pause', MediaStop: 'stop', MediaTrackNext: 'next', MediaFastForward: 'next', MediaTrackPrevious: 'prev', MediaRewind: 'prev' }[key]);
      if (inFrame) window.parent.postMessage({ wtvTv: 'media', action }, location.origin);
      mediaHandlers.forEach(fn => { try { fn(action); } catch (_) {} });
      return;
    }
    if (pickerItems() && (k === 427 || k === 428 || k === PAD_RB || k === PAD_LB || key === 'ChannelUp' || key === 'ChannelDown' || key === '+' || key === '-' || key === 'PageUp' || key === 'PageDown')) {
      e.preventDefault();                                                 // RB/LB, CH ▲/▼: a page at a time
      pickerStep((k === 428 || k === PAD_RB || key === 'ChannelDown' || key === '+' || key === 'PageDown') ? 8 : -8);
      return;
    }
    const m = mapOf(current);
    if (m && (k === 427 || k === 428 || k === PAD_RB || k === PAD_LB || key === 'ChannelUp' || key === 'ChannelDown' || key === '+' || key === '-')) {
      e.preventDefault();
      zoomStep(m, (k === 427 || k === PAD_RB || key === 'ChannelUp' || key === '+') ? 1 : -1);
      return;
    }
    if (DIRS[k]) {
      if (m) {                                                            // the map is highlighted: move the pointer
        e.preventDefault(); e.stopPropagation();
        if (!ptr.on) ptrShow(m);
        if (performance.now() - padAt < 250) return;                     // the stick is being read directly
        ptrMove(m, DIRS[k]);
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
      // A button that opens a text box (like 🔍): no web keyboard, only the app's box
      if (XBOX_APP) document.querySelectorAll('input, textarea').forEach(i => { if (isTextField(i)) i.setAttribute('inputmode', 'none'); });
      if (current.classList.contains('leaflet-container')) { const pm = mapOf(current); if (pm) ptrClick(pm); return; }
      if (current.tagName === 'SELECT') { openPicker(current); return; }
      current.click(); if (/^(INPUT|SELECT)$/.test(current.tagName)) current.focus();
      refocusSoon();                                                      // e.g. a ✕ that closed its own box
      return;
    }
    if (k === 13 && current && !typing) {
      const t = current.tagName;
      if (current.classList.contains('leaflet-container')) { e.preventDefault(); const pm = mapOf(current); if (pm) ptrClick(pm); return; }
      if (t === 'SELECT' && current.size <= 1) { e.preventDefault(); openPicker(current); return; }
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
  const start = () => {
    if (!inFrame) setTimeout(focusFirst, 400);
    setTimeout(() => { if (window.WTV_TV_MAP) radarTip(); }, 2500);       // the radar: say how to get around
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
