/**
 * The G-buffer, and the triangle rasteriser that fills it.
 *
 * The globe is displaced geometry rather than a painted sphere: every vertex is
 * pushed out to `1 + k*h`, so mountains genuinely stand off the surface and
 * basins genuinely sink into it. That geometry is rasterised here, in software,
 * with a depth buffer - the 2D canvas has no notion of depth, so a mountain can
 * only hide what is behind it if we sort that out ourselves. The triangles
 * themselves come from `quadtree.ts`, which decides per frame what the camera
 * is close enough to see.
 *
 * Two things make this much cheaper than it sounds.
 *
 * An orthographic projection is affine: there is no perspective divide, so
 * attributes interpolate exactly with plain screen-space barycentrics and no
 * correction is needed anywhere.
 *
 * And the rasteriser does not shade. It writes only where on the globe each
 * covered sample landed, plus its depth - a G-buffer - and the shading pass
 * then reads the terrain tiles per pixel. Geometry is therefore limited by the
 * mesh, but the shading is not: the relief keeps every bit of the detail it had
 * when it was only a lighting trick, while the silhouette, the parallax and the
 * occlusion become real.
 *
 * The surface is closed and star-shaped about the centre - a radial height
 * field has no overhangs - so any back-facing triangle is hidden by front-
 * facing geometry, and winding order alone is a sound way to discard half the
 * mesh before rasterising.
 */
import type { Camera } from './projection'

/**
 * What the rasteriser leaves behind for the shading pass: where on the
 * elevation grid each sample landed, and how near the camera it was.
 */
export type GBuffer = {
  width: number
  height: number
  u: Float32Array
  v: Float32Array
  /** Camera-space depth, larger being nearer. NOT_COVERED where nothing hit. */
  depth: Float32Array
}

/**
 * Depth of a sample nothing was drawn to.
 *
 * Infinity rather than some very negative number because the buffer is
 * Float32: a value like -1e30 does not survive the round trip through single
 * precision, so testing a sample against it never matches and every pixel
 * reads as covered.
 */
export const NOT_COVERED = -Infinity

let gbuffer: GBuffer | null = null

export function getGBuffer(width: number, height: number): GBuffer {
  const needed = width * height
  if (!gbuffer || gbuffer.u.length < needed) {
    gbuffer = {
      width,
      height,
      u: new Float32Array(needed),
      v: new Float32Array(needed),
      depth: new Float32Array(needed),
    }
  }
  gbuffer.width = width
  gbuffer.height = height
  gbuffer.depth.fill(NOT_COVERED, 0, needed)
  return gbuffer
}

/**
 * How the buffer's samples line up with the globe on screen. The shading pass
 * walks samples and derives camera coordinates; the rasteriser has to go the
 * other way, and the two must agree exactly or the geometry and the lighting
 * would disagree about where the surface is.
 */
export type BufferPlacement = {
  scaleX: number
  offsetX: number
  scaleY: number
  offsetY: number
}

export function placeBuffer(
  camera: Camera,
  x0: number,
  y0: number,
  stepX: number,
  stepY: number,
): BufferPlacement {
  return {
    scaleX: camera.radius / stepX,
    offsetX: (camera.cx - x0) / stepX - 0.5,
    scaleY: camera.radius / stepY,
    offsetY: (camera.cy - y0) / stepY - 0.5,
  }
}

/**
 * Rasterise one triangle with a depth test.
 *
 * Coverage comes from the sign of the three edge functions, which is the usual
 * half-plane test; because the projection is affine those same edge functions,
 * normalised, are the barycentric weights, so depth and surface coordinates
 * come out of work already done.
 *
 * Corners are passed loose rather than as indices into a vertex array: the
 * quadtree has no fixed one, and it has to adjust the longitude per triangle at
 * the antimeridian. Screen x and y are in buffer samples, z is camera-space
 * depth in globe radii, and u/v are the normalised position on the globe.
 */
export function rasteriseTriangle(
  target: GBuffer,
  ax: number, ay: number, az: number, au: number, av: number,
  bx: number, by: number, bz: number, bu: number, bv: number,
  cx: number, cy: number, cz: number, cu: number, cv: number,
) {
  // Signed area: negative is back-facing, zero is degenerate - which is what
  // every triangle collapsed onto a pole becomes.
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  if (area <= 1e-12) return

  const { width, height, u, v, depth } = target

  let minX = Math.floor(ax < bx ? (ax < cx ? ax : cx) : bx < cx ? bx : cx)
  let maxX = Math.ceil(ax > bx ? (ax > cx ? ax : cx) : bx > cx ? bx : cx)
  let minY = Math.floor(ay < by ? (ay < cy ? ay : cy) : by < cy ? by : cy)
  let maxY = Math.ceil(ay > by ? (ay > cy ? ay : cy) : by > cy ? by : cy)

  if (minX < 0) minX = 0
  if (minY < 0) minY = 0
  if (maxX > width - 1) maxX = width - 1
  if (maxY > height - 1) maxY = height - 1
  if (minX > maxX || minY > maxY) return

  const inv = 1 / area

  for (let py = minY; py <= maxY; py++) {
    const y = py
    const rowBase = py * width

    // Edge functions are affine in x, so step them along the scanline rather
    // than recomputing all three per sample.
    const w0Row = (cx - bx) * (y - by) - (cy - by) * (minX - bx)
    const w1Row = (ax - cx) * (y - cy) - (ay - cy) * (minX - cx)
    const w2Row = (bx - ax) * (y - ay) - (by - ay) * (minX - ax)
    const w0Step = -(cy - by)
    const w1Step = -(ay - cy)
    const w2Step = -(by - ay)

    let w0 = w0Row
    let w1 = w1Row
    let w2 = w2Row

    for (let px = minX; px <= maxX; px++, w0 += w0Step, w1 += w1Step, w2 += w2Step) {
      if (w0 < 0 || w1 < 0 || w2 < 0) continue

      const l0 = w0 * inv
      const l1 = w1 * inv
      const l2 = w2 * inv

      const z = az * l0 + bz * l1 + cz * l2
      const index = rowBase + px
      if (z <= depth[index]) continue

      depth[index] = z
      u[index] = au * l0 + bu * l1 + cu * l2
      v[index] = av * l0 + bv * l1 + cv * l2
    }
  }
}
