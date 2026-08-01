/**
 * Small 3D models placed on the globe and in orbit around it.
 *
 * Models are a few dozen triangles each, loaded asynchronously and drawn as
 * ordinary canvas paths at full resolution rather than through the terrain's
 * sample buffer - at the size one of these occupies, the buffer's samples are
 * far too coarse to carry a shape, and a few hundred filled paths cost less
 * than the extra resolution would.
 *
 * That means no depth buffer, so depth is handled twice over. Within a model,
 * faces are sorted back to front and painted in that order, which is sound for
 * the box-and-cylinder assemblies here. Against the globe, the model's anchor
 * is tested for occlusion as a whole: a model is small enough that it is
 * either behind the planet or in front of it, and the same test the orbits use
 * settles which - being behind the centre plane is not enough, it must also be
 * inside the silhouette, or a high satellite would vanish while still plainly
 * visible past the edge.
 *
 * Faces are lit from both sides, with the normal turned to face the camera.
 * The renderer therefore does not care which way round a model's triangles
 * wind, which is one less thing for a hand-built model to get wrong.
 *
 * Nothing here is to scale. A car is a ten-millionth of the Earth's radius and
 * would never be more than a fraction of a pixel; sizes are given in globe
 * radii and chosen to be seen, exactly as the terrain is exaggerated to be
 * seen.
 */
import {
  isOccluded,
  type Camera,
} from './projection'
import { height as terrainHeight, terrainState } from './tiles'
import { angleAt, positionAtAngle, type Orbit, type OrbitElements } from './orbits'
import type { LonLat } from './shapes'

const EARTH_RADIUS_KM = 6371
const DEG = Math.PI / 180

/** Geometry ready to draw: triangles, and a colour for each. */
export type Model = {
  name: string
  /** Vertex positions, xyz per vertex, in model units. */
  positions: Float32Array
  /** Three vertex indices per triangle. */
  faces: Uint32Array
  /** One rgb triple per triangle. */
  colors: Uint8Array
  faceCount: number
}

/** Fetch and validate a model. */
export async function loadModel(url: string): Promise<Model> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Model fetch failed: HTTP ${response.status} for ${url}`)
  }
  const json = await response.json()

  const positions = new Float32Array(json.positions)
  const faces = new Uint32Array(json.faces)
  const colors = new Uint8Array(json.colors)
  const faceCount = faces.length / 3

  if (faces.length % 3 !== 0) throw new Error(`${url}: faces are not triples`)
  if (colors.length !== faceCount * 3) {
    throw new Error(`${url}: ${faceCount} faces but ${colors.length / 3} colours`)
  }
  const vertexCount = positions.length / 3
  for (const index of faces) {
    if (index >= vertexCount) throw new Error(`${url}: face index out of range`)
  }

  return { name: json.name ?? 'model', positions, faces, colors, faceCount }
}

export type Vec3 = { x: number; y: number; z: number }

/**
 * Where a model sits. Surface anchors are their own kind rather than just a
 * function, because they have to be told the terrain to stand on it.
 */
export type ModelAnchor =
  | {
      kind: 'surface'
      /** Unit direction of the place, baked once. */
      x: number
      y: number
      z: number
      longitude: number
      latitude: number
      altitudeKm: number
    }
  | { kind: 'orbit'; elements: OrbitElements }
  | { kind: 'tracking'; resolve: (timeSeconds: number, out: Vec3) => void }

export type ModelOptions = {
  /** Size in globe radii. Not to scale - chosen to be visible. */
  size?: number
  /** Rotation about local up in degrees; 0 faces north. */
  heading?: number
  /**
   * Degrees added to the heading per second *of the scene clock*, which is the
   * same clock the orbits run on and is normally far faster than real time. A
   * figure that reads as a slow turn is a blur once the scale is applied, so
   * divide by it - `demoModels.ts` has a helper that does.
   */
  spin?: number
}

export type ModelPlacement = {
  model: Model
  anchor: ModelAnchor
  size: number
  heading: number
  spin: number
}

const DEFAULT_SIZE = 0.03

function place(
  model: Model,
  anchor: ModelAnchor,
  options: ModelOptions = {},
): ModelPlacement {
  return {
    model,
    anchor,
    size: options.size ?? DEFAULT_SIZE,
    heading: options.heading ?? 0,
    spin: options.spin ?? 0,
  }
}

/**
 * Stand a model on the ground. It rides the displaced terrain, so it rises and
 * falls with the relief slider rather than sinking into a mountain.
 */
export function placeOnSurface(
  model: Model,
  [longitude, latitude]: LonLat,
  options: ModelOptions = {},
): ModelPlacement {
  const lon = longitude * DEG
  const lat = latitude * DEG
  const cosLat = Math.cos(lat)
  return place(
    model,
    {
      kind: 'surface',
      x: cosLat * Math.sin(lon),
      y: Math.sin(lat),
      z: cosLat * Math.cos(lon),
      longitude,
      latitude,
      altitudeKm: 0,
    },
    options,
  )
}

/** Fly a model around an orbit, in place of - or alongside - its marker. */
export function placeInOrbit(
  model: Model,
  orbit: Orbit | OrbitElements,
  options: ModelOptions = {},
): ModelPlacement {
  const elements = 'elements' in orbit ? orbit.elements : orbit
  return place(model, { kind: 'orbit', elements }, options)
}

/** Anything else that moves; the position is in globe radii. */
export function placeTracking(
  model: Model,
  resolve: (timeSeconds: number, out: Vec3) => void,
  options: ModelOptions = {},
): ModelPlacement {
  return place(model, { kind: 'tracking', resolve }, options)
}

// Key light, matching the surface shading so models sit in the same world.
const LX = -0.42
const LY = 0.58
const LZ = 0.7
const AMBIENT = 0.3

// Scratch, reused every frame.
const here: Vec3 = { x: 0, y: 0, z: 0 }

let camX = new Float32Array(0)
let camY = new Float32Array(0)
let camZ = new Float32Array(0)
let faceDepth = new Float64Array(0)
const order: number[] = []

// Declared out here so the comparator is not rebuilt on every sort.
const byDepth = (a: number, b: number) => faceDepth[a] - faceDepth[b]

export type TerrainContext = {
  exaggeration: number
}

/** Draw every model at the given time. */
export function drawModels(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  placements: readonly ModelPlacement[],
  timeSeconds: number,
  terrain: TerrainContext,
) {
  ctx.lineJoin = 'round'
  ctx.setLineDash([])

  for (const placement of placements) {
    drawModel(ctx, camera, placement, timeSeconds, terrain)
  }
}

function drawModel(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  placement: ModelPlacement,
  timeSeconds: number,
  terrain: TerrainContext,
) {
  const { model, anchor, size } = placement
  const { cx, cy, radius, cosLon, sinLon, cosLat, sinLat } = camera

  if (!resolveAnchor(anchor, timeSeconds, terrain, here)) return

  // Local frame: up is radial, and heading turns the model about it.
  const length = Math.hypot(here.x, here.y, here.z)
  if (length < 1e-9) return
  const ux = here.x / length
  const uy = here.y / length
  const uz = here.z / length

  // East and north come straight from the up vector, no trigonometry.
  const horizontal = Math.hypot(ux, uz)
  let ex: number
  let ez: number
  if (horizontal > 1e-6) {
    ex = uz / horizontal
    ez = -ux / horizontal
  } else {
    // Directly over a pole, where east is undefined; any tangent will do.
    ex = 1
    ez = 0
  }
  // north = up x east, with east's vertical component dropped: east is always
  // horizontal, so those two terms are known to be zero.
  const nx = uy * ez
  const ny = uz * ex - ux * ez
  const nz = -uy * ex

  const turn = (placement.heading + placement.spin * timeSeconds) * DEG
  const cosTurn = Math.cos(turn)
  const sinTurn = Math.sin(turn)

  // Forward is north swung round by the heading; right completes the frame.
  const fx = nx * cosTurn + ex * sinTurn
  const fy = ny * cosTurn
  const fz = nz * cosTurn + ez * sinTurn
  const rx = uy * fz - uz * fy
  const ry = uz * fx - ux * fz
  const rz = ux * fy - uy * fx

  // Occlusion is decided once for the model, from its anchor. Each rotation
  // writes into shared scratch, so every result is copied out before the next.
  rotate(here.x, here.y, here.z, cosLon, sinLon, cosLat, sinLat)
  const px = rotated.x
  const py = rotated.y
  const pz = rotated.z
  if (isOccluded(px, py, pz)) return

  // Carry the model's frame into camera space once, then every vertex is a
  // linear combination of three fixed axes.
  rotate(rx, ry, rz, cosLon, sinLon, cosLat, sinLat)
  const rcx = rotated.x * size
  const rcy = rotated.y * size
  const rcz = rotated.z * size
  rotate(ux, uy, uz, cosLon, sinLon, cosLat, sinLat)
  const ucx = rotated.x * size
  const ucy = rotated.y * size
  const ucz = rotated.z * size
  rotate(fx, fy, fz, cosLon, sinLon, cosLat, sinLat)
  const fcx = rotated.x * size
  const fcy = rotated.y * size
  const fcz = rotated.z * size

  const { positions, faces, colors, faceCount } = model
  const vertexCount = positions.length / 3

  if (camX.length < vertexCount) {
    camX = new Float32Array(vertexCount)
    camY = new Float32Array(vertexCount)
    camZ = new Float32Array(vertexCount)
  }
  if (faceDepth.length < faceCount) faceDepth = new Float64Array(faceCount)

  // Kept in camera space, not screen space: the projection scales x and y by
  // the globe's radius and leaves z alone, so a normal taken from projected
  // edges would be tilted by however large the globe happens to be drawn.
  for (let i = 0; i < vertexCount; i++) {
    const vx = positions[i * 3]
    const vy = positions[i * 3 + 1]
    const vz = positions[i * 3 + 2]
    camX[i] = px + rcx * vx + ucx * vy + fcx * vz
    camY[i] = py + rcy * vx + ucy * vy + fcy * vz
    camZ[i] = pz + rcz * vx + ucz * vy + fcz * vz
  }

  order.length = faceCount
  for (let f = 0; f < faceCount; f++) {
    faceDepth[f] = (camZ[faces[f * 3]] + camZ[faces[f * 3 + 1]] + camZ[faces[f * 3 + 2]]) / 3
    order[f] = f
  }
  // Farthest first: nearer faces are painted over them.
  order.sort(byDepth)

  for (let k = 0; k < faceCount; k++) {
    const f = order[k]
    const a = faces[f * 3]
    const b = faces[f * 3 + 1]
    const c = faces[f * 3 + 2]

    // Normal from the camera-space edges, turned to face the viewer so a model
    // lights the same whichever way its triangles happen to wind.
    const e1x = camX[b] - camX[a]
    const e1y = camY[b] - camY[a]
    const e1z = camZ[b] - camZ[a]
    const e2x = camX[c] - camX[a]
    const e2y = camY[c] - camY[a]
    const e2z = camZ[c] - camZ[a]
    let mx = e1y * e2z - e1z * e2y
    let my = e1z * e2x - e1x * e2z
    let mz = e1x * e2y - e1y * e2x
    const scale = Math.hypot(mx, my, mz)
    if (scale < 1e-12) continue
    mx /= scale
    my /= scale
    mz /= scale
    if (mz < 0) {
      mx = -mx
      my = -my
      mz = -mz
    }
    const lambert = mx * LX + my * LY + mz * LZ
    const gain = AMBIENT + (1 - AMBIENT) * (lambert > 0 ? lambert : 0)

    ctx.fillStyle = shade(colors[f * 3], colors[f * 3 + 1], colors[f * 3 + 2], gain)
    ctx.beginPath()
    ctx.moveTo(cx + camX[a] * radius, cy - camY[a] * radius)
    ctx.lineTo(cx + camX[b] * radius, cy - camY[b] * radius)
    ctx.lineTo(cx + camX[c] * radius, cy - camY[c] * radius)
    ctx.closePath()
    ctx.fill()
  }
}

/**
 * Colour strings, cached by tone and by brightness.
 *
 * A model repaints every face every frame, and building `rgb(...)` each time
 * would churn through a few thousand strings a second for no gain. Quantising
 * the light to 64 steps makes the set small and fixed - the banding it costs
 * is under two levels, which is nothing against a lit surface.
 */
const SHADE_STEPS = 64
const styles = new Map<number, string>()

function shade(r: number, g: number, b: number, gain: number) {
  let level = (gain * SHADE_STEPS) | 0
  if (level < 0) level = 0
  else if (level >= SHADE_STEPS) level = SHADE_STEPS - 1

  const key = (((r << 16) | (g << 8) | b) * SHADE_STEPS) + level
  const found = styles.get(key)
  if (found !== undefined) return found

  const k = (level + 0.5) / SHADE_STEPS
  const style = `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`
  styles.set(key, style)
  return style
}

/** Position of a model at a given time, in globe radii. False if it has none. */
function resolveAnchor(
  anchor: ModelAnchor,
  timeSeconds: number,
  terrain: TerrainContext,
  out: Vec3,
): boolean {
  if (anchor.kind === 'orbit') {
    positionAtAngle(anchor.elements, angleAt(anchor.elements, timeSeconds), out)
    return true
  }
  if (anchor.kind === 'tracking') {
    anchor.resolve(timeSeconds, out)
    return true
  }

  // Stand on the terrain as it is actually displaced, so a model on a mountain
  // rides up with it rather than sinking in.
  let radius = 1 + anchor.altitudeKm / EARTH_RADIUS_KM
  const levels = terrainState().levels
  if (levels > 0) {
    // The finest level the pyramid holds; sampling falls back to whatever has
    // actually arrived, so a model never waits on a tile to be placed.
    const metres = terrainHeight(
      (anchor.longitude + 180) / 360,
      (90 - anchor.latitude) / 180,
      levels - 1,
    )
    radius += (metres / (EARTH_RADIUS_KM * 1000)) * terrain.exaggeration
  }
  out.x = anchor.x * radius
  out.y = anchor.y * radius
  out.z = anchor.z * radius
  return true
}

// Scratch for the camera rotation, reused so drawing allocates nothing.
const rotated: Vec3 = { x: 0, y: 0, z: 0 }

/** Writes into `rotated`; returns nothing, so the result cannot be aliased. */
function rotate(
  x: number,
  y: number,
  z: number,
  cosLon: number,
  sinLon: number,
  cosLat: number,
  sinLat: number,
) {
  const x1 = x * cosLon - z * sinLon
  const z1 = x * sinLon + z * cosLon
  rotated.x = x1
  rotated.y = y * cosLat - z1 * sinLat
  rotated.z = y * sinLat + z1 * cosLat
}
