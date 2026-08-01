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
import { prefetchResident, pump, tick as tickTerrain } from './tiles'
import type { Shape } from './shapes'
import { drawOrbits, type Orbit } from './orbits'
import { drawLabels, type Label } from './labels'
import { drawModels, type ModelPlacement } from './models'

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

  // The surface goes to the GPU, on its own canvas behind this one. It is a
  // static mesh, so this culls, draws, and - for the first second of a session
  // - fills in whatever chunks the frame's budget allows.
  drawSurface(camera, viewport, state.exaggeration)

  // The shipped levels are held in full, everywhere, which is exactly what the
  // mesh is built to match.
  prefetchResident()
  pump()

  const mesh = meshStats()
  // Held back until the whole mesh is up rather than as the first chunk lands:
  // the fallback disc is drawn on this canvas, which sits over the GPU one, so
  // the two cannot share the frame - it is all of one or all of the other.
  const terrain = mesh.built === mesh.chunks
  if (terrain) {
    actions.setMeshTriangles(mesh.triangles)
    actions.setDetail(Math.max(0, mesh.detail))
  } else {
    // Nothing has arrived yet: a plain disc, with the land filled from the
    // coastline geometry so the continents are there from the first frame.
    paintSphere(ctx, camera)
    ctx.fillStyle = FLAT_LAND_CSS
    fillPolygons(ctx, landfill, camera)
  }

  ctx.lineWidth = 1.25
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

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
  // mountain standing past it.
  if (!terrain) {
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
