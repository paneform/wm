import Foundation

public struct WorkspaceTransitionPlan: Equatable, Sendable {
    public var incomingWindowIDs: Set<WorkspaceWindowID>
    public var outgoingWindowIDs: Set<WorkspaceWindowID>

    public init(before: WorkspaceState, after: WorkspaceState, destination: WorkspaceName) {
        incomingWindowIDs = Set(after[workspace: destination]?.windowIDs ?? [])
        let destinationDisplay = after[workspace: destination]?.displayID
        let displaced = destinationDisplay.flatMap { before.displays[$0]?.visibleWorkspaceName }
        outgoingWindowIDs = Set(displaced.flatMap { before[workspace: $0]?.windowIDs } ?? [])
            .subtracting(incomingWindowIDs)
    }
}
