/**
 * A scalar field painted over the globe, and the ramp that colours it.
 *
 * The thing uploaded is the measurement, not a picture of it. That matters as
 * soon as anything is animated: cross-fading two coloured images averages the
 * colours, and a blue nought degrees mixed with a red thirty gives a muddy
 * purple that reads as fifteen only by accident - through a ramp with any
 * shape at all it is simply the wrong answer. Interpolate the field, then
 * colour it, and every intermediate frame means something.
 *
 * It costs nothing either. One channel instead of three is a third of the
 * bytes, and recolouring - a different ramp, a threshold moved, a band made to
 * pulse - is a kilobyte of palette rather than a re-upload of the data.
 *
 * Samples are one byte, so a field carries 256 levels across whatever range the
 * caller chose to quantise into. Over sixty degrees of frost to sixty of heat
 * that is steps of under half a degree, which is finer than the forecast. When
 * that is genuinely not enough the answer is two channels and a reconstruction
 * in the shader, and this is where it would go.
 */

/** The lon/lat box a field covers, in degrees. */
export type Bounds = {
  west: number
  east: number
  south: number
  north: number
}

/** The whole globe, which is what a field covers unless it says otherwise. */
export const GLOBE: Bounds = { west: -180, east: 180, south: -90, north: 90 }

/**
 * An equirectangular grid over a lon/lat box.
 *
 * Regional rather than global is the normal case, not the exception: a forecast
 * comes off a model with a domain, and radar sees as far as the radar sees.
 * Outside its bounds a field says nothing at all and the ground is left alone -
 * which is different from saying zero, and has to be, or every map would come
 * with a rectangle of whatever colour zero happens to be.
 *
 * A box may cross the antimeridian by giving an east smaller than its west.
 *
 * Dimensions should be powers of two. A field spanning the whole globe wraps
 * horizontally, and WebGL 1 only repeats a texture whose sides are.
 */
export type Field = {
  width: number
  height: number
  /** One byte a sample, row-major from the north-west corner. */
  samples: Uint8Array
  bounds: Bounds
}

/** Degrees of longitude a box spans, going east; 360 for the whole way round. */
export function spanEast(bounds: Bounds): number {
  const span = (((bounds.east - bounds.west) % 360) + 360) % 360
  return span === 0 ? 360 : span
}

export type Overlay = {
  field: Field
  /**
   * The frame being crossed to, if this is a moment between two of them.
   *
   * Both frames have to share a domain: the box is read from `field`, and a
   * `next` lying somewhere else would be stretched onto the first one's
   * footprint rather than its own.
   */
  next?: Field
  /** Where between the two this moment lies. 0 is `field`, 1 is `next`. */
  mix?: number
  /** 256 RGBA entries, indexed by sample value. */
  palette: Uint8Array
  /** How much of it to show, over the surface beneath. */
  opacity: number
}

export type Stop = {
  /** Where this colour sits, 0 to 1 across the field's range. */
  at: number
  color: readonly [number, number, number]
  /** Defaults to 1. Zero leaves the ground showing through untouched. */
  alpha?: number
}

/**
 * Build the 256-entry ramp a field is coloured through.
 *
 * Alpha is interpolated alongside the colour, which is what gives a scale a
 * transparent middle - a divergence from normal that shows the anomaly and
 * leaves the ordinary weather alone.
 */
export function palette(stops: readonly Stop[]): Uint8Array {
  const out = new Uint8Array(256 * 4)
  if (stops.length === 0) return out

  const sorted = [...stops].sort((a, b) => a.at - b.at)
  let i = 0
  for (let n = 0; n < 256; n++) {
    const at = n / 255
    while (i < sorted.length - 2 && at >= sorted[i + 1].at) i++

    const a = sorted[i]
    const b = sorted[Math.min(i + 1, sorted.length - 1)]
    const span = b.at - a.at
    let t = span > 0 ? (at - a.at) / span : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t

    const alphaA = a.alpha ?? 1
    const alphaB = b.alpha ?? 1
    out[n * 4] = Math.round(a.color[0] + (b.color[0] - a.color[0]) * t)
    out[n * 4 + 1] = Math.round(a.color[1] + (b.color[1] - a.color[1]) * t)
    out[n * 4 + 2] = Math.round(a.color[2] + (b.color[2] - a.color[2]) * t)
    out[n * 4 + 3] = Math.round((alphaA + (alphaB - alphaA) * t) * 255)
  }
  return out
}

/**
 * Fill a field from a function of longitude and latitude, in radians.
 *
 * `range` is what the byte scale spans, so the values handed back keep their
 * own units and the quantisation happens in one place. Anything outside is
 * clamped rather than wrapped, since a reading off the end of the scale is
 * still the hottest thing on the map.
 */
export function field(
  width: number,
  height: number,
  range: readonly [number, number],
  at: (longitude: number, latitude: number) => number,
  bounds: Bounds = GLOBE,
): Field {
  const samples = new Uint8Array(width * height)
  const [low, high] = range
  const span = high - low || 1

  const DEG = Math.PI / 180
  const west = bounds.west * DEG
  const north = bounds.north * DEG
  const eastward = spanEast(bounds) * DEG
  const southward = (bounds.north - bounds.south) * DEG

  for (let y = 0; y < height; y++) {
    // Samples sit at cell centres, so the edges of the box are half a cell
    // outside the grid rather than on top of its first and last rows.
    const latitude = north - ((y + 0.5) / height) * southward
    for (let x = 0; x < width; x++) {
      const longitude = west + ((x + 0.5) / width) * eastward
      const t = (at(longitude, latitude) - low) / span
      samples[y * width + x] = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255)
    }
  }
  return { width, height, samples, bounds }
}
