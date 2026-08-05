//
//  The globe's view stack: an MTKView drawing the surface on the GPU with a
//  CoreGraphics overlay view above it carrying the coastlines, orbits, labels
//  and models - the same two-layer architecture as the web component, where a
//  WebGL canvas sits behind the 2D one that owns the input.
//
//  Ports the frame loop of src/components/GlobeCanvas.tsx and the layer order
//  of src/globe/renderer.ts. Pointer input - drag, scroll, pinch, hover - is
//  owned here, as the web component owns it; anything higher-level (keys, a
//  HUD) belongs to the host application, talking through GlobeController.
//

import AppKit
import MetalKit
import SwiftUI

/// The globe as a SwiftUI view. Create a `GlobeController`, hand it in, and
/// talk to the globe through it - the camera, the toggles, and the scene.
///
///     @StateObject private var globe = GlobeController()
///
///     var body: some View {
///         GlobeView(controller: globe)
///             .onAppear { globe.scene = myScene }
///     }
public struct GlobeView: NSViewControllerRepresentable {
    private let controller: GlobeController

    public init(controller: GlobeController) {
        self.controller = controller
    }

    public func makeNSViewController(context: Context) -> NSViewController {
        GlobeViewController(controller: controller)
    }

    public func updateNSViewController(_ viewController: NSViewController, context: Context) {}
}

/// Radians of idle spin per second - per second, not per frame, so the globe
/// turns at the same rate whatever the display is doing.
private let AUTO_ROTATE_SPEED = 0.21
/// Radians of rotation per point dragged, at a zoom of one. Divided by the
/// zoom in use, so a pixel of pointer movement is the same distance of ground
/// however far in you are.
private let DRAG_SENSITIVITY = 0.005

/// How long the bare sphere takes to dissolve into the meshed one, in seconds.
private let HANDOVER_SECONDS = 0.6

private let LIMB = RGBA(150, 200, 250, 0.75)
private let GRATICULE = RGBA(190, 220, 250, 0.22)
private let COAST = RGBA(200, 226, 250, 0.7)

/// Where the globe sits on screen for a given viewport and controller state.
/// Shared so that hit-testing a pointer and drawing cannot disagree.
func globeCamera(_ viewport: ViewportSize, _ state: GlobeController) -> Camera {
    makeCamera(
        cx: viewport.width / 2,
        cy: viewport.height / 2,
        radius: min(viewport.width, viewport.height) / 2 * 0.72 * state.zoom,
        longitude: state.longitude,
        latitude: state.latitude)
}

private func clamp01(_ value: Double) -> Double { min(1, max(0, value)) }

final class GlobeViewController: NSViewController, MTKViewDelegate {
    let state: GlobeController
    private var renderer: MetalRenderer?
    private var mesh: SurfaceMesh?

    private var mtkView: MTKView?
    private var overlayView: OverlayView?

    private var lastFrame = CACurrentMediaTime()

    // Averaged over a window rather than reported per frame: a single frame's
    // figure jitters far too much to read.
    private var windowStart = CACurrentMediaTime()
    private var windowFrames = 0
    private var windowDrawSeconds = 0.0

    /// When the mesh first became whole, or negative until it did; latched
    /// once the dissolve has finished so a reset does not bring the loading
    /// sphere back.
    private var handoverAt = -1.0
    private var handedOver = false

    /// Self-snapshot for headless verification: with ERSETU_SNAPSHOT set to a
    /// path, the app writes a composite PNG of both layers once the scene has
    /// settled, then quits. Window capture needs permissions a command-line
    /// run does not have; the app photographing itself does not.
    private let snapshotPath = ProcessInfo.processInfo.environment["ERSETU_SNAPSHOT"]
    private let snapshotDelay =
        Double(ProcessInfo.processInfo.environment["ERSETU_SNAPSHOT_DELAY"] ?? "") ?? 4

    init(controller: GlobeController) {
        self.state = controller
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = BackgroundView(frame: NSRect(x: 0, y: 0, width: 1100, height: 800))
        root.autoresizingMask = [.width, .height]

        let renderer = MetalRenderer(chunkCount: CHUNK_COUNT)
        self.renderer = renderer
        if let renderer {
            mesh = SurfaceMesh(renderer: renderer, terrain: Terrain.shared)

            let mtk = MTKView(frame: root.bounds, device: renderer.device)
            mtk.autoresizingMask = [.width, .height]
            mtk.colorPixelFormat = .bgra8Unorm
            mtk.depthStencilPixelFormat = .depth32Float
            mtk.sampleCount = 4
            mtk.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
            mtk.preferredFramesPerSecond = 60
            mtk.delegate = self
            (mtk.layer as? CAMetalLayer)?.isOpaque = false
            root.addSubview(mtk)
            mtkView = mtk
        } else {
            print("Metal unavailable; the globe will draw without its surface.")
        }

        let overlay = OverlayView(frame: root.bounds, controller: state)
        overlay.autoresizingMask = [.width, .height]
        root.addSubview(overlay)
        overlayView = overlay

        self.view = root

        // The eight tiles of level 0 - the whole world; nothing can be drawn
        // without them. Deeper levels are opened as the mesh earns them.
        do {
            try Terrain.shared.open()
        } catch {
            print("Terrain unavailable; shading the globe flat: \(error)")
        }
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    /// The animation loop: driven by the MTKView's display link, one pass a
    /// frame - update the clock, cull and build the surface, draw it, then
    /// hand the same camera to the overlay so the two layers cannot disagree.
    func draw(in view: MTKView) {
        let now = CACurrentMediaTime()
        // Clamp the step so a blocked run loop does not resume with a jump.
        let delta = min(0.1, now - lastFrame)
        lastFrame = now

        if state.autoRotate { state.rotate(by: AUTO_ROTATE_SPEED * delta, 0) }
        state.elapsed += delta

        let scale = view.window?.backingScaleFactor ?? 2
        let viewport = ViewportSize(
            width: view.bounds.width, height: view.bounds.height, scale: scale)
        if viewport.width <= 0 || viewport.height <= 0 { return }

        let camera = globeCamera(viewport, state)
        let drawStart = CACurrentMediaTime()

        // Costs an identity comparison when nothing has changed.
        renderer?.setOverlay(state.scene.overlay?(state.elapsed))

        // The surface: cull, build whatever the frame's budget allows, draw.
        var cover = 1.0
        if let mesh, let renderer {
            mesh.update(camera: camera, viewport: viewport, exaggeration: state.exaggeration)

            // The whole mesh has to exist before it can be shown: the fallback
            // disc is drawn on the overlay, which sits over the GPU view, so
            // it is all of one or all of the other.
            let whole = mesh.stats.built == mesh.stats.chunks

            // One rung at a time: the next level is only worth fetching once
            // the mesh has finished with the one below it.
            Terrain.shared.prefetchResident(through: whole ? mesh.stats.detail + 1 : 0)

            if whole {
                // Rounded hard, so a subscriber re-renders when the figure
                // visibly changes rather than on every frame.
                let triangles = mesh.stats.triangles / 100 * 100
                if triangles != state.meshTriangles { state.meshTriangles = triangles }
                let detail = max(0, mesh.stats.detail)
                if detail != state.detail { state.detail = detail }
                if handoverAt < 0 { handoverAt = state.elapsed }
            }

            renderer.draw(
                in: view, camera: camera, viewport: viewport,
                exaggeration: state.exaggeration, visible: mesh.visible)

            // Dissolved rather than cut: the two are painted to match, so a
            // short fade reads as the sphere gaining its ground.
            cover = 0
            if !handedOver {
                cover =
                    handoverAt < 0
                    ? 1 : 1 - clamp01((state.elapsed - handoverAt) / HANDOVER_SECONDS)
                if cover <= 0 { handedOver = true }
            }
        }

        // Resolved every frame rather than only on pointer moves, so the
        // reading stays true while the globe turns under a still cursor.
        let hover = overlayView?.pointer.flatMap { pointer -> GeoPoint? in
            guard let point = unproject(camera, pointer.x, pointer.y) else { return nil }
            // Rounded to the precision a readout shows, so the published
            // value only changes when the reading visibly does.
            return GeoPoint(
                longitude: (point.longitude * 100).rounded() / 100,
                latitude: (point.latitude * 100).rounded() / 100)
        }
        if hover != state.hover { state.hover = hover }

        overlayView?.camera = camera
        overlayView?.cover = cover
        overlayView?.needsDisplay = true

        if let snapshotPath, state.elapsed >= snapshotDelay {
            writeSnapshot(to: snapshotPath, camera: camera, viewport: viewport)
            NSApp.terminate(nil)
        }

        windowDrawSeconds += CACurrentMediaTime() - drawStart
        windowFrames += 1
        updatePerformanceWindow(now)
    }

    private func updatePerformanceWindow(_ now: Double) {
        if now - windowStart >= 0.25 {
            let fps = (Double(windowFrames) / (now - windowStart)).rounded()
            let frameMs =
                (windowDrawSeconds * 1000 / Double(windowFrames) * 10).rounded() / 10
            if fps != state.fps { state.fps = fps }
            if frameMs != state.frameMs { state.frameMs = frameMs }
            windowStart = now
            windowFrames = 0
            windowDrawSeconds = 0
        }
    }

    /// Composite the three layers - page background, GPU surface, CG overlay -
    /// into one PNG, exactly as they stack on screen.
    private func writeSnapshot(to path: String, camera: Camera, viewport: ViewportSize) {
        guard let renderer, let mesh, let overlayView else { return }

        let width = Int((viewport.width * viewport.scale).rounded())
        let height = Int((viewport.height * viewport.scale).rounded())
        guard
            let space = CGColorSpace(name: CGColorSpace.sRGB),
            let ctx = CGContext(
                data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return }

        // The page background, as BackgroundView draws it.
        ctx.setFillColor(RGBA(6, 10, 18).cg)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        if let gradient = CGGradient(
            colorsSpace: space,
            colors: [RGBA(30, 60, 110, 0.35).cg, RGBA(30, 60, 110, 0).cg] as CFArray,
            locations: [0, 1])
        {
            // This context is unflipped, so 40% from the top is 60% up.
            let centre = CGPoint(x: Double(width) * 0.5, y: Double(height) * 0.6)
            ctx.drawRadialGradient(
                gradient, startCenter: centre, startRadius: 0,
                endCenter: centre, endRadius: Double(max(width, height)) * 0.65, options: [])
        }

        let frame = CGRect(x: 0, y: 0, width: width, height: height)
        if let surface = renderer.snapshot(
            camera: camera, viewport: viewport, exaggeration: state.exaggeration,
            visible: mesh.visible)
        {
            ctx.draw(surface, in: frame)
        }

        if let rep = overlayView.bitmapImageRepForCachingDisplay(in: overlayView.bounds) {
            overlayView.cacheDisplay(in: overlayView.bounds, to: rep)
            if let image = rep.cgImage { ctx.draw(image, in: frame) }
        }

        guard let composite = ctx.makeImage(),
            let destination = CGImageDestinationCreateWithURL(
                URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil)
        else { return }
        CGImageDestinationAddImage(destination, composite, nil)
        CGImageDestinationFinalize(destination)
        print("Snapshot written to \(path)")
    }
}

/// The page behind the globe: the same dark ground and faint blue ellipse as
/// the web page's CSS background.
final class BackgroundView: NSView {
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.setFillColor(RGBA(6, 10, 18).cg)
        ctx.fill(bounds)

        guard
            let gradient = CGGradient(
                colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
                colors: [RGBA(30, 60, 110, 0.35).cg, RGBA(30, 60, 110, 0).cg] as CFArray,
                locations: [0, 1])
        else { return }
        let centre = CGPoint(x: bounds.width * 0.5, y: bounds.height * 0.4)
        ctx.drawRadialGradient(
            gradient, startCenter: centre, startRadius: 0,
            endCenter: centre, endRadius: max(bounds.width, bounds.height) * 0.65,
            options: [])
    }
}

/// The 2D layer: everything drawn over the surface, in the order of
/// renderGlobe in src/globe/renderer.ts, plus the pointer handling of
/// GlobeCanvas.tsx.
final class OverlayView: NSView {
    private unowned let controller: GlobeController

    // Baked once at load: lon/lat degrees -> unit-sphere xyz.
    private let coastlines = buildMesh(COASTLINE_RINGS)
    private let landfill = buildPolygonMesh(COASTLINE_POLYGONS)
    private let graticule = buildMesh(buildGraticule(stepDegrees: 30))

    /// This frame's camera, set by the controller before display so the two
    /// layers cannot disagree about where the sphere is.
    var camera: Camera?
    /// How much of the fallback disc to draw over the GPU surface.
    var cover = 1.0

    /// Latest pointer position in view coordinates, or nil when off the view.
    private(set) var pointer: CGPoint?

    private var dragging = false
    private var lastDrag = CGPoint.zero
    private var resumeAutoRotate = false
    private var trackingArea: NSTrackingArea?

    init(frame: NSRect, controller: GlobeController) {
        self.controller = controller
        super.init(frame: frame)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
            owner: self)
        addTrackingArea(area)
        trackingArea = area
    }

    // MARK: - Drawing

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext, let camera else { return }
        let state = controller
        let scene = state.scene
        let sceneTime = state.elapsed * scene.timeScale

        ctx.setLineJoin(.round)
        ctx.setLineCap(.round)

        // A plain disc while the mesh is still building, with the land filled
        // from the coastline geometry so the continents are there from the
        // first frame.
        if cover > 0 {
            ctx.setAlpha(cover)
            ctx.beginTransparencyLayer(auxiliaryInfo: nil)
            paintSphere(ctx, camera)
            ctx.setFillColor(FLAT_LAND.cg)
            fillPolygons(ctx, landfill, camera)
            ctx.endTransparencyLayer()
            ctx.setAlpha(1)
        }

        ctx.setLineWidth(1.25)

        // Areas first, under every line: a fill is ground, and the graticule
        // and coastlines drawn over it stay legible rather than being buried.
        if let regions = scene.regions {
            for item in regions(state.elapsed) {
                if let fill = item.style.fill {
                    ctx.setFillColor(fill.cg)
                    fillPolygons(ctx, item.polygons, camera)
                }
                if let stroke = item.style.stroke {
                    ctx.setStrokeColor(stroke.cg)
                    ctx.setLineWidth(item.style.width)
                    strokeMesh(ctx, item.polygons.outline, camera)
                }
            }
            ctx.setLineWidth(1.25)
        }

        ctx.setStrokeColor(GRATICULE.cg)
        strokeMesh(ctx, graticule, camera)

        // The land outlines, from the coastline dataset rather than from the
        // terrain - the two do not quite agree, so being able to drop these is
        // being able to see the ground on its own terms.
        if state.outlines {
            ctx.setStrokeColor(COAST.cg)
            strokeMesh(ctx, coastlines, camera)
        }

        // Sphere silhouette, over the shaded limb. Displaced terrain has a
        // silhouette of its own, so this fades out with the disc it belongs to.
        if cover > 0 {
            ctx.setAlpha(cover)
            ctx.setStrokeColor(LIMB.cg)
            ctx.strokeEllipse(
                in: CGRect(
                    x: camera.cx - camera.radius, y: camera.cy - camera.radius,
                    width: camera.radius * 2, height: camera.radius * 2))
            ctx.setAlpha(1)
        }

        // Surface overlays go through the same horizon clipping as the
        // coastlines, so they are hidden exactly where the surface curves away.
        for item in scene.shapes {
            ctx.setStrokeColor(item.style.color.cg)
            ctx.setLineWidth(item.style.width)
            ctx.setLineDash(phase: 0, lengths: item.style.dash.map { CGFloat($0) })
            strokeMesh(ctx, item.mesh, camera)
        }
        ctx.setLineDash(phase: 0, lengths: [])

        // Orbits stand off the surface, so they use occlusion against the
        // globe rather than the horizon test.
        drawOrbits(ctx, camera, scene.orbits, sceneTime)

        // Models after the orbits, so a satellite's own path passes behind it,
        // but before the labels, which name them.
        if !scene.models.isEmpty {
            drawModels(ctx, camera, scene.models, sceneTime, exaggeration: state.exaggeration)
        }

        // Text on top of everything: it is the one layer that cannot be read
        // through whatever is drawn over it.
        drawLabels(ctx, camera, scene.labels, sceneTime)
    }

    // MARK: - Pointer input (GlobeCanvas.tsx)

    override func mouseDown(with event: NSEvent) {
        dragging = true
        lastDrag = convert(event.locationInWindow, from: nil)
        resumeAutoRotate = controller.autoRotate
        controller.autoRotate = false
    }

    override func mouseDragged(with event: NSEvent) {
        let here = convert(event.locationInWindow, from: nil)
        pointer = here
        guard dragging else { return }
        // Scaled by the zoom, so a pixel of pointer movement is the same
        // distance of ground however far in you are.
        let radians = DRAG_SENSITIVITY / controller.zoom
        controller.rotate(
            by: (here.x - lastDrag.x) * -radians,
            (here.y - lastDrag.y) * radians)
        lastDrag = here
    }

    override func mouseUp(with event: NSEvent) {
        guard dragging else { return }
        dragging = false
        if resumeAutoRotate { controller.autoRotate = true }
    }

    override func mouseMoved(with event: NSEvent) {
        pointer = convert(event.locationInWindow, from: nil)
    }

    override func mouseExited(with event: NSEvent) {
        pointer = nil
    }

    override func scrollWheel(with event: NSEvent) {
        // A line of wheel is a few points of scrollingDelta, so this matches
        // the web's exp(-deltaY / 1000) per wheel notch closely enough.
        controller.zoom(by: exp(event.scrollingDeltaY * 0.002))
    }

    override func magnify(with event: NSEvent) {
        controller.zoom(by: 1 + event.magnification)
    }
}
