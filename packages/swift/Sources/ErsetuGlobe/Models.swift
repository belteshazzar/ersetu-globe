//
//  Small 3D models placed on the globe and in orbit around it.
//  Port of src/globe/models.ts.
//
//  Models are a few dozen triangles each, drawn as ordinary filled paths at
//  full resolution. No depth buffer, so depth is handled twice over: within a
//  model, faces are sorted back to front; against the globe, the anchor is
//  tested for occlusion as a whole by the same rule the orbits use. Faces are
//  lit from both sides with the normal turned to face the camera, so the
//  renderer does not care which way a model's triangles wind.
//
//  Nothing here is to scale: sizes are in globe radii and chosen to be seen,
//  exactly as the terrain is exaggerated to be seen.
//

import CoreGraphics
import Foundation

/// Geometry ready to draw: triangles, and a colour for each.
public struct Model {
    var name: String
    /// Vertex positions, xyz per vertex, in model units.
    var positions: [Double]
    /// Three vertex indices per triangle.
    var faces: [Int]
    /// One rgb triple per triangle.
    var colors: [Double]
    var faceCount: Int
}

/// Load and validate a model from the bundle's JSON format.
public func loadModel(_ url: URL) throws -> Model {
    let data = try Data(contentsOf: url)
    guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        let positions = (json["positions"] as? [NSNumber])?.map({ $0.doubleValue }),
        let faces = (json["faces"] as? [NSNumber])?.map({ $0.intValue }),
        let colors = (json["colors"] as? [NSNumber])?.map({ $0.doubleValue })
    else { throw TerrainError.malformed("\(url.lastPathComponent): not a model") }

    let faceCount = faces.count / 3
    guard faces.count % 3 == 0, colors.count == faceCount * 3 else {
        throw TerrainError.malformed("\(url.lastPathComponent): faces and colours disagree")
    }
    let vertexCount = positions.count / 3
    guard faces.allSatisfy({ $0 < vertexCount }) else {
        throw TerrainError.malformed("\(url.lastPathComponent): face index out of range")
    }

    return Model(
        name: json["name"] as? String ?? "model",
        positions: positions, faces: faces, colors: colors, faceCount: faceCount)
}

/// Where a model sits. Surface anchors are their own kind rather than just a
/// function, because they have to be told the terrain to stand on it.
enum ModelAnchor {
    case surface(x: Double, y: Double, z: Double, longitude: Double, latitude: Double)
    case orbit(OrbitElements)
    case tracking((Double) -> Vec3)
}

public struct ModelPlacement {
    var model: Model
    var anchor: ModelAnchor
    /// Size in globe radii. Not to scale - chosen to be visible.
    var size: Double = 0.03
    /// Rotation about local up in degrees; 0 faces north.
    var heading: Double = 0
    /// Degrees added to the heading per second of the scene clock.
    var spin: Double = 0
}

/// Stand a model on the ground. It rides the displaced terrain, so it rises
/// and falls with the relief slider rather than sinking into a mountain.
public func placeOnSurface(
    _ model: Model, _ at: LonLat, size: Double = 0.03, heading: Double = 0, spin: Double = 0
) -> ModelPlacement {
    let (x, y, z) = toUnit(at)
    return ModelPlacement(
        model: model,
        anchor: .surface(x: x, y: y, z: z, longitude: at.0, latitude: at.1),
        size: size, heading: heading, spin: spin)
}

/// Fly a model around an orbit, in place of - or alongside - its marker.
public func placeInOrbit(
    _ model: Model, _ orbit: Orbit, size: Double = 0.03, heading: Double = 0, spin: Double = 0
) -> ModelPlacement {
    ModelPlacement(
        model: model, anchor: .orbit(orbit.elements), size: size, heading: heading, spin: spin)
}

// Key light, matching the surface shading so models sit in the same world.
private let LX = -0.42
private let LY = 0.58
private let LZ = 0.7
private let AMBIENT = 0.3

/// Draw every model at the given time.
func drawModels(
    _ ctx: CGContext, _ camera: Camera, _ placements: [ModelPlacement],
    _ timeSeconds: Double, exaggeration: Double
) {
    ctx.setLineJoin(.round)
    ctx.setLineDash(phase: 0, lengths: [])

    for placement in placements {
        drawModel(ctx, camera, placement, timeSeconds, exaggeration: exaggeration)
    }
}

private func resolveAnchor(
    _ anchor: ModelAnchor, _ timeSeconds: Double, _ exaggeration: Double
) -> Vec3 {
    switch anchor {
    case .orbit(let elements):
        return positionAtAngle(elements, angleAt(elements, timeSeconds))
    case .tracking(let resolve):
        return resolve(timeSeconds)
    case .surface(let x, let y, let z, let longitude, let latitude):
        // Stand on the terrain as it is actually displaced, so a model on a
        // mountain rides up with it rather than sinking in.
        var radius = 1.0
        let terrain = Terrain.shared
        if terrain.levels > 0 {
            let metres = terrain.height(
                u: (longitude + 180) / 360, v: (90 - latitude) / 180,
                level: terrain.levels - 1)
            radius += metres / (EARTH_RADIUS_KM * 1000) * exaggeration
        }
        return (x * radius, y * radius, z * radius)
    }
}

@inline(__always)
private func rotate(
    _ x: Double, _ y: Double, _ z: Double, _ camera: Camera
) -> (x: Double, y: Double, z: Double) {
    let x1 = x * camera.cosLon - z * camera.sinLon
    let z1 = x * camera.sinLon + z * camera.cosLon
    return (x1, y * camera.cosLat - z1 * camera.sinLat, y * camera.sinLat + z1 * camera.cosLat)
}

private func drawModel(
    _ ctx: CGContext, _ camera: Camera, _ placement: ModelPlacement,
    _ timeSeconds: Double, exaggeration: Double
) {
    let model = placement.model
    let size = placement.size
    let (cx, cy, radius) = (camera.cx, camera.cy, camera.radius)

    let here = resolveAnchor(placement.anchor, timeSeconds, exaggeration)

    // Local frame: up is radial, and heading turns the model about it.
    let length = (here.x * here.x + here.y * here.y + here.z * here.z).squareRoot()
    if length < 1e-9 { return }
    let ux = here.x / length
    let uy = here.y / length
    let uz = here.z / length

    // East and north come straight from the up vector, no trigonometry.
    let horizontal = (ux * ux + uz * uz).squareRoot()
    var ex = 1.0
    var ez = 0.0
    if horizontal > 1e-6 {
        ex = uz / horizontal
        ez = -ux / horizontal
    }
    // north = up x east, with east's vertical component dropped.
    let nx = uy * ez
    let ny = uz * ex - ux * ez
    let nz = -uy * ex

    let turn = (placement.heading + placement.spin * timeSeconds) * DEG_TO_RAD
    let cosTurn = cos(turn)
    let sinTurn = sin(turn)

    // Forward is north swung round by the heading; right completes the frame.
    let fx = nx * cosTurn + ex * sinTurn
    let fy = ny * cosTurn
    let fz = nz * cosTurn + ez * sinTurn
    let rx = uy * fz - uz * fy
    let ry = uz * fx - ux * fz
    let rz = ux * fy - uy * fx

    // Occlusion is decided once for the model, from its anchor.
    let p = rotate(here.x, here.y, here.z, camera)
    if isOccluded(p.x, p.y, p.z) { return }

    // Carry the model's frame into camera space once, then every vertex is a
    // linear combination of three fixed axes.
    let rc = rotate(rx, ry, rz, camera)
    let uc = rotate(ux, uy, uz, camera)
    let fc = rotate(fx, fy, fz, camera)
    let rcx = rc.x * size, rcy = rc.y * size, rcz = rc.z * size
    let ucx = uc.x * size, ucy = uc.y * size, ucz = uc.z * size
    let fcx = fc.x * size, fcy = fc.y * size, fcz = fc.z * size

    let vertexCount = model.positions.count / 3
    var camX = [Double](repeating: 0, count: vertexCount)
    var camY = [Double](repeating: 0, count: vertexCount)
    var camZ = [Double](repeating: 0, count: vertexCount)

    // Kept in camera space, not screen space: the projection scales x and y by
    // the globe's radius and leaves z alone, so a normal taken from projected
    // edges would be tilted by however large the globe happens to be drawn.
    for i in 0..<vertexCount {
        let vx = model.positions[i * 3]
        let vy = model.positions[i * 3 + 1]
        let vz = model.positions[i * 3 + 2]
        camX[i] = p.x + rcx * vx + ucx * vy + fcx * vz
        camY[i] = p.y + rcy * vx + ucy * vy + fcy * vz
        camZ[i] = p.z + rcz * vx + ucz * vy + fcz * vz
    }

    var order = Array(0..<model.faceCount)
    var depth = [Double](repeating: 0, count: model.faceCount)
    for f in 0..<model.faceCount {
        depth[f] =
            (camZ[model.faces[f * 3]] + camZ[model.faces[f * 3 + 1]]
                + camZ[model.faces[f * 3 + 2]]) / 3
    }
    // Farthest first: nearer faces are painted over them.
    order.sort { depth[$0] < depth[$1] }

    for f in order {
        let a = model.faces[f * 3]
        let b = model.faces[f * 3 + 1]
        let c = model.faces[f * 3 + 2]

        // Normal from the camera-space edges, turned to face the viewer so a
        // model lights the same whichever way its triangles happen to wind.
        let e1x = camX[b] - camX[a]
        let e1y = camY[b] - camY[a]
        let e1z = camZ[b] - camZ[a]
        let e2x = camX[c] - camX[a]
        let e2y = camY[c] - camY[a]
        let e2z = camZ[c] - camZ[a]
        var mx = e1y * e2z - e1z * e2y
        var my = e1z * e2x - e1x * e2z
        var mz = e1x * e2y - e1y * e2x
        let scale = (mx * mx + my * my + mz * mz).squareRoot()
        if scale < 1e-12 { continue }
        mx /= scale
        my /= scale
        mz /= scale
        if mz < 0 {
            mx = -mx
            my = -my
            mz = -mz
        }
        let lambert = mx * LX + my * LY + mz * LZ
        let gain = AMBIENT + (1 - AMBIENT) * max(0, lambert)

        ctx.setFillColor(
            RGBA(
                model.colors[f * 3] * gain, model.colors[f * 3 + 1] * gain,
                model.colors[f * 3 + 2] * gain
            ).cg)
        ctx.beginPath()
        ctx.move(to: CGPoint(x: cx + camX[a] * radius, y: cy - camY[a] * radius))
        ctx.addLine(to: CGPoint(x: cx + camX[b] * radius, y: cy - camY[b] * radius))
        ctx.addLine(to: CGPoint(x: cx + camX[c] * radius, y: cy - camY[c] * radius))
        ctx.closePath()
        ctx.fillPath()
    }
}
