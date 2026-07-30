/**
 * Building geometry to draw on the globe's surface.
 *
 * Everything here is expressed in lon/lat degrees and densified into short
 * segments that follow the sphere. That densification is the whole point: a
 * line drawn straight between two distant lon/lat points is a chord through
 * the sphere's interior, so its middle passes under the surface and is either
 * clipped away or emerges in the wrong place. Interpolating along the great
 * circle instead keeps every vertex exactly on the surface.
 *
 * The results are ordinary meshes, so they go through the same projection and
 * horizon clipping as the coastlines: a shape crossing the silhouette is cut
 * at the limb, and the part on the far side is not drawn.
 */
import { buildMesh, type Mesh } from './projection'

/** [longitude, latitude] in degrees. */
export type LonLat = readonly [number, number]

export type ShapeStyle = {
  color: string
  /** Stroke width in CSS pixels. */
  width?: number
  /** Dash pattern in CSS pixels. */
  dash?: readonly number[]
}

/** Geometry baked onto the sphere, ready to draw. */
export type Shape = {
  mesh: Mesh
  style: ShapeStyle
}

const DEG = Math.PI / 180

/**
 * Spacing between generated vertices, in degrees of arc. At 1 degree a segment
 * bulges inward from the true surface by under 0.01% of the globe's radius,
 * which is far below a pixel at any practical size.
 */
const DEFAULT_STEP_DEGREES = 1

/** A lon/lat pair as a point on the unit sphere. */
export function toUnit([longitude, latitude]: LonLat) {
  const lon = longitude * DEG
  const lat = latitude * DEG
  const cosLat = Math.cos(lat)
  return [cosLat * Math.sin(lon), Math.sin(lat), cosLat * Math.cos(lon)] as const
}

function pushLonLat(out: number[], x: number, y: number, z: number) {
  out.push(
    (Math.atan2(x, z) * 180) / Math.PI,
    (Math.asin(Math.min(1, Math.max(-1, y))) * 180) / Math.PI,
  )
}

/**
 * Great-circle path through the waypoints, as a flat [lon, lat, ...] ring.
 * With two waypoints this is the shortest path between them - the line an
 * aircraft would fly.
 */
export function geodesic(
  waypoints: readonly LonLat[],
  stepDegrees = DEFAULT_STEP_DEGREES,
): number[] {
  const out: number[] = []
  if (waypoints.length === 0) return out
  if (waypoints.length === 1) {
    const [x, y, z] = toUnit(waypoints[0])
    pushLonLat(out, x, y, z)
    return out
  }

  for (let leg = 0; leg < waypoints.length - 1; leg++) {
    const a = toUnit(waypoints[leg])
    const b = toUnit(waypoints[leg + 1])

    const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))
    const omega = Math.acos(dot)
    const sinOmega = Math.sin(omega)

    // Coincident points have no path; antipodal ones have infinitely many, so
    // there is no meaningful great circle to follow. Emit the ends and move on.
    if (sinOmega < 1e-9) {
      if (leg === 0) pushLonLat(out, a[0], a[1], a[2])
      pushLonLat(out, b[0], b[1], b[2])
      continue
    }

    const steps = Math.max(1, Math.ceil(omega / DEG / stepDegrees))
    // Skip the first point on later legs; the previous leg already ended there.
    for (let i = leg === 0 ? 0 : 1; i <= steps; i++) {
      const t = i / steps
      const wa = Math.sin((1 - t) * omega) / sinOmega
      const wb = Math.sin(t * omega) / sinOmega
      pushLonLat(
        out,
        a[0] * wa + b[0] * wb,
        a[1] * wa + b[1] * wb,
        a[2] * wa + b[2] * wb,
      )
    }
  }

  return out
}

/** A closed great-circle polygon outline through the given corners. */
export function geodesicRing(
  corners: readonly LonLat[],
  stepDegrees = DEFAULT_STEP_DEGREES,
): number[] {
  if (corners.length < 2) return geodesic(corners, stepDegrees)
  return geodesic([...corners, corners[0]], stepDegrees)
}

/**
 * A circle of constant angular radius about a centre - the set of points a
 * fixed distance away, as a range ring would be drawn.
 */
export function smallCircle(
  centre: LonLat,
  radiusDegrees: number,
  segments = 180,
): number[] {
  const [cx, cy, cz] = toUnit(centre)

  // Any two directions perpendicular to the centre span the circle's plane.
  // Pick the first from whichever axis the centre leans on least, so the
  // cross product never collapses.
  const away: readonly [number, number, number] =
    Math.abs(cy) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  let ux = cy * away[2] - cz * away[1]
  let uy = cz * away[0] - cx * away[2]
  let uz = cx * away[1] - cy * away[0]
  const ul = Math.hypot(ux, uy, uz)
  ux /= ul
  uy /= ul
  uz /= ul

  const vx = cy * uz - cz * uy
  const vy = cz * ux - cx * uz
  const vz = cx * uy - cy * ux

  const r = radiusDegrees * DEG
  const cosR = Math.cos(r)
  const sinR = Math.sin(r)

  const out: number[] = []
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2
    const ca = Math.cos(a) * sinR
    const sa = Math.sin(a) * sinR
    pushLonLat(
      out,
      cx * cosR + ux * ca + vx * sa,
      cy * cosR + uy * ca + vy * sa,
      cz * cosR + uz * ca + vz * sa,
    )
  }
  return out
}

/** Bake one or more rings into a drawable shape. */
export function shape(
  rings: readonly (readonly number[])[],
  style: ShapeStyle,
): Shape {
  return { mesh: buildMesh(rings), style }
}
