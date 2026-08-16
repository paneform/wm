// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "wm",
    platforms: [.macOS(.v26)],
    products: [
        .executable(name: "wm", targets: ["wm"]),
        .library(name: "WMProtocol", targets: ["WMProtocol"]),
        .library(name: "WMInventory", targets: ["WMInventory"]),
        .library(name: "WMWorkspace", targets: ["WMWorkspace"]),
        .library(name: "WMPersistence", targets: ["WMPersistence"]),
        .library(name: "WMCore", targets: ["WMCore"]),
        .library(name: "WMConfiguration", targets: ["WMConfiguration"]),
        .library(name: "WMWebSocket", targets: ["WMWebSocket"]),
        .library(name: "WMCLI", targets: ["WMCLI"]),
        .executable(name: "wm-geometry-fake-verify", targets: ["WMGeometryFakeVerify"]),
        .executable(name: "wm-workspace-layout-verify", targets: ["WMWorkspaceLayoutVerify"]),
    ],
    targets: [
        .target(name: "WMProtocol"),
        .target(
            name: "WMInventory",
            dependencies: ["WMProtocol"]
        ),
        .target(
            name: "WMWorkspace",
            dependencies: ["WMProtocol"]
        ),
        .target(
            name: "WMPersistence",
            dependencies: ["WMProtocol", "WMWorkspace", "WMInventory"]
        ),
        .target(
            name: "WMCore",
            dependencies: ["WMProtocol", "WMInventory"]
        ),
        .target(name: "WMConfiguration"),
        .target(
            name: "WMWebSocket",
            dependencies: ["WMProtocol", "WMCore"]
        ),
        .target(
            name: "WMCLI",
            dependencies: ["WMConfiguration", "WMInventory", "WMProtocol", "WMWebSocket"]
        ),
        .executableTarget(
            name: "wm",
            dependencies: ["WMCLI", "WMConfiguration", "WMCore", "WMInventory", "WMPersistence", "WMProtocol", "WMWebSocket", "WMWorkspace"]
        ),
        .executableTarget(
            name: "WMGeometryFakeVerify",
            dependencies: ["WMCore", "WMInventory", "WMProtocol"]
        ),
        .executableTarget(
            name: "WMWorkspaceLayoutVerify",
            dependencies: ["WMWorkspace"]
        ),
        .testTarget(name: "WMProtocolTests", dependencies: ["WMProtocol"]),
        .testTarget(name: "WMInventoryTests", dependencies: ["WMInventory", "WMProtocol"]),
        .testTarget(name: "WMWorkspaceTests", dependencies: ["WMWorkspace", "WMProtocol"]),
        .testTarget(name: "WMPersistenceTests", dependencies: ["WMPersistence", "WMWorkspace", "WMProtocol", "WMInventory"]),
        .testTarget(name: "WMCoreTests", dependencies: ["WMCore", "WMInventory", "WMProtocol"]),
        .testTarget(name: "WMConfigurationTests", dependencies: ["WMConfiguration"]),
        .testTarget(name: "WMWebSocketTests", dependencies: ["WMWebSocket", "WMCore", "WMProtocol"]),
        .testTarget(name: "WMCLITests", dependencies: ["WMCLI", "WMConfiguration", "WMProtocol"]),
        .testTarget(name: "WMDaemonTests", dependencies: ["wm", "WMInventory", "WMPersistence", "WMWorkspace"]),
    ]
)
