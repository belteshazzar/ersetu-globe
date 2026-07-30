/**
 * Example orbits, using roughly real elements. Nothing else depends on this
 * file - replace it with your own constellation.
 */
import { orbit } from './orbits'

/**
 * Simulated seconds per real second. Orbital periods are in the thousands of
 * seconds, so real time would be far too slow to watch; at 400x the low orbits
 * come round about every fifteen seconds.
 */
export const DEMO_TIME_SCALE = 400

export const DEMO_ORBITS = [
  // Low Earth orbit, at the inclination the ISS flies.
  orbit(
    {
      altitudeKm: 420,
      inclination: 51.6,
      ascendingNode: 10,
      periodSeconds: 5580,
    },
    { color: 'rgba(150, 220, 255, 0.5)', width: 1 },
    { color: 'rgba(200, 240, 255, 1)', size: 3.2, trail: 40 },
  ),

  // A near-polar orbit, of the kind Earth-observation satellites use.
  orbit(
    {
      altitudeKm: 700,
      inclination: 98.2,
      ascendingNode: 120,
      periodSeconds: 5900,
      phase: 120,
    },
    { color: 'rgba(120, 255, 214, 0.45)', width: 1 },
    { color: 'rgba(170, 255, 228, 1)', size: 2.8, trail: 36 },
  ),

  // Medium orbit, around where navigation constellations sit. The wider ring
  // shows how far out it is compared to the two above.
  orbit(
    {
      altitudeKm: 20200,
      inclination: 55,
      ascendingNode: 250,
      periodSeconds: 43080,
      phase: 200,
    },
    { color: 'rgba(255, 214, 122, 0.4)', width: 1, dash: [6, 6] },
    { color: 'rgba(255, 226, 160, 1)', size: 3, trail: 24 },
  ),
] as const
