/**
 * fetch-inat-data.js
 * Fetches all research-grade + needs_id carnivorous plant observations from iNaturalist
 * and writes compact JSON files consumed by the Bogman Climate Map.
 *
 * Run: node scripts/fetch-inat-data.js
 * Requires: INAT_API_TOKEN env var (from GitHub Secret or local .env)
 * Output:   inat/all.json, inat/{genus}.json, inat/fetch-report.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
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

// ── State ─────────────────────────────────────────────────────────────────────

let koppenRaster   = null;
let lastReqTime    = 0;
let totalRequests  = 0;
const startTime    = Date.now();

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
  const { id, observed_on, latitude, longitude, geoprivacy, taxon_geoprivacy,
          photos, quality_grade, taxon } = obs;

  if (latitude == null || longitude == null) return null; // private/no-location

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
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
  const isObscured = (geoprivacy === 'obscured' || taxon_geoprivacy === 'obscured') ? 1 : 0;
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
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
  const allTaxa    = [];
  const allObs     = [];
  const report     = { generated: new Date().toISOString(), genera: {}, totalRequests: 0, totalObs: 0 };

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

  // Write combined file
  writeFileSync(join(ROOT, 'inat', 'all.json'), JSON.stringify({ v: 1, generated: new Date().toISOString(), taxa: allTaxa, obs: allObs }));

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
    process.exit(1); // Signal GitHub Actions that manual review is needed
  }
}

main().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
