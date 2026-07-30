/**
 * Text labels pinned to the globe.
 *
 * A label is some text plus an anchor: a function that says where the label is
 * attached, in globe radii, at a given time. A place on the surface, a platform
 * standing off it and a satellite running along its orbit differ only in that
 * function, so a label that follows a moving entity costs no more per frame
 * than one nailed to a coastline - the anchor is evaluated, projected, and the
 * text is drawn beside it.
 *
 * Labels are hidden by the same occlusion test the orbits use rather than the
 * hemisphere test the surface geometry uses. That matters for anything standing
 * off the surface: a high satellite spends much of its orbit behind the centre
 * plane and is still plainly in view, because it passes wide of the globe.
 *
 * Text is the one thing on this canvas that cannot be allowed to overlap - two
 * crossed strokes still read, two crossed words do not - so labels claim a
 * screen rectangle as they are drawn and later ones that would collide are
 * dropped. Array order is the priority: put the labels that matter most first.
 */
import {
  projectSpace,
  spacePoint,
  type Camera,
  type SpacePoint,
} from './projection'
import {
  EARTH_RADIUS_KM,
  angleAt,
  positionAtAngle,
  type Orbit,
  type OrbitElements,
} from './orbits'
import { toUnit, type LonLat } from './shapes'

/** A position in globe radii, where 1 is the surface. */
export type Vec3 = { x: number; y: number; z: number }

/**
 * Where a label is attached at a given time. Writes into `out` rather than
 * returning a fresh object, so animating a label allocates nothing.
 */
export type LabelAnchor = (timeSeconds: number, out: Vec3) => void

/** Which side of the anchor the text sits on. */
export type LabelPlacement = 'right' | 'left' | 'above' | 'below' | 'centre'

export type LabelStyle = {
  color?: string
  /** Font size in CSS pixels. */
  size?: number
  weight?: string | number
  family?: string
  /** Full CSS font shorthand. Wins over size, weight and family. */
  font?: string
  /** Which side of the anchor the text sits on. Default 'right'. */
  placement?: LabelPlacement
  /** Space between the anchor and the text, in CSS pixels. */
  gap?: number
  /** Further shift of the text, in CSS pixels, applied after placement. */
  offset?: readonly [number, number]
  /** Marker radius at the anchor, in CSS pixels. Zero for none. */
  dot?: number
  /** Draw a line from the anchor to the text. */
  leader?: boolean
  /** Outline behind the glyphs, so text stays legible over any background. */
  halo?: string | false
  haloWidth?: number
  /**
   * Draw a line from the surface up to the anchor. Only meaningful for anchors
   * that stand off the surface; it shows what the label is above.
   */
  stem?: boolean
  /** Dim the label as its anchor turns towards the far side. Default true. */
  fade?: boolean
  /**
   * Whether this label may be dropped when it collides with one already drawn.
   * Default true. A label with this off is always drawn, and still reserves its
   * rectangle against the labels that follow it.
   */
  declutter?: boolean
}

export type Label = {
  /** Fixed text, or a function of the clock for a live readout. */
  text: string | ((timeSeconds: number) => string)
  anchor: LabelAnchor
  style: LabelStyle
  /** Resolved CSS font shorthand, built once at bake time. */
  font: string
}

const DEFAULT_COLOR = 'rgba(226, 238, 255, 0.92)'
const DEFAULT_HALO = 'rgba(4, 10, 20, 0.8)'
const DEFAULT_FAMILY =
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
const DEFAULT_SIZE = 12
const NO_OFFSET: readonly [number, number] = [0, 0]
const TAU = Math.PI * 2

function bake(
  text: Label['text'],
  anchor: LabelAnchor,
  style: LabelStyle,
): Label {
  const font =
    style.font ??
    `${style.weight ?? 500} ${style.size ?? DEFAULT_SIZE}px ${style.family ?? DEFAULT_FAMILY}`
  return { text, anchor, style, font }
}

/** A label pinned to a place on the surface. */
export function label(
  text: Label['text'],
  at: LonLat,
  style: LabelStyle = {},
): Label {
  const [x, y, z] = toUnit(at)
  return bake(
    text,
    (_time, out) => {
      out.x = x
      out.y = y
      out.z = z
    },
    { dot: 2.5, ...style },
  )
}

/**
 * A label pinned to a fixed point above the surface - a platform, a beacon, a
 * parked satellite. By default it is tethered to the ground point below it, so
 * it is clear what the altitude is measured from.
 */
export function labelAbove(
  text: Label['text'],
  at: LonLat,
  altitudeKm: number,
  style: LabelStyle = {},
): Label {
  const radius = 1 + altitudeKm / EARTH_RADIUS_KM
  const [x, y, z] = toUnit(at)
  return bake(
    text,
    (_time, out) => {
      out.x = x * radius
      out.y = y * radius
      out.z = z * radius
    },
    { dot: 2.5, stem: true, ...style },
  )
}

/**
 * A label that rides a satellite, staying with it as it goes round. Takes
 * either a baked orbit or bare elements, so it can be attached to an orbit you
 * are already drawing or to one you are not.
 */
export function labelOn(
  text: Label['text'],
  orbit: Orbit | OrbitElements,
  style: LabelStyle = {},
): Label {
  const elements = 'elements' in orbit ? orbit.elements : orbit
  return bake(
    text,
    (time, out) => positionAtAngle(elements, angleAt(elements, time), out),
    style,
  )
}

/**
 * A label following anything else that moves: an aircraft, a ship, a vehicle
 * whose track you are streaming in. The anchor is free to resolve the position
 * however it likes, in globe radii, and `onSurface` converts a lon/lat feed for
 * the common case.
 */
export function labelTracking(
  text: Label['text'],
  anchor: LabelAnchor,
  style: LabelStyle = {},
): Label {
  return bake(text, anchor, style)
}

/**
 * Turn a lon/lat (and optional altitude) feed into an anchor, for use with
 * `labelTracking`. The callback is asked for the position each frame.
 */
export function onSurface(
  position: (timeSeconds: number) => {
    longitude: number
    latitude: number
    altitudeKm?: number
  },
): LabelAnchor {
  return (time, out) => {
    const { longitude, latitude, altitudeKm = 0 } = position(time)
    const [x, y, z] = toUnit([longitude, latitude])
    const radius = 1 + altitudeKm / EARTH_RADIUS_KM
    out.x = x * radius
    out.y = y * radius
    out.z = z * radius
  }
}

// Scratch, reused every frame.
const here: Vec3 = { x: 0, y: 0, z: 0 }
const anchorPoint = spacePoint()
const footPoint = spacePoint()

// Rectangles already taken this frame, four numbers each: left, top, right,
// bottom. A Float32Array so that decluttering allocates nothing either.
let boxes = new Float32Array(64 * 4)
let boxCount = 0

/** Breathing room around each rectangle, so labels never quite touch. */
const BOX_PADDING = 2

/**
 * Draw the labels at the given time. Call this last: labels are the top layer,
 * and the collision test only knows about other labels.
 */
export function drawLabels(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  labels: readonly Label[],
  timeSeconds: number,
) {
  boxCount = 0

  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.setLineDash([])

  for (const item of labels) drawLabel(ctx, camera, item, timeSeconds)

  ctx.globalAlpha = 1
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  item: Label,
  timeSeconds: number,
) {
  const { style } = item

  item.anchor(timeSeconds, here)
  projectSpace(camera, here.x, here.y, here.z, anchorPoint)
  if (!anchorPoint.visible) return

  const alpha = style.fade === false ? 1 : limbFade(anchorPoint)
  if (alpha < 0.02) return

  const text = typeof item.text === 'function' ? item.text(timeSeconds) : item.text
  if (!text) return

  ctx.font = item.font
  const size = style.size ?? DEFAULT_SIZE
  const width = ctx.measureText(text).width
  const height = size * 1.2

  const placement = style.placement ?? 'right'
  const gap = style.gap ?? 10
  const [shiftX, shiftY] = style.offset ?? NO_OFFSET

  // Text box, plus the point on it that a leader line should meet.
  let left = 0
  let middle = 0
  let attachX = 0
  let attachY = 0

  switch (placement) {
    case 'left':
      left = anchorPoint.x - gap - width
      middle = anchorPoint.y
      attachX = left + width
      attachY = middle
      break
    case 'above':
      left = anchorPoint.x - width / 2
      middle = anchorPoint.y - gap - height / 2
      attachX = anchorPoint.x
      attachY = middle + height / 2
      break
    case 'below':
      left = anchorPoint.x - width / 2
      middle = anchorPoint.y + gap + height / 2
      attachX = anchorPoint.x
      attachY = middle - height / 2
      break
    case 'centre':
      left = anchorPoint.x - width / 2
      middle = anchorPoint.y
      attachX = anchorPoint.x
      attachY = anchorPoint.y
      break
    default:
      left = anchorPoint.x + gap
      middle = anchorPoint.y
      attachX = left
      attachY = middle
  }

  left += shiftX
  middle += shiftY
  attachX += shiftX
  attachY += shiftY

  const boxLeft = left - BOX_PADDING
  const boxTop = middle - height / 2 - BOX_PADDING
  const boxRight = left + width + BOX_PADDING
  const boxBottom = middle + height / 2 + BOX_PADDING

  const clear = !collides(boxLeft, boxTop, boxRight, boxBottom)
  if (!clear && style.declutter !== false) return
  claim(boxLeft, boxTop, boxRight, boxBottom)

  const color = style.color ?? DEFAULT_COLOR
  ctx.globalAlpha = alpha

  // Tether down to the ground point, for anchors standing off the surface.
  // Drawn only when both ends are in view: the line is short next to the globe,
  // so cutting it at the silhouette would cost more than it is worth.
  if (style.stem) {
    const length = Math.hypot(here.x, here.y, here.z)
    if (length > 1.0005) {
      projectSpace(
        camera,
        here.x / length,
        here.y / length,
        here.z / length,
        footPoint,
      )
      if (footPoint.visible) {
        ctx.globalAlpha = alpha * 0.4
        ctx.strokeStyle = color
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(footPoint.x, footPoint.y)
        ctx.lineTo(anchorPoint.x, anchorPoint.y)
        ctx.stroke()

        ctx.globalAlpha = alpha * 0.7
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(footPoint.x, footPoint.y, 1.5, 0, TAU)
        ctx.fill()
      }
    }
  }

  if (style.leader && placement !== 'centre') {
    ctx.globalAlpha = alpha * 0.45
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(anchorPoint.x, anchorPoint.y)
    ctx.lineTo(attachX, attachY)
    ctx.stroke()
  }

  ctx.globalAlpha = alpha

  const dot = style.dot ?? 0
  if (dot > 0) {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(anchorPoint.x, anchorPoint.y, dot, 0, TAU)
    ctx.fill()
  }

  // The halo is stroked under the glyphs, half its width falling outside them,
  // which is what lifts the text off the coastlines behind it.
  const halo = style.halo ?? DEFAULT_HALO
  if (halo) {
    ctx.strokeStyle = halo
    ctx.lineWidth = style.haloWidth ?? 3
    ctx.strokeText(text, left, middle)
  }

  ctx.fillStyle = color
  ctx.fillText(text, left, middle)
}

/**
 * How far into the limb a label fades out, in globe radii of depth. Without it
 * labels would blink on and off as the globe turns.
 */
const FADE_BAND = 0.12

/**
 * Dim a label as its anchor turns towards the far side. Only anchors inside
 * the silhouette can be swallowed by the globe, so one passing wide of it -
 * a high satellite seen past the edge - never fades.
 */
function limbFade(point: SpacePoint) {
  if (point.offset >= 1 || point.depth >= FADE_BAND) return 1
  return Math.max(0, point.depth / FADE_BAND)
}

function collides(left: number, top: number, right: number, bottom: number) {
  for (let i = 0; i < boxCount; i++) {
    const j = i * 4
    if (
      left < boxes[j + 2] &&
      right > boxes[j] &&
      top < boxes[j + 3] &&
      bottom > boxes[j + 1]
    ) {
      return true
    }
  }
  return false
}

function claim(left: number, top: number, right: number, bottom: number) {
  if ((boxCount + 1) * 4 > boxes.length) {
    const grown = new Float32Array(boxes.length * 2)
    grown.set(boxes)
    boxes = grown
  }
  const j = boxCount * 4
  boxes[j] = left
  boxes[j + 1] = top
  boxes[j + 2] = right
  boxes[j + 3] = bottom
  boxCount++
}
