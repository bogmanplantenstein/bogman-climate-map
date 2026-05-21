/**
 * fetch-inat-data.js
 * Fetches all research-grade + needs_id carnivorous plant observations from iNaturalist
 * and writes compact JSON files consumed by the Bogman Climate Map.
 *
 * Run: node scripts/fetch-inat-data.js
 * Requires: INAT_API_TOKEN env var (from GitHub Secret or local .env)
 * Output:   inat/all.json, inat/{genus}.json, inat/fetch-report.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import parseGeoraster from 'georaster';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

// ── Configuration ─────────────────────────────────────────────────────────────

const GENERA = [
  'Aldrovanda', 'Byblis', 'Cephalotus', 'Darlingtonia', 'Dionaea',
  'Drosera', 'Drosophyllum', 'Genlisea', 'Heliamphora', 'Nepenthes',
  'Pinguicula', 'Roridula', 'Sarracenia', 'Utricularia',
];

const QUALITY_GRADES  = ['research', 'needs_id'];
const MIN_YEAR        = 2006;   // iNat launched 2006; useful obs sparse before 2008
const MAX_YEAR        = new Date().getFullYear();
const RATE_LIMIT_MS   = 700;    // ~85 req/min — safe under iNat's 100/min limit
const MAX_RETRIES     = 3;
const MAX_PER_PAGE    = 200;
const CHUNK_THRESHOLD = 10000;  // recurse when count exceeds this

const API_BASE   = 'https://api.inaturalist.org/v1';
const USER_AGENT = 'BogmanClimateMap/1.0 (+https://github.com/bogmanplantenstein/bogman-climate-map; monthly data refresh)';

// ── Species climate precompute config ─────────────────────────────────────────
const GRID_DEG        = 0.5;          // 0.5° cell ≈ 55 km north-south
const DENSE_RADIUS_KM = 8;            // neighbour radius for dense-cluster pick
const OM_RATE_MS      = 700;          // ~85 req/min — matches iNat pacing
const OM_MIN_CELLS    = 3;            // skip species with fewer occupied cells
const LAPSE_RATE      = 6.5 / 1000;  // °C per metre (standard environmental lapse)
const OM_ARCHIVE      = 'https://archive-api.open-meteo.com/v1/archive';
const ELEV_API        = 'https://api.opentopodata.org/v1/aster30m';  // ASTER 30m — covers 83°N–83°S (SRTM misses >60°N, losing Nordic/sub-arctic species)
const ELEV_RATE_MS    = 1_000;  // 1 s between batches — OpenTopoData allows 1 req/s
const ELEV_BACKOFF    = [5_000, 15_000, 30_000];  // retry delays on 429 / errors
const ELEV_CACHE_PATH = join(ROOT, 'inat', 'elev-cache.json');  // persisted across runs

const MODE = process.argv[2] || 'all';  // 'obs' | 'species' | 'all'

// ── State ─────────────────────────────────────────────────────────────────────

let koppenRaster   = null;
let lastReqTime    = 0;
let totalRequests  = 0;
const startTime    = Date.now();
let omLastReq      = 0;             // Open-Meteo archive rate-limit state
let elevLastReq    = 0;             // OpenTopoData elevation rate-limit state

// ── Koppen lookup ─────────────────────────────────────────────────────────────

async function loadKoppenRaster() {
  const tifPath = join(ROOT, 'koppen_geiger_tif', '1991_2020', 'koppen_geiger_0p1.tif');
  const buf = readFileSync(tifPath);
  koppenRaster = await parseGeoraster(buf.buffer);
  console.log('✓ Koppen raster loaded (0.1° resolution)\n');
}

function getKoppen(lat, lng) {
  if (!koppenRaster) return 0;
  const { xmin, ymax, pixelWidth, pixelHeight, width, height, values } = koppenRaster;
  const col = Math.floor((lng - xmin) / pixelWidth);
  const row = Math.floor((ymax - lat) / pixelHeight);
  if (row < 0 || row >= height || col < 0 || col >= width) return 0;
  return values[0][row][col] || 0;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function rateLimitedFetch(url) {
  const wait = RATE_LIMIT_MS - (Date.now() - lastReqTime);
  if (wait > 0) await sleep(wait);
  lastReqTime = Date.now();
  totalRequests++;

  return fetch(url, {
    headers: {
      'Authorization': `Bearer ${process.env.INAT_API_TOKEN || ''}`,
      'Accept':        'application/json',
      'User-Agent':    USER_AGENT,
    }
  });
}

async function apiGet(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(String(k), String(v));
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await rateLimitedFetch(url.toString());

      if (res.ok) return res.json();

      if (res.status === 429) {
        console.warn(`    ⚠ Rate limited — waiting 60s (attempt ${attempt})`);
        await sleep(60_000);
        continue;
      }
      if (res.status >= 500) {
        console.warn(`    ⚠ Server error ${res.status} — retrying in ${attempt * 10}s`);
        await sleep(attempt * 10_000);
        continue;
      }
      throw new Error(`HTTP ${res.status} — ${url}`);

    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      console.warn(`    ⚠ Attempt ${attempt} failed: ${err.message} — retrying in ${attempt * 5}s`);
      await sleep(attempt * 5_000);
    }
  }
}

// ── Taxon ID resolution ───────────────────────────────────────────────────────

async function resolveTaxonId(genusName) {
  const data = await apiGet('/taxa', { q: genusName, rank: 'genus', is_active: true });
  const match = data.results.find(t => t.name === genusName && t.rank === 'genus');
  if (!match) throw new Error(`Could not resolve taxon_id for genus "${genusName}"`);
  return match.id;
}

// ── Recursive chunk fetcher ───────────────────────────────────────────────────
//
// Strategy:
//   1. Count-check first (1 request, fast)
//   2. If count ≤ CHUNK_THRESHOLD → paginate normally
//   3. If count > CHUNK_THRESHOLD and year set but not month → split by month
//   4. Otherwise bisect longitude, then latitude, recursively
//
// This guarantees we never attempt to fetch > 10k results in one query chain.

async function getCount(params) {
  const data = await apiGet('/observations', { ...params, per_page: 1, page: 1 });
  return data.total_results;
}

async function fetchAllPages(params, total) {
  const pages = Math.ceil(total / MAX_PER_PAGE);
  const results = [];
  for (let page = 1; page <= pages; page++) {
    const data = await apiGet('/observations', { ...params, per_page: MAX_PER_PAGE, page });
    results.push(...data.results);
    if (data.results.length === 0) break; // safety — shouldn't happen
  }
  return results;
}

async function fetchChunk(params, depth = 0) {
  const count = await getCount(params);
  if (count === 0) return [];

  if (count <= CHUNK_THRESHOLD) {
    return fetchAllPages(params, count);
  }

  const pad   = '  '.repeat(depth + 3);
  const loc   = params.year
    ? (params.month ? `${params.year}-${String(params.month).padStart(2,'0')}` : String(params.year))
    : 'all years';
  const bbox  = params.swlng != null
    ? ` bbox[${(+params.swlat).toFixed(1)},${(+params.swlng).toFixed(1)}→${(+params.nelat).toFixed(1)},${(+params.nelng).toFixed(1)}]`
    : '';
  console.log(`${pad}${count.toLocaleString()} > ${CHUNK_THRESHOLD} @ ${loc}${bbox} — splitting`);

  // Split 1: by month (if we have year but no month)
  if (params.year && !params.month) {
    const all = [];
    for (let m = 1; m <= 12; m++) {
      const sub = await fetchChunk({ ...params, month: m }, depth + 1);
      all.push(...sub);
    }
    return all;
  }

  // Split 2: bisect longitude
  const swlng = params.swlng != null ? +params.swlng : -180;
  const nelng = params.nelng != null ? +params.nelng :  180;
  const swlat = params.swlat != null ? +params.swlat :  -90;
  const nelat = params.nelat != null ? +params.nelat :   90;

  if (nelng - swlng > 0.5) {
    const mid = (swlng + nelng) / 2;
    const W   = await fetchChunk({ ...params, swlng, nelng: mid, swlat, nelat }, depth + 1);
    const E   = await fetchChunk({ ...params, swlng: mid, nelng, swlat, nelat }, depth + 1);
    return [...W, ...E];
  }

  // Split 3: bisect latitude
  if (nelat - swlat > 0.5) {
    const mid = (swlat + nelat) / 2;
    const S   = await fetchChunk({ ...params, swlng, nelng, swlat, nelat: mid }, depth + 1);
    const N   = await fetchChunk({ ...params, swlng, nelng, swlat: mid, nelat }, depth + 1);
    return [...S, ...N];
  }

  // Box too small to split further — fetch anyway (rare edge case)
  console.warn(`${pad}⚠ Cannot split further at ${swlat},${swlng}→${nelat},${nelng} (count=${count}). Fetching up to ${CHUNK_THRESHOLD}.`);
  return fetchAllPages(params, Math.min(count, CHUNK_THRESHOLD));
}

// ── Observation processor ─────────────────────────────────────────────────────
//
// Converts a raw iNat observation object into our compact 8-element array:
//   [obs_id, lat, lng, taxon_idx, date, flags, photo_id, koppen]
//
// flags bitfield:
//   bit 0: needs_id  (0=research_grade, 1=needs_id)
//   bit 1: obscured  (geoprivacy or taxon_geoprivacy = 'obscured')
//   bit 2: has_photo

function processObs(obs, taxaList, genus) {
  // iNat API v1 returns coordinates as a single "lat,lng" string in `location`
  // (no separate `latitude`/`longitude` fields). Private obs have location: null.
  const { id, observed_on, location, obscured, geoprivacy, taxon_geoprivacy,
          photos, quality_grade, taxon } = obs;

  if (!location) return null; // private/no-location obs

  const comma = location.indexOf(',');
  const lat = parseFloat(location.slice(0, comma));
  const lng = parseFloat(location.slice(comma + 1));
  if (isNaN(lat) || isNaN(lng)) return null;

  // Taxon info
  const taxonId     = taxon?.id      || 0;
  const taxonName   = taxon?.name    || genus;
  const commonName  = taxon?.preferred_common_name || null;

  // Find or create taxon in lookup table
  let ti = taxaList.findIndex(t => t[0] === taxonId);
  if (ti === -1) {
    taxaList.push([taxonId, taxonName, genus, commonName]);
    ti = taxaList.length - 1;
  }

  // Flags
  const isNeedsId  = quality_grade === 'needs_id' ? 1 : 0;
  // Use the top-level `obscured` boolean (most reliable); fall back to string checks
  const isObscured = (obscured || geoprivacy === 'obscured' || taxon_geoprivacy === 'obscured') ? 1 : 0;
  const hasPhoto   = photos?.length > 0 ? 1 : 0;
  const flags      = isNeedsId | (isObscured << 1) | (hasPhoto << 2);

  // First photo ID (reconstruct URL: https://inaturalist-open-data.s3.amazonaws.com/photos/{id}/square.jpeg)
  let photoId = 0;
  if (hasPhoto) {
    const m = photos[0].url?.match(/\/photos\/(\d+)\//);
    photoId = m ? parseInt(m[1]) : 0;
  }

  const koppen = getKoppen(lat, lng);
  const latR   = Math.round(lat * 10000) / 10000;
  const lngR   = Math.round(lng * 10000) / 10000;

  return [id, latR, lngR, ti, observed_on || '', flags, photoId, koppen];
}

// ── Per-genus fetch ───────────────────────────────────────────────────────────

async function fetchGenus(genus, taxonId) {
  const taxaList   = [];
  const obsAll     = [];
  const failedChunks = [];
  let   expectedTotal = 0;

  const baseParams = {
    taxon_id: taxonId,
    captive:  'false',
    order_by: 'id',
    order:    'asc',
  };

  for (const qg of QUALITY_GRADES) {
    const qgParams = { ...baseParams, quality_grade: qg };

    const total = await getCount(qgParams);
    console.log(`    ${qg}: ${total.toLocaleString()} observations`);
    expectedTotal += total;
    if (total === 0) continue;

    for (let year = MIN_YEAR; year <= MAX_YEAR; year++) {
      try {
        const raw = await fetchChunk({ ...qgParams, year });
        for (const obs of raw) {
          const processed = processObs(obs, taxaList, genus);
          if (processed) obsAll.push(processed);
        }
      } catch (err) {
        console.error(`    ✗ FAILED: ${genus} ${qg} ${year} — ${err.message}`);
        failedChunks.push({ genus, qg, year, error: err.message });
      }
    }
  }

  // Deduplicate by obs_id (first element) — geographic splits can produce overlaps
  const seen   = new Set();
  const deduped = obsAll.filter(o => {
    if (seen.has(o[0])) return false;
    seen.add(o[0]);
    return true;
  });

  const pct = expectedTotal ? Math.round(deduped.length / expectedTotal * 100) : 0;
  const warn = Math.abs(deduped.length - expectedTotal) / (expectedTotal || 1) > 0.02 ? ' ⚠ >2% gap' : '';
  console.log(`  → ${deduped.length.toLocaleString()} obs fetched (expected ~${expectedTotal.toLocaleString()}, ${pct}%)${warn}`);
  if (failedChunks.length) console.warn(`    ⚠ ${failedChunks.length} chunk(s) permanently failed`);

  return { taxa: taxaList, obs: deduped, expected: expectedTotal, failed: failedChunks };
}

// ── Species climate precomputation ───────────────────────────────────────────
//
// After all obs are collected we:
//   1. Assign every obs to a 0.5° global grid cell
//   2. Pick one representative GPS point per cell (densest local cluster)
//   3. Batch-fetch Copernicus GLO-30 elevations (OpenTopoData API, 100 per request)
//   4. Fetch climate normals per cell (Open-Meteo archive, temp+precip+RH combined)
//   5. Apply lapse-rate elevation correction to temperatures
//   6. For each taxon: aggregate p10/p25/p50/p75/p90 across its cells
//   7. Batch-fetch iNat taxa photos + Wikipedia summaries
//   8. Write inat/species-data.json

// ── Maths helpers ─────────────────────────────────────────────────────────────

function haversineKm(lat1, lon1, lat2, lon2) {
  const R  = 6371;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pctile(sorted, p) {
  if (!sorted.length) return null;
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const round1 = v => v == null ? null : Math.round(v * 10) / 10;
const round0 = v => v == null ? null : Math.round(v);

function computeStats(values, roundFn = round1) {
  const clean = values.filter(v => v != null && isFinite(v));
  if (!clean.length) return null;
  const s = [...clean].sort((a, b) => a - b);
  return {
    p10: roundFn(pctile(s, 10)),
    p25: roundFn(pctile(s, 25)),
    p50: roundFn(pctile(s, 50)),
    p75: roundFn(pctile(s, 75)),
    p90: roundFn(pctile(s, 90)),
  };
}

// ── Grid: build and select cell representatives ───────────────────────────────

/**
 * Groups all obs into 0.5° cells, then picks one representative per cell:
 * the point with the most neighbours within DENSE_RADIUS_KM (capped at 100
 * sample points per cell for speed). Returns Map<cellKey, {lat, lng}>.
 */
function buildGlobalGrid(allObs) {
  // Group obs coordinates by cell key
  const cells = new Map(); // cellKey → [{lat, lng}]
  for (const o of allObs) {
    const lat = o[1], lng = o[2];
    const key = `${Math.floor(lat / GRID_DEG)}:${Math.floor(lng / GRID_DEG)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push({ lat, lng });
  }

  // Select dense-cluster representative per cell
  const reps = new Map(); // cellKey → {lat, lng}
  for (const [key, pts] of cells) {
    if (pts.length === 1) { reps.set(key, pts[0]); continue; }

    // Subsample to ≤100 points before O(n²) density search
    const sample = pts.length > 100
      ? pts.filter((_, i) => i % Math.ceil(pts.length / 100) === 0)
      : pts;

    let bestPt = sample[0], bestCnt = -1;
    for (const pt of sample) {
      let cnt = 0;
      for (const other of sample) {
        if (haversineKm(pt.lat, pt.lng, other.lat, other.lng) <= DENSE_RADIUS_KM) cnt++;
      }
      if (cnt > bestCnt) { bestCnt = cnt; bestPt = pt; }
    }
    reps.set(key, bestPt);
  }

  console.log(`  Grid: ${reps.size.toLocaleString()} unique 0.5° cells`);
  return reps;
}

// ── Open-Meteo rate-limited fetch ─────────────────────────────────────────────

async function omGet(url) {
  const wait = OM_RATE_MS - (Date.now() - omLastReq);
  if (wait > 0) await sleep(wait);
  omLastReq = Date.now();
  return fetch(url, { headers: { 'User-Agent': USER_AGENT } });
}

// ── Copernicus GLO-30 elevation batch fetch ───────────────────────────────────

async function elevGet(url) {
  const wait = ELEV_RATE_MS - (Date.now() - elevLastReq);
  if (wait > 0) await sleep(wait);
  elevLastReq = Date.now();
  return fetch(url, { headers: { 'User-Agent': USER_AGENT } });
}

async function fetchElevations(cellReps) {
  const keys = [...cellReps.keys()];
  const BATCH = 100;

  // Load persisted cache (elevation data never changes for a fixed grid cell)
  let cache = {};
  if (existsSync(ELEV_CACHE_PATH)) {
    try {
      cache = JSON.parse(readFileSync(ELEV_CACHE_PATH, 'utf8'));
      console.log(`  Loaded ${Object.keys(cache).length.toLocaleString()} cached elevations`);
    } catch (err) {
      console.warn(`  ⚠ Could not read elevation cache: ${err.message}`);
    }
  }

  const missing = keys.filter(k => !(k in cache));  // null = cached no-data (ocean); undefined = never fetched

  if (missing.length === 0) {
    console.log(`  ✓ All ${keys.length.toLocaleString()} elevations served from cache — no API calls needed`);
    writeFileSync(ELEV_CACHE_PATH, JSON.stringify(cache)); // normalise / deduplicate
    return new Map(keys.map(k => [k, cache[k]]));
  }

  console.log(`  ${missing.length.toLocaleString()} cells need fetching (${keys.length - missing.length} cached)`);

  let fetched = 0;
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch     = missing.slice(i, i + BATCH);
    const coords    = batch.map(k => cellReps.get(k));
    // OpenTopoData uses pipe-separated "lat,lng" pairs
    const locations = coords.map(c => `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`).join('|');
    const url       = `${ELEV_API}?locations=${locations}`;

    let ok = false;
    for (let attempt = 0; attempt <= ELEV_BACKOFF.length; attempt++) {
      try {
        const res = await elevGet(url);
        if (res.ok) {
          const data = await res.json();
          // OpenTopoData returns { results: [{elevation, location}, ...], status: "OK" }
          if (data.results) {
            batch.forEach((key, j) => {
              const elev = data.results[j]?.elevation ?? null;  // null for ocean / no-data
              cache[key] = elev;
            });
            fetched += batch.length;
          }
          ok = true;
          break;
        }
        if (res.status === 429) {
          const delay = ELEV_BACKOFF[attempt] ?? ELEV_BACKOFF[ELEV_BACKOFF.length - 1];
          console.warn(`  ⚠ Elev 429 — waiting ${delay / 1000}s (attempt ${attempt + 1}/${ELEV_BACKOFF.length + 1})`);
          await sleep(delay);
        } else {
          console.warn(`  ⚠ Elev batch: HTTP ${res.status} — skipping`);
          break;
        }
      } catch (err) {
        console.warn(`  ⚠ Elev batch: ${err.message}`);
        if (attempt < ELEV_BACKOFF.length) await sleep(ELEV_BACKOFF[attempt]);
        else break;
      }
    }
    if (!ok) console.warn(`  ✗ Elev batch ${i}–${i + BATCH}: gave up after retries`);

    // Flush cache to disk every 1,000 cells so partial progress survives cancellation
    if ((i + BATCH) % 1000 === 0 || i + BATCH >= missing.length) {
      writeFileSync(ELEV_CACHE_PATH, JSON.stringify(cache));
    }
    if (i % 2000 === 0 && i > 0) {
      console.log(`  ${(i + BATCH).toLocaleString()}/${missing.length.toLocaleString()} missing cells processed`);
    }
  }

  console.log(`  ✓ ${fetched.toLocaleString()} new elevations fetched; cache total: ${Object.keys(cache).length.toLocaleString()}`);
  return new Map(keys.map(k => [k, cache[k] ?? null]));
}

// ── Climate fetch per cell ────────────────────────────────────────────────────

/**
 * Fetches 5-year (2019-2023) climate normals from Open-Meteo archive API.
 * Returns parsed monthly averages + model elevation, or null on failure.
 * Combined daily temp/precip + hourly RH in one request.
 */
async function fetchCellClimate(lat, lng) {
  const url = `${OM_ARCHIVE}?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
    `&start_date=2019-01-01&end_date=2023-12-31` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum` +
    `&hourly=relative_humidity_2m` +
    `&timezone=UTC`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await omGet(url);
      if (res.ok)           return parseClimateResponse(await res.json());
      if (res.status === 429) { await sleep(15_000); continue; }
      if (res.status >= 500)  { await sleep(attempt * 15_000); continue; }
      return null;
    } catch (err) {
      if (attempt === 3) return null;
      await sleep(attempt * 5_000);
    }
  }
  return null;
}

function parseClimateResponse(d) {
  const daily  = d.daily;
  const hourly = d.hourly;
  if (!daily?.time) return null;

  const modelElev = d.elevation ?? null;

  // Accumulate daily temp and precip → monthly averages
  const tmaxSum = new Array(12).fill(0), tmaxCnt = new Array(12).fill(0);
  const tminSum = new Array(12).fill(0), tminCnt = new Array(12).fill(0);
  const precSum = new Array(12).fill(0);
  const precYrs = Array.from({ length: 12 }, () => new Set());

  daily.time.forEach((date, i) => {
    const m = parseInt(date.substring(5, 7)) - 1;
    const y = date.substring(0, 4);
    const tmax = daily.temperature_2m_max?.[i];
    if (tmax != null) { tmaxSum[m] += tmax; tmaxCnt[m]++; }
    const tmin = daily.temperature_2m_min?.[i];
    if (tmin != null) { tminSum[m] += tmin; tminCnt[m]++; }
    const p = daily.precipitation_sum?.[i];
    if (p != null) { precSum[m] += p; precYrs[m].add(y); }
  });

  // Accumulate hourly RH → daily stats → monthly averages
  const dailyRH = {};
  if (hourly?.time) {
    hourly.time.forEach((dt, i) => {
      const date = dt.substring(0, 10);
      const v = hourly.relative_humidity_2m?.[i];
      if (v == null) return;
      if (!dailyRH[date]) dailyRH[date] = { max: -Infinity, min: Infinity, sum: 0, cnt: 0 };
      const s = dailyRH[date];
      if (v > s.max) s.max = v;
      if (v < s.min) s.min = v;
      s.sum += v; s.cnt++;
    });
  }

  const hiSum  = new Array(12).fill(0), hiCnt  = new Array(12).fill(0);
  const loSum  = new Array(12).fill(0), loCnt  = new Array(12).fill(0);
  const avgSum = new Array(12).fill(0), avgCnt = new Array(12).fill(0);

  for (const [date, s] of Object.entries(dailyRH)) {
    const m = parseInt(date.substring(5, 7)) - 1;
    if (s.max > -Infinity) { hiSum[m]  += s.max;         hiCnt[m]++; }
    if (s.min <  Infinity) { loSum[m]  += s.min;         loCnt[m]++; }
    if (s.cnt > 0)         { avgSum[m] += s.sum / s.cnt; avgCnt[m]++; }
  }

  return {
    modelElev,
    tempMax:  tmaxSum.map((s, m) => tmaxCnt[m]  ? s / tmaxCnt[m]  : null),
    tempMin:  tminSum.map((s, m) => tminCnt[m]  ? s / tminCnt[m]  : null),
    precipMm: precSum.map((s, m) => precYrs[m].size ? s / precYrs[m].size : null),
    rhHigh:   hiSum.map((s, m)  => hiCnt[m]    ? s / hiCnt[m]    : null),
    rhLow:    loSum.map((s, m)  => loCnt[m]    ? s / loCnt[m]    : null),
    rhMean:   avgSum.map((s, m) => avgCnt[m]   ? s / avgCnt[m]   : null),
  };
}

// ── Lapse-rate elevation correction ──────────────────────────────────────────

/**
 * Adjusts tempMax and tempMin for the elevation difference between the
 * Open-Meteo ERA5 model grid (modelElev) and the actual observation site
 * (elev). Uses standard environmental lapse rate: 6.5°C / 1000 m.
 * Only temperature is corrected; precip and RH are left unchanged.
 */
function applyLapseRate(climate, elev) {
  if (elev == null || climate.modelElev == null) return climate;
  // Positive delta → obs is higher than model → obs is colder → subtract
  const delta = LAPSE_RATE * (elev - climate.modelElev);
  return {
    ...climate,
    tempMax: climate.tempMax.map(v => v != null ? round1(v - delta) : null),
    tempMin: climate.tempMin.map(v => v != null ? round1(v - delta) : null),
  };
}

// ── iNat taxa info batch fetch ────────────────────────────────────────────────

async function fetchInatTaxaInfo(taxaToFetch) {
  // taxaToFetch: [{ti, taxonId}]
  const info  = new Map(); // ti → {photo_url, wikipedia_summary, inat_url}
  const BATCH = 30;

  for (let i = 0; i < taxaToFetch.length; i += BATCH) {
    const batch = taxaToFetch.slice(i, i + BATCH);
    const ids   = batch.map(t => t.taxonId).join(',');
    try {
      const data = await apiGet('/taxa', { id: ids, per_page: BATCH });
      if (data?.results) {
        for (const t of data.results) {
          const match = batch.find(b => b.taxonId === t.id);
          if (match) {
            info.set(match.ti, {
              photo_url:         t.default_photo?.medium_url || t.default_photo?.square_url || null,
              wikipedia_summary: t.wikipedia_summary || null,
              inat_url:          `https://www.inaturalist.org/taxa/${t.id}`,
            });
          }
        }
      }
    } catch (err) {
      console.warn(`  ⚠ taxa-info batch ${i}–${i + BATCH}: ${err.message}`);
    }
    if ((i / BATCH + 1) % 10 === 0) {
      console.log(`  ${Math.min(i + BATCH, taxaToFetch.length)}/${taxaToFetch.length} taxa info fetched`);
    }
  }

  return info;
}

// ── Main species precompute orchestrator ──────────────────────────────────────

async function computeSpeciesData(allTaxa, allObs) {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  Species Climate Precomputation                  ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // ── 1. Build global 0.5° grid ─────────────────────────────────────────────
  console.log('▶ Building global 0.5° grid...');
  const cellReps = buildGlobalGrid(allObs);

  // ── 2. Copernicus GLO-30 elevations ──────────────────────────────────────
  console.log('\n▶ Fetching Copernicus GLO-30 elevations (batched 100/request)...');
  const elevs = await fetchElevations(cellReps);
  const elevHits = [...elevs.values()].filter(v => v != null).length;
  console.log(`  ✓ ${elevHits.toLocaleString()}/${elevs.size.toLocaleString()} elevations resolved (${elevs.size - elevHits} null/ocean)`);

  // ── 3. Climate per cell ───────────────────────────────────────────────────
  const cellKeys = [...cellReps.keys()];
  const estMin   = Math.round(cellKeys.length * OM_RATE_MS / 60_000);
  console.log(`\n▶ Fetching climate data for ${cellKeys.length.toLocaleString()} cells (~${estMin} min)...`);

  const cellClimates = new Map(); // cellKey → parsed climate object
  let omFetched = 0, omFailed = 0;

  for (const key of cellKeys) {
    const { lat, lng } = cellReps.get(key);
    const raw = await fetchCellClimate(lat, lng);
    if (raw) {
      const elev = elevs.get(key) ?? null;
      cellClimates.set(key, applyLapseRate(raw, elev));
      omFetched++;
    } else {
      omFailed++;
    }
    const done = omFetched + omFailed;
    if (done % 500 === 0) {
      const pct = Math.round(done / cellKeys.length * 100);
      console.log(`  [${pct}%] ${done.toLocaleString()}/${cellKeys.length.toLocaleString()} (${omFailed} failed)`);
    }
  }
  console.log(`  ✓ ${omFetched.toLocaleString()} cells with climate data (${omFailed} failed)\n`);

  // ── 4. Build per-taxon indices ────────────────────────────────────────────
  console.log('▶ Building species indices...');
  const taxonCells    = new Map(); // taxonIdx → Set<cellKey>
  const taxonKoppen   = new Map(); // taxonIdx → Map<zone, count>
  const taxonObsCount = new Map(); // taxonIdx → count

  for (const o of allObs) {
    const ti   = o[3];
    const lat  = o[1], lng = o[2];
    const zone = o[7];
    const key  = `${Math.floor(lat / GRID_DEG)}:${Math.floor(lng / GRID_DEG)}`;

    if (!taxonCells.has(ti))  taxonCells.set(ti, new Set());
    taxonCells.get(ti).add(key);

    if (!taxonKoppen.has(ti)) taxonKoppen.set(ti, new Map());
    if (zone > 0) {
      const m = taxonKoppen.get(ti);
      m.set(zone, (m.get(zone) || 0) + 1);
    }

    taxonObsCount.set(ti, (taxonObsCount.get(ti) || 0) + 1);
  }

  // ── 5. Compute per-taxon stats ────────────────────────────────────────────
  console.log('▶ Computing species climate envelopes...');
  const speciesData  = {};
  const taxaToFetch  = [];

  for (let ti = 0; ti < allTaxa.length; ti++) {
    const cells = taxonCells.get(ti);
    if (!cells || cells.size < OM_MIN_CELLS) continue;

    // Gather climate objects for this taxon's occupied cells
    const climates = []; // [{c: climate, lat, lng}]
    for (const key of cells) {
      const c = cellClimates.get(key);
      const r = cellReps.get(key);
      if (c && r) climates.push({ c, lat: r.lat, lng: r.lng });
    }
    if (climates.length < OM_MIN_CELLS) continue;

    const [taxonId, taxonName, genus, commonName] = allTaxa[ti];

    // Annual headline metrics (one value per sample point)
    const annualMaxT  = [], annualMinT  = [], annualPrec = [], annualRH = [];
    for (const { c } of climates) {
      const maxT  = c.tempMax.filter(v => v != null);
      const minT  = c.tempMin.filter(v => v != null);
      const prec  = c.precipMm.filter(v => v != null);
      const rh    = c.rhMean.filter(v => v != null);
      if (maxT.length) annualMaxT.push(Math.max(...maxT));
      if (minT.length) annualMinT.push(Math.min(...minT));
      if (prec.length) annualPrec.push(prec.reduce((a, b) => a + b, 0));
      if (rh.length)   annualRH.push(rh.reduce((a, b) => a + b, 0) / rh.length);
    }

    // Monthly chart data: split NH (lat ≥ 0) and SH (lat < 0)
    const nhC = climates.filter(({ lat }) => lat >= 0).map(({ c }) => c);
    const shC = climates.filter(({ lat }) => lat <  0).map(({ c }) => c);

    // For each hemisphere, compute per-month [p25, p50, p75] for each metric
    const monthlyPct = (arr, field) => {
      if (!arr.length) return null;
      return Array.from({ length: 12 }, (_, m) => {
        const vals = arr.map(c => c[field]?.[m]).filter(v => v != null);
        if (!vals.length) return null;
        const s = [...vals].sort((a, b) => a - b);
        return [round1(pctile(s, 25)), round1(pctile(s, 50)), round1(pctile(s, 75))];
      });
    };

    const makeMonthly = arr => arr.length ? {
      tempMax: monthlyPct(arr, 'tempMax'),
      tempMin: monthlyPct(arr, 'tempMin'),
      precip:  monthlyPct(arr, 'precipMm'),
      rh:      monthlyPct(arr, 'rhMean'),
    } : null;

    // Köppen zone distribution sorted by count
    const koppenMap = taxonKoppen.get(ti) || new Map();
    const koppen    = [...koppenMap.entries()].sort((a, b) => b[1] - a[1]);

    speciesData[taxonId] = {
      taxon_id:        taxonId,
      scientific_name: taxonName,
      common_name:     commonName || null,
      genus,
      obs_count:       taxonObsCount.get(ti) || 0,
      sample_count:    climates.length,
      stats: {
        tempMax: computeStats(annualMaxT, round1),
        tempMin: computeStats(annualMinT, round1),
        precip:  computeStats(annualPrec, round0),
        rhMean:  computeStats(annualRH,   round0),
      },
      monthly_nh: makeMonthly(nhC),
      monthly_sh: makeMonthly(shC),
      koppen,
      // photo_url, wikipedia_summary, inat_url added in step 6
    };

    taxaToFetch.push({ ti, taxonId });
  }

  console.log(`  ✓ ${Object.keys(speciesData).length} species with ≥${OM_MIN_CELLS} cells\n`);

  // ── 6. iNat taxa photos + Wikipedia ──────────────────────────────────────
  console.log(`▶ Fetching iNat taxa info for ${taxaToFetch.length} species...`);
  const taxaInfo = await fetchInatTaxaInfo(taxaToFetch);
  for (const { ti, taxonId } of taxaToFetch) {
    const info = taxaInfo.get(ti);
    if (info && speciesData[taxonId]) Object.assign(speciesData[taxonId], info);
  }
  console.log(`  ✓ ${taxaInfo.size} taxa with photo/Wikipedia data\n`);

  // ── 7. Write output ───────────────────────────────────────────────────────
  const output = {
    v:              1,
    generated:      new Date().toISOString(),
    cell_count:     cellClimates.size,
    species_count:  Object.keys(speciesData).length,
    species:        speciesData,
  };

  writeFileSync(join(ROOT, 'inat', 'species-data.json'), JSON.stringify(output));
  console.log(`✓ Written inat/species-data.json\n`);

  return output;
}

// ── Species-only mode (reads inat/all.json written by obs job) ────────────────

async function runSpeciesMode() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Bogman iNat Species Climate Precompute          ║');
  console.log(`║  ${new Date().toISOString()}              ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');

  const allPath = join(ROOT, 'inat', 'all.json');
  if (!existsSync(allPath)) {
    throw new Error('inat/all.json not found — run "node fetch-inat-data.js obs" first');
  }

  console.log('▶ Loading observation data from inat/all.json...');
  const { taxa: allTaxa, obs: allObs } = JSON.parse(readFileSync(allPath, 'utf8'));
  console.log(`  ${allObs.length.toLocaleString()} observations, ${allTaxa.length.toLocaleString()} taxa\n`);

  await loadKoppenRaster();
  mkdirSync(join(ROOT, 'inat'), { recursive: true });

  const speciesResult = await computeSpeciesData(allTaxa, allObs);

  const report = {
    generated:     new Date().toISOString(),
    obs_loaded:    allObs.length,
    taxa_loaded:   allTaxa.length,
    species_count: speciesResult.species_count,
    cell_count:    speciesResult.cell_count,
    durationMin:   Math.round((Date.now() - startTime) / 60000),
  };
  writeFileSync(join(ROOT, 'inat', 'species-report.json'), JSON.stringify(report, null, 2));

  const mins = report.durationMin;
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Summary                                         ║');
  console.log(`║  Obs loaded         : ${String(allObs.length.toLocaleString()).padEnd(27)}║`);
  console.log(`║  Species w/ data    : ${String(speciesResult.species_count.toLocaleString()).padEnd(27)}║`);
  console.log(`║  Climate cells      : ${String(speciesResult.cell_count.toLocaleString()).padEnd(27)}║`);
  console.log(`║  Duration           : ${String(mins + ' min').padEnd(27)}║`);
  console.log('╚══════════════════════════════════════════════════╝');
}

// ── Obs fetch mode (and legacy all-in-one mode) ───────────────────────────────

async function main() {
  if (MODE === 'species') {
    await runSpeciesMode();
    return;
  }

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Bogman iNat Data Fetch                          ║');
  console.log(`║  ${new Date().toISOString()}              ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (!process.env.INAT_API_TOKEN) {
    console.warn('⚠ INAT_API_TOKEN not set — requests will be unauthenticated (rate limits apply)\n');
  }

  await loadKoppenRaster();
  mkdirSync(join(ROOT, 'inat'), { recursive: true });

  // Resolve taxon IDs for all genera
  console.log('Resolving iNat taxon IDs...');
  const generaResolved = [];
  for (const genus of GENERA) {
    try {
      const taxonId = await resolveTaxonId(genus);
      console.log(`  ${genus.padEnd(14)} taxon_id = ${taxonId}`);
      generaResolved.push({ name: genus, taxonId });
    } catch (err) {
      console.error(`  ✗ ${genus}: ${err.message}`);
    }
  }
  console.log('');

  // Fetch each genus
  const allTaxa = [];
  const allObs  = [];
  const report  = { generated: new Date().toISOString(), genera: {}, totalRequests: 0, totalObs: 0 };

  for (const genus of generaResolved) {
    console.log(`▶ ${genus.name}`);
    const result = await fetchGenus(genus.name, genus.taxonId);

    // Write per-genus file (taxon indices local to this file)
    const genusOut = { v: 1, generated: new Date().toISOString(), genus: genus.name, taxa: result.taxa, obs: result.obs };
    writeFileSync(join(ROOT, 'inat', `${genus.name.toLowerCase()}.json`), JSON.stringify(genusOut));

    // Merge into combined dataset (remap taxon indices to global offset)
    const idxOffset = allTaxa.length;
    allTaxa.push(...result.taxa);
    for (const o of result.obs) {
      allObs.push([o[0], o[1], o[2], o[3] + idxOffset, o[4], o[5], o[6], o[7]]);
    }

    report.genera[genus.name] = { fetched: result.obs.length, expected: result.expected, failed: result.failed };
    console.log('');
  }

  // Write combined file (read by the species job)
  writeFileSync(join(ROOT, 'inat', 'all.json'), JSON.stringify({ v: 1, generated: new Date().toISOString(), taxa: allTaxa, obs: allObs }));

  if (MODE === 'all') {
    // Legacy single-job mode: also run species precompute inline
    const speciesResult = await computeSpeciesData(allTaxa, allObs);
    report.speciesCount = speciesResult.species_count;
    report.cellCount    = speciesResult.cell_count;
  }

  // Write fetch report
  report.totalRequests = totalRequests;
  report.totalObs      = allObs.length;
  report.durationMin   = Math.round((Date.now() - startTime) / 60000);
  writeFileSync(join(ROOT, 'inat', 'fetch-report.json'), JSON.stringify(report, null, 2));

  // Summary
  const mins = report.durationMin;
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Summary                                         ║');
  console.log(`║  Total observations : ${String(allObs.length.toLocaleString()).padEnd(27)}║`);
  if (report.speciesCount != null) {
    console.log(`║  Species w/ data    : ${String(report.speciesCount.toLocaleString()).padEnd(27)}║`);
    console.log(`║  Climate cells      : ${String(report.cellCount.toLocaleString()).padEnd(27)}║`);
  }
  console.log(`║  API requests       : ${String(totalRequests.toLocaleString()).padEnd(27)}║`);
  console.log(`║  Duration           : ${String(mins + ' min').padEnd(27)}║`);

  const failures = Object.values(report.genera).flatMap(g => g.failed);
  if (failures.length) {
    console.log(`║  ⚠ Failed chunks    : ${String(failures.length).padEnd(27)}║`);
  }
  console.log('╚══════════════════════════════════════════════════╝');

  if (failures.length) {
    console.log('\nFailed chunks (re-run manually if needed):');
    failures.forEach(f => console.log(`  ${f.genus} ${f.qg} ${f.year}: ${f.error}`));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
