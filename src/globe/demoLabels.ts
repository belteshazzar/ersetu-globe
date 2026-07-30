/**
 * Example labels: cities on the surface, a platform standing above it, and
 * text riding each demo satellite. Nothing else depends on this file - swap the
 * contents for your own labels, or drop it and pass your own array to
 * renderGlobe.
 */
import { label, labelAbove, labelOn, type LabelStyle } from './labels'
import { angleAt, positionAtAngle, type Orbit } from './orbits'
import type { LonLat } from './shapes'
import { DEMO_ORBITS } from './demoOrbits'

const CITIES: readonly (readonly [string, LonLat])[] = [
  ['London', [-0.13, 51.51]],
  ['New York', [-74.01, 40.71]],
  ['Tokyo', [139.69, 35.69]],
  ['Sydney', [151.21, -33.87]],
  ['Cape Town', [18.42, -33.93]],
  ['Santiago', [-70.67, -33.46]],
  ['Nairobi', [36.82, -1.29]],
  ['Singapore', [103.82, 1.35]],
]

const CITY: LabelStyle = {
  color: 'rgba(226, 238, 255, 0.92)',
  size: 12,
  gap: 7,
  dot: 2.4,
}

const PLATFORM: LabelStyle = {
  color: 'rgba(255, 138, 190, 0.95)',
  size: 11,
  weight: 600,
  leader: true,
  gap: 8,
}

/** Satellite labels take their colour from the marker they ride. */
function satellite(color: string): LabelStyle {
  return { color, size: 11, weight: 600, gap: 9, placement: 'right' }
}

/**
 * Latitude of the satellite below its orbit, as a compass reading. Shows a
 * label whose text is a function of the clock rather than a fixed string.
 */
const point = { x: 0, y: 0, z: 0 }

function subLatitude(orbit: Orbit, timeSeconds: number) {
  const { elements } = orbit
  positionAtAngle(elements, angleAt(elements, timeSeconds), point)
  const length = Math.hypot(point.x, point.y, point.z)
  const degrees = (Math.asin(point.y / length) * 180) / Math.PI
  return `${Math.abs(degrees).toFixed(0)}°${degrees >= 0 ? 'N' : 'S'}`
}

export const DEMO_LABELS = [
  // Satellites first: they move, so they should not be the ones dropped when
  // they pass over a city name.
  labelOn('ISS-like', DEMO_ORBITS[0], satellite('rgba(200, 240, 255, 1)')),
  labelOn('Sun-sync', DEMO_ORBITS[1], satellite('rgba(170, 255, 228, 1)')),
  labelOn(
    (time) => `Nav-1  ${subLatitude(DEMO_ORBITS[2], time)}`,
    DEMO_ORBITS[2],
    satellite('rgba(255, 226, 160, 1)'),
  ),

  // Fixed above the surface, tethered to the ground point below it.
  labelAbove('Polar relay  1500 km', [12, 78], 1500, PLATFORM),

  ...CITIES.map(([name, at]) => label(name, at, CITY)),
] as const
