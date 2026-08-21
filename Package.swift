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
        .library(name: "WMLifecycle", targets: ["WMLifecycle"]),
        .library(name: "WMPermissions", targets: ["WMPermissions"]),
        .library(name: "WMDiagnostics", targets: ["WMDiagnostics"]),
        .executable(name: "wm-geometry-fake-verify", targets: ["WMGeometryFakeVerify"]),
        .executable(name: "wm-workspace-layout-verify", targets: ["WMWorkspaceLayoutVerify"]),
    ],
    targets: [
        .target(name: "WMProtocol"),
        .target(
            name: "WMInventory",
            dependencies: ["WMProtocol", "WMDiagnostics"]
        ),
        .target(
            name: "WMWorkspace",
            dependencies: ["WMProtocol"]
        ),
        .target(
            name: "WMPersistence",
            dependencies: ["WMProtocol", "WMWorkspace", "WMInventory", "WMDiagnostics"]
        ),
        .target(
            name: "WMCore",
            dependencies: ["WMProtocol", "WMInventory"]
        ),
        .target(name: "WMConfiguration"),
        .target(
            name: "WMLifecycle",
            dependencies: ["WMProtocol", "WMWebSocket"],
            linkerSettings: [.linkedFramework("SystemConfiguration")]
        ),
        .target(name: "WMPermissions"),
        .target(name: "WMDiagnostics"),
        .target(
            name: "WMWebSocket",
            dependencies: ["WMProtocol", "WMCore"]
        ),
        .target(
            name: "WMCLI",
            dependencies: ["WMConfiguration", "WMInventory", "WMLifecycle", "WMPermissions", "WMProtocol", "WMWebSocket"]
        ),
        .executableTarget(
            name: "wm",
            dependencies: ["WMCLI", "WMConfiguration", "WMCore", "WMDiagnostics", "WMInventory", "WMLifecycle", "WMPermissions", "WMPersistence", "WMProtocol", "WMWebSocket", "WMWorkspace"]
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
        .testTarget(name: "WMPersistenceTests", dependencies: ["WMPersistence", "WMLifecycle", "WMWorkspace", "WMProtocol", "WMInventory"]),
        .testTarget(name: "WMCoreTests", dependencies: ["WMCore", "WMInventory", "WMProtocol"]),
        .testTarget(name: "WMConfigurationTests", dependencies: ["WMConfiguration"]),
        .testTarget(name: "WMWebSocketTests", dependencies: ["WMWebSocket", "WMCore", "WMProtocol"]),
        .testTarget(name: "WMCLITests", dependencies: ["WMCLI", "WMConfiguration", "WMProtocol"]),
        .testTarget(name: "WMLifecycleTests", dependencies: ["WMLifecycle"]),
        .testTarget(name: "WMPermissionsTests", dependencies: ["WMPermissions"]),
        .testTarget(name: "WMDiagnosticsTests", dependencies: ["WMDiagnostics"]),
        .testTarget(name: "WMDaemonTests", dependencies: ["wm", "WMInventory", "WMPersistence", "WMWorkspace"]),
    ]
)
