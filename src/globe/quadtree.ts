/**
 * PARKED. The globe's surface is a static mesh now - see `mesh.ts` - because a
 * vertex's direction and height never change and so neither does the buffer
 * holding them. Rebuilding the visible surface every frame could not reach the
 * detail the archive already holds: two hundred thousand triangles cost four
 * hundred milliseconds a frame in JavaScript, to feed a card that draws ten
 * times as many in one.
 *
 * Kept because the view-dependent walk is still the right shape for levels
 * *past* what is held resident - the deeper tiles a zoom would stream in, which
 * cannot be uniform because there is far too much of them. Nothing calls it
 * today: the archive stops at tile level 2, which is exactly what the static
 * mesh is built to.
 *
 * ---
 *
 * The globe as a view-dependent quadtree, rather than one fixed lon/lat mesh.
 *
 * A fixed lon/lat mesh - which is what this replaced - carries the same number
 * of triangles wherever you look: half of them are behind the globe, the ones
 * near the poles are crushed into slivers, and zooming in gains no detail at
 * all because the mesh was built once and cannot get any finer. This builds the
 * mesh per frame instead, refining only where the screen can show the
 * difference.
 *
 * The base is an octahedron - eight spherical triangles, corners at the poles
 * and at four points around the equator. A sphere has no seamless square
 * parameterisation, and the obvious alternative of a lon/lat grid is exactly
 * what we are trying to get away from: it wastes its resolution at the poles
 * and has a singularity there. An octahedron's faces are congruent, its corners
 * fall on the poles and the equator so latitude and longitude stay easy to
 * reason about, and each face subdivides into four by joining the midpoints of
 * its edges - a quadtree over triangles.
 *
 * There is no persistent tree. Selection walks the subdivision recursively each
 * frame and keeps nothing but the vertices, which are cached because their
 * geometry never changes: a vertex costs two trigonometric calls and an
 * elevation lookup the first time it is reached and nothing on any frame after.
 *
 * Three things decide how deep the walk goes.
 *
 * The projection is orthographic, so every visible point is equidistant from
 * the camera and distance cannot drive the refinement on its own - what varies
 * is how large a patch lands on screen. That is the metric: a node splits while
 * its longest edge still spans more than a few samples of the buffer being
 * shaded. Zoom enters through the camera's radius, and foreshortening near the
 * limb falls out for free, since a patch turned away from the viewer projects
 * short.
 *
 * A node is dropped when its bounding cap is entirely off the buffer, and again
 * when the cap is entirely on the far side of the globe. The surface is
 * star-shaped about the centre, so anything back there is hidden by the front.
 *
 * Neighbours may end up at different depths, and where they do the finer side
 * has a vertex sitting in the middle of the coarser side's edge - a T-junction,
 * and a hairline crack through to the background. The cure needs no adjacency
 * bookkeeping at all: an edge belongs to exactly two triangles, so if a leaf
 * finds that this frame's split left a midpoint on one of its edges, the
 * neighbour must have put it there. The leaf walks that midpoint (and any
 * beneath it) into its outline and fans the result, so the two sides meet along
 * exactly the same chain of vertices.
 */
import type { Camera } from './projection'
import { height, sampledLevel, terrainState, wantAt } from './tiles'

const EARTH_RADIUS_M = 6_371_000

/**
 * How many quadtree levels sit between a node and the tile level that matches
 * it.
 *
 * A base face spans 90 degrees and halves each level; a level-0 tile samples
 * every 0.703 degrees, and tiles have 128 samples a side. 90/0.703 is 128, so a
 * node at level L has the same spacing as a tile at level L - 7. Sampling finer
 * than that would put a single peak or trench on a vertex that stands for a
 * whole neighbourhood, which reads as speckle in the silhouette.
 */
const TILE_LEVEL_OFFSET = 7

/**
 * How long an edge may look on screen before a node splits, in CSS pixels.
 *
 * Every triangle is a filled canvas path now rather than a few samples of a
 * buffer, and the cost of a frame turns out to follow the number of paths far
 * more than the area they cover: measured at 1400x900 on a two-times display,
 * going from 30 to 50 took the whole frame from 15 to 23 a second, and 50 to 80
 * bought only two more. This sits at the knee.
 *
 * It also sets how fine the shading can be, since the surface is lit per face -
 * so it is a straight trade between smoothness and frame rate.
 *
 * Read it as a ceiling rather than a target. A node splits when its longest
 * edge exceeds this, and the children come out at half, so leaves land between
 * a half and a whole; the longest edge of a triangle is longer than its typical
 * one; stitching a coarse leaf to a finer neighbour fans it into several; and
 * the foreshortening term above refines the rim harder still. Measured, the
 * faces come out about two and a half times finer than the number says - 60
 * gives triangles averaging some 23 pixels across.
 */
const SPLIT_PIXELS = 16

/**
 * How much of an edge's foreshortening to believe.
 *
 * A patch seen edge on projects to almost nothing and by the screen-size metric
 * alone would never refine - but the limb is precisely where displaced terrain
 * shows itself, standing out of the silhouette. Counting a fraction of the
 * depth extent alongside the screen extent keeps the rim tessellated without
 * giving up the saving across the rest of the disc.
 */
const FORESHORTEN = 0.25

/**
 * The floor on patch size, in levels below the base face.
 *
 * Set from the archive: refining past the finest tiles costs triangles and
 * adds nothing, because every new vertex would land between two samples of the
 * same cell and interpolate a straight line. Held at nine until the archive
 * opens, which is what a five-level pyramid works out at anyway.
 */
let maxLevel = 9

/** How far a leaf will chase midpoints down one edge when stitching. */
const MAX_STITCH_DEPTH = 4

/**
 * Vertex ceiling, after which the cache is dropped and rebuilt.
 *
 * Vertices are kept forever because their geometry never changes, but a long
 * session that roams the whole globe at full zoom would otherwise accumulate
 * every vertex it ever touched. At about 45 bytes each this caps the cache
 * around 18 MB; hitting it costs one frame of re-sampling.
 */
const MAX_VERTICES = 400_000

/** Where a direction is close enough to a pole that its longitude is noise. */
const POLE = 1 - 1e-7

// The vertex pool. Geometry (direction, lift, grid coordinate) is permanent;
// the screen columns are scratch, valid only for the frame that stamped them.
let capacity = 0
let count = 0
let dirs = new Float32Array(0)
let lifts = new Float32Array(0)
let coords = new Float32Array(0)
let screenX = new Float32Array(0)
let screenY = new Float32Array(0)
/**
 * Camera-space position, in globe radii. Screen x and y are these scaled and
 * shifted, so keeping them costs two arrays and saves the painter from undoing
 * the transform to work out which way a face is turned.
 */
let camX = new Float32Array(0)
let camY = new Float32Array(0)
let camZ = new Float32Array(0)
/** Frame this vertex was last projected. */
let projected = new Uint32Array(0)
/** Frame this vertex was created as the midpoint of a splitting edge. */
let splitAt = new Uint32Array(0)
/**
 * The tile level a vertex's lift actually came from, and the one it wanted.
 *
 * They differ while the tile it wanted is still on its way, and a vertex that
 * had to settle for a coarse ancestor is asked again on later frames until the
 * fine one lands. Without this a vertex created during the first second of a
 * session would keep its 78 km height for as long as the session ran, because
 * vertices are cached forever - which is the whole reason refining is cheap.
 */
let liftLevel = new Int8Array(0)
let wantLevel = new Int8Array(0)

/**
 * Edge -> the vertex sitting at its midpoint, as an open-addressed table.
 *
 * This is the hottest structure in the file: every node that splits looks up
 * three edges, and every leaf looks up three more to find out whether a
 * neighbour got finer than it did. A Map keyed on a packed pair costs about a
 * hundred nanoseconds a call and turned out to be most of the frame - more than
 * rasterising the triangles it was there to help. Linear probing over three
 * typed arrays is a few nanoseconds, and the keys are pairs of small integers,
 * which is the case it is best at.
 */
let slotA = new Uint32Array(0)
let slotB = new Uint32Array(0)
let slotVertex = new Uint32Array(0)
let slotMask = 0
let slotCount = 0

/** No vertex can have this index, so it marks a free slot. */
const EMPTY = 0xffffffff

/** Whether the base octahedron has been laid down yet. */
let seeded = false

/**
 * Frame counter, used to stamp the scratch state. Starts at 1 so that a zeroed
 * stamp reads as "never", and never resets - at sixty frames a second a 32-bit
 * counter lasts two years.
 */
let frame = 0

// Per-frame camera terms, held here so the recursion does not thread them
// through every call.
let cosLon = 1
let sinLon = 0
let cosLat = 1
let sinLat = 0
let centreX = 0
let centreY = 0
let radiusPx = 1
let viewWidth = 0
let viewHeight = 0
let exaggeration = 0
let maxLift = 0

/** What the last selection cost, for the HUD. */
export type QuadtreeStats = {
  /** Triangles handed to the rasteriser, stitching fans included. */
  triangles: number
  /** Nodes visited, whether split, drawn or dropped. */
  nodes: number
  /** Nodes dropped by the horizon or the buffer edge. */
  culled: number
  /** The deepest level anything was drawn at. */
  depth: number
  /** Vertices held in the cache. */
  vertices: number
  /** The finest tile level any vertex on screen actually got its height from. */
  detail: number
}

const stats: QuadtreeStats = {
  triangles: 0,
  nodes: 0,
  culled: 0,
  depth: 0,
  vertices: 0,
  detail: -1,
}

export function quadtreeStats(): QuadtreeStats {
  return stats
}

/**
 * The base octahedron: the poles, and four points around the equator.
 *
 * Held as raw directions rather than pool indices because they are always the
 * first six entries of the pool, whenever it is laid down.
 */
const BASE_DIRECTIONS = [
  0, 1, 0, // 0: north pole
  0, -1, 0, // 1: south pole
  0, 0, 1, // 2: longitude 0
  1, 0, 0, // 3: longitude 90 E
  0, 0, -1, // 4: longitude 180
  -1, 0, 0, // 5: longitude 90 W
]

/**
 * The eight faces, wound to match the rasteriser.
 *
 * `rasteriseTriangle` keeps triangles of positive signed area in a downward-y
 * screen space, which is a clockwise winding seen from outside the globe - so
 * the northern faces run the other way around from the southern ones.
 */
const BASE_FACES = [
  0, 3, 2,
  0, 4, 3,
  0, 5, 4,
  0, 2, 5,
  1, 2, 3,
  1, 3, 4,
  1, 4, 5,
  1, 5, 2,
]

/**
 * How far a patch can stray from the hull of its corners, per level, in globe
 * radii: the sphere bulges out of the flat triangle its corners span.
 *
 * Bounded by the circumradius of the face - 54.7 degrees at the base, halving
 * with every level - which is loose but costs one table lookup, and only ever
 * makes the culling admit a node it might have dropped.
 */
const DEEPEST = 24
const BULGE: number[] = []
for (let level = 0; level <= DEEPEST; level++) {
  BULGE.push(1 - Math.cos(Math.acos(1 / Math.sqrt(3)) / (1 << level)))
}

/**
 * Select the visible surface for this frame and hand back its triangles.
 *
 * Returns how many were produced; the geometry itself is in the arrays below,
 * which are reused every frame. The painter turns them into filled paths - it
 * needs a face normal and a height to pick a colour, and a depth to sort by,
 * and all three fall out of work the selection has already done.
 */
export function selectSurface(
  camera: Camera,
  viewport: { width: number; height: number },
  exaggerationNow: number,
): number {
  const terrain = terrainState()
  if (!seeded) reset()

  frame++
  // No point refining geometry past the data: a vertex between two samples of
  // the same cell only ever interpolates the straight line already there.
  maxLevel = terrain.levels - 1 + TILE_LEVEL_OFFSET
  cosLon = camera.cosLon
  sinLon = camera.sinLon
  cosLat = camera.cosLat
  sinLat = camera.sinLat
  centreX = camera.cx
  centreY = camera.cy
  radiusPx = camera.radius
  viewWidth = viewport.width
  viewHeight = viewport.height
  exaggeration = exaggerationNow
  maxLift = terrain.maxLift

  stats.triangles = 0
  stats.nodes = 0
  stats.culled = 0
  stats.depth = 0
  stats.detail = -1

  // The pool is only ever grown, so this drops it whole rather than evicting.
  // Cheaper than tracking use per vertex, and it happens almost never.
  if (count > MAX_VERTICES) reset()

  leafCount = 0
  for (let f = 0; f < BASE_FACES.length; f += 3) {
    select(BASE_FACES[f], BASE_FACES[f + 1], BASE_FACES[f + 2], 0)
  }

  // Emitting is a second pass because stitching asks what the *finished*
  // selection looks like: a leaf cannot know whether its neighbour split until
  // that neighbour has been visited, and the neighbour may come later.
  triangleCount = 0
  for (let i = 0; i < leafCount; i += 3) {
    emit(leaves[i], leaves[i + 1], leaves[i + 2])
  }

  stats.vertices = count
  return triangleCount
}

/**
 * The frame's triangles as vertex data for the GPU: direction xyz then height
 * in metres, four floats a vertex, three vertices a triangle.
 *
 * Nothing here is screen space and nothing is shaded. The two values a vertex
 * carries are the two that never change, so exaggeration, rotation and colour
 * are all the shaders' business.
 */
export let surfaceVertices = new Float32Array(0)
let triangleCount = 0
let faceCapacity = 0

function reserveFaces(needed: number) {
  if (needed <= faceCapacity) return
  let next = faceCapacity === 0 ? 8192 : faceCapacity
  while (next < needed) next *= 2
  const grown = new Float32Array(next * 12)
  grown.set(surfaceVertices)
  surfaceVertices = grown
  faceCapacity = next
}

/**
 * Record one triangle.
 *
 * Back-facing triangles are dropped by the sign of the screen-space area: the
 * surface is a radial height field, so it is star-shaped about the centre and
 * anything turned away is covered by something in front of it. The depth buffer
 * would sort them out regardless, but not emitting them halves the work.
 */
function face(a: number, b: number, c: number) {
  const ax = screenX[a]
  const ay = screenY[a]
  const bx = screenX[b]
  const by = screenY[b]
  const cx = screenX[c]
  const cy = screenY[c]

  // Positive area is front-facing in this downward-y screen space; zero is
  // degenerate, which is what a triangle collapsed onto a pole becomes.
  if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) <= 1e-12) return

  reserveFaces(triangleCount + 1)
  let at = triangleCount * 12
  for (const v of [a, b, c]) {
    const d = v * 3
    surfaceVertices[at] = dirs[d]
    surfaceVertices[at + 1] = dirs[d + 1]
    surfaceVertices[at + 2] = dirs[d + 2]
    surfaceVertices[at + 3] = lifts[v] * EARTH_RADIUS_M
    at += 4
  }
  triangleCount++
  stats.triangles++
}

/** Throw the cache away and lay the base octahedron down again. */
function reset() {
  seeded = true
  count = 0
  slotCount = 0
  allocateSlots(1 << 16)
  for (let i = 0; i < BASE_DIRECTIONS.length; i += 3) {
    addVertex(BASE_DIRECTIONS[i], BASE_DIRECTIONS[i + 1], BASE_DIRECTIONS[i + 2])
  }
}

// Leaves of the current selection, three vertex indices apiece.
let leaves = new Uint32Array(3 * 4096)
let leafCount = 0

/**
 * Walk one node, splitting while the screen says it is worth it.
 *
 * Children keep the parent's winding: three at the corners, and a fourth
 * inverted in the middle whose vertices run the same way around.
 */
function select(a: number, b: number, c: number, level: number) {
  stats.nodes++

  // A vertex belongs to nodes at several levels; the deepest is the one whose
  // spacing its height has to stand for.
  const tile = level - TILE_LEVEL_OFFSET
  if (tile > wantLevel[a]) wantLevel[a] = tile
  if (tile > wantLevel[b]) wantLevel[b] = tile
  if (tile > wantLevel[c]) wantLevel[c] = tile

  project(a)
  project(b)
  project(c)

  if (culled(a, b, c, level)) {
    stats.culled++
    return
  }

  if (level < maxLevel && count < MAX_VERTICES && oversized(a, b, c)) {
    const ab = midpoint(a, b)
    const bc = midpoint(b, c)
    const ca = midpoint(c, a)
    // Stamped as split, not merely as existing: the neighbours read this to
    // find the T-junctions they have to stitch across.
    splitAt[ab] = frame
    splitAt[bc] = frame
    splitAt[ca] = frame

    select(a, ab, ca, level + 1)
    select(ab, b, bc, level + 1)
    select(ca, bc, c, level + 1)
    select(ab, bc, ca, level + 1)
    return
  }

  if (level > stats.depth) stats.depth = level

  if (leafCount + 3 > leaves.length) {
    const grown = new Uint32Array(leaves.length * 2)
    grown.set(leaves)
    leaves = grown
  }
  leaves[leafCount++] = a
  leaves[leafCount++] = b
  leaves[leafCount++] = c
}

/**
 * Whether a node is worth another level.
 *
 * The longest edge decides, measured on screen with a fraction of its depth
 * extent folded in so that patches at the limb - which project to almost
 * nothing yet carry the silhouette - are not starved.
 */
function oversized(a: number, b: number, c: number): boolean {
  const limit = SPLIT_PIXELS * SPLIT_PIXELS
  return (
    edgeLength2(a, b) > limit ||
    edgeLength2(b, c) > limit ||
    edgeLength2(c, a) > limit
  )
}

function edgeLength2(i: number, j: number): number {
  const dx = screenX[i] - screenX[j]
  const dy = screenY[i] - screenY[j]
  // Depth is in globe radii; the radius carries it into pixels.
  const dz = (camZ[i] - camZ[j]) * radiusPx
  return dx * dx + dy * dy + FORESHORTEN * dz * dz
}

/**
 * Whether a node can be dropped outright.
 *
 * Both tests work on the hull of the projected corners, widened by how far the
 * curved patch can stray outside it and by however far the tallest ground is
 * currently displaced. Being conservative only ever costs a node that would
 * have drawn nothing.
 */
function culled(a: number, b: number, c: number, level: number): boolean {
  const slack = BULGE[level] + maxLift * exaggeration

  // Behind the globe. The surface is a radial height field, so it is
  // star-shaped about the centre and the far side is covered by the near side -
  // except for ground displaced past the silhouette, which the slack allows
  // for. Whatever survives and still faces away is dropped by the rasteriser's
  // own winding test.
  const nearest = Math.max(camZ[a], Math.max(camZ[b], camZ[c]))
  if (nearest + slack < 0) return true

  const margin = slack * radiusPx
  const minX = Math.min(screenX[a], Math.min(screenX[b], screenX[c])) - margin
  if (minX > viewWidth) return true
  const maxX = Math.max(screenX[a], Math.max(screenX[b], screenX[c])) + margin
  if (maxX < 0) return true

  const marginY = slack * radiusPx
  const minY = Math.min(screenY[a], Math.min(screenY[b], screenY[c])) - marginY
  if (minY > viewHeight) return true
  const maxY = Math.max(screenY[a], Math.max(screenY[b], screenY[c])) + marginY
  return maxY < 0
}

/** Project a vertex, once per frame however many nodes ask for it. */
function project(v: number) {
  if (projected[v] === frame) return
  projected[v] = frame

  // Sampled short of what this vertex wants, because the tile had not arrived
  // when it was created. Ask again; it costs one lookup and stops as soon as
  // the answer is as good as it is going to get.
  if (liftLevel[v] < wantLevel[v]) sampleLift(v)
  if (liftLevel[v] > stats.detail) stats.detail = liftLevel[v]

  const at = v * 3
  // Displacing here rather than in the cache keeps exaggeration free: the
  // vertices hold the shape of the ground, not the shape of this frame's globe.
  const radius = 1 + lifts[v] * exaggeration
  const x = dirs[at] * radius
  const y = dirs[at + 1] * radius
  const z = dirs[at + 2] * radius

  const x1 = x * cosLon - z * sinLon
  const z1 = x * sinLon + z * cosLon
  const cy = y * cosLat - z1 * sinLat

  camX[v] = x1
  camY[v] = cy
  camZ[v] = y * sinLat + z1 * cosLat
  screenX[v] = centreX + x1 * radiusPx
  screenY[v] = centreY - cy * radiusPx
}

/**
 * The slot an edge occupies, whether or not anything is in it yet.
 *
 * Endpoints are ordered so the two triangles sharing an edge land on the same
 * slot and cannot disagree about where the ground between them is.
 */
function slotOf(a: number, b: number): number {
  const lo = a < b ? a : b
  const hi = a < b ? b : a

  // A 32-bit mix of the pair. The two indices are usually near neighbours in
  // the pool, so the low bits alone would cluster badly.
  let h = Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca77)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 13

  let slot = h & slotMask
  while (slotA[slot] !== EMPTY) {
    if (slotA[slot] === lo && slotB[slot] === hi) return slot
    slot = (slot + 1) & slotMask
  }
  return slot
}

/**
 * The vertex at the midpoint of an edge, created if this is the first time
 * anything has asked.
 */
function midpoint(a: number, b: number): number {
  const slot = slotOf(a, b)
  if (slotA[slot] !== EMPTY) return slotVertex[slot]

  const ia = a * 3
  const ib = b * 3
  const v = addVertex(
    dirs[ia] + dirs[ib],
    dirs[ia + 1] + dirs[ib + 1],
    dirs[ia + 2] + dirs[ib + 2],
  )

  slotA[slot] = a < b ? a : b
  slotB[slot] = a < b ? b : a
  slotVertex[slot] = v
  // Half full is where linear probing still finds a free slot in a couple of
  // steps; past that the runs start to join up.
  if (++slotCount * 2 > slotMask) rehash()
  return v
}

/** The midpoint of an edge if it already exists, without creating one. */
function findMidpoint(a: number, b: number): number {
  const slot = slotOf(a, b)
  return slotA[slot] === EMPTY ? -1 : slotVertex[slot]
}

function rehash() {
  const oldA = slotA
  const oldB = slotB
  const oldVertex = slotVertex
  allocateSlots(oldA.length * 2)
  for (let i = 0; i < oldA.length; i++) {
    if (oldA[i] === EMPTY) continue
    const slot = slotOf(oldA[i], oldB[i])
    slotA[slot] = oldA[i]
    slotB[slot] = oldB[i]
    slotVertex[slot] = oldVertex[i]
  }
}

function allocateSlots(size: number) {
  slotA = new Uint32Array(size).fill(EMPTY)
  slotB = new Uint32Array(size)
  slotVertex = new Uint32Array(size)
  slotMask = size - 1
}

/**
 * Add a vertex, normalising the direction and sampling the ground under it.
 *
 * The grid coordinate is worked out here, once, rather than per frame: it is
 * the only trigonometry the quadtree does, and caching it is most of why
 * refining costs so little after the first few frames.
 */
function addVertex(x: number, y: number, z: number): number {
  const inverse = 1 / Math.sqrt(x * x + y * y + z * z)
  x *= inverse
  y *= inverse
  z *= inverse

  reserve(count + 1)
  const v = count++
  const at = v * 3
  dirs[at] = x
  dirs[at + 1] = y
  dirs[at + 2] = z

  const latitude = Math.asin(y < -1 ? -1 : y > 1 ? 1 : y)
  // Longitude eastward from the antimeridian and latitude southward from the
  // north pole, both as fractions. At a pole every longitude meets, so the
  // column is genuinely undefined: left as NaN and settled per triangle, from
  // whichever meridians the other two corners sit on.
  coords[v * 2] =
    y > POLE || y < -POLE ? NaN : (Math.atan2(x, z) + Math.PI) / (2 * Math.PI)
  coords[v * 2 + 1] = (Math.PI / 2 - latitude) / Math.PI

  // The pool is only ever grown, never cleared, so a vertex reusing a slot from
  // before a reset would inherit its stamps.
  projected[v] = 0
  splitAt[v] = 0
  wantLevel[v] = 0
  liftLevel[v] = -1
  sampleLift(v)
  return v
}

/**
 * Take a vertex's height from the tile pyramid, and record which level
 * answered so it can be asked again if a finer one turns up.
 */
function sampleLift(v: number) {
  const want = wantLevel[v]
  // A pole has no meridian of its own; any of them passes through it.
  const u = coords[v * 2]
  lifts[v] = height(u === u ? u : 0, coords[v * 2 + 1], want) / EARTH_RADIUS_M
  liftLevel[v] = sampledLevel
}

function reserve(needed: number) {
  if (needed <= capacity) return
  let next = capacity === 0 ? 4096 : capacity
  while (next < needed) next *= 2

  dirs = regrow(dirs, next * 3)
  coords = regrow(coords, next * 2)
  lifts = regrow(lifts, next)
  screenX = regrow(screenX, next)
  screenY = regrow(screenY, next)
  camX = regrow(camX, next)
  camY = regrow(camY, next)
  camZ = regrow(camZ, next)

  const nextProjected = new Uint32Array(next)
  nextProjected.set(projected)
  projected = nextProjected
  const nextSplit = new Uint32Array(next)
  nextSplit.set(splitAt)
  splitAt = nextSplit
  const nextLift = new Int8Array(next)
  nextLift.set(liftLevel)
  liftLevel = nextLift
  const nextWant = new Int8Array(next)
  nextWant.set(wantLevel)
  wantLevel = nextWant

  capacity = next
}

function regrow(
  array: Float32Array<ArrayBuffer>,
  length: number,
): Float32Array<ArrayBuffer> {
  const grown = new Float32Array(length)
  grown.set(array)
  return grown
}

/**
 * The outline of the leaf being drawn.
 *
 * Fixed and reused, so drawing allocates nothing. Three edges each descending
 * at most `MAX_STITCH_DEPTH` levels bounds the outline at 3 * 2^4 vertices,
 * and it is only ever near that if every neighbour is four levels finer.
 */
const OUTLINE_LIMIT = 3 * (1 << MAX_STITCH_DEPTH)
const outline = new Uint32Array(OUTLINE_LIMIT)
let outlineCount = 0

/**
 * Draw one leaf, stitched to whatever its neighbours did.
 *
 * The outline is the three edges walked in order, each descending through any
 * midpoint this frame's splitting left on it. Where no neighbour was finer
 * that is just the three corners; where one was, the extra vertices are exactly
 * the ones the neighbour drew to, so the two meet with no gap between them.
 */
function emit(a: number, b: number, c: number) {
  outlineCount = 0
  walk(a, b, 0)
  walk(b, c, 0)
  walk(c, a, 0)
  const n = outlineCount

  // The tiles that gave these corners their height are the ones this patch
  // will want again as it refines. Asking once per leaf rather than once per
  // vertex is what keeps the request count down. A pole has no meridian of its
  // own, so ask from a corner that has one - a triangle has at most one pole.
  const anchor = coords[a * 2] === coords[a * 2] ? a : coords[b * 2] === coords[b * 2] ? b : c
  wantAt(wantLevel[a], coords[anchor * 2], coords[anchor * 2 + 1])

  // A fan from the first corner. Every edge of it is either an outline edge -
  // shared, and matched vertex for vertex - or interior to this leaf, so
  // nothing here can open a crack.
  for (let i = 1; i < n - 1; i++) {
    face(outline[0], outline[i], outline[i + 1])
  }
}

/**
 * Push one edge onto the outline, descending through any midpoint that this
 * frame's splitting put on it.
 *
 * An edge is shared by exactly two triangles, so a midpoint stamped this frame
 * on the edge of a leaf can only have come from the other one - which is to say
 * the neighbour is finer, and this is the T-junction to stitch. The endpoint is
 * left to the next edge to push, so the outline comes out once around.
 */
function walk(a: number, b: number, depth: number) {
  if (depth < MAX_STITCH_DEPTH) {
    const m = findMidpoint(a, b)
    if (m >= 0 && splitAt[m] === frame) {
      walk(a, m, depth + 1)
      walk(m, b, depth + 1)
      return
    }
  }
  project(a)
  outline[outlineCount++] = a
}
