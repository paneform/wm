import Foundation
import WMPersistence
import WMWorkspace

actor WorkspaceController {
    private let store: WorkspaceStateStore<WMWorkspace.WorkspaceState>
    private(set) var state: WMWorkspace.WorkspaceState

    init(buildVersion: String) {
        store = WorkspaceStateStore(buildVersion: buildVersion) { try $0.validate() }
        switch try? store.load() {
        case .loaded(let loaded): state = loaded
        default: state = .init()
        }
    }

    func snapshot() -> WMWorkspace.WorkspaceState { state }

    func focus(name: String, displayID: String?) throws -> WMWorkspace.WorkspaceMutationResult {
        try commit { try $0.focusWorkspace(named: name, displayID: displayID) }
    }

    func previewFocus(name: String, displayID: String?) throws -> WMWorkspace.WorkspaceMutationResult {
        var candidate = state
        return try candidate.focusWorkspace(named: name, displayID: displayID)
    }

    func previewMoveWindows(_ ids: [String], to workspace: String) throws -> WMWorkspace.WorkspaceMutationResult {
        var candidate = state
        return try candidate.moveWindows(ids, to: workspace)
    }

    func previewMoveWorkspace(_ name: String, to displayID: String) throws -> WMWorkspace.WorkspaceMutationResult {
        var candidate = state
        return try candidate.moveWorkspace(named: name, to: displayID)
    }

    func previewSetMode(_ name: String, mode: WMWorkspace.WorkspaceMode) throws -> WMWorkspace.WorkspaceMutationResult {
        var candidate = state
        return try candidate.setMode(of: name, to: mode)
    }

    func commitFocus(_ result: WMWorkspace.WorkspaceMutationResult) throws {
        guard result.workspaceState != state else { return }
        try store.save(result.workspaceState)
        state = result.workspaceState
    }

    func moveWindows(_ ids: [String], to workspace: String) throws -> WMWorkspace.WorkspaceMutationResult {
        try commit { try $0.moveWindows(ids, to: workspace) }
    }

    func adoptUnassignedWindows(_ ids: [String], displayID: String) throws {
        _ = try commit { try $0.adoptUnassignedWindows(ids, displayID: displayID) }
    }

    func reconcileObservedWindows(_ ids: [String], displayID: String) throws -> WMWorkspace.WorkspaceMutationResult {
        try commit { try $0.reconcileObservedWindows(ids, defaultDisplayID: displayID) }
    }

    func moveWorkspace(_ name: String, to displayID: String) throws -> WMWorkspace.WorkspaceMutationResult {
        try commit { try $0.moveWorkspace(named: name, to: displayID) }
    }

    func setMode(_ name: String, mode: WMWorkspace.WorkspaceMode) throws -> WMWorkspace.WorkspaceMutationResult {
        try commit { try $0.setMode(of: name, to: mode) }
    }

    private func commit(
        _ mutation: (inout WMWorkspace.WorkspaceState) throws -> WMWorkspace.WorkspaceMutationResult
    ) throws -> WMWorkspace.WorkspaceMutationResult {
        var candidate = state
        let result = try mutation(&candidate)
        if candidate != state {
            try store.save(candidate)
            state = candidate
        }
        return result
    }
}
