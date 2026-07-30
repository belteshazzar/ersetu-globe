# ersetu-globe

A lightweight 3D globe with no runtime dependencies beyond React, rendered
entirely with the 2D canvas API — including exaggerated topography and
bathymetry as real displaced geometry, with its own software z-buffer.
No WebGL, no mapping library, no tile server.

**[Live demo](https://belteshazzar.github.io/ersetu-globe/)**

Drag to rotate, scroll to zoom. The HUD reads out the lon/lat under the cursor,
and the **relief** slider sets how far the terrain is exaggerated — drop it to
zero and the globe becomes a true sphere.

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

1. **The displaced globe is rasterised** by a small software z-buffer into a
   G-buffer of grid coordinates and depth — real geometry, so real silhouette,
   parallax and occlusion.
2. **The sea is shaded** from that per pixel — an environment reflection looked
   up by the reflected ray's height, plus a Fresnel rim, darkened with depth
   and lit by the sea floor's own slope. It runs at a fraction of display
   resolution and is scaled up on blit; it is all smooth gradient, so nothing
   is lost.
3. **Land is filled** with a second shaded buffer, using the real coastline
   geometry as the fill rather than a bitmask, which keeps the edge aligned
   with the stroked outline and lets the canvas antialias it.
4. **Coastlines and the graticule** are stroked as vectors at full resolution.
5. **Overlays** — surface geometry, then orbits, then labels.

Geometry is baked onto the unit sphere once at load, so no per-frame
trigonometry touches the point data; a frame only builds a camera rotation and
multiplies through it.

### Coordinates

`src/globe/projection.ts` holds the projection, the horizon clipping, and
`unproject`, which maps a screen position back to lon/lat.

### Relief

`src/globe/terrain.ts`, `src/globe/elevation.ts`, and the terrain half of
`src/globe/surface.ts`.

The globe is not a sphere. Every vertex of a lon/lat mesh is pushed out to
`1 + k·h`, so mountains genuinely stand off the surface, basins genuinely sink
into it, and the silhouette is not a circle — measured, the outline runs from
0.972 to 1.026 of the nominal radius, about ±7 px at the default size.

Earth is smoother than it looks, which is why that needs exaggerating at all:
Everest is 0.14% of the radius, so unexaggerated the whole range from the
summit to the Challenger Deep would be under one pixel. The **relief** slider
in the HUD sets the factor, from 0 — a true sphere, useful for comparison — to
80; it starts at 30.

Exaggeration is free to change because it is not baked into the mesh. Vertices
hold a unit direction and a height, and the per-frame transform puts them at
`1 + exaggeration * lift`, so moving the slider costs three multiplies on work
the transform was doing anyway rather than rebuilding fifty thousand vertices.

The 2D canvas has no notion of depth, so a mountain can only hide what is
behind it if we sort that out ourselves: `terrain.ts` is a small software
rasteriser with a z-buffer. Two things make it much cheaper than it sounds.

An orthographic projection is affine — no perspective divide — so attributes
interpolate exactly with plain screen-space barycentrics and no correction is
needed anywhere. And a radial height field has no overhangs, so the surface is
closed and star-shaped about its centre, which means any back-facing triangle
is hidden by front-facing geometry and winding order alone discards half the
mesh before rasterising.

The rasteriser does not shade. It writes only where on the elevation grid each
covered sample landed, plus its depth — a G-buffer — and the shading pass then
reads the *full resolution* grid per pixel. So geometry is limited by the mesh
at about a degree, but the shading is not: the relief keeps all the detail it
would have had as a pure lighting trick, while the silhouette, the parallax and
the occlusion become real.

Terrain still perturbs the lighting on top of the displaced surface, which is a
separate and much smaller gain — shading works on gradients, so
`SHADE_EXAGGERATION` is 7 where the geometry needs 30. For slopes `se`, `sn` in
the local east/north frame the perturbed normal is `w - (se*e + sn*n)`, so

```
n'.L = (w.L - se(e.L) - sn(n.L)) / sqrt(1 + se^2 + sn^2)
```

The key light is fixed in camera space, so `L` is carried into world space once
per frame rather than per pixel, and `e` and `n` come straight from the world
normal with no trigonometry. `w.L` is what the unperturbed surface would have
given, so subtracting it leaves exactly the terrain's own contribution.

Land and sea are shaded in the same pass. Sea gets the metal, darkened with
depth; land gets a height ramp — four stops in `LAND_STOPS`, cool and dark
rather than an atlas green-and-brown, since the relief should read from the
shading. Change those stops for a physical-atlas palette.

The whole displaced globe costs about twice a smooth-sphere frame, and rather
less than the same relief did as a lighting trick: reading grid coordinates the
rasteriser already interpolated is cheaper than recovering them per pixel, and
only covered samples are shaded. `LON_STEPS`/`LAT_STEPS` trade geometric detail
against cost; `SHADE.scale` in `renderer.ts` trades shading resolution.

The vector overlays still ride the sphere rather than being depth-tested
against the terrain. Coastlines sit at sea level so they stay correct by
construction; the visible cost is that a route or label behind a tall peak is
not hidden by it.

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
