/**
 * An example overlay: a synthetic surface temperature over a regional domain.
 * Nothing else depends on this file - replace it with a real forecast.
 *
 * Synthetic on purpose. Real weather would have to be fetched, would be stale
 * the moment it shipped, and - drawn as confidently as this - would be believed
 * by someone. A field generated from a formula is obviously a demonstration of
 * the machinery rather than a claim about the weather, and it exercises exactly
 * the same path.
 *
 * Regional on purpose too, and this is the more useful half of the example. A
 * forecast comes off a model with a domain and a radar sees as far as it sees,
 * so a weather layer is nearly always a box rather than a globe. Outside the
 * box the field says nothing and the ground shows through untouched - which is
 * a different statement from saying zero, and has to be, or the domain would
 * announce itself as a rectangle of whatever colour zero happened to be.
 */
import { field, palette, type Bounds, type Overlay } from './overlay'
import { sample, track } from './track'

/** Western Europe and the near Atlantic, which is a plausible model domain. */
const DOMAIN: Bounds = { west: -22, east: 34, south: 30, north: 64 }

/** Degrees the byte scale spans, cold end first. */
const RANGE = [-15, 35] as const

/**
 * A temperature ramp. Deep blue through to red, and deliberately a little
 * transparent at the middle so ordinary conditions leave the ground showing and
 * the extremes are what catch the eye.
 */
const TEMPERATURE = palette([
  { at: 0.0, color: [40, 60, 160], alpha: 0.9 },
  { at: 0.25, color: [70, 160, 220], alpha: 0.7 },
  { at: 0.45, color: [120, 210, 190], alpha: 0.4 },
  { at: 0.55, color: [220, 220, 140], alpha: 0.4 },
  { at: 0.75, color: [235, 150, 70], alpha: 0.7 },
  { at: 1.0, color: [200, 50, 45], alpha: 0.9 },
])

/**
 * A quarter of a degree a sample across the domain. Both sides are powers of
 * two, which costs nothing here and is what a global field would need.
 */
const WIDTH = 256
const HEIGHT = 128

/**
 * How many frames the sequence holds, and how long each is on screen.
 *
 * Every frame is a whole grid, so this is the memory: eight of these is a
 * quarter of a megabyte, uploaded once each and then cycled for nothing.
 */
const FRAMES = 8
const SECONDS_PER_FRAME = 2

/**
 * One frame of the forecast, at a phase through the cycle.
 *
 * Everything that moves is driven by `phase`, and every term is periodic in it,
 * so the eighth frame leads back into the first and the loop has no seam.
 */
function frame(phase: number) {
  const front = phase * 2 * Math.PI

  return field(
    WIDTH,
    HEIGHT,
    RANGE,
    (longitude, latitude) => {
      // Warmer towards the south, which over this domain is most of the story.
      const solar = 26 - 34 * (latitude - 0.52)

      // A front lying north-east to south-west with cold air behind it, sweeping
      // eastward across the domain and round again.
      const across = latitude * 1.6 - longitude * 0.5 - 0.55 + Math.sin(front) * 0.7
      const sweep = -9 * Math.tanh(across * 4)

      // Weather riding along with it, so the pattern is not simply translated.
      const eddies =
        3 * Math.sin(longitude * 6 + latitude * 3 - front) +
        2 * Math.sin(latitude * 7 - longitude * 2 + front * 2)

      // The sea holds its temperature and the interior does not, so the west
      // stays mild while the continent swings through the cycle. A stand-in for
      // maritime influence, not a calculation of it.
      const maritime = 4 * Math.exp(-Math.pow((longitude + 0.15) * 2.2, 2))
      const inland = 5 * Math.sin(front) * (1 - Math.exp(-Math.pow((longitude + 0.15) * 2.2, 2)))

      return solar + sweep + eddies + maritime + inland
    },
    DOMAIN,
  )
}

/**
 * The forecast as a track over its frames.
 *
 * `duration` is the whole cycle including the step from the last frame back to
 * the first, which is a step like any other - the field is periodic, so that
 * closing leg is the one that would otherwise be missing rather than a jump.
 *
 * Not eased. Easing a shape reads as deliberate; easing a measurement means
 * reporting a temperature that was never forecast, and the whole point of
 * carrying the field rather than a picture of it is that the moments between
 * two frames mean something.
 */
const FORECAST = track(
  Array.from({ length: FRAMES }, (_, i) => ({
    at: i * SECONDS_PER_FRAME,
    value: frame(i / FRAMES),
  })),
  { loop: true, duration: FRAMES * SECONDS_PER_FRAME },
)

/** The overlay as it stands at a moment, in seconds. */
export function demoOverlayAt(seconds: number): Overlay | undefined {
  const span = sample(FORECAST, seconds)
  if (!span) return undefined
  return {
    field: span.a,
    next: span.b,
    mix: span.mix,
    palette: TEMPERATURE,
    opacity: 0.75,
  }
}
