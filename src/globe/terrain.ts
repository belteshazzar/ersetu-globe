/**
 * The globe as displaced geometry rather than a painted sphere.
 *
 * Every vertex of a lon/lat mesh is pushed out to `1 + k*h`, so mountains
 * genuinely stand off the surface and basins genuinely sink into it. The mesh
 * is then rasterised here, in software, with a depth buffer - the 2D canvas has
 * no notion of depth, so a mountain can only hide what is behind it if we sort
 * that out ourselves.
 *
 * Two things make this much cheaper than it sounds.
 *
 * An orthographic projection is affine: there is no perspective divide, so
 * attributes interpolate exactly with plain screen-space barycentrics and no
 * correction is needed anywhere.
 *
 * And the rasteriser does not shade. It writes only where on the elevation grid
 * each covered sample landed, plus its depth - a G-buffer - and the shading
 * pass then reads the full resolution grid per pixel. Geometry is therefore
 * limited by the mesh, but the shading is not: the relief keeps every bit of
 * the detail it had when it was only a lighting trick, while the silhouette,
 * the parallax and the occlusion become real.
 *
 * The surface is closed and star-shaped about the centre - a radial height
 * field has no overhangs - so any back-facing triangle is hidden by front-
 * facing geometry, and winding order alone is a sound way to discard half the
 * mesh before rasterising.
 */
import type { Camera } from './projection'
import type { ElevationGrid } from './elevation'

const EARTH_RADIUS_M = 6_371_000

/**
 * Mesh resolution, in steps of longitude and latitude.
 *
 * There is no point carrying more triangles than the buffer has samples: past
 * that they cost their setup and cover nothing. This lands a little under one
 * triangle per sample at the default size, which is where the cost of the
 * setup and the cost of the coverage are about even.
 */
const LON_STEPS = 320
const LAT_STEPS = 160

export type TerrainMesh = {
  lonSteps: number
  latSteps: number
  vertexCount: number
  /** Unit direction of each vertex, xyz. The shape of the globe, undisplaced. */
  directions: Float32Array
  /**
   * Height at each vertex, already divided by the Earth's radius, so a vertex
   * sits at `1 + exaggeration * lift` globe radii.
   *
   * Kept apart from the direction so that exaggeration is not baked into the
   * mesh: it becomes three multiplies in the per-frame vertex transform, and a
   * control that changes it costs nothing rather than rebuilding fifty thousand
   * vertices on every drag of a slider.
   */
  lifts: Float32Array
  /** The largest outward lift, for sizing the area that needs shading. */
  maxLift: number
  /** Where each vertex sits on the elevation grid, uv per vertex. */
  coords: Float32Array
}

/**
 * Build the displaced mesh. Done once, when the elevation arrives: the shape
 * is fixed in the globe's own frame, and only the camera moves.
 *
 * The seam at the antimeridian gets a duplicate column whose grid coordinate
 * runs on to the full width rather than wrapping to zero, so that triangles
 * spanning it interpolate forwards across the join instead of racing back
 * around the world.
 */
export function buildTerrain(
  grid: ElevationGrid,
  lonSteps = LON_STEPS,
  latSteps = LAT_STEPS,
): TerrainMesh {
  const cols = lonSteps + 1
  const rows = latSteps + 1
  const vertexCount = cols * rows

  const directions = new Float32Array(vertexCount * 3)
  const lifts = new Float32Array(vertexCount)
  const coords = new Float32Array(vertexCount * 2)
  let maxLift = 0

  for (let j = 0; j < rows; j++) {
    // Rows run north to south, matching the grid.
    const v = (j / latSteps) * grid.height - 0.5
    const latitude = (Math.PI / 2) * (1 - (2 * j) / latSteps)
    const cosLat = Math.cos(latitude)
    const sinLat = Math.sin(latitude)

    for (let i = 0; i < cols; i++) {
      const u = (i / lonSteps) * grid.width - 0.5
      const longitude = (2 * Math.PI * i) / lonSteps - Math.PI

      const vertex = j * cols + i
      const at = vertex * 3
      directions[at] = cosLat * Math.sin(longitude)
      directions[at + 1] = sinLat
      directions[at + 2] = cosLat * Math.cos(longitude)

      const lift = sampleHeight(grid, u, v) / EARTH_RADIUS_M
      lifts[vertex] = lift
      if (lift > maxLift) maxLift = lift

      const uv = vertex * 2
      coords[uv] = u
      coords[uv + 1] = v
    }
  }

  return { lonSteps, latSteps, vertexCount, directions, lifts, maxLift, coords }
}

/**
 * Bilinear height at fractional grid coordinates.
 *
 * Deliberately not `sampleReliefAt`: this runs once per vertex at build time
 * and wants only the height, not the slope, and it must not let the poles fold
 * over onto the far side of the globe.
 */
function sampleHeight(grid: ElevationGrid, fx: number, fy: number): number {
  const { width, height, data } = grid

  let x0 = Math.floor(fx)
  const tx = fx - x0
  if (x0 < 0 || x0 >= width) x0 %= width
  if (x0 < 0) x0 += width
  const x1 = x0 + 1 < width ? x0 + 1 : 0

  let y0 = Math.floor(fy)
  let ty = fy - y0
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
  const top = data[rowA + x0] + (data[rowA + x1] - data[rowA + x0]) * tx
  const bottom = data[rowB + x0] + (data[rowB + x1] - data[rowB + x0]) * tx
  return top + (bottom - top) * ty
}

/**
 * What the rasteriser leaves behind for the shading pass: where on the
 * elevation grid each sample landed, and how near the camera it was.
 */
export type GBuffer = {
  width: number
  height: number
  u: Float32Array
  v: Float32Array
  /** Camera-space depth, larger being nearer. NOT_COVERED where nothing hit. */
  depth: Float32Array
}

/**
 * Depth of a sample nothing was drawn to.
 *
 * Infinity rather than some very negative number because the buffer is
 * Float32: a value like -1e30 does not survive the round trip through single
 * precision, so testing a sample against it never matches and every pixel
 * reads as covered.
 */
export const NOT_COVERED = -Infinity

let gbuffer: GBuffer | null = null

export function getGBuffer(width: number, height: number): GBuffer {
  const needed = width * height
  if (!gbuffer || gbuffer.u.length < needed) {
    gbuffer = {
      width,
      height,
      u: new Float32Array(needed),
      v: new Float32Array(needed),
      depth: new Float32Array(needed),
    }
  }
  gbuffer.width = width
  gbuffer.height = height
  gbuffer.depth.fill(NOT_COVERED, 0, needed)
  return gbuffer
}

// Per-frame vertex arrays, grown as needed and reused.
let screenX = new Float32Array(0)
let screenY = new Float32Array(0)
let screenZ = new Float32Array(0)

/**
 * How the buffer's samples line up with the globe on screen. The shading pass
 * walks samples and derives camera coordinates; the rasteriser has to go the
 * other way, and the two must agree exactly or the geometry and the lighting
 * would disagree about where the surface is.
 */
export type BufferPlacement = {
  scaleX: number
  offsetX: number
  scaleY: number
  offsetY: number
}

export function placeBuffer(
  camera: Camera,
  x0: number,
  y0: number,
  stepX: number,
  stepY: number,
): BufferPlacement {
  return {
    scaleX: camera.radius / stepX,
    offsetX: (camera.cx - x0) / stepX - 0.5,
    scaleY: camera.radius / stepY,
    offsetY: (camera.cy - y0) / stepY - 0.5,
  }
}

/** Rasterise the displaced mesh into the G-buffer. */
export function rasteriseTerrain(
  mesh: TerrainMesh,
  camera: Camera,
  place: BufferPlacement,
  target: GBuffer,
  exaggeration: number,
) {
  const { directions, lifts, lonSteps, latSteps, vertexCount } = mesh
  const { cosLon, sinLon, cosLat, sinLat } = camera

  if (screenX.length < vertexCount) {
    screenX = new Float32Array(vertexCount)
    screenY = new Float32Array(vertexCount)
    screenZ = new Float32Array(vertexCount)
  }

  // Vertices first, so each is transformed once however many triangles share
  // it - six, for every interior vertex of the grid.
  for (let i = 0; i < vertexCount; i++) {
    const at = i * 3
    // Displacing here rather than in the mesh is what makes exaggeration a
    // free parameter: three multiplies on work the transform was doing anyway.
    const radius = 1 + lifts[i] * exaggeration
    const x = directions[at] * radius
    const y = directions[at + 1] * radius
    const z = directions[at + 2] * radius

    const x1 = x * cosLon - z * sinLon
    const z1 = x * sinLon + z * cosLon
    const cy = y * cosLat - z1 * sinLat
    const cz = y * sinLat + z1 * cosLat

    screenX[i] = x1 * place.scaleX + place.offsetX
    screenY[i] = place.offsetY - cy * place.scaleY
    screenZ[i] = cz
  }

  const cols = lonSteps + 1
  for (let j = 0; j < latSteps; j++) {
    const row = j * cols
    const next = row + cols
    for (let i = 0; i < lonSteps; i++) {
      const a = row + i
      const b = row + i + 1
      const c = next + i + 1
      const d = next + i
      triangle(mesh, target, a, b, c)
      triangle(mesh, target, a, c, d)
    }
  }
}

/**
 * Rasterise one triangle with a depth test.
 *
 * Coverage comes from the sign of the three edge functions, which is the usual
 * half-plane test; because the projection is affine those same edge functions,
 * normalised, are the barycentric weights, so depth and grid coordinates come
 * out of work already done.
 */
function triangle(
  mesh: TerrainMesh,
  target: GBuffer,
  ia: number,
  ib: number,
  ic: number,
) {
  const ax = screenX[ia]
  const ay = screenY[ia]
  const bx = screenX[ib]
  const by = screenY[ib]
  const cx = screenX[ic]
  const cy = screenY[ic]

  // Signed area: negative is back-facing, zero is degenerate - which is what
  // every triangle collapsed onto a pole becomes.
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  if (area <= 1e-12) return

  const { width, height, u, v, depth } = target

  let minX = Math.floor(ax < bx ? (ax < cx ? ax : cx) : bx < cx ? bx : cx)
  let maxX = Math.ceil(ax > bx ? (ax > cx ? ax : cx) : bx > cx ? bx : cx)
  let minY = Math.floor(ay < by ? (ay < cy ? ay : cy) : by < cy ? by : cy)
  let maxY = Math.ceil(ay > by ? (ay > cy ? ay : cy) : by > cy ? by : cy)

  if (minX < 0) minX = 0
  if (minY < 0) minY = 0
  if (maxX > width - 1) maxX = width - 1
  if (maxY > height - 1) maxY = height - 1
  if (minX > maxX || minY > maxY) return

  const az = screenZ[ia]
  const bz = screenZ[ib]
  const cz = screenZ[ic]

  const coords = mesh.coords
  const au = coords[ia * 2]
  const av = coords[ia * 2 + 1]
  const bu = coords[ib * 2]
  const bv = coords[ib * 2 + 1]
  const cu = coords[ic * 2]
  const cv = coords[ic * 2 + 1]

  const inv = 1 / area

  for (let py = minY; py <= maxY; py++) {
    const y = py
    const rowBase = py * width

    // Edge functions are affine in x, so step them along the scanline rather
    // than recomputing all three per sample.
    const w0Row = (cx - bx) * (y - by) - (cy - by) * (minX - bx)
    const w1Row = (ax - cx) * (y - cy) - (ay - cy) * (minX - cx)
    const w2Row = (bx - ax) * (y - ay) - (by - ay) * (minX - ax)
    const w0Step = -(cy - by)
    const w1Step = -(ay - cy)
    const w2Step = -(by - ay)

    let w0 = w0Row
    let w1 = w1Row
    let w2 = w2Row

    for (let px = minX; px <= maxX; px++, w0 += w0Step, w1 += w1Step, w2 += w2Step) {
      if (w0 < 0 || w1 < 0 || w2 < 0) continue

      const l0 = w0 * inv
      const l1 = w1 * inv
      const l2 = w2 * inv

      const z = az * l0 + bz * l1 + cz * l2
      const index = rowBase + px
      if (z <= depth[index]) continue

      depth[index] = z
      u[index] = au * l0 + bu * l1 + cu * l2
      v[index] = av * l0 + bv * l1 + cv * l2
    }
  }
}
