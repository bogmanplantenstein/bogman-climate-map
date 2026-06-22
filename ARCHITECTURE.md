# Bogman Climate Map — Architecture & Cloning Guide

A reusable reference for the iNaturalist-driven climate/soil map, written so it can
be **forked into new versions for other plant/animal groups** (orchids, ferns,
amphibians, etc.). It explains *how the system is shaped*, *which parts are
group-specific*, and *what to change to retarget it*.

> Single-sentence summary: a **static, single-file web app** (`map.html`) plots
> precomputed iNaturalist observations on a Leaflet map and shows per-location,
> per-observation, and per-species **climate + soil + elevation** estimates;
> a **Node script run by GitHub Actions** does all the heavy data fetching
> monthly and commits compact JSON back to the repo, which the app reads at load.

---

## 1. Design philosophy (why it's shaped this way)

| Principle | Consequence |
|---|---|
| **Static hosting, no backend** | App is one `map.html` served by GitHub Pages / jsDelivr CDN. No server, no DB. All "state" that needs sharing lives in the URL. |
| **Precompute everything expensive** | Climate (NASA POWER), elevation, soil (SoilGrids/WRB), and species envelopes are fetched **offline** by a scheduled script and committed as JSON. The browser never makes slow/rate-limited bulk calls. |
| **Live calls only for single points** | When the user clicks a spot or opens one observation, the app makes *one* small live request (POWER + elevation + reverse-geocode). Acceptable latency for a single action. |
| **One big self-contained HTML file** | All CSS + JS inline in `map.html`. No build step, no bundler, no npm for the front end. Edit and serve directly. |
| **Compact array-encoded data** | Observations are stored as positional arrays (`[id,lat,lng,taxonIdx,date,flags,photoId,koppen]`), not objects, to keep the payload small (hundreds of thousands of obs). |
| **Graceful degradation** | Every external fetch has a fallback or null-guard; missing data hides a UI section rather than erroring. |

---

## 2. Repository layout

```
<repo root>/
├── map.html                  ← THE ENTIRE FRONT-END APP (HTML+CSS+JS, ~9,200 lines)
│                                (navigate it via CODEMAP.md — see §4)
├── README.md                 ← hosting / embedding instructions
├── ARCHITECTURE.md           ← this file
├── inat/                     ← all precomputed data (committed by the workflow)
│   ├── all.json              ← every observation, all genera (desktop loads this)
│   ├── <genus>.json          ← per-genus obs (mobile loads only selected genera)
│   ├── species-data.json     ← per-species climate envelopes + phenology + elevation
│   ├── species-soil.json     ← per-species dominant soils
│   ├── climate-cache.json    ← per 0.5° cell raw climate (avoids re-fetching; ~14 MB)
│   ├── elev-cache.json       ← per-cell ASTER elevations
│   ├── soil-cache.json       ← per-cell SoilGrids + WRB
│   ├── nepenthes-elevation.json ← GROUP-SPECIFIC: species elevation bands (example add-on)
│   └── fetch-report.json / species-report.json ← run summaries
├── scripts/
│   ├── fetch-inat-data.js    ← THE DATA PIPELINE (Node ESM, ~1,730 lines)
│   ├── gen-codemap.js        ← regenerates CODEMAP.md (line-numbered map.html index)
│   └── package.json          ← deps: georaster (for Köppen raster sampling)
├── CODEMAP.md                ← AUTO-GENERATED navigation index for map.html
├── koppen_geiger_tif/        ← Köppen raster (sampled client-side for zone lookup)
└── .github/workflows/
    ├── fetch-inat-data.yml   ← monthly cron: obs refresh + species climate
    ├── fetch-soil-data.yml   ← one-shot: precompute soil per cell
    └── fetch-wrb-data.yml    ← one-shot: precompute WRB soil class per cell
```

---

## 3. The data pipeline — `scripts/fetch-inat-data.js`

Node ESM script, run with a subcommand: `node scripts/fetch-inat-data.js <obs|species|soil|wrb>`.
Paced politely under each API's rate limit; caches aggressively so re-runs only
fetch what's missing (safe to re-run after a timeout).

### Config block (top of file) — **the main retargeting surface**
```js
const GENERA = ['Aldrovanda','Byblis', … ];   // ← the taxa you track
const QUALITY_GRADES = ['research','needs_id'];
const GRID_DEG = 0.5;            // climate aggregation cell (~55 km)
const OM_MIN_CELLS = 1;          // min occupied cells to publish a species page
const LAPSE_RATE = 6.5/1000;     // fallback lapse rate (a humidity-aware one is computed too)
const POWER_API  = 'https://power.larc.nasa.gov/api/temporal/daily/point';
const ELEV_API   = 'https://api.opentopodata.org/v1/aster30m';
const CLIM_CACHE_VER = 4;        // bump to force a full climate re-fetch (4 added DLI/sunlight)
```

### Stage 1 — Observations (`obs`)
- Pages the iNat API per genus (`/observations`, research + needs_id), recursing
  when a query exceeds 10k results (iNat's hard pagination cap) by splitting on
  date ranges.
- Writes `all.json` (everything) and `<genus>.json` (per-genus, for mobile).
- Each obs is a positional array; a parallel `taxa` table maps `taxonIdx → [taxonId, name, genus, commonName]`.
- A bitmask `flags` field encodes booleans: `F_NEEDSID=1, F_OBSCURED=2, F_PHOTO=4`.
- Köppen zone is sampled per obs from the raster at fetch time and stored inline.

### Stage 2 — Species climate envelopes (`species`)
1. **Grid:** group all obs into 0.5° cells; pick one *representative point* per
   cell (the densest local cluster) — so a species with 10k obs in one cell still
   contributes one climate sample, not 10k.
2. **Elevation:** batch-fetch ASTER 30m elevation per representative (cached).
3. **Climate:** fetch NASA POWER daily `T2M_MAX/T2M_MIN/PRECTOTCORR/RH2M/ALLSKY_SFC_SW_DWN`
   for each cell (cached in `climate-cache.json` keyed by cell — the expensive step).
   Shortwave radiation is converted to **DLI** (Daily Light Integral, mol/m²/day ≈ MJ × 2.02).
4. **Lapse correction:** adjust each cell's temps from the model grid elevation to
   the cell's true elevation using a **humidity-aware lapse rate** (`lapseRateCkm`)
   — blends dry-adiabatic (~9.8 °C/km) toward moist-adiabatic (~4–6 °C/km) by RH.
5. **Aggregate per species** (split N/S hemisphere so seasons align):
   - `avgHigh/avgLow` = mean across cells of each cell's hottest/coldest-month mean
   - `hotTypical/coldTypical` = mean across cells of per-cell daily extremes
   - `hotLimit/coldLimit` = p90/p10 **across cells** of those extremes
   - `monthly_nh/_sh` = per-month [p25,p50,p75] envelope for high/low/precip/rh/**dli** + daily-extreme band
   - `elev` = min/max/p10/p90/median across cells
6. **Phenology:** per species, fetch iNat "Flowers and Fruits" annotation
   histograms (Flowering / Buds / Fruits), wild-only, split by hemisphere.
7. **iNat taxa info:** photo + Wikipedia summary per species.
   → writes `species-data.json`.

### Stage 3 — Soil (`soil`, `wrb`)
- Per cell: SoilGrids 250m (pH, organic C, N, sand) + WRB reference soil group.
- Cached in `soil-cache.json`; aggregated to `species-soil.json`.

### GitHub Actions
- `fetch-inat-data.yml` runs **monthly** (`obs` then `species`), commits `inat/*`
  back to `main` via a token-in-URL push (the `actions/checkout` extraheader auth
  can expire on multi-hour jobs). Failure/timeout steps still commit partial caches.
- Soil/WRB are manual one-shots (data is static).

---

## 4. The front-end — `map.html`

One file (~9,200 lines). Loads Leaflet + Chart.js + Supercluster from CDNs.

> **Navigating it:** the file is divided by `// ════` banner comments. **`CODEMAP.md`**
> (auto-generated by `scripts/gen-codemap.js`) is a line-numbered index of every
> section and top-level function — read it first to jump straight to code. Line
> numbers drift as the file changes, so **grep the banner titles** (stable anchors),
> e.g. `grep -n "CLIMATE MATCH" map.html`. Regenerate after edits:
> `node scripts/gen-codemap.js`.

Structure (top→bottom):

| Region | What it is |
|---|---|
| `<style>` | All CSS. Dark theme via CSS vars (`--accent`, `--bg-panel`, …). |
| HTML body | `#map`, `#search-container`, `#region-chip`, `#side-panel`, `#inat-panel` (filters), reusable `#bmg-modal-overlay`. |
| Constants | `INAT_GENERA`, `INAT_GENUS_COLORS`, Köppen zone tables (`BECK_ZONES`/`BECK_COLORS`), USDA zones, obs field indices (`OBS_ID=0…`), flag bits. |
| Köppen overlay | Raster sampled in-browser via `getKoppenAt(lat,lng)`; colored tile layer + filter. |
| Climate helpers | `fetchSearchClimateNormals` (live POWER for a point), `lapseRateCkm`, `applyHumidityLapse`, `sampleCellElevationRange` (adaptive 2-pass elevation over a cell). |
| Charts/tables | `buildClimateChart`, `buildClimateTable`, `buildLightTable`, `extremeBoxVals`, `climateMethodologyHtml`. |
| Search | `fetchNominatim`, `searchInatTaxa` (in-memory species search), `renderSuggestions`, `selectSearchResult` → routes to species / location / **region** handlers. |
| Region filter | `selectRegionResult` (fetch boundary polygon, point-in-polygon mask), `pointInRings`, region chip. |
| iNat layer | Web-worker Supercluster for **exact** points; `buildInatFeatures` (applies all filters), `drawInatClusters`, `drawObscuredBoxes` (obscured obs as 0.2° boxes-with-counts, *outside* the cluster engine). |
| Panels | `openInatObsPanel` (one obs: climate/soil/elevation, obscured→elevation range + Low/Mid/High switcher), `openSpeciesSidebar`/`buildSpeciesSidebarContent` (envelope, phenology, soil), `buildLocationPanel` (clicked spot). |
| Deep links | `setDeepLink`/`handleUrlParams`/`buildShareUrl` + copy-link buttons. Params: `?sp=` species, `?obs=` observation, `?at=lat,lng,z` location, `?region=` admin region, legacy `?taxon=`. |
| Soil | `getSoilForLocation` (precomputed cache → live SoilGrids fallback), `renderSoilBody`. |
| `init()` | Loads obs data, builds filters, renders pins, enables iNat layer (on by default), then `handleUrlParams()`. |

### Key client-side patterns
- **Web worker for clustering.** Supercluster runs off-main-thread (`INAT_WORKER_SRC`
  is an inline blob worker). `buildInatFeatures` posts the filtered GeoJSON; the
  worker returns clusters/leaves per viewport.
- **Obscured observations are special.** iNat snaps them to a ~0.2° grid. They're
  pulled *out* of the cluster engine and always drawn as one box-with-count per
  cell at every zoom (no morphing circles↔boxes). Climate for them is shown as a
  **range** across the cell's elevation span.
- **°F/°C toggle** updates any element with `data-celsius` (single) or
  `data-celsius-range="lo,hi"` (range) in place — no re-render.
- **Lazy panels.** Climate/soil sections in the obs panel load on first expand.
- **Deep links are the only shared state** — there is no server session.

---

## 5. External services (all free, mostly keyless)

| Service | Used for | Auth | Notes |
|---|---|---|---|
| **iNaturalist API** | observations, taxa, phenology, single-obs lookup | token (Secret) for bulk; keyless for single | 100 req/min; 10k pagination cap (script recurses) |
| **NASA POWER (MERRA-2)** | daily temp/precip/RH/radiation | none | ~50 km native grid; no per-IP daily cap |
| **Open-Meteo Elevation** | client-side elevation (Copernicus GLO-90) | none | **CORS-enabled** — used in browser |
| **OpenTopoData (ASTER 30m)** | pipeline elevation | none | **NOT CORS** — Node-only |
| **Nominatim (OSM)** | geocode search, reverse-geocode, region polygons | none | 1 req/s; needs `Accept-Language`; `polygon_geojson=1` for borders |
| **SoilGrids 250m / ISRIC** | soil pH, C, N, sand, WRB class | none | pipeline-precomputed per cell |
| **Köppen-Geiger raster** | climate zone per point | n/a | bundled in repo, sampled client-side |

---

## 6. How to clone this for a different species group

Most of the system is group-agnostic. The retargeting steps, roughly in order:

1. **New repo + accounts.** Set the commit identity and remote. (For Bogman work
   this auto-routes; for a new group decide which GitHub account.)
2. **Pick the taxa.** Edit `GENERA` in `fetch-inat-data.js`. The list can be genera,
   families, or any iNat taxon — the fetch just needs iNat taxon IDs/names. If your
   group isn't naturally split by genus, change the per-"genus" file split or use a
   single combined file.
3. **Genus colors + display.** Update `INAT_GENUS_COLORS` and `INAT_GENERA` in
   `map.html`. Update labels/titles ("carnivorous plant" → your group), the welcome
   modal copy, and README hosting URLs.
4. **Run the pipeline.** Trigger the workflow (or run locally with an iNat token):
   `obs` → `species` → `soil`/`wrb`. First run is the slow one; caches make
   subsequent runs cheap.
5. **Group-specific enrichments (optional).** The Nepenthes example shows the
   pattern: a curated `inat/<group>-elevation.json` of per-species elevation bands,
   loaded client-side to *narrow* obscured-observation elevation estimates. Any
   group-specific reference data (host plants, depth ranges for aquatics, etc.) can
   follow the same "small JSON + a guarded client lookup" pattern.
6. **Decide what's relevant.** Soil matters for terrestrial plants; for aquatic or
   animal groups you may drop the soil pipeline/panel and add something else (water
   chemistry, prey, etc.). The panels are independent `<details>` sections — adding
   or removing one is localized.
7. **Hosting.** GitHub Pages on `main`, or embed via jsDelivr
   `cdn.jsdelivr.net/gh/<owner>/<repo>@main/map.html` (see README).

### What you almost never need to touch
- Clustering/worker, deep-link plumbing, region polygon filter, search UX,
  °F/°C toggle, the Köppen overlay, the live-point climate/elevation logic, the
  humidity-aware lapse model, and the chart/table builders are all generic.

### Gotchas to carry forward
- **Browser CORS:** use Open-Meteo for client elevation, OpenTopoData only in Node.
- **iNat 10k pagination cap:** the recursive date-splitting in the fetch is required
  for any abundant taxon — keep it.
- **Obscured obs** exist for many sensitive/poached taxa (orchids, rare plants) —
  the box-with-count + elevation-range handling is *more* important for those groups.
- **Hemisphere split** matters for any group spanning both hemispheres.
- **`CLIM_CACHE_VER`**: bump it whenever you change the climate source or cache shape
  to force a clean re-fetch.
- **Long Actions jobs:** push with a token-in-URL, not the default checkout auth.

---

## 7. Data contracts (quick reference)

**Observation array** (`inat/all.json` → `obs[]`):
```
[ obs_id, lat, lng, taxonIdx, dateStr, flags, photoId, koppenZone ]
   0       1    2     3         4        5      6        7
flags bits: 1=needs_id  2=obscured  4=has_photo
```
**Taxa table** (`inat/all.json` → `taxa[]`): `[ taxonId, scientificName, genus, commonName ]`

**Species entry** (`species-data.json` → `species[taxonId]`): `scientific_name,
common_name, genus, obs_count, sample_count, stats{ avgHigh, avgLow, hotTypical,
coldTypical, hotLimit, coldLimit, precip{p25,p50,p75}, rhMean{…}, elev{min,max,p10,p90,median} },
monthly_nh, monthly_sh, phenology{ flowering:{nh[12],sh[12]}, budding, fruiting },
photo_url, wikipedia_summary, inat_url`.

Each `monthly_nh`/`monthly_sh` holds 12-month [p25,p50,p75] arrays for `high, low,
precip, rh, dli` (DLI added in cache v4). The client **climate-match** scorer
(§4 `CLIMATE MATCH`) gates on the user's temperature extremes vs `coldLimit/hotLimit`,
then weights 6 sub-scores (low/high temp, monthly alignment, sunlight/DLI, RH, precip)
into a 0–100 match score.

---

*Last updated: 2026-06 (post: humidity-aware lapse, daily-extreme tiers, phenology,
obscured boxes, deep links, region polygon filter, Nepenthes elevation bands,
DLI/sunlight pipeline + 6-factor climate-match scorer, species map filter,
visualViewport metrics, CODEMAP.md navigation index).*
