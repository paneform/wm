import Foundation

public enum WorkspaceMutationError: Error, Equatable, Sendable {
    case workspaceNotFound(WorkspaceName)
    case displayRequired(WorkspaceName)
    case duplicateWindowSelection(WorkspaceWindowID)
    case windowNotFound(WorkspaceWindowID)
    case windowAlreadyInDestination(windowID: WorkspaceWindowID, workspace: WorkspaceName)
    case invalidState([WorkspaceValidationIssue])
}

extension WorkspaceState {
    public mutating func focusWorkspace(
        named name: WorkspaceName,
        displayID: WorkspaceDisplayID? = nil
    ) throws -> WorkspaceMutationResult {
        try mutate { state in
            let created = state.index(of: name) == nil
            if created {
                guard let displayID = displayID ?? state.focusedWorkspace?.displayID else {
                    throw WorkspaceMutationError.displayRequired(name)
                }
                state.workspaces.append(.init(name: name, origin: .runtime, displayID: displayID))
            }
            var modified = Set<WorkspaceName>()
            var deleted: [WorkspaceName] = []
            state.revealAndFocus(name, modified: &modified, deleted: &deleted)
            return (WorkspaceMutationResult(workspaceState: state, modifiedWorkspaces: modified.sorted(), deletedWorkspaces: deleted.sorted()), created)
        }
    }

    public mutating func moveWindows(
        _ windowIDs: [WorkspaceWindowID],
        to destinationName: WorkspaceName
    ) throws -> WorkspaceMutationResult {
        try mutate { state in
            guard !windowIDs.isEmpty else {
                return (WorkspaceMutationResult(workspaceState: state, modifiedWorkspaces: []), false)
            }
            if let duplicate = firstDuplicate(in: windowIDs) {
                throw WorkspaceMutationError.duplicateWindowSelection(duplicate)
            }
            let sources = try windowIDs.map { windowID -> WorkspaceName in
                guard let source = state.workspaces.first(where: { $0.windowIDs.contains(windowID) }) else {
                    throw WorkspaceMutationError.windowNotFound(windowID)
                }
                if source.name == destinationName {
                    throw WorkspaceMutationError.windowAlreadyInDestination(windowID: windowID, workspace: destinationName)
                }
                return source.name
            }
            if state.index(of: destinationName) == nil {
                guard let sourceDisplay = state[workspace: sources[0]]?.displayID else {
                    throw WorkspaceMutationError.windowNotFound(windowIDs[0])
                }
                state.workspaces.append(.init(name: destinationName, origin: .runtime, displayID: sourceDisplay))
            }

            var modified = Set(sources)
            modified.insert(destinationName)
            for (windowID, sourceName) in zip(windowIDs, sources) {
                state.remove(windowID: windowID, from: sourceName)
                state.insert(windowID: windowID, into: destinationName)
            }
            var deleted: [WorkspaceName] = []
            state.revealAndFocus(destinationName, modified: &modified, deleted: &deleted)
            modified.subtract(deleted)
            return (
                WorkspaceMutationResult(
                    workspaceState: state,
                    modifiedWorkspaces: modified.sorted(),
                    deletedWorkspaces: deleted.sorted(),
                    splitDecision: .provisionalVerticalHalf
                ),
                true
            )
        }
    }

    public mutating func moveWorkspace(
        named name: WorkspaceName,
        to destinationDisplayID: WorkspaceDisplayID
    ) throws -> WorkspaceMutationResult {
        try mutate { state in
            guard let movingIndex = state.index(of: name) else { throw WorkspaceMutationError.workspaceNotFound(name) }
            let sourceDisplayID = state.workspaces[movingIndex].displayID
            var modified: Set<WorkspaceName> = [name]
            var deleted: [WorkspaceName] = []
            state.runtimeDisplayAssignments[name] = destinationDisplayID

            if sourceDisplayID == destinationDisplayID {
                state.revealAndFocus(name, modified: &modified, deleted: &deleted)
                return (WorkspaceMutationResult(workspaceState: state, modifiedWorkspaces: modified.sorted(), deletedWorkspaces: deleted.sorted()), false)
            }

            let destinationVisible = state.displays[destinationDisplayID]?.visibleWorkspaceName
            if let destinationVisible, destinationVisible != name {
                state.setVisible(destinationVisible, false)
                modified.insert(destinationVisible)
            }
            state.workspaces[movingIndex].displayID = destinationDisplayID
            state.displays[destinationDisplayID] = .init(
                visibleWorkspaceName: name,
                previousWorkspaceName: destinationVisible == name ? nil : destinationVisible
            )

            let remembered = state.displays[sourceDisplayID]?.previousWorkspaceName
            let reveal = remembered.flatMap { previous in
                state[workspace: previous]?.displayID == sourceDisplayID && previous != name ? previous : nil
            }
            state.displays[sourceDisplayID] = .init(visibleWorkspaceName: reveal, previousWorkspaceName: nil)
            if let reveal {
                state.setVisible(reveal, true)
                modified.insert(reveal)
            }
            state.setFocused(name)
            state.deleteEmptyParkedRuntimeWorkspaces(modified: &modified, deleted: &deleted)
            return (WorkspaceMutationResult(workspaceState: state, modifiedWorkspaces: modified.sorted(), deletedWorkspaces: deleted.sorted()), true)
        }
    }

    public mutating func setMode(
        of name: WorkspaceName,
        to mode: WorkspaceMode
    ) throws -> WorkspaceMutationResult {
        try mutate { state in
            guard let index = state.index(of: name) else { throw WorkspaceMutationError.workspaceNotFound(name) }
            guard state.workspaces[index].mode != mode else {
                return (WorkspaceMutationResult(workspaceState: state, modifiedWorkspaces: []), false)
            }
            state.workspaces[index].mode = mode
            return (WorkspaceMutationResult(workspaceState: state, modifiedWorkspaces: [name]), true)
        }
    }

    public mutating func adoptUnassignedWindows(
        _ windowIDs: [WorkspaceWindowID],
        into workspaceName: WorkspaceName = "1",
        displayID: WorkspaceDisplayID
    ) throws -> WorkspaceMutationResult {
        try mutate { state in
            let assigned = Set(state.workspaces.flatMap(\.windowIDs))
            let unassigned = windowIDs.filter { !assigned.contains($0) }
            guard !unassigned.isEmpty else {
                return (WorkspaceMutationResult(workspaceState: state, modifiedWorkspaces: []), false)
            }
            if state.index(of: workspaceName) == nil {
                state.workspaces.append(.init(name: workspaceName, origin: .configured, displayID: displayID))
            }
            for windowID in unassigned { state.insert(windowID: windowID, into: workspaceName) }
            var modified: Set<WorkspaceName> = [workspaceName]
            var deleted: [WorkspaceName] = []
            state.revealAndFocus(workspaceName, modified: &modified, deleted: &deleted)
            return (WorkspaceMutationResult(workspaceState: state, modifiedWorkspaces: modified.sorted()), true)
        }
    }

    public mutating func reconcileObservedWindows(
        _ observedWindowIDs: [WorkspaceWindowID],
        defaultDisplayID: WorkspaceDisplayID
    ) throws -> WorkspaceMutationResult {
        try mutate { state in
            let observed = Set(observedWindowIDs)
            let assigned = Set(state.workspaces.flatMap(\.windowIDs))
            let removed = assigned.subtracting(observed)
            let added = observed.subtracting(assigned).sorted()
            var modified: Set<WorkspaceName> = []

            for index in state.workspaces.indices {
                let original = state.workspaces[index].windowIDs
                let retained = original.filter { observed.contains($0) }
                guard retained != original else { continue }
                state.workspaces[index].windowIDs = retained
                for id in original where !observed.contains(id) {
                    state.workspaces[index].bsp.root = state.workspaces[index].bsp.root?.removing(windowID: id)
                }
                if !retained.contains(state.workspaces[index].focusedWindowID ?? "") {
                    state.workspaces[index].focusedWindowID = retained.last
                }
                modified.insert(state.workspaces[index].name)
            }
            for id in removed { state.parkedWindowFrames.removeValue(forKey: id) }

            if !added.isEmpty {
                let destination = state.focusedWorkspaceName ?? "1"
                if state.index(of: destination) == nil {
                    state.workspaces.append(.init(name: destination, origin: .configured, displayID: defaultDisplayID))
                }
                guard let index = state.index(of: destination) else { return (WorkspaceMutationResult(workspaceState: state, modifiedWorkspaces: []), false) }
                for id in added { state.insert(windowID: id, into: destination) }
                state.workspaces[index].focusedWindowID = added.last
                modified.insert(destination)
            }

            var deleted: [WorkspaceName] = []
            state.deleteEmptyParkedRuntimeWorkspaces(modified: &modified, deleted: &deleted)
            return (
                WorkspaceMutationResult(
                    workspaceState: state,
                    modifiedWorkspaces: modified.sorted(),
                    deletedWorkspaces: deleted.sorted()
                ),
                !removed.isEmpty || !added.isEmpty
            )
        }
    }
}

private extension WorkspaceState {
    var focusedWorkspace: Workspace? {
        focusedWorkspaceName.flatMap { self[workspace: $0] }
    }

    func index(of name: WorkspaceName) -> Int? {
        workspaces.firstIndex { $0.name == name }
    }

    mutating func mutate<T>(_ operation: (inout WorkspaceState) throws -> (T, Bool)) throws -> T {
        do { try validate() } catch let error as WorkspaceValidationError {
            throw WorkspaceMutationError.invalidState(error.issues)
        }
        var candidate = self
        let (result, changed) = try operation(&candidate)
        do { try candidate.validate() } catch let error as WorkspaceValidationError {
            throw WorkspaceMutationError.invalidState(error.issues)
        }
        if changed { self = candidate }
        return result
    }

    mutating func revealAndFocus(
        _ name: WorkspaceName,
        modified: inout Set<WorkspaceName>,
        deleted: inout [WorkspaceName]
    ) {
        guard let workspace = self[workspace: name] else { return }
        let displayID = workspace.displayID
        let currentlyVisible = displays[displayID]?.visibleWorkspaceName
        if currentlyVisible != name {
            let olderPrevious = displays[displayID]?.previousWorkspaceName
            if let currentlyVisible {
                setVisible(currentlyVisible, false)
                modified.insert(currentlyVisible)
            }
            let previous: WorkspaceName? = currentlyVisible.flatMap { parkedName -> WorkspaceName? in
                guard let parked = self[workspace: parkedName] else { return nil }
                return parked.origin == .runtime && parked.windowIDs.isEmpty ? olderPrevious : parkedName
            }
            displays[displayID] = .init(visibleWorkspaceName: name, previousWorkspaceName: previous)
            setVisible(name, true)
        }
        setFocused(name)
        modified.insert(name)
        deleteEmptyParkedRuntimeWorkspaces(modified: &modified, deleted: &deleted)
    }

    mutating func setFocused(_ name: WorkspaceName) {
        focusedWorkspaceName = name
        for index in workspaces.indices { workspaces[index].focused = workspaces[index].name == name }
    }

    mutating func setVisible(_ name: WorkspaceName, _ visible: Bool) {
        guard let index = index(of: name) else { return }
        workspaces[index].visible = visible
    }

    mutating func remove(windowID: WorkspaceWindowID, from name: WorkspaceName) {
        guard let index = index(of: name) else { return }
        workspaces[index].windowIDs.removeAll { $0 == windowID }
        workspaces[index].bsp.root = workspaces[index].bsp.root?.removing(windowID: windowID)
        if workspaces[index].focusedWindowID == windowID {
            workspaces[index].focusedWindowID = workspaces[index].bsp.root?.windowIDs.last ?? workspaces[index].windowIDs.last
        }
    }

    mutating func insert(windowID: WorkspaceWindowID, into name: WorkspaceName) {
        guard let index = index(of: name) else { return }
        workspaces[index].windowIDs.append(windowID)
        let target = workspaces[index].focusedWindowID.flatMap { workspaces[index].bsp.root?.contains($0) == true ? $0 : nil }
            ?? workspaces[index].bsp.root?.windowIDs.last
        if let root = workspaces[index].bsp.root, let target {
            workspaces[index].bsp.root = root.inserting(windowID: windowID, beside: target)
        } else {
            workspaces[index].bsp.root = .leaf(windowID: windowID)
        }
        workspaces[index].focusedWindowID = windowID
    }

    mutating func deleteEmptyParkedRuntimeWorkspaces(
        modified: inout Set<WorkspaceName>,
        deleted: inout [WorkspaceName]
    ) {
        let names = workspaces.filter { $0.origin == .runtime && $0.windowIDs.isEmpty && !$0.visible }.map(\.name)
        for name in names {
            workspaces.removeAll { $0.name == name }
            runtimeDisplayAssignments.removeValue(forKey: name)
            for displayID in displays.keys {
                if displays[displayID]?.previousWorkspaceName == name {
                    displays[displayID]?.previousWorkspaceName = nil
                }
            }
            modified.remove(name)
            deleted.append(name)
        }
    }
}

private func firstDuplicate<T: Hashable>(in values: [T]) -> T? {
    var seen: Set<T> = []
    return values.first { !seen.insert($0).inserted }
}
