import Foundation

public enum WorkspaceValidationIssue: Equatable, Sendable {
    case duplicateWorkspaceName(WorkspaceName)
    case duplicateWindowID(WorkspaceWindowID)
    case invalidSplitRatio(workspace: WorkspaceName, ratio: Double)
    case bspWindowMissingFromMembership(workspace: WorkspaceName, windowID: WorkspaceWindowID)
    case tiledWindowMissingFromBSP(workspace: WorkspaceName, windowID: WorkspaceWindowID)
    case focusedWindowMissingFromMembership(workspace: WorkspaceName, windowID: WorkspaceWindowID)
    case focusedWorkspaceMissing(WorkspaceName)
    case focusedWorkspaceMismatch(expected: WorkspaceName, actual: WorkspaceName?)
    case multipleFocusedWorkspaces([WorkspaceName])
    case multipleVisibleWorkspaces(displayID: WorkspaceDisplayID, names: [WorkspaceName])
    case displayVisibleWorkspaceMismatch(displayID: WorkspaceDisplayID, expected: WorkspaceName?, actual: WorkspaceName?)
    case previousWorkspaceInvalid(displayID: WorkspaceDisplayID, name: WorkspaceName)
    case runtimeAssignmentInvalid(workspace: WorkspaceName, displayID: WorkspaceDisplayID)
    case parkedWindowMissing(WorkspaceWindowID)
    case invalidLayoutPolicy(WorkspaceName)
}

public struct WorkspaceValidationError: Error, Equatable, Sendable {
    public var issues: [WorkspaceValidationIssue]

    public init(issues: [WorkspaceValidationIssue]) {
        self.issues = issues
    }
}

extension WorkspaceState {
    public func validationIssues() -> [WorkspaceValidationIssue] {
        var issues: [WorkspaceValidationIssue] = []
        let groupedNames = Dictionary(grouping: workspaces, by: \.name)
        issues += groupedNames.filter { $0.value.count > 1 }.keys.sorted().map(WorkspaceValidationIssue.duplicateWorkspaceName)

        let groupedWindows = Dictionary(grouping: workspaces.flatMap(\.windowIDs), by: { $0 })
        issues += groupedWindows.filter { $0.value.count > 1 }.keys.sorted().map(WorkspaceValidationIssue.duplicateWindowID)
        for workspace in workspaces { validateWorkspace(workspace, into: &issues) }

        let focused = workspaces.filter(\.focused).map(\.name).sorted()
        if focused.count > 1 { issues.append(.multipleFocusedWorkspaces(focused)) }
        if let expected = focusedWorkspaceName {
            if self[workspace: expected] == nil {
                issues.append(.focusedWorkspaceMissing(expected))
            } else if focused != [expected] {
                issues.append(.focusedWorkspaceMismatch(expected: expected, actual: focused.first))
            }
        } else if let actual = focused.first {
            issues.append(.focusedWorkspaceMismatch(expected: "", actual: actual))
        }

        for (displayID, names) in Dictionary(grouping: workspaces.filter(\.visible), by: \.displayID) {
            if names.count > 1 { issues.append(.multipleVisibleWorkspaces(displayID: displayID, names: names.map(\.name).sorted())) }
        }
        let allDisplayIDs = Set(displays.keys).union(workspaces.map(\.displayID))
        for displayID in allDisplayIDs.sorted() {
            let actual = workspaces.first { $0.displayID == displayID && $0.visible }?.name
            let expected = displays[displayID]?.visibleWorkspaceName
            if actual != expected { issues.append(.displayVisibleWorkspaceMismatch(displayID: displayID, expected: expected, actual: actual)) }
            if let previous = displays[displayID]?.previousWorkspaceName,
               self[workspace: previous]?.displayID != displayID || previous == expected {
                issues.append(.previousWorkspaceInvalid(displayID: displayID, name: previous))
            }
        }
        for (name, displayID) in runtimeDisplayAssignments.sorted(by: { $0.key < $1.key }) where self[workspace: name]?.displayID != displayID {
            issues.append(.runtimeAssignmentInvalid(workspace: name, displayID: displayID))
        }
        let assignedWindows = Set(workspaces.flatMap(\.windowIDs))
        for id in parkedWindowFrames.keys.sorted() where !assignedWindows.contains(id) {
            issues.append(.parkedWindowMissing(id))
        }
        return issues
    }

    public func validate() throws {
        let issues = validationIssues()
        if !issues.isEmpty { throw WorkspaceValidationError(issues: issues) }
    }
}

private func validateWorkspace(_ workspace: Workspace, into issues: inout [WorkspaceValidationIssue]) {
    if (try? LayoutPolicy.validate(workspace.layoutPolicy)) == nil {
        issues.append(.invalidLayoutPolicy(workspace.name))
    }
    let leaves = workspace.bsp.root?.windowIDs ?? []
    for (id, matches) in Dictionary(grouping: leaves, by: { $0 }) where matches.count > 1 {
        issues.append(.duplicateWindowID(id))
    }
    for id in leaves where !workspace.windowIDs.contains(id) {
        issues.append(.bspWindowMissingFromMembership(workspace: workspace.name, windowID: id))
    }
    if workspace.mode == .bsp {
        for id in workspace.windowIDs where !leaves.contains(id) {
            issues.append(.tiledWindowMissingFromBSP(workspace: workspace.name, windowID: id))
        }
    }
    if let focused = workspace.focusedWindowID, !workspace.windowIDs.contains(focused) {
        issues.append(.focusedWindowMissingFromMembership(workspace: workspace.name, windowID: focused))
    }
    validateRatios(workspace.bsp.root, workspace: workspace.name, into: &issues)
}

private func validateRatios(_ node: BSPNode?, workspace: WorkspaceName, into issues: inout [WorkspaceValidationIssue]) {
    guard let node else { return }
    guard case let .split(_, ratio, first, second) = node else { return }
    if !ratio.isFinite || ratio <= 0 || ratio >= 1 {
        issues.append(.invalidSplitRatio(workspace: workspace, ratio: ratio))
    }
    validateRatios(first, workspace: workspace, into: &issues)
    validateRatios(second, workspace: workspace, into: &issues)
}
