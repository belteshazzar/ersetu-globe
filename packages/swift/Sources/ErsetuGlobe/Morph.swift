//
//  Tweening one set of polygons into another, on the sphere.
//  Port of src/globe/morph.ts.
//
//  Resample: both rings are rewritten with the same number of points, equally
//  spaced by arc length. Align: the cyclic offset that brings the two into
//  closest agreement is found once, by trying all of them. Match: polygons are
//  paired between the states by proximity, largest first, and whatever is left
//  over is paired with a copy of its own centre, so it grows from - or shrinks
//  to - a point rather than appearing whole between two frames.
//
//  What comes out is a fixed layout, so the tween writes into one buffer that
//  is allocated once and rewritten in place.
//

import Foundation

/// Points per ring after resampling. Alignment is quadratic in it, but only at
/// build time.
public let DEFAULT_POINTS = 256

public final class Morph {
    let points: Int
    /// Rewritten in place by `at(_:)`. Its identity never changes, so a region
    /// built around it once keeps working for the life of the morph.
    public let mesh: PolygonMesh
    /// Where every output vertex starts and ends, xyz.
    private let from: [Double]
    private let to: [Double]

    public init(from: [[[Double]]], to: [[[Double]]], points: Int = DEFAULT_POINTS) {
        let count = max(3, points)
        self.points = count
        let before = toPolygons(from)
        let after = toPolygons(to)

        var starts: [[Double]] = []
        var ends: [[Double]] = []
        var ringsPerPolygon: [Int] = []

        for (a, b) in matchPolygons(before, after) {
            let ringCount = max(a?.count ?? 0, b?.count ?? 0)
            for i in 0..<ringCount {
                let ra = a.flatMap { i < $0.count ? $0[i] : nil }
                let rb = b.flatMap { i < $0.count ? $0[i] : nil }

                if let ra, let rb {
                    let start = resample(ra, count)
                    let target = resample(rb, count)
                    starts.append(start)
                    ends.append(rotateRing(target, align(start, target, count), count))
                } else if let ra {
                    starts.append(resample(ra, count))
                    ends.append(constant(centroid(ra), count))
                } else if let rb {
                    starts.append(constant(centroid(rb), count))
                    ends.append(resample(rb, count))
                }
            }
            if ringCount > 0 { ringsPerPolygon.append(ringCount) }
        }

        let rings = starts.count
        let total = rings * count
        var fromAll = [Double](repeating: 0, count: total * 3)
        var toAll = [Double](repeating: 0, count: total * 3)
        var ringOffsets = [Int](repeating: 0, count: rings + 1)
        for r in 0..<rings {
            for i in 0..<(count * 3) {
                fromAll[r * count * 3 + i] = starts[r][i]
                toAll[r * count * 3 + i] = ends[r][i]
            }
            ringOffsets[r] = r * count
        }
        ringOffsets[rings] = total

        var polygonOffsets = [Int](repeating: 0, count: ringsPerPolygon.count + 1)
        var ring = 0
        for (p, n) in ringsPerPolygon.enumerated() {
            polygonOffsets[p] = ring
            ring += n
        }
        polygonOffsets[ringsPerPolygon.count] = ring

        self.from = fromAll
        self.to = toAll
        self.mesh = PolygonMesh(
            positions: [Float](repeating: 0, count: total * 3),
            ringOffsets: ringOffsets,
            polygonOffsets: polygonOffsets)
        at(0)
    }

    /// The state at a fraction, written into the morph's own buffer. Straight
    /// interpolation renormalised back onto the sphere: over the distances a
    /// border moves the difference from a true slerp is far below a pixel.
    public func at(_ t: Double) {
        let s = min(1, max(0, t))
        var i = 0
        while i < mesh.positions.count {
            var x = from[i] + (to[i] - from[i]) * s
            var y = from[i + 1] + (to[i + 1] - from[i + 1]) * s
            var z = from[i + 2] + (to[i + 2] - from[i + 2]) * s
            var length = (x * x + y * y + z * z).squareRoot()
            // Endpoints on opposite sides of the globe pass through the
            // centre, where there is no direction to normalise: hold the start
            // rather than emit a NaN that would poison the whole ring.
            if length < 1e-9 {
                x = from[i]
                y = from[i + 1]
                z = from[i + 2]
                length = 1
            }
            let inverse = 1 / length
            mesh.positions[i] = Float(x * inverse)
            mesh.positions[i + 1] = Float(y * inverse)
            mesh.positions[i + 2] = Float(z * inverse)
            i += 3
        }
    }
}

// MARK: - Preparation

/// A ring as xyz triples, not closed: the last point does not repeat the first.
private typealias Ring = [Double]
private typealias Polygon = [Ring]

private func toPolygons(_ polygons: [[[Double]]]) -> [Polygon] {
    var out: [Polygon] = []
    for rings in polygons {
        var built: Polygon = []
        for ring in rings {
            var converted = toRing(ring)
            if converted.count >= 9 {
                orient(&converted)
                built.append(converted)
            }
        }
        if !built.isEmpty { out.append(built) }
    }
    return out
}

private func toRing(_ flat: [Double]) -> Ring {
    var n = flat.count / 2
    // Sources usually repeat the first point to close the ring; the repeat is
    // a zero-length segment that would take a share of the resampling.
    if n > 1 && flat[0] == flat[(n - 1) * 2] && flat[1] == flat[(n - 1) * 2 + 1] {
        n -= 1
    }

    var out = [Double](repeating: 0, count: n * 3)
    for i in 0..<n {
        let lon = flat[i * 2] * DEG_TO_RAD
        let lat = flat[i * 2 + 1] * DEG_TO_RAD
        let cosLat = cos(lat)
        out[i * 3] = cosLat * sin(lon)
        out[i * 3 + 1] = sin(lat)
        out[i * 3 + 2] = cosLat * cos(lon)
    }
    return out
}

/// Force a ring counter-clockwise seen from outside - two rings wound opposite
/// ways have no rotation that brings them into agreement, so this has to
/// happen before the offset is searched for.
private func orient(_ ring: inout Ring) {
    let n = ring.count / 3
    var ax = 0.0, ay = 0.0, az = 0.0
    for i in 0..<n {
        let j = i * 3
        let k = ((i + 1) % n) * 3
        ax += ring[j + 1] * ring[k + 2] - ring[j + 2] * ring[k + 1]
        ay += ring[j + 2] * ring[k] - ring[j] * ring[k + 2]
        az += ring[j] * ring[k + 1] - ring[j + 1] * ring[k]
    }

    let middle = centroid(ring)
    if ax * middle.0 + ay * middle.1 + az * middle.2 >= 0 { return }

    var i = 0
    var j = n - 1
    while i < j {
        for c in 0..<3 {
            let swap = ring[i * 3 + c]
            ring[i * 3 + c] = ring[j * 3 + c]
            ring[j * 3 + c] = swap
        }
        i += 1
        j -= 1
    }
}

/// The mean direction of a ring's points, back on the sphere.
private func centroid(_ ring: Ring) -> (Double, Double, Double) {
    let n = ring.count / 3
    var x = 0.0, y = 0.0, z = 0.0
    for i in 0..<n {
        x += ring[i * 3]
        y += ring[i * 3 + 1]
        z += ring[i * 3 + 2]
    }
    let length = (x * x + y * y + z * z).squareRoot()
    if length < 1e-12 { return (ring[0], ring[1], ring[2]) }
    return (x / length, y / length, z / length)
}

/// Rewrite a ring with `count` points equally spaced along its arc.
private func resample(_ ring: Ring, _ count: Int) -> [Double] {
    let n = ring.count / 3
    var lengths = [Double](repeating: 0, count: n)
    var total = 0.0
    for i in 0..<n {
        let j = i * 3
        let k = ((i + 1) % n) * 3
        var dot =
            ring[j] * ring[k] + ring[j + 1] * ring[k + 1] + ring[j + 2] * ring[k + 2]
        dot = min(1, max(-1, dot))
        lengths[i] = acos(dot)
        total += lengths[i]
    }

    if total <= 0 { return constant((ring[0], ring[1], ring[2]), count) }

    var out = [Double](repeating: 0, count: count * 3)
    var segment = 0
    var walked = 0.0
    for s in 0..<count {
        let target = Double(s) / Double(count) * total
        while segment < n - 1 && walked + lengths[segment] <= target {
            walked += lengths[segment]
            segment += 1
        }
        let span = lengths[segment]
        let t = span > 0 ? (target - walked) / span : 0
        slerp(ring, segment, (segment + 1) % n, t, &out, s)
    }
    return out
}

/// Interpolate along the great circle between two of a ring's points - what
/// makes the spacing equal by arc rather than bunched towards segment ends.
private func slerp(
    _ ring: Ring, _ ia: Int, _ ib: Int, _ t: Double, _ out: inout [Double], _ at: Int
) {
    let j = ia * 3
    let k = ib * 3
    var dot = ring[j] * ring[k] + ring[j + 1] * ring[k + 1] + ring[j + 2] * ring[k + 2]
    dot = min(1, max(-1, dot))
    let omega = acos(dot)
    let sine = sin(omega)

    var wa = 1 - t
    var wb = t
    if sine > 1e-9 {
        wa = sin((1 - t) * omega) / sine
        wb = sin(t * omega) / sine
    }

    var x = ring[j] * wa + ring[k] * wb
    var y = ring[j + 1] * wa + ring[k + 1] * wb
    var z = ring[j + 2] * wa + ring[k + 2] * wb
    let length = (x * x + y * y + z * z).squareRoot()
    let inverse = length > 0 ? 1 / length : 1
    x *= inverse
    y *= inverse
    z *= inverse

    out[at * 3] = x
    out[at * 3 + 1] = y
    out[at * 3 + 2] = z
}

/// A ring of `count` copies of one point: what a vanishing shape shrinks to.
private func constant(_ point: (Double, Double, Double), _ count: Int) -> [Double] {
    var out = [Double](repeating: 0, count: count * 3)
    for i in 0..<count {
        out[i * 3] = point.0
        out[i * 3 + 1] = point.1
        out[i * 3 + 2] = point.2
    }
    return out
}

/// The cyclic offset bringing `b` into closest agreement with `a`: minimising
/// summed squared chord is maximising summed dot product, every offset tried.
private func align(_ a: [Double], _ b: [Double], _ count: Int) -> Int {
    var best = -Double.infinity
    var bestOffset = 0
    for k in 0..<count {
        var sum = 0.0
        for i in 0..<count {
            let p = i * 3
            let q = ((i + k) % count) * 3
            sum += a[p] * b[q] + a[p + 1] * b[q + 1] + a[p + 2] * b[q + 2]
        }
        if sum > best {
            best = sum
            bestOffset = k
        }
    }
    return bestOffset
}

private func rotateRing(_ ring: [Double], _ offset: Int, _ count: Int) -> [Double] {
    if offset == 0 { return ring }
    var out = [Double](repeating: 0, count: count * 3)
    for i in 0..<count {
        let from = ((i + offset) % count) * 3
        out[i * 3] = ring[from]
        out[i * 3 + 1] = ring[from + 1]
        out[i * 3 + 2] = ring[from + 2]
    }
    return out
}

/// Pair polygons between the two states, largest first, so a mainland claims
/// its successor before an island does.
private func matchPolygons(
    _ before: [Polygon], _ after: [Polygon]
) -> [(Polygon?, Polygon?)] {
    var taken = [Bool](repeating: false, count: after.count)
    var pairs: [(Polygon?, Polygon?)] = []

    let order = before.indices.sorted { extent(before[$0]) > extent(before[$1]) }
    for i in order {
        let here = centroid(before[i][0])
        var bestJ = -1
        var bestDistance = Double.infinity
        for j in 0..<after.count {
            if taken[j] { continue }
            let there = centroid(after[j][0])
            let distance = 1 - (here.0 * there.0 + here.1 * there.1 + here.2 * there.2)
            if distance < bestDistance {
                bestDistance = distance
                bestJ = j
            }
        }
        if bestJ < 0 {
            pairs.append((before[i], nil))
        } else {
            taken[bestJ] = true
            pairs.append((before[i], after[bestJ]))
        }
    }

    for j in 0..<after.count where !taken[j] {
        pairs.append((nil, after[j]))
    }
    return pairs
}

/// Perimeter of a polygon's outline: a cheap stand-in for how big it is.
private func extent(_ polygon: Polygon) -> Double {
    let ring = polygon[0]
    let n = ring.count / 3
    var total = 0.0
    for i in 0..<n {
        let j = i * 3
        let k = ((i + 1) % n) * 3
        var dot =
            ring[j] * ring[k] + ring[j + 1] * ring[k + 1] + ring[j + 2] * ring[k + 2]
        dot = min(1, max(-1, dot))
        total += acos(dot)
    }
    return total
}
