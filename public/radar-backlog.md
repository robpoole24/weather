# WeatherTV Radar Feature Backlog

## In Progress / Next Up
- Canadian radar via MSC GeoMet (composite WMS layer, no site selector needed)
- Travel Forecast international cities (Open-Meteo for non-NWS locations)

## Prioritized Backlog

### 1. Hurricane Tracking
- Path prediction models (NHC official track + cone of uncertainty)
- Category strength forecast overlays
- Multiple model spaghetti paths where available
- Sources: NHC API, NOAA GFS/Euro model track data

### 2. Velocity / Echo Tops / Correlation Coefficient
- Base Velocity (BR) and Storm Relative Velocity (SRV) products
- Echo Tops (EET)
- Correlation Coefficient (CC)
- Goal: consistent scaling with base reflectivity map + animation showing rotation

### 3. GOES Satellite Imagery
- Visible + IR channel tiles with animation
- Show cloud movement / convective development
- Source: NOAA GOES-East/West (already public tile access)

### 4. Seamless Multi-Site Composite Radar
- Remove requirement to select a single NWS radar site
- Options: blend neighboring NEXRAD sites / stitch regional composites
- MRMS (Multi-Radar Multi-Sensor) composite is the ideal source — already a national mosaic
- Note: Canadian MSC GeoMet is already composite-by-default; model for what US should look like

### 5. European Radar + Weather
- MSC → Canadian ✓ (done)
- Target Euro met services: EUMETNET OPERA composite radar (covers EU)
- Forecast data: Open-Meteo covers all European cities via same API path as international travel cities
- Travel Forecast European city list (confirmed): Paris, London, Barcelona, Madrid, Berlin, Rome, Amsterdam

## Notes
- Items 2 and 4 are technically related — seamless composite makes velocity/ET/CC more useful
- MRMS (item 4) also solves the Canadian border gap since it ingests Canadian radar data too
- Hurricane tracking (item 1) is highest user-value during Jun–Nov season
