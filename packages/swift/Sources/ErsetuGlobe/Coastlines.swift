//
//  The Natural Earth 110m coastline data, converted from the generated module
//  in src/globe/data/coastlines.ts to a bundled JSON resource: one entry per
//  polygon, each a list of closed rings flattened as [lon, lat, ...] degrees,
//  the first the outline and any others holes.
//

import Foundation

/// One entry per polygon, rings flattened as [lon, lat, ...] in degrees.
let COASTLINE_POLYGONS: [[[Double]]] = {
    guard let url = Bundle.module.url(forResource: "coastlines", withExtension: "json"),
        let data = try? Data(contentsOf: url),
        let parsed = try? JSONSerialization.jsonObject(with: data) as? [[[NSNumber]]]
    else {
        print("Coastlines unavailable; drawing the globe without them.")
        return []
    }
    return parsed.map { polygon in polygon.map { ring in ring.map { $0.doubleValue } } }
}()

/// Every ring, ungrouped - what the outline stroking pass wants.
let COASTLINE_RINGS: [[Double]] = COASTLINE_POLYGONS.flatMap { $0 }
