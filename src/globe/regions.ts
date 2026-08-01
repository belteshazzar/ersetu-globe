/**
 * Areas on the globe, filled rather than outlined.
 *
 * A shape is a line and a region is a patch of ground, which is a different
 * thing to draw even though both start as rings of lon/lat. A line only has to
 * be cut where it crosses the silhouette; a fill has to be *closed* along the
 * limb, or half a continent leaks out of the hole where the ring left the
 * visible hemisphere. `fillPolygons` already does that, and holes, and forces a
 * winding so it knows which way round the limb to run - all of it built for the
 * land the bare sphere is painted with. This exposes it.
 *
 * A region is one or more rings: the first is the outline and any others are
 * holes, punched by the even-odd rule. The same rings serve as the outline to
 * stroke, since a `PolygonMesh`'s positions and ring offsets are exactly what a
 * `Mesh` is - so a region carries both views of one buffer rather than baking
 * its geometry twice.
 */
import { buildPolygonMesh, type Mesh, type PolygonMesh } from './projection'

export type RegionStyle = {
  /** Fill paint. Semi-transparent is the normal case: the ground is worth seeing. */
  fill?: string
  /** Outline paint. Omitted leaves the fill unbordered. */
  stroke?: string
  /** Outline width in CSS pixels. */
  width?: number
}

/** An area baked onto the sphere, ready to draw. */
export type Region = {
  /** Rings grouped into polygons, for the fill. */
  polygons: PolygonMesh
  /** The same rings as plain outlines, for the stroke. */
  outline: Mesh
  style: RegionStyle
}

/**
 * Bake one or more polygons into a drawable region.
 *
 * Each polygon is a list of flat [lon, lat, ...] rings, outline first and holes
 * after - the shape of `COASTLINE_POLYGONS`, and what `geodesicRing` in
 * `shapes.ts` produces if you want edges that follow great circles rather than
 * lines of constant bearing.
 */
export function region(
  polygons: readonly (readonly (readonly number[])[])[],
  style: RegionStyle,
): Region {
  return regionOf(buildPolygonMesh(polygons), style)
}

/**
 * Wrap geometry that has already been built - a morph's buffer, most likely.
 *
 * The mesh is referenced rather than copied, so a region built around a morph
 * once keeps drawing whatever that morph last wrote. Nothing here has to be
 * rebuilt to animate it.
 */
export function regionOf(polygons: PolygonMesh, style: RegionStyle): Region {
  return {
    polygons,
    // Two views of one buffer, so the outline costs no geometry of its own.
    outline: { positions: polygons.positions, offsets: polygons.ringOffsets },
    style,
  }
}
