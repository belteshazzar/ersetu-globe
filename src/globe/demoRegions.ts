/**
 * Example regions, tweened between two states by a keyframe track. Nothing else
 * depends on this file - replace it with your own areas.
 *
 * Deliberately abstract shapes over open ocean rather than real borders. The
 * mechanism they demonstrate is the same either way, and a plausible-looking
 * boundary drawn across real land reads as a claim about it, which no demo
 * should be making - least of all one whose whole subject is territory
 * changing hands.
 *
 * Between the two states, three things happen at once, which are the three
 * things a border animation has to survive:
 *
 *   the shared edge moves, so one area grows and its neighbour gives way;
 *   an enclave inside the northern area closes up and disappears;
 *   a new exclave separates off to the east.
 *
 * The first is ordinary interpolation. The other two are changes of topology,
 * where one state simply has a ring the other does not, and they are handled by
 * pairing what can be paired and letting the rest grow from, or shrink to, its
 * own centre.
 */
import { morph, morphAt } from './morph'
import { regionOf, type Region } from './regions'
import { sample, smoothstep, track } from './track'

/** A lon/lat box as a closed ring, which is all these shapes need. */
const box = (west: number, east: number, south: number, north: number) => [
  west, north, east, north, east, south, west, south, west, north,
]

/** Before: a northern area with an enclave, and a southern neighbour. */
const NORTH_BEFORE = [[box(-36, -12, -19, -4), box(-30, -19, -15, -8)]]
const SOUTH_BEFORE = [[box(-36, -12, -31, -19)]]

/** After: the enclave gone, the border pushed south, an exclave to the east. */
const NORTH_AFTER = [[box(-36, -12, -26, -4)], [box(-9, -3, -14, -8)]]
const SOUTH_AFTER = [[box(-36, -12, -31, -26)]]

const NORTH = morph(NORTH_BEFORE, NORTH_AFTER)
const SOUTH = morph(SOUTH_BEFORE, SOUTH_AFTER)

/**
 * How far through the change we are, as a number the morphs can take directly.
 *
 * Six seconds across and twelve to a cycle, so the second half is the closing
 * segment travelling back - the border returns the way it came rather than
 * snapping. Eased, because this is a shape and a shape that eases reads as a
 * deliberate transition; a measurement that eased would just be wrong between
 * keyframes.
 */
const PHASE = track<number>(
  [
    { at: 0, value: 0 },
    { at: 6, value: 1 },
  ],
  { loop: true, duration: 12, ease: smoothstep },
)

// Built once around the morphs' own buffers. Animating rewrites those buffers
// in place, so nothing here is rebuilt and a frame allocates nothing.
const regions: readonly Region[] = [
  regionOf(NORTH.mesh, {
    fill: 'rgba(240, 180, 90, 0.28)',
    stroke: 'rgba(250, 205, 140, 0.85)',
    width: 1.5,
  }),
  regionOf(SOUTH.mesh, {
    fill: 'rgba(90, 210, 200, 0.24)',
    stroke: 'rgba(150, 235, 225, 0.8)',
    width: 1.5,
  }),
]

/** The regions as they stand at a moment, in seconds. */
export function demoRegionsAt(seconds: number): readonly Region[] {
  const span = sample(PHASE, seconds)
  if (span) {
    const t = span.a + (span.b - span.a) * span.mix
    morphAt(NORTH, t)
    morphAt(SOUTH, t)
  }
  return regions
}
