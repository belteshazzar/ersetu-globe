# ErsetuGlobe

The globe as a Swift package: the engine from the web component at the
repository root - Metal surface, streamed terrain, and the drawn layers -
behind a SwiftUI view and a controller to talk to it.

```swift
import ErsetuGlobe
import SwiftUI

struct MyView: View {
    @StateObject private var globe = GlobeController()

    var body: some View {
        GlobeView(controller: globe)
            .onAppear {
                globe.scene = GlobeScene(
                    shapes: [
                        shape(
                            [geodesic([(-0.13, 51.51), (-74.01, 40.71)])],
                            ShapeStyle(color: RGBA(255, 214, 122, 0.95), width: 1.75)),
                    ],
                    orbits: [
                        orbit(
                            OrbitElements(
                                altitudeKm: 420, inclination: 51.6,
                                ascendingNode: 10, periodSeconds: 5580),
                            OrbitStyle(color: RGBA(150, 220, 255, 0.5)),
                            SatelliteStyle(color: RGBA(200, 240, 255, 1), size: 3.2, trail: 40)),
                    ],
                    labels: [label("London", (-0.13, 51.51))],
                    timeScale: 400)
                globe.look(at: (-0.13, 51.51))
            }
    }
}
```

## The controller

`GlobeController` is the whole API surface at runtime.

**Camera and toggles** are plain properties, read by the render loop each
frame: `longitude`/`latitude` (radians; or `look(at:)` and `rotate(by:_:)`),
`zoom` (0.5-8), `autoRotate`, `outlines`, `exaggeration` (0-80, 0 for a true
sphere), and `scene`. They are deliberately not published - interaction
mutates them sixty times a second, and no view should re-render on that.

**Readouts** are `@Published`, written from the render loop at a few hertz and
rounded so a subscriber re-renders when a figure visibly changes: `fps`,
`frameMs`, `meshTriangles`, `detail` (the terrain level the whole globe is
guaranteed at), and `hover` (the lon/lat under the cursor, or nil).

## The scene

`GlobeScene` is what is drawn over the surface, in the web renderer's layer
order: `regions` (filled areas, under every line - a per-frame provider so a
tween can move), then the built-in graticule and coastlines, then `shapes`
(surface polylines, clipped at the horizon), `orbits` (occluded by the globe
rather than the horizon, satellites and trails included), `models` (small 3D
assemblies standing on the displaced terrain or flying), and `labels` (the top
layer, decluttered by collision, array order the priority). `overlay` is a
per-frame provider of a scalar field painted by the surface shader itself -
weather, most likely. `timeScale` is the scene clock: seconds of animation
time per real second, which orbits, spins and moving labels run on;
the `regions` and `overlay` providers get plain elapsed seconds.

Builders: `geodesic`, `geodesicRing`, `smallCircle`, `shape`, `region`,
`regionOf`, `Morph` (tween one set of polygons into another), `orbit`,
`label`, `labelAbove`, `labelOn`, `loadModel`, `placeOnSurface`,
`placeInOrbit`, `makeField`, `palette`, `Track`/`Keyframe`/`smoothstep`.

Pointer input - drag to rotate, scroll and pinch to zoom, hover for the
readout - is owned by the view, as the web component owns it. Keys and HUDs
belong to the host application; `packages/macos-demo` shows both.

## Inside

The architecture is the web component's, one to one: an `MTKView` draws the
displaced surface (the WebGL shaders of `src/globe/gl.ts` ported to MSL - a
vertex is a direction and a height, exaggeration is one multiply, occlusion is
the depth buffer) and a flipped CoreGraphics view above it draws everything
else, which let the projection and clipping code port line for line. The
terrain pyramid ships in the bundle rather than over HTTP, but arrives the
same way: level 0 before anything draws, each finer level opened only once the
mesh has finished the one below, chunks rebuilt within a per-frame budget so
the globe sharpens rung by rung.

`Resources/terrain-*.bin` are copied from the repository's `public/`, and
`Resources/coastlines.json` is the generated Natural Earth module re-expressed
as JSON.

## Snapshots

With `ERSETU_SNAPSHOT=/path.png` in the environment the view writes a
composite PNG of both layers once `ERSETU_SNAPSHOT_DELAY` seconds (default 4)
have elapsed, then quits - headless verification without the screen-recording
permissions window capture would need.
