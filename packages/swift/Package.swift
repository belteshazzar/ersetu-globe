// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ErsetuGlobe",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "ErsetuGlobe", targets: ["ErsetuGlobe"]),
    ],
    targets: [
        .target(
            name: "ErsetuGlobe",
            path: "Sources/ErsetuGlobe",
            resources: [
                .process("Shaders.metal"),
                .copy("Resources/terrain-0.bin"),
                .copy("Resources/terrain-1.bin"),
                .copy("Resources/terrain-2.bin"),
                .copy("Resources/coastlines.json"),
            ]
        ),
    ]
)
