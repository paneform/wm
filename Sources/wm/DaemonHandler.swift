import Foundation
import WMConfiguration
import WMCore
import WMDiagnostics
import WMInventory
import WMPersistence
import WMProtocol
import WMWebSocket
import WMWorkspace

actor DaemonHandler: WebSocketRequestHandler {
  private struct StaleLifecycleProposal: Error {}
  private var shutdownRequest: (@Sendable () -> Void)?
  typealias State = InventoryState<SystemInventoryProvider>

  private struct WorkspaceSubscription {
    let topics: Set<EventTopic>
    let projection: Projection
  }

  private let state: State
  private let router: RequestRouter<SystemInventoryProvider>
  private let geometryProfiles: WindowGeometryProfileRecorder
  private let geometry: any WindowGeometryEffects
  private let rawGeometry: AXWindowGeometryAdapter
  private let diagnostics: DiagnosticCoordinator
  private let workspaces: WorkspaceController
  private let sessionID = UUID().uuidString
  private let version = "0.0.1-dev"
  private var subscriptions: [UUID: [String: Task<Void, Never>]] = [:]
  private var workspaceSubscriptions: [UUID: [String: WorkspaceSubscription]] = [:]
  private var stateSnapshotSubscriptions: [UUID: [String: SnapshotDetail]] = [:]
  private var workspaceSequence: UInt64 = 0
  private var windowMinimumSizes: [String: WorkspaceMinimumSize] = [:]
  private var layoutPolicy = WMWorkspace.LayoutPolicy.defaultChain
  private var workspaceLayoutPolicies: [String: [WMWorkspace.LayoutPolicy]] = [:]
  private var workspaceLayoutResults: [String: WorkspaceLayoutResult] = [:]
  private var maxGeometryRetries = 5
  private var geometryProfileMode: WMWorkspace.GeometryProfileMode = .store
  private var workspaceGeometryPolicies:
    [String: (retries: Int?, mode: WMWorkspace.GeometryProfileMode?)] = [:]
  private var observerGeometryReliability = ObserverGeometryReliability()
  private var expectedActivationPIDs: [Int32: Date] = [:]
  private var sessionWindows: [String: NormalizedWindow] = [:]
  private var managedOverrideLifetimes: Set<WindowLifetime> = []
  private var lifecycle = ManagedWindowLifecycle()
  private var lifecycleRevision: UInt64 = 0
  private var daemonLifecycle = DaemonLifecycle()
  private var automaticReconciliationEnabled = true
  private var sessionTransitionGeneration: UInt64 = 0
  private let transactions = TransactionCoordinator<JSONValue>()
  private let sessionTransitions = SessionTransitionEpochs<
    DisplayTopologySnapshot, InventorySnapshot
  >()
  private let configuration = ConfigurationStore()
  private var lastTransitionTrace: JSONValue = .null
  private var parkingDiagnoses: [String: ResolvedDiagnostic<ParkingLimits>] = [:]
  private var pendingParking: Set<WindowLifetime> = []
  private var parkingTask: Task<Void, Never>?
  private var parkingTaskGeneration: UInt64 = 0
  private var parkingRetryRequested = false
  private var parkingProbePriority: [String: String] = [:]
  private var parkingProbe: (window: NormalizedWindow, original: InventoryRect, generation: UInt64)?
  private var sender: (@Sendable (String, UUID) -> Void)?
  private var internalErrorReporter: (@Sendable (String) -> Void)?

  init(
    state: State, workspaces: WorkspaceController,
    geometryProfiles: WindowGeometryProfileRecorder = .init(),
    geometryEffects: (any WindowGeometryEffects)? = nil,
    rawGeometry: AXWindowGeometryAdapter = .init(),
    diagnostics: DiagnosticCoordinator = .init(persistence: TransientDiagnosticStore())
  ) {
    self.state = state
    self.workspaces = workspaces
    self.geometryProfiles = geometryProfiles
    self.rawGeometry = rawGeometry
    self.diagnostics = diagnostics
    geometry =
      geometryEffects
      ?? WindowGeometryService(adapter: AXWindowGeometryAdapter(), profiles: geometryProfiles)
    router = RequestRouter(inventory: state)
  }

  func installSender(_ sender: @escaping @Sendable (String, UUID) -> Void) { self.sender = sender }
  func installInternalErrorReporter(_ reporter: @escaping @Sendable (String) -> Void) {
    internalErrorReporter = reporter
  }

  func mergingPersistedCapabilities(into inventory: InventorySnapshot) async -> InventorySnapshot {
    await geometryProfiles.mergingCapabilities(into: inventory)
  }

  func resolveParkingDiagnosis(
    _ inventory: InventorySnapshot, displayID: String, probe: NormalizedWindow,
    currentFrame: InventoryRect, restoreFrame: InventoryRect, generation: UInt64
  ) async throws {
    let key = try ParkingDiagnosticIdentity.key(
      displayID: displayID, displays: inventory.displays,
      operatingSystem: ProcessInfo.processInfo.operatingSystemVersion)
    parkingDiagnoses[displayID] = try await diagnostics.resolve(key: key) {
      let topology = DisplayTopologySnapshot(displays: inventory.displays)
      let displayFrames = topology.axFrames
      guard let display = displayFrames[displayID] else {
        throw ParkingDiagnosticError.noProbeWindow
      }
      let others = displayFrames.values.filter { $0 != display }
      let corners = WindowParkingPlan.availableCorners(
        on: display, avoiding: Array(others), window: currentFrame,
        currentFrame: currentFrame)
      guard !corners.isEmpty else {
        throw WMInventory.ParkingDiagnosticError.noTopologySafeCorner
      }
      var results: [ParkingCorner: ParkingVisibility] = [:]
      var lastProbeError: Error?
      for corner in corners {
        do {
          let start = WindowParkingPlan.diagnosticStart(
            for: corner, display: display, window: currentFrame, currentFrame: currentFrame,
            avoiding: Array(others))
          let endpoint = WindowParkingPlan.offscreenEndpoint(
            for: corner, display: display, window: currentFrame)
          let accepted = try await self.probeParkingCorner(
            probe: probe, original: currentFrame, start: start, endpoint: endpoint,
            otherDisplays: Array(others), displayID: displayID, displays: inventory.displays,
            generation: generation)
          results[corner] = WindowParkingPlan.visibility(
            for: corner, display: display, accepted: accepted)
        } catch {
          lastProbeError = error
        }
      }
      let workspaceState = await self.workspaces.snapshot()
      let workspace = workspaceState.workspaceName(containing: probe.id)
      let remainsHidden = workspace.flatMap { workspaceState[workspace: $0]?.visible } == false
      let restorationTarget = remainsHidden ? currentFrame : restoreFrame
      do {
        try await self.restoreProbe(
          probe, original: restorationTarget, displayID: displayID, displays: inventory.displays)
      } catch { throw ParkingDiagnosticError.restorationFailed }
      try await self.requireParkingTaskGeneration(generation)
      if results.isEmpty {
        throw lastProbeError ?? WMInventory.ParkingDiagnosticError.noAcceptedPosition
      }
      return ParkingLimits(corners: results)
    }
  }

  func probeParkingCorner(
    probe: NormalizedWindow, original: InventoryRect, start: InventoryRect,
    endpoint: InventoryRect, otherDisplays: [InventoryRect], displayID: String,
    displays: [DisplayObservation], generation: UInt64
  ) async throws -> InventoryRect {
    let seeded = try await self.setParkingProbePosition(
      probe, target: start, original: original, otherDisplays: otherDisplays,
      displayID: displayID, displays: displays, generation: generation)
    let endpointObservation = try await self.setParkingProbePosition(
      probe, target: endpoint, original: original, otherDisplays: otherDisplays,
      displayID: displayID, displays: displays, generation: generation)
    let discovery = ParkingLimitDiscovery()
    let xBounds = try discovery.boundsIfClamped(
      observed: endpointObservation.x, endpoint: endpoint.x,
      direction: WindowParkingPlan.axisDirection(from: start, to: endpoint, horizontal: true),
      acceptedSeed: seeded.x)
    let yBounds = try discovery.boundsIfClamped(
      observed: endpointObservation.y, endpoint: endpoint.y,
      direction: WindowParkingPlan.axisDirection(from: start, to: endpoint, horizontal: false),
      acceptedSeed: seeded.y)
    let resolved = try await ParkingJointDiscovery.search(
      base: endpoint, xAxis: xBounds, yAxis: yBounds
    ) { target in
      try await self.setParkingProbePosition(
        probe, target: target, original: original, otherDisplays: otherDisplays,
        displayID: displayID, displays: displays, generation: generation)
    }
    var accepted = endpoint
    if let x = resolved.x { accepted.x = x }
    if let y = resolved.y { accepted.y = y }
    return accepted
  }

  private func setParkingProbePosition(
    _ probe: NormalizedWindow, target: InventoryRect, original: InventoryRect,
    otherDisplays: [InventoryRect], displayID: String, displays: [DisplayObservation],
    generation: UInt64
  ) async throws -> InventoryRect {
    guard WindowParkingPlan.isTopologySafe(target, avoiding: otherDisplays) else {
      throw WMInventory.ParkingDiagnosticError.noTopologySafeCorner
    }
    try await validateParkingProbe(
      probe, original: original, displayID: displayID, displays: displays,
      generation: generation)
    let observed = try await geometry.setPositionAllowingClamping(window: probe, frame: target)
    try await validateParkingProbe(
      probe, original: original, displayID: displayID, displays: displays,
      generation: generation)
    guard abs(observed.width - original.width) <= 1,
      abs(observed.height - original.height) <= 1,
      WindowParkingPlan.isTopologySafe(observed, avoiding: otherDisplays)
    else {
      throw WMInventory.ParkingDiagnosticError.inconclusiveObservation
    }
    return observed
  }

  private func requireParkingTaskGeneration(_ generation: UInt64) throws {
    guard generation == parkingTaskGeneration else { throw CancellationError() }
  }

  private func validateParkingProbe(
    _ probe: NormalizedWindow, original: InventoryRect, displayID: String,
    displays: [DisplayObservation], generation: UInt64
  ) async throws {
    try Task.checkCancellation()
    try requireParkingTaskGeneration(generation)
    let current = try await state.state().snapshot.inventory
    try requireParkingTaskGeneration(generation)
    let workspaceState = await workspaces.snapshot()
    guard
      DisplayTopologySnapshot(displays: current.displays)
        == DisplayTopologySnapshot(displays: displays),
      current.displays.contains(where: { $0.id == displayID }),
      current.windows.contains(where: { $0.id == probe.id && $0.pid == probe.pid }),
      let workspace = workspaceState.workspaceName(containing: probe.id),
      workspaceState[workspace: workspace]?.visible == false,
      parkingProbe?.window.id == probe.id, parkingProbe?.window.pid == probe.pid,
      original.isUsable
    else { throw CancellationError() }
  }

  nonisolated static func containsCenter(_ display: InventoryRect, of window: InventoryRect)
    -> Bool
  {
    let centerX = window.x + window.width / 2
    let centerY = window.y + window.height / 2
    return centerX >= display.x && centerX < display.x + display.width
      && centerY >= display.y && centerY < display.y + display.height
  }

  private nonisolated static func contains(
    _ display: InventoryRect, frame: InventoryRect, tolerance: Double
  ) -> Bool {
    frame.x >= display.x - tolerance && frame.y >= display.y - tolerance
      && frame.x + frame.width <= display.x + display.width + tolerance
      && frame.y + frame.height <= display.y + display.height + tolerance
  }

  func reconcileExternalFocus(
    windowID: String?, frontmostPID: Int32?, inventory: InventorySnapshot,
    allowWhilePaused: Bool = false
  ) async throws {
    if !allowWhilePaused { try daemonLifecycle.requireMutationAllowed() }
    try await reconcileExternalFocusAuthorized(
      windowID: windowID, frontmostPID: frontmostPID, inventory: inventory)
  }

  private func reconcileExternalFocusAuthorized(
    windowID: String?, frontmostPID: Int32?, inventory: InventorySnapshot,
    tolerateGeometryClamp: Bool = false
  ) async throws {
    let generation = sessionTransitionGeneration
    await geometry.reconcile(windows: inventory.windows)
    try requireCurrentSessionGeneration(generation)
    let observedWindows = inventory.windows.filter { $0.classification == .normal }
    let observedIDs = Set(observedWindows.map(\.id))
    let currentLifetimes = Set(
      inventory.windows.map { WindowLifetime(windowID: $0.id, pid: $0.pid) })
    retainSessionWindows(observedWindows)
    retainSessionWindows(
      inventory.windows.compactMap { window in
        let lifetime = WindowLifetime(windowID: window.id, pid: window.pid)
        guard managedOverrideLifetimes.contains(lifetime) else { return nil }
        var managed = window
        managed.management = .managed
        return managed
      })
    let effectIDs = observedIDs.union(
      currentLifetimes.intersection(managedOverrideLifetimes).map(\.windowID))
    let windowID = resolveRetainedFocusedWindowID(
      windows: observedWindows,
      focusedWindowID: windowID.flatMap { observedIDs.contains($0) ? $0 : nil },
      frontmostPID: frontmostPID
    )
    guard let windowID else { return }
    let before = await workspaces.snapshot()
    try requireCurrentSessionGeneration(generation)
    guard let name = before.workspaceName(containing: windowID), name != before.focusedWorkspaceName
    else { return }
    guard
      Self.isAuthoritativeExternalFocus(
        windowID: windowID, frontmostPID: frontmostPID, windows: observedWindows)
    else { return }
    let displayID = before[workspace: name]?.displayID
    var mutation = try await workspaces.previewFocus(name: name, displayID: displayID)
    try requireCurrentSessionGeneration(generation)
    mutation.workspaceState.setFocusedWindow(windowID, in: name)
    let transition = WorkspaceTransitionPlan(
      before: before, after: mutation.workspaceState, destination: name)
    guard transition.incomingWindowIDs.union(transition.outgoingWindowIDs).isSubset(of: effectIDs)
    else { return }
    let pending = try await reconcileWorkspaceFocus(
      before: before, after: &mutation.workspaceState, name: name, inventory: inventory,
      tolerateGeometryClamp: tolerateGeometryClamp, sessionGeneration: generation
    )
    try requireCurrentSessionGeneration(generation)
    try await commitFocusAndSchedule(mutation, pending: pending)
    try requireCurrentSessionGeneration(generation)
    await publishWorkspaceMutation(mutation, before: before, reason: .workspaceFocused)
  }

  func reconcileApplicationActivation(frontmostPID: Int32, inventory: InventorySnapshot)
    async throws
  {
    guard automaticReconciliationEnabled else { return }
    let now = Date()
    expectedActivationPIDs = expectedActivationPIDs.filter { $0.value > now }
    if expectedActivationPIDs.removeValue(forKey: frontmostPID) != nil { return }
    let receipt = try await submitInternal(
      name: "observer.activation", idempotencyKey: "activation:\(frontmostPID)"
    ) { [weak self] in
      guard let self else { throw CancellationError() }
      try await self.reconcileExternalFocusAuthorized(
        windowID: nil, frontmostPID: frontmostPID, inventory: inventory, tolerateGeometryClamp: true
      )
    }
    if let failure = receipt.transaction.failure { throw failure }
  }

  func reconcilePeriodicObservation(
    _ inventory: InventorySnapshot, displayID: String, focusedWindowID: String?,
    frontmostPID: Int32?
  ) async throws {
    guard automaticReconciliationEnabled else { return }
    let inventory = await geometryProfiles.mergingCapabilities(into: inventory)
    let receipt = try await submitInternal(
      name: "observer.periodic", idempotencyKey: "observer.periodic"
    ) { [weak self] in
      guard let self else { throw CancellationError() }
      try await self.reconcileObservedWindowsAuthorized(inventory, displayID: displayID)
      try await self.reconcileExternalFocusAuthorized(
        windowID: focusedWindowID, frontmostPID: frontmostPID, inventory: inventory,
        tolerateGeometryClamp: true
      )
    }
    if let failure = receipt.transaction.failure { throw failure }
  }

  static func focusCandidateIDs(
    workspace: WMWorkspace.Workspace, inventory: InventorySnapshot
  ) -> [String] {
    let liveIDs = Set(inventory.windows.filter { $0.classification == .normal }.map(\.id))
    let preferred = workspace.focusedWindowID.map { [$0] } ?? []
    return (preferred + workspace.windowIDs.reversed().filter { $0 != workspace.focusedWindowID })
      .filter(liveIDs.contains)
  }

  nonisolated static func isAuthoritativeExternalFocus(
    windowID: String, frontmostPID: Int32?, windows: [NormalizedWindow]
  ) -> Bool {
    guard let frontmostPID else { return false }
    return windows.first(where: { $0.id == windowID })?.pid == frontmostPID
  }

  func reconcileObservedWindows(_ inventory: InventorySnapshot, displayID: String) async throws {
    try daemonLifecycle.requireMutationAllowed()
    try await reconcileObservedWindowsAuthorized(inventory, displayID: displayID)
  }

  private func reconcileObservedWindowsAuthorized(_ inventory: InventorySnapshot, displayID: String)
    async throws
  {
    let inventory = await geometryProfiles.mergingCapabilities(into: inventory)
    let generation = sessionTransitionGeneration
    await geometry.reconcile(windows: inventory.windows)
    try requireCurrentSessionGeneration(generation)
    let revision = lifecycleRevision
    var proposedLifecycle = lifecycle
    let update = proposedLifecycle.reconcile(inventory)
    try await applyLifecycleUpdate(
      update, inventory: inventory, displayID: displayID, sessionGeneration: generation,
      expectedLifecycleRevision: revision)
    try requireCurrentSessionGeneration(generation)
    try commitLifecycle(proposedLifecycle, expectedRevision: revision)
  }

  func auditCommittedIntent(
    _ inventory: InventorySnapshot, state proposed: WMWorkspace.WorkspaceState? = nil
  ) async throws {
    let committed: WMWorkspace.WorkspaceState
    if let proposed { committed = proposed } else { committed = await workspaces.snapshot() }
    retainSessionWindows(inventory.windows)
    await geometry.reconcile(windows: inventory.windows)
    let audit = WorkspaceIntentAudit(
      state: committed, inventory: inventory, retainedWindows: sessionWindows)
    for step in audit.orderedSteps {
      switch step.action {
      case .restore(let frame):
        let window = try resolveWindow(step.windowOrWorkspaceID, in: inventory.windows)
        let floating = committed.workspaces.contains {
          $0.floatingWindowIDs.contains(step.windowOrWorkspaceID)
        }
        _ = try await setRestoredFrame(window: window, target: frame, floating: floating)
      case .park:
        guard
          inventory.windows.contains(where: {
            $0.id == step.windowOrWorkspaceID && $0.classification == .normal
          })
        else { continue }
        try await parkCommittedWindow(
          step.windowOrWorkspaceID, state: committed, inventory: inventory)
      case .retile:
        _ = await tileWorkspaceForObserver(
          committed, named: step.windowOrWorkspaceID, inventory: inventory, forceStack: false
        )
      }
    }
  }

  func auditStartupIntent(_ inventory: InventorySnapshot) async throws {
    let inventory = await geometryProfiles.mergingCapabilities(into: inventory)
    let committed = await workspaces.snapshot()
    let candidate = StartupIntentAudit.candidate(state: committed, inventory: inventory)
    try await auditCommittedIntent(inventory, state: candidate)
    try await workspaces.commit(candidate)
  }

  func recoverInvalidPersistedState(
    configuration: Configuration, inventory: InventorySnapshot, defaultDisplayID: String
  ) async throws {
    let inventory = await geometryProfiles.mergingCapabilities(into: inventory)
    guard workspaces.recoveredFromInvalidPersistedState else { return }
    var candidate = await workspaces.configuredState(
      configuration, defaultDisplayID: defaultDisplayID, displays: inventory.displays,
      state: .init()
    )
    let windows = inventory.windows.filter {
      $0.classification == .normal && $0.management == .managed
    }.sorted { $0.id < $1.id }
    for window in windows {
      let descriptor = WindowDescriptor(
        bundleID: window.bundleID, executablePath: window.executablePath, processID: window.pid,
        title: window.title, role: window.role, subrole: window.subrole
      )
      let workspace = configuration.initialWorkspace(for: descriptor) ?? "1"
      _ = try candidate.adoptUnassignedWindows(
        [window.id], into: workspace, displayID: window.displayID ?? defaultDisplayID
      )
    }
    candidate = await workspaces.configuredState(
      configuration, defaultDisplayID: defaultDisplayID, displays: inventory.displays,
      state: candidate
    )
    try await workspaces.commit(candidate)
  }

  func loadConfiguration(source: String, inventory: InventorySnapshot) async throws
    -> ConfigurationSnapshot
  {
    let candidate = try ConfigurationParser.parse(source)
    try await applyConfiguration(candidate, inventory: inventory)
    return try await configuration.reload(source: source, trigger: .explicit, mode: .full)
  }

  func hotloadConfiguration(source: String, inventory: InventorySnapshot) async throws
    -> ConfigurationSnapshot
  {
    let candidate = try ConfigurationParser.parse(source)
    guard candidate.hotload else { return await configuration.snapshot() }
    try await applyConfiguration(candidate, inventory: inventory)
    return try await configuration.reload(source: source, trigger: .hotload, mode: .delta)
  }

  private func applyConfiguration(_ candidate: Configuration, inventory: InventorySnapshot)
    async throws
  {
    guard
      let displayID = (inventory.displays.first(where: \.isPrimary) ?? inventory.displays.first)?.id
    else {
      throw WorkspaceRequestError.displayRequired
    }
    let before = await workspaces.snapshot()
    layoutPolicy = workspacePolicies(
      candidate.defaults.layoutPolicy ?? [.greedy, .overlap, .stack, .overflow])
    workspaceLayoutPolicies.removeAll()
    maxGeometryRetries = candidate.defaults.maxGeometryRetries ?? 5
    geometryProfileMode = workspaceProfileMode(candidate.defaults.geometryProfileMode ?? .store)
    var after = await workspaces.configuredState(
      candidate, defaultDisplayID: displayID, displays: inventory.displays
    )
    guard after != before else { return }
    let modified = after.workspaces.filter { workspace in
      before[workspace: workspace.name] != workspace
    }.map(\.name)
    var pending: Set<WindowLifetime> = []
    for name in modified where after[workspace: name]?.visible == true {
      if before[workspace: name]?.displayID == after[workspace: name]?.displayID,
        before[workspace: name]?.visible == true
      {
        _ = await tileWorkspaceForObserver(
          after, named: name, inventory: inventory, forceStack: false)
      } else {
        pending.formUnion(
          try await reconcileWorkspaceFocus(
            before: before, after: &after, name: name, inventory: inventory,
            tolerateGeometryClamp: true
          ))
      }
    }
    try await workspaces.commit(after)
    pendingParking.formUnion(pending)
    scheduleParking()
    let result = WMWorkspace.WorkspaceMutationResult(
      workspaceState: after, modifiedWorkspaces: modified)
    await publishWorkspaceMutation(result, before: before, reason: .workspaceChanged)
  }

  func beginTermination() { daemonLifecycle.beginTermination() }

  func installShutdownRequest(_ request: @escaping @Sendable () -> Void) {
    shutdownRequest = request
  }

  func shutdown(_ inventory: InventorySnapshot) async -> [String] {
    daemonLifecycle.beginTermination()
    retainSessionWindows(inventory.windows)
    await geometry.reconcile(windows: inventory.windows)
    let committed = await workspaces.snapshot()
    var failures: [String] = []
    for id in committed.parkedWindowFrames.keys.sorted() {
      guard let restore = committed.parkedWindowFrames[id], let window = sessionWindows[id] else {
        failures.append("\(id): not observed during shutdown")
        continue
      }
      do {
        let floating = committed.workspaces.contains { $0.floatingWindowIDs.contains(id) }
        _ = try await setRestoredFrame(
          window: window, target: restore.inventoryRect, floating: floating)
      } catch { failures.append("\(id): \(error)") }
    }
    return failures
  }

  func isPaused() -> Bool { daemonLifecycle.isPaused }

  func beginSessionTransition(_ cause: SessionTransitionCause) async {
    await sessionTransitions.begin(cause) { [weak self] in
      await self?.pauseForSessionTransition(cause)
    }
  }

  func resynchronizeActivatedSession() async throws {
    try await resynchronizeSession(await sessionTransitions.activationCause())
  }

  func resynchronizeSession(_ cause: SessionTransitionCause) async throws {
    let result = try await sessionTransitions.submit(
      cause: cause,
      begin: { [weak self] cause in await self?.pauseForSessionTransition(cause) },
      run: { [weak self] cause in
        guard let self else { throw CancellationError() }
        return try await self.performSessionResynchronizationEpoch(cause)
      },
      complete: { [weak self] in await self?.resumeAfterSessionTransition() },
      fail: { [weak self] error in await self?.failSessionTransition(cause, error: error) }
    )
    await publishSessionEvent(
      .sessionResynchronized,
      data: .object([
        "epoch": .number(Double(result.epoch)),
        "cause": .string(result.cause.rawValue),
        "observer_generation": .number(Double(result.observerGeneration)),
        "display_stabilized": .bool(result.displayStabilized),
        "stabilization_attempts": .number(Double(result.stabilizationAttempts)),
      ]))
    if let health = try? await state.health() {
      await publishSessionEvent(.healthChanged, data: json(protocolHealth(health)))
    }
  }

  private func performSessionResynchronizationEpoch(_ cause: SessionTransitionCause) async throws
    -> SessionTransitionResult
  {
    try await sessionTransitions.resynchronize(
      cause: cause,
      pause: {},
      displays: { [state] in
        DisplayTopologySnapshot(displays: try await state.refresh().snapshot.inventory.displays)
      },
      permissions: { [state] in
        let snapshot = try await state.refresh().snapshot
        guard snapshot.health.capabilities["accessibility"] as? Bool == true,
          snapshot.health.capabilities["core_graphics"] as? Bool == true
        else {
          throw DaemonLifecycleRequestError.permissionDenied
        }
      },
      recreateObservers: { [weak self] _ in await self?.discardStaleSessionHandles() },
      rebuildInventory: { [state] in try await state.refresh().snapshot.inventory },
      reconstructAndReconcile: { [weak self] inventory in
        guard let self else { throw CancellationError() }
        try await self.reconstructObservedState(inventory)
      },
      resume: {}
    )
  }

  private func failSessionTransition(_ cause: SessionTransitionCause, error: Error) async {
    await transactions.endRecovery(
      success: false,
      failure: .init(
        code: .notReady, message: "session resynchronization failed", retryable: true
      ))
    internalErrorReporter?(
      "session resynchronization failed (cause: \(cause.rawValue)): \(String(describing: error).prefix(512))"
    )
  }

  private func pauseForSessionTransition(_ cause: SessionTransitionCause) async {
    sessionTransitionGeneration &+= 1
    await cancelParkingWork()
    _ = daemonLifecycle.pause()
    await transactions.beginRecovery(reason: "session transition: \(cause.rawValue)")
    await publishSessionEvent(.daemonPaused, data: .object(["cause": .string(cause.rawValue)]))
  }

  private func discardStaleSessionHandles() async {
    sessionWindows.removeAll(keepingCapacity: true)
    managedOverrideLifetimes.removeAll(keepingCapacity: true)
    windowMinimumSizes.removeAll(keepingCapacity: true)
    observerGeometryReliability = .init()
    lifecycle = .init()
    lifecycleRevision &+= 1
    await geometry.reconcile(windows: [])
  }

  private func reconstructObservedState(_ inventory: InventorySnapshot) async throws {
    let inventory = await geometryProfiles.mergingCapabilities(into: inventory)
    let generation = sessionTransitionGeneration
    guard
      let displayID = (inventory.displays.first(where: \.isPrimary) ?? inventory.displays.first)?.id
    else {
      throw WorkspaceRequestError.displayRequired
    }
    let committed = await workspaces.snapshot()
    try requireCurrentSessionGeneration(generation)
    let revision = lifecycleRevision
    var proposedLifecycle = lifecycle
    let update = proposedLifecycle.reconcile(inventory)
    reportRecoveryMembership(
      "reconstruct", inventory: inventory, state: committed, update: update)
    var candidate = StartupIntentAudit.candidate(
      state: committed, inventory: inventory, replacements: update.replacements)
    _ = try candidate.reconcileDisplayTopology(
      connectedDisplayIDs: Set(inventory.displays.map(\.id)), fallbackDisplayID: displayID
    )
    try await auditCommittedIntent(inventory, state: candidate)
    try requireCurrentSessionGeneration(generation)
    try await workspaces.commit(candidate)
    try requireCurrentSessionGeneration(generation)
    try await applyLifecycleUpdate(
      update, inventory: inventory, displayID: displayID, sessionGeneration: generation,
      expectedLifecycleRevision: revision)
    try requireCurrentSessionGeneration(generation)
    try commitLifecycle(proposedLifecycle, expectedRevision: revision)
  }

  private func resumeAfterSessionTransition() async {
    _ = daemonLifecycle.resume()
    await transactions.endRecovery(success: true)
    await publishSessionEvent(.daemonResumed, data: .object(["resynchronized": .bool(true)]))
  }

  private func publishSessionEvent(
    _ topic: EventTopic, data: JSONValue, sessionGeneration: UInt64? = nil
  ) async {
    let version = await currentVersion()
    guard sessionGeneration == nil || sessionGeneration == self.sessionTransitionGeneration else {
      return
    }
    workspaceSequence &+= 1
    for (clientID, subscriptions) in workspaceSubscriptions {
      for subscription in subscriptions.values where subscription.topics.contains(topic) {
        let projected =
          subscription.projection == .invalidation
          ? JSONValue.object([
            "topic": .string(topic.rawValue), "state_version": .number(Double(version)),
          ])
          : data
        sender?(
          encode(
            .event(
              .init(
                sequence: workspaceSequence,
                stateVersion: version,
                timestamp: Date(),
                topic: topic,
                data: projected
              ))), clientID)
      }
    }
  }

  private func applyLifecycleUpdate(
    _ update: WindowLifecycleUpdate, inventory: InventorySnapshot, displayID: String,
    sessionGeneration: UInt64? = nil, expectedLifecycleRevision: UInt64? = nil
  ) async throws {
    try requireCurrentSessionGeneration(sessionGeneration)
    try requireLifecycleRevision(expectedLifecycleRevision)
    let closedIDs = Set(update.verifiedClosedLifetimes.map(\.windowID))
    let before = await workspaces.snapshot()
    try requireCurrentSessionGeneration(sessionGeneration)
    try requireLifecycleRevision(expectedLifecycleRevision)
    let configured = await configuration.snapshot().configuration ?? Configuration()
    try requireCurrentSessionGeneration(sessionGeneration)
    try requireLifecycleRevision(expectedLifecycleRevision)
    let assignedIDs = Set(before.workspaces.flatMap(\.windowIDs))
    let assignments: [String: String] = Dictionary(
      uniqueKeysWithValues: update.windows.compactMap { window in
        guard !assignedIDs.contains(window.id) else { return nil }
        let descriptor = WindowDescriptor(
          bundleID: window.bundleID, executablePath: window.executablePath, processID: window.pid,
          title: window.title, role: window.role, subrole: window.subrole
        )
        return configured.initialWorkspace(for: descriptor).map { (window.id, $0) }
      })
    let unassigned = update.windows.map(\.id).filter { !assignedIDs.contains($0) }.sorted()
    if !unassigned.isEmpty || !closedIDs.isEmpty || !update.newlyUnmanagedWindowIDs.isEmpty
      || !update.replacements.isEmpty
    {
      internalErrorReporter?(
        "membership reconciliation: unassigned=\(unassigned) assignments=\(assignments.sorted { $0.key < $1.key }) closed=\(closedIDs.sorted()) unmanaged=\(update.newlyUnmanagedWindowIDs.sorted()) replacements=\(update.replacements.sorted { $0.key < $1.key })"
      )
    }
    let mutation = try await workspaces.previewReconcileObservedWindows(
      update.windows.map(\.id),
      floatingIDs: Set(
        update.windows.compactMap {
          WindowCapabilityPolicy.admission(for: $0.geometryCapabilities) == .floating ? $0.id : nil
        }),
      assignments: assignments,
      replacements: update.replacements,
      removedIDs: closedIDs.union(update.newlyUnmanagedWindowIDs),
      displayID: displayID
    )
    try requireCurrentSessionGeneration(sessionGeneration)
    try requireLifecycleRevision(expectedLifecycleRevision)
    try await workspaces.commit(mutation.workspaceState)
    try requireCurrentSessionGeneration(sessionGeneration)
    try requireLifecycleRevision(expectedLifecycleRevision)
    var evictedLifetimes = update.verifiedClosedLifetimes
    for lifetime in update.verifiedClosedLifetimes {
      managedOverrideLifetimes.remove(lifetime)
      if sessionWindows[lifetime.windowID]?.pid == lifetime.pid {
        sessionWindows.removeValue(forKey: lifetime.windowID)
      }
      windowMinimumSizes.removeValue(forKey: lifetime.windowID)
      observerGeometryReliability.clear(windowID: lifetime.windowID)
    }
    for lifetime in update.newlyUnmanagedLifetimes {
      let id = lifetime.windowID
      if sessionWindows[id]?.pid == lifetime.pid {
        sessionWindows.removeValue(forKey: id)
        managedOverrideLifetimes.remove(lifetime)
        windowMinimumSizes.removeValue(forKey: id)
        observerGeometryReliability.clear(windowID: id)
      }
      evictedLifetimes.insert(lifetime)
    }
    retainSessionWindows(update.windows)
    await geometry.evict(lifetimes: evictedLifetimes)
    try requireCurrentSessionGeneration(sessionGeneration)
    try requireLifecycleRevision(expectedLifecycleRevision)
    if !mutation.modifiedWorkspaces.isEmpty {
      internalErrorReporter?(
        "membership committed: modified=\(mutation.modifiedWorkspaces.sorted()) memberships=\(membershipSummary(mutation.workspaceState))"
      )
    }
    if !closedIDs.isEmpty {
      await publishSessionEvent(
        .windowClosed,
        data: .object(["window_ids": .array(closedIDs.sorted().map(JSONValue.string))]),
        sessionGeneration: sessionGeneration)
      try requireCurrentSessionGeneration(sessionGeneration)
      try requireLifecycleRevision(expectedLifecycleRevision)
    }
    for name in mutation.modifiedWorkspaces
    where mutation.workspaceState[workspace: name]?.visible == true {
      _ = await tileWorkspaceForObserver(
        mutation.workspaceState, named: name, inventory: inventory, forceStack: false,
        sessionGeneration: sessionGeneration)
      try requireCurrentSessionGeneration(sessionGeneration)
      try requireLifecycleRevision(expectedLifecycleRevision)
    }
    await publishWorkspaceMutation(
      mutation, before: before, reason: .workspaceChanged, sessionGeneration: sessionGeneration)
    try requireCurrentSessionGeneration(sessionGeneration)
    try requireLifecycleRevision(expectedLifecycleRevision)
  }

  private func requireCurrentSessionGeneration(_ generation: UInt64) throws {
    guard generation == sessionTransitionGeneration else {
      throw DaemonLifecycleError.paused
    }
  }

  private func requireCurrentSessionGeneration(_ generation: UInt64?) throws {
    if let generation { try requireCurrentSessionGeneration(generation) }
  }

  private func requireLifecycleRevision(_ revision: UInt64?) throws {
    guard revision == nil || revision == lifecycleRevision else { throw StaleLifecycleProposal() }
  }

  private func commitLifecycle(
    _ proposed: ManagedWindowLifecycle, expectedRevision: UInt64
  ) throws {
    try requireLifecycleRevision(expectedRevision)
    lifecycle = proposed
    lifecycleRevision &+= 1
  }

  private func reportRecoveryMembership(
    _ stage: String, inventory: InventorySnapshot, state: WMWorkspace.WorkspaceState,
    update: WindowLifecycleUpdate
  ) {
    internalErrorReporter?(
      "session recovery \(stage): observed=\(inventory.windows.filter { $0.classification == .normal }.map(\.id).sorted()) managed=\(update.windows.map(\.id).sorted()) memberships=\(membershipSummary(state)) closed=\(update.verifiedClosedLifetimes.map(\.windowID).sorted()) replacements=\(update.replacements.sorted { $0.key < $1.key })"
    )
  }

  private func membershipSummary(_ state: WMWorkspace.WorkspaceState) -> [String] {
    state.workspaces.sorted { $0.name < $1.name }.map { "\($0.name)=\($0.windowIDs.sorted())" }
  }

  func connected(clientID: UUID) async -> [String] {
    guard let committed = try? await state.state() else { return [] }
    let health = protocolHealth(committed.snapshot.health)
    return [
      encode(
        .welcome(
          .init(
            sessionId: sessionID, daemonVersion: version, currentSequence: committed.sequence,
            stateVersion: committed.stateVersion, health: health)))
    ]
  }

  func handle(text: String, clientID: UUID) async -> [String] {
    let data = Data(text.utf8)
    guard let message = try? ProtocolCodec.decode(ClientMessage.self, from: data) else {
      return [
        encode(
          .response(
            .init(
              requestId: requestID(in: data) ?? "",
              error: .init(
                code: .invalidMessage, message: "invalid client message", retryable: false),
              stateVersion: await currentVersion())))
      ]
    }
    switch message {
    case .request(let request):
      return [encode(await route(request))]
    case .subscribe(let request):
      return await subscribe(request, clientID: clientID)
    case .unsubscribe(let request):
      return await unsubscribe(request, clientID: clientID)
    }
  }

  func disconnected(clientID: UUID) async {
    for (id, task) in subscriptions.removeValue(forKey: clientID) ?? [:] {
      task.cancel()
      try? await state.unsubscribe(id: key(clientID, id))
    }
    workspaceSubscriptions.removeValue(forKey: clientID)
    stateSnapshotSubscriptions.removeValue(forKey: clientID)
  }

  private func subscribe(_ request: Subscribe, clientID: UUID) async -> [String] {
    if request.topics.contains(.stateSnapshot) {
      guard request.topics.allSatisfy({ $0 == .stateSnapshot }) else {
        return [
          await errorResponse(
            request.requestId, .invalidParams, "state snapshot cannot be combined with other topics"
          )
        ]
      }
      guard request.afterSequence == nil else {
        return [
          await errorResponse(
            request.requestId, .replayUnavailable, "state snapshot replay is unavailable")
        ]
      }
      stateSnapshotSubscriptions[clientID, default: [:]][request.subscriptionId] = request.detail
      let response = encode(
        ServerMessage.response(
          .init(
            requestId: request.requestId,
            result: .object(["subscription_id": .string(request.subscriptionId)]),
            stateVersion: await currentVersion()
          )))
      return [response, await stateSnapshotEvent(detail: request.detail)]
    }
    let daemonTopics = Set(request.topics.filter(\.isDaemonEvent))
    if !daemonTopics.isEmpty {
      guard daemonTopics.count == Set(request.topics).count else {
        return [
          await errorResponse(
            request.requestId, .invalidParams, "daemon and inventory topics cannot be combined")
        ]
      }
      guard request.afterSequence == nil else {
        return [
          await errorResponse(
            request.requestId, .replayUnavailable, "daemon event replay is unavailable")
        ]
      }
      workspaceSubscriptions[clientID, default: [:]][request.subscriptionId] = .init(
        topics: daemonTopics,
        projection: request.projection
      )
      let response = encode(
        ServerMessage.response(
          .init(
            requestId: request.requestId,
            result: .object(["subscription_id": .string(request.subscriptionId)]),
            stateVersion: await currentVersion()
          )))
      if daemonTopics.allSatisfy(\.hasWorkspaceSnapshot) {
        return [
          response,
          await workspaceSnapshotEvent(
            topic: daemonTopics.sorted(by: { $0.rawValue < $1.rawValue }).first!),
        ]
      }
      return [response]
    }
    do {
      let topics = Set(request.topics.compactMap { InventoryTopic(rawValue: $0.rawValue) })
      let subscription = try await state.subscribe(
        id: key(clientID, request.subscriptionId), topics: topics,
        projection: EventProjection(rawValue: request.projection.rawValue)!,
        afterSequence: request.afterSequence
      )
      let version = await currentVersion()
      let response = encode(
        ServerMessage.response(
          .init(
            requestId: request.requestId,
            result: .object(["subscription_id": .string(request.subscriptionId)]),
            stateVersion: version)))
      let sender = sender
      let task = Task {
        await Task.yield()
        for await item in subscription.stream {
          guard !Task.isCancelled else { return }
          sender?(encode(subscriptionMessage(item, id: request.subscriptionId)), clientID)
        }
      }
      subscriptions[clientID, default: [:]][request.subscriptionId]?.cancel()
      subscriptions[clientID, default: [:]][request.subscriptionId] = task
      return [response]
    } catch {
      return [await errorResponse(request.requestId, .notReady, "inventory is not ready")]
    }
  }

  private func unsubscribe(_ request: Unsubscribe, clientID: UUID) async -> [String] {
    if stateSnapshotSubscriptions[clientID]?.removeValue(forKey: request.subscriptionId) != nil {
      return [
        encode(
          .response(
            .init(
              requestId: request.requestId, result: .object([:]),
              stateVersion: await currentVersion())))
      ]
    }
    if workspaceSubscriptions[clientID]?.removeValue(forKey: request.subscriptionId) != nil {
      return [
        encode(
          .response(
            .init(
              requestId: request.requestId, result: .object([:]),
              stateVersion: await currentVersion())))
      ]
    }
    guard let task = subscriptions[clientID]?.removeValue(forKey: request.subscriptionId) else {
      return [
        await errorResponse(
          request.requestId, .subscriptionNotFound,
          "unknown subscription: \(request.subscriptionId)")
      ]
    }
    task.cancel()
    try? await state.unsubscribe(id: key(clientID, request.subscriptionId))
    return [
      encode(
        .response(
          .init(
            requestId: request.requestId, result: .object([:]), stateVersion: await currentVersion()
          )))
    ]
  }

  private func coreResponse(_ response: CoreResponse) -> ServerMessage {
    if response.ok, let data = response.result,
      let result = try? ProtocolCodec.decode(JSONValue.self, from: data)
    {
      return .response(
        .init(requestId: response.requestID, result: result, stateVersion: response.stateVersion))
    }
    let code = ErrorCode(rawValue: response.error?.code ?? "internal_error") ?? .internalError
    return .response(
      .init(
        requestId: response.requestID,
        error: .init(
          code: code, message: response.error?.message ?? "internal error",
          retryable: response.error?.retryable ?? false), stateVersion: response.stateVersion))
  }

  private func route(_ request: Request) async -> ServerMessage {
    if request.method == .geometryCapabilityProbe, daemonLifecycle.isPaused {
      return .response(
        .init(
          requestId: request.requestId,
          error: .init(code: .paused, message: "daemon is paused", retryable: true),
          stateVersion: await currentVersion()))
    }
    if request.method.isSerializedMutation && request.method != .daemonPause
      && request.method != .daemonResume
    {
      do {
        let mode = try returnMode(request.params["return_mode"])
        let key = request.method.isIdempotent ? canonicalKey(request) : nil
        let commandRequest = Request(
          requestId: request.requestId, method: request.method,
          params: request.params.filter { $0.key != "return_mode" }
        )
        let receipt = try await transactions.submit(
          .init(
            name: request.method.rawValue, idempotencyKey: key,
            authorize: { [weak self] in await self?.mutationBarrier() },
            operate: { [weak self] in
              guard let self else { throw CancellationError() }
              let response = await self.routeDirect(commandRequest)
              guard case .response(let value) = response else { throw CancellationError() }
              if let error = value.error { throw TransactionFailure(error) }
              return .init(result: value.result ?? .null, committedStateVersion: value.stateVersion)
            }, escalate: { [weak self] in try await self?.fullReconciliation() }), mode: mode)
        return .response(
          .init(
            requestId: request.requestId, result: json(receipt),
            stateVersion: await currentVersion()))
      } catch TransactionCoordinatorError.queueFull {
        return .response(
          .init(
            requestId: request.requestId,
            error: .init(code: .notReady, message: "transaction queue is full", retryable: true),
            stateVersion: await currentVersion()))
      } catch let error as WorkspaceRequestError {
        return .response(
          .init(
            requestId: request.requestId,
            error: .init(code: error.code, message: error.message, retryable: false),
            stateVersion: await currentVersion()))
      } catch {
        return .response(
          .init(
            requestId: request.requestId,
            error: .init(
              code: .internalError, message: "transaction submission failed", retryable: false),
            stateVersion: await currentVersion()))
      }
    }
    return await routeDirect(request)
  }

  private func routeDirect(_ request: Request) async -> ServerMessage {
    do {
      if request.method == .inventoryRefresh {
        _ = await router.route(.init(requestID: request.requestId, method: request.method.rawValue))
      }
      var committed = try await state.state()
      var snapshot = committed.snapshot
      snapshot.inventory = await geometryProfiles.mergingCapabilities(into: snapshot.inventory)
      snapshot.windows = snapshot.inventory.windows.map { .init(id: $0.id, value: $0) }
      retainSessionWindows(snapshot.inventory.windows)
      await geometry.reconcile(windows: snapshot.inventory.windows)
      let result: JSONValue
      if request.method.isSerializedMutation && request.method != .daemonPause
        && request.method != .daemonResume
      {
        try daemonLifecycle.requireMutationAllowed()
      }
      switch request.method {
      case .stateGet:
        var value = userState(committed)
        if case .object(var object) = value {
          object["transactions"] = json(await transactions.metadata())
          object["workspace_state"] = workspaceList(await workspaces.snapshot())
          value = .object(object)
        }
        result = value
      case .stateObserved: result = json(snapshot.inventory)
      case .healthGet: result = json(protocolHealth(snapshot.health))
      case .displayList:
        result = displayList(
          snapshot.inventory.displays, verbose: request.params["verbose"] == .bool(true))
      case .windowList: result = json(["windows": snapshot.inventory.windows])
      case .windowFocus, .windowMove:
        let params = try decodeParams(WindowDirectionalParams.self, from: .object(request.params))
        let before = await workspaces.snapshot()
        guard let name = before.focusedWorkspaceName,
          let workspace = before[workspace: name]
        else { throw WorkspaceMutationError.focusedWorkspaceRequired }
        guard
          let workArea = DisplayTopologySnapshot(displays: snapshot.inventory.displays)
            .axWorkAreas[workspace.displayID]
        else { throw WorkspaceRequestError.displayRequired }
        let bounds = WorkspaceLayoutRect(
          x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height)
        let direction = workspaceDirection(params.direction)
        let directional =
          try request.method == .windowFocus
          ? await workspaces.previewFocusWindow(direction: direction, bounds: bounds)
          : await workspaces.previewMoveWindow(direction: direction, bounds: bounds)
        var mutation = directional.result
        guard let focusedAfter = mutation.workspaceState[workspace: name]?.focusedWindowID else {
          throw WorkspaceMutationError.focusedWindowRequired(name)
        }
        let target = request.method == .windowFocus ? focusedAfter : directional.sourceWindowID
        if request.method == .windowMove {
          try await tileWorkspace(
            mutation.workspaceState, named: name, inventory: snapshot.inventory)
        }
        try await focusWindow(resolveWindow(target, in: snapshot.inventory.windows))
        mutation.effectStatus = .verified
        try await workspaces.commitFocus(mutation)
        await publishWorkspaceMutation(
          mutation, before: before,
          reason: request.method == .windowFocus ? .workspaceFocused : .workspaceChanged)
        result = json(
          WindowDirectionalResult(
            workspace: name, windowId: directional.sourceWindowID,
            targetWindowId: directional.targetWindowID, direction: params.direction,
            effectStatus: .verified
          ))
      case .windowManage, .windowUnmanage:
        let params = try decodeParams(WindowManagementParams.self, from: .object(request.params))
        guard
          let window =
            snapshot.inventory.windows.first(where: { $0.id == params.windowID })
            ?? sessionWindows[params.windowID]
        else {
          throw WorkspaceRequestError.windowNotFound(params.windowID)
        }
        let override: WindowManagementOverride =
          request.method == .windowManage ? .managed : .unmanaged
        let revision = lifecycleRevision
        var proposedLifecycle = lifecycle
        guard
          let update = proposedLifecycle.setOverride(
            override, for: params.windowID, pid: window.pid)
        else {
          throw WorkspaceRequestError.windowNotFound(params.windowID)
        }
        var proposedOverrides = managedOverrideLifetimes
        let lifetime = WindowLifetime(windowID: params.windowID, pid: window.pid)
        if override == .managed {
          proposedOverrides.insert(lifetime)
        } else {
          proposedOverrides.remove(lifetime)
        }
        let generation = sessionTransitionGeneration
        let displayID = try resolveDisplay(
          nil, inventory: snapshot.inventory, workspaceState: await workspaces.snapshot())
        try await applyLifecycleUpdate(
          update, inventory: snapshot.inventory, displayID: displayID,
          sessionGeneration: generation, expectedLifecycleRevision: revision)
        try requireCurrentSessionGeneration(generation)
        try commitLifecycle(proposedLifecycle, expectedRevision: revision)
        managedOverrideLifetimes = proposedOverrides
        result = .object([
          "window_id": .string(params.windowID),
          "management": .string(request.method == .windowManage ? "managed" : "unmanaged"),
        ])
      case .observeWindow:
        committed = try await state.refresh()
        retainSessionWindows(committed.snapshot.inventory.windows)
        result = observeWindows(
          params: request.params, inventory: committed.snapshot.inventory,
          workspaceState: await workspaces.snapshot())
      case .observeWorkspace:
        let params = try decodeParams(ObserveWorkspaceParams.self, from: .object(request.params))
        committed = try await state.refresh()
        retainSessionWindows(committed.snapshot.inventory.windows)
        result = try observeWorkspace(
          named: params.name,
          inventory: committed.snapshot.inventory,
          workspaceState: await workspaces.snapshot()
        )
      case .windowFrameGet:
        let params = try decodeParams(WindowFrameGetParams.self, from: .object(request.params))
        let window = try resolveWindow(params.windowID, in: snapshot.inventory.windows)
        result = json(try await geometry.get(window: window))
      case .windowFrameSet:
        let params = try decodeParams(WindowFrameSetParams.self, from: .object(request.params))
        var window = try resolveWindow(params.windowID, in: snapshot.inventory.windows)
        let setResult = try await geometry.set(window: window, params: params)
        window.frame = InventoryRect(
          x: setResult.observedFrame.x,
          y: setResult.observedFrame.y,
          width: setResult.observedFrame.width,
          height: setResult.observedFrame.height
        )
        committed = try await state.update(window: .init(id: window.id, value: window))
        result = json(setResult)
      case .debugAXFrameGet:
        let params = try decodeParams(WindowFrameGetParams.self, from: .object(request.params))
        let window = try resolveWindow(params.windowID, in: snapshot.inventory.windows)
        let frame = try await rawGeometry.rawFrame(window)
        result = json(
          WindowFrameGetResult(windowID: window.id, frame: frame.protocolFrame, observedAt: Date()))
      case .debugAXFrameSet:
        let params = try decodeParams(DebugAXFrameSetParams.self, from: .object(request.params))
        guard (0...10_000).contains(params.settleMilliseconds), params.frame.width > 0,
          params.frame.height > 0
        else { throw WorkspaceRequestError.invalidDebugRequest }
        let window = try resolveWindow(params.windowID, in: snapshot.inventory.windows)
        let requested = InventoryRect(
          x: params.frame.x, y: params.frame.y, width: params.frame.width,
          height: params.frame.height
        )
        let observed = try await rawGeometry.rawSetFrame(
          requested, of: window, order: params.order, settleMilliseconds: params.settleMilliseconds
        )
        result = .object([
          "window_id": .string(window.id), "requested_frame": json(params.frame),
          "observed_frame": json(observed.protocolFrame), "order": .string(params.order.rawValue),
        ])
      case .debugAXFocus:
        let params = try decodeParams(WindowFrameGetParams.self, from: .object(request.params))
        let window = try resolveWindow(params.windowID, in: snapshot.inventory.windows)
        let handle = try await rawGeometry.resolve(window)
        try await rawGeometry.focus(handle)
        result = .object([
          "window_id": .string(window.id),
          "focused": .bool(try await rawGeometry.isFocused(handle)),
        ])
      case .geometryCapabilityProbe:
        let params = try decodeParams(
          GeometryCapabilityProbeParams.self, from: .object(request.params))
        let window = try resolveWindow(params.windowID, in: snapshot.inventory.windows)
        let generation = sessionTransitionGeneration
        let probe = try await geometry.probeCapabilities(window: window)
        try requireCurrentSessionGeneration(generation)
        guard probe.restoration.verified else {
          result = json(probe)
          break
        }
        let capabilities = GeometryCapabilities(position: probe.position, size: probe.size)
        try await geometryProfiles.recordCapabilities(capabilities, for: window)
        try requireCurrentSessionGeneration(generation)
        var inventory = snapshot.inventory
        if let index = inventory.windows.firstIndex(where: {
          $0.id == window.id && $0.pid == window.pid
        }) {
          inventory.windows[index].geometryCapabilities = WindowCapabilityPolicy.merging(
            capabilities, into: inventory.windows[index].geometryCapabilities)
        }
        let displayID = try resolveDisplay(
          nil, inventory: inventory, workspaceState: await workspaces.snapshot())
        try await reconcileObservedWindowsAuthorized(inventory, displayID: displayID)
        try requireCurrentSessionGeneration(generation)
        result = json(probe)
      case .debugEngineGet:
        result = debugEngineState()
      case .debugEngineSet:
        guard case .bool(let enabled)? = request.params["automatic_reconciliation"] else {
          throw WorkspaceRequestError.invalidDebugRequest
        }
        automaticReconciliationEnabled = enabled
        result = debugEngineState()
      case .diagnosticsInventory:
        result = .object([
          "inventory": json(snapshot.inventory),
          "layout": .object(
            Dictionary(
              uniqueKeysWithValues: workspaceLayoutResults.map {
                ($0.key, layoutResultJSON($0.value))
              })),
        ])
      case .inventoryRefresh:
        let inventory = committed.snapshot.inventory
        if let displayID =
          (inventory.displays.first(where: \.isPrimary) ?? inventory.displays.first)?.id
        {
          try await reconcileObservedWindows(inventory, displayID: displayID)
        }
        result = json(userState(committed))
      case .configurationValidate:
        let path = try configurationPath(request.params)
        _ = try ConfigurationParser.parse(String(contentsOfFile: path, encoding: .utf8))
        result = .object(["valid": .bool(true), "path": .string(path)])
      case .configurationReload:
        let path = try configurationPath(request.params)
        let mode = try configurationMode(request.params["mode"])
        let trigger = try configurationTrigger(request.params["trigger"])
        do {
          let source = try String(contentsOfFile: path, encoding: .utf8)
          let candidate = try ConfigurationParser.parse(source)
          if trigger == .hotload, !candidate.hotload {
            result = configurationResult(await configuration.snapshot())
            break
          }
          try await applyConfiguration(candidate, inventory: snapshot.inventory)
          let loaded = try await configuration.reload(source: source, trigger: trigger, mode: mode)
          await publishConfigurationEvent(loaded.events.last!, degraded: loaded.degraded)
          result = configurationResult(loaded)
        } catch {
          let loaded = await configuration.snapshot()
          if let event = loaded.events.last {
            await publishConfigurationEvent(event, degraded: loaded.degraded)
          }
          throw error
        }
      case .daemonPing:
        result = .object([
          "session_id": .string(sessionID), "daemon_version": .string(version),
          "ready": .bool(true), "paused": .bool(daemonLifecycle.isPaused),
          "current_sequence": .number(Double(committed.sequence)),
          "state_version": .number(Double(committed.stateVersion)),
        ])
      case .daemonPause:
        if daemonLifecycle.isTerminating { throw DaemonLifecycleError.terminating }
        if request.params["toggle"] == .bool(true), daemonLifecycle.isPaused {
          result = try await resumeDaemon()
        } else {
          _ = daemonLifecycle.pause()
          result = .object(["paused": .bool(true)])
        }
      case .daemonResume:
        result = try await resumeDaemon()
      case .daemonShutdown:
        daemonLifecycle.beginTermination()
        result = .object(["shutting_down": .bool(true)])
        shutdownRequest?()
      case .transactionGet:
        guard case .string(let id)? = request.params["transaction_id"] else {
          throw WorkspaceRequestError.transactionRequired
        }
        result = json(try await transactions.status(id))
      case .commandBatch:
        let batch = try decodeParams(BatchRequest.self, from: .object(request.params))
        guard !batch.commands.isEmpty, batch.commands.count <= 64,
          batch.commands.allSatisfy({ $0.method.isMutation && $0.method != .commandBatch })
        else {
          throw WorkspaceRequestError.invalidBatch
        }
        var values: [JSONValue] = []
        var stoppedAt: Int?
        for (index, command) in batch.commands.enumerated() {
          let response = await routeDirect(
            .init(requestId: request.requestId, method: command.method, params: command.params))
          guard case .response(let value) = response else {
            stoppedAt = index
            break
          }
          if let error = value.error {
            values.append(.object(["ok": .bool(false), "error": json(error)]))
            stoppedAt = index
            break
          }
          values.append(.object(["ok": .bool(true), "result": value.result ?? .null]))
        }
        result = json(BatchResult(results: values, stoppedAt: stoppedAt))
      case .workspaceList:
        result = workspaceList(await workspaces.snapshot())
      case .workspaceFocus:
        let params = try decodeParams(WorkspaceFocusParams.self, from: .object(request.params))
        let before = await workspaces.snapshot()
        func reconcileFocus(_ inventory: InventorySnapshot) async throws
          -> (WMWorkspace.WorkspaceMutationResult, Set<WindowLifetime>)
        {
          let displayID = try resolveDisplay(
            params.displayId, selector: params.displaySelector,
            inventory: inventory, workspaceState: before
          )
          var reconciled = try await workspaces.previewFocus(
            name: params.name, displayID: displayID)
          reconciled.workspaceState = StartupIntentAudit.candidate(
            state: reconciled.workspaceState, inventory: inventory)
          let pending = try await reconcileWorkspaceFocus(
            before: before, after: &reconciled.workspaceState,
            name: params.name, inventory: inventory)
          return (reconciled, pending)
        }
        let reconciled: WMWorkspace.WorkspaceMutationResult
        let pending: Set<WindowLifetime>
        do {
          (reconciled, pending) = try await reconcileFocus(snapshot.inventory)
        } catch let failure as WindowGeometryFailure where failure.code == .inventoryStale {
          committed = try await state.refresh()
          (reconciled, pending) = try await reconcileFocus(committed.snapshot.inventory)
        }
        try await commitFocusAndSchedule(reconciled, pending: pending)
        await publishWorkspaceMutation(reconciled, before: before, reason: .workspaceFocused)
        result = workspaceMutation(reconciled)
      case .workspaceMoveWindow:
        let params = try decodeParams(WorkspaceMoveWindowParams.self, from: .object(request.params))
        if params.windowIds.isEmpty { committed = try await state.refresh() }
        let currentSnapshot = committed.snapshot
        var ids = params.windowIds
        if ids.isEmpty, let focused = currentSnapshot.focusedWindowID { ids = [focused] }
        guard !ids.isEmpty else { throw WorkspaceRequestError.windowRequired }
        try validateWindows(ids, inventory: currentSnapshot.inventory)
        let before = await workspaces.snapshot()
        let liveDisplayID = ids.compactMap { id in
          currentSnapshot.inventory.windows.first { $0.id == id }?.displayID
        }.first
        var mutation = try await workspaces.previewMoveWindows(
          ids, to: params.workspace, displayID: liveDisplayID)
        let pendingIDs = Set(
          ids.filter { id in
            currentSnapshot.inventory.windows.first(where: { $0.id == id })?.management == .pending
          })
        var parkingPending: Set<WindowLifetime> = []
        if pendingIDs.isEmpty {
          parkingPending = try await reconcileWorkspaceFocus(
            before: before, after: &mutation.workspaceState, name: params.workspace,
            inventory: currentSnapshot.inventory)
          mutation.effectStatus = .verified
        } else {
          mutation.effectStatus = .simulated
        }
        try await commitFocusAndSchedule(mutation, pending: parkingPending)
        await publishWorkspaceMutation(mutation, before: before, reason: .workspaceFocused)
        result = workspaceMutation(mutation)
      case .workspaceMoveWindowBulk:
        let params = try decodeParams(WorkspaceMoveWindowParams.self, from: .object(request.params))
        let ids = Array(Set(params.windowIds)).sorted()
        guard !ids.isEmpty, ids.count <= 128,
          ids.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 256 })
        else {
          throw WorkspaceRequestError.invalidBulk
        }
        try validateWindows(ids, inventory: snapshot.inventory)
        let before = await workspaces.snapshot()
        let windowsByID = Dictionary(
          uniqueKeysWithValues: snapshot.inventory.windows.map { ($0.id, $0) })
        let displayID = ids.compactMap { windowsByID[$0]?.displayID }.first
        let mutation = try await workspaces.previewMoveWindows(
          ids, to: params.workspace, displayID: displayID)
        try await workspaces.commitFocus(mutation)
        var failures: [BulkItemFailure] = []
        do {
          var reconciled = mutation.workspaceState
          let parkingPending = try await reconcileWorkspaceFocus(
            before: before, after: &reconciled, name: params.workspace,
            inventory: snapshot.inventory)
          pendingParking.formUnion(parkingPending)
          scheduleParking()
        } catch let failure as WindowGeometryFailure {
          let itemFailure = TransactionFailure(
            code: ErrorCode(rawValue: failure.code.rawValue) ?? .internalError,
            message: failure.message, retryable: failure.code == .inventoryStale
          )
          failures = ids.map { .init(windowId: $0, failure: itemFailure) }
        } catch {
          failures = ids.map {
            .init(
              windowId: $0,
              failure: .init(
                code: .internalError, message: "window operation failed", retryable: true))
          }
        }
        await publishWorkspaceMutation(mutation, before: before, reason: .workspaceFocused)
        result = json(BulkTransactionResult(windowIds: ids, failures: failures))
      case .workspaceMoveDisplay:
        let params = try decodeParams(
          WorkspaceMoveDisplayParams.self, from: .object(request.params))
        let before = await workspaces.snapshot()
        let workspaceName = params.workspace ?? before.focusedWorkspaceName
        guard let workspaceName, let workspace = before[workspace: workspaceName] else {
          throw WorkspaceRequestError.workspaceRequired
        }
        let displayID =
          params.next
          ? try nextDisplay(after: workspace.displayID, displays: snapshot.inventory.displays)
          : try resolveDisplay(
            params.displayId, selector: params.displaySelector,
            inventory: snapshot.inventory, workspaceState: before
          )
        var mutation = try await workspaces.previewMoveWorkspace(workspaceName, to: displayID)
        if let currentConfiguration = await configuration.snapshot().configuration {
          mutation.workspaceState = await workspaces.configuredState(
            currentConfiguration, defaultDisplayID: displayID,
            displays: snapshot.inventory.displays,
            state: mutation.workspaceState
          )
        }
        let parkingPending = try await reconcileWorkspaceFocus(
          before: before, after: &mutation.workspaceState, name: workspaceName,
          inventory: snapshot.inventory)
        try await commitFocusAndSchedule(mutation, pending: parkingPending)
        await publishWorkspaceMutation(mutation, before: before, reason: .workspaceDisplayChanged)
        result = workspaceMutation(mutation)
      case .workspaceSetMode:
        let params = try decodeParams(WorkspaceSetModeParams.self, from: .object(request.params))
        let mode: WMWorkspace.WorkspaceMode = params.mode == .bsp ? .bsp : .floating
        let before = await workspaces.snapshot()
        var mutation = try await workspaces.previewSetMode(params.workspace, mode: mode)
        var parkingPending: Set<WindowLifetime> = []
        if mutation.workspaceState.focusedWorkspaceName == params.workspace {
          parkingPending = try await reconcileWorkspaceFocus(
            before: before, after: &mutation.workspaceState, name: params.workspace,
            inventory: snapshot.inventory)
        }
        try await commitFocusAndSchedule(mutation, pending: parkingPending)
        await publishWorkspaceMutation(mutation, before: before, reason: .workspaceModeChanged)
        result = workspaceMutation(mutation)
      case .layoutPolicySet:
        let params = try decodeParams(
          LayoutPolicySetParams.self, from: .object(request.params))
        let policy = workspacePolicies(params.policy)
        try WMWorkspace.LayoutPolicy.validate(policy)
        if let name = params.workspace {
          guard (await workspaces.snapshot())[workspace: name] != nil else {
            throw WorkspaceMutationError.workspaceNotFound(name)
          }
          workspaceLayoutPolicies[name] = policy
          result = .object([
            "layout_policy": json(policy.map(\.rawValue)), "workspace": .string(name),
          ])
        } else {
          layoutPolicy = policy
          result = .object(["layout_policy": json(policy.map(\.rawValue)), "workspace": .null])
        }
      case .geometryPolicySet:
        let params = try decodeParams(GeometryPolicySetParams.self, from: .object(request.params))
        guard params.maxGeometryRetries != nil || params.geometryProfileMode != nil,
          params.maxGeometryRetries.map({ (1...5).contains($0) }) != false
        else {
          throw WorkspaceRequestError.invalidGeometryPolicy
        }
        let mode = params.geometryProfileMode.map(workspaceProfileMode)
        if let name = params.workspace {
          guard (await workspaces.snapshot())[workspace: name] != nil else {
            throw WorkspaceMutationError.workspaceNotFound(name)
          }
          var policy = workspaceGeometryPolicies[name] ?? (nil, nil)
          policy.retries = params.maxGeometryRetries ?? policy.retries
          policy.mode = mode ?? policy.mode
          workspaceGeometryPolicies[name] = policy
          result = geometryPolicyJSON(
            workspace: name, retries: policy.retries ?? maxGeometryRetries,
            mode: policy.mode ?? geometryProfileMode)
        } else {
          maxGeometryRetries = params.maxGeometryRetries ?? maxGeometryRetries
          geometryProfileMode = mode ?? geometryProfileMode
          result = geometryPolicyJSON(
            workspace: nil, retries: maxGeometryRetries, mode: geometryProfileMode)
        }
      }
      return .response(
        .init(requestId: request.requestId, result: result, stateVersion: committed.stateVersion))
    } catch let failure as WindowGeometryFailure {
      return .response(
        .init(
          requestId: request.requestId,
          error: .init(
            code: ErrorCode(rawValue: failure.code.rawValue) ?? .internalError,
            message: failure.message,
            retryable: failure.code == .inventoryStale,
            details: failure.observedFrame.map { ["observed_frame": json($0)] } ?? [:]
          ),
          stateVersion: await currentVersion()
        ))
    } catch let error as WorkspaceMutationError {
      return .response(
        .init(
          requestId: request.requestId, error: workspaceError(error),
          stateVersion: await currentVersion()))
    } catch let error as WorkspaceRequestError {
      return .response(
        .init(
          requestId: request.requestId,
          error: .init(code: error.code, message: error.message, retryable: false),
          stateVersion: await currentVersion()))
    } catch DaemonLifecycleError.paused {
      return .response(
        .init(
          requestId: request.requestId,
          error: .init(code: .paused, message: "daemon is paused", retryable: true),
          stateVersion: await currentVersion()))
    } catch DaemonLifecycleError.terminating {
      return .response(
        .init(
          requestId: request.requestId,
          error: .init(code: .notReady, message: "daemon is terminating", retryable: false),
          stateVersion: await currentVersion()))
    } catch DaemonLifecycleRequestError.permissionDenied {
      return .response(
        .init(
          requestId: request.requestId,
          error: .init(
            code: .permissionDenied, message: "required permissions are unavailable",
            retryable: true), stateVersion: await currentVersion()))
    } catch {
      return .response(
        .init(
          requestId: request.requestId,
          error: .init(code: .inventoryFailed, message: String(describing: error), retryable: true),
          stateVersion: await currentVersion()))
    }
  }

  private func resumeDaemon() async throws -> JSONValue {
    await transactions.beginRecovery(reason: "daemon resume reconciliation")
    do {
      let generation = sessionTransitionGeneration
      let committed = try await state.refresh()
      try requireCurrentSessionGeneration(generation)
      guard committed.snapshot.health.capabilities["accessibility"] as? Bool == true,
        committed.snapshot.health.capabilities["core_graphics"] as? Bool == true
      else { throw DaemonLifecycleRequestError.permissionDenied }
      let inventory = committed.snapshot.inventory
      try await auditCommittedIntent(inventory)
      guard
        let displayID =
          (inventory.displays.first(where: \.isPrimary) ?? inventory.displays.first)?.id
      else { throw WorkspaceRequestError.displayRequired }
      let revision = lifecycleRevision
      var proposedLifecycle = lifecycle
      let update = proposedLifecycle.reconcile(inventory)
      try await applyLifecycleUpdate(
        update, inventory: inventory, displayID: displayID, sessionGeneration: generation,
        expectedLifecycleRevision: revision)
      try await reconcileExternalFocus(
        windowID: committed.snapshot.focusedWindowID, frontmostPID: nil, inventory: inventory,
        allowWhilePaused: true)
      try requireCurrentSessionGeneration(generation)
      try commitLifecycle(proposedLifecycle, expectedRevision: revision)
      _ = daemonLifecycle.resume()
      await transactions.endRecovery(success: true)
      return .object(["paused": .bool(false), "reconciled": .bool(true)])
    } catch {
      await transactions.endRecovery(
        success: false,
        failure: .init(code: .notReady, message: "resume reconciliation failed", retryable: true))
      throw error
    }
  }

  private func userState(_ committed: CommittedState<PrototypeSnapshot>) -> JSONValue {
    .object([
      "state_version": .number(Double(committed.stateVersion)),
      "sequence": .number(Double(committed.sequence)),
      "health": json(protocolHealth(committed.snapshot.health)),
      "focused_window_id": committed.snapshot.focusedWindowID.map(JSONValue.string) ?? .null,
      "displays": json(committed.snapshot.inventory.displays),
      "windows": json(committed.snapshot.inventory.windows),
    ])
  }

  private func debugEngineState() -> JSONValue {
    .object(["automatic_reconciliation": .bool(automaticReconciliationEnabled)])
  }

  private func subscriptionMessage(_ message: SubscriptionMessage<PrototypeSnapshot>, id: String)
    -> ServerMessage
  {
    switch message {
    case .resync(let value):
      return .resyncRequired(
        .init(
          subscriptionId: id, requestedAfterSequence: value.requestedAfterSequence,
          oldestAvailableSequence: value.oldestAvailableSequence ?? value.currentSequence,
          currentSequence: value.currentSequence, stateVersion: value.stateVersion))
    case .event(let projected):
      switch projected {
      case .delta(let event): return eventMessage(event)
      case .snapshot(let topic, let state):
        return .event(
          .init(
            sequence: state.sequence, stateVersion: state.stateVersion,
            timestamp: state.committedAt, topic: EventTopic(rawValue: topic.rawValue)!,
            data: json(state.snapshot)))
      case .invalidation(let topic, let sequence, let version):
        return .event(
          .init(
            sequence: sequence, stateVersion: version, timestamp: Date(),
            topic: EventTopic(rawValue: topic.rawValue)!,
            data: .object([
              "topic": .string(topic.rawValue), "state_version": .number(Double(version)),
            ])))
      }
    }
  }

  private func eventMessage(_ event: InventoryEvent<PrototypeSnapshot>) -> ServerMessage {
    let data: JSONValue
    switch event.data {
    case .windows(let delta):
      data = json(
        WindowDeltaPayload(
          added: delta.added.map(\.value), updated: delta.updated.map(\.value),
          removed: delta.removed.map(\.id)))
    case .displays(let delta):
      data = json(
        DisplayDeltaPayload(
          added: delta.added.map(\.value), updated: delta.updated.map(\.value),
          removed: delta.removed.map(\.id)))
    case .health(let health): data = json(protocolHealth(health))
    case .refreshed: data = .object([:])
    }
    return .event(
      .init(
        sequence: event.sequence, stateVersion: event.stateVersion, timestamp: event.timestamp,
        topic: EventTopic(rawValue: event.topic.rawValue)!, data: data))
  }

  func publishStateSnapshot() async {
    guard stateSnapshotSubscriptions.values.contains(where: { !$0.isEmpty }) else { return }
    for (clientID, subscriptions) in stateSnapshotSubscriptions {
      for detail in Set(subscriptions.values) {
        sender?(await stateSnapshotEvent(detail: detail), clientID)
      }
    }
  }

  private func stateSnapshotEvent(detail: SnapshotDetail) async -> String {
    let committed = try? await state.state()
    return encode(
      .event(
        .init(
          sequence: committed?.sequence ?? workspaceSequence,
          stateVersion: committed?.stateVersion ?? 0,
          timestamp: Date(),
          topic: .stateSnapshot,
          data: await stateSnapshot(committed, detail: detail)
        )))
  }

  private func stateSnapshot(
    _ committed: CommittedState<PrototypeSnapshot>?, detail: SnapshotDetail
  ) async -> JSONValue {
    guard let committed else { return .object(["displays": .array([]), "health": .null]) }
    let inventory = committed.snapshot.inventory
    let workspaceState = await workspaces.snapshot()
    let windows = Dictionary(uniqueKeysWithValues: inventory.windows.map { ($0.id, $0) })
    let displays = inventory.displays.map { display -> JSONValue in
      let workspaces = workspaceState.workspaces
        .filter { $0.displayID == display.id }
        .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
      var result: [String: JSONValue] = [
        "id": .string(display.id),
        "name": .string(display.name),
        "identifiers": json(display.identifiers),
        "health": healthyState,
        "workspaces": .array(
          workspaces.map { workspaceSnapshot($0, windows: windows, detail: detail) }),
      ]
      if detail == .verbose { result["details"] = json(display) }
      return .object(result)
    }
    return .object([
      "session_id": .string(sessionID),
      "state_version": .number(Double(committed.stateVersion)),
      "sequence": .number(Double(committed.sequence)),
      "focused_workspace_name": workspaceState.focusedWorkspaceName.map(JSONValue.string) ?? .null,
      "health": json(protocolHealth(committed.snapshot.health)),
      "displays": .array(displays),
    ])
  }

  private func workspaceSnapshot(
    _ workspace: WMWorkspace.Workspace,
    windows: [String: NormalizedWindow],
    detail: SnapshotDetail
  ) -> JSONValue {
    var result: [String: JSONValue] = [
      "name": .string(workspace.name),
      "focused": .bool(workspace.focused),
      "visible": .bool(workspace.visible),
      "health": workspaceHealth(workspace.name),
      "windows": .array(
        workspace.windowIDs.map {
          windowSnapshot(
            id: $0, window: windows[$0] ?? sessionWindows[$0],
            focused: workspace.focusedWindowID == $0,
            detail: detail
          )
        }),
    ]
    if detail == .verbose { result["details"] = workspaceJSON(workspace) }
    return .object(result)
  }

  private func windowSnapshot(
    id: String, window: NormalizedWindow?, focused: Bool, detail: SnapshotDetail
  ) -> JSONValue {
    guard let window else {
      return .object([
        "id": .string(id), "exe": .null, "app_name": .null, "focused": .bool(focused),
        "health": .object([
          "status": .string("unhealthy"),
          "issues": .array([.string("window is not currently observed")]),
        ]),
      ])
    }
    var result: [String: JSONValue] = [
      "id": .string(id),
      "exe": window.executablePath.map(JSONValue.string) ?? .null,
      "app_name": .string(window.appName),
      "focused": .bool(focused),
      "health": .object([
        "status": .string(window.health.rawValue),
        "issues": .array(window.healthIssues.map(JSONValue.string)),
      ]),
    ]
    if detail == .verbose { result["details"] = json(window) }
    return .object(result)
  }

  private var healthyState: JSONValue {
    .object(["status": .string("healthy"), "issues": .array([])])
  }

  private func protocolHealth(_ value: InventoryHealth) -> Health {
    return Health(
      status: HealthStatus(rawValue: value.status.rawValue)!, issues: value.issues,
      capabilities: .init(
        accessibility: value.capabilities["accessibility"] as? Bool ?? false,
        screenRecording: value.capabilities["core_graphics"] as? Bool ?? false,
        windowInventory: true, pointerWarp: nil))
  }

  private func workspaceHealth(_ name: String) -> JSONValue {
    guard workspaceLayoutResults[name]?.plan == .rejected else { return healthyState }
    return .object(["status": .string("unhealthy"), "issues": .array([.string("layout rejected")])])
  }

  private func layoutResultJSON(_ result: WorkspaceLayoutResult) -> JSONValue {
    .object([
      "requested_chain": json(result.requestedChain.map(\.rawValue)),
      "attempted_chain": json(result.attemptedChain.map(\.rawValue)),
      "effective_policy": .string(result.effectivePolicy.rawValue),
      "fallback_occurred": .bool(result.fallbackOccurred),
      "rejected": .bool(result.plan == .rejected),
    ])
  }

  private func currentVersion() async -> UInt64 { (try? await state.state().stateVersion) ?? 0 }
  private func configurationPath(_ params: [String: JSONValue]) throws -> String {
    guard case .string(let path)? = params["path"], !path.isEmpty else {
      throw WorkspaceRequestError.invalidConfigurationRequest
    }
    return path
  }
  private func configurationMode(_ value: JSONValue?) throws -> ReloadMode? {
    guard let value else { return nil }
    guard case .string(let raw) = value, let mode = ReloadMode(rawValue: raw) else {
      throw WorkspaceRequestError.invalidConfigurationRequest
    }
    return mode
  }
  private func configurationTrigger(_ value: JSONValue?) throws -> ReloadTrigger {
    guard let value else { return .explicit }
    guard case .string(let raw) = value, let trigger = ReloadTrigger(rawValue: raw) else {
      throw WorkspaceRequestError.invalidConfigurationRequest
    }
    return trigger
  }
  private func configurationResult(_ value: ConfigurationSnapshot) -> JSONValue {
    .object([
      "applied": .bool(true), "revision": .number(Double(value.revision)),
      "degraded": .bool(value.degraded),
    ])
  }
  private func publishConfigurationEvent(_ event: ConfigurationEvent, degraded: Bool) async {
    workspaceSequence += 1
    let payload: JSONValue = .object([
      "status": .string(event.kind == .applied ? "applied" : "rejected"),
      "trigger": .string(event.trigger.rawValue), "mode": .string(event.mode.rawValue),
      "message": event.message.map(JSONValue.string) ?? .null, "degraded": .bool(degraded),
    ])
    let version = await currentVersion()
    for (clientID, subscriptions) in workspaceSubscriptions {
      for subscription in subscriptions.values {
        if subscription.topics.contains(.configurationChanged) {
          sender?(
            encode(
              .event(
                .init(
                  sequence: workspaceSequence, stateVersion: version, timestamp: Date(),
                  topic: .configurationChanged, data: payload))), clientID)
        }
        if subscription.topics.contains(.healthChanged) {
          sender?(
            encode(
              .event(
                .init(
                  sequence: workspaceSequence, stateVersion: version, timestamp: Date(),
                  topic: .healthChanged, data: .object(["configuration_degraded": .bool(degraded)]))
              )), clientID)
        }
      }
    }
  }
  private func key(_ client: UUID, _ id: String) -> String { "\(client.uuidString):\(id)" }
  private func errorResponse(_ id: String, _ code: ErrorCode, _ message: String) async -> String {
    encode(
      .response(
        .init(
          requestId: id, error: .init(code: code, message: message, retryable: false),
          stateVersion: await currentVersion())))
  }
  private func encode(_ message: ServerMessage) -> String {
    String(data: (try? ProtocolCodec.encode(message)) ?? Data(), encoding: .utf8) ?? "{}"
  }
  private func json<T: Encodable>(_ value: T) -> JSONValue {
    (try? ProtocolCodec.decode(JSONValue.self, from: ProtocolCodec.encode(value))) ?? .null
  }
  private func returnMode(_ value: JSONValue?) throws -> TransactionReturnMode {
    guard let value else { return .completion }
    guard case .string(let raw) = value, let mode = TransactionReturnMode(rawValue: raw) else {
      throw WorkspaceRequestError.invalidReturnMode
    }
    return mode
  }
  private func mutationBarrier() -> TransactionFailure? {
    do {
      try daemonLifecycle.requireMutationAllowed()
      return nil
    } catch DaemonLifecycleError.paused {
      return .init(code: .paused, message: "daemon is paused", retryable: true)
    } catch { return .init(code: .notReady, message: "daemon is terminating") }
  }
  private func fullReconciliation() async throws {
    let committed = try await state.refresh()
    try await auditCommittedIntent(committed.snapshot.inventory)
  }
  private func submitInternal(
    name: String, idempotencyKey: String? = nil,
    operation: @escaping @Sendable () async throws -> Void
  ) async throws -> TransactionReceipt<JSONValue> {
    try await transactions.submit(
      .init(
        name: name, idempotencyKey: idempotencyKey,
        authorize: { [weak self] in await self?.mutationBarrier() },
        operate: { [weak self] in
          try await operation()
          return .init(
            result: .object([:]), committedStateVersion: await self?.currentVersion() ?? 0)
        }, escalate: { [weak self] in try await self?.fullReconciliation() },
        reportInternalError: { [weak self] error in
          await self?.reportInternalTransactionError(name: name, error: error)
        }
      ))
  }
  private func reportInternalTransactionError(name: String, error: String) {
    internalErrorReporter?("internal transaction \(name) failed: \(String(error.prefix(512)))")
  }
  private func canonicalKey(_ request: Request) -> String {
    "\(request.method.rawValue):\(JSONValue.object(request.params.filter { $0.key != "return_mode" }).canonicalForm)"
  }
  private func requestID(in data: Data?) -> String? {
    data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["request_id"]
      as? String
  }

  private func decodeParams<T: Decodable>(_ type: T.Type, from value: JSONValue) throws -> T {
    try ProtocolCodec.decode(type, from: ProtocolCodec.encode(value))
  }

  private func resolveWindow(_ id: String, in windows: [NormalizedWindow]) throws
    -> NormalizedWindow
  {
    guard let window = windows.first(where: { $0.id == id }) ?? sessionWindows[id] else {
      throw WindowGeometryFailure(code: .windowNotFound, message: "unknown window: \(id)")
    }
    return window
  }

  private func retainSessionWindows(_ windows: [NormalizedWindow]) {
    for window in windows
    where window.classification == .normal || window.management == .managed {
      var retained = window
      if sessionWindows[window.id]?.pid == retained.pid
        && sessionWindows[window.id]?.management == .managed && retained.management == .unmanaged
      {
        retained.management = .managed
      }
      sessionWindows[window.id] = retained
    }
  }

  private func observeWindows(
    params: [String: JSONValue],
    inventory: InventorySnapshot,
    workspaceState: WMWorkspace.WorkspaceState
  ) -> JSONValue {
    let liveByID = Dictionary(uniqueKeysWithValues: inventory.windows.map { ($0.id, $0) })
    let ids = Set(liveByID.keys).union(sessionWindows.keys).sorted()
    let reports = ids.compactMap { id -> JSONValue? in
      let observed = liveByID[id]
      let expected = sessionWindows[id]
      guard matchesObserveFilter(params, id: id, window: observed ?? expected) else { return nil }
      let workspace = workspaceState.workspaces.first { $0.windowIDs.contains(id) }
      let parked = workspaceState.parkedWindowFrames[id]
      return .object([
        "window_id": .string(id),
        "observed": observed.map(json) ?? .null,
        "expected": expected.map(json) ?? .null,
        "workspace": workspace.map { .string($0.name) } ?? .null,
        "workspace_visible": workspace.map { .bool($0.visible) } ?? .null,
        "expected_parked": .bool(parked != nil),
        "restore_frame": parked.map(json) ?? .null,
        "session_retained": .bool(expected != nil),
      ])
    }
    return .object([
      "focused_window_id": inventory.windows.first(where: { $0.focused == true }).map {
        .string($0.id)
      } ?? .null,
      "focused_workspace_name": workspaceState.focusedWorkspaceName.map(JSONValue.string) ?? .null,
      "last_transition": lastTransitionTrace,
      "windows": .array(reports),
    ])
  }

  private func matchesObserveFilter(
    _ params: [String: JSONValue], id: String, window: NormalizedWindow?
  ) -> Bool {
    guard let window else { return false }
    if case .number(let pid)? = params["pid"], window.pid != Int32(pid) { return false }
    if case .string(let value)? = params["window_id"], id != value { return false }
    if case .string(let value)? = params["app"],
      !window.appName.localizedCaseInsensitiveContains(value)
    {
      return false
    }
    if case .string(let value)? = params["exe"],
      !(window.executablePath ?? "").localizedCaseInsensitiveContains(value)
    {
      return false
    }
    return true
  }

  private func observeWorkspace(
    named name: String,
    inventory: InventorySnapshot,
    workspaceState: WMWorkspace.WorkspaceState
  ) throws -> JSONValue {
    guard let workspace = workspaceState.workspaces.first(where: { $0.name == name }) else {
      throw WorkspaceMutationError.workspaceNotFound(name)
    }
    let liveByID = Dictionary(uniqueKeysWithValues: inventory.windows.map { ($0.id, $0) })
    return .object([
      "workspace": workspaceJSON(workspace),
      "health": workspaceHealth(workspace.name),
      "layout": workspaceLayoutResults[workspace.name].map(layoutResultJSON) ?? .null,
      "windows": .array(
        workspace.windowIDs.map { id in
          .object([
            "window_id": .string(id),
            "observed": liveByID[id].map(json) ?? .null,
            "expected": sessionWindows[id].map(json) ?? .null,
            "restore_frame": workspaceState.parkedWindowFrames[id].map(json) ?? .null,
            "session_retained": .bool(sessionWindows[id] != nil),
          ])
        }),
    ])
  }

  private func resolveDisplay(
    _ requested: String?, selector: DisplaySelector? = nil,
    inventory: InventorySnapshot, workspaceState: WMWorkspace.WorkspaceState
  ) throws -> String {
    if let selector {
      let matches = inventory.displays.filter { display in
        if let value = selector.coreGraphicsDisplayId {
          return display.identifiers.cgDirectDisplayID == value
        }
        if let value = selector.nsScreenNumber {
          return display.identifiers.nsscreenNumber == value
        }
        if let value = selector.name { return display.name == value }
        return false
      }
      guard matches.count <= 1 else { throw WorkspaceRequestError.displayAmbiguous }
      guard let match = matches.first else {
        throw WorkspaceRequestError.displayNotFound("selector")
      }
      return match.id
    }
    if let requested {
      guard inventory.displays.contains(where: { $0.id == requested }) else {
        throw WorkspaceRequestError.displayNotFound(requested)
      }
      return requested
    }
    if let focused = workspaceState.focusedWorkspaceName,
      let display = workspaceState.workspaces.first(where: { $0.name == focused })?.displayID
    {
      return display
    }
    if let focusedWindow = inventory.windows.first(where: { $0.focused == true }),
      let display = focusedWindow.displayID
    {
      return display
    }
    guard
      let display = inventory.displays.first(where: { $0.isPrimary }) ?? inventory.displays.first
    else {
      throw WorkspaceRequestError.displayRequired
    }
    return display.id
  }

  private func displayList(_ displays: [DisplayObservation], verbose: Bool) -> JSONValue {
    guard !verbose else { return json(["displays": displays]) }
    return .object([
      "displays": .array(
        displays.map { display in
          .object([
            "id": .string(display.id),
            "name": .string(display.name),
            "is_primary": .bool(display.isPrimary),
            "is_builtin": .bool(display.isBuiltin),
            "core_graphics_display_id": display.identifiers.cgDirectDisplayID.map(JSONValue.string)
              ?? .null,
            "ns_screen_number": display.identifiers.nsscreenNumber.map(JSONValue.string) ?? .null,
            "uuid": display.identifiers.uuid.map(JSONValue.string) ?? .null,
          ])
        })
    ])
  }

  private func nextDisplay(after current: String, displays: [DisplayObservation]) throws -> String {
    let ids = displays.map(\.id)
    guard ids.count > 1, let index = ids.firstIndex(of: current) else {
      throw WorkspaceRequestError.displayRequired
    }
    return ids[(index + 1) % ids.count]
  }

  private func workspaceDirection(_ direction: WMProtocol.WindowDirection)
    -> WMWorkspace.WindowDirection
  {
    switch direction {
    case .left: .left
    case .down: .down
    case .up: .up
    case .right: .right
    }
  }

  private func validateWindows(_ ids: [String], inventory: InventorySnapshot) throws {
    let known = Set(inventory.windows.map(\.id))
    if let missing = ids.first(where: { !known.contains($0) }) {
      throw WorkspaceRequestError.windowNotFound(missing)
    }
  }

  private func movableWindow(_ id: String, in windows: [String: NormalizedWindow])
    -> NormalizedWindow?
  {
    guard let window = windows[id], window.classification == .normal,
      window.management == .managed
    else { return nil }
    return window
  }

  private func movableWindow(
    _ id: String, retained: [String: NormalizedWindow], inventory: InventorySnapshot
  ) -> NormalizedWindow? {
    guard let observed = inventory.windows.first(where: { $0.id == id }),
      observed.classification == .normal,
      let retained = movableWindow(id, in: retained), retained.pid == observed.pid
    else {
      return nil
    }
    return retained
  }

  func parkingProbe(
    for lifetime: WindowLifetime, inventory: InventorySnapshot
  ) -> NormalizedWindow? {
    guard
      let observed = inventory.windows.first(where: {
        $0.id == lifetime.windowID && $0.pid == lifetime.pid
      }), observed.classification == .normal, observed.frame?.isUsable == true,
      WindowCapabilityPolicy.effective(observed.geometryCapabilities.position) != .fixed,
      var retained = movableWindow(
        lifetime.windowID, retained: sessionWindows, inventory: inventory)
    else { return nil }
    retained.frame = observed.frame
    retained.geometryCapabilities = observed.geometryCapabilities
    return retained
  }

  struct ParkingProbeCandidate: Sendable {
    var window: NormalizedWindow
    var currentFrame: InventoryRect
    var restoreFrame: InventoryRect
    var wasParked: Bool
  }

  func parkingProbeCandidates(
    for displayID: String, lifetimes: Set<WindowLifetime>, state: WMWorkspace.WorkspaceState,
    inventory: InventorySnapshot, preferredWindowID: String? = nil
  ) -> [ParkingProbeCandidate] {
    let display = DisplayTopologySnapshot(displays: inventory.displays).axFrames[displayID]
    return lifetimes.compactMap { lifetime in
      guard let workspace = state.workspaceName(containing: lifetime.windowID),
        state[workspace: workspace]?.displayID == displayID,
        state[workspace: workspace]?.visible == false,
        let window = parkingProbe(for: lifetime, inventory: inventory),
        let currentFrame = window.frame
      else { return nil }
      let parkedRestore = state.parkedWindowFrames[window.id]?.inventoryRect
      guard
        let restoreFrame = parkedRestore
          ?? display.flatMap({ Self.containsCenter($0, of: currentFrame) ? currentFrame : nil })
      else { return nil }
      return ParkingProbeCandidate(
        window: window, currentFrame: currentFrame, restoreFrame: restoreFrame,
        wasParked: parkedRestore != nil)
    }.sorted {
      if ($0.window.id == preferredWindowID) != ($1.window.id == preferredWindowID) {
        return $0.window.id == preferredWindowID
      }
      if $0.wasParked != $1.wasParked { return $0.wasParked }
      return $0.window.id < $1.window.id
    }
  }

  private func focusWorkspaceWindow(
    _ state: WMWorkspace.WorkspaceState,
    named name: String,
    inventory: InventorySnapshot,
    sessionGeneration: UInt64? = nil
  ) async throws {
    guard let workspace = state.workspaces.first(where: { $0.name == name }) else { return }
    let ids = Self.focusCandidateIDs(workspace: workspace, inventory: inventory)
    guard !ids.isEmpty else { return }
    var lastFailure: WindowGeometryFailure?
    for id in ids {
      do {
        try requireCurrentSessionGeneration(sessionGeneration)
        try await focusWindow(resolveWindow(id, in: inventory.windows))
        try requireCurrentSessionGeneration(sessionGeneration)
        return
      } catch let failure as WindowGeometryFailure {
        lastFailure = failure
      }
    }
    throw lastFailure
      ?? WindowGeometryFailure(code: .windowNotFound, message: "workspace has no observed windows")
  }

  private func focusWindow(_ window: NormalizedWindow) async throws {
    try await releaseParkingProbe(ifTargeting: [window.id], displays: [])
    expectedActivationPIDs[window.pid] = Date().addingTimeInterval(1)
    do {
      try await geometry.focus(window: window)
    } catch {
      expectedActivationPIDs.removeValue(forKey: window.pid)
      throw error
    }
  }

  @discardableResult private func reconcileWorkspaceFocus(
    before: WMWorkspace.WorkspaceState,
    after: inout WMWorkspace.WorkspaceState,
    name: String,
    inventory: InventorySnapshot,
    tolerateGeometryClamp: Bool = false,
    sessionGeneration: UInt64? = nil
  ) async throws -> Set<WindowLifetime> {
    try requireCurrentSessionGeneration(sessionGeneration)
    let transition = WorkspaceTransitionPlan(before: before, after: after, destination: name)
    let incomingIDs = transition.incomingWindowIDs
    let outgoingIDs = transition.outgoingWindowIDs
    let movedIDs = transition.movedWindowIDs
    retainSessionWindows(inventory.windows)
    let windowsByID = sessionWindows
    let previousParkedFrames = after.parkedWindowFrames
    var restoredIDs: Set<String> = []
    var changed: [(NormalizedWindow, InventoryRect)] = []
    let parkingTrace: [JSONValue] = []
    var stage = "snapshot"
    lastTransitionTrace = .object([
      "destination": .string(name), "status": .string("running"),
      "incoming_window_ids": .array(incomingIDs.sorted().map(JSONValue.string)),
      "outgoing_window_ids": .array(outgoingIDs.sorted().map(JSONValue.string)),
    ])
    do {
      for id in incomingIDs.union(outgoingIDs).sorted() {
        guard let window = movableWindow(id, retained: windowsByID, inventory: inventory) else {
          continue
        }
        try requireCurrentSessionGeneration(sessionGeneration)
        let observed = try await geometry.get(window: window).frame
        try requireCurrentSessionGeneration(sessionGeneration)
        changed.append(
          (
            window,
            .init(
              x: observed.x, y: observed.y, width: observed.width, height: observed.height
            )
          ))
      }
      let topology = DisplayTopologySnapshot(displays: inventory.displays)
      let displayFrames = topology.axFrames
      for id in incomingIDs {
        guard let restore = after.parkedWindowFrames[id]?.inventoryRect,
          !isCenteredOnDisplay(restore, displays: Array(displayFrames.values))
        else { continue }
        after.parkedWindowFrames.removeValue(forKey: id)
      }
      let incomingDisplayID = after[workspace: name]?.displayID
      let incomingDisplay = incomingDisplayID.flatMap { displayFrames[$0] }
      try await releaseParkingProbe(ifTargeting: incomingIDs, displays: inventory.displays)
      let incomingIsBSP = after[workspace: name]?.mode == .bsp
      if !incomingIsBSP {
        stage = "activate_incoming"
        try await focusWorkspaceWindow(
          after, named: name, inventory: inventory, sessionGeneration: sessionGeneration)
      }
      for id in incomingIDs where !incomingIsBSP {
        guard let window = movableWindow(id, retained: windowsByID, inventory: inventory),
          let restore = after.parkedWindowFrames[id]
        else {
          continue
        }
        let saved = restore.inventoryRect
        let target =
          isCenteredOnDisplay(saved, displays: Array(displayFrames.values))
          ? saved : incomingDisplay ?? saved
        do {
          try requireCurrentSessionGeneration(sessionGeneration)
          _ = try await setRestoredFrame(
            window: window, target: target,
            floating: after[workspace: name]?.floatingWindowIDs.contains(id) == true)
          try requireCurrentSessionGeneration(sessionGeneration)
        } catch let failure as WindowGeometryFailure {
          guard failure.code == .geometryVerificationFailed,
            let incomingDisplay,
            target != incomingDisplay
          else { throw failure }
          try requireCurrentSessionGeneration(sessionGeneration)
          _ = try await setRestoredFrame(
            window: window, target: incomingDisplay,
            floating: after[workspace: name]?.floatingWindowIDs.contains(id) == true)
          try requireCurrentSessionGeneration(sessionGeneration)
        }
        restoredIDs.insert(id)
      }
      var newlyPending: Set<WindowLifetime> = []
      for id in outgoingIDs {
        guard let window = movableWindow(id, retained: windowsByID, inventory: inventory),
          let original = changed.first(where: { $0.0.id == id })?.1
        else { continue }
        after.parkedWindowFrames[id] = .init(original)
        newlyPending.insert(.init(windowID: id, pid: window.pid))
      }
      stage = "tile_incoming"
      if tolerateGeometryClamp {
        _ = await tileWorkspaceForObserver(
          after, named: name, inventory: inventory,
          forceStack: false, sessionGeneration: sessionGeneration
        )
      } else {
        try await tileWorkspace(
          after, named: name, inventory: inventory,
          forceStack: false, priorityWindowIDs: movedIDs,
          sessionGeneration: sessionGeneration)
      }
      stage = "focus_incoming"
      try await focusWorkspaceWindow(
        after, named: name, inventory: inventory, sessionGeneration: sessionGeneration)
      if incomingIsBSP { restoredIDs.formUnion(incomingIDs) }
      for id in restoredIDs { after.parkedWindowFrames.removeValue(forKey: id) }
      lastTransitionTrace = .object([
        "destination": .string(name), "status": .string("succeeded"),
        "incoming_window_ids": .array(incomingIDs.sorted().map(JSONValue.string)),
        "outgoing_window_ids": .array(outgoingIDs.sorted().map(JSONValue.string)),
        "parking": .array(parkingTrace),
      ])
      return newlyPending
    } catch {
      let transitionError = error
      try requireCurrentSessionGeneration(sessionGeneration)
      for (window, previousFrame) in changed.reversed() {
        do {
          let floating = before.workspaces.contains {
            $0.floatingWindowIDs.contains(window.id)
          }
          _ = try await setRestoredFrame(
            window: window, target: previousFrame, floating: floating)
        } catch {
          _ = try? await geometry.fit(window: window, within: previousFrame)
        }
      }
      after.parkedWindowFrames = previousParkedFrames
      lastTransitionTrace = .object([
        "destination": .string(name), "status": .string("rolled_back"),
        "incoming_window_ids": .array(incomingIDs.sorted().map(JSONValue.string)),
        "outgoing_window_ids": .array(outgoingIDs.sorted().map(JSONValue.string)),
        "parking": .array(parkingTrace), "stage": .string(stage),
        "error": .string(String(describing: error)),
      ])
      throw transitionError
    }
  }

  private func commitFocusAndSchedule(
    _ mutation: WMWorkspace.WorkspaceMutationResult, pending: Set<WindowLifetime>
  ) async throws {
    try await workspaces.commitFocus(mutation)
    pendingParking.formUnion(pending)
    for workspace in mutation.workspaceState.workspaces where workspace.visible {
      pendingParking.subtract(
        workspace.windowIDs.compactMap { id in
          sessionWindows[id].map { WindowLifetime(windowID: id, pid: $0.pid) }
        })
    }
    scheduleParking()
  }

  private func scheduleParking() {
    guard parkingTask == nil else { return }
    parkingRetryRequested = false
    parkingTaskGeneration &+= 1
    let generation = parkingTaskGeneration
    parkingTask = Task { [weak self] in
      await self?.runParking(generation: generation)
    }
  }

  private func runParking(generation: UInt64) async {
    defer {
      if parkingTaskGeneration == generation {
        parkingTask = nil
        if parkingRetryRequested { scheduleParking() }
      }
    }
    do {
      while !Task.isCancelled {
        guard generation == parkingTaskGeneration else { return }
        let inventory = try await state.refresh().snapshot.inventory
        let committed = await workspaces.snapshot()
        let hidden = authoritativeParkingLifetimes(state: committed, inventory: inventory)
        pendingParking = hidden
        guard !hidden.isEmpty else { return }
        try await parkAuthoritativeHiddenWindows(
          hidden, state: committed, inventory: inventory, generation: generation)
        let remaining = authoritativeParkingLifetimes(state: committed, inventory: inventory)
        pendingParking = remaining
        let missingDisplayIDs = Set(
          remaining.compactMap { lifetime in
            guard let workspace = committed.workspaceName(containing: lifetime.windowID) else {
              return nil
            }
            return committed[workspace: workspace]?.displayID
          }
        ).filter { parkingDiagnoses[$0] == nil }
        guard let displayID = missingDisplayIDs.sorted().first else { return }
        let candidates = parkingProbeCandidates(
          for: displayID, lifetimes: remaining, state: committed, inventory: inventory,
          preferredWindowID: parkingProbePriority[displayID])
        var lastProbeError: Error?
        for candidate in candidates {
          parkingProbe = (candidate.window, candidate.currentFrame, generation)
          do {
            try await resolveParkingDiagnosis(
              inventory, displayID: displayID, probe: candidate.window,
              currentFrame: candidate.currentFrame, restoreFrame: candidate.restoreFrame,
              generation: generation)
            parkingProbe = nil
            lastProbeError = nil
            break
          } catch {
            parkingProbe = nil
            if error is CancellationError { throw error }
            lastProbeError = error
          }
        }
        guard parkingDiagnoses[displayID] != nil else {
          throw lastProbeError ?? ParkingDiagnosticError.noProbeWindow
        }
        parkingProbePriority[displayID] = nil
      }
    } catch is CancellationError {
    } catch {
      internalErrorReporter?(
        "parking diagnostic deferred: \(String(describing: error).prefix(512))")
    }
  }

  private func parkAuthoritativeHiddenWindows(
    _ lifetimes: Set<WindowLifetime>, state: WMWorkspace.WorkspaceState,
    inventory: InventorySnapshot, generation: UInt64
  ) async throws {
    for lifetime in lifetimes.sorted(by: { $0.windowID < $1.windowID }) {
      guard generation == parkingTaskGeneration, !Task.isCancelled else { return }
      guard let workspace = state.workspaceName(containing: lifetime.windowID),
        let displayID = state[workspace: workspace]?.displayID,
        parkingDiagnoses[displayID] != nil
      else { continue }
      try await parkCommittedWindow(lifetime.windowID, state: state, inventory: inventory)
      pendingParking.remove(lifetime)
    }
  }

  func authoritativeParkingLifetimes(
    state: WMWorkspace.WorkspaceState, inventory: InventorySnapshot
  ) -> Set<WindowLifetime> {
    let windows = Dictionary(uniqueKeysWithValues: inventory.windows.map { ($0.id, $0) })
    return Set(
      state.workspaces.filter { !$0.visible }.flatMap { workspace in
        workspace.windowIDs.compactMap { id in
          guard let window = windows[id], window.classification == .normal,
            sessionWindows[id]?.pid == window.pid, sessionWindows[id]?.management == .managed
          else { return nil }
          return WindowLifetime(windowID: id, pid: window.pid)
        }
      })
  }

  private func reconcilePendingParking(
    state: WMWorkspace.WorkspaceState, inventory: InventorySnapshot
  ) {
    pendingParking = Self.reconciledPendingParking(
      pendingParking, state: state, inventory: inventory, retainedWindows: sessionWindows)
  }

  nonisolated static func reconciledPendingParking(
    _ pending: Set<WindowLifetime>, state: WMWorkspace.WorkspaceState,
    inventory: InventorySnapshot, retainedWindows: [String: NormalizedWindow]
  ) -> Set<WindowLifetime> {
    let windows = Dictionary(uniqueKeysWithValues: inventory.windows.map { ($0.id, $0) })
    return pending.filter { lifetime in
      guard let window = windows[lifetime.windowID], window.pid == lifetime.pid,
        window.classification == .normal,
        retainedWindows[lifetime.windowID]?.pid == lifetime.pid,
        retainedWindows[lifetime.windowID]?.management == .managed,
        let workspace = state.workspaceName(containing: lifetime.windowID)
      else { return false }
      return state[workspace: workspace]?.visible == false
    }
  }

  private func releaseParkingProbe(
    ifTargeting ids: Set<String>, displays: [DisplayObservation]
  ) async throws {
    guard let lease = parkingProbe, ids.contains(lease.window.id) else { return }
    parkingTaskGeneration &+= 1
    let task = parkingTask
    task?.cancel()
    _ = await task?.result
    parkingTask = nil
    guard parkingProbe == nil else { throw ParkingDiagnosticError.restorationFailed }
  }

  private func cancelParkingWork() async {
    parkingTaskGeneration &+= 1
    let task = parkingTask
    task?.cancel()
    _ = await task?.result
    parkingTask = nil
    parkingProbe = nil
  }

  private func restoreProbe(
    _ window: NormalizedWindow, original: InventoryRect, displayID: String,
    displays: [DisplayObservation]
  ) async throws {
    let restored = try await geometry.setPosition(window: window, frame: original)
    if restored.approximatelyEquals(original, tolerance: 1) { return }
    let topology = DisplayTopologySnapshot(displays: displays)
    guard let workArea = topology.axWorkAreas[displayID] ?? topology.axWorkAreas.values.first else {
      throw ParkingDiagnosticError.restorationFailed
    }
    let width = min(original.width, workArea.width)
    let height = min(original.height, workArea.height)
    let anchor = InventoryRect(
      x: workArea.x + (workArea.width - width) / 2,
      y: workArea.y + (workArea.height - height) / 2, width: width, height: height)
    let anchored = try await geometry.setPosition(window: window, frame: anchor)
    guard anchored.approximatelyEquals(anchor, tolerance: 1) else {
      throw ParkingDiagnosticError.restorationFailed
    }
    let retried = try await geometry.setPosition(window: window, frame: original)
    guard retried.approximatelyEquals(original, tolerance: 1) else {
      throw ParkingDiagnosticError.restorationFailed
    }
  }

  private func frameParams(_ id: String, _ frame: InventoryRect, attempts: Int = 5)
    -> WindowFrameSetParams
  {
    .init(
      windowID: id, frame: .init(x: frame.x, y: frame.y, width: frame.width, height: frame.height),
      attempts: attempts)
  }

  private func tileWorkspace(
    _ state: WMWorkspace.WorkspaceState,
    named name: String,
    inventory: InventorySnapshot,
    forceStack: Bool = false,
    priorityWindowIDs: Set<String> = [],
    sessionGeneration: UInt64? = nil
  ) async throws {
    try requireCurrentSessionGeneration(sessionGeneration)
    guard let workspace = state.workspaces.first(where: { $0.name == name }),
      workspace.mode == .bsp,
      workspace.bsp.root != nil,
      let display = inventory.displays.first(where: { $0.id == workspace.displayID })
    else { return }
    guard
      let workArea = DisplayTopologySnapshot(displays: inventory.displays).axWorkAreas[display.id]
    else { return }
    let bounds = WorkspaceLayoutRect(
      x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height)
    retainSessionWindows(inventory.windows)
    let bspWindowIDs = workspace.bsp.root?.windowIDs ?? []
    let windows = bspWindowIDs.compactMap {
      movableWindow($0, retained: sessionWindows, inventory: inventory)
    }
    guard !windows.isEmpty else { return }
    let originals = Dictionary(
      uniqueKeysWithValues: windows.compactMap { window in window.frame.map { (window.id, $0) } })
    let geometryPolicy = resolvedGeometryPolicy(for: workspace)
    let retryPolicy = Self.geometryRetryPolicy(
      retries: geometryPolicy.retries, mode: geometryPolicy.mode)
    var cooperation = await workspaceCooperation(
      bspWindowIDs, inventory: inventory, mode: geometryPolicy.mode
    )
    try requireCurrentSessionGeneration(sessionGeneration)
    var moved: [NormalizedWindow] = []
    var movedIDs: Set<String> = []
    var replanCount = 0
    do {
      while replanCount <= windows.count {
        let targets = try layoutTargets(
          workspace, bounds: bounds, cooperation: cooperation, forceStack: forceStack
        )
        var shouldReplan = false
        let orderedWindows = windows.sorted {
          let leftPriority = priorityWindowIDs.contains($0.id)
          let rightPriority = priorityWindowIDs.contains($1.id)
          if leftPriority != rightPriority { return leftPriority }
          guard let left = targets[$0.id], let right = targets[$1.id] else { return $0.id < $1.id }
          let leftArea = left.width * left.height
          let rightArea = right.width * right.height
          return leftArea == rightArea ? $0.id < $1.id : leftArea < rightArea
        }
        for window in orderedWindows {
          guard let target = targets[window.id], target.width > 0, target.height > 0 else {
            throw WindowGeometryFailure(
              code: .geometryVerificationFailed,
              message: "workspace policy produced an infeasible frame")
          }
          try requireCurrentSessionGeneration(sessionGeneration)
          let outcome = try await geometry.setGeometry(
            window: window,
            request: .init(frame: inventoryRect(target), policy: retryPolicy)
          )
          try requireCurrentSessionGeneration(sessionGeneration)
          if movedIDs.insert(window.id).inserted { moved.append(window) }
          switch outcome.classification {
          case .exact:
            continue
          case .constrained:
            let minimum = Self.constrainedMinimum(fitted: outcome.observedFrame, target: target)
            let maximum = Self.constrainedMaximum(fitted: outcome.observedFrame, target: target)
            let content = contentFrame(workspace, bounds)
            if outcome.observedFrame.x >= content.x - 1,
              outcome.observedFrame.y >= content.y - 1,
              outcome.observedFrame.x + outcome.observedFrame.width <= content.x + content.width
                + 1,
              outcome.observedFrame.y + outcome.observedFrame.height <= content.y + content.height
                + 1
            {
              continue
            }
            let centerX = outcome.observedFrame.x + outcome.observedFrame.width / 2
            let centerY = outcome.observedFrame.y + outcome.observedFrame.height / 2
            if centerX >= content.x, centerX <= content.x + content.width,
              centerY >= content.y, centerY <= content.y + content.height
            {
              continue
            }
            guard minimum != .init() || maximum != .init() else { continue }
            if minimum != .init() { windowMinimumSizes[window.id] = minimum }
            let previous = cooperation[window.id] ?? .init()
            cooperation[window.id] = .init(
              minimumSize: .init(
                width: max(previous.minimumSize.width, minimum.width),
                height: max(previous.minimumSize.height, minimum.height)),
              maximumSize: .init(
                width: maximum.width ?? previous.maximumSize.width,
                height: maximum.height ?? previous.maximumSize.height),
              isCooperative: false)
            shouldReplan = true
          case .progressing, .failed:
            let minimum = Self.constrainedMinimum(fitted: outcome.observedFrame, target: target)
            let content = contentFrame(workspace, bounds)
            let centerX = outcome.observedFrame.x + outcome.observedFrame.width / 2
            let centerY = outcome.observedFrame.y + outcome.observedFrame.height / 2
            let known = cooperation[window.id] ?? .init()
            let widthBounded =
              known.maximumSize.width.map { abs($0 - outcome.observedFrame.width) <= 1 } ?? false
            let heightBounded =
              known.maximumSize.height.map { abs($0 - outcome.observedFrame.height) <= 1 } ?? true
            if widthBounded,
              outcome.observedFrame.x + outcome.observedFrame.width > content.x + content.width + 1
            {
              var corrected = target
              corrected.x = content.x + content.width - outcome.observedFrame.width
              corrected.width = outcome.observedFrame.width
              try requireCurrentSessionGeneration(sessionGeneration)
              let correction = try await geometry.setGeometry(
                window: window,
                request: .init(frame: inventoryRect(corrected), policy: retryPolicy))
              try requireCurrentSessionGeneration(sessionGeneration)
              let correctedFrame = correction.observedFrame
              if correctedFrame.x >= content.x - 1,
                correctedFrame.x + correctedFrame.width <= content.x + content.width + 1
              {
                continue
              }
            }
            if centerX >= content.x, centerX <= content.x + content.width,
              centerY >= content.y, centerY <= content.y + content.height,
              widthBounded, heightBounded
            {
              continue
            }
            if minimum != .init() {
              windowMinimumSizes[window.id] = minimum
              cooperation[window.id] = .init(minimumSize: minimum, isCooperative: false)
            }
            throw WindowGeometryFailure(
              code: .geometryVerificationFailed,
              message: "window geometry did not stabilize after \(outcome.attempts) attempts",
              observedFrame: outcome.observedFrame.protocolFrame
            )
          }
          if shouldReplan { break }
        }
        guard shouldReplan else { return }
        replanCount += 1
      }
      throw WindowGeometryFailure(
        code: .geometryVerificationFailed, message: "workspace policy did not converge")
    } catch {
      let tilingError = error
      try requireCurrentSessionGeneration(sessionGeneration)
      for window in moved.reversed() {
        guard let original = originals[window.id] else { continue }
        _ = try? await geometry.set(
          window: window,
          params: .init(
            windowID: window.id,
            frame: .init(
              x: original.x, y: original.y, width: original.width, height: original.height)
          ))
      }
      throw tilingError
    }
  }

  private func tileWorkspaceForObserver(
    _ state: WMWorkspace.WorkspaceState, named name: String, inventory: InventorySnapshot,
    forceStack: Bool, sessionGeneration: UInt64? = nil
  ) async -> Bool {
    do {
      try await tileWorkspace(
        state, named: name, inventory: inventory, forceStack: forceStack,
        sessionGeneration: sessionGeneration)
      return true
    } catch {
      reportInternalTransactionError(name: "observer.geometry", error: String(describing: error))
      return false
    }
  }

  private func workspaceCooperation(
    _ windowIDs: [String], inventory: InventorySnapshot,
    mode: WMWorkspace.GeometryProfileMode = .store
  ) async -> [String: WorkspaceWindowCooperation] {
    let windows = Dictionary(uniqueKeysWithValues: inventory.windows.map { ($0.id, $0) })
    var result: [String: WorkspaceWindowCooperation] = [:]
    for id in windowIDs {
      let sessionMinimum = windowMinimumSizes[id] ?? .init()
      guard mode != .infer, let window = windows[id],
        let profile = await geometryProfiles.profile(for: window)
      else {
        result[id] = .init(
          minimumSize: sessionMinimum, isCooperative: windowMinimumSizes[id] == nil)
        continue
      }
      let learned = WorkspaceMinimumSize(
        width: profile.minimumWidth ?? 0, height: profile.minimumHeight ?? 0
      )
      let minimum = WorkspaceMinimumSize(
        width: max(sessionMinimum.width, learned.width),
        height: max(sessionMinimum.height, learned.height)
      )
      let maximum = WorkspaceMaximumSize(
        width: profile.maximumWidth, height: profile.maximumHeight)
      result[id] = .init(
        minimumSize: minimum,
        maximumSize: maximum,
        isCooperative: minimum == .init() && maximum == .init()
      )
    }
    return result
  }

  private func layoutTargets(
    _ workspace: WMWorkspace.Workspace, bounds: WorkspaceLayoutRect,
    cooperation: [String: WorkspaceWindowCooperation], forceStack: Bool
  ) throws -> [String: WorkspaceLayoutRect] {
    let result =
      forceStack
      ? WorkspaceLayoutResult(
        requestedChain: [.stack], attemptedChain: [.stack], effectivePolicy: .stack,
        plan: .frames(
          Dictionary(
            uniqueKeysWithValues: workspace.windowIDs.map { ($0, contentFrame(workspace, bounds)) })
        ),
        fallbackOccurred: false)
      : workspaceWithPolicy(
        workspace, policy: resolvedLayoutPolicy(for: workspace)
      ).layoutResult(in: bounds, cooperation: cooperation)
    workspaceLayoutResults[workspace.name] = result
    guard case .frames(let targets) = result.plan else {
      throw WindowGeometryFailure(
        code: .geometryVerificationFailed, message: "uncooperative window policy rejected layout"
      )
    }
    return targets
  }

  private func inventoryRect(_ frame: WorkspaceLayoutRect) -> InventoryRect {
    .init(x: frame.x, y: frame.y, width: frame.width, height: frame.height)
  }

  static func geometryRetryPolicy(
    retries: Int, mode: WMWorkspace.GeometryProfileMode
  ) -> WindowGeometryRetryPolicy {
    let learningMode: WindowGeometryLearningMode =
      switch mode {
      case .store: .storeAndReuse
      case .infer: .inferEveryRequest
      case .optimistic: .optimisticIdealFirst
      }
    return .init(maximumAttempts: retries, mode: learningMode)
  }

  private func resolvedLayoutPolicy(
    for workspace: WMWorkspace.Workspace
  ) -> [WMWorkspace.LayoutPolicy] {
    workspaceLayoutPolicies[workspace.name] ?? layoutPolicy
  }

  private func workspaceWithPolicy(
    _ workspace: WMWorkspace.Workspace, policy: [WMWorkspace.LayoutPolicy]
  ) -> WMWorkspace.Workspace {
    var result = workspace
    result.layoutPolicy = policy
    return result
  }

  private func contentFrame(
    _ workspace: WMWorkspace.Workspace, _ bounds: WorkspaceLayoutRect
  ) -> WorkspaceLayoutRect {
    .init(
      x: bounds.x + workspace.margin.left, y: bounds.y + workspace.margin.top,
      width: max(0, bounds.width - workspace.margin.left - workspace.margin.right),
      height: max(0, bounds.height - workspace.margin.top - workspace.margin.bottom)
    )
  }

  static func constrainedMinimum(
    fitted: InventoryRect, target: WorkspaceLayoutRect
  ) -> WorkspaceMinimumSize {
    .init(
      width: fitted.width > target.width ? fitted.width : 0,
      height: fitted.height > target.height ? fitted.height : 0
    )
  }

  static func constrainedMaximum(
    fitted: InventoryRect, target: WorkspaceLayoutRect
  ) -> WorkspaceMaximumSize {
    .init(
      width: fitted.width < target.width ? fitted.width : nil,
      height: fitted.height < target.height ? fitted.height : nil)
  }

  private func workspacePolicies(_ policies: [WMProtocol.LayoutPolicy]) -> [WMWorkspace
    .LayoutPolicy]
  {
    policies.map { WMWorkspace.LayoutPolicy(rawValue: $0.rawValue)! }
  }

  private func workspacePolicies(_ policies: [WMConfiguration.LayoutPolicy]) -> [WMWorkspace
    .LayoutPolicy]
  {
    policies.map { WMWorkspace.LayoutPolicy(rawValue: $0.rawValue)! }
  }

  private func restoreParkedWindows(
    _ committed: WMWorkspace.WorkspaceState, inventory: InventorySnapshot, all: Bool
  ) async throws {
    retainSessionWindows(inventory.windows)
    for workspace in committed.workspaces where all || workspace.visible {
      for id in workspace.windowIDs {
        guard let restore = committed.parkedWindowFrames[id],
          let window = movableWindow(id, in: sessionWindows)
        else {
          continue
        }
        _ = try await setRestoredFrame(
          window: window, target: restore.inventoryRect,
          floating: workspace.floatingWindowIDs.contains(id))
      }
    }
  }

  private func parkCommittedWindow(
    _ id: String, state: WMWorkspace.WorkspaceState, inventory: InventorySnapshot
  ) async throws {
    let displayFrames = DisplayTopologySnapshot(displays: inventory.displays).axFrames
    guard let window = movableWindow(id, in: sessionWindows), let original = window.frame,
      let workspaceName = state.workspaceName(containing: id),
      let displayID = state[workspace: workspaceName]?.displayID,
      let displayFrame = displayFrames[displayID],
      let plan = WindowParkingPlan(
        displayFrame: displayFrame,
        otherDisplayFrames: displayFrames.filter { $0.key != displayID }.map(\.value),
        windowFrame: original, diagnosis: try requireParkingDiagnosis(displayID: displayID))
    else {
      throw WindowGeometryFailure(
        code: .geometryVerificationFailed,
        message: "no topology-safe parking corner for \(id) on its assigned display")
    }
    let floating = state[workspace: workspaceName]?.floatingWindowIDs.contains(id) == true
    let observed = try await park(window: window, frame: plan.targetFrame, floating: floating)
    guard plan.accepts(observed) else {
      try await diagnostics.invalidate(plan.provenance)
      parkingDiagnoses[displayID] = nil
      parkingProbePriority[displayID] = id
      parkingRetryRequested = true
      return
    }
  }

  private func requireParkingDiagnosis(displayID: String) throws
    -> ResolvedDiagnostic<ParkingLimits>
  {
    guard let diagnosis = parkingDiagnoses[displayID] else {
      throw ParkingDiagnosticError.missingDiagnosis
    }
    return diagnosis
  }

  private func park(
    window: NormalizedWindow, frame: InventoryRect, floating: Bool
  ) async throws -> InventoryRect {
    floating
      ? try await geometry.setPosition(window: window, frame: frame)
      : try await geometry.park(window: window, frame: frame)
  }

  private func setRestoredFrame(
    window: NormalizedWindow, target: InventoryRect, floating: Bool
  ) async throws -> InventoryRect {
    if floating { return try await geometry.setPosition(window: window, frame: target) }
    let observed = try await geometry.set(
      window: window, params: frameParams(window.id, target)
    ).observedFrame
    return .init(x: observed.x, y: observed.y, width: observed.width, height: observed.height)
  }

  private func workspaceList(_ state: WMWorkspace.WorkspaceState) -> JSONValue {
    .object([
      "workspaces": .array(state.workspaces.map(workspaceJSON)),
      "focused_workspace_name": state.focusedWorkspaceName.map(JSONValue.string) ?? .null,
    ])
  }

  private func workspaceMutation(_ result: WMWorkspace.WorkspaceMutationResult) -> JSONValue {
    .object([
      "workspace_state": workspaceList(result.workspaceState),
      "modified_workspaces": .array(result.modifiedWorkspaces.map(JSONValue.string)),
      "deleted_workspaces": .array(result.deletedWorkspaces.map(JSONValue.string)),
      "effect_status": .string("verified"),
      "split_decision": result.splitDecision.map { .string($0.rawValue) } ?? .null,
    ])
  }

  private func workspaceJSON(_ workspace: WMWorkspace.Workspace) -> JSONValue {
    var resolved = workspace
    resolved.layoutPolicy = resolvedLayoutPolicy(for: workspace)
    return json(resolved)
  }

  private func resolvedGeometryPolicy(for workspace: WMWorkspace.Workspace) -> (
    retries: Int, mode: WMWorkspace.GeometryProfileMode
  ) {
    let runtime = workspaceGeometryPolicies[workspace.name]
    return (
      runtime?.retries ?? workspace.maxGeometryRetries,
      runtime?.mode ?? workspace.geometryProfileMode
    )
  }

  private func workspaceProfileMode(_ mode: WMConfiguration.GeometryProfileMode)
    -> WMWorkspace.GeometryProfileMode
  {
    switch mode {
    case .store: .store
    case .infer: .infer
    case .optimistic: .optimistic
    }
  }

  private func workspaceProfileMode(_ mode: WMProtocol.GeometryProfileMode)
    -> WMWorkspace.GeometryProfileMode
  {
    switch mode {
    case .store: .store
    case .infer: .infer
    case .optimistic: .optimistic
    }
  }

  private func geometryPolicyJSON(
    workspace: String?, retries: Int, mode: WMWorkspace.GeometryProfileMode
  ) -> JSONValue {
    .object([
      "workspace": workspace.map(JSONValue.string) ?? .null,
      "max_geometry_retries": .number(Double(retries)),
      "geometry_profile_mode": .string(mode.rawValue),
    ])
  }

  private func publishWorkspaceMutation(
    _ result: WMWorkspace.WorkspaceMutationResult,
    before: WMWorkspace.WorkspaceState,
    reason: EventTopic,
    sessionGeneration: UInt64? = nil
  ) async {
    guard result.workspaceState != before else { return }
    let previousNames = Set(before.workspaces.map(\.name))
    let currentNames = Set(result.workspaceState.workspaces.map(\.name))
    var topics: Set<EventTopic> = [.workspaceChanged, reason]
    if !currentNames.subtracting(previousNames).isEmpty { topics.insert(.workspaceCreated) }
    if !previousNames.subtracting(currentNames).isEmpty { topics.insert(.workspaceDeleted) }
    let eventData = workspaceMutation(result)
    let version = await currentVersion()
    guard sessionGeneration == nil || sessionGeneration == self.sessionTransitionGeneration else {
      return
    }
    workspaceSequence += 1
    for (clientID, clientSubscriptions) in workspaceSubscriptions {
      for subscription in clientSubscriptions.values {
        for topic in topics.intersection(subscription.topics) {
          sender?(
            encode(
              .event(
                .init(
                  sequence: workspaceSequence,
                  stateVersion: version,
                  timestamp: Date(),
                  topic: topic,
                  data: subscription.projection == .invalidation
                    ? .object([
                      "topic": .string(topic.rawValue), "state_version": .number(Double(version)),
                    ])
                    : eventData
                ))), clientID)
        }
      }
    }
    await publishStateSnapshot()
  }

  private func workspaceSnapshotEvent(topic: EventTopic) async -> String {
    let version = await currentVersion()
    return encode(
      .event(
        .init(
          sequence: workspaceSequence,
          stateVersion: version,
          timestamp: Date(),
          topic: topic,
          data: workspaceList(await workspaces.snapshot())
        )))
  }

  private func workspaceError(_ error: WorkspaceMutationError) -> ProtocolError {
    switch error {
    case .workspaceNotFound(let name):
      .init(code: .workspaceNotFound, message: "unknown workspace: \(name)", retryable: false)
    case .displayRequired(let name):
      .init(
        code: .invalidParams, message: "display required to create workspace: \(name)",
        retryable: false)
    case .windowNotFound(let id):
      .init(
        code: .windowNotFound, message: "window is not assigned to a workspace: \(id)",
        retryable: false)
    case .windowAlreadyInDestination(let id, let workspace):
      .init(
        code: .workspaceConflict, message: "window \(id) is already in workspace \(workspace)",
        retryable: false)
    case .duplicateWindowSelection(let id):
      .init(code: .invalidParams, message: "duplicate window selection: \(id)", retryable: false)
    case .focusedWorkspaceRequired:
      .init(
        code: .workspaceNotFound, message: "no focused workspace is available", retryable: false)
    case .focusedWindowRequired(let workspace):
      .init(
        code: .windowNotFound, message: "workspace \(workspace) has no focused window",
        retryable: false)
    case .bspWorkspaceRequired(let workspace):
      .init(
        code: .workspaceConflict, message: "workspace \(workspace) is floating", retryable: false)
    case .directionalTargetNotFound(let id, let direction):
      .init(
        code: .workspaceConflict,
        message: "window \(id) has no target to the \(direction.rawValue)", retryable: false)
    case .invalidState(let issues):
      .init(
        code: .invalidWorkspaceState, message: "workspace invariant violation", retryable: false,
        details: ["issues": .array(issues.map { .string(String(describing: $0)) })])
    }
  }
}

private enum WorkspaceRequestError: Error {
  case displayRequired
  case displayNotFound(String)
  case displayAmbiguous
  case workspaceRequired
  case windowRequired
  case windowNotFound(String)
  case transactionRequired
  case invalidReturnMode
  case invalidConfigurationRequest
  case invalidDebugRequest
  case invalidBatch
  case invalidBulk
  case invalidGeometryPolicy

  var code: ErrorCode {
    switch self {
    case .displayRequired, .workspaceRequired: .invalidParams
    case .displayNotFound, .displayAmbiguous: .displayNotFound
    case .windowRequired: .windowNotFound
    case .windowNotFound: .windowNotFound
    case .transactionRequired: .invalidParams
    case .invalidReturnMode, .invalidConfigurationRequest, .invalidDebugRequest: .invalidParams
    case .invalidBatch, .invalidBulk, .invalidGeometryPolicy: .invalidParams
    }
  }

  var message: String {
    switch self {
    case .displayRequired: "no display is available for workspace creation"
    case .displayNotFound(let id): "unknown display: \(id)"
    case .displayAmbiguous: "display selector matched multiple displays"
    case .workspaceRequired: "no focused or named workspace is available"
    case .windowRequired: "no focused window is available"
    case .windowNotFound(let id): "unknown window: \(id)"
    case .transactionRequired: "transaction_id is required"
    case .invalidReturnMode: "return_mode must be completion or instant"
    case .invalidConfigurationRequest: "configuration path, mode, or trigger is invalid"
    case .invalidDebugRequest: "debug request parameters are invalid"
    case .invalidBatch: "batch requires 1...64 mutation commands"
    case .invalidBulk: "bulk requires 1...128 valid window IDs"
    case .invalidGeometryPolicy:
      "geometry policy requires max_geometry_retries from 1...5 or geometry_profile_mode"
    }
  }
}

private enum DaemonLifecycleRequestError: Error { case permissionDenied }

extension WMProtocol.Method {
  fileprivate var isSerializedMutation: Bool {
    isMutation && (!isDebug || self == .geometryCapabilityProbe)
  }

  fileprivate var isMutation: Bool {
    switch self {
    case .windowManage, .windowUnmanage, .windowFocus, .windowMove, .windowFrameSet,
      .workspaceFocus, .workspaceMoveWindow,
      .workspaceMoveWindowBulk, .workspaceMoveDisplay, .workspaceSetMode,
      .layoutPolicySet, .geometryPolicySet, .inventoryRefresh,
      .configurationReload, .commandBatch, .daemonPause, .daemonResume, .debugAXFrameSet,
      .debugAXFocus, .geometryCapabilityProbe,
      .debugEngineSet:
      true
    default: false
    }
  }

  fileprivate var isDebug: Bool {
    switch self {
    case .debugAXFrameGet, .debugAXFrameSet, .debugAXFocus,
      .debugEngineGet, .debugEngineSet:
      true
    default: false
    }
  }

  fileprivate var isIdempotent: Bool {
    switch self {
    case .windowManage, .windowUnmanage, .windowFrameSet, .workspaceFocus, .workspaceMoveDisplay,
      .workspaceSetMode, .layoutPolicySet, .geometryPolicySet, .inventoryRefresh,
      .configurationReload:
      true
    default: false
    }
  }
}

private struct WindowDeltaPayload: Encodable {
  var added: [NormalizedWindow]
  var updated: [NormalizedWindow]
  var removed: [String]
}
private struct DisplayDeltaPayload: Encodable {
  var added: [DisplayObservation]
  var updated: [DisplayObservation]
  var removed: [String]
}

extension ParkedWindowFrame {
  fileprivate init(_ frame: InventoryRect) {
    self.init(x: frame.x, y: frame.y, width: frame.width, height: frame.height)
  }

  fileprivate var inventoryRect: InventoryRect {
    .init(x: x, y: y, width: width, height: height)
  }
}

extension EventTopic {
  fileprivate var isDaemonEvent: Bool {
    switch self {
    case .windowClosed, .workspaceChanged, .workspaceFocused, .workspaceCreated, .workspaceDeleted,
      .workspaceDisplayChanged, .workspaceModeChanged, .daemonPaused, .daemonResumed,
      .sessionResynchronized, .configurationChanged, .healthChanged:
      true
    default: false
    }
  }

  fileprivate var hasWorkspaceSnapshot: Bool {
    switch self {
    case .workspaceChanged, .workspaceFocused, .workspaceCreated, .workspaceDeleted,
      .workspaceDisplayChanged, .workspaceModeChanged:
      true
    default: false
    }
  }
}
