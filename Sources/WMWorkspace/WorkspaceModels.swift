import Foundation

public typealias WorkspaceName = String
public typealias WorkspaceDisplayID = String
public typealias WorkspaceWindowID = String

public enum WorkspaceOrigin: String, Codable, CaseIterable, Sendable {
    case configured
    case runtime
}

public enum WorkspaceMode: String, Codable, CaseIterable, Sendable {
    case bsp
    case floating
}

public enum UncooperativeWindowPolicy: String, Codable, CaseIterable, Sendable {
    case greedy
    case stack
    case overlap
    case reject
}

public enum GeometryProfileMode: String, Codable, CaseIterable, Sendable { case store, infer, optimistic }

public enum BSPAxis: String, Codable, CaseIterable, Sendable {
    case vertical
    case horizontal
}

public enum WindowDirection: String, Codable, CaseIterable, Sendable {
    case left, down, up, right
}

public struct DirectionalWindowMutation: Equatable, Sendable {
    public var result: WorkspaceMutationResult
    public var sourceWindowID: WorkspaceWindowID
    public var targetWindowID: WorkspaceWindowID

    public init(
        result: WorkspaceMutationResult, sourceWindowID: WorkspaceWindowID,
        targetWindowID: WorkspaceWindowID
    ) {
        self.result = result
        self.sourceWindowID = sourceWindowID
        self.targetWindowID = targetWindowID
    }
}

public struct WorkspaceMargin: Codable, Equatable, Sendable {
    public var top: Double
    public var right: Double
    public var bottom: Double
    public var left: Double

    public init(top: Double = 0, right: Double = 0, bottom: Double = 0, left: Double = 0) {
        self.top = top
        self.right = right
        self.bottom = bottom
        self.left = left
    }
}

public indirect enum BSPNode: Equatable, Sendable {
    case leaf(windowID: WorkspaceWindowID)
    case split(axis: BSPAxis, ratio: Double, first: BSPNode, second: BSPNode)

    public var windowIDs: [WorkspaceWindowID] {
        switch self {
        case let .leaf(windowID): [windowID]
        case let .split(_, _, first, second): first.windowIDs + second.windowIDs
        }
    }

    public func contains(_ windowID: WorkspaceWindowID) -> Bool {
        switch self {
        case let .leaf(candidate): candidate == windowID
        case let .split(_, _, first, second): first.contains(windowID) || second.contains(windowID)
        }
    }

    public func inserting(
        windowID: WorkspaceWindowID,
        beside targetWindowID: WorkspaceWindowID,
        axis: BSPAxis = .vertical,
        ratio: Double = 0.5
    ) -> BSPNode? {
        switch self {
        case let .leaf(candidate) where candidate == targetWindowID:
            .split(axis: axis, ratio: ratio, first: self, second: .leaf(windowID: windowID))
        case .leaf:
            nil
        case let .split(existingAxis, existingRatio, first, second):
            if let inserted = first.inserting(windowID: windowID, beside: targetWindowID, axis: axis, ratio: ratio) {
                .split(axis: existingAxis, ratio: existingRatio, first: inserted, second: second)
            } else if let inserted = second.inserting(windowID: windowID, beside: targetWindowID, axis: axis, ratio: ratio) {
                .split(axis: existingAxis, ratio: existingRatio, first: first, second: inserted)
            } else {
                nil
            }
        }
    }

    public func removing(windowID: WorkspaceWindowID) -> BSPNode? {
        switch self {
        case let .leaf(candidate):
            return candidate == windowID ? nil : self
        case let .split(axis, ratio, first, second):
            if first.contains(windowID) {
                guard let remaining = first.removing(windowID: windowID) else { return second }
                return .split(axis: axis, ratio: ratio, first: remaining, second: second)
            }
            if second.contains(windowID) {
                guard let remaining = second.removing(windowID: windowID) else { return first }
                return .split(axis: axis, ratio: ratio, first: first, second: remaining)
            }
            return self
        }
    }

    public func swapping(_ firstWindowID: WorkspaceWindowID, with secondWindowID: WorkspaceWindowID) -> BSPNode {
        switch self {
        case .leaf(let windowID):
            if windowID == firstWindowID { return .leaf(windowID: secondWindowID) }
            if windowID == secondWindowID { return .leaf(windowID: firstWindowID) }
            return self
        case .split(let axis, let ratio, let first, let second):
            return .split(
                axis: axis, ratio: ratio,
                first: first.swapping(firstWindowID, with: secondWindowID),
                second: second.swapping(firstWindowID, with: secondWindowID)
            )
        }
    }
}

extension BSPNode: Codable {
    private enum CodingKeys: String, CodingKey { case type, windowID = "window_id", axis, ratio, first, second }
    private enum Kind: String, Codable { case leaf, split }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Kind.self, forKey: .type) {
        case .leaf:
            self = .leaf(windowID: try container.decode(String.self, forKey: .windowID))
        case .split:
            self = .split(
                axis: try container.decode(BSPAxis.self, forKey: .axis),
                ratio: try container.decode(Double.self, forKey: .ratio),
                first: try container.decode(BSPNode.self, forKey: .first),
                second: try container.decode(BSPNode.self, forKey: .second)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .leaf(windowID):
            try container.encode(Kind.leaf, forKey: .type)
            try container.encode(windowID, forKey: .windowID)
        case let .split(axis, ratio, first, second):
            try container.encode(Kind.split, forKey: .type)
            try container.encode(axis, forKey: .axis)
            try container.encode(ratio, forKey: .ratio)
            try container.encode(first, forKey: .first)
            try container.encode(second, forKey: .second)
        }
    }
}

public struct BSPTree: Codable, Equatable, Sendable {
    public var root: BSPNode?

    public init(root: BSPNode? = nil) {
        self.root = root
    }
}

public struct Workspace: Codable, Equatable, Sendable {
    public var name: WorkspaceName
    public var origin: WorkspaceOrigin
    public var displayID: WorkspaceDisplayID
    public var preferredDisplayID: WorkspaceDisplayID?
    public var visible: Bool
    public var focused: Bool
    public var mode: WorkspaceMode
    public var margin: WorkspaceMargin
    public var gap: Double
    public var resizeIncrement: Double
    public var uncooperativeWindowPolicy: UncooperativeWindowPolicy
    public var maxGeometryRetries: Int
    public var geometryProfileMode: GeometryProfileMode
    public var windowIDs: [WorkspaceWindowID]
    public var focusedWindowID: WorkspaceWindowID?
    public var bsp: BSPTree

    public init(
        name: WorkspaceName,
        origin: WorkspaceOrigin,
        displayID: WorkspaceDisplayID,
        preferredDisplayID: WorkspaceDisplayID? = nil,
        visible: Bool = false,
        focused: Bool = false,
        mode: WorkspaceMode = .bsp,
        margin: WorkspaceMargin = .init(),
        gap: Double = 8,
        resizeIncrement: Double = 0.05,
        uncooperativeWindowPolicy: UncooperativeWindowPolicy = .greedy,
        maxGeometryRetries: Int = 5,
        geometryProfileMode: GeometryProfileMode = .store,
        windowIDs: [WorkspaceWindowID] = [],
        focusedWindowID: WorkspaceWindowID? = nil,
        bsp: BSPTree = .init()
    ) {
        self.name = name
        self.origin = origin
        self.displayID = displayID
        self.preferredDisplayID = preferredDisplayID
        self.visible = visible
        self.focused = focused
        self.mode = mode
        self.margin = margin
        self.gap = gap
        self.resizeIncrement = resizeIncrement
        self.uncooperativeWindowPolicy = uncooperativeWindowPolicy
        self.maxGeometryRetries = maxGeometryRetries
        self.geometryProfileMode = geometryProfileMode
        self.windowIDs = windowIDs
        self.focusedWindowID = focusedWindowID
        self.bsp = bsp
    }

    private enum CodingKeys: String, CodingKey {
        case name, origin, visible, focused, mode, margin, gap, bsp
        case displayID = "display_id"
        case preferredDisplayID = "preferred_display_id"
        case resizeIncrement = "resize_increment"
        case uncooperativeWindowPolicy = "uncooperative_window_policy"
        case maxGeometryRetries = "max_geometry_retries"
        case geometryProfileMode = "geometry_profile_mode"
        case windowIDs = "window_ids"
        case focusedWindowID = "focused_window_id"
    }
}

public struct DisplayWorkspaceState: Codable, Equatable, Sendable {
    public var visibleWorkspaceName: WorkspaceName?
    public var previousWorkspaceName: WorkspaceName?

    public init(visibleWorkspaceName: WorkspaceName? = nil, previousWorkspaceName: WorkspaceName? = nil) {
        self.visibleWorkspaceName = visibleWorkspaceName
        self.previousWorkspaceName = previousWorkspaceName
    }

    private enum CodingKeys: String, CodingKey {
        case visibleWorkspaceName = "visible_workspace_name"
        case previousWorkspaceName = "previous_workspace_name"
    }
}

public struct DisconnectedDisplayState: Codable, Equatable, Sendable {
    public var workspaceNames: [WorkspaceName]
    public var visibleWorkspaceName: WorkspaceName?
    public var previousWorkspaceName: WorkspaceName?

    public init(
        workspaceNames: [WorkspaceName],
        visibleWorkspaceName: WorkspaceName? = nil,
        previousWorkspaceName: WorkspaceName? = nil
    ) {
        self.workspaceNames = workspaceNames
        self.visibleWorkspaceName = visibleWorkspaceName
        self.previousWorkspaceName = previousWorkspaceName
    }
}

public struct ParkedWindowFrame: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public struct WorkspaceState: Codable, Equatable, Sendable {
    public var workspaces: [Workspace]
    public var focusedWorkspaceName: WorkspaceName?
    public var displays: [WorkspaceDisplayID: DisplayWorkspaceState]
    public var runtimeDisplayAssignments: [WorkspaceName: WorkspaceDisplayID]
    public var parkedWindowFrames: [WorkspaceWindowID: ParkedWindowFrame]
    public var disconnectedDisplays: [WorkspaceDisplayID: DisconnectedDisplayState]

    public init(
        workspaces: [Workspace] = [],
        focusedWorkspaceName: WorkspaceName? = nil,
        displays: [WorkspaceDisplayID: DisplayWorkspaceState] = [:],
        runtimeDisplayAssignments: [WorkspaceName: WorkspaceDisplayID] = [:],
        parkedWindowFrames: [WorkspaceWindowID: ParkedWindowFrame] = [:],
        disconnectedDisplays: [WorkspaceDisplayID: DisconnectedDisplayState] = [:]
    ) {
        self.workspaces = workspaces
        self.focusedWorkspaceName = focusedWorkspaceName
        self.displays = displays
        self.runtimeDisplayAssignments = runtimeDisplayAssignments
        self.parkedWindowFrames = parkedWindowFrames
        self.disconnectedDisplays = disconnectedDisplays
    }

    public subscript(workspace name: WorkspaceName) -> Workspace? {
        workspaces.first { $0.name == name }
    }

    public func workspaceName(containing windowID: WorkspaceWindowID) -> WorkspaceName? {
        workspaces.first { $0.windowIDs.contains(windowID) }?.name
    }

    public mutating func setFocusedWindow(_ windowID: WorkspaceWindowID, in workspaceName: WorkspaceName) {
        guard let index = workspaces.firstIndex(where: { $0.name == workspaceName }),
              workspaces[index].windowIDs.contains(windowID) else { return }
        workspaces[index].focusedWindowID = windowID
    }

    public mutating func removeWindow(_ windowID: WorkspaceWindowID, from workspaceName: WorkspaceName) {
        guard let index = workspaces.firstIndex(where: { $0.name == workspaceName }) else { return }
        workspaces[index].windowIDs.removeAll { $0 == windowID }
        workspaces[index].bsp.root = workspaces[index].bsp.root?.removing(windowID: windowID)
        if workspaces[index].focusedWindowID == windowID {
            workspaces[index].focusedWindowID = workspaces[index].bsp.root?.windowIDs.last
                ?? workspaces[index].windowIDs.last
        }
        parkedWindowFrames.removeValue(forKey: windowID)
    }

    private enum CodingKeys: String, CodingKey {
        case workspaces, displays
        case focusedWorkspaceName = "focused_workspace_name"
        case runtimeDisplayAssignments = "runtime_display_assignments"
        case parkedWindowFrames = "parked_window_frames"
        case disconnectedDisplays = "disconnected_displays"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        workspaces = try container.decode([Workspace].self, forKey: .workspaces)
        focusedWorkspaceName = try container.decodeIfPresent(String.self, forKey: .focusedWorkspaceName)
        displays = try container.decode([WorkspaceDisplayID: DisplayWorkspaceState].self, forKey: .displays)
        runtimeDisplayAssignments = try container.decode([WorkspaceName: WorkspaceDisplayID].self, forKey: .runtimeDisplayAssignments)
        parkedWindowFrames = try container.decodeIfPresent([WorkspaceWindowID: ParkedWindowFrame].self, forKey: .parkedWindowFrames) ?? [:]
        disconnectedDisplays = try container.decodeIfPresent([WorkspaceDisplayID: DisconnectedDisplayState].self, forKey: .disconnectedDisplays) ?? [:]
    }
}

public enum WorkspaceEffectStatus: String, Codable, Sendable {
    case simulated
    case verified
}

public enum SplitDecision: String, Codable, Sendable {
    case provisionalVerticalHalf = "provisional_vertical_half"
}

public struct WorkspaceMutationResult: Codable, Equatable, Sendable {
    public var workspaceState: WorkspaceState
    public var modifiedWorkspaces: [WorkspaceName]
    public var deletedWorkspaces: [WorkspaceName]
    public var effectStatus: WorkspaceEffectStatus
    public var splitDecision: SplitDecision?

    public init(
        workspaceState: WorkspaceState,
        modifiedWorkspaces: [WorkspaceName],
        deletedWorkspaces: [WorkspaceName] = [],
        effectStatus: WorkspaceEffectStatus = .simulated,
        splitDecision: SplitDecision? = nil
    ) {
        self.workspaceState = workspaceState
        self.modifiedWorkspaces = modifiedWorkspaces
        self.deletedWorkspaces = deletedWorkspaces
        self.effectStatus = effectStatus
        self.splitDecision = splitDecision
    }

    private enum CodingKeys: String, CodingKey {
        case workspaceState = "workspace_state"
        case modifiedWorkspaces = "modified_workspaces"
        case deletedWorkspaces = "deleted_workspaces"
        case effectStatus = "effect_status"
        case splitDecision = "split_decision"
    }
}
