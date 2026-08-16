import Foundation
import Testing

@testable import WMWorkspace

@Test func bspCodableAndRecursiveTransformations() throws {
  let tree = BSPTree(
    root: .split(
      axis: .vertical,
      ratio: 0.4,
      first: .leaf(windowID: "a"),
      second: .split(
        axis: .horizontal, ratio: 0.6, first: .leaf(windowID: "b"), second: .leaf(windowID: "c"))
    ))
  let inserted = try #require(tree.root?.inserting(windowID: "d", beside: "b"))
  #expect(inserted.windowIDs == ["a", "b", "d", "c"])
  #expect(inserted.removing(windowID: "b")?.windowIDs == ["a", "d", "c"])
  let data = try JSONEncoder().encode(BSPTree(root: inserted))
  #expect(try JSONDecoder().decode(BSPTree.self, from: data) == BSPTree(root: inserted))
}

@Test func focusCreatesAndParksWithLifecycleCleanup() throws {
  var state = WorkspaceState()
  let created = try state.focusWorkspace(named: "one", displayID: "d1")
  #expect(created.modifiedWorkspaces == ["one"])
  #expect(state[workspace: "one"]?.visible == true)

  let second = try state.focusWorkspace(named: "two")
  #expect(second.deletedWorkspaces == ["one"])
  #expect(state.focusedWorkspaceName == "two")
  #expect(state.displays["d1"]?.visibleWorkspaceName == "two")
  #expect(state.workspaces.map(\.name) == ["two"])
}

@Test func configuredEmptyWorkspaceSurvivesParking() throws {
  var state = WorkspaceState(
    workspaces: [
      .init(name: "configured", origin: .configured, displayID: "d", visible: true, focused: true)
    ],
    focusedWorkspaceName: "configured",
    displays: ["d": .init(visibleWorkspaceName: "configured")]
  )
  let result = try state.focusWorkspace(named: "runtime")
  #expect(result.deletedWorkspaces.isEmpty)
  #expect(state[workspace: "configured"] != nil)
  #expect(state[workspace: "configured"]?.visible == false)
}

@Test func deletingNewEmptyWorkspaceRestoresOlderHistory() throws {
  var state = WorkspaceState(
    workspaces: [
      tiled("older", display: "d", windows: ["a"]),
      .init(name: "empty", origin: .runtime, displayID: "d", visible: true, focused: true),
    ],
    focusedWorkspaceName: "empty",
    displays: ["d": .init(visibleWorkspaceName: "empty", previousWorkspaceName: "older")]
  )
  _ = try state.focusWorkspace(named: "new")
  #expect(state.displays["d"] == .init(visibleWorkspaceName: "new", previousWorkspaceName: "older"))
  #expect(state[workspace: "empty"] == nil)
}

@Test func focusingPopulatedWorkspaceAfterEmptyRuntimeWorkspaceKeepsHistoryValid() throws {
  var state = WorkspaceState(
    workspaces: [tiled("T", display: "d", windows: ["ghostty"], visible: true, focused: true)],
    focusedWorkspaceName: "T",
    displays: ["d": .init(visibleWorkspaceName: "T")]
  )

  _ = try state.focusWorkspace(named: "B")
  #expect(state.displays["d"] == .init(visibleWorkspaceName: "B", previousWorkspaceName: "T"))
  try state.validate()

  _ = try state.focusWorkspace(named: "T")
  #expect(state[workspace: "B"] == nil)
  #expect(state.displays["d"] == .init(visibleWorkspaceName: "T"))
  try state.validate()
}

@Test func moveWindowsCollapsesSourcesAndInsertsDeterministically() throws {
  var state = sampleState()
  let result = try state.moveWindows(["b", "a"], to: "destination")
  #expect(result.splitDecision == .provisionalVerticalHalf)
  #expect(result.modifiedWorkspaces == ["destination", "source"])
  #expect(state[workspace: "source"]?.windowIDs == ["c"])
  #expect(state[workspace: "source"]?.bsp.root == .leaf(windowID: "c"))
  #expect(state[workspace: "destination"]?.windowIDs == ["b", "a"])
  #expect(state[workspace: "destination"]?.bsp.root?.windowIDs == ["b", "a"])
  #expect(state[workspace: "destination"]?.focusedWindowID == "a")
  #expect(state.focusedWorkspaceName == "destination")
}

@Test func failedMultiWindowMoveIsAtomic() throws {
  var state = sampleState()
  let original = state
  #expect(throws: WorkspaceMutationError.windowNotFound("missing")) {
    try state.moveWindows(["a", "missing"], to: "destination")
  }
  #expect(state == original)
}

@Test func newDestinationUsesLiveWindowDisplay() throws {
  var state = sampleState()
  _ = try state.moveWindows(["a"], to: "destination", displayID: "live-display")

  #expect(state[workspace: "destination"]?.displayID == "live-display")
}

@Test func singleWindowBSPUsesFullBounds() {
  let workspace = tiled("single", display: "d", windows: ["zen"])

  #expect(
    workspace.layout(in: .init(x: 0, y: 32, width: 1512, height: 950))["zen"]
      == .init(x: 0, y: 32, width: 1512, height: 950))
}

@Test func moveDisplayUpdatesBothHistorySlots() throws {
  var state = WorkspaceState(
    workspaces: [
      tiled("moving", display: "left", windows: ["m"], visible: true, focused: true),
      tiled("leftPrevious", display: "left", windows: ["l"]),
      tiled("occupied", display: "right", windows: ["r"], visible: true),
    ],
    focusedWorkspaceName: "moving",
    displays: [
      "left": .init(visibleWorkspaceName: "moving", previousWorkspaceName: "leftPrevious"),
      "right": .init(visibleWorkspaceName: "occupied"),
    ]
  )
  let result = try state.moveWorkspace(named: "moving", to: "right")
  #expect(result.modifiedWorkspaces == ["leftPrevious", "moving", "occupied"])
  #expect(state.displays["left"] == .init(visibleWorkspaceName: "leftPrevious"))
  #expect(
    state.displays["right"]
      == .init(visibleWorkspaceName: "moving", previousWorkspaceName: "occupied"))
  #expect(state.runtimeDisplayAssignments == ["moving": "right"])
  #expect(state[workspace: "moving"]?.focused == true)
}

@Test func movedWorkspaceRecalculatesEveryWindowForDestinationBounds() throws {
  var state = WorkspaceState(
    workspaces: [
      tiled("moving", display: "small", windows: ["a", "b", "c"], visible: true, focused: true)
    ],
    focusedWorkspaceName: "moving",
    displays: ["small": .init(visibleWorkspaceName: "moving")]
  )
  _ = try state.moveWorkspace(named: "moving", to: "large")
  let workspace = try #require(state[workspace: "moving"])
  let destination = WorkspaceLayoutRect(x: -1030, y: -1440, width: 3440, height: 1440)
  let frames = workspace.layout(in: destination)

  #expect(frames.keys.sorted() == ["a", "b", "c"])
  #expect(
    frames.values.allSatisfy { frame in
      frame.x >= destination.x && frame.y >= destination.y
        && frame.x + frame.width <= destination.x + destination.width
        && frame.y + frame.height <= destination.y + destination.height
    })
  #expect(frames.values.map(\.width).reduce(0, +) > 1512)
}

@Test func modeChangeDoesNotRebuildTree() throws {
  var state = sampleState()
  let tree = state[workspace: "source"]?.bsp
  let result = try state.setMode(of: "source", to: .floating)
  #expect(result.modifiedWorkspaces == ["source"])
  #expect(state[workspace: "source"]?.bsp == tree)
}

@Test func directionalFocusUsesSpatialCentersAndRemembersTarget() throws {
  var state = directionalState()
  let bounds = WorkspaceLayoutRect(x: 0, y: 0, width: 1200, height: 800)

  let result = try state.focusWindow(direction: .down, bounds: bounds)

  #expect(result.result.modifiedWorkspaces == ["grid"])
  #expect(result.targetWindowID == "bottom-right")
  #expect(state[workspace: "grid"]?.focusedWindowID == "bottom-right")
  #expect(state[workspace: "grid"]?.bsp.root?.windowIDs == ["left", "top-right", "bottom-right"])
}

@Test func directionalMoveSwapsLeavesAndMembershipOrderDeterministically() throws {
  var state = directionalState()
  let bounds = WorkspaceLayoutRect(x: 0, y: 0, width: 1200, height: 800)

  _ = try state.moveWindow(direction: .left, bounds: bounds)

  #expect(state[workspace: "grid"]?.focusedWindowID == "top-right")
  #expect(state[workspace: "grid"]?.bsp.root?.windowIDs == ["top-right", "left", "bottom-right"])
  #expect(state[workspace: "grid"]?.windowIDs == ["top-right", "left", "bottom-right"])
}

@Test func directionalCommandsRejectEdgesFloatingAndMissingFocusAtomically() throws {
  let bounds = WorkspaceLayoutRect(x: 0, y: 0, width: 1200, height: 800)
  var edge = directionalState()
  let original = edge
  #expect(throws: WorkspaceMutationError.directionalTargetNotFound(windowID: "top-right", direction: .up)) {
    try edge.focusWindow(direction: .up, bounds: bounds)
  }
  #expect(edge == original)

  var floating = directionalState()
  floating.workspaces[0].mode = .floating
  #expect(throws: WorkspaceMutationError.bspWorkspaceRequired("grid")) {
    try floating.moveWindow(direction: .left, bounds: bounds)
  }

  var missing = directionalState()
  missing.workspaces[0].focusedWindowID = nil
  #expect(throws: WorkspaceMutationError.focusedWindowRequired("grid")) {
    try missing.focusWindow(direction: .left, bounds: bounds)
  }
}

@Test func validationReportsTreeAndDisplayViolations() {
  let state = WorkspaceState(
    workspaces: [
      .init(
        name: "bad", origin: .runtime, displayID: "d", visible: true,
        windowIDs: ["a"], focusedWindowID: "missing",
        bsp: .init(
          root: .split(
            axis: .vertical, ratio: .nan, first: .leaf(windowID: "a"),
            second: .leaf(windowID: "outside")))
      )
    ]
  )
  #expect(
    state.validationIssues().contains { issue in
      guard case .invalidSplitRatio(workspace: "bad", let ratio) = issue else { return false }
      return ratio.isNaN
    })
  #expect(
    state.validationIssues().contains(
      .bspWindowMissingFromMembership(workspace: "bad", windowID: "outside")))
  #expect(
    state.validationIssues().contains(
      .focusedWindowMissingFromMembership(workspace: "bad", windowID: "missing")))
  #expect(
    state.validationIssues().contains(
      .displayVisibleWorkspaceMismatch(displayID: "d", expected: nil, actual: "bad")))
}

@Test func workspaceStateRoundTripsJSON() throws {
  let state = sampleState()
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys]
  let data = try encoder.encode(state)
  #expect(try JSONDecoder().decode(WorkspaceState.self, from: data) == state)
  #expect(String(decoding: data, as: UTF8.self).contains("\"focused_workspace_name\""))
}

@Test func findsWorkspaceContainingExternallyFocusedWindow() {
  let state = WorkspaceState(workspaces: [
    tiled("one", display: "d", windows: ["a"]),
    tiled("two", display: "d", windows: ["b"]),
  ])

  #expect(state.workspaceName(containing: "b") == "two")
  #expect(state.workspaceName(containing: "missing") == nil)
}

@Test func externalFocusOverridesRememberedWorkspaceWindow() {
  var state = WorkspaceState(workspaces: [
    .init(
      name: "one", origin: .configured, displayID: "d", windowIDs: ["zen", "messages"],
      focusedWindowID: "messages")
  ])

  state.setFocusedWindow("zen", in: "one")
  #expect(state[workspace: "one"]?.focusedWindowID == "zen")
}

@Test func externalZenTransitionParksVisibleGhosttyWorkspace() {
  let before = WorkspaceState(
    workspaces: [
      tiled("1", display: "d", windows: ["zen"]),
      tiled("T", display: "d", windows: ["ghostty"], visible: true, focused: true),
    ],
    focusedWorkspaceName: "T",
    displays: ["d": .init(visibleWorkspaceName: "T")]
  )
  var after = before
  let mutation = try? after.focusWorkspace(named: "1")
  let plan = WorkspaceTransitionPlan(
    before: before, after: mutation?.workspaceState ?? after, destination: "1")

  #expect(plan.incomingWindowIDs == ["zen"])
  #expect(plan.outgoingWindowIDs == ["ghostty"])
}

@Test func focusingVisibleWorkspaceOnAnotherDisplayDoesNotParkOtherDisplays() throws {
  let before = WorkspaceState(
    workspaces: [
      tiled("left", display: "d1", windows: ["left-window"], visible: true, focused: true),
      tiled("right", display: "d2", windows: ["right-window"], visible: true),
    ],
    focusedWorkspaceName: "left",
    displays: [
      "d1": .init(visibleWorkspaceName: "left"),
      "d2": .init(visibleWorkspaceName: "right"),
    ]
  )
  var after = before
  let mutation = try after.focusWorkspace(named: "right")
  let plan = WorkspaceTransitionPlan(
    before: before, after: mutation.workspaceState, destination: "right")

  #expect(plan.incomingWindowIDs == ["right-window"])
  #expect(plan.outgoingWindowIDs.isEmpty)
}

@Test func topologyMigrationRestoresDisconnectedDisplayArrangement() throws {
  var state = WorkspaceState(
    workspaces: [
      tiled("left", display: "d1", windows: ["left-window"], visible: true, focused: true),
      tiled("right", display: "d2", windows: ["right-window"], visible: true),
      tiled("right-old", display: "d2", windows: ["old-window"]),
    ],
    focusedWorkspaceName: "left",
    displays: [
      "d1": .init(visibleWorkspaceName: "left"),
      "d2": .init(visibleWorkspaceName: "right", previousWorkspaceName: "right-old"),
    ]
  )

  _ = try state.reconcileDisplayTopology(connectedDisplayIDs: ["d1"], fallbackDisplayID: "d1")
  #expect(state[workspace: "right"]?.displayID == "d1")
  #expect(state[workspace: "right"]?.visible == false)
  #expect(state.disconnectedDisplays["d2"]?.visibleWorkspaceName == "right")

  _ = try state.reconcileDisplayTopology(
    connectedDisplayIDs: ["d1", "d2"], fallbackDisplayID: "d1")
  #expect(state[workspace: "right"]?.displayID == "d2")
  #expect(state[workspace: "right"]?.visible == true)
  #expect(
    state.displays["d2"] == .init(visibleWorkspaceName: "right", previousWorkspaceName: "right-old")
  )
  #expect(state.disconnectedDisplays.isEmpty)
  try state.validate()
}

@Test func observedWindowReconciliationPreservesMissingAssignmentsAndAdoptsIntoOne() throws {
  var state = WorkspaceState(
    workspaces: [
      .init(
        name: "1", origin: .configured, displayID: "d",
        windowIDs: ["keep", "closed"], focusedWindowID: "closed",
        bsp: .init(
          root: .split(
            axis: .vertical, ratio: 0.5,
            first: .leaf(windowID: "keep"), second: .leaf(windowID: "closed")
          ))
      ),
      tiled("focused", display: "d", windows: ["focused-window"], visible: true, focused: true),
    ],
    focusedWorkspaceName: "focused",
    displays: ["d": .init(visibleWorkspaceName: "focused")],
    parkedWindowFrames: ["closed": .init(x: 1, y: 2, width: 3, height: 4)]
  )

  let result = try state.reconcileObservedWindows(
    ["new-b", "keep", "new-a", "focused-window"], defaultDisplayID: "d")

  #expect(result.modifiedWorkspaces == ["1"])
  #expect(state[workspace: "1"]?.windowIDs == ["keep", "closed", "new-a", "new-b"])
  #expect(state[workspace: "1"]?.bsp.root?.windowIDs == ["keep", "closed", "new-a", "new-b"])
  #expect(state[workspace: "1"]?.focusedWindowID == "new-b")
  #expect(state[workspace: "focused"]?.windowIDs == ["focused-window"])
  #expect(state.parkedWindowFrames["closed"] == .init(x: 1, y: 2, width: 3, height: 4))

  let unchanged = try state.reconcileObservedWindows(
    ["new-b", "keep", "new-a", "focused-window"], defaultDisplayID: "d")
  #expect(unchanged.modifiedWorkspaces.isEmpty)
}

@Test func verifiedCloseCollapsesBSPAndClearsParkingImmediately() throws {
  var state = WorkspaceState(
    workspaces: [tiled("1", display: "d", windows: ["a", "closed", "b"])],
    parkedWindowFrames: ["closed": .init(x: 1, y: 2, width: 3, height: 4)]
  )

  let result = try state.reconcileObservedWindows(
    ["a", "b"], removedWindowIDs: ["closed"], defaultDisplayID: "d"
  )

  #expect(result.modifiedWorkspaces == ["1"])
  #expect(state[workspace: "1"]?.windowIDs == ["a", "b"])
  #expect(state[workspace: "1"]?.bsp.root?.windowIDs == ["a", "b"])
  #expect(state.parkedWindowFrames["closed"] == nil)
}

@Test func initialAssignmentsOnlyPlaceUnassignedWindows() throws {
  var state = WorkspaceState(workspaces: [
    tiled("M", display: "d", windows: ["manually-moved"]),
    tiled("other", display: "d", windows: []),
  ])

  let result = try state.reconcileObservedWindows(
    ["manually-moved", "messages", "fallback"],
    initialAssignments: ["manually-moved": "other", "messages": "M"],
    defaultDisplayID: "d"
  )

  #expect(result.modifiedWorkspaces == ["1", "M"])
  #expect(state[workspace: "M"]?.windowIDs == ["manually-moved", "messages"])
  #expect(state[workspace: "other"]?.windowIDs.isEmpty == true)
  #expect(state[workspace: "1"]?.windowIDs == ["fallback"])
}

@Test func sameIDReplacementIsRemovedThenFreshlyInserted() throws {
  var state = WorkspaceState(workspaces: [tiled("old", display: "d", windows: ["a", "sibling"])])

  _ = try state.reconcileObservedWindows(
    ["a", "sibling"], removedWindowIDs: ["a"], defaultDisplayID: "d")

  #expect(state[workspace: "old"]?.windowIDs == ["sibling"])
  #expect(state[workspace: "1"]?.windowIDs == ["a"])
  #expect(state[workspace: "old"]?.bsp.root == .leaf(windowID: "sibling"))
  #expect(state[workspace: "1"]?.bsp.root == .leaf(windowID: "a"))
}

@Test func identifiedReplacementPreservesWorkspaceMembership() throws {
  var state = WorkspaceState(workspaces: [tiled("C", display: "d", windows: ["settings-old"])])
  _ = try state.reconcileObservedWindows(
    ["settings-new"], replacements: ["settings-old": "settings-new"],
    removedWindowIDs: ["settings-old"], defaultDisplayID: "d")
  #expect(state[workspace: "C"]?.windowIDs == ["settings-new"])
  #expect(state[workspace: "1"] == nil)
}

@Test func bspLayoutAdaptsToObservedMinimumWidths() {
  let workspace = Workspace(
    name: "tile", origin: .runtime, displayID: "d",
    gap: 8,
    windowIDs: ["spotify", "ghostty"],
    bsp: .init(
      root: .split(
        axis: .vertical, ratio: 0.5,
        first: .leaf(windowID: "spotify"), second: .leaf(windowID: "ghostty")
      ))
  )

  let layout = workspace.layout(
    in: .init(x: 0, y: 32, width: 1512, height: 950),
    minimumSizes: ["spotify": .init(width: 800, height: 0)]
  )

  #expect(layout["spotify"] == .init(x: 0, y: 32, width: 800, height: 950))
  #expect(layout["ghostty"] == .init(x: 808, y: 32, width: 704, height: 950))
}

@Test func greedyGivesSurplusToPeerOfMaximumWidthWindow() {
  var workspace = tiled("settings", display: "d", windows: ["settings", "peer"])
  workspace.bsp.root = .split(
    axis: .vertical, ratio: 0.5,
    first: .leaf(windowID: "settings"), second: .leaf(windowID: "peer"))
  let plan = workspace.layoutPlan(
    in: .init(x: 0, y: 0, width: 1_512, height: 950),
    cooperation: [
      "settings": .init(maximumSize: .init(width: 723), isCooperative: false),
      "peer": .init(),
    ])
  guard case .frames(let frames) = plan else { Issue.record("expected frames"); return }
  #expect(frames["settings"]?.width == 723)
  #expect(frames["peer"]?.width == 781)
}

@Test func bspLayoutReportsWhenMinimumSizesCannotFit() {
  let workspace = tiled("tile", display: "d", windows: ["a", "b", "c"])
  let bounds = WorkspaceLayoutRect(x: 0, y: 32, width: 1512, height: 950)

  #expect(
    !workspace.canFit(
      in: bounds,
      minimumSizes: [
        "a": .init(width: 700), "b": .init(width: 800), "c": .init(width: 744),
      ]))
  #expect(
    workspace.canFit(
      in: bounds,
      minimumSizes: [
        "a": .init(width: 400), "b": .init(width: 400), "c": .init(width: 400),
      ]))
}

@Test func uncooperativePoliciesProduceDeterministicPlans() {
  var workspace = tiled("tile", display: "d", windows: ["a", "b"])
  workspace.focusedWindowID = "b"
  let bounds = WorkspaceLayoutRect(x: 0, y: 0, width: 1000, height: 600)
  let cooperation = [
    "a": WorkspaceWindowCooperation(minimumSize: .init(width: 700), isCooperative: false),
    "b": WorkspaceWindowCooperation(minimumSize: .init(width: 292)),
  ]

  workspace.layoutPolicy = [.greedy]
  guard case .frames(let greedy) = workspace.layoutPlan(in: bounds, cooperation: cooperation) else {
    Issue.record("expected greedy frames")
    return
  }
  #expect(greedy["a"]?.width == 700)
  #expect(greedy["b"]?.width == 292)

  workspace.layoutPolicy = [.stack]
  #expect(
    workspace.layoutPlan(in: bounds, cooperation: cooperation)
      == .frames([
        "a": bounds, "b": bounds,
      ]))

  workspace.layoutPolicy = [.overlap]
  guard case .frames(let overlap) = workspace.layoutPlan(in: bounds, cooperation: cooperation)
  else {
    Issue.record("expected overlap frames")
    return
  }
  #expect(overlap["a"] == .init(x: 0, y: 0, width: 700, height: 600))
  #expect(overlap["b"] == .init(x: 504, y: 0, width: 496, height: 600))

  workspace.layoutPolicy = [.reject]
  #expect(workspace.layoutPlan(in: bounds, cooperation: cooperation) == .rejected)
}

@Test func uncooperativePoliciesHandleInfeasibleMinimums() {
  var workspace = tiled("tile", display: "d", windows: ["a", "b"])
  workspace.focusedWindowID = "b"
  let bounds = WorkspaceLayoutRect(x: 0, y: 0, width: 1_000, height: 600)
  let cooperation = [
    "a": WorkspaceWindowCooperation(minimumSize: .init(width: 700), isCooperative: false),
    "b": WorkspaceWindowCooperation(minimumSize: .init(width: 500)),
  ]

  workspace.layoutPolicy = [.greedy, .overlap, .stack, .overflow]
  #expect(workspace.layoutPlan(in: bounds, cooperation: cooperation) == .frames([
    "a": .init(x: 0, y: 0, width: 700, height: 600),
    "b": .init(x: 500, y: 0, width: 500, height: 600),
  ]))

  workspace.layoutPolicy = [.stack]
  #expect(
    workspace.layoutPlan(in: bounds, cooperation: cooperation)
      == .frames([
        "a": bounds, "b": bounds,
      ]))

  workspace.layoutPolicy = [.overlap, .overflow]
  #expect(
    workspace.layoutPlan(in: bounds, cooperation: cooperation)
      == .frames([
        "a": .init(x: 0, y: 0, width: 700, height: 600),
        "b": .init(x: 500, y: 0, width: 500, height: 600),
      ]))

  workspace.layoutPolicy = [.reject]
  #expect(workspace.layoutPlan(in: bounds, cooperation: cooperation) == .rejected)

  let oversized = [
    "a": WorkspaceWindowCooperation(minimumSize: .init(width: 1_100), isCooperative: false),
    "b": WorkspaceWindowCooperation(),
  ]
  workspace.layoutPolicy = [.overlap, .overflow]
  #expect(workspace.layoutPlan(in: bounds, cooperation: oversized) == .frames([
    "a": .init(x: 0, y: 0, width: 1_100, height: 600),
    "b": .init(x: 504, y: 0, width: 496, height: 600),
  ]))
}

@Test func layoutPolicyOrchestrationReportsFallbackAndOverflowAllocation() {
  var workspace = Workspace(name: "1", origin: .configured, displayID: "main")
  workspace.windowIDs = ["a", "b"]
  workspace.bsp.root = .split(axis: .vertical, ratio: 0.5, first: .leaf(windowID: "a"), second: .leaf(windowID: "b"))
  workspace.layoutPolicy = [.greedy, .overlap, .overflow]
  let result = workspace.layoutResult(in: .init(x: 0, y: 0, width: 1_000, height: 600), cooperation: [
    "a": .init(minimumSize: .init(width: 1_100), isCooperative: false),
    "b": .init(),
  ])
  #expect(result.requestedChain == [.greedy, .overlap, .overflow])
  #expect(result.attemptedChain == [.greedy, .overlap, .overflow])
  #expect(result.effectivePolicy == .overflow)
  #expect(result.fallbackOccurred)
  #expect(result.plan == .frames([
    "a": .init(x: 0, y: 0, width: 1_100, height: 600),
    "b": .init(x: 504, y: 0, width: 496, height: 600),
  ]))
}

private func sampleState() -> WorkspaceState {
  WorkspaceState(
    workspaces: [
      tiled("source", display: "d", windows: ["a", "b", "c"], visible: true, focused: true)
    ],
    focusedWorkspaceName: "source",
    displays: ["d": .init(visibleWorkspaceName: "source")]
  )
}

private func directionalState() -> WorkspaceState {
  let root = BSPNode.split(
    axis: .vertical, ratio: 0.5,
    first: .leaf(windowID: "left"),
    second: .split(
      axis: .horizontal, ratio: 0.5,
      first: .leaf(windowID: "top-right"), second: .leaf(windowID: "bottom-right")
    )
  )
  return WorkspaceState(
    workspaces: [.init(
      name: "grid", origin: .configured, displayID: "d", visible: true, focused: true,
      windowIDs: root.windowIDs, focusedWindowID: "top-right", bsp: .init(root: root)
    )],
    focusedWorkspaceName: "grid", displays: ["d": .init(visibleWorkspaceName: "grid")]
  )
}

private func tiled(
  _ name: String,
  display: String,
  windows: [String],
  visible: Bool = false,
  focused: Bool = false
) -> Workspace {
  var root: BSPNode?
  for window in windows {
    if let existing = root, let target = existing.windowIDs.last {
      root = existing.inserting(windowID: window, beside: target)
    } else {
      root = .leaf(windowID: window)
    }
  }
  return .init(
    name: name, origin: .runtime, displayID: display, visible: visible, focused: focused,
    windowIDs: windows, focusedWindowID: windows.last, bsp: .init(root: root)
  )
}
