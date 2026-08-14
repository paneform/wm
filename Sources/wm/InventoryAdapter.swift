import Foundation
import AppKit
import WMCore
import WMInventory

struct PrototypeSnapshot: InventorySnapshotProtocol {
    var windows: [PrototypeWindow]
    var displays: [PrototypeDisplay]
    var health: InventoryHealth
    var focusedWindowID: String?
    var inventory: InventorySnapshot

    func replacingWindow(_ window: PrototypeWindow) -> Self? {
        guard let index = windows.firstIndex(where: { $0.id == window.id }) else { return nil }
        var copy = self
        copy.windows[index] = window
        guard let inventoryIndex = copy.inventory.windows.firstIndex(where: { $0.id == window.id }) else { return nil }
        copy.inventory.windows[inventoryIndex] = window.value
        return copy
    }
}

struct PrototypeWindow: Identifiable, Codable, Equatable, Sendable {
    var id: String
    var value: NormalizedWindow
}

struct PrototypeDisplay: Identifiable, Codable, Equatable, Sendable {
    var id: String
    var value: DisplayObservation
}

struct SystemInventoryProvider: InventoryProvider {
    let scanner: InventoryScanner

    func inventory() async -> PrototypeSnapshot {
        let inventory = await scanner.scan()
        let focused = resolveFocusedWindowID(
            windows: inventory.windows,
            frontmostPID: NSWorkspace.shared.frontmostApplication?.processIdentifier
        )
        let issues = inventory.sourceHealth.flatMap(\.issues)
        let status: InventoryHealth.Status
        if inventory.sourceHealth.contains(where: { $0.status == .unhealthy }) { status = .unhealthy }
        else if inventory.sourceHealth.contains(where: { $0.status == .degraded }) { status = .degraded }
        else { status = .healthy }
        let permissions = Dictionary(uniqueKeysWithValues: inventory.sourceHealth.map { ($0.source.rawValue, $0.permissionGranted) })
        return PrototypeSnapshot(
            windows: inventory.windows.map { .init(id: $0.id, value: $0) },
            displays: inventory.displays.map { .init(id: $0.id, value: $0) },
            health: .init(status: status, issues: issues, capabilities: permissions),
            focusedWindowID: focused,
            inventory: inventory
        )
    }
}
