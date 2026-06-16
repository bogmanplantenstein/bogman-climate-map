# Bogman Climate Map

Interactive world map showing native habitat locations for carnivorous plant species, with Köppen climate zone overlays and per-species climate data.

Hosted at `burymeinthebog.com/map`. Deployed via jsDelivr CDN from this repo, embedded in Squarespace.

---

## How It Works

- Reads species data from the Bogman Gallery's `data.json` on GitHub (fetched at page load)
- Displays pins for all taxa with `entryType: species` or `location` that have `mapPin.lat`/`mapPin.lng` set
- Köppen climate zone overlay loaded from `koppen.geojson` in this repo
- Climate normals read from `data.json` (pre-fetched by the gallery admin — no live API calls)
- All logic is in a single self-contained `map.html` file

---

## Repo Structure

```
bogman-climate-map/
├── map.html              ← entire app (HTML + CSS + JS)
├── koppen.geojson        ← Köppen-Geiger zone polygons (see below)
├── snapshots/            ← pre-generated PNG embeds (future)
│   └── README.md
├── scripts/
│   └── generate-snapshots.js   ← placeholder
└── README.md
```

---

## Köppen GeoJSON Overlay

The app loads the Köppen overlay in two stages:

1. **Local file (preferred):** tries `./koppen.geojson` in this repo first
2. **CDN fallback (automatic):** if no local file, fetches from [circleofconfusion/climate-map](https://github.com/circleofconfusion/climate-map) — 851 KB, 1976–2000 period, global coverage

The app works out of the box with no setup needed. The CDN fallback is loaded automatically.

**To bundle a local copy for faster/reliable loading:**

1. Download `1976-2000.geojson` from:  
   `https://raw.githubusercontent.com/circleofconfusion/climate-map/master/topojson/1976-2000.geojson`
2. Save it as `koppen.geojson` in this repo root
3. Commit it — the app will prefer the local copy automatically

The file uses the `CODE` property for zone codes (e.g. `"Cfa"`, `"ET"`) which the app handles natively.

---

## Squarespace Embedding

In Squarespace, create a page at `/map` and add a Code Block with the snippet
below.

**Two important things this version gets right:**

1. **The iframe has a real `src` in the HTML** — so the map loads even if
   Squarespace strips or fails to run the inline `<script>` (Code Blocks often
   sanitize scripts). The script only *enhances* deep-linking; it is never
   required for the map to appear. *(A previous version set `src` only from the
   script — if the script didn't run, the iframe was blank.)*
2. **It pins to a commit hash, not `@main`.** jsDelivr caches the mutable
   `@main` tag for up to 7 days and can briefly serve an inconsistent file right
   after a push. A commit hash is immutable and always consistent. **To publish
   an update, bump the hash** (see "Publishing an update" below).

```html
<iframe
  id="bmg-map-frame"
  src="https://cdn.jsdelivr.net/gh/bogmanplantenstein/bogman-climate-map@563e362/map.html"
  style="width:100%;height:calc(100vh - 80px);border:none;display:block;"></iframe>

<script>
(function () {
  var frame = document.getElementById("bmg-map-frame");
  if (!frame) return;

  // 1. Forward the page's query string (?sp=, ?obs=, ?at=, ?region=) into the
  //    iframe so an incoming deep link opens the right view. We append to the
  //    EXISTING src (which already has the pinned commit), so the map still
  //    loads from the hash even if this runs.
  if (window.location.search) {
    var sep = frame.src.indexOf("?") === -1 ? "?" : "&";
    frame.src = frame.src + sep + window.location.search.slice(1);
  }

  // 2. Keep this page's address bar in sync with the map's current view, so any
  //    link is copyable straight from the browser bar and back/forward works.
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.type !== "bmg-map-deeplink") return;
    var qs = new URLSearchParams();
    var p  = e.data.params || {};
    Object.keys(p).forEach(function (k) { qs.set(k, p[k]); });
    var url = window.location.pathname + (qs.toString() ? "?" + qs.toString() : "");
    history.replaceState(null, "", url);
  });
})();
</script>
```

Adjust the `80px` offset to match the actual Squarespace header height.

### Publishing an update

The iframe is pinned to a commit hash, so pushing to `main` does **not** change
the live site until you bump the hash:

1. Push your changes to `main`.
2. Copy the new short hash: `git rev-parse --short HEAD`.
3. In the Squarespace Code Block, replace the hash in the iframe `src`
   (`...@<hash>/map.html`) with the new one. Save.

The new file is served immediately and consistently (immutable hash = no CDN
cache lag). The data files (`inat/*.json`) are still loaded by the map at the
same pinned commit, so the HTML and its data always match.

> The map builds its **Copy link** buttons against `SHARE_BASE_URL` (set near the
> top of the deep-link section in `map.html`). If the public page URL changes,
> update that constant to match.

---

## Updating Species Data

Species data updates automatically — the map always fetches the latest `data.json` from the gallery repo. No action needed here when gallery data changes.

To add a species to the map, use the gallery admin tool to set:
- `mapPin.lat` / `mapPin.lng` (required for pin to appear)
- `mapPin.coordinatePrecision` — `exact`, `regional`, or `country`
- `mapPin.rangeRadiusKm` — draws a range circle around the pin
- `koppenZone` / `koppenLabel`
- `elevationBand`
- `climateNormals` — fetched via the admin's Open-Meteo integration

---

## Deep Linking

```
/map?taxon=txn_abc123       → open panel for taxon by ID
/map?slug=drosera-capensis  → open panel for taxon by slug
```

The URL updates automatically when a pin is clicked, making any view bookmarkable and shareable.

---

## Snapshots (Future Phase)

The `snapshots/` folder is reserved for per-taxon PNG embeds generated by a Playwright script. These will eventually be embedded on individual gallery taxon pages. See `snapshots/README.md`.
