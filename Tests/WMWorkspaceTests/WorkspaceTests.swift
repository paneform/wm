import Foundation
import Testing
@testable import WMWorkspace

@Test func bspCodableAndRecursiveTransformations() throws {
    let tree = BSPTree(root: .split(
        axis: .vertical,
        ratio: 0.4,
        first: .leaf(windowID: "a"),
        second: .split(axis: .horizontal, ratio: 0.6, first: .leaf(windowID: "b"), second: .leaf(windowID: "c"))
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
        workspaces: [.init(name: "configured", origin: .configured, displayID: "d", visible: true, focused: true)],
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

    #expect(workspace.layout(in: .init(x: 0, y: 32, width: 1512, height: 950))["zen"] == .init(x: 0, y: 32, width: 1512, height: 950))
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
    #expect(state.displays["right"] == .init(visibleWorkspaceName: "moving", previousWorkspaceName: "occupied"))
    #expect(state.runtimeDisplayAssignments == ["moving": "right"])
    #expect(state[workspace: "moving"]?.focused == true)
}

@Test func modeChangeDoesNotRebuildTree() throws {
    var state = sampleState()
    let tree = state[workspace: "source"]?.bsp
    let result = try state.setMode(of: "source", to: .floating)
    #expect(result.modifiedWorkspaces == ["source"])
    #expect(state[workspace: "source"]?.bsp == tree)
}

@Test func validationReportsTreeAndDisplayViolations() {
    let state = WorkspaceState(
        workspaces: [
            .init(
                name: "bad", origin: .runtime, displayID: "d", visible: true,
                windowIDs: ["a"], focusedWindowID: "missing",
                bsp: .init(root: .split(axis: .vertical, ratio: .nan, first: .leaf(windowID: "a"), second: .leaf(windowID: "outside")))
            )
        ]
    )
    #expect(state.validationIssues().contains { issue in
        guard case .invalidSplitRatio(workspace: "bad", let ratio) = issue else { return false }
        return ratio.isNaN
    })
    #expect(state.validationIssues().contains(.bspWindowMissingFromMembership(workspace: "bad", windowID: "outside")))
    #expect(state.validationIssues().contains(.focusedWindowMissingFromMembership(workspace: "bad", windowID: "missing")))
    #expect(state.validationIssues().contains(.displayVisibleWorkspaceMismatch(displayID: "d", expected: nil, actual: "bad")))
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
        .init(name: "one", origin: .configured, displayID: "d", windowIDs: ["zen", "messages"], focusedWindowID: "messages"),
    ])

    state.setFocusedWindow("zen", in: "one")
    #expect(state[workspace: "one"]?.focusedWindowID == "zen")
}

@Test func observedWindowReconciliationPreservesMissingAssignmentsAndAdoptsIntoOne() throws {
    var state = WorkspaceState(
        workspaces: [
            .init(
                name: "1", origin: .configured, displayID: "d",
                windowIDs: ["keep", "closed"], focusedWindowID: "closed",
                bsp: .init(root: .split(
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

    let result = try state.reconcileObservedWindows(["new-b", "keep", "new-a", "focused-window"], defaultDisplayID: "d")

    #expect(result.modifiedWorkspaces == ["1"])
    #expect(state[workspace: "1"]?.windowIDs == ["keep", "closed", "new-a", "new-b"])
    #expect(state[workspace: "1"]?.bsp.root?.windowIDs == ["keep", "closed", "new-a", "new-b"])
    #expect(state[workspace: "1"]?.focusedWindowID == "new-b")
    #expect(state[workspace: "focused"]?.windowIDs == ["focused-window"])
    #expect(state.parkedWindowFrames["closed"] == .init(x: 1, y: 2, width: 3, height: 4))

    let unchanged = try state.reconcileObservedWindows(["new-b", "keep", "new-a", "focused-window"], defaultDisplayID: "d")
    #expect(unchanged.modifiedWorkspaces.isEmpty)
}

@Test func bspLayoutAdaptsToObservedMinimumWidths() {
    let workspace = Workspace(
        name: "tile", origin: .runtime, displayID: "d",
        gap: 8,
        windowIDs: ["spotify", "ghostty"],
        bsp: .init(root: .split(
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

private func sampleState() -> WorkspaceState {
    WorkspaceState(
        workspaces: [tiled("source", display: "d", windows: ["a", "b", "c"], visible: true, focused: true)],
        focusedWorkspaceName: "source",
        displays: ["d": .init(visibleWorkspaceName: "source")]
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
