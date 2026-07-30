# ersetu-globe

A lightweight 3D globe with no runtime dependencies beyond React, rendered
entirely with the 2D canvas API. No WebGL, no mapping library, no tile server.

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

## How it works

Everything is drawn into one canvas, in layers:

1. **The metal surface** is shaded per pixel — an environment reflection looked
   up by the reflected ray's height, plus a Fresnel rim. It runs at a fraction
   of display resolution and is scaled up on blit; it is all smooth gradient,
   so nothing is lost.
2. **Land is cut back out** of that shading using the real coastline geometry
   rather than a bitmask, which keeps the edge aligned with the stroked outline
   and lets the canvas antialias it.
3. **Coastlines and the graticule** are stroked as vectors at full resolution.
4. **Overlays** — surface geometry, then orbits.

Geometry is baked onto the unit sphere once at load, so no per-frame
trigonometry touches the point data; a frame only builds a camera rotation and
multiplies through it.

### Coordinates

`src/globe/projection.ts` holds the projection, the horizon clipping, and
`unproject`, which maps a screen position back to lon/lat.

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

### Drawing a scene

```ts
renderGlobe(ctx, viewport, state, {
  shapes: [routes, rings],
  orbits: [iss],
  time: elapsedSeconds * 400,
})
```

`time` is whatever clock you choose to run, in the same units as each orbit's
period — scale it to set the animation speed.

`src/globe/demoShapes.ts` and `src/globe/demoOrbits.ts` hold the demo content.
Nothing else depends on them.

### State

One store, `src/store/appStore.ts` — about 40 lines on top of React's
`useSyncExternalStore`. The canvas never subscribes to it: the render loop
reads state imperatively, so 60fps updates cost no React renders.

## Data

Coastlines are Natural Earth 110m land polygons (public domain), converted to a
compact committed module by `scripts/build-coastlines.mjs`. The app fetches
nothing at runtime. `npm run coastlines 50m` swaps in the higher-detail set.

## Licence

BSD 2-Clause for the code, see [LICENSE](LICENSE). The coastline data is
Natural Earth, which is public domain.
