/**
 * Example overlay geometry. Nothing else depends on this file - swap the
 * contents for your own shapes, or drop it and pass your own array to
 * renderGlobe.
 */
import { geodesic, geodesicRing, shape, smallCircle, type LonLat } from './shapes'

const LONDON: LonLat = [-0.13, 51.51]
const NEW_YORK: LonLat = [-74.01, 40.71]
const TOKYO: LonLat = [139.69, 35.69]
const SYDNEY: LonLat = [151.21, -33.87]
const CAPE_TOWN: LonLat = [18.42, -33.93]
const SANTIAGO: LonLat = [-70.67, -33.46]
const NAIROBI: LonLat = [36.82, -1.29]
const SINGAPORE: LonLat = [103.82, 1.35]

const ROUTE = 'rgba(255, 214, 122, 0.95)'
const RANGE = 'rgba(120, 255, 214, 0.85)'
const AREA = 'rgba(255, 138, 190, 0.9)'

export const DEMO_SHAPES = [
  // Great-circle routes. Each is the shortest path over the surface, which is
  // why they bow away from the straight line you would expect on a flat map.
  shape(
    [
      geodesic([LONDON, NEW_YORK]),
      geodesic([TOKYO, SYDNEY]),
      geodesic([CAPE_TOWN, SANTIAGO]),
      // A multi-leg path: London to Singapore to Sydney.
      geodesic([LONDON, SINGAPORE, SYDNEY]),
    ],
    { color: ROUTE, width: 1.75 },
  ),

  // Range rings at a fixed angular distance from Nairobi.
  shape(
    [smallCircle(NAIROBI, 15), smallCircle(NAIROBI, 30), smallCircle(NAIROBI, 45)],
    { color: RANGE, width: 1.1, dash: [4, 4] },
  ),

  // A closed region whose edges follow great circles.
  shape(
    [
      geodesicRing([
        [-20, 20],
        [40, 20],
        [40, -10],
        [-20, -10],
      ]),
    ],
    { color: AREA, width: 1.5 },
  ),
] as const
