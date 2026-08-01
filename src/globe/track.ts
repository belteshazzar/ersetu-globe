/**
 * Keyframes and a cursor over them.
 *
 * Both of the things this globe wants to animate - a field of weather sampled
 * every few hours, a border as it stood in successive years - are a list of
 * states with times attached, and both need the same question answered every
 * frame: which two states straddle now, and how far between them are we. What
 * differs is only what gets interpolated afterwards, so that is left to the
 * caller and this holds nothing but the timing.
 *
 * `sample` returns the pair and the fraction; it never interpolates. A weather
 * field has to be mixed as data and then coloured, a polygon has to be mixed
 * per vertex on the sphere, and neither is something a clock should know about.
 *
 * The easing hook is there for the second case and a trap for the first. A
 * border that eases in and out reads as a deliberate transition; a temperature
 * that eases in and out is simply reporting the wrong temperature between
 * keyframes. Ease shapes, not measurements.
 */

export type Keyframe<T> = {
  /** When this state holds, in whatever unit the caller's clock uses. */
  at: number
  value: T
}

/** The two states straddling a moment, and how far between them it lies. */
export type Span<T> = {
  a: T
  b: T
  /** 0 at `a`, 1 at `b`, eased if the track asked for it. */
  mix: number
}

export type TrackOptions = {
  /**
   * Whether time wraps. A cycle runs from the first keyframe for `duration`,
   * so leaving room past the last keyframe gives the wrap somewhere to happen.
   */
  loop?: boolean
  /**
   * Length of one cycle. Defaults to the span the keyframes cover, which loops
   * by jumping straight from the last back to the first - seamless when the two
   * hold the same state, and a cut when they do not. Set it longer to get a
   * closing segment that travels back.
   */
  duration?: number
  /** Applied to the fraction, not to the time. */
  ease?: (t: number) => number
}

export type Track<T> = {
  frames: readonly Keyframe<T>[]
  loop: boolean
  duration: number
  ease: ((t: number) => number) | null
  /**
   * Where the last search finished. Time almost always creeps forward, so
   * starting from here turns the search into a comparison or two; it is only a
   * hint, and a caller that jumps about at random pays a short walk instead.
   */
  cursor: number
}

/**
 * Build a track. Keyframes are sorted by time, so they may be given in any
 * order, and the input is copied rather than kept.
 */
export function track<T>(
  frames: readonly Keyframe<T>[],
  options: TrackOptions = {},
): Track<T> {
  const sorted = [...frames].sort((a, b) => a.at - b.at)
  const covered =
    sorted.length > 1 ? sorted[sorted.length - 1].at - sorted[0].at : 0
  return {
    frames: sorted,
    loop: options.loop ?? false,
    // Shorter than the keyframes cover would strand the late ones outside every
    // cycle, so the span they occupy is the floor.
    duration: Math.max(options.duration ?? covered, covered),
    ease: options.ease ?? null,
    cursor: 0,
  }
}

/**
 * The two keyframes straddling `time`, and the fraction between them.
 *
 * Returns null only for an empty track. Outside the keyframes a track that does
 * not loop holds its first or last state rather than extrapolating: a border
 * before the earliest record is not known to have been moving.
 */
export function sample<T>(it: Track<T>, time: number): Span<T> | null {
  const frames = it.frames
  const n = frames.length
  if (n === 0) return null
  if (n === 1) return { a: frames[0].value, b: frames[0].value, mix: 0 }

  const start = frames[0].at
  const end = frames[n - 1].at
  let t = time

  if (it.loop && it.duration > 0) {
    t = start + wrap(time - start, it.duration)
    if (t >= end) {
      // The closing segment, from the last keyframe round to the first. It only
      // exists when the cycle is longer than the keyframes cover.
      const gap = start + it.duration - end
      const u = gap > 0 ? (t - end) / gap : 0
      return {
        a: frames[n - 1].value,
        b: frames[0].value,
        mix: eased(it, u),
      }
    }
  } else {
    if (t <= start) return { a: frames[0].value, b: frames[0].value, mix: 0 }
    if (t >= end) {
      return { a: frames[n - 1].value, b: frames[n - 1].value, mix: 0 }
    }
  }

  let i = it.cursor
  if (i > n - 2) i = n - 2
  if (i < 0) i = 0
  while (i > 0 && t < frames[i].at) i--
  while (i < n - 2 && t >= frames[i + 1].at) i++
  it.cursor = i

  const from = frames[i].at
  const to = frames[i + 1].at
  // Keyframes sharing a time are a step rather than a ramp, and dividing by the
  // gap between them would be a divide by zero.
  const u = to > from ? (t - from) / (to - from) : 0
  return { a: frames[i].value, b: frames[i + 1].value, mix: eased(it, u) }
}

function eased<T>(it: Track<T>, u: number): number {
  const clamped = u < 0 ? 0 : u > 1 ? 1 : u
  return it.ease ? it.ease(clamped) : clamped
}

/** Positive remainder, so time before the track's start still lands in a cycle. */
function wrap(value: number, period: number): number {
  const r = value % period
  return r < 0 ? r + period : r
}

/** Ease in and out. The usual choice for a shape that has to look deliberate. */
export function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}
