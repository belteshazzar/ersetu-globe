import type { AppState } from '../store/appStore'
import { COASTLINE_POLYGONS, COASTLINE_RINGS } from './data/coastlines'
import {
  buildGraticule,
  buildMesh,
  buildPolygonMesh,
  fillPolygons,
  makeCamera,
  strokeMesh,
  type Camera,
} from './projection'
import { shadeSurface, type SurfaceImage } from './surface'
import type { ElevationGrid } from './elevation'
import type { TerrainMesh } from './terrain'
import type { Shape } from './shapes'
import { drawOrbits, type Orbit } from './orbits'
import { drawLabels, type Label } from './labels'

/** Everything drawn on top of the globe itself. */
export type Scene = {
  /** Geometry lying on the surface. */
  shapes?: readonly Shape[]
  /** Orbits standing off the surface, with their satellites. */
  orbits?: readonly Orbit[]
  /**
   * Text pinned to the surface, to points above it, or to moving entities.
   * Drawn last, over everything else; earlier labels win any collision.
   */
  labels?: readonly Label[]
  /**
   * Relief for the globe itself, rather than an overlay on it. Optional and
   * loaded asynchronously: until it arrives the globe shades as smooth metal
   * with the land cut out, which is what it did before there was any.
   * `terrain` is the displaced mesh built from `elevation`; both are needed
   * before the globe takes on any shape.
   */
  elevation?: ElevationGrid | null
  terrain?: TerrainMesh | null
  /**
   * The clock driving satellite motion, in the same units as each orbit's
   * period. Scale it however fast you want the animation to run.
   */
  time?: number
}

export type Viewport = {
  /** CSS pixels. */
  width: number
  height: number
  dpr: number
}

// Baked once at module load: lon/lat degrees -> unit-sphere xyz.
const coastlines = buildMesh(COASTLINE_RINGS)
const landfill = buildPolygonMesh(COASTLINE_POLYGONS)
const graticule = buildMesh(buildGraticule(30))

const LIMB = 'rgba(150, 200, 250, 0.75)'
const GRATICULE = 'rgba(190, 220, 250, 0.22)'
const COAST = 'rgba(200, 226, 250, 0.7)'

// The metal is shaded at a fraction of display resolution and scaled up. It is
// all smooth gradient, so that costs nothing visually - every crisp edge in the
// final image comes from the vector passes below. The sample ceiling keeps the
// pass at roughly 4ms even on a large display.
const SHADE = { scale: 0.5, maxSamples: 160_000 }

/**
 * Where the globe sits on screen for a given viewport and store state.
 *
 * Shared so that hit-testing a pointer and drawing the globe cannot disagree
 * about the position or size of the sphere.
 */
export function globeCamera(viewport: Viewport, state: AppState): Camera {
  const { width, height } = viewport
  return makeCamera(
    width / 2,
    height / 2,
    (Math.min(width, height) / 2) * 0.72 * state.zoom,
    state.longitude,
    state.latitude,
  )
}

/**
 * Draws the globe into a 2D context already scaled to device pixels, so all
 * units here are CSS pixels.
 */
export function renderGlobe(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  state: AppState,
  scene: Scene = {},
) {
  const { width, height } = viewport
  ctx.clearRect(0, 0, width, height)

  const camera = globeCamera(viewport, state)
  const { cx, cy, radius } = camera

  const surface = shadeSurface(
    camera,
    viewport,
    SHADE,
    scene.elevation ?? null,
    scene.terrain ?? null,
    state.exaggeration,
  )
  if (surface) blit(ctx, surface, surface.pixels)

  // Displaced terrain already knows which of its samples are land, from the
  // same elevation that gave them their shape, so it arrives coloured.
  //
  // The bare sphere does not - there is no elevation to ask - so its land is
  // cut out with the real coastline geometry rather than a bitmask, which
  // keeps the edge on the stroked outline and lets the canvas antialias it.
  if (!surface?.terrain) {
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = '#000'
    fillPolygons(ctx, landfill, camera)
    ctx.globalCompositeOperation = 'source-over'
  }

  ctx.lineWidth = 1.25
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  ctx.strokeStyle = GRATICULE
  strokeMesh(ctx, graticule, camera)

  ctx.strokeStyle = COAST
  strokeMesh(ctx, coastlines, camera)

  // Sphere silhouette, over the shaded limb. Displaced terrain has a
  // silhouette of its own - that is rather the point of displacing it - and a
  // perfect circle drawn over the top would saw straight through every
  // mountain standing past it.
  if (!surface?.terrain) {
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.strokeStyle = LIMB
    ctx.stroke()
  }

  // Surface overlays go through the same horizon clipping as the coastlines,
  // so they are hidden exactly where the surface curves away.
  for (const item of scene.shapes ?? []) {
    ctx.strokeStyle = item.style.color
    ctx.lineWidth = item.style.width ?? 1.5
    ctx.setLineDash(item.style.dash ? [...item.style.dash] : [])
    strokeMesh(ctx, item.mesh, camera)
  }
  ctx.setLineDash([])

  // Orbits stand off the surface, so they use occlusion against the globe
  // rather than the horizon test, and remain visible past its edge.
  if (scene.orbits?.length) {
    drawOrbits(ctx, camera, scene.orbits, scene.time ?? 0)
  }

  // Text on top of everything: it is the one layer that cannot be read through
  // whatever is drawn over it.
  if (scene.labels?.length) {
    drawLabels(ctx, camera, scene.labels, scene.time ?? 0)
  }
}

// Scratch canvas used to scale a shaded buffer up on blit. putImageData
// ignores the current transform, so it cannot write to the main canvas
// directly, and it ignores the composite operation too - hence the round trip
// through drawImage, which honours both.
let scratch: HTMLCanvasElement | null = null
let scratchCtx: CanvasRenderingContext2D | null = null

function blit(
  ctx: CanvasRenderingContext2D,
  image: SurfaceImage,
  data: Uint8ClampedArray<ArrayBuffer>,
) {
  if (!scratch) {
    if (typeof document === 'undefined') return
    scratch = document.createElement('canvas')
    scratchCtx = scratch.getContext('2d')
  }
  if (!scratch || !scratchCtx) return

  if (scratch.width !== image.width || scratch.height !== image.height) {
    scratch.width = image.width
    scratch.height = image.height
  }

  scratchCtx.putImageData(
    new ImageData(data.subarray(0, image.width * image.height * 4), image.width, image.height),
    0,
    0,
  )

  // The buffer is only ever scaled up by about half again, and holds nothing
  // but smooth gradients, so bilinear resampling is indistinguishable from the
  // expensive filter here - and this is now done twice a frame. On a software
  // rasteriser the high quality setting costs several times as much.
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'low'
  ctx.drawImage(scratch, 0, 0, image.width, image.height, image.x, image.y, image.w, image.h)
}
