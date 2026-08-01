/**
 * Tweening one set of polygons into another, on the sphere.
 *
 * Two states of a border have nothing in common that a computer can see: a
 * different number of points, in different places, at different spacings,
 * starting wherever the surveyor happened to start. Interpolating them means
 * inventing a correspondence first, and the whole of this file is that
 * invention. It comes in three parts, and each exists because leaving it out
 * looks obviously wrong.
 *
 * Resample. Both rings are rewritten with the same number of points, equally
 * spaced by arc length. Without it a point from a densely surveyed coast pairs
 * with one from a straight desert border and the shape shears as it moves.
 *
 * Align. Both rings now run the same way round - orientation is forced, since
 * the fill needs it too - but they still start at arbitrary places, and pairing
 * point 0 with point 0 makes the shape spin like a wheel on its way across and
 * fold through itself doing it. So the cyclic offset that brings the two into
 * closest agreement is found once, by trying all of them: N^2 dot products,
 * paid at build time and never again.
 *
 * Match. Rings appear and vanish - a lake dries, a province splits away - so
 * polygons are paired between the states by proximity, largest first, and
 * whatever is left over is paired with a copy of its own centre. A polygon with
 * no successor shrinks into itself and a polygon with no predecessor grows out
 * of a point, which is a reading of the event rather than a claim about it, and
 * far better than a shape appearing whole between two frames.
 *
 * What comes out is a fixed layout: same rings, same points, every frame. So
 * the tween writes into one buffer that is allocated once and rewritten in
 * place, and a frame of animation allocates nothing at all.
 */
import type { Mesh, PolygonMesh } from './projection'

const DEG = Math.PI / 180

/**
 * Points per ring after resampling.
 *
 * A quarter of a degree of arc at the equator once a country is a tenth of the
 * globe across, which is finer than the coastline data this would be morphing.
 * Alignment is quadratic in it, but only at build time.
 */
const DEFAULT_POINTS = 256

/** Polygons of rings of flat [lon, lat, ...] degrees, outline first then holes. */
export type Polygons = readonly (readonly (readonly number[])[])[]

export type MorphOptions = {
  /** Points per ring. More is smoother and costs its square to prepare. */
  points?: number
}

export type Morph = {
  points: number
  /**
   * Rewritten in place by `morphAt`. Its identity never changes, so a region
   * built around it once keeps working for the life of the morph.
   */
  mesh: PolygonMesh
  /** The same rings as outlines, sharing the one position buffer. */
  outline: Mesh
  /** Where every output vertex starts and ends, xyz. */
  from: Float64Array
  to: Float64Array
}

/** Prepare a tween between two states. All the expensive work happens here. */
export function morph(
  from: Polygons,
  to: Polygons,
  options: MorphOptions = {},
): Morph {
  const points = Math.max(3, Math.trunc(options.points ?? DEFAULT_POINTS))
  const before = toPolygons(from)
  const after = toPolygons(to)

  const starts: Float64Array[] = []
  const ends: Float64Array[] = []
  const ringsPerPolygon: number[] = []

  for (const [a, b] of matchPolygons(before, after)) {
    const count = Math.max(a ? a.length : 0, b ? b.length : 0)
    for (let i = 0; i < count; i++) {
      const ra = a && i < a.length ? a[i] : null
      const rb = b && i < b.length ? b[i] : null

      if (ra && rb) {
        const start = resample(ra, points)
        const target = resample(rb, points)
        starts.push(start)
        ends.push(rotate(target, align(start, target, points), points))
      } else if (ra) {
        const start = resample(ra, points)
        starts.push(start)
        ends.push(constant(centroid(ra), points))
      } else if (rb) {
        const end = resample(rb, points)
        starts.push(constant(centroid(rb), points))
        ends.push(end)
      }
    }
    if (count > 0) ringsPerPolygon.push(count)
  }

  const rings = starts.length
  const total = rings * points
  const fromAll = new Float64Array(total * 3)
  const toAll = new Float64Array(total * 3)
  const ringOffsets = new Uint32Array(rings + 1)
  for (let r = 0; r < rings; r++) {
    fromAll.set(starts[r], r * points * 3)
    toAll.set(ends[r], r * points * 3)
    ringOffsets[r] = r * points
  }
  ringOffsets[rings] = total

  const polygonOffsets = new Uint32Array(ringsPerPolygon.length + 1)
  let ring = 0
  for (let p = 0; p < ringsPerPolygon.length; p++) {
    polygonOffsets[p] = ring
    ring += ringsPerPolygon[p]
  }
  polygonOffsets[ringsPerPolygon.length] = ring

  const positions = new Float32Array(total * 3)
  const mesh: PolygonMesh = { positions, ringOffsets, polygonOffsets }
  const it: Morph = {
    points,
    mesh,
    outline: { positions, offsets: ringOffsets },
    from: fromAll,
    to: toAll,
  }
  morphAt(it, 0)
  return it
}

/**
 * The state at a fraction, written into the morph's own buffer.
 *
 * Straight interpolation renormalised back onto the sphere, rather than a true
 * slerp. Over the distances a border moves between two records the difference
 * is far below a pixel, and the one case where it is not - a ring collapsing
 * into its own centre - is a shape shrinking away, where nobody can see how
 * evenly it did it.
 */
export function morphAt(it: Morph, t: number): PolygonMesh {
  const { from, to } = it
  const out = it.mesh.positions
  const s = t < 0 ? 0 : t > 1 ? 1 : t

  for (let i = 0; i < out.length; i += 3) {
    let x = from[i] + (to[i] - from[i]) * s
    let y = from[i + 1] + (to[i + 1] - from[i + 1]) * s
    let z = from[i + 2] + (to[i + 2] - from[i + 2]) * s
    let length = Math.sqrt(x * x + y * y + z * z)
    // Endpoints on opposite sides of the globe pass through the centre, where
    // there is no direction to normalise. Nothing sensible connects them, so
    // hold the start rather than emit a NaN that would poison the whole ring.
    if (length < 1e-9) {
      x = from[i]
      y = from[i + 1]
      z = from[i + 2]
      length = 1
    }
    const inverse = 1 / length
    out[i] = x * inverse
    out[i + 1] = y * inverse
    out[i + 2] = z * inverse
  }
  return it.mesh
}

// --- Preparation ----------------------------------------------------------

/** A ring as xyz triples, not closed: the last point does not repeat the first. */
type Ring = Float64Array
type Polygon = Ring[]

function toPolygons(polygons: Polygons): Polygon[] {
  const out: Polygon[] = []
  for (const rings of polygons) {
    const built: Polygon = []
    for (const ring of rings) {
      const converted = toRing(ring)
      if (converted.length >= 9) {
        orient(converted)
        built.push(converted)
      }
    }
    if (built.length > 0) out.push(built)
  }
  return out
}

function toRing(flat: readonly number[]): Ring {
  let n = Math.floor(flat.length / 2)
  // Sources usually repeat the first point to close the ring. Everything here
  // treats a ring as closed already, so the repeat is a zero-length segment
  // that would take a share of the resampling for itself.
  if (
    n > 1 &&
    flat[0] === flat[(n - 1) * 2] &&
    flat[1] === flat[(n - 1) * 2 + 1]
  ) {
    n--
  }

  const out = new Float64Array(n * 3)
  for (let i = 0; i < n; i++) {
    const lon = flat[i * 2] * DEG
    const lat = flat[i * 2 + 1] * DEG
    const cosLat = Math.cos(lat)
    out[i * 3] = cosLat * Math.sin(lon)
    out[i * 3 + 1] = Math.sin(lat)
    out[i * 3 + 2] = cosLat * Math.cos(lon)
  }
  return out
}

/**
 * Force a ring counter-clockwise seen from outside, the same convention the
 * fill needs.
 *
 * Two rings wound opposite ways have no rotation that brings them into
 * agreement - the best alignment is still a shape turned inside out - so this
 * has to happen before the offset is searched for, not after.
 */
function orient(ring: Ring) {
  const n = ring.length / 3
  let ax = 0
  let ay = 0
  let az = 0
  for (let i = 0; i < n; i++) {
    const j = i * 3
    const k = ((i + 1) % n) * 3
    ax += ring[j + 1] * ring[k + 2] - ring[j + 2] * ring[k + 1]
    ay += ring[j + 2] * ring[k] - ring[j] * ring[k + 2]
    az += ring[j] * ring[k + 1] - ring[j + 1] * ring[k]
  }

  const middle = centroid(ring)
  if (ax * middle[0] + ay * middle[1] + az * middle[2] >= 0) return

  for (let i = 0, j = n - 1; i < j; i++, j--) {
    for (let c = 0; c < 3; c++) {
      const swap = ring[i * 3 + c]
      ring[i * 3 + c] = ring[j * 3 + c]
      ring[j * 3 + c] = swap
    }
  }
}

/** The mean direction of a ring's points, back on the sphere. */
function centroid(ring: Ring): [number, number, number] {
  const n = ring.length / 3
  let x = 0
  let y = 0
  let z = 0
  for (let i = 0; i < n; i++) {
    x += ring[i * 3]
    y += ring[i * 3 + 1]
    z += ring[i * 3 + 2]
  }
  const length = Math.sqrt(x * x + y * y + z * z)
  // A ring wrapped symmetrically about the globe has no mean direction. Any
  // answer is arbitrary, so take the first point and move on.
  if (length < 1e-12) return [ring[0], ring[1], ring[2]]
  return [x / length, y / length, z / length]
}

/** Rewrite a ring with `count` points equally spaced along its arc. */
function resample(ring: Ring, count: number): Float64Array {
  const n = ring.length / 3
  const lengths = new Float64Array(n)
  let total = 0
  for (let i = 0; i < n; i++) {
    const j = i * 3
    const k = ((i + 1) % n) * 3
    let dot = ring[j] * ring[k] + ring[j + 1] * ring[k + 1] + ring[j + 2] * ring[k + 2]
    dot = dot > 1 ? 1 : dot < -1 ? -1 : dot
    lengths[i] = Math.acos(dot)
    total += lengths[i]
  }

  const out = new Float64Array(count * 3)
  if (total <= 0) return constant([ring[0], ring[1], ring[2]], count)

  let segment = 0
  let walked = 0
  for (let s = 0; s < count; s++) {
    const target = (s / count) * total
    while (segment < n - 1 && walked + lengths[segment] <= target) {
      walked += lengths[segment]
      segment++
    }
    const span = lengths[segment]
    const t = span > 0 ? (target - walked) / span : 0
    slerp(ring, segment, (segment + 1) % n, t, out, s)
  }
  return out
}

/**
 * Interpolate along the great circle between two of a ring's points.
 *
 * Slerp rather than a straight mix, because this is what makes the spacing
 * equal by arc: mixing and renormalising bunches points towards the ends of a
 * segment, which is exactly the unevenness the resampling exists to remove.
 */
function slerp(
  ring: Ring,
  ia: number,
  ib: number,
  t: number,
  out: Float64Array,
  at: number,
) {
  const j = ia * 3
  const k = ib * 3
  let dot = ring[j] * ring[k] + ring[j + 1] * ring[k + 1] + ring[j + 2] * ring[k + 2]
  dot = dot > 1 ? 1 : dot < -1 ? -1 : dot
  const omega = Math.acos(dot)
  const sine = Math.sin(omega)

  let wa = 1 - t
  let wb = t
  if (sine > 1e-9) {
    wa = Math.sin((1 - t) * omega) / sine
    wb = Math.sin(t * omega) / sine
  }

  let x = ring[j] * wa + ring[k] * wb
  let y = ring[j + 1] * wa + ring[k + 1] * wb
  let z = ring[j + 2] * wa + ring[k + 2] * wb
  const length = Math.sqrt(x * x + y * y + z * z) || 1
  x /= length
  y /= length
  z /= length

  out[at * 3] = x
  out[at * 3 + 1] = y
  out[at * 3 + 2] = z
}

/** A ring of `count` copies of one point: what a vanishing shape shrinks to. */
function constant(point: readonly [number, number, number], count: number) {
  const out = new Float64Array(count * 3)
  for (let i = 0; i < count; i++) {
    out[i * 3] = point[0]
    out[i * 3 + 1] = point[1]
    out[i * 3 + 2] = point[2]
  }
  return out
}

/**
 * The cyclic offset bringing `b` into closest agreement with `a`.
 *
 * Minimising the summed squared chord between paired points is the same as
 * maximising the summed dot product, since every point is on the unit sphere.
 * Every offset is tried: N^2, which at 256 points is a few hundred thousand
 * multiplies, once, when the morph is built.
 */
function align(a: Float64Array, b: Float64Array, count: number): number {
  let best = -Infinity
  let bestOffset = 0
  for (let k = 0; k < count; k++) {
    let sum = 0
    for (let i = 0; i < count; i++) {
      const p = i * 3
      const q = ((i + k) % count) * 3
      sum += a[p] * b[q] + a[p + 1] * b[q + 1] + a[p + 2] * b[q + 2]
    }
    if (sum > best) {
      best = sum
      bestOffset = k
    }
  }
  return bestOffset
}

function rotate(ring: Float64Array, offset: number, count: number): Float64Array {
  if (offset === 0) return ring
  const out = new Float64Array(count * 3)
  for (let i = 0; i < count; i++) {
    const from = ((i + offset) % count) * 3
    out[i * 3] = ring[from]
    out[i * 3 + 1] = ring[from + 1]
    out[i * 3 + 2] = ring[from + 2]
  }
  return out
}

/**
 * Pair polygons between the two states, largest first.
 *
 * Largest first so a mainland claims its successor before an island does; each
 * takes the nearest partner still going spare. Whatever is unclaimed on either
 * side is returned half-paired, and the caller turns it into a shape that grows
 * from, or shrinks to, its own centre.
 */
function matchPolygons(
  before: Polygon[],
  after: Polygon[],
): Array<[Polygon | null, Polygon | null]> {
  const taken = new Array<boolean>(after.length).fill(false)
  const pairs: Array<[Polygon | null, Polygon | null]> = []

  const order = before.map((_, i) => i).sort((i, j) => extent(before[j]) - extent(before[i]))
  for (const i of order) {
    const here = centroid(before[i][0])
    let bestJ = -1
    let bestDistance = Infinity
    for (let j = 0; j < after.length; j++) {
      if (taken[j]) continue
      const there = centroid(after[j][0])
      const distance = 1 - (here[0] * there[0] + here[1] * there[1] + here[2] * there[2])
      if (distance < bestDistance) {
        bestDistance = distance
        bestJ = j
      }
    }
    if (bestJ < 0) {
      pairs.push([before[i], null])
    } else {
      taken[bestJ] = true
      pairs.push([before[i], after[bestJ]])
    }
  }

  for (let j = 0; j < after.length; j++) {
    if (!taken[j]) pairs.push([null, after[j]])
  }
  return pairs
}

/** Perimeter of a polygon's outline: a cheap stand-in for how big it is. */
function extent(polygon: Polygon): number {
  const ring = polygon[0]
  const n = ring.length / 3
  let total = 0
  for (let i = 0; i < n; i++) {
    const j = i * 3
    const k = ((i + 1) % n) * 3
    let dot = ring[j] * ring[k] + ring[j + 1] * ring[k + 1] + ring[j + 2] * ring[k + 2]
    dot = dot > 1 ? 1 : dot < -1 ? -1 : dot
    total += Math.acos(dot)
  }
  return total
}
