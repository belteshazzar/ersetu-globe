//
//  Text labels pinned to the globe. Port of src/globe/labels.ts.
//
//  A label is some text plus an anchor: a function that says where the label
//  is attached, in globe radii, at a given time. Labels are hidden by the same
//  occlusion test the orbits use, so one riding a high satellite stays
//  readable while it passes wide of the silhouette. Text is the one layer that
//  cannot be allowed to overlap, so each label claims a screen rectangle as it
//  is drawn and later ones that would collide are dropped - array order is the
//  priority.
//

import AppKit
import Foundation

/// A position in globe radii, where 1 is the surface.
typealias Vec3 = (x: Double, y: Double, z: Double)

/// Where a label is attached at a given time.
typealias LabelAnchor = (Double) -> Vec3

/// Which side of the anchor the text sits on.
public enum LabelPlacement {
    case right, left, above, below, centre
}

public struct LabelStyle {
    public var color: RGBA = RGBA(226, 238, 255, 0.92)
    public var size: Double = 12
    public var weight: NSFont.Weight = .medium
    public var placement: LabelPlacement = .right
    /// Space between the anchor and the text, in points.
    public var gap: Double = 10
    /// Further shift of the text, applied after placement.
    public var offset: (Double, Double) = (0, 0)
    /// Marker radius at the anchor. Zero for none.
    public var dot: Double = 0
    /// Draw a line from the anchor to the text.
    public var leader = false
    /// Outline behind the glyphs, so text stays legible over any background.
    public var halo: RGBA? = RGBA(4, 10, 20, 0.8)
    public var haloWidth: Double = 3
    /// Draw a line from the surface up to the anchor - it shows what a label
    /// standing off the surface is above.
    public var stem = false
    /// Dim the label as its anchor turns towards the far side.
    public var fade = true
    /// Whether this label may be dropped when it collides with one already
    /// drawn. A label with this off is always drawn, and still reserves its
    /// rectangle against the labels that follow it.
    public var declutter = true

    public init() {}
}

public struct GlobeLabel {
    /// Fixed text, or a function of the clock for a live readout.
    var text: (Double) -> String
    var anchor: LabelAnchor
    var style: LabelStyle
}

/// A label pinned to a place on the surface.
public func label(_ text: String, _ at: LonLat, _ style: LabelStyle = LabelStyle()) -> GlobeLabel {
    let (x, y, z) = toUnit(at)
    var withDot = style
    if withDot.dot == 0 { withDot.dot = 2.5 }
    return GlobeLabel(text: { _ in text }, anchor: { _ in (x, y, z) }, style: withDot)
}

/// A label pinned to a fixed point above the surface, tethered by default to
/// the ground point below it so it is clear what the altitude is measured from.
public func labelAbove(
    _ text: String, _ at: LonLat, _ altitudeKm: Double, _ style: LabelStyle = LabelStyle()
) -> GlobeLabel {
    let radius = 1 + altitudeKm / EARTH_RADIUS_KM
    let (x, y, z) = toUnit(at)
    var s = style
    if s.dot == 0 { s.dot = 2.5 }
    s.stem = true
    return GlobeLabel(
        text: { _ in text },
        anchor: { _ in (x * radius, y * radius, z * radius) },
        style: s)
}

/// A label that rides a satellite, staying with it as it goes round.
public func labelOn(
    _ text: @escaping (Double) -> String, _ orbit: Orbit, _ style: LabelStyle = LabelStyle()
) -> GlobeLabel {
    let elements = orbit.elements
    return GlobeLabel(
        text: text,
        anchor: { time in positionAtAngle(elements, angleAt(elements, time)) },
        style: style)
}

public func labelOn(_ text: String, _ orbit: Orbit, _ style: LabelStyle = LabelStyle()) -> GlobeLabel {
    labelOn({ _ in text }, orbit, style)
}

// Rectangles already taken this frame.
private var boxes: [CGRect] = []

/// Breathing room around each rectangle, so labels never quite touch.
private let BOX_PADDING = 2.0

/// How far into the limb a label fades out, in globe radii of depth. Without
/// it labels would blink on and off as the globe turns.
private let FADE_BAND = 0.12

/// Dim a label as its anchor turns towards the far side. Only anchors inside
/// the silhouette can be swallowed by the globe, so one passing wide of it -
/// a high satellite seen past the edge - never fades.
private func limbFade(_ point: SpacePoint) -> Double {
    if point.offset >= 1 || point.depth >= FADE_BAND { return 1 }
    return max(0, point.depth / FADE_BAND)
}

/// Draw the labels at the given time. Call this last: labels are the top
/// layer, and the collision test only knows about other labels.
func drawLabels(
    _ ctx: CGContext, _ camera: Camera, _ labels: [GlobeLabel], _ timeSeconds: Double
) {
    boxes.removeAll(keepingCapacity: true)
    ctx.setLineJoin(.round)
    ctx.setLineCap(.round)
    ctx.setLineDash(phase: 0, lengths: [])

    for item in labels { drawLabel(ctx, camera, item, timeSeconds) }
}

private func drawLabel(
    _ ctx: CGContext, _ camera: Camera, _ item: GlobeLabel, _ timeSeconds: Double
) {
    let style = item.style

    let here = item.anchor(timeSeconds)
    let anchorPoint = projectSpace(camera, here.x, here.y, here.z)
    if !anchorPoint.visible { return }

    let alpha = style.fade ? limbFade(anchorPoint) : 1
    if alpha < 0.02 { return }

    let text = item.text(timeSeconds)
    if text.isEmpty { return }

    let font = NSFont.systemFont(ofSize: style.size, weight: style.weight)
    let fillColor = NSColor(
        srgbRed: style.color.r / 255, green: style.color.g / 255, blue: style.color.b / 255,
        alpha: style.color.a * alpha)
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: fillColor]
    let measured = (text as NSString).size(withAttributes: attributes)
    let width = Double(measured.width)
    let height = style.size * 1.2

    let gap = style.gap
    let (shiftX, shiftY) = style.offset

    // Text box, plus the point on it that a leader line should meet.
    var left = 0.0
    var middle = 0.0
    var attachX = 0.0
    var attachY = 0.0

    switch style.placement {
    case .left:
        left = anchorPoint.x - gap - width
        middle = anchorPoint.y
        attachX = left + width
        attachY = middle
    case .above:
        left = anchorPoint.x - width / 2
        middle = anchorPoint.y - gap - height / 2
        attachX = anchorPoint.x
        attachY = middle + height / 2
    case .below:
        left = anchorPoint.x - width / 2
        middle = anchorPoint.y + gap + height / 2
        attachX = anchorPoint.x
        attachY = middle - height / 2
    case .centre:
        left = anchorPoint.x - width / 2
        middle = anchorPoint.y
        attachX = anchorPoint.x
        attachY = anchorPoint.y
    case .right:
        left = anchorPoint.x + gap
        middle = anchorPoint.y
        attachX = left
        attachY = middle
    }

    left += shiftX
    middle += shiftY
    attachX += shiftX
    attachY += shiftY

    let box = CGRect(
        x: left - BOX_PADDING, y: middle - height / 2 - BOX_PADDING,
        width: width + BOX_PADDING * 2, height: height + BOX_PADDING * 2)

    let clear = !boxes.contains { $0.intersects(box) }
    if !clear && style.declutter { return }
    boxes.append(box)

    let color = style.color

    // Tether down to the ground point, for anchors standing off the surface.
    // Drawn only when both ends are in view: the line is short next to the
    // globe, so cutting it at the silhouette would cost more than it is worth.
    if style.stem {
        let length = (here.x * here.x + here.y * here.y + here.z * here.z).squareRoot()
        if length > 1.0005 {
            let foot = projectSpace(
                camera, here.x / length, here.y / length, here.z / length)
            if foot.visible {
                ctx.setStrokeColor(color.withAlpha(alpha * 0.4).cg)
                ctx.setLineWidth(1)
                ctx.beginPath()
                ctx.move(to: CGPoint(x: foot.x, y: foot.y))
                ctx.addLine(to: CGPoint(x: anchorPoint.x, y: anchorPoint.y))
                ctx.strokePath()

                ctx.setFillColor(color.withAlpha(alpha * 0.7).cg)
                ctx.fillEllipse(in: CGRect(x: foot.x - 1.5, y: foot.y - 1.5, width: 3, height: 3))
            }
        }
    }

    if style.leader && style.placement != .centre {
        ctx.setStrokeColor(color.withAlpha(alpha * 0.45).cg)
        ctx.setLineWidth(1)
        ctx.beginPath()
        ctx.move(to: CGPoint(x: anchorPoint.x, y: anchorPoint.y))
        ctx.addLine(to: CGPoint(x: attachX, y: attachY))
        ctx.strokePath()
    }

    if style.dot > 0 {
        ctx.setFillColor(color.withAlpha(alpha).cg)
        ctx.fillEllipse(
            in: CGRect(
                x: anchorPoint.x - style.dot, y: anchorPoint.y - style.dot,
                width: style.dot * 2, height: style.dot * 2))
    }

    let origin = CGPoint(x: left, y: middle - Double(measured.height) / 2)

    // The halo is stroked under the glyphs, half its width falling outside
    // them - what lifts the text off the coastlines behind it. Stroke width in
    // attributed strings is a percentage of the font size.
    if let halo = style.halo {
        let haloColor = NSColor(
            srgbRed: halo.r / 255, green: halo.g / 255, blue: halo.b / 255,
            alpha: halo.a * alpha)
        var haloAttributes = attributes
        haloAttributes[.strokeColor] = haloColor
        haloAttributes[.strokeWidth] = style.haloWidth / style.size * 100
        (text as NSString).draw(at: origin, withAttributes: haloAttributes)
    }

    (text as NSString).draw(at: origin, withAttributes: attributes)
}
