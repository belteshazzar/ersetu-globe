/**
 * Builds the tiled terrain archive the renderer streams from.
 *
 * Run with: node scripts/build-terrain.mjs [--levels N] [--source PATH]
 *
 * `build-elevation.mjs` bakes one grid at one resolution, and the whole thing
 * has to arrive before the globe has any shape. That caps fidelity at whatever
 * looked reasonable to download in a lump - 2048x1024, about 19 km a sample -
 * and it is the wrong shape for a quadtree, which wants fine data only where
 * the camera is actually looking.
 *
 * So this writes a pyramid instead, cut into tiles, packed into one file.
 *
 * The pyramid is rooted to match the globe's own geometry: level 0 is 4 tiles
 * around by 2 down, which is exactly the eight lon/lat boxes of the octahedron
 * the quadtree starts from. Level z is 4*2^z by 2*2^z tiles of 128 samples, so
 * a node at quadtree level z and a tile at level z cover about the same ground
 * and the renderer can go from one to the other by arithmetic rather than by
 * searching.
 *
 *     level 0 :   512 x 256    0.70 deg   ~78 km
 *     level 1 :  1024 x 512    0.35 deg   ~39 km
 *     level 2 :  2048 x 1024   0.18 deg   ~20 km   (what shipped before)
 *     level 3 :  4096 x 2048   0.09 deg   ~10 km
 *     level 4 :  8192 x 4096   0.04 deg   ~ 5 km
 *
 * Level 4 is where it stops being worth it: the shading pass is capped at 160k
 * samples, and at the maximum zoom of 8 that works out at about 0.06 degrees a
 * sample, so level 4 is already finer than anything that can be seen.
 *
 * Tiles carry a one sample border, so bilinear sampling and the slope taps at
 * the very edge of a tile need nothing but that tile. It costs 3% and saves the
 * sampler from ever having to hold two tiles at once.
 *
 * Each tile is compressed on its own rather than as part of one stream. That
 * gives up some ratio - a shared dictionary would do better - but it is what
 * makes a tile independently fetchable, independently cacheable, and decodable
 * without its neighbours or its parent, which is the entire point of the
 * exercise. Absolute heights for the same reason: coding a level against its
 * parent would compress better still and would mean no tile could be read
 * until its whole ancestry had been.
 *
 * The index carries, per tile, the largest amount by which that tile departs
 * from what its parent already said - the error you accept by not fetching it.
 * That is the number the renderer needs to decide whether a tile is worth
 * asking for, and to stop refining geometry over ground that is flat.
 *
 * One file per level, not one file for the pyramid and not one file per region.
 *
 * Per region was measured and is a trap: a region's file holds every depth of
 * that region, but a view wants one or two depths at a time, so zooming to
 * 10 km somewhere drags the 5 km data for the whole surrounding block along
 * with it - between twice and ten times the bytes, depending on where the split
 * goes. Locality was never the problem anyway: a level is laid out row by row,
 * what is on screen at one level is a band of rows, and the client already
 * fetches such a band as one coalesced range.
 *
 * Per level is worth it for the reasons a byte range cannot give you. Whole
 * files are cached by every CDN and service worker without special handling,
 * where a 206 is cached unevenly; and a level can be added to a deployment by
 * uploading a file, without rebuilding or re-committing the ones already there.
 * Level 0 is small enough to fetch whole, which makes the bootstrap a single
 * plain GET.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { deflateSync, inflateSync } from 'node:zlib'

const SOURCE_URL =
  'https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif'

/** Interior samples per tile side. */
const TILE = 128
/** Samples of overlap on each side, so sampling never needs a neighbour. */
const BORDER = 1
const STORED = TILE + 2 * BORDER

const MAGIC = 'ERSETILE'
/** 2 is one file per level; 1 was the whole pyramid in one. */
const VERSION = 2
const HEADER_BYTES = 32
const INDEX_ENTRY_BYTES = 16

/** ETOPO marks absent data with this; the global grid should have none. */
const NODATA = -99999

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback
}

const LEVELS = Number(option('levels', 4)) + 1
const SOURCE = option('source', null)
/** Files are written as `<prefix>-<level>.bin`. */
const OUT = option('out', new URL('../public/terrain', import.meta.url).pathname)

if (!Number.isInteger(LEVELS) || LEVELS < 1 || LEVELS > 7) {
  console.error(`Bad --levels "${option('levels')}". Expected 0 to 6.`)
  process.exit(1)
}

const levelWidth = (z) => TILE * 4 * (1 << z)
const levelHeight = (z) => TILE * 2 * (1 << z)
const tilesAcrossAt = (z) => 4 * (1 << z)
const tilesDownAt = (z) => 2 * (1 << z)

const FINEST = LEVELS - 1

// --- Source ---------------------------------------------------------------

/**
 * The finest level, box-averaged from whatever the source is.
 *
 * Averaging rather than point sampling matters: taking one source cell per
 * output cell keeps whichever peak or trench it landed on and drops the rest,
 * which reads as speckle once the result is used to light a surface.
 */
async function loadFinest() {
  const width = levelWidth(FINEST)
  const height = levelHeight(FINEST)

  if (SOURCE && SOURCE.endsWith('.bin')) {
    return fromGrid(SOURCE, width, height)
  }

  const bytes = SOURCE
    ? await readFile(SOURCE)
    : Buffer.from(await (await fetchOrDie(SOURCE_URL)).arrayBuffer())

  console.log(`Averaging ETOPO down to ${width}x${height}...`)
  return fromGeoTiff(bytes, width, height)
}

async function fetchOrDie(url) {
  console.log(`Downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
  return response
}

/** Re-tile an existing single-grid elevation.bin. Only useful for a rebuild. */
async function fromGrid(path, width, height) {
  const packed = await readFile(path)
  const payload = inflateSync(packed)
  const srcWidth = payload.readUInt16LE(4)
  const srcHeight = payload.readUInt16LE(6)
  const data = new Int16Array(
    payload.buffer.slice(payload.byteOffset + 8, payload.byteOffset + payload.length),
  )
  for (let y = 0; y < srcHeight; y++) {
    const row = y * srcWidth
    data[row] += y > 0 ? data[row - srcWidth] : 0
    for (let x = 1; x < srcWidth; x++) data[row + x] += data[row + x - 1]
  }
  if (srcWidth < width) {
    throw new Error(
      `${path} is ${srcWidth}x${srcHeight}, too coarse for level ${FINEST} (${width}x${height})`,
    )
  }
  console.log(`Averaging ${srcWidth}x${srcHeight} down to ${width}x${height}...`)
  return boxAverage(
    (visit) => {
      for (let y = 0; y < srcHeight; y++) {
        for (let x = 0; x < srcWidth; x++) visit(x, y, data[y * srcWidth + x])
      }
    },
    srcWidth,
    srcHeight,
    width,
    height,
  )
}

/**
 * Decode the published ETOPO GeoTIFF: 32-bit float, Deflate, floating point
 * predictor, in 256x256 tiles. Anything else means NOAA republished the file
 * differently and the assumptions here need revisiting.
 */
function fromGeoTiff(bytes, width, height) {
  if (bytes.toString('ascii', 0, 2) !== 'II' || bytes.readUInt16LE(2) !== 42) {
    throw new Error('Not a little-endian classic TIFF; the layout assumed here has changed.')
  }

  const ifd = bytes.readUInt32LE(4)
  const entryCount = bytes.readUInt16LE(ifd)
  const tags = new Map()
  for (let i = 0; i < entryCount; i++) {
    const at = ifd + 2 + i * 12
    const type = bytes.readUInt16LE(at + 2)
    tags.set(bytes.readUInt16LE(at), {
      type,
      count: bytes.readUInt32LE(at + 4),
      value: type === 3 ? bytes.readUInt16LE(at + 8) : bytes.readUInt32LE(at + 8),
    })
  }
  const tag = (id, name) => {
    const found = tags.get(id)
    if (!found) throw new Error(`Missing TIFF tag ${name} (${id})`)
    return found
  }
  const expect = (actual, wanted, what) => {
    if (actual !== wanted) throw new Error(`Unexpected ${what}: ${actual} (expected ${wanted})`)
  }
  expect(tag(258, 'BitsPerSample').value, 32, 'BitsPerSample')
  expect(tag(339, 'SampleFormat').value, 3, 'SampleFormat (want IEEE float)')
  expect(tag(259, 'Compression').value, 8, 'Compression (want Deflate)')
  expect(tag(317, 'Predictor').value, 3, 'Predictor (want floating point)')

  const srcWidth = tag(256, 'ImageWidth').value
  const srcHeight = tag(257, 'ImageLength').value
  const tileWidth = tag(322, 'TileWidth').value
  const tileHeight = tag(323, 'TileLength').value
  const offsetsAt = tag(324, 'TileOffsets').value
  const countsAt = tag(325, 'TileByteCounts').value
  const across = Math.ceil(srcWidth / tileWidth)
  const down = Math.ceil(srcHeight / tileHeight)
  const tileCount = across * down
  console.log(`Source ${srcWidth}x${srcHeight}, ${tileCount} tiles of ${tileWidth}x${tileHeight}`)

  return boxAverage(
    (visit) => {
      const row = Buffer.allocUnsafe(tileWidth * 4)
      for (let t = 0; t < tileCount; t++) {
        const raw = bytes.subarray(
          bytes.readUInt32LE(offsetsAt + t * 4),
          bytes.readUInt32LE(offsetsAt + t * 4) + bytes.readUInt32LE(countsAt + t * 4),
        )
        const plane = inflateSync(raw)
        const tileX = (t % across) * tileWidth
        const tileY = Math.floor(t / across) * tileHeight

        for (let y = 0; y < tileHeight; y++) {
          const sy = tileY + y
          // The last row and column of tiles run past the image; that padding
          // is not data.
          if (sy >= srcHeight) break
          undoFloatPredictor(plane, y * tileWidth * 4, tileWidth, row)
          const values = new Float32Array(row.buffer, row.byteOffset, tileWidth)
          for (let x = 0; x < tileWidth; x++) {
            const sx = tileX + x
            if (sx >= srcWidth) break
            const value = values[x]
            if (!Number.isFinite(value) || value <= NODATA) continue
            visit(sx, sy, value)
          }
        }
      }
    },
    srcWidth,
    srcHeight,
    width,
    height,
  )
}

/**
 * Undo the TIFF floating point predictor for one row, into `out`.
 *
 * The predictor splits each sample into byte planes - all the most significant
 * bytes of the row first, then the next plane - which puts similar magnitudes
 * next to each other, and then stores each byte as a difference from its
 * neighbour. Deflate sees a long run of near zeroes instead of scattered float
 * bits, which is where the 4:1 comes from.
 */
function undoFloatPredictor(plane, start, width, out) {
  const bytes = plane.subarray(start, start + width * 4)
  for (let i = 1; i < bytes.length; i++) bytes[i] = (bytes[i] + bytes[i - 1]) & 0xff
  // Planes are stored most significant first; the file is little-endian, so
  // they go back in reverse.
  for (let j = 0; j < width; j++) {
    out[j * 4 + 3] = bytes[j]
    out[j * 4 + 2] = bytes[width + j]
    out[j * 4 + 1] = bytes[width * 2 + j]
    out[j * 4] = bytes[width * 3 + j]
  }
}

function boxAverage(walk, srcWidth, srcHeight, width, height) {
  // Float32 is exact for these: a cell sums a handful of values under 10000.
  const sums = new Float32Array(width * height)
  const hits = new Uint16Array(width * height)

  walk((sx, sy, value) => {
    const index =
      Math.floor((sy * height) / srcHeight) * width + Math.floor((sx * width) / srcWidth)
    sums[index] += value
    hits[index]++
  })

  const grid = new Int16Array(width * height)
  let missing = 0
  for (let i = 0; i < grid.length; i++) {
    if (hits[i] === 0) {
      missing++
      continue
    }
    grid[i] = Math.round(sums[i] / hits[i])
  }
  if (missing) console.warn(`Warning: ${missing} cells had no source data`)
  return grid
}

// --- Pyramid --------------------------------------------------------------

/** Average each level down into the next, so every level is a true mean. */
function buildPyramid(finest) {
  const levels = new Array(LEVELS)
  levels[FINEST] = finest
  for (let z = FINEST - 1; z >= 0; z--) {
    const width = levelWidth(z)
    const height = levelHeight(z)
    const child = levels[z + 1]
    const childWidth = width * 2
    const grid = new Int16Array(width * height)
    for (let y = 0; y < height; y++) {
      const rowA = y * 2 * childWidth
      const rowB = rowA + childWidth
      for (let x = 0; x < width; x++) {
        const a = x * 2
        grid[y * width + x] = Math.round(
          (child[rowA + a] + child[rowA + a + 1] + child[rowB + a] + child[rowB + a + 1]) / 4,
        )
      }
    }
    levels[z] = grid
    console.log(`  level ${z}: ${width}x${height}`)
  }
  return levels
}

/**
 * What a level looks like predicted from the one above it, which is what a
 * client that stopped fetching at the parent would be drawing.
 *
 * Cell centres, so a child sample sits a quarter of a parent cell either side
 * of the parent centre - the 0.25/0.75 weights below. Longitude wraps; latitude
 * clamps, because past the pole there is no next row.
 */
function predictFromParent(parent, z) {
  const width = levelWidth(z)
  const height = levelHeight(z)
  const pw = width / 2
  const ph = height / 2
  const out = new Int16Array(width * height)

  for (let y = 0; y < height; y++) {
    const fy = (y + 0.5) / 2 - 0.5
    let y0 = Math.floor(fy)
    const ty = fy - y0
    let y1 = y0 + 1
    if (y0 < 0) y0 = 0
    if (y1 > ph - 1) y1 = ph - 1
    const rowA = y0 * pw
    const rowB = y1 * pw

    for (let x = 0; x < width; x++) {
      const fx = (x + 0.5) / 2 - 0.5
      let x0 = Math.floor(fx)
      const tx = fx - x0
      if (x0 < 0) x0 += pw
      const x1 = x0 + 1 < pw ? x0 + 1 : 0

      const top = parent[rowA + x0] + (parent[rowA + x1] - parent[rowA + x0]) * tx
      const bottom = parent[rowB + x0] + (parent[rowB + x1] - parent[rowB + x0]) * tx
      out[y * width + x] = Math.round(top + (bottom - top) * ty)
    }
  }
  return out
}

// --- Tiles ----------------------------------------------------------------

/**
 * Cut one stored tile out of a level, border included.
 *
 * Longitude wraps and latitude clamps, so the border is real data everywhere
 * except at the poles, where holding the last row is the same thing the
 * sampler does.
 */
function cutTile(grid, z, tileX, tileY) {
  const width = levelWidth(z)
  const height = levelHeight(z)
  const out = new Int16Array(STORED * STORED)

  for (let y = 0; y < STORED; y++) {
    let sy = tileY * TILE + y - BORDER
    if (sy < 0) sy = 0
    else if (sy > height - 1) sy = height - 1
    const row = sy * width

    for (let x = 0; x < STORED; x++) {
      let sx = tileX * TILE + x - BORDER
      if (sx < 0) sx += width
      else if (sx >= width) sx -= width
      out[y * STORED + x] = grid[row + sx]
    }
  }
  return out
}

/**
 * Predict each sample from the one to its left before compressing. Terrain is
 * smooth at these resolutions, so the residuals are small and their high bytes
 * are almost all 0x00 or 0xff, which is what Deflate is good at. The first of
 * each row predicts from the row above, so the whole tile is covered.
 */
function encodeTile(samples) {
  const residuals = new Int16Array(samples.length)
  for (let y = 0; y < STORED; y++) {
    const row = y * STORED
    for (let x = 0; x < STORED; x++) {
      const predicted =
        x > 0 ? samples[row + x - 1] : y > 0 ? samples[row - STORED] : 0
      // Int16Array wraps on overflow, which is exactly the modular arithmetic
      // the decoder undoes.
      residuals[row + x] = samples[row + x] - predicted
    }
  }
  return deflateSync(Buffer.from(residuals.buffer, 0, residuals.byteLength), { level: 9 })
}

// --- Build ----------------------------------------------------------------

const finest = await loadFinest()
console.log('Building the pyramid...')
const pyramid = buildPyramid(finest)

// The tallest ground anywhere, taken from the finest level so that a client
// holding only level 0 still knows how far terrain can stand off the sphere.
// It sizes the region that gets shaded, and clipping it would saw the tops off
// mountains at the limb.
let peak = 0
for (const sample of pyramid[FINEST]) if (sample > peak) peak = sample

console.log('\nCutting tiles...')
let total = 0
let firstLevelBytes = 0

for (let z = 0; z < LEVELS; z++) {
  const width = levelWidth(z)
  const grid = pyramid[z]
  // Level 0 has no parent, so what a client would be drawing without it is a
  // sphere at sea level.
  const predicted = z === 0 ? new Int16Array(grid.length) : predictFromParent(pyramid[z - 1], z)

  const across = tilesAcrossAt(z)
  const down = tilesDownAt(z)
  const tileCount = across * down
  const index = Buffer.alloc(tileCount * INDEX_ENTRY_BYTES)
  const payloads = []
  let offset = 0
  let entry = 0

  for (let tileY = 0; tileY < down; tileY++) {
    for (let tileX = 0; tileX < across; tileX++) {
      const samples = cutTile(grid, z, tileX, tileY)
      const packed = encodeTile(samples)

      // Measured over the interior only: the border belongs to the neighbours,
      // and counting it would let one tile's cliff drive its neighbour's.
      let error = 0
      let low = 32767
      let high = -32768
      for (let y = 0; y < TILE; y++) {
        const row = (tileY * TILE + y) * width + tileX * TILE
        for (let x = 0; x < TILE; x++) {
          const sample = grid[row + x]
          const off = Math.abs(sample - predicted[row + x])
          if (off > error) error = off
          if (sample < low) low = sample
          if (sample > high) high = sample
        }
      }

      const at = entry * INDEX_ENTRY_BYTES
      index.writeUInt32LE(offset, at)
      index.writeUInt32LE(packed.length, at + 4)
      index.writeUInt16LE(Math.min(65535, error), at + 8)
      index.writeInt16LE(low, at + 10)
      index.writeInt16LE(high, at + 12)

      payloads.push(packed)
      offset += packed.length
      entry++
    }
  }

  // Every file says how many levels the pyramid had, so a client that has only
  // level 0 knows what else it may ask for - and gets a 404 it can live with if
  // the deeper ones were not deployed.
  const header = Buffer.alloc(HEADER_BYTES)
  header.write(MAGIC, 0, 'ascii')
  header.writeUInt16LE(VERSION, 8)
  header.writeUInt16LE(TILE, 10)
  header.writeUInt8(BORDER, 12)
  header.writeUInt8(LEVELS, 13)
  header.writeUInt8(z, 14)
  header.writeUInt32LE(index.length, 16)
  header.writeUInt32LE(HEADER_BYTES + index.length, 20)
  header.writeUInt32LE(tileCount, 24)
  header.writeInt16LE(peak, 28)

  const file = Buffer.concat([header, index, ...payloads])
  await writeFile(`${OUT}-${z}.bin`, file)
  total += file.length
  if (z === 0) firstLevelBytes = file.length

  const rawBytes = width * levelHeight(z) * 2
  console.log(
    `  level ${z}: ${String(tileCount).padStart(4)} tiles  ` +
      `${mb(file.length).padStart(8)}  from ${mb(rawBytes)} raw  ` +
      `(${(rawBytes / file.length).toFixed(1)}:1)  ` +
      `${(360 / width).toFixed(3)} deg/sample  ` +
      `-> ${OUT.split('/').pop()}-${z}.bin`,
  )
}

console.log(
  `\nWrote ${LEVELS} level files, ${mb(total)} in all, peak ${peak} m\n` +
    `  level 0 is ${mb(firstLevelBytes)} and draws the whole world - one plain GET, no range needed\n` +
    `  deeper levels are optional: host the files you want, the client falls back to what is there`,
)

function mb(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
    : `${(bytes / 1024).toFixed(0)} kB`
}
