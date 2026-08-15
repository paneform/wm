import Foundation
import Testing
import WMCore
import WMInventory
import WMPersistence
import WMProtocol
import WMWorkspace
@testable import wm

private func daemonHandler() throws -> (DaemonHandler, DaemonHandler.State) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let scanner = InventoryScanner(sources: .init(
        displays: StubDisplays(), accessibility: StubAX(), coreGraphics: StubCG()
    ))
    let state = DaemonHandler.State(provider: SystemInventoryProvider(scanner: scanner))
    return (DaemonHandler(
        state: state,
        workspaces: try WorkspaceController(buildVersion: "test", stateURL: directory.appendingPathComponent("state.json"))
    ), state)
}

private struct StubDisplays: DisplayInventorySource {
    func displays() async -> SourceResult<[DisplayObservation]> {
        .init(value: [.init(id: "display:1", name: "Display", isBuiltin: true, isPrimary: true, frame: .init(x: 0, y: 0, width: 1000, height: 800), visibleFrame: .init(x: 0, y: 0, width: 1000, height: 800), backingScale: 1, identifiers: .init())], health: .init(source: .displays, status: .healthy, permissionGranted: nil))
    }
}

private struct StubCG: CoreGraphicsInventorySource {
    func windows() async -> SourceResult<[WMInventory.RawCGWindow]> {
        .init(value: [], health: .init(source: .coreGraphics, status: .healthy, permissionGranted: true))
    }
}

private struct StubAX: AccessibilityInventorySource {
    func applications() async -> SourceResult<[ApplicationObservation]> {
        .init(value: [], health: .init(source: .accessibility, status: .healthy, permissionGranted: true))
    }
    func windows(for application: ApplicationObservation) async throws -> [WMInventory.RawAXWindow] { [] }
}

private actor EventProbe {
    private var topics: [EventTopic] = []
    func record(_ topic: EventTopic) { topics.append(topic) }
    func contains(_ topic: EventTopic) -> Bool { topics.contains(topic) }
}

private func clientMessage(_ message: ClientMessage) throws -> String {
    String(data: try ProtocolCodec.encode(message), encoding: .utf8)!
}

private func response(_ text: String) throws -> Response {
    guard case .response(let response) = try ProtocolCodec.decode(ServerMessage.self, from: Data(text.utf8)) else {
        throw CancellationError()
    }
    return response
}

@Test func daemonSubscriptionsUnsubscribeExactlyByID() async throws {
    let (handler, _) = try daemonHandler()
    let client = UUID()
    await handler.installSender { _, _ in }
    _ = await handler.handle(text: try clientMessage(.subscribe(.init(
        requestId: "one", subscriptionId: "one", topics: [.configurationChanged]
    ))), clientID: client)
    _ = await handler.handle(text: try clientMessage(.subscribe(.init(
        requestId: "two", subscriptionId: "two", topics: [.configurationChanged]
    ))), clientID: client)
    let unsubscribe = await handler.handle(text: try clientMessage(.unsubscribe(.init(
        requestId: "remove", subscriptionId: "one"
    ))), clientID: client)

    #expect(try response(unsubscribe[0]).error == nil)
    let secondUnsubscribe = await handler.handle(text: try clientMessage(.unsubscribe(.init(
        requestId: "missing", subscriptionId: "one"
    ))), clientID: client)
    #expect(try response(secondUnsubscribe[0]).error?.code == .subscriptionNotFound)
}

@Test func mixedRoutingFamiliesAreRejectedWithoutRegistration() async throws {
    let (handler, _) = try daemonHandler()
    let client = UUID()
    let replies = await handler.handle(text: try clientMessage(.subscribe(.init(
        requestId: "mixed", subscriptionId: "mixed", topics: [.configurationChanged, .windowInventory]
    ))), clientID: client)

    #expect(try response(replies[0]).error?.code == .invalidParams)
    let unsubscribe = await handler.handle(text: try clientMessage(.unsubscribe(.init(
        requestId: "remove", subscriptionId: "mixed"
    ))), clientID: client)
    #expect(try response(unsubscribe[0]).error?.code == .subscriptionNotFound)
}

@Test func sessionHealthUsesTheSameHealthSubscriptionRoute() async throws {
    let (handler, _) = try daemonHandler()
    let client = UUID()
    let events = EventProbe()
    await handler.installSender { text, _ in
        guard case .event(let event) = try? ProtocolCodec.decode(ServerMessage.self, from: Data(text.utf8)) else { return }
        Task { await events.record(event.topic) }
    }
    _ = await handler.handle(text: try clientMessage(.subscribe(.init(
        requestId: "health", subscriptionId: "health", topics: [.healthChanged]
    ))), clientID: client)

    try await handler.resynchronizeSession(.wake)
    await Task.yield()
    #expect(await events.contains(.healthChanged))
}

@Test func configurationHealthUsesTheSameHealthSubscriptionRoute() async throws {
    let (handler, state) = try daemonHandler()
    let client = UUID()
    let events = EventProbe()
    await handler.installSender { text, _ in
        guard case .event(let event) = try? ProtocolCodec.decode(ServerMessage.self, from: Data(text.utf8)) else { return }
        Task { await events.record(event.topic) }
    }
    _ = await handler.handle(text: try clientMessage(.subscribe(.init(
        requestId: "health", subscriptionId: "health", topics: [.healthChanged]
    ))), clientID: client)
    _ = try await state.refresh()
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try Data(#"{"workspaces":[]}"#.utf8).write(to: path)
    defer { try? FileManager.default.removeItem(at: path) }

    _ = await handler.handle(text: try clientMessage(.request(.init(
        requestId: "reload", method: .configurationReload, params: ["path": .string(path.path)]
    ))), clientID: client)
    for _ in 0..<100 where !(await events.contains(.healthChanged)) { await Task.yield() }
    #expect(await events.contains(.healthChanged))
}

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

@Test func overlappingTransitionsCoalesceIntoOneFollowUpEpoch() async throws {
    actor Probe {
        var causes: [SessionTransitionCause] = []
        var gate: CheckedContinuation<Void, Never>?
        func run(_ cause: SessionTransitionCause) async -> SessionTransitionResult {
            causes.append(cause)
            if causes.count == 1 { await withCheckedContinuation { gate = $0 } }
            return .init(epoch: UInt64(causes.count), cause: cause, observerGeneration: UInt64(causes.count), displayStabilized: true, stabilizationAttempts: 2)
        }
        func waiting() -> Bool { gate != nil }
        func release() { gate?.resume(); gate = nil }
    }
    let probe = Probe()
    let epochs = SessionTransitionEpochs<Int, Void>(sleep: { _ in })
    let wake = Task { try await epochs.submit(cause: .wake) { await probe.run($0) } }
    while !(await probe.waiting()) { await Task.yield() }
    let active = Task { try await epochs.submit(cause: .activeSession) { await probe.run($0) } }
    while await epochs.queuedTransitionCause() != .activeSession { await Task.yield() }
    let screen = Task { try await epochs.submit(cause: .clamshell) { await probe.run($0) } }
    while await epochs.queuedTransitionCause() != .clamshell { await Task.yield() }
    await probe.release()

    _ = try await wake.value
    _ = try await active.value
    _ = try await screen.value
    #expect(await probe.causes == [.wake, .clamshell])
}

@Test func failedTransitionBurstRunsFailureCleanupAndReleasesWaiters() async {
    actor Probe {
        var failureCount = 0
        var gate: CheckedContinuation<Void, Never>?
        func fail() async throws -> SessionTransitionResult {
            await withCheckedContinuation { gate = $0 }
            throw Failure.expected
        }
        func waiting() -> Bool { gate != nil }
        func release() { gate?.resume(); gate = nil }
        func recordFailure() { failureCount += 1 }
    }
    enum Failure: Error { case expected }
    let probe = Probe()
    let epochs = SessionTransitionEpochs<Int, Void>(sleep: { _ in })
    let wake = Task {
        try await epochs.submit(cause: .wake, run: { _ in try await probe.fail() }, fail: { _ in
            await probe.recordFailure()
        })
    }
    while !(await probe.waiting()) { await Task.yield() }
    let screen = Task { try await epochs.submit(cause: .clamshell) { _ in
        Issue.record("coalesced caller must not start an overlapping transition")
        return .init(epoch: 0, cause: .clamshell, observerGeneration: 0, displayStabilized: false, stabilizationAttempts: 0)
    } }
    while await epochs.queuedTransitionCause() != .clamshell { await Task.yield() }
    await probe.release()

    await #expect(throws: Failure.expected) { try await wake.value }
    await #expect(throws: Failure.expected) { try await screen.value }
    #expect(await probe.failureCount == 1)
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

private func startupState(staleID: String, liveID: String) -> WMWorkspace.WorkspaceState {
    WMWorkspace.WorkspaceState(
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
