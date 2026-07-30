/**
 * Downloads Natural Earth land polygons and emits a compact TS module.
 *
 * Run with: node scripts/build-coastlines.mjs [110m|50m]
 *
 * The output is committed, so the app itself never fetches anything at
 * runtime and stays dependency-free. Re-run this only when you want to
 * change the resolution.
 */
import { writeFile } from 'node:fs/promises'

const SOURCES = {
  '110m': 'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/110m/physical/ne_110m_land.json',
  '50m': 'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/50m/physical/ne_50m_land.json',
}

// 2 decimal places is ~1.1km at the equator, well under the 110m dataset's
// own precision, and it roughly halves the file size.
const PRECISION = 2

const resolution = process.argv[2] ?? '110m'
const url = SOURCES[resolution]
if (!url) {
  console.error(`Unknown resolution "${resolution}". Expected one of: ${Object.keys(SOURCES).join(', ')}`)
  process.exit(1)
}

const response = await fetch(url)
if (!response.ok) {
  console.error(`Download failed: HTTP ${response.status} ${response.statusText}`)
  process.exit(1)
}
const geojson = await response.json()

const round = (n) => Number(n.toFixed(PRECISION))

/**
 * Group rings by polygon, preserving GeoJSON's convention that the first ring
 * of a polygon is its outline and any others are holes. The renderer fills
 * each polygon as a unit, so that structure has to survive.
 */
const polygons = []
for (const feature of geojson.features) {
  const { type, coordinates } = feature.geometry
  for (const polygon of type === 'Polygon' ? [coordinates] : coordinates) {
    const rings = []
    for (const ring of polygon) {
      const flat = []
      let prevLon = NaN
      let prevLat = NaN
      for (const [lon, lat] of ring) {
        const rLon = round(lon)
        const rLat = round(lat)
        // Rounding can collapse neighbours onto each other; drop the dupes.
        if (rLon === prevLon && rLat === prevLat) continue
        flat.push(rLon, rLat)
        prevLon = rLon
        prevLat = rLat
      }
      if (flat.length >= 6) rings.push(flat)
    }
    if (rings.length) polygons.push(rings)
  }
}

const ringCount = polygons.reduce((sum, p) => sum + p.length, 0)
const pointCount = polygons.reduce(
  (sum, p) => sum + p.reduce((s, r) => s + r.length / 2, 0),
  0,
)

const body = polygons
  .map((rings) => `[${rings.map((r) => `[${r.join(',')}]`).join(',')}]`)
  .join(',\n')

const output = `// GENERATED FILE - do not edit by hand.
// Source: Natural Earth ${resolution} land polygons (public domain).
// Regenerate with: node scripts/build-coastlines.mjs ${resolution}
//
// One entry per polygon. Each polygon is a list of closed rings: the first is
// the outline, any others are holes. Rings are flattened as
// [lon, lat, lon, lat, ...] in degrees.
// ${polygons.length} polygons, ${ringCount} rings, ${pointCount} points.

export type Ring = readonly number[]
export type Polygon = readonly Ring[]

export const COASTLINE_POLYGONS: readonly Polygon[] = [
${body},
]

/** Every ring, ungrouped - what the outline stroking pass wants. */
export const COASTLINE_RINGS: readonly Ring[] = COASTLINE_POLYGONS.flat()
`

const target = new URL('../src/globe/data/coastlines.ts', import.meta.url)
await writeFile(target, output)
console.log(`Wrote ${polygons.length} polygons / ${ringCount} rings / ${pointCount} points (${(output.length / 1024).toFixed(1)} kB) to src/globe/data/coastlines.ts`)
