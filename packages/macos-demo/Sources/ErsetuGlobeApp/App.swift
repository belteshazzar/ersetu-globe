//
//  The demo application: a window, the globe, a HUD, and key bindings - the
//  SwiftUI equivalent of the web repository's App.tsx and Hud.tsx. Everything
//  the globe needs travels through GlobeController; this file only decides
//  what to show and which keys do what.
//

import AppKit
import ErsetuGlobe
import SwiftUI

/// Launched by `swift run` there is no app bundle, and without one the
/// process comes up as a background ("prohibited") application: its window is
/// created but never brought on screen, there is no Dock icon, and no menu
/// bar. Claiming regular status and activating is what an app bundle's
/// Info.plist would otherwise have arranged.
final class AppActivator: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        NSApp.windows.first?.makeKeyAndOrderFront(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

@main
struct ErsetuGlobeApp: App {
    @NSApplicationDelegateAdaptor(AppActivator.self) private var activator

    var body: some Scene {
        WindowGroup("ersetu-globe") {
            ContentView()
                .frame(minWidth: 640, minHeight: 480)
        }
        .defaultSize(width: 1100, height: 800)
    }
}

struct ContentView: View {
    @StateObject private var globe = GlobeController()
    @State private var weather = false
    @State private var keyMonitor: Any?

    var body: some View {
        ZStack(alignment: .topLeading) {
            GlobeView(controller: globe)
                .ignoresSafeArea()
            Hud(globe: globe)
                .padding(14)
                .allowsHitTesting(false)
        }
        .onAppear(perform: start)
        .onDisappear {
            if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
            keyMonitor = nil
        }
    }

    private func start() {
        globe.scene = GlobeScene(
            shapes: DEMO_SHAPES,
            orbits: DEMO_ORBITS,
            labels: DEMO_LABELS,
            regions: demoRegionsAt,
            timeScale: DEMO_TIME_SCALE)

        // A few kB each, and entirely optional: the globe draws without them
        // and gains them when they land.
        DispatchQueue.global(qos: .utility).async {
            let models = loadDemoModels()
            DispatchQueue.main.async { globe.scene.models = models }
        }

        // Scene toggles for headless snapshot runs, which cannot press keys.
        let environment = ProcessInfo.processInfo.environment
        if environment["ERSETU_OVERLAY"] != nil { setWeather(true) }
        if environment["ERSETU_STILL"] != nil { globe.autoRotate = false }

        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            handle(event) ? nil : event
        }
    }

    private func setWeather(_ on: Bool) {
        weather = on
        globe.scene.overlay = on ? demoOverlayAt : nil
    }

    private func handle(_ event: NSEvent) -> Bool {
        switch event.charactersIgnoringModifiers?.lowercased() {
        case " ":
            globe.autoRotate.toggle()
        case "o":
            globe.outlines.toggle()
        case "w":
            setWeather(!weather)
        case "r":
            globe.reset()
            setWeather(false)
        case "[":
            globe.exaggeration -= 5
        case "]":
            globe.exaggeration += 5
        case "0":
            globe.exaggeration = 0
        default:
            return false
        }
        return true
    }
}

/// The readouts the web page's HUD shows, as observing SwiftUI text - only
/// this view re-renders when a published figure changes.
private struct Hud: View {
    @ObservedObject var globe: GlobeController

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(readout)
            Text(reliefLine)
            Text("drag rotate · scroll zoom · space spin · O outlines · W weather · [ ] relief · R reset")
                .foregroundStyle(.secondary)
        }
        .font(.system(size: 11).monospacedDigit())
        .foregroundStyle(Color(red: 226 / 255, green: 238 / 255, blue: 1).opacity(0.92))
    }

    private var readout: String {
        String(
            format: "%.0f fps · %.1f ms · %@ triangles · detail L%d",
            globe.fps, globe.frameMs,
            globe.meshTriangles.formatted(.number), globe.detail)
    }

    private var reliefLine: String {
        var line = String(format: "relief ×%.0f", globe.exaggeration)
        if let hover = globe.hover {
            line += String(format: " · lon %.2f° lat %.2f°", hover.longitude, hover.latitude)
        }
        return line
    }
}
