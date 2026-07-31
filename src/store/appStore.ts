import { useSyncExternalStore } from 'react'
import { createStore } from './createStore'

export type SurfaceStyle = 'metal' | 'flat'

/**
 * Where the globe's geometry comes from.
 *
 * `uniform` is the fixed lon/lat mesh built once from the elevation; `quadtree`
 * refines an octahedron per frame against the camera, so detail follows the
 * zoom instead of being decided when the data landed.
 */
export type MeshMode = 'uniform' | 'quadtree'

/** Camera/orientation state for the globe, plus general app state. */
export type AppState = {
  /** Rotation about the polar axis, radians. */
  longitude: number
  /** Camera tilt above the equator, radians, clamped to +/- PI/2. */
  latitude: number
  /** Distance multiplier from the globe centre. 1 = fits the viewport. */
  zoom: number
  /** Whether the idle spin animation is running. */
  autoRotate: boolean
  /**
   * How the surface is coloured. `metal` reflects an environment gradient and
   * ramps the land by height; `flat` is one colour for land and one for sea,
   * left to the lighting to give them shape.
   */
  surface: SurfaceStyle
  /** Where the globe's geometry comes from. */
  mesh: MeshMode
  /**
   * Triangles the last frame's geometry cost, rounded to the nearest hundred.
   *
   * Rounded in the action rather than the readout so that the HUD re-renders
   * when the figure visibly changes rather than on every frame, which is what
   * it would do if the exact count were held here.
   */
  meshTriangles: number
  /** Which level of the terrain pyramid the last frame shaded from. */
  detail: number
  /**
   * How far the terrain is displaced, as a multiple of true height.
   *
   * Relief is only 0.14% of the Earth's radius at its highest, so at 1 the
   * globe is indistinguishable from a sphere and at 0 it is exactly one. At 30
   * Everest stands about 4% of a radius proud of sea level, which is a dozen
   * pixels on the default globe.
   */
  exaggeration: number
  /** Frames rendered since mount, useful while bringing up the renderer. */
  frame: number
  /**
   * Seconds elapsed since mount. Driven by the clock rather than the frame
   * count, so animation runs at the same speed on any refresh rate.
   */
  elapsed: number
  /**
   * Where the pointer currently sits on the globe, in degrees, or null when
   * it is off the sphere. Held as two primitives rather than an object so
   * selectors can compare them with Object.is.
   */
  hoverLongitude: number | null
  hoverLatitude: number | null
}

const initialState: AppState = {
  longitude: 0,
  latitude: 0.35,
  zoom: 1,
  autoRotate: true,
  surface: 'flat',
  mesh: 'quadtree',
  meshTriangles: 0,
  detail: 0,
  exaggeration: 30,
  frame: 0,
  elapsed: 0,
  hoverLongitude: null,
  hoverLatitude: null,
}

/** The single application store. */
export const appStore = createStore<AppState>(initialState)

const HALF_PI = Math.PI / 2
const TAU = Math.PI * 2

/**
 * Past this the globe stops reading as a globe: the deepest trenches fold in
 * towards the centre and the silhouette turns to spikes.
 */
export const MAX_EXAGGERATION = 80

/**
 * All mutations live here so components never call setState directly.
 * Callable from outside React (e.g. the render loop) as well as inside it.
 */
export const actions = {
  rotateBy(dLongitude: number, dLatitude: number) {
    appStore.setState((prev) => ({
      longitude: (prev.longitude + dLongitude) % TAU,
      latitude: clamp(prev.latitude + dLatitude, -HALF_PI, HALF_PI),
    }))
  },
  setZoom(zoom: number) {
    appStore.setState({ zoom: clamp(zoom, 0.5, 8) })
  },
  zoomBy(factor: number) {
    actions.setZoom(appStore.getState().zoom * factor)
  },
  setAutoRotate(autoRotate: boolean) {
    appStore.setState({ autoRotate })
  },
  setSurface(surface: SurfaceStyle) {
    appStore.setState({ surface })
  },
  setMesh(mesh: MeshMode) {
    appStore.setState({ mesh })
  },
  /**
   * Report what the last frame's geometry cost. Called from the render loop, so
   * it rounds hard: an exact count would differ every frame and drag the HUD
   * through a re-render with it.
   */
  setMeshTriangles(triangles: number) {
    const rounded = Math.round(triangles / 100) * 100
    if (rounded !== appStore.getState().meshTriangles) {
      appStore.setState({ meshTriangles: rounded })
    }
  },
  setDetail(detail: number) {
    if (detail !== appStore.getState().detail) appStore.setState({ detail })
  },
  setExaggeration(exaggeration: number) {
    appStore.setState({ exaggeration: clamp(exaggeration, 0, MAX_EXAGGERATION) })
  },
  toggleAutoRotate() {
    actions.setAutoRotate(!appStore.getState().autoRotate)
  },
  tick(deltaSeconds: number) {
    appStore.setState((prev) => ({
      frame: prev.frame + 1,
      elapsed: prev.elapsed + deltaSeconds,
    }))
  },
  setHover(longitude: number | null, latitude: number | null) {
    appStore.setState({ hoverLongitude: longitude, hoverLatitude: latitude })
  },
  reset() {
    appStore.setState(initialState)
  },
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Subscribe a component to a slice of the store.
 * The selector result is compared with Object.is, so return primitives
 * or memo-stable values rather than fresh objects.
 */
export function useAppStore<T>(selector: (state: AppState) => T): T {
  return useSyncExternalStore(
    appStore.subscribe,
    () => selector(appStore.getState()),
    () => selector(appStore.getState()),
  )
}
