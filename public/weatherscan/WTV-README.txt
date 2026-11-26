Weatherscan on Weather TV
=========================

This folder is Weatherscan v2 by Mist Weather Media
(https://github.com/MistWeatherMedia/weatherscan-v2), a recreation of The Weather Channel's
Weatherscan, licensed under the GNU General Public License v3 (LICENSE.txt). It is offered
here, modified, as channel 5 of the Weather TV Channel Guide and the Weatherscan button on
watchweathertv.com. Our modified source is these files themselves.

Weather TV's changes (Nov 2026)
-------------------------------
- Weather data: every request that went to weather.com's paid API (api.weather.com) now goes to
  Weather TV's own server (/wxapi, weatherscan-api.js in the site's repo), which answers in the
  same format from the National Weather Service (forecast wording, alerts, stations) and
  Open-Meteo (conditions, hourly/daily numbers, normals and records). No weather.com keys.
- Maps: MapLibre with our own style (js/wtv.js) in place of Mapbox and its hosted style.
  Outlines in geo/: Natural Earth land and country borders (public domain), US Census states,
  counties and shorelines (public domain, via us-atlas), lakes from OpenStreetMap via geo-maps
  (LICENSE-lakes.txt; © OpenStreetMap contributors).
- Radar: Iowa State University (IEM) NEXRAD frames; satellite: IEM GOES-East infrared.
- Fonts: Barlow / Barlow Condensed (SIL Open Font License, fonts/OFL-Barlow.txt) in place of
  the commercial Frutiger and Interstate fonts, under the same family names.
- Music: Weather TV's WeatherStar music list in place of the bundled tracks; narration off
  (the bundled music and narrator clips are not included).
- Branding: Weather TV logos in place of The Weather Channel and IntelliStar logos on the
  startup screen and the provider logo; our own crawl lines; no update pop-ups.
- Packages left out (no free data source): health/pollen, golf, garden, ski, airport, traffic.
- Location: Weather TV opens it as /weatherscan/?lat,lon;Name (no IP lookup service).
