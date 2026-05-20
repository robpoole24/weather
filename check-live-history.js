// ═══════════════════════════════════════════
// WeatherTV — Live Stream History Checker
// Run with: node check-live-history.js
// Checks each channel's most recent live stream
// and reports how long ago it was
// ═══════════════════════════════════════════

const https = require('https');
const fs = require('fs');
const path = require('path');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && !key.startsWith('#') && val.length) {
      process.env[key.trim()] = val.join('=').trim();
    }
  });
}

const API_KEY = process.env.YOUTUBE_API_KEY;
if (!API_KEY || API_KEY === 'YOUR_YOUTUBE_API_KEY') {
  console.error('No API key found in .env file');
  process.exit(1);
}

// All channels with hasLive: true
const CHANNELS = [
  // Forecasters
  { name: 'Max Velocity',          id: 'UCvBVK2ymNzPLRJrgip2GeQQ' },
  { name: "Ryan Hall Y'all",       id: 'UCJHAT3Uvv-g3I8H3GhHWV7w' },
  { name: 'Evan Fryberger',        id: 'UCp2G_jHO53yj2NVjv8zbDmQ' },
  { name: 'Severe Studios',        id: 'UCBtR7ynKM9odz-PW_7uyzDw'  },
  // Chasers
  { name: 'Aaron Jayjack',         id: 'UC8QZ-OIqfWKek1CpMvs2O3g' },
  { name: 'Andrew Pritchard',      id: 'UCT1IIkU3Yafr6nfNxQlWuSQ' },
  { name: 'Brandon Clement',       id: 'UCD3KREyo3IqCLBC-4khGgIw'  },
  { name: 'Brandon Copic',         id: 'UCJ_8JVFhFKEaFRqnv9kxKmA'  },
  { name: 'Brittney Richardson',   id: 'UCMmlV4B6Bx2GuYtIaxpLcfw'  },
  { name: 'CF Productions',        id: 'UCvIqVAaqpx1Q_e9DzIxgk1A'  },
  { name: 'Chris Riske',           id: 'UCGpPbdVAtTUgW_w98lXC9nw'  },
  { name: 'Connor Croff',          id: 'UCLMVjB6YhWX-bDxNiSmVNNg'  },
  { name: 'Convective Chronicles', id: 'UCRYYy0UrfyGmMKQDU1N1R3g'  },
  { name: 'Corey Gerken',          id: 'UCx5ex9rJumpj-oKgVJrP4hA'  },
  { name: 'Daniel Shaw',           id: 'UCemyFpFfu55JvAP_eWW1NdA'  },
  { name: 'Edgar O\'Neal',         id: 'UChZ_VT3MrHB53bSqFiVf4eg'  },
  { name: 'Freddy McKinney',       id: 'UCFQfMFWHkIBFSxfS_kI4iKA'  },
  { name: 'Jakob McMillin',        id: 'UCPgskHnT1cT_hpfbq9nUK7w'  },
  { name: 'John McKinney',         id: 'UCWMRFAo3Cvd7W8yQpQwsOQA'  },
  { name: 'Jordan Hall',           id: 'UC86mOt7YnKgRUQxblDpsN-g'  },
  { name: 'Justin Poublon',        id: 'UClIZx2ESMJVocfMIbji_ujg'  },
  { name: 'Kannon Kalton',         id: 'UCPtizAsfQaJktz0tw9YuKLQ'  },
  { name: 'Live Storms Media',     id: 'UC1nJElGcVcTpeZJVyxEbzJw'  },
  { name: 'Melanie Metz',          id: 'UCeE90n3GWO1XZcwt8xpNRtw'  },
  { name: 'Reed Timmer',           id: 'UCV6hWxB0-u_IX7e-h4fEBAw'  },
  { name: 'Reilly Dibble',         id: 'UChxsy558HhpaqnB1Hk6tHkw'  },
  { name: 'Scott Peake',           id: 'UCqAWcfd0BJBgCW8iyOLOF3g'  },
  { name: 'Storm Chase TV',        id: 'UCdSMdTFOfqmOXP-1vD2cxAA'  },
  { name: 'Stormgasm',             id: 'UCAnSuGYTjwbGoBMgF_aBpnQ'  },
  { name: 'Stormrunner Media',     id: 'UCBmOfiL9LC3dT4Ps2veVCoQ'  },
  { name: 'Tornado Paigeyy',       id: 'UCm8EwVbQaGVkYnxZVQvCFAw'  },
  { name: 'Tornado TRX',           id: 'UCuer9Sw2UAD5LWZpVXbgKTA'  },
  // Creators
  { name: 'June First',            id: 'UCGEZlX4V82wv7_Z2LsXtjPA'  },
  { name: 'More Max Velocity',     id: 'UCpYQmszu4IP37xyt3RQb2gw'  },
];

function ytFetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function daysAgo(dateStr) {
  if (!dateStr) return null;
  const then = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkChannel(ch) {
  const url = `https://www.googleapis.com/youtube/v3/search?key=${API_KEY}&channelId=${ch.id}&part=snippet&eventType=completed&type=video&order=date&maxResults=1`;
  try {
    const data = await ytFetch(url);
    if (data.error) {
      return { ...ch, error: data.error.message, days: null };
    }
    if (!data.items || data.items.length === 0) {
      return { ...ch, lastLive: null, days: null, note: 'No past live streams found' };
    }
    const item = data.items[0];
    const date = item.snippet.publishedAt;
    const days = daysAgo(date);
    return { ...ch, lastLive: date, days };
  } catch(e) {
    return { ...ch, error: e.message, days: null };
  }
}

async function main() {
  console.log('\n═══════════════════════════════════════════');
  console.log('  WeatherTV — Live Stream History Report');
  console.log('═══════════════════════════════════════════\n');
  console.log(`Checking ${CHANNELS.length} channels...\n`);

  const results = [];

  for (const ch of CHANNELS) {
    process.stdout.write(`  Checking ${ch.name}...`);
    const result = await checkChannel(ch);
    results.push(result);

    if (result.error) {
      console.log(` ERROR: ${result.error}`);
    } else if (result.days === null) {
      console.log(` Never gone live`);
    } else {
      console.log(` ${result.days} days ago`);
    }

    // Small delay to avoid hammering the API
    await sleep(200);
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════\n');

  const active    = results.filter(r => r.days !== null && r.days <= 90);
  const stale     = results.filter(r => r.days !== null && r.days > 90);
  const neverLive = results.filter(r => r.days === null && !r.error);
  const errors    = results.filter(r => r.error);

  console.log(`✅ RECENTLY LIVE (within 90 days) — keep hasLive: true`);
  active.sort((a,b) => a.days - b.days).forEach(r => {
    console.log(`   ${r.name.padEnd(28)} ${r.days} days ago`);
  });

  console.log(`\n⚠️  STALE (over 90 days ago) — consider hasLive: false`);
  stale.sort((a,b) => a.days - b.days).forEach(r => {
    console.log(`   ${r.name.padEnd(28)} ${r.days} days ago`);
  });

  console.log(`\n❌ NEVER GONE LIVE — set hasLive: false`);
  neverLive.forEach(r => {
    console.log(`   ${r.name}`);
  });

  if (errors.length) {
    console.log(`\n🔴 ERRORS`);
    errors.forEach(r => {
      console.log(`   ${r.name}: ${r.error}`);
    });
  }

  // Cost estimate
  const cost = CHANNELS.length * 100;
  console.log(`\n═══════════════════════════════════════════`);
  console.log(`  API units used: ~${cost} of 10,000`);
  console.log(`═══════════════════════════════════════════\n`);
}

main().catch(console.error);
