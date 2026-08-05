//
//  Satellite orbits and the satellites that ride them.
//  Port of src/globe/orbits.ts.
//
//  Orbits are circular and defined in the globe's own frame, so an orbit stays
//  fixed relative to the continents and a satellite runs around it once per
//  period. For everything visual - inclination, altitude, phasing, occlusion -
//  the simpler frame behaves the same as an inertial one.
//

import CoreGraphics
import Foundation

let EARTH_RADIUS_KM = 6371.0

public struct OrbitElements {
    /// Height above the surface, in kilometres.
    public var altitudeKm: Double
    /// Tilt of the orbital plane against the equator, in degrees.
    public var inclination: Double
    /// Longitude where the orbit crosses the equator going north, in degrees.
    public var ascendingNode: Double
    /// Time for one revolution, in the units of the clock you render with.
    public var periodSeconds: Double
    /// Angle along the orbit at time zero, from the ascending node.
    public var phase: Double

    public init(
        altitudeKm: Double, inclination: Double, ascendingNode: Double,
        periodSeconds: Double, phase: Double = 0
    ) {
        self.altitudeKm = altitudeKm
        self.inclination = inclination
        self.ascendingNode = ascendingNode
        self.periodSeconds = periodSeconds
        self.phase = phase
    }
}

public struct OrbitStyle {
    public var color: RGBA
    public var width: Double
    public var dash: [Double]

    public init(color: RGBA, width: Double = 1, dash: [Double] = []) {
        self.color = color
        self.width = width
        self.dash = dash
    }
}

public struct SatelliteStyle {
    public var color: RGBA
    /// Marker radius in points.
    public var size: Double
    /// Length of the trailing arc, in degrees of orbit. Zero for none.
    public var trail: Double

    public init(color: RGBA, size: Double = 3, trail: Double = 0) {
        self.color = color
        self.size = size
        self.trail = trail
    }
}

public struct Orbit {
    public var elements: OrbitElements
    var path: PolylineMesh
    var style: OrbitStyle
    var satellite: SatelliteStyle?
}

/// The orbital plane's two in-plane axes: `u` points at the ascending node,
/// and `v` is a quarter turn along the orbit from it, lifted by inclination.
private func basis(_ elements: OrbitElements)
    -> (ux: Double, uy: Double, uz: Double, vx: Double, vy: Double, vz: Double)
{
    let node = elements.ascendingNode * DEG_TO_RAD
    let inc = elements.inclination * DEG_TO_RAD
    let cosNode = cos(node)
    let sinNode = sin(node)
    let cosInc = cos(inc)
    let sinInc = sin(inc)

    return (
        // On the equator, at the ascending node's longitude.
        ux: sinNode, uy: 0, uz: cosNode,
        // A quarter turn east, tilted north by the inclination - what makes
        // the orbit reach exactly `inclination` degrees of latitude.
        vx: cosInc * cosNode, vy: sinInc, vz: -cosInc * sinNode
    )
}

/// Orbital radius in globe radii, where 1 is the surface.
public func orbitRadius(_ elements: OrbitElements) -> Double {
    1 + elements.altitudeKm / EARTH_RADIUS_KM
}

/// Position of the satellite at a given angle along its orbit, in globe radii.
public func positionAtAngle(_ elements: OrbitElements, _ angleDegrees: Double)
    -> (x: Double, y: Double, z: Double)
{
    let b = basis(elements)
    let a = angleDegrees * DEG_TO_RAD
    let cosA = cos(a)
    let sinA = sin(a)
    let r = orbitRadius(elements)

    return (
        x: r * (b.ux * cosA + b.vx * sinA),
        y: r * (b.uy * cosA + b.vy * sinA),
        z: r * (b.uz * cosA + b.vz * sinA)
    )
}

/// How far around the orbit the satellite has travelled at time `t`.
public func angleAt(_ elements: OrbitElements, _ timeSeconds: Double) -> Double {
    elements.phase + 360 * timeSeconds / elements.periodSeconds
}

/// The orbit as a closed ring of [x, y, z, ...] in globe radii.
func orbitRing(_ elements: OrbitElements, segments: Int = 240) -> [Double] {
    var out: [Double] = []
    for i in 0...segments {
        let p = positionAtAngle(elements, Double(i) / Double(segments) * 360)
        out.append(p.x)
        out.append(p.y)
        out.append(p.z)
    }
    return out
}

/// Bake an orbit for drawing.
public func orbit(
    _ elements: OrbitElements, _ style: OrbitStyle, _ satellite: SatelliteStyle? = nil
) -> Orbit {
    Orbit(
        elements: elements,
        path: buildMeshFromXyz([orbitRing(elements)]),
        style: style,
        satellite: satellite)
}

/// Draw the orbits and their satellites at the given time.
func drawOrbits(
    _ ctx: CGContext, _ camera: Camera, _ orbits: [Orbit], _ timeSeconds: Double
) {
    for item in orbits {
        ctx.setStrokeColor(item.style.color.cg)
        ctx.setLineWidth(item.style.width)
        ctx.setLineDash(phase: 0, lengths: item.style.dash.map { CGFloat($0) })
        strokeAbove(ctx, item.path, camera)
    }
    ctx.setLineDash(phase: 0, lengths: [])

    // Satellites last, so a marker is never overdrawn by another orbit's path.
    for item in orbits {
        guard let style = item.satellite else { continue }
        drawSatellite(ctx, camera, item, style, timeSeconds)
    }
}

private func drawSatellite(
    _ ctx: CGContext, _ camera: Camera, _ item: Orbit, _ style: SatelliteStyle,
    _ timeSeconds: Double
) {
    let angle = angleAt(item.elements, timeSeconds)
    let size = style.size
    let trail = style.trail

    // Trailing arc, drawn as separate segments so it can fade out behind the
    // satellite; a single stroke could not vary its alpha along the path.
    if trail > 0 {
        let steps = min(16, max(3, Int((trail / 3).rounded())))
        ctx.setLineWidth(size * 0.55)
        ctx.setLineCap(.round)

        for i in 0..<steps {
            let from = angle - trail * Double(i + 1) / Double(steps)
            let to = angle - trail * Double(i) / Double(steps)

            let a = positionAtAngle(item.elements, from)
            let previous = projectSpace(camera, a.x, a.y, a.z)
            let b = positionAtAngle(item.elements, to)
            let screen = projectSpace(camera, b.x, b.y, b.z)
            if !previous.visible || !screen.visible { continue }

            let alpha = 1 - Double(i) / Double(steps)
            ctx.setStrokeColor(style.color.withAlpha(alpha).cg)
            ctx.beginPath()
            ctx.move(to: CGPoint(x: previous.x, y: previous.y))
            ctx.addLine(to: CGPoint(x: screen.x, y: screen.y))
            ctx.strokePath()
        }
    }

    let p = positionAtAngle(item.elements, angle)
    let screen = projectSpace(camera, p.x, p.y, p.z)
    if !screen.visible { return }

    // Halo, then core.
    ctx.setFillColor(style.color.withAlpha(0.28).cg)
    ctx.fillEllipse(
        in: CGRect(
            x: screen.x - size * 2.4, y: screen.y - size * 2.4,
            width: size * 4.8, height: size * 4.8))

    ctx.setFillColor(style.color.cg)
    ctx.fillEllipse(
        in: CGRect(x: screen.x - size, y: screen.y - size, width: size * 2, height: size * 2))
}
