# WeatherTV 🌩️

A curated weather content app with live YouTube channel integration, WeatherStar 4000+ passthrough, and a weather playlist viewer.

---

## Project Structure

```
weather-tv/
├── public/
│   └── index.html        ← Main app (the TV interface)
├── admin/
│   └── index.html        ← Admin panel
├── data/
│   └── channels.json     ← Auto-generated on first run
├── server.js             ← Node.js/Express backend
├── package.json
└── README.md
```

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Add your YouTube API Key
Open `public/index.html` and find line:
```js
const YT_API_KEY = 'YOUR_YOUTUBE_API_KEY';
```
Replace with your key. Also set your playlist ID:
```js
const PLAYLIST_ID = 'YOUR_PLAYLIST_ID';
```

Or set it via environment variable (recommended for production):
```bash
export YOUTUBE_API_KEY=AIzaXXXXXXXXXXXXXX
```

### 3. Run the app
```bash
npm start
```

App runs at: http://localhost:3000
Admin panel: http://localhost:3000/admin

---

## Deploy to Railway

1. Go to [railway.app](https://railway.app) and sign in
2. Click **New Project → Deploy from GitHub repo**
3. Connect your GitHub account and select this repo
4. Under **Variables**, add:
   - `YOUTUBE_API_KEY` = your API key
   - `PORT` = 3000
5. Click Deploy — Railway gives you a live URL in ~2 minutes

---

## Finding YouTube Channel IDs

To find a channel's ID:
1. Go to the channel's YouTube page
2. View page source (Ctrl+U)
3. Search for `"channelId"` — the value is the ID
4. Or use: https://commentpicker.com/youtube-channel-id.php

---

## Admin Panel Features

- Add / remove channels from any group
- Toggle Live Stream on/off per channel
- Enable/disable individual channels without deleting them
- Update app store links for Weather Apps
- Set YouTube API key and Playlist ID

---

## Platform Notes

| Platform | Status | Notes |
|---|---|---|
| Web (Desktop) | ✅ Full support | Primary platform |
| iOS | ✅ Full support | Wrap in WKWebView |
| Android | ✅ Full support | Wrap in WebView |
| Windows | ✅ Full support | Wrap in Electron |
| Samsung Tizen | ⚠️ Partial | YouTube embed restricted; opens native YT app |

---

## YouTube API Quota

The free tier gives 10,000 units/day.
- Live status check per channel: ~1 unit
- Recent videos fetch: ~100 units
- Typical session: ~200-500 units

More than enough for normal use. Request a quota increase from Google if the app scales.

---

## Respecting Content Creators

This app is designed as a passthrough — all YouTube content plays through the official YouTube embed player, which means:
- ✅ View counts are tracked normally
- ✅ Ads display for non-Premium users
- ✅ Creator revenue is unaffected
- ✅ WeatherStar 4000+ is a direct passthrough to netbymatt.com
