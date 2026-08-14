// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "wm",
    platforms: [.macOS(.v26)],
    products: [
        .executable(name: "wm", targets: ["wm"]),
        .library(name: "WMProtocol", targets: ["WMProtocol"]),
        .library(name: "WMInventory", targets: ["WMInventory"]),
        .library(name: "WMCore", targets: ["WMCore"]),
        .library(name: "WMWebSocket", targets: ["WMWebSocket"]),
        .library(name: "WMCLI", targets: ["WMCLI"]),
        .executable(name: "wm-geometry-fake-verify", targets: ["WMGeometryFakeVerify"]),
    ],
    targets: [
        .target(name: "WMProtocol"),
        .target(
            name: "WMInventory",
            dependencies: ["WMProtocol"]
        ),
        .target(
            name: "WMCore",
            dependencies: ["WMProtocol", "WMInventory"]
        ),
        .target(
            name: "WMWebSocket",
            dependencies: ["WMProtocol", "WMCore"]
        ),
        .target(
            name: "WMCLI",
            dependencies: ["WMProtocol", "WMWebSocket"]
        ),
        .executableTarget(
            name: "wm",
            dependencies: ["WMCLI", "WMCore", "WMInventory", "WMProtocol", "WMWebSocket"]
        ),
        .executableTarget(
            name: "WMGeometryFakeVerify",
            dependencies: ["WMCore", "WMInventory", "WMProtocol"]
        ),
        .testTarget(name: "WMProtocolTests", dependencies: ["WMProtocol"]),
        .testTarget(name: "WMInventoryTests", dependencies: ["WMInventory", "WMProtocol"]),
        .testTarget(name: "WMCoreTests", dependencies: ["WMCore", "WMInventory", "WMProtocol"]),
        .testTarget(name: "WMWebSocketTests", dependencies: ["WMWebSocket", "WMCore", "WMProtocol"]),
        .testTarget(name: "WMCLITests", dependencies: ["WMCLI", "WMProtocol"]),
    ]
)
