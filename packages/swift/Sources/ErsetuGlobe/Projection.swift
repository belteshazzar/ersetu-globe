//
//  Orthographic projection of lon/lat polylines onto a rotating sphere.
//  Direct port of src/globe/projection.ts. The overlay view is flipped
//  (y grows downward), so every screen-space formula carries over verbatim
//  from the canvas implementation.
//

import CoreGraphics
import Foundation

let DEG_TO_RAD = Double.pi / 180

/// A set of polylines baked onto the unit sphere.
/// `positions` holds xyz triples; `offsets` marks where each polyline starts,
/// with a trailing entry for the end of the last one.
struct PolylineMesh {
    var positions: [Double]
    var offsets: [Int]
}

/// Convert flat [lon, lat, ...] degree rings into unit-sphere xyz, once.
func buildMesh(_ rings: [[Double]]) -> PolylineMesh {
    var total = 0
    for ring in rings { total += ring.count / 2 }

    var positions = [Double](repeating: 0, count: total * 3)
    var offsets = [Int](repeating: 0, count: rings.count + 1)

    var point = 0
    for (r, ring) in rings.enumerated() {
        offsets[r] = point
        var i = 0
        while i < ring.count {
            let lon = ring[i] * DEG_TO_RAD
            let lat = ring[i + 1] * DEG_TO_RAD
            let cosLat = cos(lat)
            positions[point * 3] = cosLat * sin(lon)
            positions[point * 3 + 1] = sin(lat)
            positions[point * 3 + 2] = cosLat * cos(lon)
            point += 1
            i += 2
        }
    }
    offsets[rings.count] = point

    return PolylineMesh(positions: positions, offsets: offsets)
}

/// Build a mesh from rings of raw [x, y, z, ...] points at any radius.
func buildMeshFromXyz(_ rings: [[Double]]) -> PolylineMesh {
    var total = 0
    for ring in rings { total += ring.count / 3 }

    var positions = [Double](repeating: 0, count: total * 3)
    var offsets = [Int](repeating: 0, count: rings.count + 1)

    var point = 0
    for (r, ring) in rings.enumerated() {
        offsets[r] = point
        var i = 0
        while i < ring.count {
            positions[point * 3] = ring[i]
            positions[point * 3 + 1] = ring[i + 1]
            positions[point * 3 + 2] = ring[i + 2]
            point += 1
            i += 3
        }
    }
    offsets[rings.count] = point

    return PolylineMesh(positions: positions, offsets: offsets)
}

/// Precomputed per-frame camera terms, in view points.
struct Camera {
    var cx: Double
    var cy: Double
    var radius: Double
    var cosLon: Double
    var sinLon: Double
    var cosLat: Double
    var sinLat: Double
}

func makeCamera(
    cx: Double, cy: Double, radius: Double, longitude: Double, latitude: Double
) -> Camera {
    Camera(
        cx: cx, cy: cy, radius: radius,
        cosLon: cos(longitude), sinLon: sin(longitude),
        cosLat: cos(latitude), sinLat: sin(latitude)
    )
}

/// Rotate a sphere point into camera space: yaw by -longitude, then pitch by
/// +latitude, which puts the point under the camera at (0, 0, 1).
/// Front-facing points end up with z > 0.
@inline(__always)
func rotate(_ camera: Camera, _ x: Double, _ y: Double, _ z: Double)
    -> (x: Double, y: Double, z: Double)
{
    let x1 = x * camera.cosLon - z * camera.sinLon
    let z1 = x * camera.sinLon + z * camera.cosLon
    return (
        x: x1,
        y: y * camera.cosLat - z1 * camera.sinLat,
        z: y * camera.sinLat + z1 * camera.cosLat
    )
}

/// Whether the globe hides a point, in camera space and units of globe radii.
///
/// Geometry sitting above the surface cannot use the surface test: a point is
/// occluded only when it is both behind the centre plane and inside the
/// silhouette cylinder.
@inline(__always)
func isOccluded(_ x: Double, _ y: Double, _ z: Double) -> Bool {
    z < 0 && x * x + y * y < 1
}

/// Screen position of a point above the surface, and whether it is visible.
struct SpacePoint {
    var x: Double = 0
    var y: Double = 0
    var visible = false
    /// Camera-space depth in globe radii; positive is towards the camera.
    var depth: Double = 0
    /// Distance from the view axis in globe radii; 1 is the silhouette edge.
    var offset: Double = 0
}

func projectSpace(_ camera: Camera, _ x: Double, _ y: Double, _ z: Double) -> SpacePoint {
    let r = rotate(camera, x, y, z)
    return SpacePoint(
        x: camera.cx + r.x * camera.radius,
        y: camera.cy - r.y * camera.radius,
        visible: !isOccluded(r.x, r.y, r.z),
        depth: r.z,
        offset: (r.x * r.x + r.y * r.y).squareRoot()
    )
}

/// A point on the globe, in degrees.
public struct GeoPoint: Equatable {
    public var longitude: Double
    public var latitude: Double

    public init(longitude: Double, latitude: Double) {
        self.longitude = longitude
        self.latitude = latitude
    }
}

/// Map a screen position back onto the sphere, inverting both the orthographic
/// projection and the camera rotation. Nil when the point misses the globe.
func unproject(_ camera: Camera, _ screenX: Double, _ screenY: Double) -> GeoPoint? {
    let nx = (screenX - camera.cx) / camera.radius
    let ny = (camera.cy - screenY) / camera.radius
    let r2 = nx * nx + ny * ny
    if r2 > 1 { return nil }

    let nz = (1 - r2).squareRoot()

    // Undo the pitch, then the yaw.
    let wy = ny * camera.cosLat + nz * camera.sinLat
    let z1 = nz * camera.cosLat - ny * camera.sinLat
    let wx = nx * camera.cosLon + z1 * camera.sinLon
    let wz = z1 * camera.cosLon - nx * camera.sinLon

    return GeoPoint(
        longitude: atan2(wx, wz) * 180 / .pi,
        latitude: asin(min(1, max(-1, wy))) * 180 / .pi
    )
}

/// A point interpolated to z = 0 sits slightly inside the sphere because the
/// chord cuts the surface, so push it back out to the limb before projecting.
@inline(__always)
private func limbScale(_ x: Double, _ y: Double) -> Double {
    let length = (x * x + y * y).squareRoot()
    return length > 1e-9 ? 1 / length : 0
}

/// Stroke every polyline in the mesh, hiding the hemisphere facing away from
/// the camera. Segments straddling the horizon are cut exactly at the limb.
func strokeMesh(_ ctx: CGContext, _ mesh: PolylineMesh, _ camera: Camera) {
    let (cx, cy, radius) = (camera.cx, camera.cy, camera.radius)
    ctx.beginPath()

    for r in 0..<(mesh.offsets.count - 1) {
        let start = mesh.offsets[r]
        let end = mesh.offsets[r + 1]

        var penDown = false
        var px = 0.0, py = 0.0, pz = 0.0
        var hasPrev = false

        for i in start..<end {
            let p = rotate(
                camera,
                mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2])

            if p.z > 0 {
                if !penDown {
                    if hasPrev {
                        // Entering view: start at the limb.
                        let t = pz / (pz - p.z)
                        let ix = px + (p.x - px) * t
                        let iy = py + (p.y - py) * t
                        let s = limbScale(ix, iy)
                        ctx.move(to: CGPoint(x: cx + ix * s * radius, y: cy - iy * s * radius))
                    } else {
                        ctx.move(to: CGPoint(x: cx + p.x * radius, y: cy - p.y * radius))
                    }
                    penDown = true
                }
                ctx.addLine(to: CGPoint(x: cx + p.x * radius, y: cy - p.y * radius))
            } else if penDown {
                // Leaving view: finish on the limb, then lift the pen.
                let t = pz / (pz - p.z)
                let ix = px + (p.x - px) * t
                let iy = py + (p.y - py) * t
                let s = limbScale(ix, iy)
                ctx.addLine(to: CGPoint(x: cx + ix * s * radius, y: cy - iy * s * radius))
                penDown = false
            }

            px = p.x
            py = p.y
            pz = p.z
            hasPrev = true
        }
    }

    ctx.strokePath()
}

/// Stroke geometry that stands off the surface, cutting it where the globe
/// occludes it. The crossing is found by bisection rather than snapped to the
/// nearest vertex, so the path meets the silhouette cleanly.
func strokeAbove(_ ctx: CGContext, _ mesh: PolylineMesh, _ camera: Camera) {
    let (cx, cy, radius) = (camera.cx, camera.cy, camera.radius)
    ctx.beginPath()

    for r in 0..<(mesh.offsets.count - 1) {
        let start = mesh.offsets[r]
        let end = mesh.offsets[r + 1]

        var penDown = false
        var hasPrev = false
        var px = 0.0, py = 0.0, pz = 0.0

        for i in start..<end {
            let p = rotate(
                camera,
                mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2])
            let visible = !isOccluded(p.x, p.y, p.z)

            if visible {
                if !penDown {
                    if hasPrev {
                        let c = crossOcclusion(px, py, pz, p.x, p.y, p.z)
                        ctx.move(to: CGPoint(x: cx + c.x * radius, y: cy - c.y * radius))
                        ctx.addLine(to: CGPoint(x: cx + p.x * radius, y: cy - p.y * radius))
                    } else {
                        ctx.move(to: CGPoint(x: cx + p.x * radius, y: cy - p.y * radius))
                    }
                    penDown = true
                } else {
                    ctx.addLine(to: CGPoint(x: cx + p.x * radius, y: cy - p.y * radius))
                }
            } else if penDown {
                let c = crossOcclusion(px, py, pz, p.x, p.y, p.z)
                ctx.addLine(to: CGPoint(x: cx + c.x * radius, y: cy - c.y * radius))
                penDown = false
            }

            px = p.x
            py = p.y
            pz = p.z
            hasPrev = true
        }
    }

    ctx.strokePath()
}

/// Locate where a segment crosses into or out of the globe's shadow. The
/// boundary is not a plane - it is the silhouette edge - so this bisects on
/// the occlusion test itself rather than solving for it.
private func crossOcclusion(
    _ ax: Double, _ ay: Double, _ az: Double,
    _ bx: Double, _ by: Double, _ bz: Double
) -> (x: Double, y: Double, z: Double) {
    let aVisible = !isOccluded(ax, ay, az)
    var lo = 0.0
    var hi = 1.0

    for _ in 0..<16 {
        let mid = (lo + hi) / 2
        let mx = ax + (bx - ax) * mid
        let my = ay + (by - ay) * mid
        let mz = az + (bz - az) * mid
        if !isOccluded(mx, my, mz) == aVisible { lo = mid } else { hi = mid }
    }

    return (x: ax + (bx - ax) * lo, y: ay + (by - ay) * lo, z: az + (bz - az) * lo)
}

// MARK: - Polygons

/// Polygons baked onto the sphere, keeping each polygon's rings together so
/// holes can be filled with the even-odd rule against their own outline.
public final class PolygonMesh {
    /// Rewritten in place by a morph; shared with the outline view of it.
    var positions: [Float]
    /// Start index of each ring, with a trailing end marker.
    let ringOffsets: [Int]
    /// Start ring of each polygon, with a trailing end marker.
    let polygonOffsets: [Int]

    init(positions: [Float], ringOffsets: [Int], polygonOffsets: [Int]) {
        self.positions = positions
        self.ringOffsets = ringOffsets
        self.polygonOffsets = polygonOffsets
    }

    /// The same rings as plain outlines, for stroking.
    var outline: PolylineMesh {
        PolylineMesh(positions: positions.map(Double.init), offsets: ringOffsets)
    }
}

func buildPolygonMesh(_ polygons: [[[Double]]]) -> PolygonMesh {
    let rings = polygons.flatMap { $0 }
    var mesh = buildMesh(rings)
    orientRings(&mesh)

    var polygonOffsets = [Int](repeating: 0, count: polygons.count + 1)
    var ring = 0
    for (p, polygon) in polygons.enumerated() {
        polygonOffsets[p] = ring
        ring += polygon.count
    }
    polygonOffsets[polygons.count] = ring

    return PolygonMesh(
        positions: mesh.positions.map(Float.init),
        ringOffsets: mesh.offsets,
        polygonOffsets: polygonOffsets
    )
}

/// Force every ring counter-clockwise as seen from outside the sphere.
///
/// Which way to run along the limb when closing a clipped ring follows from
/// the ring's orientation, so a convention has to be forced here.
private func orientRings(_ mesh: inout PolylineMesh) {
    for r in 0..<(mesh.offsets.count - 1) {
        let start = mesh.offsets[r]
        let end = mesh.offsets[r + 1]

        var ax = 0.0, ay = 0.0, az = 0.0
        var mx = 0.0, my = 0.0, mz = 0.0

        for i in start..<end {
            let a = i * 3
            let b = (i + 1 < end ? i + 1 : start) * 3
            let x0 = mesh.positions[a]
            let y0 = mesh.positions[a + 1]
            let z0 = mesh.positions[a + 2]
            let x1 = mesh.positions[b]
            let y1 = mesh.positions[b + 1]
            let z1 = mesh.positions[b + 2]
            ax += y0 * z1 - z0 * y1
            ay += z0 * x1 - x0 * z1
            az += x0 * y1 - y0 * x1
            mx += x0
            my += y0
            mz += z0
        }

        if ax * mx + ay * my + az * mz >= 0 { continue }

        var i = start
        var j = end - 1
        while i < j {
            for c in 0..<3 {
                let t = mesh.positions[i * 3 + c]
                mesh.positions[i * 3 + c] = mesh.positions[j * 3 + c]
                mesh.positions[j * 3 + c] = t
            }
            i += 1
            j -= 1
        }
    }
}

// MARK: - Polygon fill, clipped to the visible hemisphere

private let TAU = Double.pi * 2

/// Visible chains of the ring currently being clipped.
private struct Chains {
    var points: [Double] = []
    var start: [Int] = []
    var length: [Int] = []
    var enterAzimuth: [Double] = []
    var exitAzimuth: [Double] = []

    mutating func reset() {
        points.removeAll(keepingCapacity: true)
        start.removeAll(keepingCapacity: true)
        length.removeAll(keepingCapacity: true)
        enterAzimuth.removeAll(keepingCapacity: true)
        exitAzimuth.removeAll(keepingCapacity: true)
    }

    var count: Int { start.count }
}

private var chains = Chains()
private var scratch: [Double] = []

/// Fill every polygon that has any part facing the camera.
///
/// Back-facing points are handled by clipping each ring to the visible
/// hemisphere and bridging the gaps along the limb circle, which is exactly
/// where the visible region's boundary lies.
func fillPolygons(_ ctx: CGContext, _ mesh: PolygonMesh, _ camera: Camera) {
    for p in 0..<(mesh.polygonOffsets.count - 1) {
        var open = false

        for r in mesh.polygonOffsets[p]..<mesh.polygonOffsets[p + 1] {
            if !clipRing(mesh, r, camera) { continue }
            if !open {
                ctx.beginPath()
                open = true
            }
            emitRing(ctx, camera)
        }

        if open { ctx.fillPath(using: .evenOdd) }
    }
}

/// Clip one ring to the visible hemisphere, leaving the result in the chain
/// scratch buffers. False when nothing of the ring is visible.
private func clipRing(_ mesh: PolygonMesh, _ r: Int, _ camera: Camera) -> Bool {
    let (cx, cy, radius) = (camera.cx, camera.cy, camera.radius)

    let start = mesh.ringOffsets[r]
    let count = mesh.ringOffsets[r + 1] - start
    if count < 3 { return false }

    if scratch.count < count * 3 { scratch = [Double](repeating: 0, count: count * 3) }

    var visible = 0
    var entry = -1
    for i in 0..<count {
        let j = (start + i) * 3
        let p = rotate(
            camera,
            Double(mesh.positions[j]), Double(mesh.positions[j + 1]),
            Double(mesh.positions[j + 2]))
        scratch[i * 3] = p.x
        scratch[i * 3 + 1] = p.y
        scratch[i * 3 + 2] = p.z
        if p.z > 0 { visible += 1 }
    }
    if visible == 0 { return false }

    // An entry is a visible point whose predecessor is hidden. Starting the
    // walk there means chains never straddle the wrap-around.
    for i in 0..<count {
        let prev = (i + count - 1) % count
        if scratch[i * 3 + 2] > 0 && scratch[prev * 3 + 2] <= 0 {
            entry = i
            break
        }
    }

    chains.reset()

    // Wholly visible: one closed chain, no limb arcs needed.
    if entry < 0 {
        chains.start.append(0)
        for i in 0..<count {
            chains.points.append(cx + scratch[i * 3] * radius)
            chains.points.append(cy - scratch[i * 3 + 1] * radius)
        }
        chains.length.append(count)
        chains.enterAzimuth.append(.nan)
        chains.exitAzimuth.append(.nan)
        return true
    }

    var inChain = false

    for k in 0..<count {
        let i = (entry + k) % count
        let prev = (i + count - 1) % count

        let px = scratch[prev * 3]
        let py = scratch[prev * 3 + 1]
        let pz = scratch[prev * 3 + 2]
        let x = scratch[i * 3]
        let y = scratch[i * 3 + 1]
        let z = scratch[i * 3 + 2]

        if (z > 0) != (pz > 0) {
            // Cross exactly on the limb, then push the point out onto the
            // circle: interpolating along the chord lands just inside it.
            let t = pz / (pz - z)
            let ix = px + (x - px) * t
            let iy = py + (y - py) * t
            let s = limbScale(ix, iy)
            let ux = ix * s
            let uy = iy * s
            let azimuth = atan2(uy, ux)

            if z > 0 {
                chains.start.append(chains.points.count)
                chains.enterAzimuth.append(azimuth)
                inChain = true
            } else if inChain {
                chains.points.append(cx + ux * radius)
                chains.points.append(cy - uy * radius)
                chains.length.append((chains.points.count - chains.start.last!) / 2)
                chains.exitAzimuth.append(azimuth)
                inChain = false
                continue
            }

            if z > 0 {
                chains.points.append(cx + ux * radius)
                chains.points.append(cy - uy * radius)
            }
        }

        if z > 0 && inChain {
            chains.points.append(cx + x * radius)
            chains.points.append(cy - y * radius)
        }
    }

    // The walk began at an entry, so any open chain closes on the final edge.
    if inChain {
        chains.length.append((chains.points.count - chains.start.last!) / 2)
        chains.exitAzimuth.append(chains.enterAzimuth[chains.count - 1])
    }

    return chains.count > 0
}

/// Emit the clipped chains as closed subpaths, bridging each chain's exit to
/// the next chain's entry along the limb.
///
/// Rings run counter-clockwise with the filled side on the left, so the arc
/// that continues the boundary is the one swept counter-clockwise - which,
/// with screen y pointing down, is drawn clockwise.
private func emitRing(_ ctx: CGContext, _ camera: Camera) {
    let (cx, cy, radius) = (camera.cx, camera.cy, camera.radius)
    let chainCount = chains.count

    var used = [Bool](repeating: false, count: chainCount)

    for c in 0..<chainCount {
        if used[c] { continue }

        var current = c
        var first = true

        var guardCount = 0
        while guardCount <= chainCount {
            guardCount += 1
            used[current] = true

            let base = chains.start[current]
            let length = chains.length[current]
            for i in 0..<length {
                let x = chains.points[base + i * 2]
                let y = chains.points[base + i * 2 + 1]
                if first {
                    ctx.move(to: CGPoint(x: x, y: y))
                    first = false
                } else {
                    ctx.addLine(to: CGPoint(x: x, y: y))
                }
            }

            let exit = chains.exitAzimuth[current]
            if exit.isNaN { break }

            // Nearest chain entry going counter-clockwise from this exit.
            var next = -1
            var best = Double.infinity
            for n in 0..<chainCount {
                var delta = chains.enterAzimuth[n] - exit
                while delta < 0 { delta += TAU }
                while delta >= TAU { delta -= TAU }
                if delta < best {
                    best = delta
                    next = n
                }
            }
            if next < 0 { break }

            let steps = max(2, Int(ceil(best / TAU * 180)))
            for s in 1...steps {
                let a = exit + best * Double(s) / Double(steps)
                ctx.addLine(to: CGPoint(x: cx + cos(a) * radius, y: cy - sin(a) * radius))
            }

            if used[next] { break }
            current = next
        }

        ctx.closePath()
    }
}

/// Meridians and parallels at a fixed spacing, as flat [lon, lat, ...] rings.
func buildGraticule(stepDegrees: Double = 30) -> [[Double]] {
    var rings: [[Double]] = []

    var lon = -180.0
    while lon < 180 {
        var meridian: [Double] = []
        var lat = -90.0
        while lat <= 90 {
            meridian.append(lon)
            meridian.append(lat)
            lat += 2
        }
        rings.append(meridian)
        lon += stepDegrees
    }

    var lat = -90 + stepDegrees
    while lat < 90 {
        var parallel: [Double] = []
        var l = -180.0
        while l <= 180 {
            parallel.append(l)
            parallel.append(lat)
            l += 2
        }
        rings.append(parallel)
        lat += stepDegrees
    }

    return rings
}
