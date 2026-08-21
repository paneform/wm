import Foundation
import Testing
import WMConfiguration
import WMCore
import WMInventory
import WMPersistence
import WMProtocol
import WMWorkspace

@testable import wm

private func daemonHandler() throws -> (DaemonHandler, DaemonHandler.State) {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let scanner = InventoryScanner(
    sources: .init(
      displays: StubDisplays(), accessibility: StubAX(), coreGraphics: StubCG()
    ))
  let state = DaemonHandler.State(provider: SystemInventoryProvider(scanner: scanner))
  return (
    DaemonHandler(
      state: state,
      workspaces: try WorkspaceController(
        buildVersion: "test", stateURL: directory.appendingPathComponent("state.json"))
    ), state
  )
}

private struct StubDisplays: DisplayInventorySource {
  func displays() async -> SourceResult<[DisplayObservation]> {
    .init(
      value: [
        .init(
          id: "display:1", name: "Display", isBuiltin: true, isPrimary: true,
          frame: .init(x: 0, y: 0, width: 1000, height: 800),
          visibleFrame: .init(x: 0, y: 0, width: 1000, height: 800), backingScale: 1,
          identifiers: .init())
      ], health: .init(source: .displays, status: .healthy, permissionGranted: nil))
  }
}

private struct TwoDisplays: DisplayInventorySource {
  func displays() async -> SourceResult<[DisplayObservation]> {
    .init(
      value: [
        .init(
          id: "display:built-in", name: "Built-in Retina Display", isBuiltin: true, isPrimary: true,
          frame: .init(x: 0, y: 0, width: 1000, height: 800),
          visibleFrame: .init(x: 0, y: 0, width: 1000, height: 780), backingScale: 2,
          identifiers: .init(nsscreenNumber: "1", cgDirectDisplayID: "1", uuid: "built-in")
        ),
        .init(
          id: "display:external", name: "Studio Display", isBuiltin: false, isPrimary: false,
          frame: .init(x: 1000, y: 0, width: 1200, height: 900),
          visibleFrame: .init(x: 1000, y: 0, width: 1200, height: 860), backingScale: 2,
          identifiers: .init(nsscreenNumber: "2", cgDirectDisplayID: "7", uuid: "external")
        ),
      ], health: .init(source: .displays, status: .healthy, permissionGranted: nil))
  }
}

private struct StubCG: CoreGraphicsInventorySource {
  func windows() async -> SourceResult<[WMInventory.RawCGWindow]> {
    .init(
      value: [], health: .init(source: .coreGraphics, status: .healthy, permissionGranted: true))
  }
}

private struct WindowCG: CoreGraphicsInventorySource {
  let titles: [String]
  func windows() async -> SourceResult<[WMInventory.RawCGWindow]> {
    .init(
      value: titles.enumerated().map { index, title in
        .init(
          cgWindowID: UInt32(index + 1), pid: 1, ownerName: "Test", title: title,
          layer: 0, alpha: 1, onScreen: true,
          frame: .init(x: Double(index * 100), y: 0, width: 100, height: 100))
      }, health: .init(source: .coreGraphics, status: .healthy, permissionGranted: true))
  }
}

private struct StubAX: AccessibilityInventorySource {
  func applications() async -> SourceResult<[ApplicationObservation]> {
    .init(
      value: [], health: .init(source: .accessibility, status: .healthy, permissionGranted: true))
  }
  func windows(for application: ApplicationObservation) async throws -> [WMInventory.RawAXWindow] {
    []
  }
}

private struct WindowAX: AccessibilityInventorySource {
  let titles: [String]
  func applications() async -> SourceResult<[ApplicationObservation]> {
    .init(
      value: [.init(pid: 1, name: "Test")],
      health: .init(
        source: .accessibility, status: .healthy, permissionGranted: true))
  }
  func windows(for application: ApplicationObservation) async throws -> [WMInventory.RawAXWindow] {
    titles.enumerated().map { index, title in
      .init(
        pid: 1, appName: "Test", bundleID: "com.example.Test", title: title, role: "AXWindow",
        frame: .init(x: Double(index * 100), y: 0, width: 100, height: 100),
        cgWindowID: UInt32(index + 1))
    }
  }
}

private actor EventProbe {
  private var topics: [EventTopic] = []
  func record(_ topic: EventTopic) { topics.append(topic) }
  func contains(_ topic: EventTopic) -> Bool { topics.contains(topic) }
}

private actor ErrorProbe {
  private var messages: [String] = []
  func record(_ message: String) { messages.append(message) }
  func contains(_ text: String) -> Bool { messages.contains { $0.contains(text) } }
}

private struct DeniedAX: AccessibilityInventorySource {
  func applications() async -> SourceResult<[ApplicationObservation]> {
    .init(
      value: [],
      health: .init(source: .accessibility, status: .unhealthy, permissionGranted: false))
  }
  func windows(for application: ApplicationObservation) async throws -> [WMInventory.RawAXWindow] {
    []
  }
}

private actor DirectionalGeometry: WindowGeometryEffects {
  enum Operation: Equatable {
    case set(String)
    case focus(String)
    case park(String)
  }
  var frames: [String: InventoryRect]
  var focused: String?
  var failFocus = false
  var staleWindowIDs: Set<String> = []
  var reconciledWindowIDs: [[String]] = []
  var operations: [Operation] = []

  init(frames: [String: InventoryRect]) { self.frames = frames }
  func setFailFocus(_ value: Bool) { failFocus = value }
  func setStaleWindowIDs(_ ids: Set<String>) { staleWindowIDs = ids }
  func resetOperations() { operations.removeAll(keepingCapacity: true) }
  func reconcile(windows: [NormalizedWindow]) async {
    reconciledWindowIDs.append(windows.map(\.id).sorted())
  }
  func evict(lifetimes: Set<WindowLifetime>) async {}
  func get(window: NormalizedWindow) async throws -> WindowFrameGetResult {
    if staleWindowIDs.contains(window.id) {
      throw WindowGeometryFailure(
        code: .inventoryStale, message: "window inventory identity is stale")
    }
    let frame = frames[window.id] ?? window.frame!
    return .init(windowID: window.id, frame: frame.protocolFrame, observedAt: .init())
  }
  func set(window: NormalizedWindow, params: WindowFrameSetParams) async throws
    -> WindowFrameSetResult
  {
    operations.append(.set(window.id))
    frames[window.id] = .init(
      x: params.frame.x, y: params.frame.y,
      width: params.frame.width, height: params.frame.height)
    return .init(
      windowID: window.id, requestedFrame: params.frame, observedFrame: params.frame,
      verified: true, attempts: 1, strategy: .positionThenSize, durationMilliseconds: 0)
  }
  func setGeometry(window: NormalizedWindow, request: WindowGeometrySetRequest) async throws
    -> WindowGeometrySetOutcome
  {
    operations.append(.set(window.id))
    frames[window.id] = request.frame
    return .init(
      requestedFrame: request.frame, observedFrame: request.frame,
      classification: .exact, attempts: 1, strategy: .positionThenSize)
  }
  func focus(window: NormalizedWindow) async throws {
    if failFocus {
      throw WindowGeometryFailure(code: .geometryVerificationFailed, message: "focus failed")
    }
    operations.append(.focus(window.id))
    focused = window.id
  }
  func fit(window: NormalizedWindow, within frame: InventoryRect) async throws -> InventoryRect {
    frame
  }
  func park(window: NormalizedWindow, frame: InventoryRect) async throws -> InventoryRect {
    operations.append(.park(window.id))
    frames[window.id] = frame
    return frame
  }
  func setPosition(window: NormalizedWindow, frame: InventoryRect) async throws -> InventoryRect {
    operations.append(.set(window.id))
    let original = frames[window.id] ?? window.frame!
    let positioned = InventoryRect(
      x: frame.x, y: frame.y, width: original.width, height: original.height)
    frames[window.id] = positioned
    return positioned
  }
  func setPositionAllowingClamping(window: NormalizedWindow, frame: InventoryRect) async throws
    -> InventoryRect
  {
    try await setPosition(window: window, frame: frame)
  }
  func probeCapabilities(window: NormalizedWindow) async throws -> GeometryCapabilityProbeResult {
    let frame = (frames[window.id] ?? window.frame!).protocolFrame
    return .init(
      windowID: window.id, originalFrame: frame, finalFrame: frame,
      position: .init(confirmed: .supported), size: .init(confirmed: .fixed), attempts: [],
      restoration: .init(attempted: true, succeeded: true, verified: true))
  }
}

private func clientMessage(_ message: ClientMessage) throws -> String {
  String(data: try ProtocolCodec.encode(message), encoding: .utf8)!
}

private func response(_ text: String) throws -> Response {
  guard
    case .response(let response) = try ProtocolCodec.decode(
      ServerMessage.self, from: Data(text.utf8))
  else {
    throw CancellationError()
  }
  return response
}

@Test func fittedFrameOnlyContributesDimensionsThatExceedTile() {
  let target = WorkspaceLayoutRect(x: 0, y: 32, width: 756, height: 950)

  #expect(
    DaemonHandler.constrainedMinimum(
      fitted: .init(x: 0, y: 32, width: 1512, height: 950), target: target
    ) == .init(width: 1512, height: 0))
  #expect(
    DaemonHandler.constrainedMinimum(
      fitted: .init(x: 0, y: 32, width: 756, height: 950), target: target
    ) == .init())
}

@Test func workspaceGeometryPolicyTranslatesToEngineRetryPolicy() {
  #expect(
    DaemonHandler.geometryRetryPolicy(retries: 2, mode: .store)
      == .init(
        maximumAttempts: 2, mode: .storeAndReuse
      ))
  #expect(
    DaemonHandler.geometryRetryPolicy(retries: 3, mode: .infer)
      == .init(
        maximumAttempts: 3, mode: .inferEveryRequest
      ))
  #expect(
    DaemonHandler.geometryRetryPolicy(retries: 5, mode: .optimistic)
      == .init(
        maximumAttempts: 5, mode: .optimisticIdealFirst
      ))
}

@Test func pendingParkingSurvivesRawInventoryRefresh() throws {
  let window = NormalizedWindow(
    id: "window:1", pid: 1, appName: "Test",
    frame: .init(x: 0, y: 0, width: 100, height: 100), classification: .normal,
    management: .unmanaged, rejectionReasons: [], joinConfidence: .exact, joinSignals: [],
    health: .healthy, healthIssues: [])
  var retained = window
  retained.management = .managed
  let workspace = WMWorkspace.WorkspaceState(workspaces: [
    .init(
      name: "hidden", origin: .runtime, displayID: "display:1", visible: false,
      windowIDs: [window.id])
  ])
  let lifetime = WindowLifetime(windowID: window.id, pid: window.pid)

  let pending = DaemonHandler.reconciledPendingParking(
    [lifetime], state: workspace,
    inventory: InventorySnapshot(
      timestamp: .init(), durationMilliseconds: 0, displays: [], rawAXWindows: [], rawCGWindows: [],
      windows: [window], rejectedAXWindows: [], joinDecisions: [], sourceHealth: [], appScans: []),
    retainedWindows: [window.id: retained])

  #expect(pending == [lifetime])
}

@Test func committedParkingAuditUsesRetainedManagementAuthority() {
  var raw = inventory(["window:1"])
  raw.windows[0].management = .unmanaged
  var retained = raw.windows[0]
  retained.management = .managed
  var state = WorkspaceState()
  _ = try? state.focusWorkspace(named: "hidden", displayID: "display:1")
  _ = try? state.adoptUnassignedWindows([retained.id], displayID: "display:1")
  _ = try? state.focusWorkspace(named: "visible", displayID: "display:1")

  #expect(
    WorkspaceIntentAudit(
      state: state, inventory: raw, retainedWindows: [retained.id: retained]
    ).park == [retained.id])

  retained.pid += 1
  #expect(
    WorkspaceIntentAudit(
      state: state, inventory: raw, retainedWindows: [retained.id: retained]
    ).park.isEmpty)
  retained.pid = raw.windows[0].pid
  retained.management = .unmanaged
  #expect(
    WorkspaceIntentAudit(
      state: state, inventory: raw, retainedWindows: [retained.id: retained]
    ).park.isEmpty)
}

@Test func parkingProbeUsesRawObservationAndRetainedManagementAuthority() async throws {
  let (handler, _) = try daemonHandler()
  var raw = inventory(["window:1"])
  raw.windows[0].management = .unmanaged
  raw.windows[0].frame = .init(x: 10, y: 20, width: 300, height: 200)
  let lifetime = WindowLifetime(windowID: raw.windows[0].id, pid: raw.windows[0].pid)
  var retained = raw.windows[0]
  retained.management = .managed
  retained.frame = .init(x: 1, y: 2, width: 3, height: 4)
  try await handler.reconcileObservedWindows(lifecycleInventory(retained), displayID: "display:1")

  let probe = await handler.parkingProbe(for: lifetime, inventory: raw)

  #expect(probe?.management == .managed)
  #expect(probe?.frame == raw.windows[0].frame)

  var wrongPID = raw
  wrongPID.windows[0].pid += 1
  #expect(await handler.parkingProbe(for: lifetime, inventory: wrongPID) == nil)

  let (unmanagedHandler, _) = try daemonHandler()
  #expect(await unmanagedHandler.parkingProbe(for: lifetime, inventory: raw) == nil)
}

@Test func inactiveGeometryIsNotAuthoritativeExternalFocus() {
  var inactive = recoveryWindow(id: "inactive", bundleID: "test", displayID: "display:1")
  inactive.pid = 10
  inactive.focused = true

  #expect(
    !DaemonHandler.isAuthoritativeExternalFocus(
      windowID: inactive.id, frontmostPID: nil, windows: [inactive]))
  #expect(
    !DaemonHandler.isAuthoritativeExternalFocus(
      windowID: inactive.id, frontmostPID: 20, windows: [inactive]))
  #expect(
    DaemonHandler.isAuthoritativeExternalFocus(
      windowID: inactive.id, frontmostPID: inactive.pid, windows: [inactive]))
}

@Test func authoritativeParkingAuditIncludesEveryHiddenWorkspace() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: directory) }
  let controller = try WorkspaceController(
    buildVersion: "test", stateURL: directory.appendingPathComponent("state.json"))
  let state = WorkspaceState(
    workspaces: [
      .init(
        name: "visible", origin: .configured, displayID: "display:1", visible: true,
        focused: true, windowIDs: ["visible"], bsp: .init(root: .leaf(windowID: "visible"))),
      .init(
        name: "hidden-a", origin: .configured, displayID: "display:1",
        windowIDs: ["hidden-a"], bsp: .init(root: .leaf(windowID: "hidden-a"))),
      .init(
        name: "hidden-b", origin: .configured, displayID: "display:2",
        windowIDs: ["hidden-b"], bsp: .init(root: .leaf(windowID: "hidden-b"))),
    ], focusedWorkspaceName: "visible",
    displays: ["display:1": .init(visibleWorkspaceName: "visible")])
  try await controller.commit(state)
  let handler = DaemonHandler(
    state: .init(
      provider: SystemInventoryProvider(
        scanner: .init(
          sources: .init(
            displays: StubDisplays(), accessibility: StubAX(), coreGraphics: StubCG())))),
    workspaces: controller)
  let windows = ["visible", "hidden-a", "hidden-b"].map {
    recoveryWindow(id: $0, bundleID: "test", displayID: nil)
  }
  try await handler.reconcileObservedWindows(lifecycleInventory(windows), displayID: "display:1")

  let audit = await handler.authoritativeParkingLifetimes(
    state: state, inventory: lifecycleInventory(windows))

  #expect(
    audit == [
      WindowLifetime(windowID: "hidden-a", pid: 1),
      WindowLifetime(windowID: "hidden-b", pid: 1),
    ])
}

@Test func debugEngineSwitchIsInspectableAndMutable() async throws {
  let (handler, state) = try daemonHandler()
  _ = try await state.refresh()
  let client = UUID()

  let disabled = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "disable", method: .debugEngineSet,
          params: ["automatic_reconciliation": .bool(false)]
        ))), clientID: client)
  let disabledResult = try #require(try response(disabled[0]).result)
  #expect(disabledResult == .object(["automatic_reconciliation": .bool(false)]))

  let status = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "status", method: .debugEngineGet
        ))), clientID: client)
  #expect(try response(status[0]).result == .object(["automatic_reconciliation": .bool(false)]))
}

@Test func daemonShutdownBeginsTerminationAndRequestsProcessExit() async throws {
  let (handler, state) = try daemonHandler()
  _ = try await state.refresh()
  actor Probe {
    var requested = false
    func mark() { requested = true }
  }
  let probe = Probe()
  await handler.installShutdownRequest { Task { await probe.mark() } }
  let replies = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "shutdown", method: .daemonShutdown
        ))), clientID: UUID())
  #expect(try response(replies[0]).result == .object(["shutting_down": .bool(true)]))
  for _ in 0..<100 where !(await probe.requested) { await Task.yield() }
  #expect(await probe.requested)
  let mutation = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "pause", method: .daemonPause
        ))), clientID: UUID())
  #expect(try response(mutation[0]).error != nil)
}

@Test func pauseTogglePausesThenResumesWithReconciliation() async throws {
  let (handler, state) = try daemonHandler()
  _ = try await state.refresh()
  let client = UUID()
  let pause = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "pause", method: .daemonPause, params: ["toggle": .bool(true)]
        ))), clientID: client)
  #expect(try response(pause[0]).result == .object(["paused": .bool(true)]))
  #expect(await handler.isPaused())

  let resume = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "resume", method: .daemonPause, params: ["toggle": .bool(true)]
        ))), clientID: client)
  #expect(
    try response(resume[0]).result
      == .object([
        "paused": .bool(false), "reconciled": .bool(true),
      ]))
  #expect(await !handler.isPaused())
}

@Test func geometryProbeIsBlockedWhilePaused() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let scanner = InventoryScanner(
    sources: .init(
      displays: StubDisplays(), accessibility: WindowAX(titles: ["One"]),
      coreGraphics: WindowCG(titles: ["One"])))
  let state = DaemonHandler.State(provider: SystemInventoryProvider(scanner: scanner))
  let handler = DaemonHandler(
    state: state,
    workspaces: try WorkspaceController(
      buildVersion: "test", stateURL: directory.appendingPathComponent("state.json")))
  let snapshot = try await state.refresh()
  let id = try #require(snapshot.snapshot.inventory.windows.first?.id)
  let client = UUID()
  let paused = await handler.handle(
    text: try clientMessage(.request(.init(requestId: "pause", method: .daemonPause))),
    clientID: client)
  #expect(try response(paused[0]).result == .object(["paused": .bool(true)]))
  #expect(await handler.isPaused())
  let replies = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "probe", method: .geometryCapabilityProbe, params: ["window_id": .string(id)]))
    ), clientID: client)
  let probeResponse = try response(replies[0])
  #expect(probeResponse.error?.code == .paused)
}

@Test func verifiedProbeImmediatelyFloatsWindowAndProfilesFutureMatch() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: directory) }
  let scanner = InventoryScanner(
    sources: .init(
      displays: StubDisplays(), accessibility: WindowAX(titles: ["One"]),
      coreGraphics: WindowCG(titles: ["One"])))
  let state = DaemonHandler.State(provider: SystemInventoryProvider(scanner: scanner))
  let workspaces = try WorkspaceController(
    buildVersion: "test", stateURL: directory.appendingPathComponent("state.json"))
  let geometry = DirectionalGeometry(frames: [:])
  let profiles = WindowGeometryProfileRecorder()
  let handler = DaemonHandler(
    state: state, workspaces: workspaces, geometryProfiles: profiles, geometryEffects: geometry)
  let observedInventory = try await state.refresh().snapshot.inventory
  let window = try #require(observedInventory.windows.first)
  try await handler.reconcileObservedWindows(observedInventory, displayID: "display:main")

  let replies = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "probe", method: .geometryCapabilityProbe,
          params: ["window_id": .string(window.id), "return_mode": .string("completion")]))),
    clientID: UUID())
  #expect(try response(replies[0]).error == nil)
  let workspace = try #require(await workspaces.snapshot().workspaces.first)
  #expect(workspace.windowIDs == [window.id])
  #expect(workspace.floatingWindowIDs == [window.id])
  #expect(workspace.bsp.root == nil)

  try await handler.reconcilePeriodicObservation(
    observedInventory, displayID: "display:main", focusedWindowID: nil,
    frontmostPID: nil)
  let periodicWorkspace = try #require(await workspaces.snapshot().workspaces.first)
  #expect(periodicWorkspace.floatingWindowIDs == [window.id])
  #expect(periodicWorkspace.bsp.root == nil)

  let focus = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "focus", method: .workspaceFocus,
          params: ["name": .string(periodicWorkspace.name), "return_mode": .string("completion")]))),
    clientID: UUID())
  #expect(try response(focus[0]).error == nil)
  let focusedWorkspace = try #require(await workspaces.snapshot().workspaces.first)
  #expect(focusedWorkspace.floatingWindowIDs == [window.id])
  #expect(focusedWorkspace.bsp.root == nil)

  var future = window
  future.id = "future"
  future.pid += 1
  future.geometryCapabilities = .init()
  var futureInventory = inventory([])
  futureInventory.windows = [future]
  let merged = await profiles.mergingCapabilities(into: futureInventory)
  #expect(
    WindowCapabilityPolicy.admission(for: merged.windows[0].geometryCapabilities) == .floating)
}

@Test func geometryPolicyRuntimeUpdatesGlobalAndWorkspaceSettings() async throws {
  let (handler, state) = try daemonHandler()
  let inventory = try await state.refresh().snapshot.inventory
  _ = try await handler.loadConfiguration(
    source: #"{"workspaces":[{"name":"T"}]}"#, inventory: inventory)

  for (id, params, expected) in [
    (
      "global",
      [
        "max_geometry_retries": JSONValue.number(3), "geometry_profile_mode": .string("infer"),
        "return_mode": .string("completion"),
      ],
      JSONValue.object([
        "workspace": .null, "max_geometry_retries": .number(3),
        "geometry_profile_mode": .string("infer"),
      ])
    ),
    (
      "workspace",
      [
        "workspace": .string("T"), "geometry_profile_mode": .string("optimistic"),
        "return_mode": .string("completion"),
      ],
      .object([
        "workspace": .string("T"), "max_geometry_retries": .number(3),
        "geometry_profile_mode": .string("optimistic"),
      ])
    ),
  ] {
    let replies = await handler.handle(
      text: try clientMessage(
        .request(
          .init(
            requestId: id, method: .geometryPolicySet, params: params
          ))), clientID: UUID())
    let receipt = try #require(try response(replies[0]).result)
    guard case .object(let object) = receipt else {
      Issue.record("expected transaction receipt")
      continue
    }
    #expect(object["result"] == expected)
  }
}

@Test func configurationAppliesWorkspaceLayoutSettingsAtRuntime() async throws {
  let (handler, state) = try daemonHandler()
  let inventory = try await state.refresh().snapshot.inventory
  _ = try await handler.loadConfiguration(
    source: #"""
      {
        "defaults":{"mode":"floating","margin":{"top":1,"right":2,"bottom":3,"left":4},"gap":6,"resize_increment":7},
        "workspaces":[{"name":"T","preferred_display":"display:1","gap":8}]
      }
      """#, inventory: inventory)
  let client = UUID()
  let replies = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "list", method: .workspaceList
        ))), clientID: client)
  let result = try #require(try response(replies[0]).result)
  let data = try ProtocolCodec.encode(result)
  let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
  let workspaces = try #require(object["workspaces"] as? [[String: Any]])
  let workspace = try #require(workspaces.first { $0["name"] as? String == "T" })
  #expect(workspace["mode"] as? String == "floating")
  #expect(workspace["gap"] as? Double == 8)
  #expect(workspace["resize_increment"] as? Double == 7)
  #expect(workspace["preferred_display_id"] as? String == "display:1")
  #expect(
    workspace["margin"] as? [String: Double] == ["top": 1, "right": 2, "bottom": 3, "left": 4])
}

@Test func configurationReloadClearsWorkspaceLayoutPolicyOverride() async throws {
  let (handler, state) = try daemonHandler()
  let inventory = try await state.refresh().snapshot.inventory
  _ = try await handler.loadConfiguration(
    source:
      #"{"defaults":{"layout_policy":["greedy","stack","overflow"]},"workspaces":[{"name":"T"}]}"#,
    inventory: inventory)

  _ = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "override", method: .layoutPolicySet,
          params: [
            "workspace": .string("T"), "policy": .array([.string("overlap")]),
            "return_mode": .string("completion"),
          ]
        ))), clientID: UUID())
  _ = try await handler.hotloadConfiguration(
    source:
      #"{"defaults":{"gap":1,"layout_policy":["greedy","stack","overflow"]},"workspaces":[{"name":"T"}]}"#,
    inventory: inventory)

  let replies = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "list", method: .workspaceList
        ))), clientID: UUID())
  let result = try #require(try response(replies[0]).result)
  let data = try ProtocolCodec.encode(result)
  let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
  let workspaces = try #require(object["workspaces"] as? [[String: Any]])
  let workspace = try #require(workspaces.first { $0["name"] as? String == "T" })
  #expect(workspace["layout_policy"] as? [String] == ["greedy", "stack", "overflow"])
}

@Test func displayListIsConciseUnlessVerbose() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let state = DaemonHandler.State(
    provider: SystemInventoryProvider(
      scanner: .init(
        sources: .init(
          displays: TwoDisplays(), accessibility: StubAX(), coreGraphics: StubCG()
        ))))
  let handler = DaemonHandler(
    state: state,
    workspaces: try WorkspaceController(
      buildVersion: "test", stateURL: directory.appendingPathComponent("state.json"))
  )
  _ = try await state.refresh()

  let concise = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "concise", method: .displayList, params: ["verbose": .bool(false)]
        ))), clientID: UUID())
  let conciseResult = try #require(try response(concise[0]).result)
  let conciseJSON = try #require(
    JSONSerialization.jsonObject(with: ProtocolCodec.encode(conciseResult)) as? [String: Any])
  let displays = try #require(conciseJSON["displays"] as? [[String: Any]])
  #expect(displays[0]["core_graphics_display_id"] as? String == "1")
  #expect(displays[0]["frame"] == nil)

  let verbose = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "verbose", method: .displayList, params: ["verbose": .bool(true)]
        ))), clientID: UUID())
  let verboseResult = try #require(try response(verbose[0]).result)
  let verboseJSON = try #require(
    JSONSerialization.jsonObject(with: ProtocolCodec.encode(verboseResult)) as? [String: Any])
  #expect(((verboseJSON["displays"] as? [[String: Any]])?.first?["frame"] as? [String: Any]) != nil)
}

@Test func workspaceMoveResolvesDisplayIdentifiers() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let state = DaemonHandler.State(
    provider: SystemInventoryProvider(
      scanner: .init(
        sources: .init(
          displays: TwoDisplays(), accessibility: StubAX(), coreGraphics: StubCG()
        ))))
  let handler = DaemonHandler(
    state: state,
    workspaces: try WorkspaceController(
      buildVersion: "test", stateURL: directory.appendingPathComponent("state.json"))
  )
  let inventory = try await state.refresh().snapshot.inventory
  _ = try await handler.loadConfiguration(
    source: #"{"workspaces":[{"name":"T"}]}"#, inventory: inventory)

  for (key, value) in [
    ("core_graphics_display_id", "7"), ("ns_screen_number", "2"), ("name", "Studio Display"),
  ] {
    let replies = await handler.handle(
      text: try clientMessage(
        .request(
          .init(
            requestId: key, method: .workspaceMoveDisplay,
            params: [
              "workspace": .string("T"), "display_selector": .object([key: .string(value)]),
            ]
          ))), clientID: UUID())
    #expect(try response(replies[0]).error == nil)
  }
}

@Test func workspaceMoveNextDefaultsToFocusedAndWraps() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let state = DaemonHandler.State(
    provider: SystemInventoryProvider(
      scanner: .init(
        sources: .init(
          displays: TwoDisplays(), accessibility: StubAX(), coreGraphics: StubCG()
        ))))
  let controller = try WorkspaceController(
    buildVersion: "test", stateURL: directory.appendingPathComponent("state.json")
  )
  let handler = DaemonHandler(state: state, workspaces: controller)
  let inventory = try await state.refresh().snapshot.inventory
  _ = try await handler.loadConfiguration(
    source: #"{"workspaces":[{"name":"T"}]}"#, inventory: inventory)
  _ = try await controller.focus(name: "T", displayID: "display:built-in")

  for expected in ["display:external", "display:built-in"] {
    let replies = await handler.handle(
      text: try clientMessage(
        .request(
          .init(
            requestId: expected, method: .workspaceMoveDisplay,
            params: [
              "next": .bool(true), "return_mode": .string("completion"),
            ]
          ))), clientID: UUID())
    let value = try response(replies[0])
    #expect(value.error == nil, Comment(rawValue: value.error?.message ?? expected))
    #expect(
      await controller.snapshot()[workspace: "T"]?.displayID == expected,
      Comment(rawValue: expected))
  }
}

@Test func directionalWindowCommandsVerifyPersistAndRemainAtomicOnFailure() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let controller = try WorkspaceController(
    buildVersion: "test", stateURL: directory.appendingPathComponent("state.json"))
  try await controller.commit(
    .init(
      workspaces: [
        .init(
          name: "T", origin: .configured, displayID: "display:1", visible: true, focused: true,
          windowIDs: ["left", "right"], focusedWindowID: "right",
          bsp: .init(
            root: .split(
              axis: .vertical, ratio: 0.5,
              first: .leaf(windowID: "left"), second: .leaf(windowID: "right"))))
      ],
      focusedWorkspaceName: "T", displays: ["display:1": .init(visibleWorkspaceName: "T")]))
  let geometry = DirectionalGeometry(frames: [
    "left": .init(x: 0, y: 0, width: 496, height: 800),
    "right": .init(x: 504, y: 0, width: 496, height: 800),
  ])
  let state = DaemonHandler.State(
    provider: SystemInventoryProvider(
      scanner: .init(
        sources: .init(
          displays: StubDisplays(), accessibility: StubAX(), coreGraphics: StubCG()))))
  let handler = DaemonHandler(state: state, workspaces: controller, geometryEffects: geometry)
  _ = try await state.refresh()
  let windows = [
    recoveryWindow(id: "left", bundleID: "test", displayID: "display:1"),
    recoveryWindow(id: "right", bundleID: "test", displayID: "display:1"),
  ]
  try await handler.reconcileObservedWindows(lifecycleInventory(windows), displayID: "display:1")

  let focusReply = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "focus", method: .windowFocus,
          params: ["direction": .string("left"), "return_mode": .string("completion")]
        ))), clientID: UUID())
  #expect(try response(focusReply[0]).error == nil)
  #expect(await controller.snapshot()[workspace: "T"]?.focusedWindowID == "left")
  #expect(await geometry.focused == "left")

  let committed = await controller.snapshot()
  await geometry.setFailFocus(true)
  let failedMove = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "move", method: .windowMove,
          params: ["direction": .string("right"), "return_mode": .string("completion")]
        ))), clientID: UUID())
  let failedReceipt = try #require(try response(failedMove[0]).result)
  guard case .object(let failedObject) = failedReceipt,
    case .object(let transaction)? = failedObject["transaction"],
    case .object(let failure)? = transaction["failure"]
  else {
    Issue.record("expected failed transaction receipt")
    return
  }
  #expect(failure["code"] == .string("geometry_verification_failed"))
  #expect(await controller.snapshot() == committed)
}

@Test func moveWindowFollowsAndTilesWithoutParkingMovedWindow() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let controller = try WorkspaceController(
    buildVersion: "test", stateURL: directory.appendingPathComponent("state.json"))
  try await controller.commit(
    .init(
      workspaces: [
        .init(
          name: "source", origin: .configured, displayID: "display:1", visible: true, focused: true,
          windowIDs: ["window:cg:1", "window:cg:2"], focusedWindowID: "window:cg:1",
          bsp: .init(
            root: .split(
              axis: .vertical, ratio: 0.5,
              first: .leaf(windowID: "window:cg:1"), second: .leaf(windowID: "window:cg:2")))),
        .init(
          name: "destination", origin: .configured, displayID: "display:1",
          windowIDs: ["window:cg:3"], focusedWindowID: "window:cg:3",
          bsp: .init(root: .leaf(windowID: "window:cg:3"))),
      ], focusedWorkspaceName: "source",
      displays: ["display:1": .init(visibleWorkspaceName: "source")]))
  let geometry = DirectionalGeometry(frames: [
    "window:cg:1": .init(x: 0, y: 0, width: 500, height: 800),
    "window:cg:2": .init(x: 500, y: 0, width: 500, height: 800),
    "window:cg:3": .init(x: 0, y: 0, width: 1000, height: 800),
  ])
  let state = DaemonHandler.State(
    provider: SystemInventoryProvider(
      scanner: .init(
        sources: .init(
          displays: StubDisplays(),
          accessibility: WindowAX(titles: ["moving", "peer", "resident"]),
          coreGraphics: WindowCG(titles: ["moving", "peer", "resident"])))))
  let handler = DaemonHandler(state: state, workspaces: controller, geometryEffects: geometry)
  _ = try await state.refresh()
  let windows = ["window:cg:1", "window:cg:2", "window:cg:3"].map {
    recoveryWindow(id: $0, bundleID: "test", displayID: "display:1")
  }
  try await handler.reconcileObservedWindows(lifecycleInventory(windows), displayID: "display:1")

  let replies = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "move", method: .workspaceMoveWindow,
          params: [
            "workspace": .string("destination"), "window_ids": .array([.string("window:cg:1")]),
            "return_mode": .string("completion"),
          ]
        ))), clientID: UUID())

  let reply = try response(replies[0])
  #expect(reply.error == nil)
  if case .object(let result)? = reply.result,
    case .object(let transaction)? = result["transaction"]
  {
    #expect(transaction["failure"] == nil)
  }
  let committed = await controller.snapshot()
  #expect(committed.focusedWorkspaceName == "destination")
  #expect(committed[workspace: "source"]?.windowIDs == ["window:cg:2"])
  #expect(committed[workspace: "destination"]?.windowIDs == ["window:cg:3", "window:cg:1"])
  let operations = await geometry.operations
  #expect(
    operations.prefix(3) == [.set("window:cg:1"), .set("window:cg:3"), .focus("window:cg:1")])
  #expect(!operations.contains(.park("window:cg:1")))

  let observed = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "observe", method: .observeWorkspace,
          params: ["name": .string("destination")]
        ))), clientID: UUID())
  guard case .object(let result)? = try response(observed[0]).result,
    case .array(let reports)? = result["windows"],
    case .object(let moved)? = reports.last,
    case .object(let expected)? = moved["expected"]
  else {
    Issue.record("expected workspace observation")
    return
  }
  #expect(expected["management"] == .string("managed"))
  guard case .object(let health)? = result["health"] else {
    Issue.record("expected workspace health")
    return
  }
  #expect(health["status"] == .string("healthy"))
}

@Test func configurationResolvesDisplayAffinitySelectors() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let state = DaemonHandler.State(
    provider: SystemInventoryProvider(
      scanner: .init(
        sources: .init(
          displays: TwoDisplays(), accessibility: StubAX(), coreGraphics: StubCG()
        ))))
  let controller = try WorkspaceController(
    buildVersion: "test", stateURL: directory.appendingPathComponent("state.json")
  )
  let handler = DaemonHandler(state: state, workspaces: controller)
  let inventory = try await state.refresh().snapshot.inventory

  _ = try await handler.loadConfiguration(
    source: #"""
      {
        "workspaces":[
          {"name":"cg","preferred_display":{"core_graphics_display_id":"7"}},
          {"name":"ns","preferred_display":{"ns_screen_number":"2"}},
          {"name":"named","preferred_display":{"name":"Studio Display"}}
        ]
      }
      """#, inventory: inventory)

  let workspaceState = await controller.snapshot()
  #expect(workspaceState[workspace: "cg"]?.displayID == "display:external")
  #expect(workspaceState[workspace: "ns"]?.displayID == "display:external")
  #expect(workspaceState[workspace: "named"]?.displayID == "display:external")
}

@Test func displayLayoutOverridesApplyAfterWorkspaceSettings() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let state = DaemonHandler.State(
    provider: SystemInventoryProvider(
      scanner: .init(
        sources: .init(
          displays: TwoDisplays(), accessibility: StubAX(), coreGraphics: StubCG()
        ))))
  let controller = try WorkspaceController(
    buildVersion: "test", stateURL: directory.appendingPathComponent("state.json")
  )
  let handler = DaemonHandler(state: state, workspaces: controller)
  let inventory = try await state.refresh().snapshot.inventory

  _ = try await handler.loadConfiguration(
    source: #"""
      {
        "defaults":{"margin":{"top":1,"right":2,"bottom":3,"left":4},"gap":5},
        "displays":[{"display":{"ns_screen_number":"2"},"margin":{"top":20,"left":40},"gap":12}],
        "workspaces":[{"name":"T","preferred_display":{"name":"Studio Display"},"margin":{"right":8}}]
      }
      """#, inventory: inventory)

  let workspace = await controller.snapshot()[workspace: "T"]
  #expect(workspace?.displayID == "display:external")
  #expect(workspace?.margin == .init(top: 20, right: 8, bottom: 3, left: 40))
  #expect(workspace?.gap == 12)
}

@Test func movedWorkspaceReappliesDestinationDisplayOverrides() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let controller = try WorkspaceController(
    buildVersion: "test", stateURL: directory.appendingPathComponent("state.json")
  )
  let displays = await TwoDisplays().displays().value
  let configuration = try ConfigurationParser.parse(
    #"""
    {
      "displays":[{"display":{"ns_screen_number":"2"},"margin":{"top":32}}],
      "workspaces":[{"name":"B","preferred_display":"display:1"}]
    }
    """#)
  let configured = await controller.configuredState(
    configuration, defaultDisplayID: "display:1", displays: displays
  )
  var source = configured
  _ = try source.focusWorkspace(named: "B", displayID: "display:1")
  try await controller.commit(source)

  var moved = try await controller.previewMoveWorkspace("B", to: "display:external")
  moved.workspaceState = await controller.configuredState(
    configuration, defaultDisplayID: "display:external", displays: displays,
    state: moved.workspaceState
  )
  #expect(moved.workspaceState[workspace: "B"]?.margin.top == 32)

  var returned = moved.workspaceState
  _ = try returned.moveWorkspace(named: "B", to: "display:1")
  returned = await controller.configuredState(
    configuration, defaultDisplayID: "display:1", displays: displays, state: returned
  )
  #expect(returned[workspace: "B"]?.margin.top == 0)
}

@Test func wildcardDisplayLayoutOverridesApplyToEveryConnectedDisplay() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let state = DaemonHandler.State(
    provider: SystemInventoryProvider(
      scanner: .init(
        sources: .init(
          displays: TwoDisplays(), accessibility: StubAX(), coreGraphics: StubCG()
        ))))
  let controller = try WorkspaceController(
    buildVersion: "test", stateURL: directory.appendingPathComponent("state.json")
  )
  let handler = DaemonHandler(state: state, workspaces: controller)
  let inventory = try await state.refresh().snapshot.inventory

  _ = try await handler.loadConfiguration(
    source: #"""
      {
        "displays":[{"display":"*","margin":{"top":8,"right":8,"bottom":8,"left":8},"gap":8}],
        "workspaces":[{"name":"external","preferred_display":"display:external"}]
      }
      """#, inventory: inventory)

  let workspaces = await controller.snapshot().workspaces
  #expect(workspaces.allSatisfy { $0.margin == .init(top: 8, right: 8, bottom: 8, left: 8) })
  #expect(workspaces.allSatisfy { $0.gap == 8 })
}

@Test func configurationFallsBackFromUnknownDisplayAndResetsRemovedSettings() async throws {
  let (handler, state) = try daemonHandler()
  let inventory = try await state.refresh().snapshot.inventory
  _ = try await handler.loadConfiguration(
    source: #"""
      {"defaults":{"gap":9,"margin":{"left":4}},"workspaces":[{"name":"T","preferred_display":"missing"}]}
      """#, inventory: inventory)
  _ = try await handler.loadConfiguration(
    source: #"""
      {"workspaces":[{"name":"T"}]}
      """#, inventory: inventory)
  let replies = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "list", method: .workspaceList
        ))), clientID: UUID())
  let result = try #require(try response(replies[0]).result)
  let object = try #require(
    JSONSerialization.jsonObject(with: ProtocolCodec.encode(result)) as? [String: Any])
  let workspace = try #require((object["workspaces"] as? [[String: Any]])?.first)
  #expect(workspace["display_id"] as? String == "display:1")
  #expect(workspace["preferred_display_id"] == nil)
  #expect(workspace["gap"] as? Double == 0)
  #expect(
    workspace["margin"] as? [String: Double] == ["top": 0, "right": 0, "bottom": 0, "left": 0])
}

@Test func daemonSubscriptionsUnsubscribeExactlyByID() async throws {
  let (handler, _) = try daemonHandler()
  let client = UUID()
  await handler.installSender { _, _ in }
  _ = await handler.handle(
    text: try clientMessage(
      .subscribe(
        .init(
          requestId: "one", subscriptionId: "one", topics: [.configurationChanged]
        ))), clientID: client)
  _ = await handler.handle(
    text: try clientMessage(
      .subscribe(
        .init(
          requestId: "two", subscriptionId: "two", topics: [.configurationChanged]
        ))), clientID: client)
  let unsubscribe = await handler.handle(
    text: try clientMessage(
      .unsubscribe(
        .init(
          requestId: "remove", subscriptionId: "one"
        ))), clientID: client)

  #expect(try response(unsubscribe[0]).error == nil)
  let secondUnsubscribe = await handler.handle(
    text: try clientMessage(
      .unsubscribe(
        .init(
          requestId: "missing", subscriptionId: "one"
        ))), clientID: client)
  #expect(try response(secondUnsubscribe[0]).error?.code == .subscriptionNotFound)
}

@Test func mixedRoutingFamiliesAreRejectedWithoutRegistration() async throws {
  let (handler, _) = try daemonHandler()
  let client = UUID()
  let replies = await handler.handle(
    text: try clientMessage(
      .subscribe(
        .init(
          requestId: "mixed", subscriptionId: "mixed",
          topics: [.configurationChanged, .windowInventory]
        ))), clientID: client)

  #expect(try response(replies[0]).error?.code == .invalidParams)
  let unsubscribe = await handler.handle(
    text: try clientMessage(
      .unsubscribe(
        .init(
          requestId: "remove", subscriptionId: "mixed"
        ))), clientID: client)
  #expect(try response(unsubscribe[0]).error?.code == .subscriptionNotFound)
}

@Test func sessionHealthUsesTheSameHealthSubscriptionRoute() async throws {
  let (handler, _) = try daemonHandler()
  let client = UUID()
  let events = EventProbe()
  await handler.installSender { text, _ in
    guard
      case .event(let event) = try? ProtocolCodec.decode(ServerMessage.self, from: Data(text.utf8))
    else { return }
    Task { await events.record(event.topic) }
  }
  _ = await handler.handle(
    text: try clientMessage(
      .subscribe(
        .init(
          requestId: "health", subscriptionId: "health", topics: [.healthChanged]
        ))), clientID: client)

  try await handler.resynchronizeSession(.wake)
  await Task.yield()
  #expect(await events.contains(.healthChanged))
}

@Test func failedSessionResynchronizationReportsCauseAndError() async {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let state = DaemonHandler.State(
    provider: SystemInventoryProvider(
      scanner: .init(
        sources: .init(
          displays: StubDisplays(), accessibility: DeniedAX(), coreGraphics: StubCG()
        ))))
  let handler = try? DaemonHandler(
    state: state,
    workspaces: WorkspaceController(
      buildVersion: "test", stateURL: directory.appendingPathComponent("state.json"))
  )
  guard let handler else {
    Issue.record("failed to create daemon handler")
    return
  }
  let errors = ErrorProbe()
  await handler.installInternalErrorReporter { message in
    Task { await errors.record(message) }
  }

  do {
    try await handler.resynchronizeSession(.wake)
    Issue.record("expected session resynchronization to fail")
  } catch {}
  for _ in 0..<100 where !(await errors.contains("cause: wake")) { await Task.yield() }
  #expect(await errors.contains("cause: wake"))
  #expect(await errors.contains("permissionDenied"))
  #expect(await handler.isPaused())
}

@Test func configurationHealthUsesTheSameHealthSubscriptionRoute() async throws {
  let (handler, state) = try daemonHandler()
  let client = UUID()
  let events = EventProbe()
  await handler.installSender { text, _ in
    guard
      case .event(let event) = try? ProtocolCodec.decode(ServerMessage.self, from: Data(text.utf8))
    else { return }
    Task { await events.record(event.topic) }
  }
  _ = await handler.handle(
    text: try clientMessage(
      .subscribe(
        .init(
          requestId: "health", subscriptionId: "health", topics: [.healthChanged]
        ))), clientID: client)
  _ = try await state.refresh()
  let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try Data(#"{"workspaces":[]}"#.utf8).write(to: path)
  defer { try? FileManager.default.removeItem(at: path) }

  _ = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
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
    rebuildInventory: {
      await probe.append("inventory")
      return "rebuilt"
    },
    reconstructAndReconcile: { await probe.append("reconcile:\($0)") },
    resume: { await probe.append("resume") }
  )

  #expect(
    result
      == .init(
        epoch: 1, cause: .wake, observerGeneration: 1, displayStabilized: true,
        stabilizationAttempts: 3))
  #expect(
    await probe.steps == [
      "pause", "permissions", "observers:1", "inventory", "reconcile:rebuilt", "resume",
    ])
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
      permissions: {
        await probe.append("permissions")
        throw PermissionFailure.denied
      },
      recreateObservers: { _ in await probe.append("observers") },
      rebuildInventory: {
        await probe.append("inventory")
        return "rebuilt"
      },
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
      return .init(
        epoch: UInt64(causes.count), cause: cause, observerGeneration: UInt64(causes.count),
        displayStabilized: true, stabilizationAttempts: 2)
    }
    func waiting() -> Bool { gate != nil }
    func release() {
      gate?.resume()
      gate = nil
    }
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
    func release() {
      gate?.resume()
      gate = nil
    }
    func recordFailure() { failureCount += 1 }
  }
  enum Failure: Error { case expected }
  let probe = Probe()
  let epochs = SessionTransitionEpochs<Int, Void>(sleep: { _ in })
  let wake = Task {
    try await epochs.submit(
      cause: .wake, run: { _ in try await probe.fail() },
      fail: { _ in
        await probe.recordFailure()
      })
  }
  while !(await probe.waiting()) { await Task.yield() }
  let screen = Task {
    try await epochs.submit(cause: .clamshell) { _ in
      Issue.record("coalesced caller must not start an overlapping transition")
      return .init(
        epoch: 0, cause: .clamshell, observerGeneration: 0, displayStabilized: false,
        stabilizationAttempts: 0)
    }
  }
  while await epochs.queuedTransitionCause() != .clamshell { await Task.yield() }
  await probe.release()

  await #expect(throws: Failure.expected) { try await wake.value }
  await #expect(throws: Failure.expected) { try await screen.value }
  #expect(await probe.failureCount == 1)
}

@Test func unstableDisplaysRemainPausedWithoutRebuilding() async {
  actor Displays {
    var value = 0
    func next() -> Int {
      defer { value += 1 }
      return value
    }
  }
  let displays = Displays()
  let epochs = SessionTransitionEpochs<Int, Void>(maximumDisplayAttempts: 3, sleep: { _ in })
  await #expect(throws: SessionTransitionError.displayTopologyUnstable(attempts: 3)) {
    try await epochs.resynchronize(
      cause: .clamshell,
      pause: {},
      displays: { await displays.next() },
      permissions: {},
      recreateObservers: { _ in Issue.record("unstable topology must not recreate observers") },
      rebuildInventory: { Issue.record("unstable topology must not rebuild inventory") },
      reconstructAndReconcile: { _ in Issue.record("unstable topology must not reconcile") },
      resume: { Issue.record("unstable topology must not resume") }
    )
  }
}

@Test func sessionActivationAfterSleepIsClassifiedAsUnlock() async {
  let epochs = SessionTransitionEpochs<Int, Void>(sleep: { _ in })
  await epochs.begin(.sleep, pause: {})
  #expect(await epochs.activationCause() == .unlock)
}

@Test func sessionActivationAfterLockIsClassifiedAsUnlock() async {
  let epochs = SessionTransitionEpochs<Int, Void>(sleep: { _ in })
  await epochs.begin(.lock, pause: {})
  #expect(await epochs.activationCause() == .unlock)
}

@Test func invalidPersistedStateIsQuarantinedAndRecoversByInitialAssignmentThenFallback()
  async throws
{
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let stateURL = directory.appendingPathComponent("state.json")
  try Data("not json".utf8).write(to: stateURL)
  let controller = try WorkspaceController(buildVersion: "test", stateURL: stateURL)
  #expect(await controller.recoveredFromInvalidPersistedState)
  #expect(!FileManager.default.fileExists(atPath: stateURL.path))
  #expect(
    try FileManager.default.contentsOfDirectory(atPath: directory.path).contains {
      $0.hasPrefix("state.corrupt.")
    })

  let configuration = try ConfigurationParser.parse(
    #"""
    {
      "defaults":{"gap":3},
      "workspaces":[
        {"name":"assigned","preferred_display":"display:external","gap":11,"initial_assignment":[
          {"property":"bundle_id","operator":"exact","value":"com.example.match"}
        ]},
        {"name":"missing","preferred_display":"unavailable"}
      ]
    }
    """#)
  let displays = await TwoDisplays().displays().value
  let windows = [
    recoveryWindow(
      id: "window:matched", bundleID: "com.example.match", displayID: "display:built-in"),
    recoveryWindow(id: "window:unmatched", bundleID: "com.example.other", displayID: nil),
  ]
  let inventory = InventorySnapshot(
    timestamp: .init(timeIntervalSince1970: 0), durationMilliseconds: 0, displays: displays,
    rawAXWindows: [], rawCGWindows: [], windows: windows, rejectedAXWindows: [],
    joinDecisions: [], sourceHealth: [], appScans: []
  )
  let scanner = InventoryScanner(
    sources: .init(
      displays: StubDisplays(), accessibility: StubAX(), coreGraphics: StubCG()
    ))
  let handler = DaemonHandler(
    state: .init(provider: SystemInventoryProvider(scanner: scanner)), workspaces: controller
  )
  try await handler.recoverInvalidPersistedState(
    configuration: configuration, inventory: inventory, defaultDisplayID: "display:built-in"
  )

  let recovered = await controller.snapshot()
  #expect(recovered[workspace: "assigned"]?.windowIDs == ["window:matched"])
  #expect(recovered[workspace: "1"]?.windowIDs == ["window:unmatched"])
  #expect(recovered[workspace: "assigned"]?.gap == 11)
  #expect(recovered[workspace: "assigned"]?.displayID == "display:external")
  #expect(recovered[workspace: "assigned"]?.preferredDisplayID == "display:external")
  #expect(recovered[workspace: "missing"]?.displayID == "display:built-in")
  #expect(recovered[workspace: "missing"]?.preferredDisplayID == nil)
  #expect(
    recovered.workspaces.flatMap(\.windowIDs).sorted() == ["window:matched", "window:unmatched"])
  #expect(Set(recovered.workspaces.flatMap(\.windowIDs)).count == 2)
  try? FileManager.default.removeItem(at: directory)
}

@Test func newWindowUsesInitialAssignmentWithoutReassigningManuallyMovedWindow() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let controller = try WorkspaceController(
    buildVersion: "test", stateURL: directory.appendingPathComponent("state.json")
  )
  let handler = DaemonHandler(
    state: .init(
      provider: SystemInventoryProvider(
        scanner: .init(
          sources: .init(
            displays: StubDisplays(), accessibility: StubAX(), coreGraphics: StubCG()
          )))), workspaces: controller
  )
  let configuration =
    #"{"workspaces":[{"name":"matched","initial_assignment":[{"property":"bundle_id","operator":"exact","value":"com.example.match"}]},{"name":"manual"}]}"#
  _ = try await handler.loadConfiguration(
    source: configuration,
    inventory: InventorySnapshot(
      timestamp: .init(), durationMilliseconds: 0, displays: await StubDisplays().displays().value,
      rawAXWindows: [], rawCGWindows: [], windows: [], rejectedAXWindows: [], joinDecisions: [],
      sourceHealth: [], appScans: []
    )
  )
  let window = recoveryWindow(
    id: "window:new", bundleID: "com.example.match", displayID: "display:1")
  let observed = lifecycleInventory(window)

  try await handler.reconcileObservedWindows(observed, displayID: "display:1")
  #expect(await controller.snapshot()[workspace: "matched"]?.windowIDs == ["window:new"])

  _ = try await controller.moveWindows(["window:new"], to: "manual")
  try await handler.reconcileObservedWindows(observed, displayID: "display:1")
  #expect(await controller.snapshot()[workspace: "matched"]?.windowIDs.isEmpty == true)
  #expect(await controller.snapshot()[workspace: "manual"]?.windowIDs == ["window:new"])
  try? FileManager.default.removeItem(at: directory)
}

@Test func sessionRecoveryPreservesManuallyMovedWindowOverInitialAssignment() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let scanner = InventoryScanner(
    sources: .init(
      displays: StubDisplays(), accessibility: WindowAX(titles: ["Spotify Premium"]),
      coreGraphics: WindowCG(titles: ["Spotify Premium"])
    ))
  let state = DaemonHandler.State(provider: SystemInventoryProvider(scanner: scanner))
  let controller = try WorkspaceController(
    buildVersion: "test", stateURL: directory.appendingPathComponent("state.json"))
  let handler = DaemonHandler(state: state, workspaces: controller)
  let inventory = try await state.refresh().snapshot.inventory
  _ = try await handler.loadConfiguration(
    source:
      #"{"workspaces":[{"name":"1","initial_assignment":[{"property":"executable_name","operator":"exact","value":"Test"}]},{"name":"S"}]}"#,
    inventory: inventory
  )
  try await handler.reconcileObservedWindows(inventory, displayID: "display:1")
  let windowID = try #require(inventory.windows.first(where: { $0.classification == .normal })?.id)
  _ = try await controller.moveWindows([windowID], to: "S")

  try await handler.resynchronizeSession(.unlock)
  try await handler.resynchronizeSession(.clamshell)

  #expect(await controller.snapshot()[workspace: "S"]?.windowIDs == [windowID])
  #expect(await controller.snapshot()[workspace: "1"]?.windowIDs.isEmpty == true)
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

  let steps = WorkspaceIntentAudit(state: state, inventory: inventory(["window:1", "window:2"]))
    .orderedSteps
  #expect(steps.first?.windowOrWorkspaceID == "window:1")
  #expect(steps.contains(.init(windowOrWorkspaceID: "window:2", action: .park)))
  let parkIndex = steps.firstIndex { $0.action == .park }
  let retileIndex = steps.firstIndex { $0.action == .retile }
  #expect(parkIndex != nil && retileIndex != nil && parkIndex! < retileIndex!)
}

@Test func committedIntentAuditNeverMovesTransientOrUnmanagedMembers() {
  var state = WorkspaceState()
  _ = try? state.focusWorkspace(named: "visible", displayID: "display:1")
  _ = try? state.focusWorkspace(named: "hidden", displayID: "display:1")
  _ = try? state.adoptUnassignedWindows(["transient", "unmanaged"], displayID: "display:1")
  _ = try? state.focusWorkspace(named: "visible", displayID: "display:1")
  var snapshot = inventory(["transient", "unmanaged"])
  snapshot.windows[0].classification = .transient
  snapshot.windows[1].management = .unmanaged

  let audit = WorkspaceIntentAudit(state: state, inventory: snapshot)

  #expect(audit.park.isEmpty)
  #expect(audit.restore.isEmpty)
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

@Test func healthyStartupAuditPrunesPersistedIneligibleSystemUIMember() throws {
  let state = startupState(staleID: "window:cg:155", liveID: "window:cg:200")
  var inventory = completeInventory(["window:cg:155", "window:cg:200"])
  inventory.windows[0].classification = .systemUI
  inventory.windows[0].management = .ineligible

  let candidate = StartupIntentAudit.candidate(state: state, inventory: inventory)

  #expect(candidate[workspace: "visible"]?.windowIDs == ["window:cg:200"])
  #expect(candidate[workspace: "visible"]?.focusedWindowID == "window:cg:200")
  #expect(candidate[workspace: "visible"]?.bsp.root == .leaf(windowID: "window:cg:200"))
  #expect(candidate.parkedWindowFrames["window:cg:155"] == nil)
  try candidate.validate()
}

@Test func healthyStartupAuditDoesNotAdoptNewIneligibleSystemUIWindow() {
  let state = startupState(staleID: "window:cg:155", liveID: "window:cg:200")
  var inventory = completeInventory(["window:cg:155", "window:cg:200", "window:cg:300"])
  inventory.windows[2].classification = .systemUI
  inventory.windows[2].management = .ineligible

  let candidate = StartupIntentAudit.candidate(state: state, inventory: inventory)

  #expect(candidate.workspaces.flatMap(\.windowIDs).contains("window:cg:300") == false)
}

@Test func startupAuditPreservesAssignmentsWithoutAdoptingNewWindows() throws {
  var state = WorkspaceState()
  _ = try state.adoptUnassignedWindows(["window:cg:1"], into: "T", displayID: "display:1")
  let candidate = StartupIntentAudit.candidate(
    state: state, inventory: completeInventory(["window:cg:1", "window:cg:2"])
  )

  #expect(candidate[workspace: "T"]?.windowIDs == ["window:cg:1"])
  #expect(candidate.workspaces.allSatisfy { !$0.windowIDs.contains("window:cg:2") })
}

@Test func resumeAuditPreservesMembershipAcrossWindowIDReplacement() throws {
  let state = startupState(staleID: "window:cg:155", liveID: "window:cg:200")
  var inventory = completeInventory(["window:cg:200", "window:cg:300"])
  inventory.windows = [
    recoveryWindow(id: "window:cg:200", bundleID: "test", displayID: "display:1"),
    recoveryWindow(id: "window:cg:300", bundleID: "test", displayID: "display:1"),
  ]
  inventory.displays = [
    .init(
      id: "display:1", name: "Display", isBuiltin: true, isPrimary: true,
      frame: .init(x: 0, y: 0, width: 1_000, height: 800),
      visibleFrame: .init(x: 0, y: 0, width: 1_000, height: 800),
      backingScale: 1, identifiers: .init())
  ]
  let candidate = StartupIntentAudit.candidate(
    state: state, inventory: inventory,
    replacements: ["window:cg:155": "window:cg:300"]
  )

  #expect(candidate[workspace: "visible"]?.windowIDs == ["window:cg:300", "window:cg:200"])
  #expect(candidate[workspace: "visible"]?.bsp.root?.contains("window:cg:300") == true)
  try candidate.validate()
}

@Test func unrelatedFailedAppScanDoesNotBlockStaleAXExpiration() throws {
  let staleID = "window:ax:1:AXWindow:AXStandardWindow:old:0"
  let state = startupState(staleID: staleID, liveID: "window:cg:200")
  var inventory = completeInventory(["window:cg:200"])
  inventory.appScans.append(
    .init(
      application: .init(pid: 2, name: "Helper"), status: .failed,
      durationMilliseconds: 1, windowCount: 0, issues: ["failed"]
    ))
  let candidate = StartupIntentAudit.candidate(
    state: state, inventory: inventory
  )

  #expect(candidate[workspace: "visible"]?.windowIDs == ["window:cg:200"])
  #expect(candidate[workspace: "visible"]?.focusedWindowID == "window:cg:200")
  #expect(candidate[workspace: "visible"]?.bsp.root == .leaf(windowID: "window:cg:200"))
  #expect(candidate.parkedWindowFrames[staleID] == nil)
  try candidate.validate()
}

@Test func completeStartupAuditPreservesStaleAXIdentityThroughReplacement() throws {
  let staleID = "window:ax:1:AXWindow:AXStandardWindow:old:0"
  let replacementID = "window:ax:1:AXWindow:AXStandardWindow:new:0"
  let state = startupState(staleID: staleID, liveID: "window:cg:200")
  var inventory = completeInventory([replacementID, "window:cg:200"])
  inventory.displays = [
    .init(
      id: "display:1", name: "Display", isBuiltin: true, isPrimary: true,
      frame: .init(x: 0, y: 0, width: 1_000, height: 800),
      visibleFrame: .init(x: 0, y: 0, width: 1_000, height: 800),
      backingScale: 1, identifiers: .init())
  ]
  let candidate = StartupIntentAudit.candidate(
    state: state, inventory: inventory,
    replacements: [staleID: replacementID]
  )

  #expect(candidate[workspace: "visible"]?.windowIDs == [replacementID, "window:cg:200"])
  #expect(candidate[workspace: "visible"]?.focusedWindowID == replacementID)
  #expect(candidate[workspace: "visible"]?.bsp.root?.contains(replacementID) == true)
  try candidate.validate()
}

@Test func owningPIDTimedOutScanPreservesUnmatchedStaleAXIdentity() {
  let staleID = "window:ax:1:AXWindow:AXStandardWindow:old:0"
  let state = startupState(staleID: staleID, liveID: "window:cg:200")
  let candidate = StartupIntentAudit.candidate(
    state: state,
    inventory: completeInventory(["window:cg:200"], appStatus: .timedOut)
  )

  #expect(candidate == state)
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
  inventory.sourceHealth = [
    .init(source: .coreGraphics, status: .unhealthy, permissionGranted: false)
  ]

  #expect(StartupIntentAudit.candidate(state: state, inventory: inventory) == state)
}

@Test func periodicHealthyCGReconciliationPrunesStaleMembersBeforeEffects() throws {
  let state = startupState(staleID: "window:cg:13547", liveID: "window:cg:200")
  var inventory = completeInventory(["window:cg:200"], appStatus: .failed)
  inventory.rawCGWindows.append(.init(cgWindowID: 13_547, pid: 99))
  let reconciled = StartupIntentAudit.candidate(state: state, inventory: inventory)

  #expect(reconciled[workspace: "visible"]?.windowIDs == ["window:cg:200"])
  #expect(
    WorkspaceIntentAudit(state: reconciled, inventory: completeInventory(["window:cg:200"]))
      .orderedSteps.allSatisfy { $0.windowOrWorkspaceID != "window:cg:13547" })
  try reconciled.validate()
}

@Test func periodicHandlerPrunesPersistedStaleCGMember() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let controller = WorkspaceController(
    store: WorkspaceStateStore(
      stateURL: directory.appendingPathComponent("state.json"), buildVersion: "test"
    ) { try $0.validate() },
    state: startupState(staleID: "window:cg:155", liveID: "window:cg:200")
  )
  let handler = DaemonHandler(
    state: .init(
      provider: SystemInventoryProvider(
        scanner: .init(
          sources: .init(
            displays: StubDisplays(), accessibility: StubAX(), coreGraphics: StubCG()
          )))),
    workspaces: controller, geometryEffects: DirectionalGeometry(frames: [:])
  )

  try await handler.reconcileObservedWindows(
    lifecycleInventory([
      recoveryWindow(id: "window:cg:155", bundleID: "test", displayID: "display:1"),
      recoveryWindow(id: "window:cg:200", bundleID: "test", displayID: "display:1"),
    ]), displayID: "display:1")
  try await handler.reconcileObservedWindows(
    completeInventory(["window:cg:200"]), displayID: "display:1")
  #expect(
    await controller.snapshot()[workspace: "visible"]?.windowIDs == [
      "window:cg:155", "window:cg:200",
    ])
  try await handler.reconcileObservedWindows(
    completeInventory(["window:cg:200"]), displayID: "display:1")

  let workspace = await controller.snapshot()[workspace: "visible"]
  #expect(workspace?.windowIDs == ["window:cg:200"])
  #expect(workspace?.focusedWindowID == "window:cg:200")
  #expect(workspace?.bsp.root == .leaf(windowID: "window:cg:200"))
  try? FileManager.default.removeItem(at: directory)
}

@Test func periodicFocusSkipsGeometryForRetainedOmittedWindows() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let displayID = "display:1"
  let zenID = "window:cg:100"
  let peerID = "window:cg:101"
  let spotifyID = "window:cg:200"
  let state = WorkspaceState(
    workspaces: [
      .init(
        name: "B", origin: .configured, displayID: displayID,
        windowIDs: [zenID, peerID], focusedWindowID: zenID,
        bsp: .init(
          root: .split(
            axis: .vertical, ratio: 0.5,
            first: .leaf(windowID: zenID), second: .leaf(windowID: peerID)))),
      .init(
        name: "3", origin: .runtime, displayID: displayID, visible: true, focused: true,
        windowIDs: [spotifyID], focusedWindowID: spotifyID,
        bsp: .init(root: .leaf(windowID: spotifyID))),
    ],
    focusedWorkspaceName: "3",
    displays: [displayID: .init(visibleWorkspaceName: "3")]
  )
  let controller = WorkspaceController(
    store: WorkspaceStateStore(
      stateURL: directory.appendingPathComponent("state.json"), buildVersion: "test"
    ) { try $0.validate() },
    state: state
  )
  let geometry = DirectionalGeometry(frames: [
    zenID: .init(x: 0, y: 0, width: 500, height: 800),
    peerID: .init(x: 500, y: 0, width: 500, height: 800),
    spotifyID: .init(x: 0, y: 0, width: 1_000, height: 800),
  ])
  await geometry.setStaleWindowIDs([spotifyID])
  let handler = DaemonHandler(
    state: .init(
      provider: SystemInventoryProvider(
        scanner: .init(
          sources: .init(
            displays: StubDisplays(), accessibility: StubAX(), coreGraphics: StubCG()
          )))),
    workspaces: controller, geometryEffects: geometry
  )
  var zen = recoveryWindow(id: zenID, bundleID: "zen", displayID: displayID)
  zen.pid = 10
  zen.main = true
  var peer = recoveryWindow(id: peerID, bundleID: "zen", displayID: displayID)
  peer.pid = 10
  var spotify = recoveryWindow(id: spotifyID, bundleID: "spotify", displayID: displayID)
  spotify.pid = 20
  var dialog = recoveryWindow(id: "window:cg:102", bundleID: "zen", displayID: displayID)
  dialog.pid = 10
  dialog.classification = .transient
  dialog.management = .unmanaged
  let display = DisplayObservation(
    id: displayID, name: "Display", isBuiltin: true, isPrimary: true,
    frame: .init(x: 0, y: 0, width: 1_000, height: 800),
    visibleFrame: .init(x: 0, y: 0, width: 1_000, height: 800), backingScale: 1,
    identifiers: .init())
  func snapshot(_ windows: [NormalizedWindow]) -> InventorySnapshot {
    .init(
      timestamp: .init(), durationMilliseconds: 0, displays: [display], rawAXWindows: [],
      rawCGWindows: [], windows: windows, rejectedAXWindows: [], joinDecisions: [],
      sourceHealth: [],
      appScans: [
        .init(
          application: .init(pid: 10, name: "Zen"), status: .succeeded,
          durationMilliseconds: 0, windowCount: windows.filter { $0.pid == 10 }.count, issues: []),
        .init(
          application: .init(pid: 20, name: "Spotify"), status: .succeeded,
          durationMilliseconds: 0, windowCount: windows.filter { $0.pid == 20 }.count, issues: []),
      ])
  }
  try await handler.reconcileObservedWindows(snapshot([zen, peer, spotify]), displayID: displayID)

  try await handler.reconcileApplicationActivation(
    frontmostPID: zen.pid, inventory: snapshot([spotify]))
  #expect(await controller.snapshot().focusedWorkspaceName == "3")
  #expect(await geometry.reconciledWindowIDs.contains([spotifyID]))

  try await handler.reconcilePeriodicObservation(
    snapshot([spotify, dialog]), displayID: displayID, focusedWindowID: dialog.id,
    frontmostPID: zen.pid)
  #expect(await controller.snapshot().focusedWorkspaceName == "3")

  try await handler.reconcilePeriodicObservation(
    snapshot([spotify, dialog]), displayID: displayID, focusedWindowID: zenID,
    frontmostPID: zen.pid)
  #expect(await controller.snapshot().focusedWorkspaceName == "3")

  try await handler.reconcilePeriodicObservation(
    snapshot([zen, peer]), displayID: displayID, focusedWindowID: nil, frontmostPID: zen.pid)
  #expect(await controller.snapshot().focusedWorkspaceName == "3")

  try await handler.reconcilePeriodicObservation(
    snapshot([zen, peer]), displayID: displayID, focusedWindowID: nil, frontmostPID: zen.pid)

  let committed = await controller.snapshot()
  #expect(committed.focusedWorkspaceName == "B")
  #expect(committed[workspace: "B"]?.windowIDs == [zenID, peerID])
  #expect(committed.workspaces.allSatisfy { !($0.windowIDs.contains(spotifyID)) })
  #expect(await geometry.focused == zenID)
  #expect(await geometry.operations.filter { $0 == .focus(zenID) }.count == 1)
  #expect(await geometry.reconciledWindowIDs.contains([zenID, peerID]))
  try? FileManager.default.removeItem(at: directory)
}

@Test func automaticFocusNeverMovesExplicitlyManagedTransientWindows() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: directory) }
  let scanner = InventoryScanner(
    sources: .init(
      displays: StubDisplays(), accessibility: WindowAX(titles: ["source", "target", "panel"]),
      coreGraphics: WindowCG(titles: ["source", "target", "panel"])))
  let inventoryState = DaemonHandler.State(provider: SystemInventoryProvider(scanner: scanner))
  let initial = try await inventoryState.refresh().snapshot.inventory.windows.sorted {
    $0.id < $1.id
  }
  var source = initial[0]
  source.pid = 10
  var target = initial[1]
  target.pid = 20
  target.main = true
  var panel = initial[2]
  panel.pid = 10
  let sourceID = source.id
  let targetID = target.id
  let panelID = panel.id
  let displayID = "display:1"
  let controller = WorkspaceController(
    store: WorkspaceStateStore(
      stateURL: directory.appendingPathComponent("state.json"), buildVersion: "test"
    ) { try $0.validate() },
    state: WorkspaceState(
      workspaces: [
        .init(
          name: "source", origin: .configured, displayID: displayID, visible: true, focused: true,
          windowIDs: [sourceID, panelID], focusedWindowID: sourceID,
          bsp: .init(
            root: .split(
              axis: .vertical, ratio: 0.5, first: .leaf(windowID: sourceID),
              second: .leaf(windowID: panelID)))),
        .init(
          name: "target", origin: .configured, displayID: displayID, windowIDs: [targetID],
          focusedWindowID: targetID, bsp: .init(root: .leaf(windowID: targetID))),
      ], focusedWorkspaceName: "source",
      displays: [displayID: .init(visibleWorkspaceName: "source")]))
  let geometry = DirectionalGeometry(frames: [
    sourceID: source.frame!, targetID: target.frame!, panelID: panel.frame!,
  ])
  let handler = DaemonHandler(
    state: inventoryState, workspaces: controller, geometryEffects: geometry)
  try await handler.reconcileObservedWindows(
    lifecycleInventory([source, target, panel]), displayID: displayID)
  await geometry.resetOperations()

  panel.classification = .transient
  panel.management = .unmanaged
  for window in [source, target, panel] {
    _ = try await inventoryState.update(window: .init(id: window.id, value: window))
  }
  let currentInventory = try await inventoryState.state().snapshot.inventory

  try await handler.reconcileApplicationActivation(
    frontmostPID: target.pid, inventory: currentInventory)
  #expect(await controller.snapshot().focusedWorkspaceName == "source")
  #expect(await geometry.operations.isEmpty)

  let replies = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "manage-panel", method: .windowManage,
          params: [
            "window_id": .string(panelID), "return_mode": .string("completion"),
          ]))), clientID: UUID())
  let reply = try response(replies[0])
  #expect(reply.error == nil)
  if case .object(let result)? = reply.result,
    case .object(let transaction)? = result["transaction"]
  {
    #expect(transaction["failure"] == nil)
  }
  await geometry.resetOperations()

  try await handler.reconcileApplicationActivation(
    frontmostPID: target.pid, inventory: currentInventory)
  #expect(await controller.snapshot().focusedWorkspaceName == "target")
  #expect(!(await geometry.operations.contains(.park(panelID))))
  #expect(await geometry.focused == targetID)

  let unmanaged = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "unmanage-panel", method: .windowUnmanage,
          params: [
            "window_id": .string(panelID), "return_mode": .string("completion"),
          ]))), clientID: UUID())
  #expect(try response(unmanaged[0]).error == nil)
  let observed = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "observe-panel", method: .observeWindow,
          params: ["window_id": .string(panelID)]))), clientID: UUID())
  guard case .object(let result)? = try response(observed[0]).result,
    case .array(let windows)? = result["windows"],
    case .object(let report)? = windows.first,
    case .object(let expected)? = report["expected"]
  else {
    Issue.record("expected panel observation")
    return
  }
  #expect(expected["management"] == .string("unmanaged"))
  #expect(report["session_retained"] == .bool(true))
}

@Test func workspaceFocusIgnoresStaleTransientMember() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: directory) }
  let displayID = "display:1"
  let scanner = InventoryScanner(
    sources: .init(
      displays: StubDisplays(), accessibility: WindowAX(titles: ["normal", "panel"]),
      coreGraphics: WindowCG(titles: ["normal", "panel"])))
  let inventoryState = DaemonHandler.State(provider: SystemInventoryProvider(scanner: scanner))
  let initial = try await inventoryState.refresh().snapshot.inventory.windows.sorted {
    $0.id < $1.id
  }
  var normal = initial[0]
  normal.pid = 10
  normal.management = .managed
  normal.displayID = displayID
  var transient = initial[1]
  transient.pid = 20
  transient.classification = .transient
  transient.displayID = displayID
  transient.management = .unmanaged
  let controller = WorkspaceController(
    store: WorkspaceStateStore(
      stateURL: directory.appendingPathComponent("state.json"), buildVersion: "test"
    ) { try $0.validate() },
    state: WorkspaceState(
      workspaces: [
        .init(
          name: "source", origin: .configured, displayID: displayID, visible: true, focused: true),
        .init(
          name: "target", origin: .configured, displayID: displayID,
          windowIDs: [normal.id, transient.id], focusedWindowID: transient.id,
          bsp: .init(
            root: .split(
              axis: .vertical, ratio: 0.5, first: .leaf(windowID: normal.id),
              second: .leaf(windowID: transient.id)))),
      ], focusedWorkspaceName: "source",
      displays: [displayID: .init(visibleWorkspaceName: "source")]))
  let geometry = DirectionalGeometry(frames: [
    normal.id: normal.frame!, transient.id: transient.frame!,
  ])
  let handler = DaemonHandler(
    state: inventoryState,
    workspaces: controller, geometryEffects: geometry)
  for window in [normal, transient] {
    _ = try await inventoryState.update(window: .init(id: window.id, value: window))
  }

  let replies = await handler.handle(
    text: try clientMessage(
      .request(
        .init(
          requestId: "focus-target", method: .workspaceFocus,
          params: ["name": .string("target"), "return_mode": .string("completion")]))),
    clientID: UUID())

  let focusReply = try response(replies[0])
  #expect(focusReply.error == nil)
  if case .object(let result)? = focusReply.result,
    case .object(let transaction)? = result["transaction"]
  {
    #expect(transaction["failure"] == nil)
  }
  #expect(await controller.snapshot().focusedWorkspaceName == "target")
  #expect(await geometry.focused == normal.id)
  #expect(!(await geometry.operations.contains(.set(transient.id))))
}

@Test func lifecycleCloseRemovesMemberAndRetilesVisibleWorkspace() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  var state = startupState(staleID: "window:cg:155", liveID: "window:cg:200")
  state.parkedWindowFrames = [:]
  let controller = WorkspaceController(
    store: WorkspaceStateStore(
      stateURL: directory.appendingPathComponent("state.json"), buildVersion: "test"
    ) { try $0.validate() },
    state: state
  )
  let geometry = DirectionalGeometry(frames: [
    "window:cg:155": .init(x: 0, y: 0, width: 500, height: 800),
    "window:cg:200": .init(x: 500, y: 0, width: 500, height: 800),
  ])
  let handler = DaemonHandler(
    state: .init(
      provider: SystemInventoryProvider(
        scanner: .init(
          sources: .init(
            displays: StubDisplays(), accessibility: StubAX(), coreGraphics: StubCG()
          )))),
    workspaces: controller, geometryEffects: geometry
  )
  let client = UUID()
  let events = EventProbe()
  await handler.installSender { text, _ in
    guard
      case .event(let event) = try? ProtocolCodec.decode(ServerMessage.self, from: Data(text.utf8))
    else { return }
    Task { await events.record(event.topic) }
  }
  _ = await handler.handle(
    text: try clientMessage(
      .subscribe(
        .init(
          requestId: "closed", subscriptionId: "closed", topics: [.windowClosed]
        ))), clientID: client)

  try await handler.reconcileObservedWindows(
    lifecycleInventory([
      recoveryWindow(id: "window:cg:155", bundleID: "test", displayID: "display:1"),
      recoveryWindow(id: "window:cg:200", bundleID: "test", displayID: "display:1"),
    ]), displayID: "display:1")
  try await handler.reconcileObservedWindows(
    completeInventory(["window:cg:200"]), displayID: "display:1")
  try await handler.reconcileObservedWindows(
    completeInventory(["window:cg:200"]), displayID: "display:1")
  try await handler.reconcileObservedWindows(
    completeInventory(["window:cg:200"]), displayID: "display:1")

  let workspace = await controller.snapshot()[workspace: "visible"]
  #expect(workspace?.windowIDs == ["window:cg:200"])
  #expect(workspace?.bsp.root == .leaf(windowID: "window:cg:200"))
  for _ in 0..<100 where !(await events.contains(.windowClosed)) { await Task.yield() }
  #expect(await events.contains(.windowClosed))
  try? FileManager.default.removeItem(at: directory)
}

@Test func lifecycleCloseUpdatesHiddenLayoutWithoutRendering() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  var state = startupState(staleID: "window:cg:155", liveID: "window:cg:200")
  state.parkedWindowFrames = [:]
  state.workspaces[0].visible = false
  state.workspaces[0].focused = false
  state.focusedWorkspaceName = nil
  state.displays["display:1"]?.visibleWorkspaceName = nil
  let controller = WorkspaceController(
    store: WorkspaceStateStore(
      stateURL: directory.appendingPathComponent("state.json"), buildVersion: "test"
    ) { try $0.validate() },
    state: state
  )
  let geometry = DirectionalGeometry(frames: [
    "window:cg:155": .init(x: 0, y: 0, width: 500, height: 800),
    "window:cg:200": .init(x: 500, y: 0, width: 500, height: 800),
  ])
  let handler = DaemonHandler(
    state: .init(
      provider: SystemInventoryProvider(
        scanner: .init(
          sources: .init(
            displays: StubDisplays(), accessibility: StubAX(), coreGraphics: StubCG()
          )))),
    workspaces: controller, geometryEffects: geometry
  )

  try await handler.reconcileObservedWindows(
    lifecycleInventory([
      recoveryWindow(id: "window:cg:155", bundleID: "test", displayID: "display:1"),
      recoveryWindow(id: "window:cg:200", bundleID: "test", displayID: "display:1"),
    ]), displayID: "display:1")
  try await handler.reconcileObservedWindows(
    completeInventory(["window:cg:200"]), displayID: "display:1")
  try await handler.reconcileObservedWindows(
    completeInventory(["window:cg:200"]), displayID: "display:1")

  let workspace = await controller.snapshot()[workspace: "visible"]
  #expect(workspace?.windowIDs == ["window:cg:200"])
  #expect(workspace?.bsp.root == .leaf(windowID: "window:cg:200"))
  #expect(await geometry.operations.isEmpty)
  try? FileManager.default.removeItem(at: directory)
}

@Test func recoveryPrunesStaleCGMemberBeforeGeometryEffects() async throws {
  let staleID = "window:cg:155"
  let liveID = "window:cg:200"
  let state = startupState(staleID: staleID, liveID: liveID)
  let inventory = completeInventory([liveID])
  let candidate = StartupIntentAudit.candidate(state: state, inventory: inventory)

  #expect(candidate[workspace: "visible"]?.windowIDs == [liveID])
  #expect(
    WorkspaceIntentAudit(state: candidate, inventory: inventory).orderedSteps.allSatisfy {
      $0.windowOrWorkspaceID != staleID
    })
}

@Test func periodicUnhealthyCGRetainsStaleMembersConservatively() {
  let state = startupState(staleID: "window:cg:13547", liveID: "window:cg:200")
  var inventory = completeInventory(["window:cg:200"])
  inventory.sourceHealth = [
    .init(source: .coreGraphics, status: .degraded, permissionGranted: true)
  ]

  #expect(StartupIntentAudit.candidate(state: state, inventory: inventory) == state)
}

@Test func explicitFocusCandidateDoesNotPruneDuringDegradedCGInventory() {
  let state = startupState(staleID: "window:cg:13547", liveID: "window:cg:200")
  var inventory = completeInventory(["window:cg:200"])
  inventory.sourceHealth = [
    .init(source: .coreGraphics, status: .degraded, permissionGranted: true)
  ]
  #expect(StartupIntentAudit.candidate(state: state, inventory: inventory) == state)
}

@Test func observerClampReportsOnceAndDoesNotBlockLaterWork() {
  var reliability = ObserverGeometryReliability()
  let clamp = ObserverGeometryReliability.Clamp(
    requestedWidth: 752, requestedHeight: 950, observedWidth: 723, observedHeight: 950
  )
  var completed: [String] = []

  #expect(
    reliability.shouldAttempt(windowID: "settings", requestedWidth: 752, requestedHeight: 950))
  let firstReport = reliability.record(windowID: "settings", clamp: clamp)
  #expect(firstReport)
  completed.append("other-window")
  completed.append("focus")

  #expect(
    !reliability.shouldAttempt(windowID: "settings", requestedWidth: 752, requestedHeight: 950))
  let repeatedReport = reliability.record(windowID: "settings", clamp: clamp)
  #expect(!repeatedReport)
  #expect(
    reliability.shouldAttempt(windowID: "settings", requestedWidth: 800, requestedHeight: 950))
  completed.append("later-focus")
  #expect(completed == ["other-window", "focus", "later-focus"])
}

@Test func recoveryAuditClassifiesRetilingAsBestEffort() {
  let step = WorkspaceIntentAuditStep(windowOrWorkspaceID: "visible", action: .retile)

  #expect(step.isRequiredForRecovery == false)
  #expect(
    WorkspaceIntentAuditStep(windowOrWorkspaceID: "window:1", action: .park).isRequiredForRecovery)
  #expect(
    WorkspaceIntentAuditStep(
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

  #expect(
    resolveRetainedFocusedWindowID(
      windows: retained, focusedWindowID: nil, frontmostPID: 20
    ) == "replacement")
}

private func startupState(staleID: String, liveID: String) -> WMWorkspace.WorkspaceState {
  WMWorkspace.WorkspaceState(
    workspaces: [
      .init(
        name: "visible", origin: .configured, displayID: "display:1", visible: true, focused: true,
        windowIDs: [staleID, liveID], focusedWindowID: staleID,
        bsp: .init(
          root: .split(
            axis: .vertical, ratio: 0.5,
            first: .leaf(windowID: staleID), second: .leaf(windowID: liveID)
          ))
      )
    ],
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
    guard let value = UInt32(id.replacingOccurrences(of: "window:cg:", with: "")) else {
      return nil
    }
    return .init(cgWindowID: value, pid: 1)
  }
  snapshot.sourceHealth = [
    .init(source: .accessibility, status: .healthy, permissionGranted: true),
    .init(source: .coreGraphics, status: .healthy, permissionGranted: true),
  ]
  snapshot.appScans = [
    .init(
      application: .init(pid: 1, name: "Test"), status: appStatus,
      durationMilliseconds: 1, windowCount: ids.count, issues: []
    )
  ]
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
    timestamp: Date(timeIntervalSince1970: 0), durationMilliseconds: 0, displays: [],
    rawAXWindows: [],
    rawCGWindows: [], windows: windows, rejectedAXWindows: [], joinDecisions: [],
    sourceHealth: enumeration.map {
      [.init(source: .accessibility, status: $0, permissionGranted: true, issues: [])]
    } ?? [],
    appScans: []
  )
}

private func recoveryWindow(id: String, bundleID: String, displayID: String?) -> NormalizedWindow {
  NormalizedWindow(
    id: id, pid: 1, appName: "Test", bundleID: bundleID,
    executablePath: "/Applications/Test.app/Test",
    frame: .init(x: 0, y: 0, width: 100, height: 100), displayID: displayID,
    classification: .normal, management: .managed, rejectionReasons: [], joinConfidence: .exact,
    joinSignals: [], health: .healthy, healthIssues: []
  )
}

private func lifecycleInventory(_ window: NormalizedWindow) -> InventorySnapshot {
  lifecycleInventory([window])
}

private func lifecycleInventory(_ windows: [NormalizedWindow]) -> InventorySnapshot {
  InventorySnapshot(
    timestamp: .init(), durationMilliseconds: 0, displays: [], rawAXWindows: [], rawCGWindows: [],
    windows: windows, rejectedAXWindows: [], joinDecisions: [], sourceHealth: [],
    appScans: [
      .init(
        application: .init(pid: windows[0].pid, name: windows[0].appName), status: .succeeded,
        durationMilliseconds: 0, windowCount: windows.count, issues: []
      )
    ]
  )
}
