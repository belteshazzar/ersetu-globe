//
//  The demo scene: routes, range rings, orbits, labels, tweened regions and a
//  synthetic weather overlay. Ports of src/globe/demoShapes.ts, demoOrbits.ts,
//  demoLabels.ts, demoRegions.ts, demoOverlay.ts and demoModels.ts. Nothing
//  else depends on this file - swap the contents for your own scene.
//

import ErsetuGlobe
import Foundation

// MARK: - Shapes (demoShapes.ts)

private let LONDON: LonLat = (-0.13, 51.51)
private let NEW_YORK: LonLat = (-74.01, 40.71)
private let TOKYO: LonLat = (139.69, 35.69)
private let SYDNEY: LonLat = (151.21, -33.87)
private let CAPE_TOWN: LonLat = (18.42, -33.93)
private let SANTIAGO: LonLat = (-70.67, -33.46)
private let NAIROBI: LonLat = (36.82, -1.29)
private let SINGAPORE: LonLat = (103.82, 1.35)

let DEMO_SHAPES: [Shape] = [
    // Great-circle routes: the shortest paths over the surface, which is why
    // they bow away from the straight line you would expect on a flat map.
    shape(
        [
            geodesic([LONDON, NEW_YORK]),
            geodesic([TOKYO, SYDNEY]),
            geodesic([CAPE_TOWN, SANTIAGO]),
            // A multi-leg path: London to Singapore to Sydney.
            geodesic([LONDON, SINGAPORE, SYDNEY]),
        ],
        ShapeStyle(color: RGBA(255, 214, 122, 0.95), width: 1.75)),

    // Range rings at a fixed angular distance from Nairobi.
    shape(
        [smallCircle(NAIROBI, 15), smallCircle(NAIROBI, 30), smallCircle(NAIROBI, 45)],
        ShapeStyle(color: RGBA(120, 255, 214, 0.85), width: 1.1, dash: [4, 4])),

    // A closed region whose edges follow great circles.
    shape(
        [geodesicRing([(-20, 20), (40, 20), (40, -10), (-20, -10)])],
        ShapeStyle(color: RGBA(255, 138, 190, 0.9), width: 1.5)),
]

// MARK: - Orbits (demoOrbits.ts)

/// Simulated seconds per real second: orbital periods are in the thousands of
/// seconds, so real time would be far too slow to watch.
let DEMO_TIME_SCALE = 400.0

let DEMO_ORBITS: [Orbit] = [
    // Low Earth orbit, at the inclination the ISS flies.
    orbit(
        OrbitElements(altitudeKm: 420, inclination: 51.6, ascendingNode: 10, periodSeconds: 5580),
        OrbitStyle(color: RGBA(150, 220, 255, 0.5), width: 1),
        SatelliteStyle(color: RGBA(200, 240, 255, 1), size: 3.2, trail: 40)),

    // A near-polar orbit, of the kind Earth-observation satellites use.
    orbit(
        OrbitElements(
            altitudeKm: 700, inclination: 98.2, ascendingNode: 120, periodSeconds: 5900,
            phase: 120),
        OrbitStyle(color: RGBA(120, 255, 214, 0.45), width: 1),
        SatelliteStyle(color: RGBA(170, 255, 228, 1), size: 2.8, trail: 36)),

    // Medium orbit, around where navigation constellations sit.
    orbit(
        OrbitElements(
            altitudeKm: 20200, inclination: 55, ascendingNode: 250, periodSeconds: 43080,
            phase: 200),
        OrbitStyle(color: RGBA(255, 214, 122, 0.4), width: 1, dash: [6, 6]),
        SatelliteStyle(color: RGBA(255, 226, 160, 1), size: 3, trail: 24)),
]

// MARK: - Labels (demoLabels.ts)

private let CITIES: [(String, LonLat)] = [
    ("London", LONDON),
    ("New York", NEW_YORK),
    ("Tokyo", TOKYO),
    ("Sydney", SYDNEY),
    ("Cape Town", CAPE_TOWN),
    ("Santiago", SANTIAGO),
    ("Nairobi", NAIROBI),
    ("Singapore", SINGAPORE),
]

private var cityStyle: LabelStyle {
    var style = LabelStyle()
    style.color = RGBA(226, 238, 255, 0.92)
    style.size = 12
    style.gap = 7
    style.dot = 2.4
    return style
}

private var platformStyle: LabelStyle {
    var style = LabelStyle()
    style.color = RGBA(255, 138, 190, 0.95)
    style.size = 11
    style.weight = .semibold
    style.leader = true
    style.gap = 8
    return style
}

/// Satellite labels take their colour from the marker they ride.
private func satelliteStyle(_ color: RGBA) -> LabelStyle {
    var style = LabelStyle()
    style.color = color
    style.size = 11
    style.weight = .semibold
    style.gap = 9
    style.placement = .right
    return style
}

/// Latitude of the satellite below its orbit, as a compass reading - a label
/// whose text is a function of the clock rather than a fixed string.
private func subLatitude(_ orbit: Orbit, _ timeSeconds: Double) -> String {
    let p = positionAtAngle(orbit.elements, angleAt(orbit.elements, timeSeconds))
    let length = (p.x * p.x + p.y * p.y + p.z * p.z).squareRoot()
    let degrees = asin(p.y / length) * 180 / .pi
    return String(format: "%.0f°%@", abs(degrees), degrees >= 0 ? "N" : "S")
}

let DEMO_LABELS: [GlobeLabel] =
    [
        // Satellites first: they move, so they should not be the ones dropped
        // when they pass over a city name.
        labelOn("ISS-like", DEMO_ORBITS[0], satelliteStyle(RGBA(200, 240, 255, 1))),
        labelOn("Sun-sync", DEMO_ORBITS[1], satelliteStyle(RGBA(170, 255, 228, 1))),
        labelOn(
            { time in "Nav-1  \(subLatitude(DEMO_ORBITS[2], time))" },
            DEMO_ORBITS[2], satelliteStyle(RGBA(255, 226, 160, 1))),

        // Fixed above the surface, tethered to the ground point below it.
        labelAbove("Polar relay  1500 km", (12, 78), 1500, platformStyle),
    ] + CITIES.map { label($0.0, $0.1, cityStyle) }

// MARK: - Regions (demoRegions.ts)

// Deliberately abstract shapes over open ocean rather than real borders: a
// plausible-looking boundary drawn across real land reads as a claim about it.
// Between the two states the shared edge moves, an enclave closes up, and a
// new exclave separates off - the three things a border animation must survive.

/// A lon/lat box as a closed ring, which is all these shapes need.
private func box(_ west: Double, _ east: Double, _ south: Double, _ north: Double) -> [Double] {
    [west, north, east, north, east, south, west, south, west, north]
}

private let NORTH_BEFORE = [[box(-36, -12, -19, -4), box(-30, -19, -15, -8)]]
private let SOUTH_BEFORE = [[box(-36, -12, -31, -19)]]
private let NORTH_AFTER = [[box(-36, -12, -26, -4)], [box(-9, -3, -14, -8)]]
private let SOUTH_AFTER = [[box(-36, -12, -31, -26)]]

private let NORTH = Morph(from: NORTH_BEFORE, to: NORTH_AFTER)
private let SOUTH = Morph(from: SOUTH_BEFORE, to: SOUTH_AFTER)

/// Six seconds across and twelve to a cycle, so the second half is the closing
/// segment travelling back - the border returns the way it came. Eased,
/// because a shape that eases reads as a deliberate transition.
private let PHASE = Track<Double>(
    [Keyframe(at: 0, value: 0), Keyframe(at: 6, value: 1)],
    loop: true, duration: 12, ease: smoothstep)

// Built once around the morphs' own buffers: animating rewrites those buffers
// in place, so nothing here is rebuilt and a frame allocates nothing.
private let demoRegions: [Region] = [
    regionOf(
        NORTH.mesh,
        RegionStyle(
            fill: RGBA(240, 180, 90, 0.28), stroke: RGBA(250, 205, 140, 0.85), width: 1.5)),
    regionOf(
        SOUTH.mesh,
        RegionStyle(
            fill: RGBA(90, 210, 200, 0.24), stroke: RGBA(150, 235, 225, 0.8), width: 1.5)),
]

/// The regions as they stand at a moment, in seconds.
func demoRegionsAt(_ seconds: Double) -> [Region] {
    if let span = PHASE.sample(seconds) {
        let t = span.a + (span.b - span.a) * span.mix
        NORTH.at(t)
        SOUTH.at(t)
    }
    return demoRegions
}

// MARK: - Weather overlay (demoOverlay.ts)

// Synthetic on purpose: a field generated from a formula is obviously a
// demonstration of the machinery rather than a claim about the weather.
// Regional on purpose too - outside the box the field says nothing and the
// ground shows through untouched.

/// Western Europe and the near Atlantic, a plausible model domain.
private let DOMAIN = Bounds(west: -22, east: 34, south: 30, north: 64)

/// Degrees the byte scale spans, cold end first.
private let RANGE = (-15.0, 35.0)

/// A temperature ramp, deliberately a little transparent at the middle so
/// ordinary conditions leave the ground showing.
private let TEMPERATURE = palette([
    PaletteStop(at: 0.0, color: (40, 60, 160), alpha: 0.9),
    PaletteStop(at: 0.25, color: (70, 160, 220), alpha: 0.7),
    PaletteStop(at: 0.45, color: (120, 210, 190), alpha: 0.4),
    PaletteStop(at: 0.55, color: (220, 220, 140), alpha: 0.4),
    PaletteStop(at: 0.75, color: (235, 150, 70), alpha: 0.7),
    PaletteStop(at: 1.0, color: (200, 50, 45), alpha: 0.9),
])

private let FIELD_WIDTH = 256
private let FIELD_HEIGHT = 128
private let FRAMES = 8
private let SECONDS_PER_FRAME = 2.0

/// One frame of the forecast, at a phase through the cycle. Every term is
/// periodic in `phase`, so the eighth frame leads back into the first.
private func forecastFrame(_ phase: Double) -> Field {
    let front = phase * 2 * .pi

    return makeField(
        width: FIELD_WIDTH, height: FIELD_HEIGHT, range: RANGE, bounds: DOMAIN
    ) { longitude, latitude in
        // Warmer towards the south, which over this domain is most of the story.
        let solar = 26 - 34 * (latitude - 0.52)

        // A front lying north-east to south-west with cold air behind it,
        // sweeping eastward across the domain and round again.
        let across = latitude * 1.6 - longitude * 0.5 - 0.55 + sin(front) * 0.7
        let sweep = -9 * tanh(across * 4)

        // Weather riding along with it, so the pattern is not simply
        // translated.
        let eddies =
            3 * sin(longitude * 6 + latitude * 3 - front)
            + 2 * sin(latitude * 7 - longitude * 2 + front * 2)

        // The sea holds its temperature and the interior does not: a stand-in
        // for maritime influence, not a calculation of it.
        let coastal = exp(-pow((longitude + 0.15) * 2.2, 2))
        let maritime = 4 * coastal
        let inland = 5 * sin(front) * (1 - coastal)

        return solar + sweep + eddies + maritime + inland
    }
}

/// Not eased: easing a measurement means reporting a temperature that was
/// never forecast.
private let FORECAST = Track<Field>(
    (0..<FRAMES).map { i in
        Keyframe(at: Double(i) * SECONDS_PER_FRAME, value: forecastFrame(Double(i) / Double(FRAMES)))
    },
    loop: true, duration: Double(FRAMES) * SECONDS_PER_FRAME)

/// The overlay as it stands at a moment, in seconds.
func demoOverlayAt(_ seconds: Double) -> Overlay? {
    guard let span = FORECAST.sample(seconds) else { return nil }
    return Overlay(
        field: span.a, next: span.b, mix: span.mix, palette: TEMPERATURE, opacity: 0.75)
}

// MARK: - Models (demoModels.ts)

private let SALAR_DE_UYUNI: LonLat = (-67.5, -20.4)

/// A spin written in degrees per second you can actually count: `spin` runs
/// against the scene clock, which is `DEMO_TIME_SCALE` times faster than real
/// time.
private func perSecond(_ degrees: Double) -> Double { degrees / DEMO_TIME_SCALE }

/// Load the models and place them. Returns an empty list rather than throwing
/// if any of them fails: a missing model is worth a warning, not a globe that
/// will not draw.
func loadDemoModels() -> [ModelPlacement] {
    func bundled(_ name: String) -> Model? {
        guard
            let url = Bundle.module.url(
                forResource: name, withExtension: "json", subdirectory: "models")
        else { return nil }
        return try? loadModel(url)
    }

    guard let station = bundled("station"),
        let satellite = bundled("satellite"),
        let building = bundled("building"),
        let car = bundled("car")
    else {
        print("Models unavailable; drawing the globe without them.")
        return []
    }

    return [
        // Riding the low orbit, turning slowly to keep its wings to the sun.
        placeInOrbit(station, DEMO_ORBITS[0], size: 0.07, spin: perSecond(9)),
        placeInOrbit(satellite, DEMO_ORBITS[1], size: 0.05, spin: perSecond(-14)),

        // Standing on the ground, which means standing on the displaced
        // terrain: both rise and fall with the relief setting.
        placeOnSurface(building, NEW_YORK, size: 0.05),
        placeOnSurface(car, SALAR_DE_UYUNI, size: 0.035, heading: 60, spin: perSecond(18)),
    ]
}
