// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "wm-sidecar",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(
            name: "wm-sidecar",
            path: "Sources/wm-sidecar"
        ),
        .testTarget(
            name: "wm-sidecarTests",
            dependencies: [.target(name: "wm-sidecar")]
        )
    ]
)
