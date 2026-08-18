import Foundation
import WMConfiguration
import WMInventory
import WMPersistence
import WMWorkspace

actor WorkspaceController {
  private let store: WorkspaceStateStore<WMWorkspace.WorkspaceState>
  private(set) var state: WMWorkspace.WorkspaceState
  let recoveredFromInvalidPersistedState: Bool

  init(buildVersion: String, stateURL: URL = WorkspaceStatePath.resolve()) throws {
    store = WorkspaceStateStore(stateURL: stateURL, buildVersion: buildVersion) {
      try $0.validate()
    }
    switch try store.load() {
    case .loaded(let loaded):
      state = loaded
      recoveredFromInvalidPersistedState = false
    case .absent:
      state = .init()
      recoveredFromInvalidPersistedState = false
    case .quarantined:
      state = .init()
      recoveredFromInvalidPersistedState = true
    }
  }

  init(store: WorkspaceStateStore<WMWorkspace.WorkspaceState>, state: WMWorkspace.WorkspaceState) {
    self.store = store
    self.state = state
    recoveredFromInvalidPersistedState = false
  }

  func snapshot() -> WMWorkspace.WorkspaceState { state }

  func commit(_ candidate: WMWorkspace.WorkspaceState) throws {
    guard candidate != state else { return }
    try store.save(candidate)
    state = candidate
  }

  func focus(name: String, displayID: String?) throws -> WMWorkspace.WorkspaceMutationResult {
    try commit { try $0.focusWorkspace(named: name, displayID: displayID) }
  }

  func previewFocus(name: String, displayID: String?) throws -> WMWorkspace.WorkspaceMutationResult
  {
    var candidate = state
    return try candidate.focusWorkspace(named: name, displayID: displayID)
  }

  func previewMoveWindows(_ ids: [String], to workspace: String, displayID: String? = nil) throws
    -> WMWorkspace.WorkspaceMutationResult
  {
    var candidate = state
    return try candidate.moveWindows(ids, to: workspace, displayID: displayID)
  }

  func previewMoveWorkspace(_ name: String, to displayID: String) throws
    -> WMWorkspace.WorkspaceMutationResult
  {
    var candidate = state
    return try candidate.moveWorkspace(named: name, to: displayID)
  }

  func previewSetMode(_ name: String, mode: WMWorkspace.WorkspaceMode) throws
    -> WMWorkspace.WorkspaceMutationResult
  {
    var candidate = state
    return try candidate.setMode(of: name, to: mode)
  }

  func previewFocusWindow(
    direction: WMWorkspace.WindowDirection, bounds: WorkspaceLayoutRect
  ) throws -> WMWorkspace.DirectionalWindowMutation {
    var candidate = state
    return try candidate.focusWindow(direction: direction, bounds: bounds)
  }

  func previewMoveWindow(
    direction: WMWorkspace.WindowDirection, bounds: WorkspaceLayoutRect
  ) throws -> WMWorkspace.DirectionalWindowMutation {
    var candidate = state
    return try candidate.moveWindow(direction: direction, bounds: bounds)
  }

  func previewSetLayoutPolicy(
    _ name: String, policy: [WMWorkspace.LayoutPolicy]
  ) throws -> WMWorkspace.WorkspaceMutationResult {
    var candidate = state
    return try candidate.setLayoutPolicy(of: name, to: policy)
  }

  func commitFocus(_ result: WMWorkspace.WorkspaceMutationResult) throws {
    guard result.workspaceState != state else { return }
    try store.save(result.workspaceState)
    state = result.workspaceState
  }

  func moveWindows(_ ids: [String], to workspace: String) throws
    -> WMWorkspace.WorkspaceMutationResult
  {
    try commit { try $0.moveWindows(ids, to: workspace) }
  }

  func adoptUnassignedWindows(_ ids: [String], displayID: String) throws {
    _ = try commit { try $0.adoptUnassignedWindows(ids, displayID: displayID) }
  }

  func reconcileObservedWindows(
    _ ids: [String], assignments: [String: String] = [:], replacements: [String: String] = [:],
    removedIDs: Set<String> = [], displayID: String
  ) throws -> WMWorkspace.WorkspaceMutationResult {
    try commit {
      try $0.reconcileObservedWindows(
        ids, initialAssignments: assignments, replacements: replacements,
        removedWindowIDs: removedIDs,
        defaultDisplayID: displayID
      )
    }
  }

  func previewReconcileObservedWindows(
    _ ids: [String], assignments: [String: String] = [:], replacements: [String: String] = [:],
    removedIDs: Set<String> = [], displayID: String
  ) throws -> WMWorkspace.WorkspaceMutationResult {
    var candidate = state
    return try candidate.reconcileObservedWindows(
      ids, initialAssignments: assignments, replacements: replacements,
      removedWindowIDs: removedIDs, defaultDisplayID: displayID
    )
  }

  func moveWorkspace(_ name: String, to displayID: String) throws
    -> WMWorkspace.WorkspaceMutationResult
  {
    try commit { try $0.moveWorkspace(named: name, to: displayID) }
  }

  func setMode(_ name: String, mode: WMWorkspace.WorkspaceMode) throws
    -> WMWorkspace.WorkspaceMutationResult
  {
    try commit { try $0.setMode(of: name, to: mode) }
  }

  func configuredState(
    _ configuration: Configuration, defaultDisplayID: String, displays: [DisplayObservation],
    state source: WMWorkspace.WorkspaceState? = nil
  ) -> WMWorkspace.WorkspaceState {
    var candidate = source ?? state
    let configured = Dictionary(
      uniqueKeysWithValues: configuration.resolvedWorkspaces.map { ($0.name, $0.settings) })
    for name in configured.keys.sorted() where candidate[workspace: name] == nil {
      let settings = configured[name]!
      candidate.workspaces.append(
        .init(
          name: name, origin: .configured,
          displayID: settings.preferredDisplay.flatMap { resolve($0, displays: displays) }
            ?? defaultDisplayID
        ))
    }
    for index in candidate.workspaces.indices {
      var settings = configured[candidate.workspaces[index].name] ?? configuration.defaults
      candidate.workspaces[index].preferredDisplayID = settings.preferredDisplay.flatMap {
        resolve($0, displays: displays)
      }
      if candidate.runtimeDisplayAssignments[candidate.workspaces[index].name] == nil {
        candidate.workspaces[index].displayID =
          settings.preferredDisplay.flatMap { resolve($0, displays: displays) }
          ?? candidate.workspaces[index].displayID
      }
      for displaySettings in configuration.displays
      where
        displaySettings.display.id == "*"
        || resolve(displaySettings.display, displays: displays)
          == candidate.workspaces[index].displayID
      {
        settings.margin =
          displaySettings.margin.map { $0.inheriting(settings.margin ?? .init()) }
          ?? settings.margin
        settings.gap = displaySettings.gap ?? settings.gap
      }
      candidate.workspaces[index].mode = settings.mode == .floating ? .floating : .bsp
      let margin = settings.margin ?? .init()
      candidate.workspaces[index].margin = .init(
        top: margin.top ?? 0, right: margin.right ?? 0,
        bottom: margin.bottom ?? 0, left: margin.left ?? 0
      )
      candidate.workspaces[index].gap = settings.gap ?? 0
      candidate.workspaces[index].resizeIncrement = settings.resizeIncrement ?? 10
      candidate.workspaces[index].layoutPolicy =
        (settings.layoutPolicy ?? [.greedy, .overlap, .stack, .overflow]).map {
          WMWorkspace.LayoutPolicy(rawValue: $0.rawValue)!
        }
      candidate.workspaces[index].maxGeometryRetries = settings.maxGeometryRetries ?? 5
      candidate.workspaces[index].geometryProfileMode =
        switch settings.geometryProfileMode ?? .store {
        case .store: .store
        case .infer: .infer
        case .optimistic: .optimistic
        }
    }
    return candidate
  }

  private func resolve(_ affinity: DisplayAffinity, displays: [DisplayObservation]) -> String? {
    let matches = displays.filter { display in
      if let id = affinity.id { return display.id == id }
      if let value = affinity.coreGraphicsDisplayID {
        return display.identifiers.cgDirectDisplayID == value
      }
      if let value = affinity.nsScreenNumber { return display.identifiers.nsscreenNumber == value }
      if let name = affinity.name { return display.name == name }
      return false
    }
    return matches.count == 1 ? matches[0].id : nil
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
