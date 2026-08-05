//
//  Colours for the globe's drawn layers, standing in for the CSS colour
//  strings the web styles carry: channels 0-255, alpha 0-1.
//

import CoreGraphics

public struct RGBA {
    public var r: Double
    public var g: Double
    public var b: Double
    public var a: Double

    public init(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) {
        self.r = r
        self.g = g
        self.b = b
        self.a = a
    }

    var cg: CGColor {
        CGColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
    }

    public func withAlpha(_ alpha: Double) -> RGBA {
        RGBA(r, g, b, a * alpha)
    }
}
