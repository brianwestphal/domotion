// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "DomotionGlyphPaths",
    platforms: [.macOS(.v11)],
    targets: [
        .executableTarget(
            name: "DomotionGlyphPaths",
            path: "Sources/DomotionGlyphPaths"
        )
    ]
)
