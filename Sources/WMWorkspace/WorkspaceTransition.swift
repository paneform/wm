import Foundation

public struct WorkspaceTransitionPlan: Equatable, Sendable {
    public var incomingWindowIDs: Set<WorkspaceWindowID>
    public var outgoingWindowIDs: Set<WorkspaceWindowID>

    public init(before: WorkspaceState, after: WorkspaceState, destination: WorkspaceName) {
        incomingWindowIDs = Set(after[workspace: destination]?.windowIDs ?? [])
        let visibleNames = before.displays.values.compactMap(\.visibleWorkspaceName)
        outgoingWindowIDs = Set(visibleNames.flatMap { before[workspace: $0]?.windowIDs ?? [] })
            .subtracting(incomingWindowIDs)
    }
}
