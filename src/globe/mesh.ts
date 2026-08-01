/**
 * The globe's surface as one static mesh, built once and left on the GPU.
 *
 * This replaces a view-dependent quadtree that rebuilt the visible surface
 * every frame. That made sense while triangles were expensive - each was a
 * filled canvas path - and the whole game was emitting as few as possible. On
 * the GPU it is backwards. Measured, the walk could not produce more than about
 * fifty thousand triangles a frame before it ate the frame whole: reaching the
 * detail the terrain archive actually holds cost four hundred milliseconds a
 * frame in JavaScript, to feed a card that would have drawn it in under one.
 *
 * The observation that undoes all of it: a vertex carries a direction and a
 * height above sea level, and neither ever changes. Exaggeration is a shader
 * uniform, the camera is a shader uniform, colour is computed per fragment.
 * There is nothing per-frame about the mesh at all - so it does not need
 * rebuilding, it needs uploading, once.
 *
 * So the whole globe is subdivided uniformly to the finest spacing the archive
 * can answer for - node level 9, matching tile level 2, about 78 metres of
 * error and two million triangles - and handed over as static buffers. A frame
 * is a few uniform writes and one draw call per chunk. Being uniform, it also
 * has no T-junctions, so the stitching the quadtree needed is simply absent.
 *
 * Chunks exist for four reasons: they keep every index buffer inside sixteen
 * bits, so no extension is needed; they let the back hemisphere and anything
 * off screen be dropped for the cost of a dot product; they let the build be
 * spread over frames rather than freezing one; and they are the unit that a
 * later, deeper level would be streamed in.
 */
import type { Camera } from './projection'
import { drawMesh, glReady, setMeshChunk, setMeshIndices } from './gl'
import { height, RESIDENT_LEVELS, sampledLevel, terrainState } from './tiles'

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
 * The tile level the mesh is built to match.
 *
 * The same level that is fetched for the whole globe up front, because the two
 * have to agree: meshing finer than the resident data only interpolates the
 * straight line already there, and meshing coarser throws away detail that has
 * been paid for.
 */
const TARGET_TILE_LEVEL = RESIDENT_LEVELS

/** Node level of the mesh: level 9, for tile level 2. */
const MESH_LEVEL = TILE_LEVEL_OFFSET + TARGET_TILE_LEVEL

/**
 * Node level a chunk sits at, so there are 8 * 4^n of them.
 *
 * Two gives 128 chunks of 8,385 vertices - just inside the 65,536 an unsigned
 * short index can reach, which is what keeps this on plain WebGL 1 with no
 * extensions. It is also about the right granularity for culling: a chunk spans
 * some 22 degrees, so the horizon test throws away close to half of them and
 * the screen test does the rest as you zoom.
 */
const CHUNK_LEVEL = 2

const CHUNK_COUNT = 8 << (2 * CHUNK_LEVEL)
/** Divisions along a chunk's edge. */
const N = 1 << (MESH_LEVEL - CHUNK_LEVEL)
const VERTICES_PER_CHUNK = ((N + 1) * (N + 2)) / 2
const TRIANGLES_PER_CHUNK = N * N

/**
 * How long a frame may spend building chunks, in milliseconds.
 *
 * The build is a one-off costing perhaps half a second in total, but taken in
 * one bite it would be a visible stall. Rationed like this the globe simply
 * sharpens over the first second, front first.
 */
const BUILD_BUDGET_MS = 5

/** A chunk that has never been built. */
const UNBUILT = -2

// --- The base octahedron ---------------------------------------------------
//
// A sphere has no seamless square parameterisation, and the obvious alternative
// of a lon/lat grid wastes its resolution at the poles and is singular there.
// An octahedron's faces are congruent, its corners fall on the poles and the
// equator so latitude and longitude stay easy to reason about, and each face
// subdivides into four by joining the midpoints of its edges.

const BASE_DIRECTIONS = [
  [0, 1, 0], // 0: north pole
  [0, -1, 0], // 1: south pole
  [0, 0, 1], // 2: longitude 0
  [1, 0, 0], // 3: longitude 90 E
  [0, 0, -1], // 4: longitude 180
  [-1, 0, 0], // 5: longitude 90 W
]

/**
 * The eight faces, wound anticlockwise seen from outside the globe.
 *
 * That is what `gl.frontFace(gl.CCW)` wants, and it is the opposite of the
 * order the quadtree used: its rasteriser worked in a downward-y screen space
 * and kept triangles of positive signed area there, which is clockwise once y
 * points up again. Get it backwards and the near hemisphere is the side that
 * gets culled, leaving a ring of far-side ground around the limb and nothing in
 * the middle - which is exactly what it looks like.
 *
 * Subdivision preserves winding, so this is the only place it is decided.
 */
const BASE_FACES = [
  [0, 2, 3],
  [0, 3, 4],
  [0, 4, 5],
  [0, 5, 2],
  [1, 3, 2],
  [1, 4, 3],
  [1, 5, 4],
  [1, 2, 5],
]

// --- Chunk geometry --------------------------------------------------------

/** Three corner directions per chunk, nine doubles apiece. */
const corners = new Float64Array(CHUNK_COUNT * 9)
/** The bounding cap of each chunk: centre direction, and the sine of its angular radius. */
const capX = new Float64Array(CHUNK_COUNT)
const capY = new Float64Array(CHUNK_COUNT)
const capZ = new Float64Array(CHUNK_COUNT)
const capSin = new Float64Array(CHUNK_COUNT)

/**
 * The finest tile level that answered for every vertex of a chunk, or `UNBUILT`.
 *
 * Short of the target while the tiles under it are still on their way, which is
 * what asks for the rebuild once they land.
 */
const sampled = new Int8Array(CHUNK_COUNT).fill(UNBUILT)
/** Tiles resident when a chunk was last built, so a retry only happens on news. */
const stamped = new Int32Array(CHUNK_COUNT).fill(-1)

/** Chunks to draw this frame, and how many. */
const visible = new Uint16Array(CHUNK_COUNT)
let visibleCount = 0
/** Whether each chunk is on screen this frame, so the builder can go there first. */
const shown = new Uint8Array(CHUNK_COUNT)
/** Chunks that want building this frame, on-screen ones first. */
const pending = new Uint16Array(CHUNK_COUNT)

/** One chunk's vertices, refilled per build and handed straight to the GPU. */
const scratch = new Float32Array(VERTICES_PER_CHUNK * 4)

let seeded = false
let builtChunks = 0

export type MeshStats = {
  /** Triangles drawn this frame. */
  triangles: number
  /** Chunks drawn this frame, out of `CHUNK_COUNT`. */
  drawn: number
  /** Chunks built so far. */
  built: number
  /** Total chunks in the mesh. */
  chunks: number
  /**
   * The coarsest tile level any built chunk had to settle for - so the level
   * the whole globe is guaranteed at, not the best anywhere.
   */
  detail: number
}

const stats: MeshStats = {
  triangles: 0,
  drawn: 0,
  built: 0,
  chunks: CHUNK_COUNT,
  detail: -1,
}

export function meshStats(): MeshStats {
  return stats
}

/**
 * Cull, build what the budget allows, and draw.
 *
 * Everything the frame costs is here, and once the mesh is complete it is a
 * hundred and twenty-eight dot products and half as many draw calls.
 */
export function drawSurface(
  camera: Camera,
  viewport: { width: number; height: number; dpr: number },
  exaggeration: number,
) {
  if (!glReady()) return
  if (!seeded) seed()

  selectVisible(camera, viewport, exaggeration)
  build()

  drawMesh(camera, viewport, exaggeration, visible, visibleCount)

  stats.drawn = visibleCount
  stats.triangles = visibleCount * TRIANGLES_PER_CHUNK
  stats.built = builtChunks
}

/** Lay out the chunk corners and the index buffer they all draw through. */
function seed() {
  seeded = true

  let at = 0
  const place = (
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    level: number,
  ) => {
    if (level === CHUNK_LEVEL) {
      corners.set(a, at)
      corners.set(b, at + 3)
      corners.set(c, at + 6)
      at += 9
      return
    }
    // Midpoints are computed from the shared endpoints and handed to every
    // child that touches them, so two chunks either side of an edge get the
    // same corner to the bit - which is what stops a crack opening between
    // them once their interiors are interpolated from it.
    const ab = mid(a, b)
    const bc = mid(b, c)
    const ca = mid(c, a)
    place(a, ab, ca, level + 1)
    place(ab, b, bc, level + 1)
    place(ca, bc, c, level + 1)
    place(ab, bc, ca, level + 1)
  }

  for (const [a, b, c] of BASE_FACES) {
    place(BASE_DIRECTIONS[a], BASE_DIRECTIONS[b], BASE_DIRECTIONS[c], 0)
  }

  for (let k = 0; k < CHUNK_COUNT; k++) capOf(k)

  setMeshIndices(buildIndices())
}

/** The normalised midpoint of two directions. */
function mid(a: readonly number[], b: readonly number[]): number[] {
  const x = a[0] + b[0]
  const y = a[1] + b[1]
  const z = a[2] + b[2]
  const inverse = 1 / Math.sqrt(x * x + y * y + z * z)
  return [x * inverse, y * inverse, z * inverse]
}

/**
 * The cap that contains a chunk: the direction of its centre, and how far its
 * corners lean away from it.
 *
 * The patch bulges out of the flat triangle its corners span, but never past
 * the sphere, so a cap through the corners contains the whole of it.
 */
function capOf(k: number) {
  const o = k * 9
  let x = corners[o] + corners[o + 3] + corners[o + 6]
  let y = corners[o + 1] + corners[o + 4] + corners[o + 7]
  let z = corners[o + 2] + corners[o + 5] + corners[o + 8]
  const inverse = 1 / Math.sqrt(x * x + y * y + z * z)
  x *= inverse
  y *= inverse
  z *= inverse

  let cos = 1
  for (let i = 0; i < 3; i++) {
    const c = o + i * 3
    const dot = x * corners[c] + y * corners[c + 1] + z * corners[c + 2]
    if (dot < cos) cos = dot
  }

  capX[k] = x
  capY[k] = y
  capZ[k] = z
  capSin[k] = Math.sqrt(Math.max(0, 1 - cos * cos))
}

/**
 * The triangle list, shared by every chunk.
 *
 * Vertices are laid out row by row from the first corner: row i holds i + 1 of
 * them, so the vertex at (i, j) is at i(i+1)/2 + j. Each row adds an upward
 * triangle per step and a downward one between them, which comes to N^2.
 */
function buildIndices(): Uint16Array {
  const out = new Uint16Array(TRIANGLES_PER_CHUNK * 3)
  let at = 0
  for (let i = 1; i <= N; i++) {
    const above = ((i - 1) * i) / 2
    const row = (i * (i + 1)) / 2
    for (let j = 0; j < i; j++) {
      out[at++] = above + j
      out[at++] = row + j
      out[at++] = row + j + 1
      if (j < i - 1) {
        out[at++] = above + j
        out[at++] = row + j + 1
        out[at++] = above + j + 1
      }
    }
  }
  return out
}

// --- Selection -------------------------------------------------------------

/**
 * Work out which chunks can contribute a pixel.
 *
 * Two tests against the chunk's bounding cap, both widened by however far the
 * tallest ground is currently displaced: one for the far side of the globe,
 * which the near side covers, and one for the edges of the viewport, which is
 * what pays as you zoom in.
 */
function selectVisible(
  camera: Camera,
  viewport: { width: number; height: number },
  exaggeration: number,
) {
  const { cosLon, sinLon, cosLat, sinLat, cx, cy, radius } = camera
  const slack = terrainState().maxLift * exaggeration
  visibleCount = 0
  shown.fill(0)

  for (let k = 0; k < CHUNK_COUNT; k++) {
    const x = capX[k]
    const y = capY[k]
    const z = capZ[k]

    const x1 = x * cosLon - z * sinLon
    const z1 = x * sinLon + z * cosLon
    const viewY = y * cosLat - z1 * sinLat
    const viewZ = y * sinLat + z1 * cosLat

    const reach = capSin[k] + slack
    // Wholly behind the globe.
    if (viewZ + reach < 0) continue

    const r = reach * radius
    const sx = cx + x1 * radius
    const sy = cy - viewY * radius
    if (sx + r < 0 || sx - r > viewport.width) continue
    if (sy + r < 0 || sy - r > viewport.height) continue

    shown[k] = 1
    visible[visibleCount++] = k
  }
}

// --- Building --------------------------------------------------------------

/**
 * Build whatever the frame's budget allows, visible chunks first.
 *
 * A chunk is built once, and rebuilt only if it had to settle for a tile
 * coarser than the target and more tiles have landed since - so the retries
 * stop of their own accord as the archive fills in.
 */
function build() {
  const terrain = terrainState()
  if (!terrain.ready) return
  const resident = terrain.resident

  // Ground that has never been meshed comes first, wherever it is, because the
  // fallback disc covers the globe until every chunk exists - so one unbuilt
  // patch on the far side holds up the whole surface. Only once they all exist
  // does the budget go on refining what is on screen.
  let count = 0
  for (let i = 0; i < visibleCount; i++) {
    const k = visible[i]
    if (sampled[k] === UNBUILT) pending[count++] = k
  }
  for (let k = 0; k < CHUNK_COUNT; k++) {
    if (shown[k] === 0 && sampled[k] === UNBUILT) pending[count++] = k
  }
  for (let i = 0; i < visibleCount; i++) {
    const k = visible[i]
    if (sampled[k] !== UNBUILT && wants(k, resident)) pending[count++] = k
  }
  for (let k = 0; k < CHUNK_COUNT; k++) {
    if (shown[k] === 0 && sampled[k] !== UNBUILT && wants(k, resident)) pending[count++] = k
  }
  if (count === 0) return

  const deadline = performance.now() + BUILD_BUDGET_MS
  for (let i = 0; i < count; i++) {
    buildChunk(pending[i], resident)
    if (performance.now() >= deadline) break
  }

  // The globe is only as good as its worst patch, so the readout is the
  // coarsest level anything settled for rather than the finest anything got.
  let worst = TARGET_TILE_LEVEL
  let built = 0
  for (let k = 0; k < CHUNK_COUNT; k++) {
    if (sampled[k] === UNBUILT) continue
    built++
    if (sampled[k] < worst) worst = sampled[k]
  }
  builtChunks = built
  stats.detail = built === 0 ? -1 : worst
}

function wants(k: number, resident: number): boolean {
  if (sampled[k] === UNBUILT) return true
  return sampled[k] < TARGET_TILE_LEVEL && stamped[k] !== resident
}

/**
 * Fill one chunk's vertices and hand them to the GPU.
 *
 * The interior is a plain barycentric grid over the three corners, normalised
 * back onto the sphere. Weights are exact binary fractions and the corners are
 * shared, so a vertex on the boundary between two chunks comes out identical in
 * both of them - which is the whole of the seam handling.
 */
function buildChunk(k: number, resident: number) {
  const o = k * 9
  const ax = corners[o]
  const ay = corners[o + 1]
  const az = corners[o + 2]
  const bx = corners[o + 3]
  const by = corners[o + 4]
  const bz = corners[o + 5]
  const cx = corners[o + 6]
  const cy = corners[o + 7]
  const cz = corners[o + 8]

  let worst = 127
  let at = 0
  for (let i = 0; i <= N; i++) {
    const wa = (N - i) / N
    for (let j = 0; j <= i; j++) {
      const wb = (i - j) / N
      const wc = j / N

      let x = ax * wa + bx * wb + cx * wc
      let y = ay * wa + by * wb + cy * wc
      let z = az * wa + bz * wb + cz * wc
      const inverse = 1 / Math.sqrt(x * x + y * y + z * z)
      x *= inverse
      y *= inverse
      z *= inverse

      scratch[at] = x
      scratch[at + 1] = y
      scratch[at + 2] = z

      // Longitude eastward from the antimeridian and latitude southward from
      // the north pole, both as fractions. A pole has no meridian of its own,
      // but every chunk that reaches one reaches it at exactly (0, +/-1, 0), so
      // they all ask the same question and get the same answer.
      const latitude = Math.asin(y < -1 ? -1 : y > 1 ? 1 : y)
      const u = (Math.atan2(x, z) + Math.PI) / (2 * Math.PI)
      const v = (Math.PI / 2 - latitude) / Math.PI
      scratch[at + 3] = height(u, v, TARGET_TILE_LEVEL)
      if (sampledLevel < worst) worst = sampledLevel

      at += 4
    }
  }

  setMeshChunk(k, scratch)
  sampled[k] = worst
  stamped[k] = resident
}
