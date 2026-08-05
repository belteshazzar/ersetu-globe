# ersetu-globe / macos

The demo macOS application: the same scene as the web example - routes, range
rings, tweened regions, orbits with satellites, labels, models and the
synthetic weather overlay - built on the `ErsetuGlobe` package in
`../swift`.

```bash
cd packages/macos-demo
swift run
```

| input | what it does |
| --- | --- |
| drag | rotate |
| scroll / pinch | zoom |
| space | toggle the idle spin |
| `O` | toggle the coastline outlines |
| `W` | toggle the weather overlay |
| `[` / `]` | relief exaggeration down / up (`0` for a true sphere) |
| `R` | reset the view |

`App.swift` is the whole application: a `GlobeController`, a `GlobeView`, a
SwiftUI HUD observing the controller's published readouts, and a key monitor
mapping the table above onto controller properties. `DemoContent.swift` builds
the scene, and is the file to replace with your own.

For a headless picture: `ERSETU_SNAPSHOT=/tmp/globe.png swift run`, with
`ERSETU_OVERLAY=1` and `ERSETU_STILL=1` for a reproducible frame and
`ERSETU_SNAPSHOT_DELAY` (seconds) to let the terrain ladder finish first.
