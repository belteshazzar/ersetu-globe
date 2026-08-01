import { actions, type AppState } from '../store/appStore'
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
import { paintSphere, FLAT_LAND_CSS } from './surface'
import { drawSurface, meshStats } from './mesh'
import { setOverlay } from './gl'
import type { Overlay } from './overlay'
import { prefetchResident, pump, tick as tickTerrain } from './tiles'
import type { Shape } from './shapes'
import type { Region } from './regions'
import { drawOrbits, type Orbit } from './orbits'
import { drawLabels, type Label } from './labels'
import { drawModels, type ModelPlacement } from './models'

/** Everything drawn on top of the globe itself. */
export type Scene = {
  /**
   * A scalar field painted over the whole surface - weather, most likely.
   * Drawn by the surface shader itself, so it is occluded by the horizon and
   * follows the displaced ground exactly as the terrain does.
   */
  overlay?: Overlay
  /**
   * Filled areas lying on the surface, drawn beneath every line in the scene.
   * Fills are ground and lines are annotation, so the lines stay legible over
   * them rather than the other way about.
   */
  regions?: readonly Region[]
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
   * Small 3D models standing on the surface or flying above it. Loaded
   * asynchronously, so this is simply empty until they arrive.
   */
  models?: readonly ModelPlacement[]
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

/** How long the bare sphere takes to dissolve into the meshed one, in seconds. */
const HANDOVER_SECONDS = 0.6

/**
 * When the mesh first became whole, on the store's clock, or negative until it
 * did. Held here rather than in the store because nothing outside this file has
 * any use for it: it is a property of the picture, not of the application.
 */
let handoverAt = -1

/**
 * Latched once the dissolve has finished, because Reset puts the store's clock
 * back to zero: without this, resetting an hour into a session would find the
 * elapsed time behind the handover again and bring the loading sphere back for
 * an hour. The terrain is still there; there is nothing to load.
 */
let handedOver = false

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value)

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

  tickTerrain()
  // Costs two identity comparisons when nothing has changed, which is why it
  // can sit in the frame rather than behind a caller having to remember.
  setOverlay(scene.overlay ?? null)

  // The surface goes to the GPU, on its own canvas behind this one. It is a
  // static mesh, so this culls, draws, and - for the first second of a session
  // - fills in whatever chunks the frame's budget allows.
  drawSurface(camera, viewport, state.exaggeration)

  const mesh = meshStats()
  // The whole mesh has to exist before it can be shown, because the fallback
  // disc is drawn on this canvas, which sits over the GPU one - the two cannot
  // share a frame, so it is all of one or all of the other.
  const whole = mesh.built === mesh.chunks

  // One rung at a time: the next level is only worth fetching once the mesh has
  // finished with the one below it. Before that the ladder stays where it is,
  // and the coarse globe is on screen while the finer tiles are still in the
  // air rather than after them.
  prefetchResident(whole ? mesh.detail + 1 : 0)
  pump()

  if (whole) {
    actions.setMeshTriangles(mesh.triangles)
    actions.setDetail(Math.max(0, mesh.detail))
    if (handoverAt < 0) handoverAt = state.elapsed
  }

  // Dissolved rather than cut. The two are painted to match, so a short fade
  // reads as the sphere gaining its ground rather than as one picture being
  // swapped for another.
  let cover = 0
  if (!handedOver) {
    cover =
      handoverAt < 0
        ? 1
        : 1 - clamp01((state.elapsed - handoverAt) / HANDOVER_SECONDS)
    if (cover <= 0) handedOver = true
  }
  if (cover > 0) {
    // A plain disc, with the land filled from the coastline geometry so the
    // continents are there from the first frame.
    ctx.globalAlpha = cover
    paintSphere(ctx, camera)
    ctx.fillStyle = FLAT_LAND_CSS
    fillPolygons(ctx, landfill, camera)
    ctx.globalAlpha = 1
  }

  ctx.lineWidth = 1.25
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  // Areas first, under every line: a fill is ground, and the graticule and
  // coastlines drawn over it stay legible rather than being buried by it.
  for (const item of scene.regions ?? []) {
    if (item.style.fill) {
      ctx.fillStyle = item.style.fill
      fillPolygons(ctx, item.polygons, camera)
    }
    if (item.style.stroke) {
      ctx.strokeStyle = item.style.stroke
      ctx.lineWidth = item.style.width ?? 1.25
      strokeMesh(ctx, item.outline, camera)
    }
  }
  ctx.lineWidth = 1.25

  ctx.strokeStyle = GRATICULE
  strokeMesh(ctx, graticule, camera)

  // The land outlines, from the coastline dataset rather than from the terrain.
  // The two do not quite agree - the elevation puts the waterline where its own
  // samples say - so being able to drop these is being able to see the ground
  // on its own terms.
  if (state.outlines) {
    ctx.strokeStyle = COAST
    strokeMesh(ctx, coastlines, camera)
  }

  // Sphere silhouette, over the shaded limb. Displaced terrain has a
  // silhouette of its own - that is rather the point of displacing it - and a
  // perfect circle drawn over the top would saw straight through every
  // mountain standing past it, so it fades out with the disc it belongs to.
  if (cover > 0) {
    ctx.globalAlpha = cover
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.strokeStyle = LIMB
    ctx.stroke()
    ctx.globalAlpha = 1
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

  // Models after the orbits, so a satellite's own path passes behind it, but
  // before the labels, which name them.
  if (scene.models?.length) {
    drawModels(ctx, camera, scene.models, scene.time ?? 0, {
      exaggeration: state.exaggeration,
    })
  }

  // Text on top of everything: it is the one layer that cannot be read through
  // whatever is drawn over it.
  if (scene.labels?.length) {
    drawLabels(ctx, camera, scene.labels, scene.time ?? 0)
  }
}
