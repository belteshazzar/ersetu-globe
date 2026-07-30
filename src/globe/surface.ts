/**
 * Per-pixel shading for the globe: the metal sea, and the land relief.
 *
 * Metal reads as metal because of what it reflects, not because of its
 * diffuse colour, so the base tone here comes from an environment gradient
 * looked up by the reflection vector, with a Fresnel rim on top.
 *
 * There are two ways through this file. Without an elevation grid the globe is
 * a smooth sphere and every sample is found analytically from the disc, which
 * is what it did before there was any relief. With one, the geometry has
 * already been rasterised by `terrain.ts` and this reads the G-buffer it left:
 * which point of the elevation grid each sample landed on, and how far away it
 * was. Nothing here has to work out where on the globe a pixel is - the
 * rasteriser interpolated that - so the shading pass costs less than it did
 * when the relief was only a lighting trick, and now it is real geometry.
 *
 * Terrain still perturbs the lighting on top of the displaced surface. The
 * mesh carries features down to about a degree; the grid holds five times
 * that, and the difference would be lost if the mesh's own normals were used.
 * So the slope is taken from the full resolution grid per pixel, and shading
 * detail stays far finer than the geometry underneath it:
 *
 *     n'.L = (w.L - se(e.L) - sn(n.L)) / sqrt(1 + se^2 + sn^2)
 *
 * for slopes `se`, `sn` in the local east/north frame. The key light is fixed
 * in camera space, so `L` is carried into world space once per frame rather
 * than per pixel, and `e` and `n` come straight from the world normal with no
 * trigonometry. `w.L` is what the unperturbed surface would have given, so
 * subtracting it leaves exactly the terrain's own contribution.
 *
 * Two images come out of one pass: the sea look and the land look. They share
 * every expensive term, and the renderer fills the coastline geometry with the
 * land one, so the shoreline stays exactly where the vector outline puts it.
 */
import type { Camera } from './projection'
import { sampleReliefAt, type ElevationGrid, type Relief } from './elevation'
import {
  getGBuffer,
  placeBuffer,
  rasteriseTerrain,
  NOT_COVERED,
  type TerrainMesh,
} from './terrain'

export type SurfaceImage = {
  // Explicitly backed by an ArrayBuffer (not SharedArrayBuffer) so the
  // buffer can be handed straight to the ImageData constructor.
  pixels: Uint8ClampedArray<ArrayBuffer>
  /**
   * Whether this is displaced terrain, already coloured land and sea, or the
   * bare sphere - which still needs its land cutting out with the coastline
   * geometry, because there is no elevation to say where the land is.
   */
  terrain: boolean
  /** Buffer dimensions, in shading samples. */
  width: number
  height: number
  /** Where to blit it, in CSS pixels. */
  x: number
  y: number
  w: number
  h: number
}

// Key light. There is deliberately no specular term: a point highlight on a
// surface this large reads as a lamp reflected in it, so the only directional
// cue is the broad gradient below.
const LX = -0.42
const LY = 0.58
const LZ = 0.7

// Environment: a bright sky above, a dark ground below, meeting at a horizon.
// Keeping saturation up through the whole ramp is what stops the metal from
// reading as plain steel - a near-white sky washes the blue straight out.
const SKY = [110, 176, 255]
const HORIZON = [30, 92, 190]
const GROUND = [5, 18, 52]

// The rim is tinted too, for the same reason: adding equal amounts to every
// channel desaturates whatever is underneath.
const RIM_TINT = [40, 118, 230]

/**
 * Land tones, by height. Deliberately cool and dark rather than the greens and
 * browns of a physical atlas: this globe is a dark instrument, and the relief
 * should read from the shading. Change these stops for an atlas palette.
 */
const LAND_STOPS = [
  { height: 0, color: [22, 38, 58] },
  { height: 900, color: [46, 68, 92] },
  { height: 2600, color: [104, 130, 158] },
  { height: 5200, color: [208, 226, 246] },
]

/**
 * The ramp above, baked into a flat table once.
 *
 * Walking the stops per pixel meant a search and then six pointer hops through
 * an array of objects holding arrays, for every shaded sample of land. A table
 * turns all of that into one index and three contiguous reads. At 512 entries
 * over the range the steps are about 13 m, which moves a colour by less than
 * half a level - below what the buffer can even hold.
 */
const RAMP_SIZE = 512
const RAMP_MAX = 6400
const RAMP_SCALE = RAMP_SIZE / RAMP_MAX
const landRamp = new Float32Array(RAMP_SIZE * 3)
for (let i = 0; i < RAMP_SIZE; i++) {
  const metres = (i / RAMP_SIZE) * RAMP_MAX
  let stop = 0
  while (stop < LAND_STOPS.length - 2 && metres > LAND_STOPS[stop + 1].height) {
    stop++
  }
  const lo = LAND_STOPS[stop]
  const hi = LAND_STOPS[stop + 1]
  const k = Math.min(1, (metres - lo.height) / (hi.height - lo.height))
  landRamp[i * 3] = lo.color[0] + (hi.color[0] - lo.color[0]) * k
  landRamp[i * 3 + 1] = lo.color[1] + (hi.color[1] - lo.color[1]) * k
  landRamp[i * 3 + 2] = lo.color[2] + (hi.color[2] - lo.color[2]) * k
}

const EARTH_RADIUS_M = 6_371_000

/**
 * Slope gain for the *lighting*, which is a separate thing from the gain used
 * to displace the geometry. Shading works on gradients, so it needs far less:
 * over a 19 km grid cell a 2 km rise is already a slope of 0.1.
 */
const SHADE_EXAGGERATION = 7

/** How strongly relief modulates each surface. Land carries more than sea. */
const SEA_RELIEF = 0.42
const LAND_RELIEF = 0.78

/** Depth darkening for the sea, reaching full strength at this depth. */
const FULL_DEPTH = 7000
const DEPTH_DARKEN = 0.3

/**
 * Near the poles the grid's columns converge and a cell becomes vanishingly
 * narrow, so the eastward slope divides by something close to zero. Clamping
 * the cosine bounds that; the error is confined to the last fraction of a
 * degree, where the cells are far narrower than a pixel anyway.
 */
const MIN_COS_LAT = 0.02

let pixelBuffer: Uint8ClampedArray<ArrayBuffer> | null = null

// Scratch, reused every sample.
const relief: Relief = { height: 0, east: 0, north: 0 }

export type ShadeOptions = {
  /** Shading samples per CSS pixel, before the budget is applied. */
  scale: number
  /** Hard ceiling on samples per frame, to bound cost on large displays. */
  maxSamples: number
}

/**
 * Shade the visible globe into reusable RGBA buffers.
 * Returns null when the globe is entirely off screen.
 */
export function shadeSurface(
  camera: Camera,
  viewport: { width: number; height: number },
  options: ShadeOptions,
  grid: ElevationGrid | null,
  mesh: TerrainMesh | null,
  exaggeration: number,
): SurfaceImage | null {
  const { cx, cy, radius } = camera

  // Only shade where the globe and the viewport actually overlap. Displaced
  // terrain stands proud of the sphere, so the box has to allow for however
  // far the tallest ground is currently pushed out.
  const reach =
    radius * (grid && mesh ? 1 + mesh.maxLift * exaggeration + 0.002 : 1)
  const x0 = Math.max(0, Math.floor(cx - reach))
  const y0 = Math.max(0, Math.floor(cy - reach))
  const x1 = Math.min(viewport.width, Math.ceil(cx + reach))
  const y1 = Math.min(viewport.height, Math.ceil(cy + reach))
  if (x1 <= x0 || y1 <= y0) return null

  const cssW = x1 - x0
  const cssH = y1 - y0

  // Derive the working scale from the region actually being shaded, so a
  // large window or a zoomed-in globe costs no more than the budget allows.
  const scale = Math.min(
    options.scale,
    Math.sqrt(options.maxSamples / (cssW * cssH)),
  )
  const width = Math.max(1, Math.round(cssW * scale))
  const height = Math.max(1, Math.round(cssH * scale))

  const needed = width * height * 4
  if (!pixelBuffer || pixelBuffer.length < needed) {
    pixelBuffer = new Uint8ClampedArray(needed)
  }
  const pixels = pixelBuffer
  pixels.fill(0, 0, needed)

  const stepX = cssW / width
  const stepY = cssH / height
  const terrain = Boolean(grid && mesh)
  const image = { pixels, terrain, width, height, x: x0, y: y0, w: cssW, h: cssH }

  if (grid && mesh) {
    shadeTerrain(camera, grid, mesh, image, stepX, stepY, exaggeration)
  } else {
    shadeSphere(camera, image, stepX, stepY, scale)
  }

  return image
}

/** The key light, carried into world space. Terrain slopes live there. */
function worldLight(camera: Camera) {
  const { cosLon, sinLon, cosLat, sinLat } = camera
  const lz1 = LZ * cosLat - LY * sinLat
  return {
    x: LX * cosLon + lz1 * sinLon,
    y: LY * cosLat + LZ * sinLat,
    z: lz1 * cosLon - LX * sinLon,
  }
}

/**
 * The smooth sphere, with no elevation to draw. Every sample is found from the
 * disc itself, and the limb is feathered over about a pixel so the edge is not
 * stair-stepped.
 */
function shadeSphere(
  camera: Camera,
  image: SurfaceImage,
  stepX: number,
  stepY: number,
  scale: number,
) {
  const { cx, cy, radius } = camera
  const { pixels, width, height, x: x0, y: y0 } = image

  const feather = Math.min(0.5, 1.5 / (radius * scale))
  const featherStart = (1 - feather) * (1 - feather)

  for (let by = 0; by < height; by++) {
    const ny = (cy - (y0 + (by + 0.5) * stepY)) / radius
    const ny2 = ny * ny
    if (ny2 >= 1) continue
    let index = by * width * 4
    const nyLY = ny * LY

    for (let bx = 0; bx < width; bx++, index += 4) {
      const nx = (x0 + (bx + 0.5) * stepX - cx) / radius
      const r2 = nx * nx + ny2
      if (r2 >= 1) continue

      const nz = Math.sqrt(1 - r2)
      const base = 0.82 + 0.18 * Math.max(0, nx * LX + nyLY + nz * LZ)
      const fresnel = fresnelAt(nz)

      environment(nz * ny + 0.5)
      pixels[index] = env[0] * base + fresnel * RIM_TINT[0]
      pixels[index + 1] = env[1] * base + fresnel * RIM_TINT[1]
      pixels[index + 2] = env[2] * base + fresnel * RIM_TINT[2]
      pixels[index + 3] =
        r2 > featherStart ? 255 * Math.min(1, (1 - Math.sqrt(r2)) / feather) : 255
    }
  }
}

/**
 * The displaced globe. The rasteriser has already decided what is visible and
 * where on the elevation grid it sits, so this walks the G-buffer and lights
 * what it finds.
 */
function shadeTerrain(
  camera: Camera,
  grid: ElevationGrid,
  mesh: TerrainMesh,
  image: SurfaceImage,
  stepX: number,
  stepY: number,
  exaggeration: number,
) {
  const { cx, cy, radius, cosLon, sinLon, cosLat, sinLat } = camera
  const { pixels, width, height, x: x0, y: y0 } = image

  const place = placeBuffer(camera, x0, y0, stepX, stepY)
  const gbuffer = getGBuffer(width, height)
  rasteriseTerrain(mesh, camera, place, gbuffer, exaggeration)

  const light = worldLight(camera)
  const invCellNorth = grid.height / (Math.PI * EARTH_RADIUS_M)
  const invCellEast = grid.width / (2 * Math.PI * EARTH_RADIUS_M)
  const { u: uBuf, v: vBuf, depth } = gbuffer

  for (let by = 0; by < height; by++) {
    const ny = (cy - (y0 + (by + 0.5) * stepY)) / radius
    const rowBase = by * width
    let index = rowBase * 4

    for (let bx = 0; bx < width; bx++, index += 4) {
      const sample = rowBase + bx
      const z = depth[sample]
      if (z === NOT_COVERED) continue

      const nx = (x0 + (bx + 0.5) * stepX - cx) / radius

      // The surface direction, from the point the ray actually hit rather than
      // from the disc: on displaced ground these differ, which is the whole
      // point.
      const invLength = 1 / Math.sqrt(nx * nx + ny * ny + z * z)
      const dx = nx * invLength
      const dy = ny * invLength
      const dz = z * invLength

      const flat = dx * LX + dy * LY + dz * LZ
      const base = 0.82 + 0.18 * (flat > 0 ? flat : 0)
      const fresnel = fresnelAt(dz)
      environment(dz * dy + 0.5)

      // Undo the camera rotation for the local east/north frame.
      const wy = dy * cosLat + dz * sinLat
      const z1 = dz * cosLat - dy * sinLat
      const wx = dx * cosLon + z1 * sinLon
      const wz = z1 * cosLon - dx * sinLon

      const horizontal = Math.sqrt(wx * wx + wz * wz)
      const cosPhi = horizontal > MIN_COS_LAT ? horizontal : MIN_COS_LAT
      const invCos = 1 / cosPhi

      sampleReliefAt(grid, uBuf[sample], vBuf[sample], relief)

      const se = SHADE_EXAGGERATION * relief.east * invCellEast * invCos
      const sn = SHADE_EXAGGERATION * relief.north * invCellNorth

      // east is (wz, 0, -wx)/cos, north is (-wy*wx, cos^2, -wy*wz)/cos.
      const eastDotL = (wz * light.x - wx * light.z) * invCos
      const northDotL =
        (-wy * wx * light.x + cosPhi * cosPhi * light.y - wy * wz * light.z) *
        invCos

      const tilted =
        (flat - se * eastDotL - sn * northDotL) / Math.sqrt(1 + se * se + sn * sn)
      const shade = tilted - flat
      const elevation = relief.height

      // Land or sea comes from the same sample that displaced the ground, so
      // the colour cannot drift away from the shape the way a coastline
      // projected onto the undisplaced sphere does - which showed up as a rim
      // of sea colour around every continent, worst at the limb, where the
      // displacement is entirely sideways.
      //
      // The crossing is softened over about a grid cell either side, measured
      // by how fast the height is changing: a steep coast gets a hard edge, a
      // shallow one a wider blend, and both stay smooth under magnification.
      const slope = Math.abs(relief.east) + Math.abs(relief.north) + 1
      let landness = 0.5 + elevation / slope
      if (landness < 0) landness = 0
      else if (landness > 1) landness = 1

      let ramp = elevation > 0 ? (elevation * RAMP_SCALE) | 0 : 0
      if (ramp >= RAMP_SIZE) ramp = RAMP_SIZE - 1
      ramp *= 3
      const landGain = 1 + LAND_RELIEF * shade + 0.12 * (flat > 0 ? flat : 0)

      const deep = elevation < 0 ? Math.min(1, -elevation / FULL_DEPTH) : 0
      const seaGain = base * (1 - DEPTH_DARKEN * deep) + SEA_RELIEF * shade
      const wet = 1 - landness

      // The rasteriser decides coverage per whole sample, so the silhouette
      // comes out as a staircase. Counting how many of the four neighbours were
      // also covered approximates how much of this sample the surface actually
      // fills. Only the outline is affected; interior samples all score four.
      // The ramp is deliberately shallow - seen edge on at the limb, terrain
      // makes a thin ragged profile where many samples are edge samples, and a
      // steep ramp turns that whole rim translucent.
      let covered = 4
      if (bx === 0 || depth[sample - 1] === NOT_COVERED) covered--
      if (bx === width - 1 || depth[sample + 1] === NOT_COVERED) covered--
      if (by === 0 || depth[sample - width] === NOT_COVERED) covered--
      if (by === height - 1 || depth[sample + width] === NOT_COVERED) covered--

      pixels[index] =
        (env[0] * seaGain + fresnel * RIM_TINT[0]) * wet +
        landRamp[ramp] * landGain * landness
      pixels[index + 1] =
        (env[1] * seaGain + fresnel * RIM_TINT[1]) * wet +
        landRamp[ramp + 1] * landGain * landness
      pixels[index + 2] =
        (env[2] * seaGain + fresnel * RIM_TINT[2]) * wet +
        landRamp[ramp + 2] * landGain * landness
      pixels[index + 3] = covered === 4 ? 255 : 176 + covered * 20
    }
  }
}

// Scratch for the environment lookup, so it can return three numbers without
// allocating on every sample.
const env = [0, 0, 0]

/**
 * Environment reflection, sampled by the reflected ray's height. Each half of
 * the ramp is eased so the two meet with matching slope at the horizon - a
 * plain linear join leaves a visible crease there.
 */
function environment(t: number) {
  if (t > 0.5) {
    const u = (t - 0.5) * 2
    const k = u * u * (3 - 2 * u)
    env[0] = HORIZON[0] + (SKY[0] - HORIZON[0]) * k
    env[1] = HORIZON[1] + (SKY[1] - HORIZON[1]) * k
    env[2] = HORIZON[2] + (SKY[2] - HORIZON[2]) * k
  } else {
    const u = t > 0 ? t * 2 : 0
    const k = u * u * (3 - 2 * u)
    env[0] = GROUND[0] + (HORIZON[0] - GROUND[0]) * k
    env[1] = GROUND[1] + (HORIZON[1] - GROUND[1]) * k
    env[2] = GROUND[2] + (HORIZON[2] - GROUND[2]) * k
  }
}

/** Grazing angles reflect more, which brightens the limb. */
function fresnelAt(nz: number) {
  const f = 1 - nz
  const f2 = f * f
  return f2 * f2 * 0.55
}
