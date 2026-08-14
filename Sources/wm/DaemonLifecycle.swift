import Foundation
import WMInventory
import WMProtocol
import WMWorkspace

struct DaemonLifecycle {
    private(set) var isPaused = false
    private(set) var isTerminating = false

    mutating func pause() -> Bool {
        defer { isPaused = true }
        return !isPaused
    }

    mutating func resume() -> Bool {
        guard !isTerminating else { return false }
        defer { isPaused = false }
        return isPaused
    }

    mutating func beginTermination() {
        isPaused = true
        isTerminating = true
    }

    func requireMutationAllowed() throws {
        if isTerminating { throw DaemonLifecycleError.terminating }
        if isPaused { throw DaemonLifecycleError.paused }
    }
}

enum DaemonLifecycleError: Error, Equatable {
    case paused, terminating
}

struct WorkspaceIntentAudit: Equatable {
    var restore: [String: InventoryRect]
    var park: Set<String>
    var reconcileVisible: Set<String>

    init(state: WMWorkspace.WorkspaceState, inventory: InventorySnapshot) {
        let live = Dictionary(uniqueKeysWithValues: inventory.windows.map { ($0.id, $0) })
        restore = [:]
        park = []
        reconcileVisible = []
        for workspace in state.workspaces {
            if workspace.visible {
                reconcileVisible.insert(workspace.name)
                for id in workspace.windowIDs where state.parkedWindowFrames[id] != nil {
                    if live[id] != nil { restore[id] = state.parkedWindowFrames[id]?.inventoryRect }
                }
            } else {
                for id in workspace.windowIDs where live[id] != nil { park.insert(id) }
            }
        }
    }
}

struct WorkspaceIntentAuditStep: Equatable {
    enum Action: Equatable { case restore(InventoryRect), park, retile }
    var windowOrWorkspaceID: String
    var action: Action
}

extension WorkspaceIntentAudit {
    var orderedSteps: [WorkspaceIntentAuditStep] {
        restore.keys.sorted().compactMap { id in restore[id].map { .init(windowOrWorkspaceID: id, action: .restore($0)) } }
            + park.sorted().map { .init(windowOrWorkspaceID: $0, action: .park) }
            + reconcileVisible.sorted().map { .init(windowOrWorkspaceID: $0, action: .retile) }
    }
}

private extension ParkedWindowFrame {
    var inventoryRect: InventoryRect { .init(x: x, y: y, width: width, height: height) }
}
