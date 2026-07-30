# ersetu-globe

A lightweight 3D globe with no runtime dependencies beyond React, rendered
entirely with the 2D canvas API — including shaded topography and bathymetry.
No WebGL, no mapping library, no tile server.

**[Live demo](https://belteshazzar.github.io/ersetu-globe/)**

Drag to rotate, scroll to zoom. The HUD reads out the lon/lat under the cursor.

## Running it

```bash
npm install
npm run dev
```

| script | what it does |
| --- | --- |
| `npm run dev` | dev server |
| `npm run build` | type-check and build |
| `npm run lint` | lint |
| `npm run coastlines [110m\|50m]` | regenerate the coastline data |
| `npm run elevation [width]` | regenerate the elevation grid (downloads 466 MB) |

## How it works

Everything is drawn into one canvas, in layers:

1. **The metal sea** is shaded per pixel — an environment reflection looked
   up by the reflected ray's height, plus a Fresnel rim, darkened with depth
   and modulated by the relief of the sea floor. It runs at a fraction of
   display resolution and is scaled up on blit; it is all smooth gradient, so
   nothing is lost.
2. **Land is filled** with a second shaded buffer, using the real coastline
   geometry as the fill rather than a bitmask, which keeps the edge aligned
   with the stroked outline and lets the canvas antialias it.
3. **Coastlines and the graticule** are stroked as vectors at full resolution.
4. **Overlays** — surface geometry, then orbits, then labels.

Geometry is baked onto the unit sphere once at load, so no per-frame
trigonometry touches the point data; a frame only builds a camera rotation and
multiplies through it.

### Coordinates

`src/globe/projection.ts` holds the projection, the horizon clipping, and
`unproject`, which maps a screen position back to lon/lat.

### Relief

`src/globe/elevation.ts` and the relief half of `src/globe/surface.ts`.

Earth is smoother than it looks: Everest is 0.14% of the radius, so at the
default 288px globe the whole range from the summit to the Challenger Deep is
under one pixel. Nothing would be visible without exaggeration — but relief
*shading* works on gradients rather than heights, so it needs a slope gain of
about 7 rather than the 20×–100× that displacing the geometry would.

The elevation is never displaced. It modulates the lighting instead: the
environment reflection describes the shape of the sphere, which is smooth, and
terrain is a local brightening and darkening on top of it. That is both truer
to what the eye reads as relief and far cheaper, because the whole terrain
contribution is one scalar per pixel and it falls out with no vector rotation
at all. For slopes `se`, `sn` in the local east/north frame the perturbed
normal is `w - (se*e + sn*n)`, so

```
n'.L = (w.L - se(e.L) - sn(n.L)) / sqrt(1 + se^2 + sn^2)
```

The key light is fixed in camera space, so `L` is carried into world space once
per frame rather than per pixel, and `e` and `n` come straight from the world
normal with no trigonometry. `w.L` is what the smooth sphere would have given,
so subtracting it leaves exactly the terrain's own contribution.

Land and sea are shaded in the same pass, sharing the unprojection, the grid
lookup and the slope. Sea gets the metal, darkened with depth; land gets a
height ramp — four stops in `LAND_STOPS`, cool and dark rather than an atlas
green-and-brown, since the relief should read from the shading. Change those
stops for a physical-atlas palette.

Relief costs about 1.5× a flat frame. If that matters, `SHADE.scale` in
`renderer.ts` trades relief resolution against it directly.

### Surface geometry

`src/globe/shapes.ts`. Everything is given in lon/lat degrees and densified
along great circles, so every vertex lands exactly on the surface — a line
interpolated linearly between two distant lon/lat points is a chord through the
sphere's interior and sinks below it.

```ts
import { geodesic, smallCircle, shape } from './globe/shapes'

const routes = shape([geodesic([[-0.13, 51.51], [-74.01, 40.71]])], {
  color: 'rgba(255, 214, 122, 0.95)',
  width: 1.75,
})

const rings = shape([smallCircle([36.82, -1.29], 15)], {
  color: 'rgba(120, 255, 214, 0.85)',
  dash: [4, 4],
})
```

Also available: `geodesicRing`, for closed polygons whose edges follow great
circles.

### Orbits and satellites

`src/globe/orbits.ts`. Circular orbits from familiar elements, with an animated
satellite and a fading trail.

```ts
import { orbit } from './globe/orbits'

const iss = orbit(
  { altitudeKm: 420, inclination: 51.6, ascendingNode: 10, periodSeconds: 5580 },
  { color: 'rgba(150, 220, 255, 0.5)' },
  { color: 'rgba(200, 240, 255, 1)', size: 3.2, trail: 40 },
)
```

Geometry above the surface cannot use the hemisphere test that surface geometry
uses: a high enough orbit is mostly behind the centre plane yet plainly
visible, because it passes wide of the globe. It is hidden only when *both*
behind the centre plane and inside the silhouette cylinder, and paths are cut
at that boundary by bisection.

`groundTrack` returns the sub-satellite path as a lon/lat ring, ready to pass
to `shape()`.

Orbits are defined in the globe's own frame, so they stay fixed relative to the
continents. Real satellites orbit in an inertial frame while the Earth turns
underneath, which makes ground tracks drift west each revolution; reproducing
that would need a spinning Earth, which this globe does not model.

### Labels

`src/globe/labels.ts`. Text pinned to the globe — to a place on the surface, to
a point standing above it, or to something moving.

```ts
import { label, labelAbove, labelOn, labelTracking, onSurface } from './globe/labels'

// Pinned to the surface.
const london = label('London', [-0.13, 51.51])

// Pinned above the surface, tethered to the ground point below it.
const relay = labelAbove('Polar relay', [12, 78], 1500, { leader: true })

// Riding a satellite, from a baked orbit or from bare elements.
const tag = labelOn('ISS-like', iss, { color: 'rgba(200, 240, 255, 1)' })

// Anything else that moves: the anchor is asked for a position each frame.
const flight = labelTracking(
  (t) => `BA117  FL${Math.round(altitude(t) / 100)}`,
  onSurface((t) => ({ ...positionAt(t), altitudeKm: 11 })),
)
```

A label is text plus an *anchor* — a function returning where it is attached,
in globe radii, at a given time. All four constructors differ only in that
function, so a label following a satellite costs no more per frame than one
nailed to a coastline. `text` may itself be a function of the clock, for a live
readout.

Labels are hidden by the same occlusion test the orbits use, not the hemisphere
test surface geometry uses, so one riding a high satellite stays readable while
it passes wide of the silhouette. Anything that *can* be swallowed by the globe
fades out over the last few degrees rather than blinking off.

Text is the one layer that cannot be allowed to overlap, so each label claims a
screen rectangle as it is drawn and later ones that would collide are dropped.
Array order is the priority — put what matters most first, or set
`declutter: false` on a label that must always appear.

Style options: `color`, `size`, `weight`, `family`, `font`, `placement`
(`right` | `left` | `above` | `below` | `centre`), `gap`, `offset`, `dot`,
`leader`, `halo`, `haloWidth`, `stem`, `fade`, `declutter`.

### Drawing a scene

```ts
renderGlobe(ctx, viewport, state, {
  shapes: [routes, rings],
  orbits: [iss],
  labels: [london, relay, tag],
  time: elapsedSeconds * 400,
})
```

`time` is whatever clock you choose to run, in the same units as each orbit's
period — scale it to set the animation speed.

`src/globe/demoShapes.ts`, `src/globe/demoOrbits.ts` and
`src/globe/demoLabels.ts` hold the demo content. Nothing else depends on them.

### State

One store, `src/store/appStore.ts` — about 40 lines on top of React's
`useSyncExternalStore`. The canvas never subscribes to it: the render loop
reads state imperatively, so 60fps updates cost no React renders.

## Data

**Coastlines** are Natural Earth 110m land polygons (public domain), converted
to a compact committed module by `scripts/build-coastlines.mjs`.
`npm run coastlines 50m` swaps in the higher-detail set.

**Elevation** is [NOAA's ETOPO 2022 global relief
model](https://www.ncei.noaa.gov/products/etopo-global-relief-model)
([doi:10.25921/fd45-gt74](https://doi.org/10.25921/fd45-gt74)), free for any
use except navigation. ETOPO is the useful source because it is seamless —
topography and bathymetry come from one grid, so there is no coastline seam to
reconcile between two datasets.

`npm run elevation [width]` builds it. The published 60 arc-second GeoTIFF is
466 MB of Deflate-compressed 32-bit float in 256×256 tiles; the script streams
it, undoes the floating-point predictor, box-averages down to 2048×1024 and
writes 16-bit metres. Averaging rather than sampling matters — keeping one
15 arc-second cell out of every block would hold whichever peak or trench it
landed on and drop the rest, which reads as speckle once it lights a surface.

That grid is committed as `src/globe/data/elevation.bin`: 2.6 MB, stored as
differences from the neighbouring sample and Deflate-compressed, which is
roughly what a PNG would do. It is read back through `DecompressionStream`
rather than as an image, because drawing a 16-bit PNG to a canvas is the one
thing guaranteed to throw the low byte away. It is fetched once on load and the
globe renders as smooth metal until it lands, so nothing waits for it.

Both datasets ship with the app. Nothing else is fetched at runtime — no tiles,
no APIs.

## Licence

BSD 2-Clause for the code, see [LICENSE](LICENSE). The coastline data is
Natural Earth, which is public domain.
