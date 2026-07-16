// src/security-middleware.js — Altruistic Apps unified security layer
// Updated: 2026-07-09T05:30:00Z
//
// USAGE (drop into any Altruistic Apps server.js):
//
//   const { applySecurityMiddleware, adminAuth, sanitizeInput } = require('./security-middleware');
//   applySecurityMiddleware(app);
//
//   // Then protect admin routes:
//   app.post('/api/admin/something', adminAuth, (req, res) => { ... });
//
//   // Or sanitize a user input before using it in a query:
//   const q = sanitizeInput(req.query.search);
//
// NO extra npm installs needed beyond what Altruistic Apps already uses.
// Optional: `npm install helmet` for the best HTTP header protection (recommended).

'use strict';

const crypto = require('crypto');

// ─── Config ──────────────────────────────────────────────────────────────────
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;

// Allowed origins — expand per app as needed via ALLOWED_ORIGINS env var
const DEFAULT_ORIGINS = [
  'https://altruisticapps.com',
  'https://www.altruisticapps.com',
  'https://watchweathertv.com',
  'https://www.watchweathertv.com',
  'https://aporia.up.railway.app',
  'https://mel.up.railway.app',
  'https://jess.up.railway.app',
  'https://bonniespantry.up.railway.app',
  'https://trustyoureyes.app',
  'https://www.trustyoureyes.app',
];

function getAllowedOrigins() {
  const extra = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return [...DEFAULT_ORIGINS, ...extra];
}

// ─── Rate limiter (no extra package — pure in-memory) ────────────────────────
// Tracks request counts per IP in a sliding window.
// Automatically cleans up stale entries every 5 minutes.
const rateLimitStore = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, data] of rateLimitStore.entries()) {
    if (now - data.windowStart > 60 * 1000 * 5) rateLimitStore.delete(key);
  }
}, 5 * 60 * 1000);

function makeRateLimiter({ windowMs = 60000, max = 100, message = 'Too many requests' } = {}) {
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = rateLimitStore.get(ip) || { count: 0, windowStart: now };

    if (now - entry.windowStart > windowMs) {
      entry.count = 0;
      entry.windowStart = now;
    }

    entry.count++;
    rateLimitStore.set(ip, entry);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - entry.count));

    if (entry.count > max) {
      return res.status(429).json({ error: message, retryAfter: Math.ceil(windowMs / 1000) });
    }
    next();
  };
}

// ─── Security headers ────────────────────────────────────────────────────────
// Applied to every response. Covers the OWASP Top 10 header recommendations.
// If helmet is installed it will be used instead for broader coverage.
function securityHeaders(req, res, next) {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Prevent MIME sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // XSS protection (legacy browsers)
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Only send referrer to same origin
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // HTTPS only (1 year) — only in production
  if (IS_PROD) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // Content Security Policy — allows our own assets + Railway CDN + Google Fonts
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https: blob:",
    "connect-src 'self'" +
      // Internal WeatherTV APIs
      " https://api.anthropic.com" +
      // cdnjs — source maps and fetch requests from cdnjs-hosted libraries (Leaflet, hls.js)
      " https://cdnjs.cloudflare.com" +
      // HMS Smoke + NIFC fire perimeters are server-proxied (/api/hms-smoke, /api/fire-perimeters)
      // — no direct browser calls to satepsanone.nesdis.noaa.gov or services3.arcgis.com needed
      // AirNow is proxied through /api/aqi in server.js — no direct browser call needed
      // Travel forecast city data (domestic + international travel displays)
      " https://api.open-meteo.com" +
      // NWS — forecasts, conditions, alerts, points, radar station lookup
      " https://api.weather.gov" +
      " https://forecast.weather.gov" +
      // Radar imagery (WS4KP + WeatherTV radar panel)
      " https://mesonet.agron.iastate.edu" +
      " https://opengeo.ncep.noaa.gov" +
      " https://mapservices.weather.noaa.gov" +
      // SPC outlook data (WS4KP SPC display)
      " https://www.spc.noaa.gov" +
      // NWS Probabilistic Hazards (WS4KP)
      " https://idpgis.ncep.noaa.gov" +
      // Altruistic Apps / Aporia quote APIs
      " https://zenquotes.io https://en.wikiquote.org https://raw.githubusercontent.com",
    "frame-ancestors 'self'",
  ].join('; '));
  // Remove fingerprinting header
  res.removeHeader('X-Powered-By');
  next();
}

// ─── CORS ────────────────────────────────────────────────────────────────────
function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  const allowed = getAllowedOrigins();

  // Allow same-origin, no-origin (mobile apps, curl, Postman), and whitelisted origins
  if (!origin || allowed.includes(origin) || !IS_PROD) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
  } else {
    // Unknown origin in production — block it
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// ─── Error sanitizer ────────────────────────────────────────────────────────
// Catches unhandled errors and returns safe messages in production.
// Stack traces, file paths, and internal details are never sent to clients.
function errorHandler(err, req, res, next) {
  const id = crypto.randomBytes(4).toString('hex').toUpperCase();

  // Always log full error server-side
  console.error(`[Error ${id}] ${req.method} ${req.path}:`, err.message);
  if (!IS_PROD) console.error(err.stack);

  // Never expose internals in production
  const message = IS_PROD
    ? `An error occurred. Reference ID: ${id}`
    : err.message;

  res.status(err.status || 500).json({ error: message, ref: id });
}

// ─── Input sanitizer ────────────────────────────────────────────────────────
// Use on any user-supplied string before passing to DB or external service.
// Strips control characters, trims whitespace, enforces max length.
function sanitizeInput(value, maxLength = 500) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // control chars
    .replace(/[<>]/g, '')                                 // basic XSS chars
    .trim()
    .slice(0, maxLength);
}

// Sanitize an entire req.query or req.body object in one call
function sanitizeObject(obj, maxLength = 500) {
  if (!obj || typeof obj !== 'object') return {};
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      sanitizeInput(k, 100),
      typeof v === 'string' ? sanitizeInput(v, maxLength) : v,
    ])
  );
}

// ─── Admin auth middleware ───────────────────────────────────────────────────
// Drop-in replacement for the inline key checks scattered across server files.
// Use as route middleware: app.post('/api/admin/thing', adminAuth, handler)
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    // Log failed attempts with IP for monitoring
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    console.warn(`[Security] Failed admin auth from ${ip} on ${req.method} ${req.path}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Request size limiter ────────────────────────────────────────────────────
// Prevents large payload attacks. Express's built-in json() limit + explicit check.
function requestSizeGuard(maxKB = 512) {
  return (req, res, next) => {
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > maxKB * 1024) {
      return res.status(413).json({ error: `Request too large. Maximum ${maxKB}KB.` });
    }
    next();
  };
}

// ─── API key leak detector ───────────────────────────────────────────────────
// Scans outgoing response bodies for patterns that look like leaked secrets.
// Logs a warning if it detects one — does NOT block (to avoid false positives).
const SECRET_PATTERNS = [
  /sk-ant-[a-zA-Z0-9\-_]{20,}/,  // Anthropic API key
  /AIza[0-9A-Za-z\-_]{35}/,       // Google API key
  /ghp_[a-zA-Z0-9]{36}/,          // GitHub PAT
  /ADMIN_KEY/,                     // Our own admin key name
];

function apiKeyLeakDetector(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (data) => {
    const str = JSON.stringify(data);
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(str)) {
        console.error(`[Security] POSSIBLE SECRET LEAK in response to ${req.method} ${req.path} — check immediately`);
        break;
      }
    }
    return originalJson(data);
  };
  next();
}

// ─── Main export ─────────────────────────────────────────────────────────────
// applySecurityMiddleware(app) applies everything in the right order.
// Individual pieces are also exported for granular use.
function applySecurityMiddleware(app, options = {}) {
  const {
    rateLimit = { windowMs: 60000, max: 200 },     // 200 req/min general
    adminRateLimit = { windowMs: 60000, max: 20 },  // 20 req/min on admin routes
    maxBodyKB = 512,
  } = options;

  // Try to use helmet if installed, fall back to manual headers
  try {
    const helmet = require('helmet');
    app.use(helmet({
      contentSecurityPolicy: false, // We set our own above
      crossOriginEmbedderPolicy: false, // Breaks some Railway setups
    }));
    console.log('[Security] helmet active');
  } catch {
    app.use(securityHeaders);
    console.log('[Security] manual headers active (install helmet for broader coverage)');
  }

  // CORS — replaces app.use(cors())
  app.use(corsMiddleware);

  // Request size guard
  app.use(requestSizeGuard(maxBodyKB));

  // General rate limit
  app.use(makeRateLimiter(rateLimit));

  // Tighter rate limit on admin routes
  app.use('/api/admin', makeRateLimiter({
    ...adminRateLimit,
    message: 'Too many admin requests — slow down',
  }));

  // API key leak detector (non-blocking, logging only)
  app.use(apiKeyLeakDetector);

  // Error handler — must be last
  // Call app.use(errorHandler) AFTER all routes are registered
  // (can't be done here since routes aren't registered yet)
  app._altruisticErrorHandler = errorHandler;

  console.log(`[Security] Altruistic Apps security middleware active (${IS_PROD ? 'production' : 'development'})`);
}

// Helper: call this AFTER all routes are registered
function applyErrorHandler(app) {
  app.use(app._altruisticErrorHandler || errorHandler);
}

module.exports = {
  applySecurityMiddleware,
  applyErrorHandler,
  adminAuth,
  sanitizeInput,
  sanitizeObject,
  makeRateLimiter,
  errorHandler,
  securityHeaders,
};
