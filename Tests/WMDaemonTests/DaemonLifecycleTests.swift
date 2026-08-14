import Foundation
import Testing
import WMInventory
import WMPersistence
import WMWorkspace
@testable import wm

@Test func pauseBlocksMutationsUntilResume() throws {
    var lifecycle = DaemonLifecycle()
    let paused = lifecycle.pause()
    #expect(paused)
    #expect(throws: DaemonLifecycleError.paused) { try lifecycle.requireMutationAllowed() }
    let resumed = lifecycle.resume()
    #expect(resumed)
    #expect(throws: Never.self) { try lifecycle.requireMutationAllowed() }
}

@Test func terminationCannotResumeAndBlocksObservers() {
    var lifecycle = DaemonLifecycle()
    lifecycle.beginTermination()
    #expect(lifecycle.isPaused)
    #expect(lifecycle.isTerminating)
    let resumed = lifecycle.resume()
    #expect(!resumed)
    #expect(throws: DaemonLifecycleError.terminating) { try lifecycle.requireMutationAllowed() }
}

@Test func invalidPersistedStateFailsControllerInitialization() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let stateURL = directory.appendingPathComponent("state.json")
    try Data("not json".utf8).write(to: stateURL)
    #expect(throws: WorkspaceControllerError.self) {
        _ = try WorkspaceController(buildVersion: "test", stateURL: stateURL)
    }
    try? FileManager.default.removeItem(at: directory)
}

@Test func committedIntentAuditRepairsInterruptedEffects() {
    var state = WorkspaceState()
    _ = try? state.focusWorkspace(named: "visible", displayID: "display:1")
    _ = try? state.adoptUnassignedWindows(["window:1"], displayID: "display:1")
    _ = try? state.focusWorkspace(named: "parked", displayID: "display:1")
    _ = try? state.adoptUnassignedWindows(["window:2"], displayID: "display:1")
    _ = try? state.focusWorkspace(named: "visible", displayID: "display:2")
    state.parkedWindowFrames["window:1"] = .init(x: 10, y: 20, width: 300, height: 200)

    let audit = WorkspaceIntentAudit(state: state, inventory: inventory(["window:1", "window:2"]))
    #expect(audit.restore["window:1"] == .init(x: 10, y: 20, width: 300, height: 200))
    #expect(audit.park.isEmpty)
    #expect(audit.reconcileVisible.contains("visible"))
}

@Test func committedIntentAuditOrdersRestoreParkAndRetile() {
    var state = WorkspaceState()
    _ = try? state.focusWorkspace(named: "visible", displayID: "display:1")
    _ = try? state.adoptUnassignedWindows(["window:1"], displayID: "display:1")
    _ = try? state.focusWorkspace(named: "hidden", displayID: "display:2")
    _ = try? state.adoptUnassignedWindows(["window:2"], displayID: "display:1")
    _ = try? state.focusWorkspace(named: "visible", displayID: "display:1")
    state.parkedWindowFrames["window:1"] = .init(x: 10, y: 20, width: 300, height: 200)
    state.workspaces[state.workspaces.firstIndex(where: { $0.name == "hidden" })!].visible = false

    let steps = WorkspaceIntentAudit(state: state, inventory: inventory(["window:1", "window:2"])).orderedSteps
    #expect(steps.first?.windowOrWorkspaceID == "window:1")
    #expect(steps.contains(.init(windowOrWorkspaceID: "window:2", action: .park)))
    let parkIndex = steps.firstIndex { $0.action == .park }
    let retileIndex = steps.firstIndex { $0.action == .retile }
    #expect(parkIndex != nil && retileIndex != nil && parkIndex! < retileIndex!)
}

private func inventory(_ ids: [String]) -> InventorySnapshot {
    let windows = ids.map { id in
        NormalizedWindow(
            id: id, pid: 1, appName: "Test", frame: .init(x: 0, y: 0, width: 100, height: 100),
            displayID: "display:1", classification: .normal, management: .managed, rejectionReasons: [],
            joinConfidence: .exact, joinSignals: [], health: .healthy, healthIssues: []
        )
    }
    return .init(
        timestamp: Date(timeIntervalSince1970: 0), durationMilliseconds: 0, displays: [], rawAXWindows: [],
        rawCGWindows: [], windows: windows, rejectedAXWindows: [], joinDecisions: [], sourceHealth: [], appScans: []
    )
}
