/**
 * Satellite orbits and the satellites that ride them.
 *
 * Orbits are circular and defined in the globe's own frame, so an orbit stays
 * fixed relative to the continents and a satellite runs around it once per
 * period. Real satellites orbit in an inertial frame while the Earth turns
 * underneath, which makes their ground tracks drift west each revolution;
 * modelling that would need a spinning Earth, which this globe does not have.
 * For everything visual - inclination, altitude, phasing, occlusion - the
 * simpler frame behaves the same way.
 */
import {
  buildMeshFromXyz,
  projectSpace,
  spacePoint,
  strokeAbove,
  type Camera,
  type Mesh,
  type SpacePoint,
} from './projection'

export const EARTH_RADIUS_KM = 6371

export type OrbitElements = {
  /** Height above the surface, in kilometres. */
  altitudeKm: number
  /** Tilt of the orbital plane against the equator, in degrees. */
  inclination: number
  /** Longitude where the orbit crosses the equator going north, in degrees. */
  ascendingNode: number
  /** Time for one revolution, in the same units as the clock you render with. */
  periodSeconds: number
  /** Angle along the orbit at time zero, measured from the ascending node. */
  phase?: number
}

export type OrbitStyle = {
  color: string
  width?: number
  dash?: readonly number[]
}

export type SatelliteStyle = {
  color: string
  /** Marker radius in CSS pixels. */
  size?: number
  /** Length of the trailing arc, in degrees of orbit. Zero for none. */
  trail?: number
}

export type Orbit = {
  elements: OrbitElements
  path: Mesh
  style: OrbitStyle
  satellite?: SatelliteStyle
}

const DEG = Math.PI / 180

/**
 * The orbital plane's two in-plane axes: `u` points at the ascending node, and
 * `v` is a quarter turn along the orbit from it, lifted by the inclination.
 */
function basis(elements: OrbitElements) {
  const node = elements.ascendingNode * DEG
  const inc = elements.inclination * DEG
  const cosNode = Math.cos(node)
  const sinNode = Math.sin(node)
  const cosInc = Math.cos(inc)
  const sinInc = Math.sin(inc)

  return {
    // On the equator, at the ascending node's longitude.
    ux: sinNode,
    uy: 0,
    uz: cosNode,
    // A quarter turn east, tilted north by the inclination. This is what makes
    // the orbit reach exactly `inclination` degrees of latitude.
    vx: cosInc * cosNode,
    vy: sinInc,
    vz: -cosInc * sinNode,
  }
}

/** Orbital radius in globe radii, where 1 is the surface. */
export function orbitRadius(elements: OrbitElements) {
  return 1 + elements.altitudeKm / EARTH_RADIUS_KM
}

/**
 * Position of the satellite at a given angle along its orbit, in globe radii.
 * Writes into `out` so animation allocates nothing per frame.
 */
export function positionAtAngle(
  elements: OrbitElements,
  angleDegrees: number,
  out: { x: number; y: number; z: number },
) {
  const { ux, uy, uz, vx, vy, vz } = basis(elements)
  const a = angleDegrees * DEG
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const r = orbitRadius(elements)

  out.x = r * (ux * cos + vx * sin)
  out.y = r * (uy * cos + vy * sin)
  out.z = r * (uz * cos + vz * sin)
  return out
}

/** How far around the orbit the satellite has travelled at time `t`. */
export function angleAt(elements: OrbitElements, timeSeconds: number) {
  return (elements.phase ?? 0) + (360 * timeSeconds) / elements.periodSeconds
}

/** The orbit as a closed ring of [x, y, z, ...] in globe radii. */
export function orbitRing(elements: OrbitElements, segments = 240): number[] {
  const point = { x: 0, y: 0, z: 0 }
  const out: number[] = []
  for (let i = 0; i <= segments; i++) {
    positionAtAngle(elements, (i / segments) * 360, point)
    out.push(point.x, point.y, point.z)
  }
  return out
}

/** Bake an orbit for drawing. */
export function orbit(
  elements: OrbitElements,
  style: OrbitStyle,
  satellite?: SatelliteStyle,
): Orbit {
  return {
    elements,
    path: buildMeshFromXyz([orbitRing(elements)]),
    style,
    satellite,
  }
}

/**
 * The satellite's position on the surface directly below it, as a flat
 * [lon, lat, ...] ring - the ground track, ready to pass to `shape()`.
 */
export function groundTrack(elements: OrbitElements, segments = 240): number[] {
  const point = { x: 0, y: 0, z: 0 }
  const out: number[] = []
  for (let i = 0; i <= segments; i++) {
    positionAtAngle(elements, (i / segments) * 360, point)
    const length = Math.hypot(point.x, point.y, point.z)
    out.push(
      (Math.atan2(point.x, point.z) * 180) / Math.PI,
      (Math.asin(point.y / length) * 180) / Math.PI,
    )
  }
  return out
}

// Scratch, reused every frame.
const here = { x: 0, y: 0, z: 0 }
const screen: SpacePoint = spacePoint()
const previous: SpacePoint = spacePoint()

/**
 * Draw the orbits and their satellites at the given time.
 * `timeSeconds` is whatever clock you choose to run - scale it to make the
 * motion as fast as you want.
 */
export function drawOrbits(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  orbits: readonly Orbit[],
  timeSeconds: number,
) {
  for (const item of orbits) {
    ctx.strokeStyle = item.style.color
    ctx.lineWidth = item.style.width ?? 1
    ctx.setLineDash(item.style.dash ? [...item.style.dash] : [])
    strokeAbove(ctx, item.path, camera)
  }
  ctx.setLineDash([])

  // Satellites last, so a marker is never overdrawn by another orbit's path.
  for (const item of orbits) {
    if (!item.satellite) continue
    drawSatellite(ctx, camera, item, item.satellite, timeSeconds)
  }
}

function drawSatellite(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  item: Orbit,
  style: SatelliteStyle,
  timeSeconds: number,
) {
  const angle = angleAt(item.elements, timeSeconds)
  const size = style.size ?? 3
  const trail = style.trail ?? 0

  // Trailing arc, drawn as separate segments so it can fade out behind the
  // satellite; a single stroke could not vary its alpha along the path.
  if (trail > 0) {
    // Each step is its own stroke call, which is the expensive part, so use
    // few long segments rather than one per degree. A dozen reads as a smooth
    // fade at any size the marker is drawn.
    const steps = Math.min(16, Math.max(3, Math.round(trail / 3)))
    ctx.lineWidth = size * 0.55
    ctx.lineCap = 'round'

    for (let i = 0; i < steps; i++) {
      const from = angle - trail * ((i + 1) / steps)
      const to = angle - trail * (i / steps)

      positionAtAngle(item.elements, from, here)
      projectSpace(camera, here.x, here.y, here.z, previous)
      positionAtAngle(item.elements, to, here)
      projectSpace(camera, here.x, here.y, here.z, screen)
      if (!previous.visible || !screen.visible) continue

      ctx.globalAlpha = 1 - i / steps
      ctx.strokeStyle = style.color
      ctx.beginPath()
      ctx.moveTo(previous.x, previous.y)
      ctx.lineTo(screen.x, screen.y)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  positionAtAngle(item.elements, angle, here)
  projectSpace(camera, here.x, here.y, here.z, screen)
  if (!screen.visible) return

  // Halo, then core.
  ctx.fillStyle = style.color
  ctx.globalAlpha = 0.28
  ctx.beginPath()
  ctx.arc(screen.x, screen.y, size * 2.4, 0, Math.PI * 2)
  ctx.fill()

  ctx.globalAlpha = 1
  ctx.beginPath()
  ctx.arc(screen.x, screen.y, size, 0, Math.PI * 2)
  ctx.fill()
}
