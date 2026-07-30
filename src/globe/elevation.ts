/**
 * The elevation grid, and how the shader reads it.
 *
 * `scripts/build-elevation.mjs` bakes NOAA's ETOPO 2022 relief model down to a
 * committed grid of 16-bit metres, seamless across the coastline: positive is
 * land, negative is sea floor, and there is no join between two datasets to go
 * wrong. It is stored as differences from the neighbouring sample and then
 * Deflate-compressed, which is roughly what a PNG would do - but read back
 * through `DecompressionStream` rather than an image, because drawing a 16-bit
 * PNG to a canvas is the one thing guaranteed to throw the low byte away.
 *
 * Sampling returns the height and the slope from the same four taps. The
 * shading pass covers about two samples per degree of longitude while the grid
 * holds nearly six, so this is reading a grid finer than the screen it lands
 * on; the gradient is taken across a whole cell rather than fitted to
 * something smaller, which is the right end to err on when downsampling.
 */

const MAGIC = 'ERSE'
const HEADER_BYTES = 8

export type ElevationGrid = {
  width: number
  height: number
  /**
   * Metres above sea level, row major. Row 0 is latitude +90 and column 0 is
   * longitude -180, each sample being the centre of its cell.
   */
  data: Int16Array
}

/** Fetch and decode the committed grid. */
export async function loadElevation(url: string): Promise<ElevationGrid> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Elevation fetch failed: HTTP ${response.status}`)
  }
  if (!response.body) throw new Error('Elevation fetch returned no body')

  const stream = response.body.pipeThrough(new DecompressionStream('deflate'))
  const buffer = await new Response(stream).arrayBuffer()
  return decodeElevation(buffer)
}

export function decodeElevation(buffer: ArrayBuffer): ElevationGrid {
  const header = new DataView(buffer)
  const magic = String.fromCharCode(
    header.getUint8(0),
    header.getUint8(1),
    header.getUint8(2),
    header.getUint8(3),
  )
  if (magic !== MAGIC) throw new Error('Elevation data has the wrong magic')

  const width = header.getUint16(4, true)
  const height = header.getUint16(6, true)

  const expected = HEADER_BYTES + width * height * 2
  if (buffer.byteLength !== expected) {
    throw new Error(
      `Elevation data is ${buffer.byteLength} bytes, expected ${expected} for ${width}x${height}`,
    )
  }

  // Undo the predictor the build script applied: each sample was stored as the
  // difference from the one to its left, and the first of each row as the
  // difference from the row above. Int16Array wraps on overflow, which is the
  // same modular arithmetic the encoder relied on.
  const data = new Int16Array(buffer, HEADER_BYTES, width * height)
  for (let y = 0; y < height; y++) {
    const row = y * width
    data[row] += y > 0 ? data[row - width] : 0
    for (let x = 1; x < width; x++) data[row + x] += data[row + x - 1]
  }

  return { width, height, data }
}

/**
 * Height in metres, plus the slope across one grid cell in each direction.
 *
 * Written into `out` so the shading loop allocates nothing, and taken from a
 * single set of four taps: the bilinear patch those four corners define has an
 * exact gradient, so the slope costs no extra reads.
 */
export type Relief = {
  /** Metres above sea level. */
  height: number
  /** Rise in metres per grid cell, eastward. */
  east: number
  /** Rise in metres per grid cell, northward. */
  north: number
}

export function sampleRelief(
  grid: ElevationGrid,
  longitude: number,
  latitude: number,
  out: Relief,
): Relief {
  // Cell centres sit half a cell in from the edges of their cell.
  return sampleReliefAt(
    grid,
    ((longitude + 180) / 360) * grid.width - 0.5,
    ((90 - latitude) / 180) * grid.height - 0.5,
    out,
  )
}

/**
 * The same, at fractional grid coordinates rather than degrees.
 *
 * The shading loop works in these directly: it already has the sine and cosine
 * of the latitude in hand from the unprojection, so it can reach a row and
 * column without ever forming an angle in degrees.
 */
export function sampleReliefAt(
  grid: ElevationGrid,
  fx: number,
  fy: number,
  out: Relief,
): Relief {
  const { width, height, data } = grid

  let x0 = Math.floor(fx)
  const tx = fx - x0
  // Longitude wraps; a sample just west of the antimeridian must interpolate
  // against the column at the far edge of the grid rather than clamp.
  if (x0 < 0 || x0 >= width) x0 %= width
  if (x0 < 0) x0 += width
  const x1 = x0 + 1 < width ? x0 + 1 : 0

  let y0 = Math.floor(fy)
  let ty = fy - y0
  // Latitude does not wrap: past the pole there is no next row, so hold the
  // last one rather than folding over onto the other side of the globe.
  if (y0 < 0) {
    y0 = 0
    ty = 0
  } else if (y0 >= height - 1) {
    y0 = height - 1
    ty = 0
  }
  const y1 = y0 + 1 < height ? y0 + 1 : y0

  const rowA = y0 * width
  const rowB = y1 * width
  const h00 = data[rowA + x0]
  const h10 = data[rowA + x1]
  const h01 = data[rowB + x0]
  const h11 = data[rowB + x1]

  const top = h00 + (h10 - h00) * tx
  const bottom = h01 + (h11 - h01) * tx

  out.height = top + (bottom - top) * ty
  out.east = h10 - h00 + (h11 - h01 - (h10 - h00)) * ty
  // Rows run north to south, so a rise going down the grid is a fall going
  // north.
  out.north = -(h01 - h00 + (h11 - h10 - (h01 - h00)) * tx)
  return out
}
