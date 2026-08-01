/**
 * Streaming terrain: one archive, fetched a tile at a time, sampled at
 * whatever resolution has actually turned up.
 *
 * `scripts/build-terrain.mjs` writes a pyramid of 128-sample tiles rooted so
 * that level 0 is four tiles around by two down - the eight lon/lat boxes of
 * the octahedron the quadtree starts from - and doubling each level after
 * that. Each level is its own file: a header, an index, and the tile payloads
 * back to back.
 *
 * Level 0 comes whole, in one plain GET. It is 191 kB, it is the entire world,
 * and nothing can be drawn without it, so there is no sense paying a round trip
 * for an index and another for the tiles. Deeper levels are opened only when
 * something wants them - one small range request for the index, then ranges for
 * the tiles - which every static host serves with no server logic anywhere. A
 * host that will not honour Range says so by sending the whole file, and this
 * notices and serves every tile out of memory thereafter.
 *
 * What that buys is the difference between 191 kB and 3.6 MB before the globe
 * has any shape. Level 0 draws the whole world; everything after it is detail
 * fetched for the part being looked at, and a session that never leaves one
 * hemisphere never pays for the other.
 *
 * A level that was never deployed is asked for once, takes the 404, and is
 * written off for good - so the deep levels are genuinely optional, and a
 * deployment can add one by uploading a file.
 *
 * Sampling always succeeds. Asking for a level that has not arrived walks up
 * the pyramid to the finest ancestor that has, so the picture is never missing,
 * only coarser than it will be shortly. Callers are told which level answered,
 * because a vertex that had to settle for a coarse one wants asking again once
 * the fine one lands.
 */

const MAGIC = 'ERSETILE'
/** 2 is one file per level; 1 was the whole pyramid in one. */
const VERSION = 2
const HEADER_BYTES = 32
const INDEX_ENTRY_BYTES = 16

const EARTH_RADIUS_M = 6_371_000

/**
 * Near the poles a cell of longitude becomes vanishingly narrow, so an eastward
 * slope divides by something close to zero. The error is confined to the last
 * fraction of a degree, where the cells are far narrower than a pixel anyway.
 */
const MIN_COS_LAT = 0.02

/** How many tiles to hold decoded. Level 0 is pinned and never counted out. */
const CACHE_LIMIT = 320

/**
 * Requests in flight at once. Each one now covers a whole run of tiles rather
 * than a single tile, so this is a good deal more data than the number
 * suggests, and HTTP/2 multiplexes them down one connection anyway.
 */
const MAX_IN_FLIGHT = 8

export type Relief = {
  /** Metres above sea level. */
  height: number
  /** Rise in metres per metre of ground, eastward. */
  east: number
  /** Rise in metres per metre of ground, northward. */
  north: number
}

export function relief(): Relief {
  return { height: 0, east: 0, north: 0 }
}

type Tile = {
  samples: Int16Array
  /** Frame it was last read, for eviction. */
  used: number
}

export type Terrain = {
  /** Number of levels in the archive; the finest is `levels - 1`. */
  levels: number
  /** Interior samples per tile side. */
  tileSize: number
  /** Whether enough has arrived for the globe to have a shape. */
  ready: boolean
  /** Largest lift anywhere, in globe radii, from the index's per-tile maxima. */
  maxLift: number
  /** Bytes fetched so far, for the readout. */
  fetched: number
  /** Tiles decoded and held. */
  resident: number
}

// --- Archive --------------------------------------------------------------

/**
 * One level's file, once its index has been read.
 *
 * The index is parallel typed arrays rather than objects: it is walked per
 * frame to decide what to ask for, and there is an entry per tile of the level.
 * Offsets are within this file, so a coalesced run never spans two of them.
 */
type LevelFile = {
  url: string
  dataOffset: number
  /** Byte offset of each tile's payload, relative to `dataOffset`. */
  offsets: Uint32Array
  lengths: Uint32Array
  /** Metres by which each tile departs from what its parent already said. */
  errors: Uint16Array
  /** The whole file, when it was fetched whole rather than by range. */
  whole: Uint8Array | null
}

/**
 * How far each level has got. A level that 404s is `missing` for good: the
 * deeper files are optional, and sampling simply falls back to what is there.
 */
type LevelStatus = 'absent' | 'opening' | 'ready' | 'missing'

type Archive = {
  /** Files are `<base>-<level>.bin`. */
  base: string
  levels: number
  tileSize: number
  border: number
  stored: number
  files: (LevelFile | null)[]
  status: LevelStatus[]
  /** Index of the first tile of each level, in the global numbering. */
  levelBase: Uint32Array
}

let archive: Archive | null = null
const tiles = new Map<number, Tile>()
const pending = new Set<number>()
/** Tiles asked for this frame but not yet fetched, best first. */
let wanted: number[] = []
let inFlight = 0
let clock = 0
let bytesFetched = 0

const state: Terrain = {
  levels: 0,
  tileSize: 0,
  ready: false,
  maxLift: 0,
  fetched: 0,
  resident: 0,
}

export function terrainState(): Terrain {
  state.fetched = bytesFetched
  state.resident = tiles.size
  return state
}

/**
 * Read the header and index, then the eight tiles of level 0.
 *
 * Resolves once level 0 is in, which is the point the globe can be drawn at
 * all. Everything finer arrives later and on demand.
 */
export async function openTerrain(base: string): Promise<void> {
  // Level 0 comes whole, in one plain GET. It is 191 kB, it is the entire
  // world, and nothing can be drawn without it - so there is no sense paying a
  // round trip for the index and another for the tiles, and a 200 is cached by
  // everything without special handling.
  const response = await fetch(`${base}-0.bin`)
  if (!response.ok) throw new Error(`Terrain fetch failed: HTTP ${response.status}`)
  const body = new Uint8Array(await response.arrayBuffer())
  bytesFetched += body.byteLength

  const head = readHeader(body)
  if (head.level !== 0) throw new Error(`Expected level 0, got level ${head.level}`)

  const levelBase = new Uint32Array(head.levels + 1)
  let at = 0
  for (let z = 0; z < head.levels; z++) {
    levelBase[z] = at
    at += tilesAcross(z) * tilesDown(z)
  }
  levelBase[head.levels] = at

  archive = {
    base,
    levels: head.levels,
    tileSize: head.tileSize,
    border: head.border,
    stored: head.tileSize + 2 * head.border,
    files: new Array(head.levels).fill(null),
    status: new Array(head.levels).fill('absent'),
    levelBase,
  }
  archive.files[0] = readIndex(`${base}-0.bin`, body, head, body)
  archive.status[0] = 'ready'

  state.levels = head.levels
  state.tileSize = head.tileSize
  // Taken from the finest level at build time, so a client holding only level 0
  // still knows how far terrain can stand off the sphere. Level 0's own maxima
  // are averaged down and would size the shaded region short, which saws the
  // tops off mountains at the limb.
  state.maxLift = head.peak / EARTH_RADIUS_M
  // Stamps start at zero, so the clock must not; otherwise the first frame
  // reads every tile as already asked for.
  asked = new Uint32Array(at)
  clock = 1

  // Decode level 0's eight tiles up front; the globe cannot draw without them.
  const file = archive.files[0]!
  await Promise.all(
    Array.from({ length: tilesAcross(0) * tilesDown(0) }, (_, i) =>
      decode(
        file.whole!.subarray(
          file.dataOffset + file.offsets[i],
          file.dataOffset + file.offsets[i] + file.lengths[i],
        ),
        archive!.stored,
      ).then((samples) => tiles.set(i, { samples, used: 1 })),
    ),
  )
  state.ready = true
}

type Header = {
  tileSize: number
  border: number
  levels: number
  level: number
  indexBytes: number
  dataOffset: number
  tileCount: number
  peak: number
}

function readHeader(bytes: Uint8Array): Header {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let magic = ''
  for (let i = 0; i < 8; i++) magic += String.fromCharCode(view.getUint8(i))
  if (magic !== MAGIC) throw new Error('Terrain file has the wrong magic')
  if (view.getUint16(8, true) !== VERSION) {
    throw new Error(`Terrain file is version ${view.getUint16(8, true)}, expected ${VERSION}`)
  }
  return {
    tileSize: view.getUint16(10, true),
    border: view.getUint8(12),
    levels: view.getUint8(13),
    level: view.getUint8(14),
    indexBytes: view.getUint32(16, true),
    dataOffset: view.getUint32(20, true),
    tileCount: view.getUint32(24, true),
    peak: view.getInt16(28, true),
  }
}

function readIndex(
  url: string,
  index: Uint8Array,
  head: Header,
  whole: Uint8Array | null,
): LevelFile {
  const offsets = new Uint32Array(head.tileCount)
  const lengths = new Uint32Array(head.tileCount)
  const errors = new Uint16Array(head.tileCount)
  const entries = new DataView(index.buffer, index.byteOffset, index.byteLength)
  for (let i = 0; i < head.tileCount; i++) {
    const at = HEADER_BYTES + i * INDEX_ENTRY_BYTES
    offsets[i] = entries.getUint32(at, true)
    lengths[i] = entries.getUint32(at + 4, true)
    errors[i] = entries.getUint16(at + 8, true)
  }
  return { url, dataOffset: head.dataOffset, offsets, lengths, errors, whole }
}

/**
 * Read a level's index, once, the first time anything wants a tile from it.
 *
 * A level that is not deployed answers 404 and is written off for good, which
 * is what makes the deep levels optional: sampling falls back to the finest
 * ancestor that did arrive, so the picture is coarser and nothing breaks.
 */
function openLevel(z: number) {
  const it = archive
  if (!it || it.status[z] !== 'absent') return
  it.status[z] = 'opening'

  const url = `${it.base}-${z}.bin`
  void (async () => {
    try {
      // One request covers the header and the index for any level worth
      // shipping: level 4 is 2048 tiles, which is 32 kB of index.
      const first = await fetchRange(url, 0, 65535)
      const head = readHeader(first.body)
      let index = first.body
      if (!first.ranged) {
        it.files[z] = readIndex(url, index, head, first.body)
      } else {
        if (HEADER_BYTES + head.indexBytes > index.byteLength) {
          index = (await fetchRange(url, 0, head.dataOffset - 1)).body
        }
        it.files[z] = readIndex(url, index, head, null)
      }
      it.status[z] = 'ready'
    } catch {
      // Not deployed, which is a normal way to ship: coarse levels in the
      // package, fine ones hosted or not at all.
      it.status[z] = 'missing'
    }
  })()
}

const tilesAcross = (z: number) => 4 << z
const tilesDown = (z: number) => 2 << z

/** The archive's tile index for a tile at a level. */
function tileId(z: number, x: number, y: number): number {
  return archive!.levelBase[z] + y * tilesAcross(z) + x
}

type Ranged = { body: Uint8Array; ranged: boolean }

async function fetchRange(url: string, from: number, to: number): Promise<Ranged> {
  const response = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } })
  if (!response.ok) throw new Error(`Terrain fetch failed: HTTP ${response.status}`)
  const body = new Uint8Array(await response.arrayBuffer())
  bytesFetched += body.byteLength
  // 206 means the range was honoured. Anything else and this is the whole file.
  return { body, ranged: response.status === 206 }
}

/**
 * Fetch one stretch of a level's file and decode every tile in it.
 *
 * One request however many tiles the run covers, which is the whole point of
 * coalescing; the payloads are cut back out of the response by the offsets the
 * index already gives.
 */
async function loadRun(run: Run): Promise<void> {
  const it = archive!
  const file = it.files[run.level]
  if (!file) return
  const fresh = run.ids.filter((id) => !tiles.has(id) && !pending.has(id))
  if (!fresh.length) return
  fresh.forEach((id) => pending.add(id))

  const base = it.levelBase[run.level]
  try {
    let block: Uint8Array
    if (file.whole) {
      block = file.whole.subarray(file.dataOffset + run.from, file.dataOffset + run.to)
    } else {
      block = (
        await fetchRange(file.url, file.dataOffset + run.from, file.dataOffset + run.to - 1)
      ).body
    }

    // All at once, not one after another. Inflating goes through
    // `DecompressionStream`, so every tile costs an await, and the render loop
    // owns the main thread between them - a run of a hundred tiles awaited in
    // turn waits a frame apiece and takes seconds. Started together they
    // overlap, and the run lands in one go.
    const decoded = await Promise.all(
      fresh.map((id) => {
        const at = file.offsets[id - base] - run.from
        return decode(block.subarray(at, at + file.lengths[id - base]), it.stored)
      }),
    )
    fresh.forEach((id, k) => tiles.set(id, { samples: decoded[k], used: clock }))
    evict()
  } catch (error) {
    console.warn(`Terrain run at ${run.from} unavailable.`, error)
  } finally {
    fresh.forEach((id) => pending.delete(id))
  }
}

/**
 * Inflate a tile and undo the predictor.
 *
 * Read back through `DecompressionStream` rather than as an image, because
 * drawing a 16-bit PNG to a canvas is the one thing guaranteed to throw the
 * low byte away.
 */
async function decode(packed: Uint8Array, stored: number): Promise<Int16Array> {
  const stream = new Blob([packed as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
  const buffer = await new Response(stream).arrayBuffer()
  const samples = new Int16Array(buffer)

  // Each sample was stored as the difference from the one to its left, and the
  // first of each row as the difference from the row above. Int16Array wraps on
  // overflow, which is the same modular arithmetic the encoder relied on.
  for (let y = 0; y < stored; y++) {
    const row = y * stored
    samples[row] += y > 0 ? samples[row - stored] : 0
    for (let x = 1; x < stored; x++) samples[row + x] += samples[row + x - 1]
  }
  return samples
}

/** Drop the least recently sampled tiles. Level 0 is pinned; it is the world. */
function evict() {
  const it = archive!
  if (tiles.size <= CACHE_LIMIT) return
  const pinned = it.levelBase[1]
  const ids = [...tiles.keys()]
    .filter((id) => id >= pinned)
    .sort((a, b) => tiles.get(a)!.used - tiles.get(b)!.used)
  for (let i = 0; i < ids.length && tiles.size > CACHE_LIMIT; i++) tiles.delete(ids[i])
}

// --- Requests -------------------------------------------------------------

/**
 * Levels to hold in full, everywhere, whatever the camera is looking at.
 *
 * These are the levels that ship in the package, so there is nothing to gain by
 * rationing them: the whole of level 2 is 2.7 MB, it is contiguous in its own
 * file, and coalescing turns it into a single range request. Fetching it up
 * front means the globe is never coarse in one place because you happened to
 * arrive from another, and panning never has to wait.
 *
 * Past this, detail is fetched for what is on screen, as before.
 */
export const RESIDENT_LEVELS = 2

/**
 * Ask for everything up to `RESIDENT_LEVELS`, everywhere.
 *
 * Called every frame and costs a map lookup per tile once they have landed -
 * a hundred and sixty of them, which is nothing. Levels whose index has not
 * been read yet open here and are picked up on a later frame.
 */
export function prefetchResident() {
  const it = archive
  if (!it) return
  for (let z = 1; z <= Math.min(RESIDENT_LEVELS, it.levels - 1); z++) {
    if (it.status[z] !== 'ready') {
      openLevel(z)
      continue
    }
    const across = tilesAcross(z)
    const down = tilesDown(z)
    for (let y = 0; y < down; y++) {
      for (let x = 0; x < across; x++) want(z, x, y)
    }
  }
}

/**
 * Note that a tile would be useful this frame.
 *
 * Nothing is fetched here: the frame collects what it wants and `pump` decides
 * what is worth asking for, because the renderer touches the same tile from
 * thousands of vertices and the useful ordering is only known once it has
 * finished looking.
 */
export function want(z: number, x: number, y: number) {
  const it = archive
  if (!it || z <= 0 || z >= it.levels) return
  const id = tileId(z, x, y)
  if (asked[id] === clock) return
  asked[id] = clock
  if (tiles.has(id) || pending.has(id)) return
  // The level's index has to be in hand before a tile of it can be asked for by
  // offset. Reading it is one small request; until it lands the ask is simply
  // dropped, and the next frame - which wants much the same ground - raises it
  // again.
  if (it.status[z] !== 'ready') {
    openLevel(z)
    return
  }
  wanted.push(id)
}

/**
 * The same, for a normalised position rather than a tile index.
 *
 * Called from the selection walk, once per leaf, so thousands of times a frame
 * over a few dozen distinct tiles - hence the stamp above, which turns all but
 * the first ask per tile into one array read.
 */
export function wantAt(z: number, u: number, v: number) {
  if (!archive || z <= 0 || z >= archive.levels) return
  want(z, tileIndexX(z, u), tileIndexY(z, v))
}

/** Frame each tile was last asked for, so repeats within a frame cost nothing. */
let asked = new Uint32Array(0)

/**
 * Issue whatever the frame asked for, coarsest first.
 *
 * Coarsest first because a fine tile is refinement of a coarse one that is
 * already being drawn, and arriving out of order would mean detail appearing
 * in a hole. Within a level the tiles that differ most from what their parent
 * already said go first, so the fetch budget goes on mountains rather than on
 * the middle of an ocean, which the parent got right.
 */
export function pump() {
  const it = archive
  if (!it || wanted.length === 0) return

  // Tiles a view wants are neighbours on the globe, and neighbours on the globe
  // are neighbours in the file - the level is laid out row by row, and what is
  // on screen at one level is a band of rows. So the run of bytes covering
  // twenty tiles is very often one run, and asking for it once instead of
  // twenty times is the difference between one round trip and twenty.
  //
  // Measured over a real session: 421 tile fetches become 92 requests, for
  // exactly the same bytes.
  runs.length = 0
  // By level first, because offsets are within a level's own file and a run
  // cannot span two of them; then by offset, so neighbours end up adjacent.
  wanted.sort((a, b) => {
    const za = levelOf(a)
    const zb = levelOf(b)
    if (za !== zb) return za - zb
    return it.files[za]!.offsets[a - it.levelBase[za]] - it.files[zb]!.offsets[b - it.levelBase[zb]]
  })

  let run: Run | null = null
  for (const id of wanted) {
    if (tiles.has(id) || pending.has(id)) continue
    const z = levelOf(id)
    const file = it.files[z]
    if (!file) continue
    const local = id - it.levelBase[z]
    const from = file.offsets[local]
    if (run && run.level === z && from === run.to) {
      run.to = from + file.lengths[local]
      run.ids.push(id)
      if (file.errors[local] > run.error) run.error = file.errors[local]
      continue
    }
    run = {
      from,
      to: from + file.lengths[local],
      ids: [id],
      level: z,
      error: file.errors[local],
    }
    runs.push(run)
  }

  // Coarsest first, because a fine tile refines a coarse one that is already
  // being drawn and arriving out of order would put detail in a hole. Within a
  // level the runs that differ most from what their parent already said go
  // first, so the budget goes on mountains rather than on the middle of an
  // ocean, which the parent got right.
  runs.sort((a, b) => (a.level !== b.level ? a.level - b.level : b.error - a.error))

  for (let i = 0; i < runs.length && inFlight < MAX_IN_FLIGHT; i++) {
    inFlight++
    void loadRun(runs[i]).finally(() => {
      inFlight--
    })
  }
  // Whatever did not fit is simply asked for again next frame, by a selection
  // that will have moved on and may not want it any more.
  wanted.length = 0
}

/** A contiguous stretch of one level's file, covering several tiles. */
type Run = {
  /** Offsets within that level's file, relative to its data section. */
  from: number
  to: number
  ids: number[]
  /** The level the run belongs to, and its largest error, for ordering. */
  level: number
  error: number
}

let runs: Run[] = []

function levelOf(id: number): number {
  const base = archive!.levelBase
  for (let z = archive!.levels - 1; z >= 0; z--) if (id >= base[z]) return z
  return 0
}

/** Advance the clock used for eviction. One tick per frame. */
export function tick() {
  clock++
}

// --- Sampling -------------------------------------------------------------

/**
 * Longitude fraction from the antimeridian and latitude fraction from the
 * north pole, both in 0..1. Resolution-independent on purpose: the rasteriser
 * interpolates these across a triangle without knowing or caring which level
 * will end up answering for them.
 */
export function levelWidth(z: number) {
  return 512 << z
}

/**
 * Height in metres at a normalised position, from the finest level available
 * at or above `level`.
 *
 * Returns the height; `sampledLevel` says which level answered.
 */
export let sampledLevel = 0

export function height(u: number, v: number, level: number): number {
  const it = archive
  if (!it) return 0

  for (let z = Math.min(level, it.levels - 1); z >= 0; z--) {
    const tile = at(z, u, v)
    if (!tile) continue
    sampledLevel = z
    const stored = it.stored
    const { fx, fy } = local(it, z, u, v)

    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    const rowA = y0 * stored
    const rowB = rowA + stored
    const top = tile[rowA + x0] + (tile[rowA + x0 + 1] - tile[rowA + x0]) * tx
    const bottom = tile[rowB + x0] + (tile[rowB + x0 + 1] - tile[rowB + x0]) * tx
    return top + (bottom - top) * ty
  }
  sampledLevel = -1
  return 0
}

/**
 * Height and true slope at a normalised position.
 *
 * Slope comes from the same four taps as the height: the bilinear patch those
 * four corners define has an exact gradient, so it costs no extra reads. It is
 * returned as rise per metre of ground rather than per sample, so the caller
 * does not have to know which level answered - which it cannot, when a fine
 * tile is still on its way and a coarse one is standing in.
 */
export function sampleRelief(u: number, v: number, level: number, out: Relief): number {
  const it = archive
  if (!it) {
    out.height = 0
    out.east = 0
    out.north = 0
    return -1
  }

  for (let z = Math.min(level, it.levels - 1); z >= 0; z--) {
    const tile = at(z, u, v)
    if (!tile) continue

    const stored = it.stored
    const { fx, fy } = local(it, z, u, v)
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    const rowA = y0 * stored
    const rowB = rowA + stored

    const h00 = tile[rowA + x0]
    const h10 = tile[rowA + x0 + 1]
    const h01 = tile[rowB + x0]
    const h11 = tile[rowB + x0 + 1]

    const top = h00 + (h10 - h00) * tx
    const bottom = h01 + (h11 - h01) * tx
    out.height = top + (bottom - top) * ty

    const perSampleEast = h10 - h00 + (h11 - h01 - (h10 - h00)) * ty
    // Rows run north to south, so a rise going down the grid is a fall going
    // north.
    const perSampleNorth = -(h01 - h00 + (h11 - h10 - (h01 - h00)) * tx)

    // Ground covered by one sample, which is what turns those into slopes.
    const width = levelWidth(z)
    const latitude = (0.5 - v) * Math.PI
    const cosLat = Math.max(MIN_COS_LAT, Math.cos(latitude))
    out.east = (perSampleEast * width) / (2 * Math.PI * EARTH_RADIUS_M * cosLat)
    out.north = (perSampleNorth * (width / 2)) / (Math.PI * EARTH_RADIUS_M)
    return z
  }

  out.height = 0
  out.east = 0
  out.north = 0
  return -1
}

/** The decoded tile covering a position at a level, if it is resident. */
function at(z: number, u: number, v: number): Int16Array | null {
  const x = tileIndexX(z, u)
  const y = tileIndexY(z, v)
  const tile = tiles.get(tileId(z, x, y))
  if (!tile) return null
  tile.used = clock
  return tile.samples
}

export function tileIndexX(z: number, u: number): number {
  const across = tilesAcross(z)
  // Longitude wraps, and the seam fix upstream can carry u past 1.
  let x = Math.floor((u - Math.floor(u)) * across)
  if (x < 0) x = 0
  else if (x >= across) x = across - 1
  return x
}

export function tileIndexY(z: number, v: number): number {
  const down = tilesDown(z)
  let y = Math.floor(v * down)
  if (y < 0) y = 0
  else if (y >= down) y = down - 1
  return y
}

/**
 * Position within a tile's stored block, border included.
 *
 * Samples sit at cell centres, so the interior runs from -0.5 to tileSize-0.5
 * before the border shifts it; the border is what makes both ends land inside
 * the block and lets the four taps above never need a neighbouring tile.
 */
const site = { fx: 0, fy: 0 }

function local(it: Archive, z: number, u: number, v: number) {
  const width = levelWidth(z)
  const height = width / 2
  const wrapped = u - Math.floor(u)
  site.fx =
    wrapped * width - 0.5 - tileIndexX(z, u) * it.tileSize + it.border
  site.fy = v * height - 0.5 - tileIndexY(z, v) * it.tileSize + it.border
  return site
}
