> **⚠️ HISTORICAL / SUPERSEDED — DO NOT USE AS A REFERENCE.**
> Early planning doc describing the original design where the map read from the
> gallery's `data/data.json` and used Open-Meteo. That design was abandoned — the
> map is now decoupled and uses iNaturalist + NASA POWER via the precompute
> pipeline. See `ARCHITECTURE.md` and `CODEMAP.md` for current reality.
> Archived 2026-06-22.

---

# Bogman Climate Map — Build Instructions

## What You Are Building

A standalone single-page web application called the **Bogman Climate Map**, hosted at `burymeinthebog.com/map`. It displays carnivorous plant native habitat locations on an interactive world map with Köppen climate zone overlays, and shows detailed climate data for each species pin.

This app is built as a **single self-contained HTML file** (`map.html`) with all CSS and JavaScript embedded. It will be injected into a Squarespace page that provides the site's existing header and navigation — so the app itself does not include a header or footer. It must coexist with the existing Squarespace page shell.

The app reads species data from the Bogman Gallery's `data.json` on GitHub. It calls two external APIs (Open-Meteo for climate data, iNaturalist for observation photos) directly from the browser with no server required.

---

## Repository Structure

Create a new repository called `bogman-climate-map` (separate from the gallery repo). Structure:

```
bogman-climate-map/
├── map.html              ← the entire app (HTML + CSS + JS, self-contained)
├── map-data.json         ← climate map overlay data (see Section 3)
├── snapshots/            ← pre-generated PNG embeds (populated later by snapshot script)
│   └── README.md
├── scripts/
│   └── generate-snapshots.js   ← Playwright snapshot script (built later, placeholder now)
├── README.md
└── .gitignore
```

The `map.html` file is what gets embedded in Squarespace via a full-page code block injection. It must be fully functional when fetched via jsDelivr CDN (same pattern as the gallery).

---

## Section 1 — Data Architecture

### 1.1 Primary Data Source: Gallery data.json

Fetch the gallery's `data.json` from GitHub on app load:

```
https://raw.githubusercontent.com/bogmanplantenstein/bogmangallery/main/data/data.json
```

From this file, extract taxa that meet the **pin eligibility rules**:

**Include automatically:**
- `entryType === "species"`
- `entryType === "location"`

**Exclude automatically:**
- `entryType === "cultivar_unreg"`
- `entryType === "cultivar_reg"`
- `entryType === "named_hybrid"` (unless `mapPin.override === true`)

**Manual override:** Any taxon with `mapPin.override === true` AND `mapPin.includedOnMap === true` is always included regardless of entry type. This handles natural hybrids like *Drosera × carbarup*.

**Unmapped taxa:** Eligible taxa that have `mapPin` null, or have `mapPin` but no `lat`/`lng`, are tracked separately as "unmapped" and shown in the unmapped list panel. They do not get a map pin.

### 1.2 Expected Taxon Shape (post-gallery update)

After the gallery update, eligible taxa will have this shape (new fields added by the gallery update):

```json
{
  "id": "txn_692ie83seap",
  "slug": "dionaea_muscipula_typical",
  "genus": "Dionaea",
  "species": "muscipula",
  "subspecies": "typical",
  "entryType": "cultivar_unreg",
  "displayName": "Dionaea muscipula \"typical\"",
  "country": "United States",
  "nativeRange": "Endemic to coastal areas of North and South Carolina...",
  "nativeHabitat": "Grows in wet, acidic, nitrogen-poor soils of longleaf pine savannas...",
  "mapPin": {
    "includedOnMap": true,
    "override": true,
    "coordinatePrecision": "exact",
    "lat": 34.2,
    "lng": -77.9,
    "elevationM": 30,
    "regionCode": "US-NC",
    "countryCode": "US"
  },
  "koppenZone": "Cfa",
  "koppenLabel": "Humid Subtropical",
  "elevationBand": "lowland",
  "inatTaxonId": 49935
}
```

### 1.3 Graceful Degradation

The gallery `data.json` may not have the new fields yet when first testing. Handle gracefully:
- If `mapPin` is null/missing → taxon goes in unmapped list
- If `koppenZone` is null → show pin but omit zone badge in panel
- If `inatTaxonId` is null → omit iNaturalist section entirely
- Never crash on missing fields — use optional chaining throughout

---

## Section 2 — Map Foundation

### 2.1 Libraries

Load from CDN (no npm, no build step):

```html
<!-- Leaflet -->
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>

<!-- Chart.js for climate charts -->
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>

<!-- No other dependencies. All other code is vanilla JS. -->
```

### 2.2 Base Map Tiles

Two tile layers, toggleable:

**Dark (default):**
```
https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png
Attribution: © OpenStreetMap contributors © CARTO
```

**Satellite:**
```
https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}
Attribution: © Esri, Maxar, Earthstar Geographics
```

A tile toggle button in the top-right corner of the map switches between them. Label it with an icon: 🌍 for dark, 🛰️ for satellite.

### 2.3 Initial Map View

- Center: `[20, 10]` (roughly centered on world landmass)
- Zoom: `3`
- Min zoom: `2`, Max zoom: `16`
- `zoomControl: false` (we'll add it in bottom-right instead of default top-left)
- `worldCopyJump: true`

### 2.4 Map Controls Layout

- Zoom control: bottom-right
- Tile toggle: top-right
- Köppen toggle: top-right (below tile toggle)
- Filter panel toggle: top-left
- All controls use Leaflet's `L.Control` system

---

## Section 3 — Köppen Climate Zone Overlay

### 3.1 Data Source

Use the simplified Köppen-Geiger GeoJSON world dataset. The best freely available source is the Beck et al. dataset simplified for web use. Fetch it from:

```
https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson
```

Actually — do not use that. Instead, source the Köppen GeoJSON from this location which has the actual zone polygons:

```
https://raw.githubusercontent.com/delfrrr/delaunator-cpp/master/...
```

**Important:** Finding a reliable hosted Köppen GeoJSON may require searching. The best approach is to **bundle a simplified version** in the repo as `koppen.geojson`. 

Source it from the Beck et al. (2018) Köppen-Geiger dataset available at `https://www.gloh2o.org/koppen/` — download the shapefile, simplify to ~500KB GeoJSON using mapshaper, and commit it to the repo. If this data is not available during build, use a fallback: color the map background tiles only (no polygon layer) and note in README that the GeoJSON needs to be added.

The GeoJSON features should have a property `code` or `Cls` containing the Köppen zone code (e.g. `"Cfa"`, `"Af"`).

### 3.2 Köppen Color Scheme

Use the standard international Köppen color convention:

```javascript
const KOPPEN_COLORS = {
  // Tropical A
  "Af":  "#0000FF", "Am":  "#0077FF", "Aw":  "#46AAFA", "As":  "#46AAFA",
  // Arid B
  "BWh": "#FF0000", "BWk": "#FF9696", "BSh": "#F5A500", "BSk": "#FFDB63",
  // Temperate C
  "Csa": "#FFFF00", "Csb": "#C6C700", "Csc": "#969600",
  "Cwa": "#96FF96", "Cwb": "#64C864", "Cwc": "#329632",
  "Cfa": "#C8FF50", "Cfb": "#64FF50", "Cfc": "#32C800",
  // Continental D
  "Dsa": "#FF00FF", "Dsb": "#C800C8", "Dsc": "#963296", "Dsd": "#966496",
  "Dwa": "#AB82FF", "Dwb": "#B44682", "Dwc": "#FF8282", "Dwd": "#FF2896",
  "Dfa": "#FF6464", "Dfb": "#FF3232", "Dfc": "#C80000", "Dfd": "#820000",
  // Polar E
  "ET":  "#B2B2B2", "EF":  "#686868",
};

function getKoppenColor(code) {
  return KOPPEN_COLORS[code] || "#888888";
}
```

### 3.3 Overlay Rendering

```javascript
const koppenLayer = L.geoJSON(koppenData, {
  style: feature => ({
    fillColor: getKoppenColor(feature.properties.code || feature.properties.Cls),
    fillOpacity: 0.35,
    color: "transparent",
    weight: 0
  }),
  onEachFeature: (feature, layer) => {
    const code = feature.properties.code || feature.properties.Cls;
    layer.bindTooltip(`${code} — ${KOPPEN_LABELS[code] || ''}`, {
      sticky: true,
      className: "koppen-tooltip"
    });
  }
});
```

### 3.4 Toggle Behavior

Köppen overlay is **on by default**. The toggle button in the top-right shows current state. When satellite tiles are active, reduce `fillOpacity` to `0.25` automatically (satellite imagery is busy, overlay needs to be lighter).

---

## Section 4 — Species Pins

### 4.1 Pin Color by Genus

```javascript
const GENUS_COLORS = {
  "Dionaea":    "#FF4444",   // red
  "Drosera":    "#FF69B4",   // hot pink/magenta
  "Pinguicula": "#9B7FD4",   // lavender
  "Utricularia":"#00CED1",   // cyan/teal
  "Byblis":     "#7FBA00",   // lime green
  "default":    "#AAAAAA"    // grey for anything else
};
```

### 4.2 Pin Shape

Use circular SVG markers (not default Leaflet teardrops). Each pin is a filled circle with a white border:

```javascript
function createPin(genus) {
  const color = GENUS_COLORS[genus] || GENUS_COLORS["default"];
  return L.divIcon({
    className: "",
    html: `<svg width="20" height="20" viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="8" fill="${color}" stroke="white" stroke-width="2" opacity="0.9"/>
    </svg>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -12]
  });
}
```

When a pin is selected (panel open), scale it up slightly and add a pulse animation:

```css
.pin-selected circle {
  r: 10;
  animation: pulse 1.5s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 0.9; }
  50% { opacity: 0.5; }
}
```

### 4.3 Pin Tooltip (hover)

On hover, show a small tooltip with the display name only. Keep it minimal — the full data is in the side panel.

### 4.4 All Pins Visible

No clustering. Show all individual pins at all zoom levels. This is intentional — the density pattern showing biodiversity hotspots (SW Australia for Drosera, Mexico for Pinguicula) is meaningful information.

### 4.5 Coordinate Precision Visual Distinction

Pins with `coordinatePrecision !== "exact"` render with a dashed border instead of solid:

```javascript
html: `<svg width="20" height="20" viewBox="0 0 20 20">
  <circle cx="10" cy="10" r="8" fill="${color}" 
    stroke="white" stroke-width="2" stroke-dasharray="3,2" opacity="0.7"/>
</svg>`
```

This gives an immediate visual signal that the location is approximate.

### 4.6 Region/Country Highlight on Click

When a pin with `coordinatePrecision === "regional"` or `"country"` is clicked, in addition to opening the side panel, highlight the relevant boundary polygon on the map.

For this you need world administrative boundary GeoJSON. Use Natural Earth data:
- Countries: `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson`
- States/provinces: `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_1_states_provinces.geojson`

Load both lazily (fetch only when first needed). When a regional pin is clicked:
1. Find the matching feature by `regionCode` (ISO 3166-2) in the states layer, or `countryCode` (ISO 3166-1) in the countries layer
2. Add a highlight layer: `fillColor: pinColor, fillOpacity: 0.15, color: pinColor, weight: 2, dashArray: "6,4"`
3. Remove the highlight layer when the panel closes or another pin is clicked

---

## Section 5 — Side Panel

### 5.1 Layout

The side panel occupies the **right 40% of the map container** on desktop, sliding in from the right when a pin is clicked. On mobile (< 768px), it becomes a **bottom drawer** occupying 60% of screen height.

The map reflows to fill the remaining space (left 60% on desktop) when the panel opens. Use CSS transitions for smooth open/close.

Panel close button: `×` in the top-right corner of the panel.

### 5.2 Panel Structure: Collapsed State (default on open)

When a pin is first clicked, the panel opens in **collapsed summary** mode:

```
┌─────────────────────────────────────────────┐
│  × (close)                                  │
│                                             │
│  Dionaea muscipula "typical"                │  ← displayName, styled italic
│  Coastal North Carolina · 30m               │  ← location label + elevation
│  🇺🇸 United States                          │  ← country with flag emoji
│                                             │
│  [Cfa] Humid Subtropical                    │  ← Köppen badge, colored chip
│  [Lowland] [Coastal Wetland]                │  ← elevation band + habitatId badges
│                                             │
│  ── Annual Summary ──────────────────────   │
│  Temp range:   15–33°C / 59–91°F           │
│  Annual precip: 1,340mm                     │
│  Annual sunshine: 2,600 hrs                 │
│                                             │
│  [↓ Full Climate Data]                      │  ← expand button
│                                             │
│  [View in Bogman Gallery →]                 │  ← deep link (uses slug)
└─────────────────────────────────────────────┘
```

The **annual summary values come from the Open-Meteo API** — fetch them when the panel opens. Show a loading spinner in place of values while fetching. If the API call fails, show "Climate data unavailable" gracefully.

### 5.3 Panel Structure: Expanded State

Clicking "Full Climate Data" smoothly expands the panel to show:

#### Monthly Climate Chart

A Chart.js dual-axis chart:
- **Temperature band**: shaded area between monthly min and monthly max (line chart with fill between)
- **Precipitation bars**: bar chart on secondary y-axis
- X-axis: Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec
- Both datasets on the same chart instance using Chart.js mixed type

Chart color scheme (dark theme):
- Temperature min line: `rgba(100, 180, 255, 0.8)` (cool blue)
- Temperature max line: `rgba(255, 140, 60, 0.8)` (warm orange)
- Fill between: `rgba(150, 160, 200, 0.15)`
- Precipitation bars: `rgba(80, 160, 240, 0.6)`
- Chart background: transparent
- Grid lines: `rgba(255,255,255,0.08)`
- Text: `rgba(255,255,255,0.7)`

Below the temperature lines, add two toggleable overlays (checkboxes or pill toggles):
- ☁️ Humidity (% relative humidity, line chart, right axis)
- ☀️ Solar Radiation (kWh/m²/day, area chart, right axis)

Only one extra overlay visible at a time.

#### Climate Normals Table

A two-column table, 12 rows (one per month) plus a totals/averages row:

| Month | Avg High | Avg Low | Precip | Humidity | Sun hrs |
|-------|----------|---------|--------|----------|---------|
| Jan   | 14°C/57°F | 5°C/41°F | 95mm | 78% | 142 |
| ...   | ...      | ...     | ...    | ...      | ...     |
| **Annual** | **33°C** | **1°C** | **1,340mm** | **72%** | **2,600** |

Show temperature in the currently selected unit (°F or °C). The F/C toggle is a small pill button in the panel header — persists to localStorage.

#### iNaturalist Photo Strip

Only shown if `inatTaxonId` is not null.

Query:
```
GET https://api.inaturalist.org/v1/observations
  ?taxon_id={inatTaxonId}
  &lat={pin.lat}
  &lng={pin.lng}
  &radius=20
  &quality_grade=research
  &photos=true
  &per_page=6
  &order_by=votes
```

If the radius query returns 0 results, fall back to:
```
GET https://api.inaturalist.org/v1/observations
  ?taxon_id={inatTaxonId}
  &quality_grade=research
  &photos=true
  &per_page=6
  &order_by=votes
```

Render as a horizontal scrollable strip of photo thumbnails (square crops, ~80px). On hover: show observer username. Clicking a thumbnail opens the observation on iNaturalist in a new tab.

Below the strip: `"View all observations on iNaturalist →"` linking to `https://www.inaturalist.org/taxa/{inatTaxonId}`.

If inatTaxonId is null: omit this section entirely (no placeholder).

#### Gallery Link

```
[View in Bogman Gallery →]
```

Links to `https://www.burymeinthebog.com/gallery#{slug}`. This is a placeholder deep-link — the gallery will eventually support anchor-based species navigation. For now the link still goes to the gallery page (the hash may not scroll yet — that's okay for phase 1).

### 5.4 Temperature Unit Toggle

A `°F / °C` pill toggle in the panel header. Default: `°F`.

All temperature values throughout the panel update instantly when toggled. Persist choice to `localStorage` key `bmg_temp_unit`.

Conversion:
```javascript
const toDisplay = (celsius, unit) => 
  unit === 'F' ? Math.round(celsius * 9/5 + 32) + '°F' : Math.round(celsius) + '°C';
```

---

## Section 6 — Open-Meteo Climate API

### 6.1 Endpoint

```
GET https://climate-api.open-meteo.com/v1/climate
```

Parameters:
```
latitude={lat}
longitude={lng}
start_date=1991-01-01
end_date=2020-12-31
models=EC_Earth3P_HR
monthly=temperature_2m_max,temperature_2m_min,precipitation_sum,relative_humidity_2m_mean,shortwave_radiation_sum
```

This returns 30-year climate normal data (1991–2020 standard climatological period) as monthly aggregates.

### 6.2 Response Processing

The response contains monthly arrays. Process into a structured object:

```javascript
function processClimateData(raw) {
  const monthly = raw.monthly;
  // monthly arrays are indexed 0-11 (Jan-Dec)
  return {
    tempMax: monthly.temperature_2m_max,      // °C
    tempMin: monthly.temperature_2m_min,      // °C
    precip: monthly.precipitation_sum,         // mm
    humidity: monthly.relative_humidity_2m_mean, // %
    solar: monthly.shortwave_radiation_sum,    // MJ/m² → convert to kWh: divide by 3.6
    // Derived annual summary:
    annualPrecip: monthly.precipitation_sum.reduce((a,b) => a+b, 0),
    peakHigh: Math.max(...monthly.temperature_2m_max),
    peakLow: Math.min(...monthly.temperature_2m_min),
    annualSunHours: monthly.shortwave_radiation_sum.reduce((a,b) => a+b, 0) / 3.6 * 24 // approx
  };
}
```

### 6.3 Caching

Cache climate responses in memory during the session (a simple JS Map keyed by `"${lat},${lng}"`). Do not use localStorage for climate data — it's too large and can be re-fetched. If a user clicks the same pin twice in a session, serve from the in-memory cache.

### 6.4 Error Handling

If the API call fails or times out (10s timeout):
- Show "Climate data unavailable for this location" in the panel
- Do not crash — the rest of the panel (species info, iNat photos) should still render

---

## Section 7 — Unmapped List Panel

### 7.1 Toggle

A button in the bottom-left of the map: `📋 Unmapped (N)` where N is the count of eligible taxa without coordinates. Clicking it opens the unmapped list panel.

### 7.2 Panel Contents

A scrollable list of all eligible taxa (species + location entry types) that have no `mapPin.lat`/`mapPin.lng`. Sorted alphabetically by genus then species.

Each row:
```
Drosera [species]  •  [country]  •  entryType
```

For each row, show a small icon indicating what's missing:
- 📍 No coordinates
- 🌍 No Köppen zone
- ↕ No elevation

This gives a clear data-entry queue view.

### 7.3 Export Button

A small "Copy as CSV" button that copies the unmapped list to clipboard as:
```
id,slug,displayName,country,entryType
txn_abc123,drosera_capensis,Drosera capensis,South Africa,species
...
```

Useful for batch-editing coordinates offline.

---

## Section 8 — Filter Controls

A collapsible filter panel in the top-left of the map (toggled by a ☰ button).

### Filters

**By Genus** (multi-select checkboxes, all checked by default):
- ☑ Dionaea (N)
- ☑ Drosera (N)
- ☑ Pinguicula (N)
- ☑ Utricularia (N)
- ☑ Byblis (N)

**By Köppen Zone Group** (multi-select):
- ☑ Tropical (A)
- ☑ Arid (B)
- ☑ Temperate (C)
- ☑ Continental (D)
- ☑ Polar (E)
- ☑ No zone data

**By Elevation Band** (multi-select):
- ☑ Lowland
- ☑ Intermediate
- ☑ Highland
- ☑ Ultra-Highland
- ☑ Not set

When filters change, hide non-matching pins (remove from map layer, don't destroy) and update the pin count display. A "Reset filters" link appears when any filter is non-default.

---

## Section 9 — URL / Deep-Link System

### URL Parameters

```
/map                                    → world view, all pins, no panel
/map?taxon=txn_692ie83seap              → open panel for this taxon (by txn ID)
/map?slug=dionaea_muscipula_typical     → open panel for this taxon (by slug)
/map?taxon=txn_abc123&embed=true        → embed mode (see Section 10)
```

On load, read URL params and:
1. If `taxon` or `slug` param present: find the matching taxon, fly the map to its pin, open the side panel
2. If `embed=true`: render in embed mode

Update the URL bar using `history.replaceState` when a pin is clicked (without page reload), so the URL is always shareable/bookmarkable. Closing the panel clears the taxon param.

---

## Section 10 — Embed Mode

When `embed=true` is in the URL, render a compact non-interactive view for embedding as a static image in the gallery (the actual static PNG generation happens via a Playwright script later — but the embed mode must be a live renderable page too, since the snapshot script will open it in a browser).

### Embed Layout

Fixed dimensions: `600 × 420px` total.

```
┌──────────────────────────────────────────┐
│                                          │
│      [Map — country/continent zoom]      │  280px
│         ● highlighted pin               │
│                                          │
├──────────────────────────────────────────┤
│  Dionaea muscipula                       │
│  Coastal NC, USA  ·  30m                │  140px
│  [Cfa] Humid Subtropical  [Lowland]     │
│  ██ Jan ██ Feb ██ Mar ... (mini bars)   │
│  Temp: 15–33°C   Precip: 1,340mm/yr    │
└──────────────────────────────────────────┘
```

In embed mode:
- Map is not pannable or zoomable (`dragging.disable()`, `scrollWheelZoom.disable()`, etc.)
- No controls visible (no zoom buttons, no toggles, no filter panel)
- Köppen overlay visible but no tooltip on hover
- The entire embed div is wrapped in an `<a>` tag pointing to the full map URL for that taxon
- No side panel — data is shown in the compact card below the map
- The mini climate bar chart in the embed is a simplified version: just 12 precipitation bars in a single color, tiny, no labels. Temp range shown as text only.

The embed URL structure:
```
https://raw.githubusercontent.com/bogmanplantenstein/bogman-climate-map/main/map.html
  ?taxon=txn_692ie83seap&embed=true
```

Or via jsDelivr (preferred for CDN caching):
```
https://cdn.jsdelivr.net/gh/bogmanplantenstein/bogman-climate-map@main/map.html
  ?taxon=txn_692ie83seap&embed=true
```

---

## Section 11 — Visual Design

### 11.1 Design Direction

**Dark botanical cartographic** — scientific precision meets natural world aesthetics. The map is the hero; UI chrome is minimal and unobtrusive. Think field guide meets modern data visualization.

### 11.2 Color Palette (CSS Variables)

```css
:root {
  --bg:           #0d1117;   /* near-black background */
  --bg-panel:     #161b22;   /* panel background */
  --bg-elevated:  #1f2937;   /* cards, inputs */
  --border:       #30363d;   /* subtle borders */
  --text-primary: #e6edf3;   /* primary text */
  --text-muted:   #8b949e;   /* secondary text */
  --accent:       #3fb950;   /* bogman green — used for interactive elements */
  --accent-dim:   #1a4a2a;   /* dimmed green for backgrounds */
  --danger:       #f85149;
  --warning:      #d29922;

  /* Genus colors (match Section 4.1) */
  --color-dionaea:    #FF4444;
  --color-drosera:    #FF69B4;
  --color-pinguicula: #9B7FD4;
  --color-utricularia:#00CED1;
  --color-byblis:     #7FBA00;
}
```

### 11.3 Typography

Load from Google Fonts:
```html
<link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;1,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

- **Species names**: Lora italic (`font-family: 'Lora', serif; font-style: italic`)
- **UI labels, data values**: system-ui stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`)
- **Coordinates, zone codes**: JetBrains Mono (`font-family: 'JetBrains Mono', monospace`)

### 11.4 Layout

The app fills the full width and height of the Squarespace content area below the header. Use:

```css
#bmg-map-app {
  width: 100%;
  height: calc(100vh - 80px);  /* subtract approx header height */
  display: flex;
  position: relative;
  overflow: hidden;
  background: var(--bg);
}

#map-container {
  flex: 1;
  height: 100%;
  transition: flex 0.3s ease;
}

#side-panel {
  width: 0;
  height: 100%;
  overflow: hidden;
  transition: width 0.3s ease;
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
}

#side-panel.open {
  width: 40%;
  min-width: 320px;
  max-width: 520px;
  overflow-y: auto;
}
```

### 11.5 Köppen Badge Style

```css
.koppen-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid rgba(255,255,255,0.15);
}
/* Color is set inline from KOPPEN_COLORS with 20% opacity background */
```

### 11.6 Scrollbar Styling (panel)

```css
#side-panel::-webkit-scrollbar { width: 4px; }
#side-panel::-webkit-scrollbar-track { background: transparent; }
#side-panel::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
```

---

## Section 12 — Squarespace Integration

### 12.1 Embedding

The `map.html` file is served via jsDelivr. In Squarespace:
1. Create a new page at `/map`
2. Add a **Code Block** that covers the full content area
3. Paste:

```html
<div id="bmg-map-root"></div>
<script>
  fetch('https://cdn.jsdelivr.net/gh/bogmanplantenstein/bogman-climate-map@main/map.html')
    .then(r => r.text())
    .then(html => {
      document.getElementById('bmg-map-root').innerHTML = html;
      // Re-execute scripts
      document.querySelectorAll('#bmg-map-root script').forEach(old => {
        const s = document.createElement('script');
        s.textContent = old.textContent;
        old.parentNode.replaceChild(s, old);
      });
    });
</script>
```

**Alternative (simpler):** If Squarespace allows full-page iframe injection, use:
```html
<iframe src="https://cdn.jsdelivr.net/gh/bogmanplantenstein/bogman-climate-map@main/map.html"
  style="width:100%;height:calc(100vh - 80px);border:none;"></iframe>
```

The iframe approach is simpler and more reliable. Use it unless there's a reason not to.

### 12.2 CORS

All external API calls (Open-Meteo, iNaturalist, GitHub raw) support CORS from browser. No proxy needed.

---

## Section 13 — Performance Requirements

- Map must be interactive within **3 seconds** on a standard connection
- Species pins must appear before climate data loads (pins render from `data.json`, climate data loads lazily per panel open)
- Köppen GeoJSON loads asynchronously — map is usable with pins before the overlay appears
- iNaturalist photos load lazily (only when panel is open and section is scrolled into view)
- Climate API responses are cached in-session memory
- No loading screen — show the map immediately, progressively enhance

---

## Section 14 — Phase 1 Scope (Build This Now)

Build everything in Sections 1–13 as a fully working application. The following are explicitly **deferred to later phases** — do not build them now, but do not build anything that would prevent them:

- Snapshot generation script (Playwright) — `scripts/generate-snapshots.js` placeholder only
- Gallery embed integration — the `?embed=true` mode must work, but no gallery wiring needed
- Trewartha zone overlay — architecture supports multiple overlay layers, but only Köppen needed now
- iNaturalist observation pin layer (secondary observation dots on the map)
- Genus-specific custom SVG pin icons (current colored circles are phase 1)
- Search bar / type-to-find species

---

## Section 15 — Testing Checklist

Before delivering, verify all of the following:

**Data loading:**
- [ ] `data.json` fetches successfully from GitHub
- [ ] Eligible taxa (species + location) are correctly filtered
- [ ] Taxa with `mapPin.override: true` and `includedOnMap: true` appear even if cultivar/hybrid type
- [ ] Taxa with no `mapPin` or no coords appear in unmapped list
- [ ] App handles missing new fields gracefully (taxa without `koppenZone`, etc.)

**Map:**
- [ ] Map loads and is interactive
- [ ] Dark tiles load as default
- [ ] Satellite tile toggle works
- [ ] Köppen overlay renders with correct colors
- [ ] Köppen toggle shows/hides overlay
- [ ] All pins render at correct coordinates
- [ ] Approximate-precision pins have dashed border
- [ ] Clicking a regional pin highlights the correct state polygon
- [ ] Clicking a country-precision pin highlights the correct country

**Side panel:**
- [ ] Panel opens on pin click, closes on × or clicking map background
- [ ] Collapsed summary shows correct species info, Köppen badge, annual climate summary
- [ ] Climate data fetches from Open-Meteo and populates correctly
- [ ] Loading state shown while fetching
- [ ] Failed API call handled gracefully
- [ ] Expand button reveals full chart and table
- [ ] Temperature toggle (°F/°C) works and persists
- [ ] Monthly chart renders with correct data
- [ ] Humidity and solar radiation toggles work
- [ ] iNat photo strip loads (for taxa with inatTaxonId)
- [ ] iNat fallback (global observations) triggers when radius returns 0
- [ ] Gallery link uses correct slug

**URL system:**
- [ ] Clicking a pin updates the URL with `?taxon=` parameter
- [ ] Loading `/map?taxon=txn_abc123` opens correct panel on load
- [ ] Loading `/map?slug=drosera_capensis` opens correct panel on load
- [ ] Closing panel clears URL parameter

**Embed mode:**
- [ ] `/map?taxon=X&embed=true` renders compact embed layout
- [ ] Map is non-interactive in embed mode
- [ ] Compact climate card shows correct data
- [ ] Entire embed is clickable to full map

**Filters:**
- [ ] Genus filter hides/shows correct pins
- [ ] Köppen group filter works
- [ ] Elevation band filter works
- [ ] Reset filters restores all pins

**Unmapped list:**
- [ ] Shows all eligible unmapped taxa
- [ ] Count in button is accurate
- [ ] Copy CSV button works

**Responsive:**
- [ ] Side panel is right-side on desktop (> 768px)
- [ ] Side panel is bottom drawer on mobile (< 768px)
- [ ] Map is usable on mobile

---

## Section 16 — Deliverables

1. `map.html` — complete, self-contained, working application
2. `README.md` — setup instructions, how to update data, how to add the Squarespace snippet
3. `koppen.geojson` — the Köppen zone polygon data used by the app (commit to repo)
4. `snapshots/README.md` — placeholder explaining the future snapshot workflow
5. `scripts/generate-snapshots.js` — placeholder file with a comment block explaining what it will do

The primary deliverable is `map.html`. When opening it directly in a browser (file:// or local server), the app must be fully functional.
