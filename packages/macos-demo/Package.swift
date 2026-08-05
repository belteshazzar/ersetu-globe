// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ErsetuGlobeApp",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(path: "../swift"),
    ],
    targets: [
        .executableTarget(
            name: "ErsetuGlobeApp",
            dependencies: [
                .product(name: "ErsetuGlobe", package: "swift"),
            ],
            path: "Sources/ErsetuGlobeApp",
            resources: [
                .copy("Resources/models"),
            ]
        ),
    ]
)
