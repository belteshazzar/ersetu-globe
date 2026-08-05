//
//  The globe's public face: everything a host application sets or reads.
//
//  The camera and toggles are plain properties rather than @Published,
//  deliberately: the render loop reads them every frame and interaction
//  mutates them sixty times a second, and publishing that would drag SwiftUI
//  through an invalidation per frame for values no view needs to observe.
//  The readouts - which a HUD does want to observe - are published, and the
//  render loop writes them at a few hertz, rounded, so a subscriber re-renders
//  when a figure visibly changes rather than on every frame. This is the same
//  split the web version makes: its render loop reads the store imperatively,
//  and its HUD subscribes to rounded values.
//

import Foundation

/// Past this the globe stops reading as a globe: the deepest trenches fold in
/// towards the centre and the silhouette turns to spikes.
public let MAX_EXAGGERATION = 80.0

/// Everything drawn on top of the globe itself, plus the clock it animates on.
public struct GlobeScene {
    /// Geometry lying on the surface, hidden exactly where it curves away.
    public var shapes: [Shape]
    /// Orbits standing off the surface, with their satellites.
    public var orbits: [Orbit]
    /// Text pinned to the surface, to points above it, or to moving entities.
    /// Drawn last, over everything; earlier labels win any collision.
    public var labels: [GlobeLabel]
    /// Small 3D models standing on the surface or flying above it.
    public var models: [ModelPlacement]
    /// Filled areas lying on the surface, drawn beneath every line. Asked for
    /// each frame with the elapsed seconds, so a tweened border can move.
    public var regions: ((Double) -> [Region])?
    /// A scalar field painted over the whole surface by the surface shader
    /// itself. Asked for each frame with the elapsed seconds.
    public var overlay: ((Double) -> Overlay?)?
    /// Scene-clock seconds per real second - the clock orbits, spins and
    /// moving labels run on. 1 is real time, which for orbits is glacial.
    public var timeScale: Double

    public init(
        shapes: [Shape] = [],
        orbits: [Orbit] = [],
        labels: [GlobeLabel] = [],
        models: [ModelPlacement] = [],
        regions: ((Double) -> [Region])? = nil,
        overlay: ((Double) -> Overlay?)? = nil,
        timeScale: Double = 1
    ) {
        self.shapes = shapes
        self.orbits = orbits
        self.labels = labels
        self.models = models
        self.regions = regions
        self.overlay = overlay
        self.timeScale = timeScale
    }
}

public final class GlobeController: ObservableObject {
    // MARK: Camera and toggles - read by the render loop each frame.

    /// Rotation about the polar axis, radians.
    public var longitude = 0.0
    /// Camera tilt above the equator, radians, clamped to +/- pi/2.
    public var latitude = 0.35
    /// Distance multiplier from the globe centre. 1 fits the viewport;
    /// clamped to 0.5 ... 8.
    public var zoom = 1.0 {
        didSet { zoom = min(8, max(0.5, zoom)) }
    }
    /// Whether the idle spin animation is running.
    public var autoRotate = true
    /// Whether the land outlines are drawn over the surface. They come from a
    /// coastline dataset rather than from the terrain, so at depth the two
    /// disagree about where the water starts - worth being able to drop.
    public var outlines = true
    /// How far the terrain is displaced, as a multiple of true height.
    /// 0 is a true sphere; clamped to 0 ... MAX_EXAGGERATION.
    public var exaggeration = 30.0 {
        didSet { exaggeration = min(MAX_EXAGGERATION, max(0, exaggeration)) }
    }
    /// What is drawn over the globe. Replace it, or mutate parts of it, at
    /// any time; the next frame picks it up.
    public var scene = GlobeScene()

    /// Seconds since the view appeared - the clock the scene providers are
    /// asked with, driven by the display rather than the frame count.
    public internal(set) var elapsed = 0.0

    // MARK: Readouts - published at a few hertz from the render loop.

    /// Frames per second, averaged over the last quarter second.
    @Published public internal(set) var fps = 0.0
    /// Milliseconds of main-thread draw time per frame, same window.
    @Published public internal(set) var frameMs = 0.0
    /// Triangles the surface costs per frame, rounded to the nearest hundred.
    @Published public internal(set) var meshTriangles = 0
    /// The terrain pyramid level the whole globe is guaranteed at.
    @Published public internal(set) var detail = 0
    /// Where the pointer sits on the globe, in degrees, or nil when it is off
    /// the sphere. Updated every frame while the cursor is over the globe.
    @Published public internal(set) var hover: GeoPoint?

    public init() {}

    // MARK: Interaction

    private let halfPi = Double.pi / 2
    private let tau = Double.pi * 2

    /// Turn the globe by an angle, in radians.
    public func rotate(by dLongitude: Double, _ dLatitude: Double) {
        longitude = (longitude + dLongitude).truncatingRemainder(dividingBy: tau)
        latitude = min(halfPi, max(-halfPi, latitude + dLatitude))
    }

    /// Put a place in the middle of the disc.
    public func look(at place: LonLat) {
        longitude = place.0 * Double.pi / 180
        latitude = place.1 * Double.pi / 180
    }

    public func zoom(by factor: Double) {
        zoom *= factor
    }

    /// Back to the launch view: home orientation, spin on, outlines on,
    /// relief at 30. The scene is left alone; it is the caller's.
    public func reset() {
        longitude = 0
        latitude = 0.35
        zoom = 1
        autoRotate = true
        outlines = true
        exaggeration = 30
        elapsed = 0
    }
}
