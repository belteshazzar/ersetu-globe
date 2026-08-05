//
//  A scalar field painted over the globe, and the ramp that colours it.
//  Port of src/globe/overlay.ts and src/globe/track.ts.
//
//  The thing uploaded is the measurement, not a picture of it: interpolate the
//  field, then colour it, and every intermediate frame means something.
//

import Foundation

/// The lon/lat box a field covers, in degrees.
public struct Bounds {
    public var west: Double
    public var east: Double
    public var south: Double
    public var north: Double

    public init(west: Double, east: Double, south: Double, north: Double) {
        self.west = west
        self.east = east
        self.south = south
        self.north = north
    }
}

/// The whole globe, which is what a field covers unless it says otherwise.
public let GLOBE_BOUNDS = Bounds(west: -180, east: 180, south: -90, north: 90)

/// Degrees of longitude a box spans, going east; 360 for the whole way round.
func spanEast(_ bounds: Bounds) -> Double {
    let span = ((bounds.east - bounds.west).truncatingRemainder(dividingBy: 360) + 360)
        .truncatingRemainder(dividingBy: 360)
    return span == 0 ? 360 : span
}

/// An equirectangular grid over a lon/lat box. A class, because the texture
/// cache keys fields by identity - a sequence of frames cycled over and over
/// is uploaded once each.
public final class Field {
    let width: Int
    let height: Int
    /// One byte a sample, row-major from the north-west corner.
    let samples: [UInt8]
    let bounds: Bounds

    public init(width: Int, height: Int, samples: [UInt8], bounds: Bounds) {
        self.width = width
        self.height = height
        self.samples = samples
        self.bounds = bounds
    }
}

public struct Overlay {
    public var field: Field
    /// The frame being crossed to, if this is a moment between two of them.
    public var next: Field?
    /// Where between the two this moment lies. 0 is `field`, 1 is `next`.
    public var mix: Double
    /// 256 RGBA entries, indexed by sample value.
    public var palette: [UInt8]
    /// How much of it to show, over the surface beneath.
    public var opacity: Double

    public init(
        field: Field, next: Field? = nil, mix: Double = 0, palette: [UInt8], opacity: Double
    ) {
        self.field = field
        self.next = next
        self.mix = mix
        self.palette = palette
        self.opacity = opacity
    }
}

public struct PaletteStop {
    /// Where this colour sits, 0 to 1 across the field's range.
    public var at: Double
    public var color: (Double, Double, Double)
    /// 1 by default. Zero leaves the ground showing through untouched.
    public var alpha: Double

    public init(at: Double, color: (Double, Double, Double), alpha: Double = 1) {
        self.at = at
        self.color = color
        self.alpha = alpha
    }
}

/// Build the 256-entry ramp a field is coloured through. Alpha is interpolated
/// alongside the colour, which is what gives a scale a transparent middle.
public func palette(_ stops: [PaletteStop]) -> [UInt8] {
    var out = [UInt8](repeating: 0, count: 256 * 4)
    if stops.isEmpty { return out }

    let sorted = stops.sorted { $0.at < $1.at }
    var i = 0
    for n in 0..<256 {
        let at = Double(n) / 255
        while i < sorted.count - 2 && at >= sorted[i + 1].at { i += 1 }

        let a = sorted[i]
        let b = sorted[min(i + 1, sorted.count - 1)]
        let span = b.at - a.at
        var t = span > 0 ? (at - a.at) / span : 0
        t = min(1, max(0, t))

        out[n * 4] = UInt8((a.color.0 + (b.color.0 - a.color.0) * t).rounded())
        out[n * 4 + 1] = UInt8((a.color.1 + (b.color.1 - a.color.1) * t).rounded())
        out[n * 4 + 2] = UInt8((a.color.2 + (b.color.2 - a.color.2) * t).rounded())
        out[n * 4 + 3] = UInt8(((a.alpha + (b.alpha - a.alpha) * t) * 255).rounded())
    }
    return out
}

/// Fill a field from a function of longitude and latitude, in radians.
/// `range` is what the byte scale spans; anything outside is clamped.
public func makeField(
    width: Int, height: Int,
    range: (Double, Double),
    bounds: Bounds = GLOBE_BOUNDS,
    at: (Double, Double) -> Double
) -> Field {
    var samples = [UInt8](repeating: 0, count: width * height)
    let (low, high) = range
    let span = high - low == 0 ? 1 : high - low

    let west = bounds.west * DEG_TO_RAD
    let north = bounds.north * DEG_TO_RAD
    let eastward = spanEast(bounds) * DEG_TO_RAD
    let southward = (bounds.north - bounds.south) * DEG_TO_RAD

    for y in 0..<height {
        // Samples sit at cell centres, so the edges of the box are half a cell
        // outside the grid rather than on top of its first and last rows.
        let latitude = north - (Double(y) + 0.5) / Double(height) * southward
        for x in 0..<width {
            let longitude = west + (Double(x) + 0.5) / Double(width) * eastward
            let t = (at(longitude, latitude) - low) / span
            samples[y * width + x] = t <= 0 ? 0 : t >= 1 ? 255 : UInt8((t * 255).rounded())
        }
    }
    return Field(width: width, height: height, samples: samples, bounds: bounds)
}

// MARK: - Keyframes and a cursor over them (track.ts)

public struct Keyframe<T> {
    public var at: Double
    public var value: T

    public init(at: Double, value: T) {
        self.at = at
        self.value = value
    }
}

/// The two states straddling a moment, and how far between them it lies.
public struct Span<T> {
    public var a: T
    public var b: T
    public var mix: Double
}

public final class Track<T> {
    let frames: [Keyframe<T>]
    let loop: Bool
    let duration: Double
    let ease: ((Double) -> Double)?
    /// Where the last search finished; time almost always creeps forward.
    var cursor = 0

    public init(
        _ frames: [Keyframe<T>], loop: Bool = false, duration: Double? = nil,
        ease: ((Double) -> Double)? = nil
    ) {
        let sorted = frames.sorted { $0.at < $1.at }
        let covered = sorted.count > 1 ? sorted[sorted.count - 1].at - sorted[0].at : 0
        self.frames = sorted
        self.loop = loop
        self.duration = max(duration ?? covered, covered)
        self.ease = ease
    }

    private func eased(_ u: Double) -> Double {
        let clamped = min(1, max(0, u))
        return ease?(clamped) ?? clamped
    }

    /// The two keyframes straddling `time`, and the fraction between them.
    public func sample(_ time: Double) -> Span<T>? {
        let n = frames.count
        if n == 0 { return nil }
        if n == 1 { return Span(a: frames[0].value, b: frames[0].value, mix: 0) }

        let start = frames[0].at
        let end = frames[n - 1].at
        var t = time

        if loop && duration > 0 {
            t = start + wrap(time - start, duration)
            if t >= end {
                // The closing segment, from the last keyframe round to the
                // first - it only exists when the cycle is longer than the
                // keyframes cover.
                let gap = start + duration - end
                let u = gap > 0 ? (t - end) / gap : 0
                return Span(a: frames[n - 1].value, b: frames[0].value, mix: eased(u))
            }
        } else {
            if t <= start { return Span(a: frames[0].value, b: frames[0].value, mix: 0) }
            if t >= end {
                return Span(a: frames[n - 1].value, b: frames[n - 1].value, mix: 0)
            }
        }

        var i = min(max(cursor, 0), n - 2)
        while i > 0 && t < frames[i].at { i -= 1 }
        while i < n - 2 && t >= frames[i + 1].at { i += 1 }
        cursor = i

        let from = frames[i].at
        let to = frames[i + 1].at
        let u = to > from ? (t - from) / (to - from) : 0
        return Span(a: frames[i].value, b: frames[i + 1].value, mix: eased(u))
    }
}

/// Positive remainder, so time before the track's start still lands in a cycle.
private func wrap(_ value: Double, _ period: Double) -> Double {
    let r = value.truncatingRemainder(dividingBy: period)
    return r < 0 ? r + period : r
}

/// Ease in and out. The usual choice for a shape that has to look deliberate.
public func smoothstep(_ t: Double) -> Double {
    t * t * (3 - 2 * t)
}
