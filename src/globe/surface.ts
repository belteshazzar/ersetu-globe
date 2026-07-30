/**
 * Per-pixel shading for the sphere: the metal sea, and the land relief.
 *
 * Metal reads as metal because of what it reflects, not because of its
 * diffuse colour, so the base tone here comes from an environment gradient
 * looked up by the reflection vector, with a Fresnel rim on top.
 *
 * Relief is added as a *modulation* of that lighting rather than by disturbing
 * the reflection. The environment gradient describes the shape of the sphere,
 * which is smooth; terrain is a local brightening and darkening on top of it.
 * Keeping the two separate is both truer to what the eye reads as relief and
 * far cheaper - the reflection lookup is untouched, and the whole terrain
 * contribution is one scalar per pixel.
 *
 * That scalar falls out with no vector rotation at all. The perturbed normal is
 * `w - (se*e + sn*n)` for slopes `se`, `sn` in the local east/north frame, so
 *
 *     n'.L = (w.L - se(e.L) - sn(n.L)) / sqrt(1 + se^2 + sn^2)
 *
 * and because the key light is fixed in camera space, `L` need only be carried
 * into world space once per frame. `w.L` is the value the smooth sphere would
 * have had, so subtracting it leaves exactly the terrain's own contribution.
 *
 * Two images come out of the one pass: the sea look and the land look. They
 * share every expensive term - the unprojection, the grid lookup, the slope -
 * and the renderer composites the land one into the holes it punches with the
 * real coastline geometry, so the shoreline stays exactly where the vector
 * outline puts it rather than wherever a 19 km grid cell happens to fall.
 *
 * All of this is smooth enough to run at a fraction of display resolution and
 * be scaled up on blit; every crisp edge in the final image comes from the
 * vector passes drawn over it.
 */
import type { Camera } from './projection'
import { sampleReliefAt, type ElevationGrid, type Relief } from './elevation'

const HALF_PI = Math.PI / 2
const TAU = Math.PI * 2

/**
 * atan2 to within about 1e-7 radians - a thousandth of a grid cell, and far
 * finer than anything that reaches a pixel.
 *
 * The library version is accurate to the last bit and costs accordingly, which
 * is worth paying once but not once per sample: this is the hot path, run for
 * every shaded pixel of the globe, twice. Folding the argument into [0, 1] and
 * running a seven term odd polynomial is several times quicker.
 */
function fastAtan2(y: number, x: number): number {
  const ax = x < 0 ? -x : x
  const ay = y < 0 ? -y : y
  if (ax === 0 && ay === 0) return 0

  // Keep the ratio inside the unit interval, where the polynomial is fitted.
  const swap = ay > ax
  const t = swap ? ax / ay : ay / ax
  const t2 = t * t

  let r =
    t *
    (0.99999766 +
      t2 *
        (-0.33262347 +
          t2 *
            (0.19354346 +
              t2 * (-0.11643287 + t2 * (0.05265332 + t2 * -0.0117212)))))

  if (swap) r = HALF_PI - r
  if (x < 0) r = Math.PI - r
  return y < 0 ? -r : r
}

export type SurfaceImage = {
  // Explicitly backed by an ArrayBuffer (not SharedArrayBuffer) so the
  // buffer can be handed straight to the ImageData constructor.
  sea: Uint8ClampedArray<ArrayBuffer>
  /** Null when there is no elevation grid, in which case land stays a hole. */
  land: Uint8ClampedArray<ArrayBuffer> | null
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
 * should read from the shading rather than from biome colour. Change these
 * stops and their heights to get an atlas palette instead.
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
 * Slope gain. Relief shading works on gradients rather than heights, so it
 * needs nothing like the 20x-100x that displacing the geometry would: over a
 * 19 km grid cell a 2 km rise is already a slope of 0.1. This is enough to
 * make the ocean ridges and the great mountain chains obvious without turning
 * gentle country into noise.
 */
const EXAGGERATION = 7

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

let seaBuffer: Uint8ClampedArray<ArrayBuffer> | null = null
let landBuffer: Uint8ClampedArray<ArrayBuffer> | null = null

// Scratch, reused every sample.
const relief: Relief = { height: 0, east: 0, north: 0 }

export type ShadeOptions = {
  /** Shading samples per CSS pixel, before the budget is applied. */
  scale: number
  /** Hard ceiling on samples per frame, to bound cost on large displays. */
  maxSamples: number
}

/**
 * Shade the visible sphere into reusable RGBA buffers.
 * Returns null when the globe is entirely off screen.
 */
export function shadeSurface(
  camera: Camera,
  viewport: { width: number; height: number },
  options: ShadeOptions,
  grid: ElevationGrid | null,
): SurfaceImage | null {
  const { cx, cy, radius, cosLon, sinLon, cosLat, sinLat } = camera

  // Only shade where the globe and the viewport actually overlap.
  const x0 = Math.max(0, Math.floor(cx - radius))
  const y0 = Math.max(0, Math.floor(cy - radius))
  const x1 = Math.min(viewport.width, Math.ceil(cx + radius))
  const y1 = Math.min(viewport.height, Math.ceil(cy + radius))
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
  if (!seaBuffer || seaBuffer.length < needed) {
    seaBuffer = new Uint8ClampedArray(needed)
  }
  const sea = seaBuffer
  sea.fill(0, 0, needed)

  let land: Uint8ClampedArray<ArrayBuffer> | null = null
  if (grid) {
    if (!landBuffer || landBuffer.length < needed) {
      landBuffer = new Uint8ClampedArray(needed)
    }
    land = landBuffer
    land.fill(0, 0, needed)
  }

  // Feather the limb over roughly a pixel so the disc edge is not stair-stepped.
  const feather = Math.min(0.5, 1.5 / (radius * scale))
  const featherStart = (1 - feather) * (1 - feather)

  const stepX = cssW / width
  const stepY = cssH / height

  // The key light, carried into world space once. Terrain slopes live in the
  // local east/north frame, which is a world-space thing; taking the light to
  // them costs one rotation per frame instead of one per pixel.
  const lz1 = LZ * cosLat - LY * sinLat
  const lightY = LY * cosLat + LZ * sinLat
  const lightX = LX * cosLon + lz1 * sinLon
  const lightZ = lz1 * cosLon - LX * sinLon

  // A grid cell's north-south extent never varies; its east-west extent is a
  // full circumference divided between the columns, narrowing with latitude.
  // Held as reciprocals: the pixel loop should multiply, not divide.
  const invCellNorth = grid ? grid.height / (Math.PI * EARTH_RADIUS_M) : 0
  const invCellEast = grid ? grid.width / (2 * Math.PI * EARTH_RADIUS_M) : 0

  // Angle straight to grid coordinate, so the loop never forms degrees.
  const gridPerRadianX = grid ? grid.width / TAU : 0
  const gridPerRadianY = grid ? grid.height / Math.PI : 0
  const halfWidth = grid ? grid.width / 2 : 0
  const halfHeight = grid ? grid.height / 2 : 0

  for (let by = 0; by < height; by++) {
    const ny = (cy - (y0 + (by + 0.5) * stepY)) / radius
    const ny2 = ny * ny
    if (ny2 >= 1) continue
    let index = by * width * 4

    // Row constants, hoisted out of the pixel loop.
    const nyLY = ny * LY

    for (let bx = 0; bx < width; bx++, index += 4) {
      const nx = (x0 + (bx + 0.5) * stepX - cx) / radius
      const r2 = nx * nx + ny2
      if (r2 >= 1) continue

      const nz = Math.sqrt(1 - r2)

      // Environment reflection, sampled by the reflected ray's height. Each
      // half of the ramp is eased so the two meet with matching slope at the
      // horizon - a plain linear join leaves a visible crease there.
      const t = nz * ny + 0.5 // == (2*nz*ny)*0.5 + 0.5
      let er: number
      let eg: number
      let eb: number
      if (t > 0.5) {
        const u = (t - 0.5) * 2
        const k = u * u * (3 - 2 * u)
        er = HORIZON[0] + (SKY[0] - HORIZON[0]) * k
        eg = HORIZON[1] + (SKY[1] - HORIZON[1]) * k
        eb = HORIZON[2] + (SKY[2] - HORIZON[2]) * k
      } else {
        const u = t * 2
        const k = u * u * (3 - 2 * u)
        er = GROUND[0] + (HORIZON[0] - GROUND[0]) * k
        eg = GROUND[1] + (HORIZON[1] - GROUND[1]) * k
        eb = GROUND[2] + (HORIZON[2] - GROUND[2]) * k
      }

      // Fresnel: grazing angles reflect more, which brightens the limb.
      const f = 1 - nz
      const f2 = f * f
      const fresnel = f2 * f2 * 0.55

      // What the smooth sphere alone would give.
      const flat = nx * LX + nyLY + nz * LZ
      const base = 0.82 + 0.18 * Math.max(0, flat)

      const alpha =
        r2 > featherStart ? 255 * Math.min(1, (1 - Math.sqrt(r2)) / feather) : 255

      if (!grid || !land) {
        sea[index] = er * base + fresnel * RIM_TINT[0]
        sea[index + 1] = eg * base + fresnel * RIM_TINT[1]
        sea[index + 2] = eb * base + fresnel * RIM_TINT[2]
        sea[index + 3] = alpha
        continue
      }

      // Undo the camera rotation to find where on the globe this pixel is.
      const wy = ny * cosLat + nz * sinLat
      const z1 = nz * cosLat - ny * sinLat
      const wx = nx * cosLon + z1 * sinLon
      const wz = z1 * cosLon - nx * sinLon

      // The world normal's horizontal length is the cosine of the latitude,
      // which makes the latitude itself an atan2 rather than an arcsine - and
      // the same routine then serves for the longitude.
      const horizontal = Math.sqrt(wx * wx + wz * wz)
      const cosPhi = horizontal > MIN_COS_LAT ? horizontal : MIN_COS_LAT
      const invCos = 1 / cosPhi

      sampleReliefAt(
        grid,
        (fastAtan2(wx, wz) * gridPerRadianX + halfWidth) - 0.5,
        (halfHeight - fastAtan2(wy, horizontal) * gridPerRadianY) - 0.5,
        relief,
      )

      // Slopes, as a rise over a run in the same units.
      const se = EXAGGERATION * relief.east * invCellEast * invCos
      const sn = EXAGGERATION * relief.north * invCellNorth

      // The light resolved onto the local east and north directions. Both
      // basis vectors come straight from the world normal, no trigonometry:
      // east is (wz, 0, -wx)/cos, north is (-wy*wx, cos^2, -wy*wz)/cos.
      const eastDotL = (wz * lightX - wx * lightZ) * invCos
      const northDotL =
        (-wy * wx * lightX + cosPhi * cosPhi * lightY - wy * wz * lightZ) * invCos

      const tilted =
        (flat - se * eastDotL - sn * northDotL) / Math.sqrt(1 + se * se + sn * sn)

      // Terrain's own contribution: what the slope added over flat ground.
      const shade = tilted - flat
      const elevation = relief.height

      // Sea: the metal, darkened with depth and modulated by the sea floor.
      const depth = elevation < 0 ? Math.min(1, -elevation / FULL_DEPTH) : 0
      const seaGain = base * (1 - DEPTH_DARKEN * depth) + SEA_RELIEF * shade
      sea[index] = er * seaGain + fresnel * RIM_TINT[0]
      sea[index + 1] = eg * seaGain + fresnel * RIM_TINT[1]
      sea[index + 2] = eb * seaGain + fresnel * RIM_TINT[2]
      sea[index + 3] = alpha

      // Land: a height ramp, lit by the same slope.
      let ramp = elevation > 0 ? (elevation * RAMP_SCALE) | 0 : 0
      if (ramp >= RAMP_SIZE) ramp = RAMP_SIZE - 1
      ramp *= 3
      const landGain = 1 + LAND_RELIEF * shade + 0.12 * (flat > 0 ? flat : 0)

      land[index] = landRamp[ramp] * landGain
      land[index + 1] = landRamp[ramp + 1] * landGain
      land[index + 2] = landRamp[ramp + 2] * landGain
      // Feathered exactly like the sea, so a continent meeting the silhouette
      // fades into the page on the same edge the sea does rather than stopping
      // against it.
      land[index + 3] = alpha
    }
  }

  return { sea, land, width, height, x: x0, y: y0, w: cssW, h: cssH }
}
