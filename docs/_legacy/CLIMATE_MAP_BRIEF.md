> **⚠️ HISTORICAL / SUPERSEDED — DO NOT USE AS A REFERENCE.**
> Early planning doc describing the original design where the map read from the
> gallery's `data/data.json` and used Open-Meteo. That design was abandoned — the
> map is now decoupled and uses iNaturalist + NASA POWER via the precompute
> pipeline. See `ARCHITECTURE.md` and `CODEMAP.md` for current reality.
> Archived 2026-06-22.

---

# Bogman Climate Map — Project Brief

## What You Are Building

A standalone public-facing web app hosted at `burymeinthebog.com/map`. It displays native habitat pins for carnivorous plant taxa on a world map with Köppen climate zone overlays.

This is a **separate project** from the gallery app. It is read-only — it consumes data produced by the gallery admin but does not write anything back.

---

## Data Source

All data comes from a single JSON file maintained by the gallery admin app.

**URL:**
```
https://raw.githubusercontent.com/bogmanplantenstein/bogmangallery/main/data/data.json
```

Fetch this at app load time. It is updated when the gallery admin publishes changes. You can cache it with a reasonable TTL (e.g. 1 hour).

**Data version:** `2.1` (check `data.meta.version`)

---

## Relevant Schema

### Top-level structure

```json
{
  "meta": { "version": "2.1", "taxaCount": 270, ... },
  "taxa": [ ...taxon objects... ],
  "habitats": [ { "id": "...", "name": "..." }, ... ]
}
```

### Taxon object — fields relevant to the map

```json
{
  "id":          "txn_692ie83seap",
  "slug":        "dionaea-muscipula-typical",
  "displayName": "Dionaea muscipula \"typical\"",
  "commonName":  "Venus Flytrap",
  "genus":       "Dionaea",
  "species":     "muscipula",
  "subspecies":  "typical",
  "entryType":   "cultivar_unreg",
  "country":     "United States",
  "habitatId":   "pine_savanna",
  "nativeRange": "Endemic to coastal areas of North and South Carolina...",
  "nativeHabitat": "Grows in wet, acidic, nitrogen-poor soils...",
  "photos":      ["drive:FILE_ID", "drive:FILE_ID"],

  "mapPin": {
    "includedOnMap":       true,
    "override":            false,
    "coordinatePrecision": "exact",
    "lat":                 34.22,
    "lng":                 -77.94,
    "elevationM":          20,
    "rangeRadiusKm":       120,
    "regionCode":          "US-NC",
    "countryCode":         "US",
    "geocodeConfidence":   "high",
    "geocodeWarning":      null
  },

  "koppenZone":    "Cfa",
  "koppenLabel":   "Humid Subtropical",
  "elevationBand": "lowland",
  "inatTaxonId":   62562,

  "climateNormals": {
    "source":    "open-meteo",
    "fetchedAt": "2026-05-12",
    "lat": 34.22, "lng": -77.94,
    "tempMean":  [9.1, 10.5, 14.2, 19.1, 23.4, 27.1, 29.0, 28.4, 25.1, 19.8, 14.3, 10.0],
    "tempMin":   [4.1, 5.2, 8.8, 13.5, 17.9, 21.9, 23.8, 23.2, 20.0, 14.1, 9.0, 5.1],
    "tempMax":   [14.1, 15.8, 19.6, 24.7, 28.9, 32.3, 34.2, 33.6, 30.2, 25.5, 19.6, 14.9],
    "precipMm":  [101, 89, 104, 72, 92, 113, 148, 146, 121, 80, 77, 93]
  }
}
```

### Field notes

**`id`** — stable internal key (`txn_...`). Use this as the canonical identifier for any cross-referencing.

**`slug`** — human-readable URL key (e.g. `dionaea-muscipula-typical`). Use this in the map app's own URLs. Generated from `displayName`, unique across all taxa, hyphen-separated.

**`entryType`** — one of:
- `species` — a full species
- `location` — a geographic form of a species (e.g. "Scott River" form)
- `cultivar_reg` — a registered cultivar
- `cultivar_unreg` — an unregistered form/clone
- `named_hybrid` — a hybrid with a formal name

**`mapPin.includedOnMap`** — if `false`, exclude this taxon from the map entirely. The default is `true` for `species` and `location` entry types; `false` for cultivars and hybrids (unless manually overridden — check `override`).

**`mapPin.coordinatePrecision`**:
- `"exact"` — precise lat/lng; show a standard pin
- `"regional"` — approximate; highlight the region polygon (ISO 3166-2 from `regionCode`)
- `"country"` — country-level only; highlight the country boundary (ISO 3166-1 from `countryCode`)

**`mapPin.rangeRadiusKm`** — approximate radius of the native range in km. Draw as a circle around the pin. Null for country-level precision. Many taxa will have this set from AI inference; it's approximate.

**`climateNormals`** — 12-element arrays, one value per month (Jan–Dec). Temperatures in °C, precipitation in mm. Source is Open-Meteo 30-year historical archive (1991–2020). May be null if not yet fetched for this taxon.

**`inatTaxonId`** — integer iNaturalist taxon ID. Useful for linking to iNaturalist observation maps or fetching observation data in the future.

**`habitatId`** — references the `habitats` array at the root of data.json. Use the habitats array to get the display name.

---

## Photo URLs

Photos are stored as `drive:FILE_ID` strings. To display a photo, resolve to a Google Drive thumbnail URL:

```
https://drive.google.com/thumbnail?id=FILE_ID&sz=w400
```

Replace `w400` with `w800` or `w1200` for larger sizes. The first photo in the `photos` array is the primary/cover photo.

---

## Linking Back to the Gallery

Each taxon page in the gallery is reachable at:

```
https://www.burymeinthebog.com/gallery#/taxon/{slug}
```

Example:
```
https://www.burymeinthebog.com/gallery#/taxon/dionaea-muscipula-typical
```

Use this to link from a map pin popup/panel back to the full gallery taxon page.

---

## Map Embed Images (Future)

The gallery repo contains a folder `mapEmbed/` reserved for pre-generated PNG snapshots of the map for each taxon, named by slug:

```
mapEmbed/dionaea-muscipula-typical.png
```

These will be generated by a snapshot script in this project and committed back to the repo. They will eventually be embedded on individual taxon pages in the gallery. This is a future phase — do not build the snapshot script yet, just be aware the folder exists and the naming convention is `{slug}.png`.

---

## Filtering Logic

When building the map, filter taxa with this logic before rendering any pins:

```javascript
const mapTaxa = data.taxa.filter(t =>
  t.mapPin &&
  t.mapPin.includedOnMap === true &&
  t.mapPin.lat != null &&
  t.mapPin.lng != null
);
```

Taxa without `mapPin` or with `includedOnMap: false` should not appear on the map at all.

---

## Köppen Climate Zone Reference

The following zone codes appear in the data. The map should be able to colour-code or filter pins by Köppen group (first letter: A=Tropical, B=Arid, C=Temperate, D=Continental, E=Polar/Highland).

| Code | Label |
|------|-------|
| Af | Tropical Rainforest |
| Am | Tropical Monsoon |
| Aw | Tropical Savanna (dry winter) |
| As | Tropical Savanna (dry summer) |
| BWh | Hot Desert |
| BWk | Cold Desert |
| BSh | Hot Semi-Arid (Steppe) |
| BSk | Cold Semi-Arid (Steppe) |
| Csa | Hot-summer Mediterranean |
| Csb | Warm-summer Mediterranean |
| Csc | Cold-summer Mediterranean |
| Cwa | Humid Subtropical (dry winter, hot summer) |
| Cwb | Subtropical Highland (dry winter, warm summer) |
| Cfa | Humid Subtropical |
| Cfb | Oceanic |
| Cfc | Subpolar Oceanic |
| Dfa | Hot-summer Humid Continental |
| Dfb | Warm-summer Humid Continental |
| Dfc | Subarctic |
| ET | Tundra |
| EF | Ice Cap |
| H | Highland / Alpine |

---

## Habitat Types Reference

Current habitat categories (from `data.habitats`):

| id | name |
|----|------|
| `temperate_bog` | Temperate Bog / Fen |
| `mediterranean_heath` | Mediterranean Heathland |
| `pine_savanna` | Subtropical Pine Savanna / Pocosin |
| `tropical_lowland_peat` | Tropical Lowland Peat Swamp |
| `tropical_savanna` | Tropical Seasonal Wetland / Savanna |
| `highland_meadow` | Highland / Montane Meadow |
| `granite_outcrop` | Granite Outcrop / Laterite |
| `limestone_seep` | Limestone Seep / Cliff |
| `coastal_wetland` | Sandy Coastal Wetland |
| `alpine` | Alpine / Subalpine |

Always read these from `data.habitats` at runtime rather than hardcoding — the list may grow.

---

## What Is Not Yet Available

The following data fields exist in the schema but are not yet populated for most taxa. Build the app to handle null values gracefully:

- `mapPin` — most taxa not yet geocoded (this is being filled in progressively via the admin)
- `climateNormals` — requires manual triggering per taxon in the admin
- `koppenZone` / `koppenLabel` — not yet filled for most taxa
- `inatTaxonId` — not yet filled for most taxa

The app should work with partial data — a pin should appear as soon as `lat`/`lng` are set, even if Köppen and climate normals are missing.
