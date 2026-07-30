/**
 * Orthographic projection of lon/lat polylines onto a rotating sphere.
 * No dependencies, no per-frame trigonometry on point data.
 */

const DEG_TO_RAD = Math.PI / 180

/**
 * A set of polylines baked onto the unit sphere.
 * `positions` holds xyz triples; `offsets` marks where each polyline starts,
 * with a trailing entry for the end of the last one.
 */
export type Mesh = {
  positions: Float32Array
  offsets: Uint32Array
}

/** Convert flat [lon, lat, ...] degree rings into unit-sphere xyz, once. */
export function buildMesh(rings: readonly (readonly number[])[]): Mesh {
  let total = 0
  for (const ring of rings) total += ring.length / 2

  const positions = new Float32Array(total * 3)
  const offsets = new Uint32Array(rings.length + 1)

  let point = 0
  for (let r = 0; r < rings.length; r++) {
    offsets[r] = point
    const ring = rings[r]
    for (let i = 0; i < ring.length; i += 2) {
      const lon = ring[i] * DEG_TO_RAD
      const lat = ring[i + 1] * DEG_TO_RAD
      const cosLat = Math.cos(lat)
      positions[point * 3] = cosLat * Math.sin(lon)
      positions[point * 3 + 1] = Math.sin(lat)
      positions[point * 3 + 2] = cosLat * Math.cos(lon)
      point++
    }
  }
  offsets[rings.length] = point

  return { positions, offsets }
}

/** Precomputed per-frame camera terms, in CSS pixels. */
export type Camera = {
  cx: number
  cy: number
  radius: number
  cosLon: number
  sinLon: number
  cosLat: number
  sinLat: number
}

export function makeCamera(
  cx: number,
  cy: number,
  radius: number,
  longitude: number,
  latitude: number,
): Camera {
  return {
    cx,
    cy,
    radius,
    cosLon: Math.cos(longitude),
    sinLon: Math.sin(longitude),
    cosLat: Math.cos(latitude),
    sinLat: Math.sin(latitude),
  }
}

/** Build a mesh from rings of raw [x, y, z, ...] points at any radius. */
export function buildMeshFromXyz(rings: readonly (readonly number[])[]): Mesh {
  let total = 0
  for (const ring of rings) total += ring.length / 3

  const positions = new Float32Array(total * 3)
  const offsets = new Uint32Array(rings.length + 1)

  let point = 0
  for (let r = 0; r < rings.length; r++) {
    offsets[r] = point
    const ring = rings[r]
    for (let i = 0; i < ring.length; i += 3) {
      positions[point * 3] = ring[i]
      positions[point * 3 + 1] = ring[i + 1]
      positions[point * 3 + 2] = ring[i + 2]
      point++
    }
  }
  offsets[rings.length] = point

  return { positions, offsets }
}

/**
 * Whether the globe hides a point, in camera space and units of globe radii.
 *
 * Geometry sitting above the surface cannot use the surface test: being on the
 * far side is not enough to be hidden, because anything wide of the silhouette
 * is seen past the edge of the globe. A point is occluded only when it is both
 * behind the centre plane and inside the silhouette cylinder.
 */
export function isOccluded(x: number, y: number, z: number) {
  return z < 0 && x * x + y * y < 1
}

/** Screen position of a point above the surface, and whether it is visible. */
export type SpacePoint = { x: number; y: number; visible: boolean }

export function projectSpace(
  camera: Camera,
  x: number,
  y: number,
  z: number,
  out: SpacePoint,
): SpacePoint {
  rotate(camera, x, y, z)
  out.x = camera.cx + rotated.x * camera.radius
  out.y = camera.cy - rotated.y * camera.radius
  out.visible = !isOccluded(rotated.x, rotated.y, rotated.z)
  return out
}

/**
 * Stroke geometry that stands off the surface, cutting it where the globe
 * occludes it. The crossing is found by bisection rather than snapped to the
 * nearest vertex, so the path meets the silhouette cleanly.
 */
export function strokeAbove(
  ctx: CanvasRenderingContext2D,
  mesh: Mesh,
  camera: Camera,
) {
  const { positions, offsets } = mesh
  const { cx, cy, radius } = camera

  ctx.beginPath()

  for (let r = 0; r < offsets.length - 1; r++) {
    const start = offsets[r]
    const end = offsets[r + 1]

    let penDown = false
    let hasPrev = false
    let px = 0
    let py = 0
    let pz = 0

    for (let i = start; i < end; i++) {
      rotate(camera, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])
      const { x, y, z } = rotated
      const visible = !isOccluded(x, y, z)

      if (visible) {
        if (!penDown) {
          if (hasPrev) {
            crossOcclusion(px, py, pz, x, y, z)
            ctx.moveTo(cx + crossing.x * radius, cy - crossing.y * radius)
            ctx.lineTo(cx + x * radius, cy - y * radius)
          } else {
            ctx.moveTo(cx + x * radius, cy - y * radius)
          }
          penDown = true
        } else {
          ctx.lineTo(cx + x * radius, cy - y * radius)
        }
      } else if (penDown) {
        crossOcclusion(px, py, pz, x, y, z)
        ctx.lineTo(cx + crossing.x * radius, cy - crossing.y * radius)
        penDown = false
      }

      px = x
      py = y
      pz = z
      hasPrev = true
    }
  }

  ctx.stroke()
}

const crossing = { x: 0, y: 0, z: 0 }

/**
 * Locate where a segment crosses into or out of the globe's shadow. The
 * boundary is not a plane - it is the silhouette edge - so this bisects on the
 * occlusion test itself rather than solving for it.
 */
function crossOcclusion(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
) {
  const aVisible = !isOccluded(ax, ay, az)
  let lo = 0
  let hi = 1

  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2
    const mx = ax + (bx - ax) * mid
    const my = ay + (by - ay) * mid
    const mz = az + (bz - az) * mid
    if (!isOccluded(mx, my, mz) === aVisible) lo = mid
    else hi = mid
  }

  crossing.x = ax + (bx - ax) * lo
  crossing.y = ay + (by - ay) * lo
  crossing.z = az + (bz - az) * lo
}

/** A point on the globe, in degrees. */
export type GeoPoint = { longitude: number; latitude: number }

/**
 * Map a screen position back onto the sphere, inverting both the orthographic
 * projection and the camera rotation. Returns null when the point misses the
 * globe.
 */
export function unproject(
  camera: Camera,
  screenX: number,
  screenY: number,
): GeoPoint | null {
  const { cx, cy, radius, cosLon, sinLon, cosLat, sinLat } = camera

  const nx = (screenX - cx) / radius
  const ny = (cy - screenY) / radius
  const r2 = nx * nx + ny * ny
  if (r2 > 1) return null

  const nz = Math.sqrt(1 - r2)

  // Undo the pitch, then the yaw.
  const wy = ny * cosLat + nz * sinLat
  const z1 = nz * cosLat - ny * sinLat
  const wx = nx * cosLon + z1 * sinLon
  const wz = z1 * cosLon - nx * sinLon

  return {
    longitude: (Math.atan2(wx, wz) * 180) / Math.PI,
    latitude: (Math.asin(Math.min(1, Math.max(-1, wy))) * 180) / Math.PI,
  }
}

// Scratch space, reused every call so the render loop allocates nothing.
const rotated = { x: 0, y: 0, z: 0 }

/**
 * Rotate a sphere point into camera space: yaw by -longitude, then pitch by
 * +latitude, which puts the point under the camera at (0, 0, 1).
 * Front-facing points end up with z > 0.
 */
function rotate(camera: Camera, x: number, y: number, z: number) {
  const x1 = x * camera.cosLon - z * camera.sinLon
  const z1 = x * camera.sinLon + z * camera.cosLon
  rotated.x = x1
  rotated.y = y * camera.cosLat - z1 * camera.sinLat
  rotated.z = y * camera.sinLat + z1 * camera.cosLat
}

/**
 * Stroke every polyline in the mesh, hiding the hemisphere facing away from
 * the camera. Segments straddling the horizon are cut exactly at the limb
 * rather than snapped to the nearest vertex.
 */
export function strokeMesh(
  ctx: CanvasRenderingContext2D,
  mesh: Mesh,
  camera: Camera,
) {
  const { positions, offsets } = mesh
  const { cx, cy, radius } = camera

  ctx.beginPath()

  for (let r = 0; r < offsets.length - 1; r++) {
    const start = offsets[r]
    const end = offsets[r + 1]

    let penDown = false
    // Previous point in camera space, kept for horizon interpolation.
    let px = 0
    let py = 0
    let pz = 0
    let hasPrev = false

    for (let i = start; i < end; i++) {
      rotate(camera, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])
      const { x, y, z } = rotated

      if (z > 0) {
        if (!penDown) {
          // Entering view: start at the limb if we have a point behind us.
          if (hasPrev) {
            const t = pz / (pz - z)
            moveToLimb(ctx, px + (x - px) * t, py + (y - py) * t, cx, cy, radius)
          } else {
            ctx.moveTo(cx + x * radius, cy - y * radius)
          }
          penDown = true
        }
        ctx.lineTo(cx + x * radius, cy - y * radius)
      } else if (penDown) {
        // Leaving view: finish on the limb, then lift the pen.
        const t = pz / (pz - z)
        lineToLimb(ctx, px + (x - px) * t, py + (y - py) * t, cx, cy, radius)
        penDown = false
      }

      px = x
      py = y
      pz = z
      hasPrev = true
    }
  }

  ctx.stroke()
}

/**
 * A point interpolated to z = 0 sits slightly inside the sphere because the
 * chord cuts the surface, so push it back out to the limb before projecting.
 */
function limb(x: number, y: number) {
  const length = Math.hypot(x, y)
  return length > 1e-9 ? 1 / length : 0
}

function moveToLimb(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  cx: number,
  cy: number,
  radius: number,
) {
  const s = limb(x, y)
  ctx.moveTo(cx + x * s * radius, cy - y * s * radius)
}

function lineToLimb(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  cx: number,
  cy: number,
  radius: number,
) {
  const s = limb(x, y)
  ctx.lineTo(cx + x * s * radius, cy - y * s * radius)
}

/**
 * Polygons baked onto the sphere, keeping each polygon's rings together so
 * holes can be filled with the even-odd rule against their own outline.
 */
export type PolygonMesh = {
  positions: Float32Array
  /** Start index of each ring, with a trailing end marker. */
  ringOffsets: Uint32Array
  /** Start ring of each polygon, with a trailing end marker. */
  polygonOffsets: Uint32Array
}

export function buildPolygonMesh(
  polygons: readonly (readonly (readonly number[])[])[],
): PolygonMesh {
  const rings = polygons.flat()
  const mesh = buildMesh(rings)
  orientRings(mesh)

  const polygonOffsets = new Uint32Array(polygons.length + 1)
  let ring = 0
  for (let p = 0; p < polygons.length; p++) {
    polygonOffsets[p] = ring
    ring += polygons[p].length
  }
  polygonOffsets[polygons.length] = ring

  return { positions: mesh.positions, ringOffsets: mesh.offsets, polygonOffsets }
}

/**
 * Force every ring counter-clockwise as seen from outside the sphere.
 *
 * Source data does not guarantee a winding convention, and the fill needs one:
 * which way to run along the limb when closing a clipped ring follows from the
 * ring's orientation. The vector area of the ring points along its own normal,
 * so comparing it against the ring's mean direction gives the sense.
 */
function orientRings(mesh: Mesh) {
  const { positions, offsets } = mesh

  for (let r = 0; r < offsets.length - 1; r++) {
    const start = offsets[r]
    const end = offsets[r + 1]

    let ax = 0
    let ay = 0
    let az = 0
    let mx = 0
    let my = 0
    let mz = 0

    for (let i = start; i < end; i++) {
      const a = i * 3
      const b = (i + 1 < end ? i + 1 : start) * 3
      const x0 = positions[a]
      const y0 = positions[a + 1]
      const z0 = positions[a + 2]
      const x1 = positions[b]
      const y1 = positions[b + 1]
      const z1 = positions[b + 2]
      ax += y0 * z1 - z0 * y1
      ay += z0 * x1 - x0 * z1
      az += x0 * y1 - y0 * x1
      mx += x0
      my += y0
      mz += z0
    }

    if (ax * mx + ay * my + az * mz >= 0) continue

    for (let i = start, j = end - 1; i < j; i++, j--) {
      for (let c = 0; c < 3; c++) {
        const t = positions[i * 3 + c]
        positions[i * 3 + c] = positions[j * 3 + c]
        positions[j * 3 + c] = t
      }
    }
  }
}

// Rotated ring points, reused across rings so filling allocates nothing.
let scratch = new Float32Array(0)

// Visible chains of the ring currently being clipped: flat screen-space
// coordinate pairs, plus one descriptor per chain.
let chainPoints = new Float32Array(0)
let chainCount = 0
const chainStart: number[] = []
const chainLength: number[] = []
const chainEnterAzimuth: number[] = []
const chainExitAzimuth: number[] = []
const chainUsed: boolean[] = []

const TAU = Math.PI * 2

/**
 * Fill every polygon that has any part facing the camera.
 *
 * Rather than clipping each ring against the visible hemisphere - which needs
 * the boundary closed along the limb, and the winding worked out to know which
 * way round - back-facing points are projected outward onto the limb circle.
 * The hidden part of the outline then traces the limb itself, which is exactly
 * where the visible region's boundary lies, so the fill comes out right with
 * no special cases.
 *
 * Two corrections are needed for rings that wrap the far side:
 *
 * - A ring with no visible point is skipped outright. Lying entirely on the
 *   far side, it can sweep a full turn of azimuth, and collapsing it would
 *   enclose the whole disc.
 *
 * - A ring can be partly visible and still have its hidden portion wind a full
 *   turn around the view antipode. Natural Earth joins Africa and Eurasia into
 *   one ring, so looking at southern Africa from the south leaves the coast
 *   visible while the rest of the ring circles Siberia, which sits behind the
 *   camera's far pole. The collapsed path then carries an extra turn and the
 *   even-odd fill comes out inverted - ocean erased, land kept. Such a turn is
 *   detected from the winding of the collapsed segments and cancelled by
 *   XORing in the limb circle.
 */
export function fillPolygons(
  ctx: CanvasRenderingContext2D,
  mesh: PolygonMesh,
  camera: Camera,
) {
  const { polygonOffsets } = mesh

  for (let p = 0; p < polygonOffsets.length - 1; p++) {
    let open = false

    for (let r = polygonOffsets[p]; r < polygonOffsets[p + 1]; r++) {
      if (!clipRing(mesh, r, camera)) continue
      if (!open) {
        ctx.beginPath()
        open = true
      }
      emitRing(ctx, camera)
    }

    if (open) ctx.fill('evenodd')
  }
}

/**
 * Clip one ring to the visible hemisphere, leaving the result in the chain
 * scratch buffers. Returns false when nothing of the ring is visible.
 *
 * A ring lying wholly on the far side is dropped. In principle such a ring
 * could still enclose the whole visible hemisphere, but that needs a landmass
 * spanning more than half the globe, which no Earth coastline does.
 */
function clipRing(mesh: PolygonMesh, r: number, camera: Camera): boolean {
  const { positions, ringOffsets } = mesh
  const { cx, cy, radius } = camera

  const start = ringOffsets[r]
  const count = ringOffsets[r + 1] - start
  if (count < 3) return false

  if (scratch.length < count * 3) scratch = new Float32Array(count * 3)
  if (chainPoints.length < (count + 8) * 2) {
    chainPoints = new Float32Array((count + 8) * 2)
  }

  let visible = 0
  let entry = -1
  for (let i = 0; i < count; i++) {
    const j = (start + i) * 3
    rotate(camera, positions[j], positions[j + 1], positions[j + 2])
    scratch[i * 3] = rotated.x
    scratch[i * 3 + 1] = rotated.y
    scratch[i * 3 + 2] = rotated.z
    if (rotated.z > 0) visible++
  }
  if (visible === 0) return false

  // An entry is a visible point whose predecessor is hidden. Starting the walk
  // there means chains never straddle the wrap-around.
  for (let i = 0; i < count; i++) {
    const prev = (i + count - 1) % count
    if (scratch[i * 3 + 2] > 0 && scratch[prev * 3 + 2] <= 0) {
      entry = i
      break
    }
  }

  chainCount = 0
  let write = 0

  // Wholly visible: one closed chain, no limb arcs needed.
  if (entry < 0) {
    chainStart[0] = 0
    for (let i = 0; i < count; i++) {
      chainPoints[write++] = cx + scratch[i * 3] * radius
      chainPoints[write++] = cy - scratch[i * 3 + 1] * radius
    }
    chainLength[0] = count
    chainEnterAzimuth[0] = NaN
    chainExitAzimuth[0] = NaN
    chainCount = 1
    return true
  }

  let inChain = false

  for (let k = 0; k < count; k++) {
    const i = (entry + k) % count
    const prev = (i + count - 1) % count

    const px = scratch[prev * 3]
    const py = scratch[prev * 3 + 1]
    const pz = scratch[prev * 3 + 2]
    const x = scratch[i * 3]
    const y = scratch[i * 3 + 1]
    const z = scratch[i * 3 + 2]

    if (z > 0 !== pz > 0) {
      // Cross exactly on the limb, then push the point out onto the circle:
      // interpolating along the chord lands just inside it.
      const t = pz / (pz - z)
      const ix = px + (x - px) * t
      const iy = py + (y - py) * t
      const s = limb(ix, iy)
      const ux = ix * s
      const uy = iy * s
      const azimuth = Math.atan2(uy, ux)

      if (z > 0) {
        chainStart[chainCount] = write
        chainEnterAzimuth[chainCount] = azimuth
        inChain = true
      } else if (inChain) {
        chainPoints[write++] = cx + ux * radius
        chainPoints[write++] = cy - uy * radius
        chainLength[chainCount] = (write - chainStart[chainCount]) / 2
        chainExitAzimuth[chainCount] = azimuth
        chainCount++
        inChain = false
        continue
      }

      if (z > 0) {
        chainPoints[write++] = cx + ux * radius
        chainPoints[write++] = cy - uy * radius
      }
    }

    if (z > 0 && inChain) {
      chainPoints[write++] = cx + x * radius
      chainPoints[write++] = cy - y * radius
    }
  }

  // The walk began at an entry, so any open chain closes on the final edge.
  if (inChain) {
    chainLength[chainCount] = (write - chainStart[chainCount]) / 2
    chainExitAzimuth[chainCount] = chainEnterAzimuth[chainCount]
    chainCount++
  }

  return chainCount > 0
}

/**
 * Emit the clipped chains as closed subpaths, bridging each chain's exit to
 * the next chain's entry along the limb.
 *
 * Rings run counter-clockwise with the filled side on the left, so the arc
 * that continues the boundary is the one swept counter-clockwise - which, with
 * screen y pointing down, is drawn clockwise.
 */
function emitRing(ctx: CanvasRenderingContext2D, camera: Camera) {
  const { cx, cy, radius } = camera

  for (let c = 0; c < chainCount; c++) chainUsed[c] = false

  for (let c = 0; c < chainCount; c++) {
    if (chainUsed[c]) continue

    let current = c
    let first = true

    for (let guard = 0; guard <= chainCount; guard++) {
      chainUsed[current] = true

      const base = chainStart[current]
      const length = chainLength[current]
      for (let i = 0; i < length; i++) {
        const x = chainPoints[base + i * 2]
        const y = chainPoints[base + i * 2 + 1]
        if (first) {
          ctx.moveTo(x, y)
          first = false
        } else {
          ctx.lineTo(x, y)
        }
      }

      const exit = chainExitAzimuth[current]
      if (Number.isNaN(exit)) break

      // Nearest chain entry going counter-clockwise from this exit.
      let next = -1
      let best = Infinity
      for (let n = 0; n < chainCount; n++) {
        let delta = chainEnterAzimuth[n] - exit
        while (delta < 0) delta += TAU
        while (delta >= TAU) delta -= TAU
        if (delta < best) {
          best = delta
          next = n
        }
      }
      if (next < 0) break

      const steps = Math.max(2, Math.ceil((best / TAU) * 180))
      for (let s = 1; s <= steps; s++) {
        const a = exit + (best * s) / steps
        ctx.lineTo(cx + Math.cos(a) * radius, cy - Math.sin(a) * radius)
      }

      if (chainUsed[next]) break
      current = next
    }

    ctx.closePath()
  }
}

/** Meridians and parallels at a fixed spacing, as flat [lon, lat, ...] rings. */
export function buildGraticule(stepDegrees = 30): number[][] {
  const rings: number[][] = []

  for (let lon = -180; lon < 180; lon += stepDegrees) {
    const meridian: number[] = []
    for (let lat = -90; lat <= 90; lat += 2) meridian.push(lon, lat)
    rings.push(meridian)
  }

  for (let lat = -90 + stepDegrees; lat < 90; lat += stepDegrees) {
    const parallel: number[] = []
    for (let lon = -180; lon <= 180; lon += 2) parallel.push(lon, lat)
    rings.push(parallel)
  }

  return rings
}
