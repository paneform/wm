import Foundation

public enum WorkspaceMutationError: Error, Equatable, Sendable {
    case workspaceNotFound(WorkspaceName)
    case displayRequired(WorkspaceName)
    case duplicateWindowSelection(WorkspaceWindowID)
    case windowNotFound(WorkspaceWindowID)
    case windowAlreadyInDestination(windowID: WorkspaceWindowID, workspace: WorkspaceName)
    case focusedWorkspaceRequired
    case focusedWindowRequired(WorkspaceName)
    case bspWorkspaceRequired(WorkspaceName)
    case directionalTargetNotFound(windowID: WorkspaceWindowID, direction: WindowDirection)
    case invalidState([WorkspaceValidationIssue])
}

extension WorkspaceState {
    public mutating func focusWindow(
        direction: WindowDirection, bounds: WorkspaceLayoutRect
    ) throws -> DirectionalWindowMutation {
        try directionalMutation(direction: direction, bounds: bounds, move: false)
    }

    public mutating func moveWindow(
        direction: WindowDirection, bounds: WorkspaceLayoutRect
    ) throws -> DirectionalWindowMutation {
        try directionalMutation(direction: direction, bounds: bounds, move: true)
    }

    private mutating func directionalMutation(
        direction: WindowDirection, bounds: WorkspaceLayoutRect, move: Bool
    ) throws -> DirectionalWindowMutation {
        try mutate { state in
            guard let name = state.focusedWorkspaceName,
                  let index = state.index(of: name) else {
                throw WorkspaceMutationError.focusedWorkspaceRequired
            }
            let workspace = state.workspaces[index]
            guard workspace.mode == .bsp else {
                throw WorkspaceMutationError.bspWorkspaceRequired(name)
            }
            guard let focused = workspace.focusedWindowID else {
                throw WorkspaceMutationError.focusedWindowRequired(name)
            }
            let frames = workspace.layout(in: bounds)
            guard let target = directionalTarget(
                from: focused, direction: direction, frames: frames
            ) else {
                throw WorkspaceMutationError.directionalTargetNotFound(
                    windowID: focused, direction: direction
                )
            }
            if move {
                state.workspaces[index].bsp.root = workspace.bsp.root?.swapping(focused, with: target)
                if let first = state.workspaces[index].windowIDs.firstIndex(of: focused),
                   let second = state.workspaces[index].windowIDs.firstIndex(of: target) {
                    state.workspaces[index].windowIDs.swapAt(first, second)
                }
            } else {
                state.workspaces[index].focusedWindowID = target
            }
            return (DirectionalWindowMutation(
                result: WorkspaceMutationResult(workspaceState: state, modifiedWorkspaces: [name]),
                sourceWindowID: focused, targetWindowID: target
            ), true)
        }
    }

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
            return (WorkspaceMutationResult(workspaceState: state, modifiedWorkspaces: modified.sorted(), deletedWorkspaces: deleted.sorted()), !modified.isEmpty || !deleted.isEmpty)
        }
    }

    public mutating func moveWindows(
        _ windowIDs: [WorkspaceWindowID],
        to destinationName: WorkspaceName,
        displayID: WorkspaceDisplayID? = nil
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
                guard let sourceDisplay = displayID ?? state[workspace: sources[0]]?.displayID else {
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

    public mutating func setUncooperativeWindowPolicy(
        of name: WorkspaceName,
        to policy: UncooperativeWindowPolicy
    ) throws -> WorkspaceMutationResult {
        try mutate { state in
            guard let index = state.index(of: name) else { throw WorkspaceMutationError.workspaceNotFound(name) }
            guard state.workspaces[index].uncooperativeWindowPolicy != policy else {
                return (WorkspaceMutationResult(workspaceState: state, modifiedWorkspaces: []), false)
            }
            state.workspaces[index].uncooperativeWindowPolicy = policy
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
        initialAssignments: [WorkspaceWindowID: WorkspaceName] = [:],
        replacements: [WorkspaceWindowID: WorkspaceWindowID] = [:],
        removedWindowIDs: Set<WorkspaceWindowID> = [],
        defaultDisplayID: WorkspaceDisplayID
    ) throws -> WorkspaceMutationResult {
        try mutate { state in
            let observed = Set(observedWindowIDs)
            var modified: Set<WorkspaceName> = []

            for oldID in replacements.keys.sorted() {
                guard let newID = replacements[oldID],
                      let workspace = state.workspaces.first(where: { $0.windowIDs.contains(oldID) }) else { continue }
                state.remove(windowID: oldID, from: workspace.name)
                state.insert(windowID: newID, into: workspace.name)
                modified.insert(workspace.name)
            }

            for id in removedWindowIDs.sorted() {
                guard let workspace = state.workspaces.first(where: { $0.windowIDs.contains(id) }) else { continue }
                state.remove(windowID: id, from: workspace.name)
                state.parkedWindowFrames.removeValue(forKey: id)
                modified.insert(workspace.name)
            }

            let assigned = Set(state.workspaces.flatMap(\.windowIDs))
            let added = observed.subtracting(assigned).sorted()

            for id in added {
                let destination = initialAssignments[id] ?? "1"
                if state.index(of: destination) == nil {
                    state.workspaces.append(.init(name: destination, origin: .configured, displayID: defaultDisplayID))
                }
                state.insert(windowID: id, into: destination)
                modified.insert(destination)
            }

            return (
                WorkspaceMutationResult(
                    workspaceState: state,
                    modifiedWorkspaces: modified.sorted()
                ),
                !added.isEmpty || !removedWindowIDs.isEmpty
            )
        }
    }

    public mutating func reconcileDisplayTopology(
        connectedDisplayIDs: Set<WorkspaceDisplayID>,
        fallbackDisplayID: WorkspaceDisplayID
    ) throws -> WorkspaceMutationResult {
        try mutate { state in
            guard connectedDisplayIDs.contains(fallbackDisplayID) else {
                throw WorkspaceMutationError.displayRequired("topology recovery")
            }
            let before = state
            state.restoreReconnectedDisplays(connectedDisplayIDs)
            state.migrateDisconnectedDisplays(connectedDisplayIDs, fallbackDisplayID: fallbackDisplayID)
            let modified = state.workspaces.compactMap { workspace in
                before[workspace: workspace.name] == workspace ? nil : workspace.name
            }.sorted()
            return (.init(workspaceState: state, modifiedWorkspaces: modified), state != before)
        }
    }
}

private func directionalTarget(
    from focused: WorkspaceWindowID, direction: WindowDirection,
    frames: [WorkspaceWindowID: WorkspaceLayoutRect]
) -> WorkspaceWindowID? {
    guard let source = frames[focused] else { return nil }
    let sourceX = source.x + source.width / 2
    let sourceY = source.y + source.height / 2
    return frames.compactMap { id, frame -> (String, Double, Double)? in
        guard id != focused else { return nil }
        let x = frame.x + frame.width / 2
        let y = frame.y + frame.height / 2
        let primary: Double
        let overlap: Double
        switch direction {
        case .left:
            primary = source.x - (frame.x + frame.width)
            overlap = min(source.y + source.height, frame.y + frame.height) - max(source.y, frame.y)
        case .right:
            primary = frame.x - (source.x + source.width)
            overlap = min(source.y + source.height, frame.y + frame.height) - max(source.y, frame.y)
        case .up:
            primary = source.y - (frame.y + frame.height)
            overlap = min(source.x + source.width, frame.x + frame.width) - max(source.x, frame.x)
        case .down:
            primary = frame.y - (source.y + source.height)
            overlap = min(source.x + source.width, frame.x + frame.width) - max(source.x, frame.x)
        }
        let centerPrimary: Double
        switch direction {
        case .left: centerPrimary = sourceX - x
        case .right: centerPrimary = x - sourceX
        case .up: centerPrimary = sourceY - y
        case .down: centerPrimary = y - sourceY
        }
        return centerPrimary > 0 ? (id, max(0, primary), overlap > 0 ? 0 : -overlap) : nil
    }.min {
        if $0.2 != $1.2 { return $0.2 < $1.2 }
        if $0.1 != $1.1 { return $0.1 < $1.1 }
        return $0.0 < $1.0
    }?.0
}

private extension WorkspaceState {
    mutating func restoreReconnectedDisplays(_ connected: Set<WorkspaceDisplayID>) {
        for displayID in disconnectedDisplays.keys.sorted() where connected.contains(displayID) {
            guard let saved = disconnectedDisplays.removeValue(forKey: displayID) else { continue }
            for name in saved.workspaceNames {
                guard let index = index(of: name), workspaces[index].displayID != displayID else { continue }
                let temporaryDisplay = workspaces[index].displayID
                if displays[temporaryDisplay]?.visibleWorkspaceName == name {
                    displays[temporaryDisplay]?.visibleWorkspaceName = nil
                }
                workspaces[index].displayID = displayID
                workspaces[index].visible = false
            }
            let visible = saved.visibleWorkspaceName.flatMap { self[workspace: $0]?.displayID == displayID ? $0 : nil }
            displays[displayID] = .init(
                visibleWorkspaceName: visible,
                previousWorkspaceName: saved.previousWorkspaceName.flatMap { self[workspace: $0]?.displayID == displayID ? $0 : nil }
            )
            if let visible { setVisible(visible, true) }
        }
    }

    mutating func migrateDisconnectedDisplays(
        _ connected: Set<WorkspaceDisplayID>, fallbackDisplayID: WorkspaceDisplayID
    ) {
        let disconnected = Set(workspaces.map(\.displayID)).subtracting(connected)
        for displayID in disconnected.sorted() {
            let names = workspaces.filter { $0.displayID == displayID }.map(\.name)
            if disconnectedDisplays[displayID] == nil {
                let displayState = displays[displayID]
                disconnectedDisplays[displayID] = .init(
                    workspaceNames: names,
                    visibleWorkspaceName: displayState?.visibleWorkspaceName,
                    previousWorkspaceName: displayState?.previousWorkspaceName
                )
            }
            var fallbackHasVisible = displays[fallbackDisplayID]?.visibleWorkspaceName != nil
            for name in names {
                guard let index = index(of: name) else { continue }
                let shouldReveal = workspaces[index].visible && !fallbackHasVisible
                workspaces[index].displayID = fallbackDisplayID
                workspaces[index].visible = shouldReveal
                if shouldReveal {
                    displays[fallbackDisplayID, default: .init()].visibleWorkspaceName = name
                    fallbackHasVisible = true
                }
            }
            displays.removeValue(forKey: displayID)
        }
    }

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
        let (operationResult, changed) = try operation(&candidate)
        do { try candidate.validate() } catch let error as WorkspaceValidationError {
            throw WorkspaceMutationError.invalidState(error.issues)
        }
        var result = operationResult
        if var mutation = result as? WorkspaceMutationResult {
            mutation.workspaceState = candidate
            result = mutation as! T
        } else if var directional = result as? DirectionalWindowMutation {
            directional.result.workspaceState = candidate
            result = directional as! T
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
        for displayID in displays.keys where displays[displayID]?.previousWorkspaceName == displays[displayID]?.visibleWorkspaceName {
            displays[displayID]?.previousWorkspaceName = nil
        }
    }
}

private func firstDuplicate<T: Hashable>(in values: [T]) -> T? {
    var seen: Set<T> = []
    return values.first { !seen.insert($0).inserted }
}
