// swift-tools-version:5.7
// Roughcut's small native helpers, built in CI and copied into the app.
import PackageDescription

let package = Package(
    name: "RoughcutHelpers",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "roughcut-matte", path: "Sources/roughcut-matte"),
    ]
)
