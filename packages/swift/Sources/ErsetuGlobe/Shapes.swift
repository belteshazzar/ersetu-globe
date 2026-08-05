//
//  Building geometry to draw on the globe's surface.
//  Port of src/globe/shapes.ts and src/globe/regions.ts.
//
//  Everything is expressed in lon/lat degrees and densified into short
//  segments that follow the sphere: a line drawn straight between two distant
//  lon/lat points is a chord through the sphere's interior. Interpolating
//  along the great circle keeps every vertex exactly on the surface.
//

import Foundation

/// [longitude, latitude] in degrees.
public typealias LonLat = (Double, Double)

public struct ShapeStyle {
    public var color: RGBA
    /// Stroke width in points.
    public var width: Double
    /// Dash pattern in points.
    public var dash: [Double]

    public init(color: RGBA, width: Double = 1.5, dash: [Double] = []) {
        self.color = color
        self.width = width
        self.dash = dash
    }
}

/// Geometry baked onto the sphere, ready to draw.
public struct Shape {
    var mesh: PolylineMesh
    var style: ShapeStyle
}

/// Spacing between generated vertices, in degrees of arc. At 1 degree a
/// segment bulges inward from the true surface by under 0.01% of the radius.
public let DEFAULT_STEP_DEGREES = 1.0

/// A lon/lat pair as a point on the unit sphere.
public func toUnit(_ at: LonLat) -> (Double, Double, Double) {
    let lon = at.0 * DEG_TO_RAD
    let lat = at.1 * DEG_TO_RAD
    let cosLat = cos(lat)
    return (cosLat * sin(lon), sin(lat), cosLat * cos(lon))
}

private func pushLonLat(_ out: inout [Double], _ x: Double, _ y: Double, _ z: Double) {
    out.append(atan2(x, z) * 180 / .pi)
    out.append(asin(min(1, max(-1, y))) * 180 / .pi)
}

/// Great-circle path through the waypoints, as a flat [lon, lat, ...] ring.
/// With two waypoints this is the shortest path between them.
public func geodesic(
    _ waypoints: [LonLat], stepDegrees: Double = DEFAULT_STEP_DEGREES
) -> [Double] {
    var out: [Double] = []
    if waypoints.isEmpty { return out }
    if waypoints.count == 1 {
        let (x, y, z) = toUnit(waypoints[0])
        pushLonLat(&out, x, y, z)
        return out
    }

    for leg in 0..<(waypoints.count - 1) {
        let a = toUnit(waypoints[leg])
        let b = toUnit(waypoints[leg + 1])

        let dot = min(1, max(-1, a.0 * b.0 + a.1 * b.1 + a.2 * b.2))
        let omega = acos(dot)
        let sinOmega = sin(omega)

        // Coincident points have no path; antipodal ones have infinitely many.
        // Emit the ends and move on.
        if sinOmega < 1e-9 {
            if leg == 0 { pushLonLat(&out, a.0, a.1, a.2) }
            pushLonLat(&out, b.0, b.1, b.2)
            continue
        }

        let steps = max(1, Int(ceil(omega / DEG_TO_RAD / stepDegrees)))
        // Skip the first point on later legs; the previous leg ended there.
        for i in (leg == 0 ? 0 : 1)...steps {
            let t = Double(i) / Double(steps)
            let wa = sin((1 - t) * omega) / sinOmega
            let wb = sin(t * omega) / sinOmega
            pushLonLat(
                &out,
                a.0 * wa + b.0 * wb,
                a.1 * wa + b.1 * wb,
                a.2 * wa + b.2 * wb)
        }
    }

    return out
}

/// A closed great-circle polygon outline through the given corners.
public func geodesicRing(
    _ corners: [LonLat], stepDegrees: Double = DEFAULT_STEP_DEGREES
) -> [Double] {
    if corners.count < 2 { return geodesic(corners, stepDegrees: stepDegrees) }
    return geodesic(corners + [corners[0]], stepDegrees: stepDegrees)
}

/// A circle of constant angular radius about a centre - the set of points a
/// fixed distance away, as a range ring would be drawn.
public func smallCircle(
    _ centre: LonLat, _ radiusDegrees: Double, segments: Int = 180
) -> [Double] {
    let (cx, cy, cz) = toUnit(centre)

    // Any two directions perpendicular to the centre span the circle's plane.
    // Pick the first from whichever axis the centre leans on least.
    let away: (Double, Double, Double) = abs(cy) < 0.9 ? (0, 1, 0) : (1, 0, 0)
    var ux = cy * away.2 - cz * away.1
    var uy = cz * away.0 - cx * away.2
    var uz = cx * away.1 - cy * away.0
    let ul = (ux * ux + uy * uy + uz * uz).squareRoot()
    ux /= ul
    uy /= ul
    uz /= ul

    let vx = cy * uz - cz * uy
    let vy = cz * ux - cx * uz
    let vz = cx * uy - cy * ux

    let r = radiusDegrees * DEG_TO_RAD
    let cosR = cos(r)
    let sinR = sin(r)

    var out: [Double] = []
    for i in 0...segments {
        let a = Double(i) / Double(segments) * Double.pi * 2
        let ca = cos(a) * sinR
        let sa = sin(a) * sinR
        pushLonLat(
            &out,
            cx * cosR + ux * ca + vx * sa,
            cy * cosR + uy * ca + vy * sa,
            cz * cosR + uz * ca + vz * sa)
    }
    return out
}

/// Bake one or more rings into a drawable shape.
public func shape(_ rings: [[Double]], _ style: ShapeStyle) -> Shape {
    Shape(mesh: buildMesh(rings), style: style)
}

// MARK: - Regions (regions.ts)

public struct RegionStyle {
    /// Fill paint. Semi-transparent is the normal case: the ground is worth
    /// seeing.
    public var fill: RGBA?
    /// Outline paint. Nil leaves the fill unbordered.
    public var stroke: RGBA?
    public var width: Double

    public init(fill: RGBA? = nil, stroke: RGBA? = nil, width: Double = 1.25) {
        self.fill = fill
        self.stroke = stroke
        self.width = width
    }
}

/// An area baked onto the sphere, ready to draw. A region is one or more
/// rings: the first is the outline and any others are holes, punched by the
/// even-odd rule.
public struct Region {
    /// Rings grouped into polygons, for the fill.
    var polygons: PolygonMesh
    var style: RegionStyle
}

public func region(_ polygons: [[[Double]]], _ style: RegionStyle) -> Region {
    Region(polygons: buildPolygonMesh(polygons), style: style)
}

/// Wrap geometry that has already been built - a morph's buffer, most likely.
/// The mesh is referenced rather than copied, so a region built around a morph
/// once keeps drawing whatever that morph last wrote.
public func regionOf(_ polygons: PolygonMesh, _ style: RegionStyle) -> Region {
    Region(polygons: polygons, style: style)
}
