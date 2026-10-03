// WeatherTV — offline world place-name list for placing cameras — build.1791118800
//
// Uses GeoNames "cities1000" (every town/city with 1,000+ people, ~160k places,
// with coordinates, country and region). Free, CC BY 4.0 — credit: GeoNames
// (https://www.geonames.org). Downloaded once at startup (~9 MB zip), cached in
// /tmp, held in memory. No API calls, no cost: thousands of titles in seconds.
//
//   locate(text, countryHint) → { lat, lng, name, region, cc, confident, why } | null
//
// It reads every 1–4 word phrase of the title/description, looks each up, and
// scores matches: country or region named in the text (strong), multi-word
// names, population. Common words on their own ("Main", "Beach", "Square")
// never count. ✓ confident only when the country or region in the text agrees.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

const SRC = 'https://download.geonames.org/export/dump/cities1000.zip';
const ADMIN1 = 'https://download.geonames.org/export/dump/admin1CodesASCII.txt';
const CACHE = path.join(require('os').tmpdir(), 'wtv-geonames');

let index = null;            // normalized name → [{lat,lng,cc,a1,pop,name}]
let admin1 = new Map();      // "US.WI" → "wisconsin"
let loading = null;

const norm = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Words that are never a place on their own (they can still be PART of a name)
const NOT_PLACE = new Set(('live webcam webcams cam cams camera cameras view views stream streaming hd 4k uhd 24 7 the a an of and at in on to from by with for '
  + 'beach harbor harbour port marina pier bay lake river sea ocean island coast coastal mountain mountains ski resort hotel city town village center centre '
  + 'downtown main street square park bridge station airport railway train traffic weather panorama panoramic north south east west upper lower old new '
  + 'saint st san santa big little great grand royal central view live now day night sunset sunrise church castle tower valley hill hills falls').split(' '));

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'WeatherTV/1.0 (https://watchweathertv.com)' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return resolve(get(r.headers.location));
      if (r.statusCode !== 200) return reject(new Error('HTTP ' + r.statusCode));
      const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// Minimal .zip reader (central directory → first .txt entry → inflate)
function unzipFirstTxt(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  let p = buf.readUInt32LE(eocd + 16);
  const n = buf.readUInt16LE(eocd + 10);
  for (let k = 0; k < n; k++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString();
    if (/\.txt$/i.test(name)) {
      const lnlen = buf.readUInt16LE(off + 26), lxlen = buf.readUInt16LE(off + 28);
      const data = buf.slice(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
      return method === 8 ? zlib.inflateRawSync(data) : data;
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error('no .txt in zip');
}

function build(citiesTxt, admin1Txt) {
  admin1 = new Map();
  for (const line of String(admin1Txt || '').split('\n')) {
    const f = line.split('\t'); if (f.length >= 3) admin1.set(f[0], norm(f[2] || f[1]));
  }
  index = new Map();
  const add = (key, rec) => { if (!key || key.length < 3) return; const a = index.get(key); if (a) a.push(rec); else index.set(key, [rec]); };
  for (const line of String(citiesTxt).split('\n')) {
    const f = line.split('\t');
    if (f.length < 15) continue;
    const rec = { name: f[1], lat: +f[4], lng: +f[5], cc: f[8].toLowerCase(), a1: f[10], pop: +f[14] || 0 };
    const keys = new Set([norm(f[1]), norm(f[2])]);
    if (rec.pop >= 100000) String(f[3] || '').split(',').forEach(n => { if (/^[\x20-\x7e]+$/.test(n)) keys.add(norm(n)); });  // English exonyms for big places
    keys.forEach(k => add(k, rec));
  }
}

async function load(opts = {}) {
  if (index) return true;
  if (loading) return loading;
  loading = (async () => {
    try {
      if (opts.citiesTxt) { build(opts.citiesTxt, opts.admin1Txt || ''); return true; }
      fs.mkdirSync(CACHE, { recursive: true });
      const zf = path.join(CACHE, 'cities1000.zip'), af = path.join(CACHE, 'admin1.txt');
      if (!fs.existsSync(zf)) fs.writeFileSync(zf, await get(SRC));
      if (!fs.existsSync(af)) fs.writeFileSync(af, await get(ADMIN1));
      build(unzipFirstTxt(fs.readFileSync(zf)).toString('utf8'), fs.readFileSync(af, 'utf8'));
      console.log(`[Gazetteer] ${index.size.toLocaleString()} place names loaded (GeoNames, CC BY 4.0)`);
      return true;
    } catch (e) {
      console.warn('[Gazetteer] could not load GeoNames:', e.message);
      return false;
    } finally { loading = null; }
  })();
  return loading;
}

// Country names → ISO2, for reading "…, Germany" in titles
const COUNTRY_WORDS = {
  'united states': 'us', usa: 'us', america: 'us', 'united kingdom': 'gb', uk: 'gb', england: 'gb', scotland: 'gb', wales: 'gb', ireland: 'ie',
  canada: 'ca', mexico: 'mx', germany: 'de', deutschland: 'de', austria: 'at', switzerland: 'ch', france: 'fr', italy: 'it', italia: 'it', spain: 'es',
  espana: 'es', portugal: 'pt', netherlands: 'nl', holland: 'nl', belgium: 'be', denmark: 'dk', sweden: 'se', norway: 'no', finland: 'fi', iceland: 'is',
  poland: 'pl', czechia: 'cz', 'czech republic': 'cz', slovakia: 'sk', hungary: 'hu', slovenia: 'si', croatia: 'hr', serbia: 'rs', romania: 'ro',
  bulgaria: 'bg', greece: 'gr', turkey: 'tr', malta: 'mt', cyprus: 'cy', japan: 'jp', china: 'cn', taiwan: 'tw', korea: 'kr', thailand: 'th',
  philippines: 'ph', indonesia: 'id', vietnam: 'vn', india: 'in', australia: 'au', 'new zealand': 'nz', brazil: 'br', argentina: 'ar', chile: 'cl',
  'south africa': 'za', israel: 'il', jamaica: 'jm', bahamas: 'bs', 'puerto rico': 'pr', 'dominican republic': 'do', 'costa rica': 'cr',
};

function locate(text, countryHint) {
  if (!index) return null;
  const t = ' ' + norm(text) + ' ';
  // same text, keeping commas: "rauris, salzburg, austria"
  const tc = ' ' + String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’'`]/g, '')
    .replace(/[^a-z0-9,]+/g, ' ').replace(/\s*,\s*/g, ', ').trim() + ' ';
  const followedBy = (phrase, what) => what && (tc.includes(' ' + phrase + ', ' + what + ' ') || tc.includes(' ' + phrase + ', ' + what + ','));
  const words = t.trim().split(' ').filter(Boolean);
  // countries and regions mentioned anywhere in the text
  const ccInText = new Set(countryHint ? [countryHint] : []);
  for (const [w, cc] of Object.entries(COUNTRY_WORDS)) if (t.includes(' ' + w + ' ')) ccInText.add(cc);
  const regionMentioned = (rec) => { const r = admin1.get(rec.cc.toUpperCase() + '.' + rec.a1); return r && r.length >= 3 && t.includes(' ' + r + ' ') ? r : null; };
  let best = null;
  for (let len = 4; len >= 1; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      const phrase = words.slice(i, i + len).join(' ');
      if (len === 1 && (NOT_PLACE.has(phrase) || phrase.length < 4 || /^\d+$/.test(phrase))) continue;
      if (words.slice(i, i + len).every(w => NOT_PLACE.has(w))) continue;
      const hits = index.get(phrase);
      if (!hits) continue;
      for (const rec of hits) {
        const region = regionMentioned(rec);
        const ccOk = ccInText.has(rec.cc);
        let score = Math.log10(rec.pop + 10) + (len - 1) * 2.5 + (ccOk ? 6 : 0) + (region ? 5 : 0);
        // "Rauris, Salzburg, Austria": the name written right before its region/country is THE place
        const countryWord = Object.keys(COUNTRY_WORDS).find(w => COUNTRY_WORDS[w] === rec.cc && t.includes(' ' + w + ' '));
        if (followedBy(phrase, region) || followedBy(phrase, countryWord)) score += 4;
        // A city named exactly like its region ("Salzburg" in Salzburg) is only the
        // answer when nothing more specific is named
        if (region && norm(rec.name) === region) score -= 3;
        if (ccInText.size && !ccOk) score -= 8;                     // a country is named, and it isn't this one
        if (len === 1 && rec.pop < 5000 && !ccOk && !region) score -= 3;
        if (!best || score > best.score) best = { ...rec, score, region, ccOk, phrase };
      }
    }
  }
  if (!best || best.score < 4) return null;
  const confident = (best.ccOk || !!best.region) && best.score >= 8;
  return { lat: best.lat, lng: best.lng, name: best.name, region: best.region, cc: best.cc, confident,
           why: `"${best.phrase}" → ${best.name}${best.region ? ', ' + best.region.replace(/\b\w/g, c => c.toUpperCase()) : ''} (${best.cc.toUpperCase()})` };
}

module.exports = { load, locate, _build: build, _norm: norm };
