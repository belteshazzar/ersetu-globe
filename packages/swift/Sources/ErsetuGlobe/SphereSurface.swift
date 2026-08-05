//
//  The bare sphere, before any terrain has arrived. Port of
//  src/globe/surface.ts: a radial gradient for the moment between the first
//  frame and the first tiles - there is no elevation yet to say where the land
//  is, and a gradient is the honest thing to show.
//

import CoreGraphics

private let SKY = RGBA(110, 176, 255)
private let HORIZON = RGBA(30, 92, 190)
private let GROUND = RGBA(5, 18, 52)

/// The land colour used to fill the coastline polygons before terrain lands.
let FLAT_LAND = RGBA(82, 88, 93)

func paintSphere(_ ctx: CGContext, _ camera: Camera) {
    let (cx, cy, radius) = (camera.cx, camera.cy, camera.radius)

    guard
        let gradient = CGGradient(
            colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
            colors: [SKY.cg, HORIZON.cg, GROUND.cg] as CFArray,
            locations: [0, 0.55, 1])
    else { return }

    ctx.saveGState()
    ctx.beginPath()
    ctx.addEllipse(
        in: CGRect(x: cx - radius, y: cy - radius, width: radius * 2, height: radius * 2))
    ctx.clip()
    ctx.drawRadialGradient(
        gradient,
        startCenter: CGPoint(x: cx - radius * 0.25, y: cy - radius * 0.35),
        startRadius: radius * 0.05,
        endCenter: CGPoint(x: cx, y: cy),
        endRadius: radius,
        options: [.drawsAfterEndLocation])
    ctx.restoreGState()
}
