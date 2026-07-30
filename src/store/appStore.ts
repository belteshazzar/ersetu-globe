import { useSyncExternalStore } from 'react'
import { createStore } from './createStore'

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
