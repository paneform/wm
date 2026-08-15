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

@Test func transitionEpochOrdersFullRebuildAndRollsObserverGeneration() async throws {
    actor Probe {
        var steps: [String] = []
        var displays = [["old"], ["new"], ["new"]]
        func append(_ step: String) { steps.append(step) }
        func nextDisplays() -> [String] { displays.removeFirst() }
    }
    let probe = Probe()
    let epochs = SessionTransitionEpochs<[String], String>(sleep: { _ in })
    let result = try await epochs.resynchronize(
        cause: .wake,
        pause: { await probe.append("pause") },
        displays: { await probe.nextDisplays() },
        permissions: { await probe.append("permissions") },
        recreateObservers: { await probe.append("observers:\($0)") },
        rebuildInventory: { await probe.append("inventory"); return "rebuilt" },
        reconstructAndReconcile: { await probe.append("reconcile:\($0)") },
        resume: { await probe.append("resume") }
    )

    #expect(result == .init(epoch: 1, cause: .wake, observerGeneration: 1, displayStabilized: true, stabilizationAttempts: 3))
    #expect(await probe.steps == ["pause", "permissions", "observers:1", "inventory", "reconcile:rebuilt", "resume"])
}

@Test func failedTransitionRemainsPausedAndDoesNotRebuildOrResume() async {
    actor Probe {
        var steps: [String] = []
        func append(_ step: String) { steps.append(step) }
    }
    enum PermissionFailure: Error { case denied }
    let probe = Probe()
    let epochs = SessionTransitionEpochs<[String], String>(sleep: { _ in })

    await #expect(throws: PermissionFailure.denied) {
        try await epochs.resynchronize(
            cause: .unlock,
            pause: { await probe.append("pause") },
            displays: { ["stable"] },
            permissions: { await probe.append("permissions"); throw PermissionFailure.denied },
            recreateObservers: { _ in await probe.append("observers") },
            rebuildInventory: { await probe.append("inventory"); return "rebuilt" },
            reconstructAndReconcile: { _ in await probe.append("reconcile") },
            resume: { await probe.append("resume") }
        )
    }
    #expect(await probe.steps == ["pause", "permissions"])
}

@Test func unstableDisplaysUseBoundedDegradedFallback() async throws {
    actor Displays {
        var value = 0
        func next() -> Int { defer { value += 1 }; return value }
    }
    let displays = Displays()
    let epochs = SessionTransitionEpochs<Int, Void>(maximumDisplayAttempts: 3, sleep: { _ in })
    let result = try await epochs.resynchronize(
        cause: .clamshell,
        pause: {},
        displays: { await displays.next() },
        permissions: {},
        recreateObservers: { _ in },
        rebuildInventory: {},
        reconstructAndReconcile: { _ in },
        resume: {}
    )

    #expect(!result.displayStabilized)
    #expect(result.stabilizationAttempts == 3)
}

@Test func sessionActivationAfterSleepIsClassifiedAsUnlock() async {
    let epochs = SessionTransitionEpochs<Int, Void>(sleep: { _ in })
    await epochs.begin(.sleep, pause: {})
    #expect(await epochs.activationCause() == .unlock)
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

@Test func healthyStartupAuditRemovesDefinitivelyAbsentMembers() throws {
    let state = startupState(staleID: "window:cg:155", liveID: "window:cg:200")
    let candidate = StartupIntentAudit.candidate(
        state: state, inventory: completeInventory(["window:cg:200"])
    )

    #expect(candidate[workspace: "visible"]?.windowIDs == ["window:cg:200"])
    #expect(candidate[workspace: "visible"]?.focusedWindowID == "window:cg:200")
    #expect(candidate[workspace: "visible"]?.bsp.root == .leaf(windowID: "window:cg:200"))
    #expect(candidate.parkedWindowFrames["window:cg:155"] == nil)
    try candidate.validate()
}

@Test func unrelatedFailedAXScanStillPrunesStaleCGMember() {
    let state = startupState(staleID: "window:cg:155", liveID: "window:cg:200")
    let candidate = StartupIntentAudit.candidate(
        state: state, inventory: completeInventory(["window:cg:200"], appStatus: .failed)
    )

    #expect(candidate[workspace: "visible"]?.windowIDs == ["window:cg:200"])
    #expect(candidate.parkedWindowFrames["window:cg:155"] == nil)
}

@Test func unhealthyCGInventoryPreservesStartupIntent() {
    let state = startupState(staleID: "window:cg:155", liveID: "window:cg:200")
    var inventory = completeInventory(["window:cg:200"])
    inventory.sourceHealth = [.init(source: .coreGraphics, status: .unhealthy, permissionGranted: false)]

    #expect(StartupIntentAudit.candidate(state: state, inventory: inventory) == state)
}

@Test func periodicHealthyCGReconciliationPrunesStaleMembersBeforeEffects() throws {
    let state = startupState(staleID: "window:cg:13547", liveID: "window:cg:200")
    let reconciled = StartupIntentAudit.candidate(
        state: state, inventory: completeInventory(["window:cg:200"], appStatus: .failed)
    )

    #expect(reconciled[workspace: "visible"]?.windowIDs == ["window:cg:200"])
    #expect(WorkspaceIntentAudit(state: reconciled, inventory: completeInventory(["window:cg:200"]))
        .orderedSteps.allSatisfy { $0.windowOrWorkspaceID != "window:cg:13547" })
    try reconciled.validate()
}

@Test func periodicUnhealthyCGRetainsStaleMembersConservatively() {
    let state = startupState(staleID: "window:cg:13547", liveID: "window:cg:200")
    var inventory = completeInventory(["window:cg:200"])
    inventory.sourceHealth = [.init(source: .coreGraphics, status: .degraded, permissionGranted: true)]

    #expect(StartupIntentAudit.candidate(state: state, inventory: inventory) == state)
}

@Test func explicitFocusCandidateDoesNotPruneDuringDegradedCGInventory() {
    let state = startupState(staleID: "window:cg:13547", liveID: "window:cg:200")
    var inventory = completeInventory(["window:cg:200"])
    inventory.sourceHealth = [.init(source: .coreGraphics, status: .degraded, permissionGranted: true)]
    #expect(StartupIntentAudit.candidate(state: state, inventory: inventory) == state)
}

@Test func observerClampReportsOnceAndDoesNotBlockLaterWork() {
    var reliability = ObserverGeometryReliability()
    let clamp = ObserverGeometryReliability.Clamp(
        requestedWidth: 752, requestedHeight: 950, observedWidth: 723, observedHeight: 950
    )
    var completed: [String] = []

    #expect(reliability.shouldAttempt(windowID: "settings", requestedWidth: 752, requestedHeight: 950))
    let firstReport = reliability.record(windowID: "settings", clamp: clamp)
    #expect(firstReport)
    completed.append("other-window")
    completed.append("focus")

    #expect(!reliability.shouldAttempt(windowID: "settings", requestedWidth: 752, requestedHeight: 950))
    let repeatedReport = reliability.record(windowID: "settings", clamp: clamp)
    #expect(!repeatedReport)
    #expect(reliability.shouldAttempt(windowID: "settings", requestedWidth: 800, requestedHeight: 950))
    completed.append("later-focus")
    #expect(completed == ["other-window", "focus", "later-focus"])
}

@Test func recoveryAuditClassifiesRetilingAsBestEffort() {
    let step = WorkspaceIntentAuditStep(windowOrWorkspaceID: "visible", action: .retile)

    #expect(step.isRequiredForRecovery == false)
    #expect(WorkspaceIntentAuditStep(windowOrWorkspaceID: "window:1", action: .park).isRequiredForRecovery)
    #expect(WorkspaceIntentAuditStep(
        windowOrWorkspaceID: "window:1",
        action: .restore(.init(x: 0, y: 0, width: 100, height: 100))
    ).isRequiredForRecovery)
}

@Test func failedStartupAuditPreservesPersistedState() throws {
    enum AuditFailure: Error { case failed }
    let state = startupState(staleID: "window:cg:155", liveID: "window:cg:200")
    var persisted = state

    #expect(throws: AuditFailure.failed) {
        try StartupIntentAudit.run(
            state: state, inventory: completeInventory(["window:cg:200"]),
            audit: { _ in throw AuditFailure.failed },
            commit: { persisted = $0 }
        )
    }
    #expect(persisted == state)
}

@Test func externalActivationUsesFrontmostApplicationAfterLifecycleChanges() {
    var retained = inventory(["old", "replacement"]).windows
    retained[0].pid = 10
    retained[0].focused = true
    retained[1].pid = 20
    retained[1].main = true

    #expect(resolveRetainedFocusedWindowID(
        windows: retained, focusedWindowID: nil, frontmostPID: 20
    ) == "replacement")
}

private func startupState(staleID: String, liveID: String) -> WorkspaceState {
    WorkspaceState(
        workspaces: [.init(
            name: "visible", origin: .configured, displayID: "display:1", visible: true, focused: true,
            windowIDs: [staleID, liveID], focusedWindowID: staleID,
            bsp: .init(root: .split(
                axis: .vertical, ratio: 0.5,
                first: .leaf(windowID: staleID), second: .leaf(windowID: liveID)
            ))
        )],
        focusedWorkspaceName: "visible",
        displays: ["display:1": .init(visibleWorkspaceName: "visible")],
        parkedWindowFrames: [staleID: .init(x: 1, y: 2, width: 3, height: 4)]
    )
}

private func completeInventory(
    _ ids: [String], appStatus: AppScanStatus = .succeeded
) -> InventorySnapshot {
    var snapshot = inventory(ids)
    snapshot.rawCGWindows = ids.compactMap { id in
        guard let value = UInt32(id.replacingOccurrences(of: "window:cg:", with: "")) else { return nil }
        return .init(cgWindowID: value, pid: 1)
    }
    snapshot.sourceHealth = [
        .init(source: .accessibility, status: .healthy, permissionGranted: true),
        .init(source: .coreGraphics, status: .healthy, permissionGranted: true),
    ]
    snapshot.appScans = [.init(
        application: .init(pid: 1, name: "Test"), status: appStatus,
        durationMilliseconds: 1, windowCount: ids.count, issues: []
    )]
    return snapshot
}

private func inventory(_ ids: [String], enumeration: SourceStatus? = nil) -> InventorySnapshot {
    let windows = ids.map { id in
        NormalizedWindow(
            id: id, pid: 1, appName: "Test", frame: .init(x: 0, y: 0, width: 100, height: 100),
            displayID: "display:1", classification: .normal, management: .managed, rejectionReasons: [],
            joinConfidence: .exact, joinSignals: [], health: .healthy, healthIssues: []
        )
    }
    return .init(
        timestamp: Date(timeIntervalSince1970: 0), durationMilliseconds: 0, displays: [], rawAXWindows: [],
        rawCGWindows: [], windows: windows, rejectedAXWindows: [], joinDecisions: [],
        sourceHealth: enumeration.map { [.init(source: .accessibility, status: $0, permissionGranted: true, issues: [])] } ?? [],
        appScans: []
    )
}
