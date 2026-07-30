/**
 * Downloads NOAA's ETOPO 2022 global relief model and emits a compact
 * elevation grid for the renderer.
 *
 * Run with: node scripts/build-elevation.mjs [width]
 *
 * ETOPO is the useful source here because it is seamless: topography and
 * bathymetry come from one grid, so there is no coastline seam to reconcile
 * between two datasets. The published 60 arc-second GeoTIFF is 466 MB of
 * Deflate-compressed 32-bit float in 256x256 tiles, which is far more than a
 * globe this size can show - the shading pass is capped at 160k samples, about
 * two per degree of longitude - so the grid is box-averaged down on the way
 * through and written as 16-bit metres.
 *
 * Averaging rather than sampling matters: point-sampling one 15 arc-second
 * cell out of every block would keep whichever peak or trench it happened to
 * land on and drop the rest, which reads as speckle once the result is used to
 * light a surface.
 *
 * The output is committed, like the coastlines, so the app ships with it
 * rather than fetching from NOAA at runtime. Re-run this only to change the
 * resolution.
 */
import { writeFile } from 'node:fs/promises'
import { deflateSync, inflateSync } from 'node:zlib'

const SOURCE =
  'https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif'

// Ice surface rather than bedrock: this is a picture of the Earth as it looks,
// and under the ice sheets the bedrock is a different planet entirely.
const OUT_WIDTH = Number(process.argv[2] ?? 2048)
const OUT_HEIGHT = OUT_WIDTH / 2

if (!Number.isInteger(OUT_WIDTH) || OUT_WIDTH < 64 || OUT_WIDTH % 2 !== 0) {
  console.error(`Bad width "${process.argv[2]}". Expected an even integer >= 64.`)
  process.exit(1)
}

/** ETOPO marks absent data with this; the global grid should have none. */
const NODATA = -99999

// Header: magic, then the grid dimensions as uint16. Eight bytes keeps the
// int16 samples that follow two-byte aligned.
const MAGIC = 'ERSE'
const HEADER_BYTES = 8

// --- TIFF directory -------------------------------------------------------

/** Read a byte range without pulling the whole file. */
async function fetchRange(from, to) {
  const response = await fetch(SOURCE, { headers: { Range: `bytes=${from}-${to}` } })
  if (!response.ok) throw new Error(`Range request failed: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

console.log('Reading TIFF directory...')
const head = await fetchRange(0, 65535)

if (head.toString('ascii', 0, 2) !== 'II' || head.readUInt16LE(2) !== 42) {
  throw new Error('Not a little-endian classic TIFF; the layout assumed here has changed.')
}

const ifd = head.readUInt32LE(4)
const entryCount = head.readUInt16LE(ifd)
const tags = new Map()
for (let i = 0; i < entryCount; i++) {
  const offset = ifd + 2 + i * 12
  const tag = head.readUInt16LE(offset)
  const type = head.readUInt16LE(offset + 2)
  const count = head.readUInt32LE(offset + 4)
  // SHORT values sit in the low half of the value field; everything larger is
  // a file offset to an array.
  const value = type === 3 ? head.readUInt16LE(offset + 8) : head.readUInt32LE(offset + 8)
  tags.set(tag, { type, count, value })
}

const tag = (id, name) => {
  const found = tags.get(id)
  if (!found) throw new Error(`Missing TIFF tag ${name} (${id})`)
  return found
}

const srcWidth = tag(256, 'ImageWidth').value
const srcHeight = tag(257, 'ImageLength').value
const tileWidth = tag(322, 'TileWidth').value
const tileHeight = tag(323, 'TileLength').value
const tileOffsets = tag(324, 'TileOffsets')
const tileCounts = tag(325, 'TileByteCounts')

// The decoder below understands exactly one layout. Anything else means NOAA
// republished the file differently and the assumptions need revisiting.
const expect = (actual, wanted, what) => {
  if (actual !== wanted) throw new Error(`Unexpected ${what}: ${actual} (expected ${wanted})`)
}
expect(tag(258, 'BitsPerSample').value, 32, 'BitsPerSample')
expect(tag(339, 'SampleFormat').value, 3, 'SampleFormat (want IEEE float)')
expect(tag(259, 'Compression').value, 8, 'Compression (want Deflate)')
expect(tag(317, 'Predictor').value, 3, 'Predictor (want floating point)')
expect(tag(277, 'SamplesPerPixel').value, 1, 'SamplesPerPixel')

const tilesAcross = Math.ceil(srcWidth / tileWidth)
const tilesDown = Math.ceil(srcHeight / tileHeight)
const tileCount = tilesAcross * tilesDown
expect(tileOffsets.count, tileCount, 'TileOffsets count')

const directory = await fetchRange(
  Math.min(tileOffsets.value, tileCounts.value),
  Math.max(tileOffsets.value, tileCounts.value) + tileCount * 4 - 1,
)
const base = Math.min(tileOffsets.value, tileCounts.value)
const offsets = new Array(tileCount)
const counts = new Array(tileCount)
for (let i = 0; i < tileCount; i++) {
  offsets[i] = directory.readUInt32LE(tileOffsets.value - base + i * 4)
  counts[i] = directory.readUInt32LE(tileCounts.value - base + i * 4)
}

// Tiles pack the file back to back, but not in tile-index order - the writer
// laid them out in some other sequence. Walking them in offset order rather
// than index order lets the whole thing be consumed as one forward stream
// instead of 3655 range requests; the index is still what says where each tile
// belongs in the image.
const order = [...offsets.keys()].sort((a, b) => offsets[a] - offsets[b])
for (let k = 1; k < tileCount; k++) {
  const previous = order[k - 1]
  if (offsets[order[k]] !== offsets[previous] + counts[previous]) {
    throw new Error(`Tiles are not contiguous at ${k}; streaming assumption broken.`)
  }
}

const first = order[0]
const last = order[tileCount - 1]
const totalBytes = offsets[last] + counts[last]
console.log(
  `Source ${srcWidth}x${srcHeight}, ${tileCount} tiles of ${tileWidth}x${tileHeight}, ${(totalBytes / 1e6).toFixed(0)} MB`,
)
console.log(`Averaging down to ${OUT_WIDTH}x${OUT_HEIGHT}...`)

// --- Stream and accumulate ------------------------------------------------

// Running mean per output cell. Float64 because a cell sums ~110 samples and
// the result is rounded to a metre at the end.
const sums = new Float64Array(OUT_WIDTH * OUT_HEIGHT)
const hits = new Uint32Array(OUT_WIDTH * OUT_HEIGHT)

/**
 * Undo the TIFF floating-point predictor, in place, one tile row at a time.
 *
 * The predictor does two things: it splits each sample into byte planes -
 * all the most significant bytes of the row first, then the next plane, and so
 * on, which puts similar magnitudes next to each other - and then stores each
 * byte as a difference from its neighbour. Deflate sees a long run of near
 * zeroes instead of scattered float bits, which is where the 4:1 comes from.
 */
function undoFloatPredictor(bytes, width, height) {
  const rowBytes = width * 4
  const out = Buffer.allocUnsafe(bytes.length)

  for (let row = 0; row < height; row++) {
    const start = row * rowBytes

    for (let i = 1; i < rowBytes; i++) {
      bytes[start + i] = (bytes[start + i] + bytes[start + i - 1]) & 0xff
    }

    // Planes are stored most significant first; the file is little-endian, so
    // they go back in reverse.
    for (let j = 0; j < width; j++) {
      out[start + j * 4 + 3] = bytes[start + j]
      out[start + j * 4 + 2] = bytes[start + width + j]
      out[start + j * 4 + 1] = bytes[start + width * 2 + j]
      out[start + j * 4] = bytes[start + width * 3 + j]
    }
  }

  return out
}

const response = await fetch(SOURCE)
if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)

const reader = response.body.getReader()
let pending = Buffer.alloc(0)
let consumed = 0
let done = 0
let reported = -1

/** Pull `length` bytes out of the stream, buffering across chunk boundaries. */
async function take(length) {
  while (pending.length < length) {
    const { value, done } = await reader.read()
    if (done) throw new Error('Stream ended early')
    pending = pending.length ? Buffer.concat([pending, value]) : Buffer.from(value)
  }
  const out = pending.subarray(0, length)
  pending = pending.subarray(length)
  consumed += length
  return out
}

// Everything before the first tile is header and directory.
await take(offsets[first])

while (done < tileCount) {
  const tile = order[done]
  const raw = Buffer.from(await take(counts[tile]))
  const bytes = inflateSync(raw)
  const pixels = undoFloatPredictor(bytes, tileWidth, tileHeight)
  const values = new Float32Array(pixels.buffer, pixels.byteOffset, tileWidth * tileHeight)

  const tileX = (tile % tilesAcross) * tileWidth
  const tileY = Math.floor(tile / tilesAcross) * tileHeight

  for (let y = 0; y < tileHeight; y++) {
    const sy = tileY + y
    // The last row and column of tiles run past the image; that padding is
    // not data.
    if (sy >= srcHeight) break
    const ty = Math.floor((sy * OUT_HEIGHT) / srcHeight) * OUT_WIDTH

    for (let x = 0; x < tileWidth; x++) {
      const sx = tileX + x
      if (sx >= srcWidth) break
      const value = values[y * tileWidth + x]
      if (!Number.isFinite(value) || value <= NODATA) continue
      const index = ty + Math.floor((sx * OUT_WIDTH) / srcWidth)
      sums[index] += value
      hits[index]++
    }
  }

  done++
  const percent = Math.floor((consumed / totalBytes) * 100)
  if (percent >= reported + 5) {
    reported = percent
    console.log(`  ${percent}% (${(consumed / 1e6).toFixed(0)} MB, ${done}/${tileCount} tiles)`)
  }
}

// --- Encode ---------------------------------------------------------------

const elevation = new Int16Array(OUT_WIDTH * OUT_HEIGHT)
let missing = 0
let min = Infinity
let max = -Infinity
for (let i = 0; i < elevation.length; i++) {
  if (hits[i] === 0) {
    missing++
    continue
  }
  const value = Math.round(sums[i] / hits[i])
  elevation[i] = value
  if (value < min) min = value
  if (value > max) max = value
}
if (missing) console.warn(`Warning: ${missing} output cells had no source data`)

/**
 * Predict each sample from its neighbours before compressing. Terrain is
 * smooth at this resolution, so the residuals are small and their high bytes
 * are almost all 0x00 or 0xff - which is what Deflate is good at. The first
 * column predicts from the row above so the whole grid is covered, and the
 * prediction wraps at the antimeridian because the grid does.
 */
const residuals = new Int16Array(elevation.length)
for (let y = 0; y < OUT_HEIGHT; y++) {
  const row = y * OUT_WIDTH
  for (let x = 0; x < OUT_WIDTH; x++) {
    const here = elevation[row + x]
    const predicted =
      x > 0 ? elevation[row + x - 1] : y > 0 ? elevation[row - OUT_WIDTH] : 0
    // Int16Array wraps on overflow, which is exactly the modular arithmetic
    // the decoder undoes.
    residuals[row + x] = here - predicted
  }
}

// The grid is self-describing, so the loader never has to be kept in step with
// whatever resolution this was last run at.
const payload = Buffer.alloc(HEADER_BYTES + residuals.byteLength)
payload.write(MAGIC, 0, 'ascii')
payload.writeUint16LE(OUT_WIDTH, 4)
payload.writeUint16LE(OUT_HEIGHT, 6)
Buffer.from(residuals.buffer, 0, residuals.byteLength).copy(payload, HEADER_BYTES)

const packed = deflateSync(payload, { level: 9 })

const target = new URL('../src/globe/data/elevation.bin', import.meta.url)
await writeFile(target, packed)

const rawSize = elevation.byteLength
console.log(
  `\nWrote ${OUT_WIDTH}x${OUT_HEIGHT} elevation grid, ${min} m to ${max} m`,
)
console.log(
  `  ${(packed.length / 1024).toFixed(0)} kB compressed from ${(rawSize / 1024).toFixed(0)} kB (${(rawSize / packed.length).toFixed(1)}:1)`,
)
console.log('  -> src/globe/data/elevation.bin')
