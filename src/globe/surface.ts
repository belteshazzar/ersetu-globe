/**
 * What is left of the software surface: the bare sphere, before any terrain
 * has arrived.
 *
 * The globe itself is drawn by `gl.ts` now. This is a radial gradient on the 2D
 * canvas, for the moment between the first frame and the first tiles - there is
 * no elevation yet to say where the land is or which way the ground faces, and
 * a gradient is the honest thing to show.
 */
import type { Camera } from './projection'

const SKY = [110, 176, 255]
const HORIZON = [30, 92, 190]
const GROUND = [5, 18, 52]

/** The land colour used to fill the coastline polygons before terrain lands. */
export const FLAT_LAND_CSS = 'rgb(82, 88, 93)'

export function paintSphere(ctx: CanvasRenderingContext2D, camera: Camera) {
  const { cx, cy, radius } = camera
  const gradient = ctx.createRadialGradient(
    cx - radius * 0.25,
    cy - radius * 0.35,
    radius * 0.05,
    cx,
    cy,
    radius,
  )
  gradient.addColorStop(0, `rgb(${SKY[0]},${SKY[1]},${SKY[2]})`)
  gradient.addColorStop(0.55, `rgb(${HORIZON[0]},${HORIZON[1]},${HORIZON[2]})`)
  gradient.addColorStop(1, `rgb(${GROUND[0]},${GROUND[1]},${GROUND[2]})`)

  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fillStyle = gradient
  ctx.fill()
}
