/**
 * Example models: a station and a satellite riding two of the demo orbits, and
 * a tower and a car standing on the ground. Nothing else depends on this file.
 *
 * The models are fetched rather than bundled, so the globe is drawn long
 * before any of them arrive and simply gains them when they do.
 */
import {
  loadModel,
  placeInOrbit,
  placeOnSurface,
  type ModelPlacement,
} from './models'
import { DEMO_ORBITS, DEMO_TIME_SCALE } from './demoOrbits'
import stationUrl from './data/models/station.json?url'
import satelliteUrl from './data/models/satellite.json?url'
import buildingUrl from './data/models/building.json?url'
import carUrl from './data/models/car.json?url'

const NEW_YORK: [number, number] = [-74.01, 40.71]
const SALAR_DE_UYUNI: [number, number] = [-67.5, -20.4]

/**
 * A spin written in degrees per second you can actually count.
 *
 * `spin` is applied against the scene clock, which runs at `DEMO_TIME_SCALE` so
 * that the orbits are worth watching - and a spin left in those units is that
 * many times faster than it looks on the page. Written straight, `spin: 8` is
 * three thousand degrees a second: nine turns before you have finished reading
 * the number.
 */
const perSecond = (degrees: number) => degrees / DEMO_TIME_SCALE

/**
 * Fetch the models and place them. Resolves to an empty list rather than
 * rejecting if any of them fails: a missing model is worth a warning, not a
 * globe that will not draw.
 */
export async function loadDemoModels(): Promise<ModelPlacement[]> {
  const [station, satellite, building, car] = await Promise.all([
    loadModel(stationUrl),
    loadModel(satelliteUrl),
    loadModel(buildingUrl),
    loadModel(carUrl),
  ])

  // Sizes are in globe radii and nothing like true scale - a real tower is a
  // ten-millionth of the Earth's radius and would never reach a pixel. These
  // are chosen to be seen, exactly as the terrain is exaggerated to be seen.
  //
  // Anything standing on the ground is only seen side on near the limb, since
  // an orthographic globe looks straight down at whatever is in the middle of
  // the disc. That is worth a little extra size.
  return [
    // Riding the low orbit, turning slowly to keep its wings to the sun: one
    // turn in forty seconds, which is a drift rather than a spin.
    placeInOrbit(station, DEMO_ORBITS[0], { size: 0.07, spin: perSecond(9) }),
    placeInOrbit(satellite, DEMO_ORBITS[1], { size: 0.05, spin: perSecond(-14) }),

    // Standing on the ground, which means standing on the displaced terrain:
    // both rise and fall with the relief slider.
    placeOnSurface(building, NEW_YORK, { size: 0.05 }),
    placeOnSurface(car, SALAR_DE_UYUNI, {
      size: 0.035,
      heading: 60,
      spin: perSecond(18),
    }),
  ]
}
