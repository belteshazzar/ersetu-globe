//
//  The globe's surface as one static mesh, built once and left on the GPU.
//  Port of src/globe/mesh.ts.
//
//  A vertex carries a direction and a height above sea level, and neither ever
//  changes: exaggeration is a shader uniform, the camera is a shader uniform,
//  colour is computed per fragment. So the whole globe is subdivided uniformly
//  to the finest spacing the archive can answer for and handed over as static
//  buffers; a frame is a few uniform writes and one draw call per chunk.
//
//  Chunks keep every index buffer inside sixteen bits, let the back hemisphere
//  and anything off screen be dropped for the cost of a dot product, and let
//  the build be spread over frames rather than freezing one.
//

import Foundation
import QuartzCore

/// A base face spans 90 degrees and halves each level; a level-0 tile samples
/// every 0.703 degrees over 128 samples, so a node at level L has the same
/// spacing as a tile at level L - 7.
private let TILE_LEVEL_OFFSET = 7

/// The tile level the mesh is built to match - the same level fetched for the
/// whole globe up front, because the two have to agree.
private let TARGET_TILE_LEVEL = RESIDENT_LEVELS

/// Node level of the mesh: level 9, for tile level 2.
private let MESH_LEVEL = TILE_LEVEL_OFFSET + TARGET_TILE_LEVEL

/// Node level a chunk sits at: 8 * 4^2 = 128 chunks of 8,385 vertices, just
/// inside what an unsigned short index can reach.
private let CHUNK_LEVEL = 2

let CHUNK_COUNT = 8 << (2 * CHUNK_LEVEL)
/// Divisions along a chunk's edge.
private let N = 1 << (MESH_LEVEL - CHUNK_LEVEL)
private let VERTICES_PER_CHUNK = (N + 1) * (N + 2) / 2
private let TRIANGLES_PER_CHUNK = N * N

/// How long a frame may spend building chunks, in seconds. The build is a
/// one-off costing perhaps half a second in total; rationed like this the
/// globe simply sharpens over the first second, front first.
private let BUILD_BUDGET_SECONDS = 0.005

/// A chunk that has never been built.
private let UNBUILT: Int8 = -2

// The base octahedron: faces are congruent, corners fall on the poles and the
// equator, and each face subdivides into four by joining edge midpoints.
private let BASE_DIRECTIONS: [[Double]] = [
    [0, 1, 0],  // north pole
    [0, -1, 0],  // south pole
    [0, 0, 1],  // longitude 0
    [1, 0, 0],  // longitude 90 E
    [0, 0, -1],  // longitude 180
    [-1, 0, 0],  // longitude 90 W
]

/// The eight faces, wound anticlockwise seen from outside the globe - what the
/// renderer's counter-clockwise front face wants. Subdivision preserves
/// winding, so this is the only place it is decided.
private let BASE_FACES: [[Int]] = [
    [0, 2, 3],
    [0, 3, 4],
    [0, 4, 5],
    [0, 5, 2],
    [1, 3, 2],
    [1, 4, 3],
    [1, 5, 4],
    [1, 2, 5],
]

struct MeshStats {
    /// Triangles drawn this frame.
    var triangles = 0
    /// Chunks drawn this frame.
    var drawn = 0
    /// Chunks built so far.
    var built = 0
    /// Total chunks in the mesh.
    var chunks = CHUNK_COUNT
    /// The coarsest tile level any built chunk had to settle for - the level
    /// the whole globe is guaranteed at, not the best anywhere.
    var detail = -1
}

final class SurfaceMesh {
    private let renderer: MetalRenderer
    private let terrain: Terrain

    /// Three corner directions per chunk, nine doubles apiece.
    private var corners = [Double](repeating: 0, count: CHUNK_COUNT * 9)
    /// The bounding cap of each chunk: centre direction and the sine of its
    /// angular radius.
    private var capX = [Double](repeating: 0, count: CHUNK_COUNT)
    private var capY = [Double](repeating: 0, count: CHUNK_COUNT)
    private var capZ = [Double](repeating: 0, count: CHUNK_COUNT)
    private var capSin = [Double](repeating: 0, count: CHUNK_COUNT)

    /// The finest tile level that answered for every vertex of a chunk.
    private var sampled = [Int8](repeating: UNBUILT, count: CHUNK_COUNT)
    /// Tiles resident when a chunk was last built, so a retry only happens on
    /// news.
    private var stamped = [Int](repeating: -1, count: CHUNK_COUNT)

    /// Chunks to draw this frame.
    private(set) var visible: [Int] = []
    private var shown = [Bool](repeating: false, count: CHUNK_COUNT)

    /// One chunk's vertices, refilled per build and handed to the GPU.
    private var scratch = [Float](repeating: 0, count: VERTICES_PER_CHUNK * 4)

    private var seeded = false
    private(set) var stats = MeshStats()

    init(renderer: MetalRenderer, terrain: Terrain) {
        self.renderer = renderer
        self.terrain = terrain
        visible.reserveCapacity(CHUNK_COUNT)
    }

    /// Cull, build what the budget allows, and report what to draw. Once the
    /// mesh is complete this is a hundred and twenty-eight dot products.
    func update(camera: Camera, viewport: ViewportSize, exaggeration: Double) {
        if !seeded { seed() }

        selectVisible(camera: camera, viewport: viewport, exaggeration: exaggeration)
        build()

        stats.drawn = visible.count
        stats.triangles = visible.count * TRIANGLES_PER_CHUNK
    }

    /// Lay out the chunk corners and the index buffer they all draw through.
    private func seed() {
        seeded = true

        var at = 0
        func place(_ a: [Double], _ b: [Double], _ c: [Double], _ level: Int) {
            if level == CHUNK_LEVEL {
                for i in 0..<3 { corners[at + i] = a[i] }
                for i in 0..<3 { corners[at + 3 + i] = b[i] }
                for i in 0..<3 { corners[at + 6 + i] = c[i] }
                at += 9
                return
            }
            // Midpoints are computed from the shared endpoints and handed to
            // every child that touches them, so two chunks either side of an
            // edge get the same corner to the bit - which is what stops a
            // crack opening between them.
            let ab = mid(a, b)
            let bc = mid(b, c)
            let ca = mid(c, a)
            place(a, ab, ca, level + 1)
            place(ab, b, bc, level + 1)
            place(ca, bc, c, level + 1)
            place(ab, bc, ca, level + 1)
        }

        for face in BASE_FACES {
            place(
                BASE_DIRECTIONS[face[0]], BASE_DIRECTIONS[face[1]], BASE_DIRECTIONS[face[2]], 0)
        }

        for k in 0..<CHUNK_COUNT { capOf(k) }

        renderer.setMeshIndices(buildIndices())
    }

    /// The normalised midpoint of two directions.
    private func mid(_ a: [Double], _ b: [Double]) -> [Double] {
        let x = a[0] + b[0]
        let y = a[1] + b[1]
        let z = a[2] + b[2]
        let inverse = 1 / (x * x + y * y + z * z).squareRoot()
        return [x * inverse, y * inverse, z * inverse]
    }

    /// The cap that contains a chunk: the direction of its centre, and how far
    /// its corners lean away from it. The patch bulges out of the flat
    /// triangle its corners span, but never past the sphere, so a cap through
    /// the corners contains the whole of it.
    private func capOf(_ k: Int) {
        let o = k * 9
        var x = corners[o] + corners[o + 3] + corners[o + 6]
        var y = corners[o + 1] + corners[o + 4] + corners[o + 7]
        var z = corners[o + 2] + corners[o + 5] + corners[o + 8]
        let inverse = 1 / (x * x + y * y + z * z).squareRoot()
        x *= inverse
        y *= inverse
        z *= inverse

        var cosine = 1.0
        for i in 0..<3 {
            let c = o + i * 3
            let dot = x * corners[c] + y * corners[c + 1] + z * corners[c + 2]
            if dot < cosine { cosine = dot }
        }

        capX[k] = x
        capY[k] = y
        capZ[k] = z
        capSin[k] = max(0, 1 - cosine * cosine).squareRoot()
    }

    /// The triangle list, shared by every chunk. Vertices are laid out row by
    /// row from the first corner: row i holds i + 1 of them, so the vertex at
    /// (i, j) is at i(i+1)/2 + j.
    private func buildIndices() -> [UInt16] {
        var out = [UInt16](repeating: 0, count: TRIANGLES_PER_CHUNK * 3)
        var at = 0
        for i in 1...N {
            let above = (i - 1) * i / 2
            let row = i * (i + 1) / 2
            for j in 0..<i {
                out[at] = UInt16(above + j)
                out[at + 1] = UInt16(row + j)
                out[at + 2] = UInt16(row + j + 1)
                at += 3
                if j < i - 1 {
                    out[at] = UInt16(above + j)
                    out[at + 1] = UInt16(row + j + 1)
                    out[at + 2] = UInt16(above + j + 1)
                    at += 3
                }
            }
        }
        return out
    }

    /// Work out which chunks can contribute a pixel: two tests against the
    /// chunk's bounding cap, both widened by however far the tallest ground is
    /// currently displaced - one for the far side of the globe, one for the
    /// edges of the viewport.
    private func selectVisible(camera: Camera, viewport: ViewportSize, exaggeration: Double) {
        let slack = terrain.maxLift * exaggeration
        visible.removeAll(keepingCapacity: true)
        for k in 0..<CHUNK_COUNT { shown[k] = false }

        for k in 0..<CHUNK_COUNT {
            let x = capX[k]
            let y = capY[k]
            let z = capZ[k]

            let x1 = x * camera.cosLon - z * camera.sinLon
            let z1 = x * camera.sinLon + z * camera.cosLon
            let viewY = y * camera.cosLat - z1 * camera.sinLat
            let viewZ = y * camera.sinLat + z1 * camera.cosLat

            let reach = capSin[k] + slack
            // Wholly behind the globe.
            if viewZ + reach < 0 { continue }

            let r = reach * camera.radius
            let sx = camera.cx + x1 * camera.radius
            let sy = camera.cy - viewY * camera.radius
            if sx + r < 0 || sx - r > viewport.width { continue }
            if sy + r < 0 || sy - r > viewport.height { continue }

            shown[k] = true
            visible.append(k)
        }
    }

    /// Build whatever the frame's budget allows, unbuilt chunks first - one
    /// unbuilt patch on the far side holds up the whole surface, because the
    /// fallback disc covers the globe until every chunk exists.
    private func build() {
        guard terrain.ready else { return }
        let resident = terrain.resident

        var pending: [Int] = []
        for k in visible where sampled[k] == UNBUILT { pending.append(k) }
        for k in 0..<CHUNK_COUNT where !shown[k] && sampled[k] == UNBUILT { pending.append(k) }
        for k in visible where sampled[k] != UNBUILT && wants(k, resident) { pending.append(k) }
        for k in 0..<CHUNK_COUNT
        where !shown[k] && sampled[k] != UNBUILT && wants(k, resident) {
            pending.append(k)
        }
        if !pending.isEmpty {
            let deadline = CACurrentMediaTime() + BUILD_BUDGET_SECONDS
            for k in pending {
                buildChunk(k, resident)
                if CACurrentMediaTime() >= deadline { break }
            }
        }

        // The globe is only as good as its worst patch, so the readout is the
        // coarsest level anything settled for.
        var worst = Int8(TARGET_TILE_LEVEL)
        var built = 0
        for k in 0..<CHUNK_COUNT {
            if sampled[k] == UNBUILT { continue }
            built += 1
            if sampled[k] < worst { worst = sampled[k] }
        }
        stats.built = built
        stats.detail = built == 0 ? -1 : Int(worst)
    }

    private func wants(_ k: Int, _ resident: Int) -> Bool {
        if sampled[k] == UNBUILT { return true }
        return sampled[k] < Int8(TARGET_TILE_LEVEL) && stamped[k] != resident
    }

    /// Fill one chunk's vertices and hand them to the GPU. The interior is a
    /// plain barycentric grid over the three corners, normalised back onto the
    /// sphere; weights are exact binary fractions and the corners are shared,
    /// so a boundary vertex comes out identical in both chunks - which is the
    /// whole of the seam handling.
    private func buildChunk(_ k: Int, _ resident: Int) {
        let o = k * 9
        let ax = corners[o], ay = corners[o + 1], az = corners[o + 2]
        let bx = corners[o + 3], by = corners[o + 4], bz = corners[o + 5]
        let cx = corners[o + 6], cy = corners[o + 7], cz = corners[o + 8]

        var worst: Int8 = 127
        var at = 0
        for i in 0...N {
            let wa = Double(N - i) / Double(N)
            for j in 0...i {
                let wb = Double(i - j) / Double(N)
                let wc = Double(j) / Double(N)

                var x = ax * wa + bx * wb + cx * wc
                var y = ay * wa + by * wb + cy * wc
                var z = az * wa + bz * wb + cz * wc
                let inverse = 1 / (x * x + y * y + z * z).squareRoot()
                x *= inverse
                y *= inverse
                z *= inverse

                scratch[at] = Float(x)
                scratch[at + 1] = Float(y)
                scratch[at + 2] = Float(z)

                // Longitude eastward from the antimeridian and latitude
                // southward from the north pole, both as fractions.
                let latitude = asin(min(1, max(-1, y)))
                let u = (atan2(x, z) + .pi) / (2 * .pi)
                let v = (Double.pi / 2 - latitude) / .pi
                scratch[at + 3] = Float(terrain.height(u: u, v: v, level: TARGET_TILE_LEVEL))
                if Int8(terrain.sampledLevel) < worst { worst = Int8(terrain.sampledLevel) }

                at += 4
            }
        }

        renderer.setMeshChunk(k, scratch)
        sampled[k] = worst
        stamped[k] = resident
    }
}
