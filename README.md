# ersetu-globe

A lightweight 3D globe with no runtime dependencies beyond React, rendered
entirely with the 2D canvas API — including exaggerated topography and
bathymetry as real displaced geometry, with its own software z-buffer.
No WebGL, no mapping library, no tile server.

**[Live demo](https://belteshazzar.github.io/ersetu-globe/)**

Drag to rotate, scroll to zoom. The HUD reads out the lon/lat under the cursor;
the **relief** slider sets how far the terrain is exaggerated — drop it to zero
and the globe becomes a true sphere — and **surface** switches between a flat
pair of colours and a metallic sea with land ramped by height.

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
| `npm run terrain [--levels N] [--source FILE]` | regenerate the terrain tiles (downloads 466 MB) |
| `npm run models` | regenerate the sample 3D models |

## How it works

Everything is drawn into one canvas, in layers:

1. **The displaced globe is rasterised** by a small software z-buffer into a
   G-buffer of grid coordinates and depth — real geometry, so real silhouette,
   parallax and occlusion.
2. **Land and sea are shaded** from that per pixel, in one pass — the sea an
   environment reflection looked up by the reflected ray's height plus a
   Fresnel rim, darkened with depth; land a height ramp. Which of the two a
   sample gets comes from the same elevation that gave it its shape. It runs at
   a fraction of display resolution and is scaled up on blit.
3. **Coastlines and the graticule** are stroked as vectors at full resolution.
4. **Overlays** — surface geometry, then orbits, then labels.

Geometry is baked onto the unit sphere once at load, so no per-frame
trigonometry touches the point data; a frame only builds a camera rotation and
multiplies through it.

### Coordinates

`src/globe/projection.ts` holds the projection, the horizon clipping, and
`unproject`, which maps a screen position back to lon/lat.

### Relief

`src/globe/quadtree.ts`, `src/globe/tiles.ts`, `src/globe/terrain.ts`, and the
terrain half of `src/globe/surface.ts`.

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

Land and sea are shaded in the same pass, in one of two palettes.

**flat** is one solid colour for each, `FLAT_LAND` and `FLAT_SEA`. They are
still lit, because they have to be: with the geometry doing the work, an unlit
solid colour would collapse the globe into a flat pair of silhouettes and throw
away the very relief the displacement exists to show. Shading is the only thing
carrying shape, and it uses the terrain-perturbed normal, so detail far below
the mesh still reads.

**metal** gives the sea an environment reflection darkened with depth, and
ramps the land by height — four stops in `LAND_STOPS`, cool and dark rather
than an atlas green-and-brown. Change those stops for a physical-atlas palette.

Which of the two a sample gets comes from the elevation, not from the coastline
polygons. Filling those instead is tempting — they are the crisper outline, and
it is what the smooth globe does — but they are projected onto the undisplaced
sphere, and the terrain is not on it. Radial displacement barely moves anything
at the centre of the disc, where it points at the viewer, but at the limb it is
entirely sideways: exactly there the ground stands outside its own polygon, and
past the radius-1 limb the fill is clipped away altogether. The result was a rim
of sea colour around every continent, worst where the relief was most visible.
Reading land and sea from the grid that displaced the ground cannot drift from
it. The crossing is softened over about a cell either side, scaled by how fast
the height is changing, so a steep coast gets a hard edge and a shallow one a
wider blend. The vector coastline is still stroked over the top.

The whole displaced globe costs around a third again over a smooth-sphere
frame, and less than the same relief did as a lighting trick: reading grid
coordinates the rasteriser already interpolated is cheaper than recovering them
per pixel, only covered samples are shaded, and colouring land from the grid
retired a full-disc vector fill every frame. `LON_STEPS`/`LAT_STEPS` trade
geometric detail against cost; `SHADE.scale` in `renderer.ts` trades shading
resolution.

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

### 3D models

`src/globe/models.ts`. Small models standing on the ground or flying above it,
fetched at runtime rather than bundled — the globe draws long before any of
them arrive and simply gains them when they do.

```ts
import { loadModel, placeOnSurface, placeInOrbit } from './globe/models'

const station = await loadModel(stationUrl)

const scene = [
  placeInOrbit(station, iss, { size: 0.07, spin: 8 }),
  placeOnSurface(tower, [-74.01, 40.71], { size: 0.05, heading: 30 }),
]
```

Also `placeTracking`, for anything else that moves. A surface model rides the
*displaced* terrain, so it rises and falls with the relief slider instead of
sinking into a mountain.

Models are drawn as ordinary canvas paths at full resolution rather than
through the terrain's sample buffer — at the size one of these occupies, those
samples are far too coarse to carry a shape. That means no depth buffer, so
depth is handled twice over: within a model, faces are sorted back to front,
which is sound for these box-and-cylinder assemblies; against the globe, the
anchor is tested for occlusion as a whole, by the same rule the orbits use.
Faces are lit from both sides with the normal turned towards the camera, so the
renderer does not care which way a model's triangles wind.

Nothing is to scale. A real car is a ten-millionth of the Earth's radius and
would never reach a pixel, so `size` is in globe radii and chosen to be seen —
exactly as the terrain is exaggerated to be seen. One consequence of an
orthographic projection is worth knowing: whatever sits in the middle of the
disc is seen from directly overhead, so a tower there shows you its roof. Move
it towards the limb and it stands up.

The samples — a satellite, a space station, a tower and a car — are built from
boxes and cylinders by `scripts/build-models.mjs` into a small JSON format:
`positions`, `faces` as triangle indices, and one rgb triple per face.

### Drawing a scene

```ts
renderGlobe(ctx, viewport, state, {
  shapes: [routes, rings],
  orbits: [iss],
  labels: [london, relay, tag],
  models: [station, tower],
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

`npm run terrain` builds it. The published 60 arc-second GeoTIFF is 466 MB of
Deflate-compressed 32-bit float in 256×256 tiles; the script streams it, undoes
the floating-point predictor and box-averages down. Averaging rather than
sampling matters — keeping one 15 arc-second cell out of every block would hold
whichever peak or trench it landed on and drop the rest, which reads as speckle
once it lights a surface.

The result is a pyramid, not one grid, cut into 128-sample tiles and packed into
`public/terrain.bin`. It is rooted to match the geometry: level 0 is four tiles
around by two down, which is exactly the eight lon/lat boxes of the octahedron
the quadtree starts from, and each level doubles.

| level | grid | deg/sample | ground | size |
| --- | --- | --- | --- | --- |
| 0 | 512×256 | 0.703 | 78 km | 191 kB |
| 1 | 1024×512 | 0.352 | 39 km | 729 kB |
| 2 | 2048×1024 | 0.176 | 20 km | 2.68 MB |
| 3 | 4096×2048 | 0.088 | 10 km | 10.0 MB |
| 4 | 8192×4096 | 0.044 | 4.9 km | 36.5 MB |

Levels 0–2 ship, at 3.6 MB. `npm run terrain -- --levels 4` builds the rest,
which is worth hosting rather than committing.

Tiles carry a one-sample border, so bilinear sampling and the slope taps at the
very edge of a tile need nothing but that tile. Each is compressed on its own —
which gives up some ratio, but is what makes a tile independently fetchable and
decodable without its neighbours or its parent.

The client reads the index once and then asks for byte ranges, which every
static host already does, with no server logic anywhere. If a host does not
honour Range it says so by sending the whole file, and the client notices and
serves every tile from memory instead. That is the difference between 234 kB and
3.6 MB before the globe has any shape: level 0 draws the whole world, and
everything after it is detail fetched for the part being looked at. A session
that zooms into two continents transfers about 9% of the archive.

Sampling always succeeds. Asking for a level that has not arrived walks up the
pyramid to the finest ancestor that has, so the picture is never missing, only
coarser than it will shortly be.

## Licence

BSD 2-Clause for the code, see [LICENSE](LICENSE). The coastline data is
Natural Earth, which is public domain.
