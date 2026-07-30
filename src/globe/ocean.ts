/**
 * Per-pixel metallic shading for the sphere.
 *
 * Metal reads as metal because of what it reflects, not because of its
 * diffuse colour, so the base tone here comes from an environment gradient
 * looked up by the reflection vector, with a specular highlight and a
 * Fresnel rim on top.
 *
 * This shades the whole disc; the land is punched out afterwards using the
 * coastline geometry. Because everything here is a smooth gradient, it can
 * run at a fraction of display resolution and be scaled up on blit without
 * anyone noticing - all the crisp edges in the final image come from the
 * vector passes drawn over it.
 */
import type { Camera } from './projection'

export type OceanImage = {
  // Explicitly backed by an ArrayBuffer (not SharedArrayBuffer) so the
  // buffer can be handed straight to the ImageData constructor.
  data: Uint8ClampedArray<ArrayBuffer>
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

let buffer: Uint8ClampedArray<ArrayBuffer> | null = null

export type ShadeOptions = {
  /** Shading samples per CSS pixel, before the budget is applied. */
  scale: number
  /** Hard ceiling on samples per frame, to bound cost on large displays. */
  maxSamples: number
}

/**
 * Shade the visible ocean into a reusable RGBA buffer.
 * Returns null when the globe is entirely off screen.
 */
export function shadeOcean(
  camera: Camera,
  viewport: { width: number; height: number },
  options: ShadeOptions,
): OceanImage | null {
  const { cx, cy, radius } = camera

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
  if (!buffer || buffer.length < needed) buffer = new Uint8ClampedArray(needed)
  const data = buffer
  data.fill(0, 0, needed)

  // Feather the limb over roughly a pixel so the disc edge is not stair-stepped.
  const feather = Math.min(0.5, 1.5 / (radius * scale))
  const featherStart = (1 - feather) * (1 - feather)

  const stepX = cssW / width
  const stepY = cssH / height

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

      const gain = 0.82 + 0.18 * Math.max(0, nx * LX + nyLY + nz * LZ)

      data[index] = er * gain + fresnel * RIM_TINT[0]
      data[index + 1] = eg * gain + fresnel * RIM_TINT[1]
      data[index + 2] = eb * gain + fresnel * RIM_TINT[2]

      if (r2 > featherStart) {
        data[index + 3] = 255 * Math.min(1, (1 - Math.sqrt(r2)) / feather)
      } else {
        data[index + 3] = 255
      }
    }
  }

  return { data, width, height, x: x0, y: y0, w: cssW, h: cssH }
}
