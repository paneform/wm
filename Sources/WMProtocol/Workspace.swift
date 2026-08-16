import Foundation

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

public indirect enum BSPNode: Codable, Equatable, Sendable {
    case leaf(windowId: String)
    case split(axis: BSPAxis, ratio: Double, first: BSPNode, second: BSPNode)

    private enum CodingKeys: String, CodingKey {
        case type
        case windowId = "window_id"
        case axis
        case ratio
        case first
        case second
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "leaf":
            self = .leaf(windowId: try container.decode(String.self, forKey: .windowId))
        case "split":
            self = .split(
                axis: try container.decode(BSPAxis.self, forKey: .axis),
                ratio: try container.decode(Double.self, forKey: .ratio),
                first: try container.decode(BSPNode.self, forKey: .first),
                second: try container.decode(BSPNode.self, forKey: .second)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: container, debugDescription: "Unknown BSP node type"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .leaf(windowId):
            try container.encode("leaf", forKey: .type)
            try container.encode(windowId, forKey: .windowId)
        case let .split(axis, ratio, first, second):
            try container.encode("split", forKey: .type)
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

public struct WorkspaceMargin: Codable, Equatable, Sendable {
    public var top: Double
    public var right: Double
    public var bottom: Double
    public var left: Double

    public init(top: Double, right: Double, bottom: Double, left: Double) {
        self.top = top
        self.right = right
        self.bottom = bottom
        self.left = left
    }
}

public struct WorkspaceState: Codable, Equatable, Sendable {
    public var name: String
    public var origin: WorkspaceOrigin
    public var displayId: String
    public var preferredDisplayId: String?
    public var visible: Bool
    public var focused: Bool
    public var mode: WorkspaceMode
    public var margin: WorkspaceMargin
    public var gap: Double
    public var resizeIncrement: Double
    public var uncooperativeWindowPolicy: UncooperativeWindowPolicy
    public var maxGeometryRetries: Int
    public var geometryProfileMode: GeometryProfileMode
    public var windowIds: [String]
    public var focusedWindowId: String?
    public var bsp: BSPTree

    public init(
        name: String,
        origin: WorkspaceOrigin,
        displayId: String,
        preferredDisplayId: String? = nil,
        visible: Bool,
        focused: Bool,
        mode: WorkspaceMode,
        margin: WorkspaceMargin,
        gap: Double,
        resizeIncrement: Double,
        uncooperativeWindowPolicy: UncooperativeWindowPolicy = .greedy,
        maxGeometryRetries: Int = 5,
        geometryProfileMode: GeometryProfileMode = .store,
        windowIds: [String],
        focusedWindowId: String? = nil,
        bsp: BSPTree
    ) {
        self.name = name
        self.origin = origin
        self.displayId = displayId
        self.preferredDisplayId = preferredDisplayId
        self.visible = visible
        self.focused = focused
        self.mode = mode
        self.margin = margin
        self.gap = gap
        self.resizeIncrement = resizeIncrement
        self.uncooperativeWindowPolicy = uncooperativeWindowPolicy
        self.maxGeometryRetries = maxGeometryRetries
        self.geometryProfileMode = geometryProfileMode
        self.windowIds = windowIds
        self.focusedWindowId = focusedWindowId
        self.bsp = bsp
    }

    enum CodingKeys: String, CodingKey {
        case name, origin, visible, focused, mode, margin, gap, bsp
        case displayId = "display_id"
        case preferredDisplayId = "preferred_display_id"
        case resizeIncrement = "resize_increment"
        case uncooperativeWindowPolicy = "uncooperative_window_policy"
        case maxGeometryRetries = "max_geometry_retries"
        case geometryProfileMode = "geometry_profile_mode"
        case windowIds = "window_ids"
        case focusedWindowId = "focused_window_id"
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(origin, forKey: .origin)
        try container.encode(displayId, forKey: .displayId)
        try container.encode(preferredDisplayId, forKey: .preferredDisplayId)
        try container.encode(visible, forKey: .visible)
        try container.encode(focused, forKey: .focused)
        try container.encode(mode, forKey: .mode)
        try container.encode(margin, forKey: .margin)
        try container.encode(gap, forKey: .gap)
        try container.encode(resizeIncrement, forKey: .resizeIncrement)
        try container.encode(uncooperativeWindowPolicy, forKey: .uncooperativeWindowPolicy)
        try container.encode(maxGeometryRetries, forKey: .maxGeometryRetries)
        try container.encode(geometryProfileMode, forKey: .geometryProfileMode)
        try container.encode(windowIds, forKey: .windowIds)
        try container.encode(focusedWindowId, forKey: .focusedWindowId)
        try container.encode(bsp, forKey: .bsp)
    }
}

public struct WorkspaceListParams: Codable, Equatable, Sendable {
    public init() {}
}

public struct ObserveWorkspaceParams: Codable, Equatable, Sendable {
    public var name: String

    public init(name: String) {
        self.name = name
    }
}

public struct WorkspaceFocusParams: Codable, Equatable, Sendable {
    public var name: String
    public var displayId: String?
    public var displaySelector: DisplaySelector?

    public init(name: String, displayId: String? = nil, displaySelector: DisplaySelector? = nil) {
        self.name = name
        self.displayId = displayId
        self.displaySelector = displaySelector
    }

    enum CodingKeys: String, CodingKey { case name, displayId = "display_id", displaySelector = "display_selector" }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(displayId, forKey: .displayId)
        try container.encodeIfPresent(displaySelector, forKey: .displaySelector)
    }
}

public struct DisplaySelector: Codable, Equatable, Sendable {
    public var coreGraphicsDisplayId: String?
    public var nsScreenNumber: String?
    public var name: String?

    public init(coreGraphicsDisplayId: String? = nil, nsScreenNumber: String? = nil, name: String? = nil) {
        self.coreGraphicsDisplayId = coreGraphicsDisplayId
        self.nsScreenNumber = nsScreenNumber
        self.name = name
    }

    enum CodingKeys: String, CodingKey {
        case coreGraphicsDisplayId = "core_graphics_display_id"
        case nsScreenNumber = "ns_screen_number"
        case name
    }
}

public struct WorkspaceMoveWindowParams: Codable, Equatable, Sendable {
    public var windowIds: [String]
    public var workspace: String

    public init(windowIds: [String], workspace: String) {
        self.windowIds = windowIds
        self.workspace = workspace
    }

    enum CodingKeys: String, CodingKey { case windowIds = "window_ids", workspace }
}

public struct WorkspaceMoveDisplayParams: Codable, Equatable, Sendable {
    public var workspace: String?
    public var displayId: String?
    public var displaySelector: DisplaySelector?
    public var next: Bool

    public init(workspace: String? = nil, displayId: String? = nil, displaySelector: DisplaySelector? = nil, next: Bool = false) {
        self.workspace = workspace
        self.displayId = displayId
        self.displaySelector = displaySelector
        self.next = next
    }

    enum CodingKeys: String, CodingKey { case workspace, displayId = "display_id", displaySelector = "display_selector", next }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        workspace = try values.decodeIfPresent(String.self, forKey: .workspace)
        displayId = try values.decodeIfPresent(String.self, forKey: .displayId)
        displaySelector = try values.decodeIfPresent(DisplaySelector.self, forKey: .displaySelector)
        next = try values.decodeIfPresent(Bool.self, forKey: .next) ?? false
    }
}

public struct WorkspaceSetModeParams: Codable, Equatable, Sendable {
    public var workspace: String
    public var mode: WorkspaceMode

    public init(workspace: String, mode: WorkspaceMode) {
        self.workspace = workspace
        self.mode = mode
    }
}

public struct UncooperativeWindowPolicySetParams: Codable, Equatable, Sendable {
    public var policy: UncooperativeWindowPolicy
    public var workspace: String?

    public init(policy: UncooperativeWindowPolicy, workspace: String? = nil) {
        self.policy = policy
        self.workspace = workspace
    }
}

public struct GeometryPolicySetParams: Codable, Equatable, Sendable {
    public var workspace: String?
    public var maxGeometryRetries: Int?
    public var geometryProfileMode: GeometryProfileMode?

    public init(workspace: String? = nil, maxGeometryRetries: Int? = nil, geometryProfileMode: GeometryProfileMode? = nil) {
        self.workspace = workspace
        self.maxGeometryRetries = maxGeometryRetries
        self.geometryProfileMode = geometryProfileMode
    }

    enum CodingKeys: String, CodingKey {
        case workspace
        case maxGeometryRetries = "max_geometry_retries"
        case geometryProfileMode = "geometry_profile_mode"
    }
}

public struct WorkspaceListResult: Codable, Equatable, Sendable {
    public var workspaces: [WorkspaceState]
    public var focusedWorkspaceName: String?

    public init(workspaces: [WorkspaceState], focusedWorkspaceName: String? = nil) {
        self.workspaces = workspaces
        self.focusedWorkspaceName = focusedWorkspaceName
    }

    enum CodingKeys: String, CodingKey {
        case workspaces
        case focusedWorkspaceName = "focused_workspace_name"
    }
}

public enum WorkspaceEffectStatus: String, Codable, CaseIterable, Sendable {
    case simulated
    case verified
}

public struct WorkspaceMutationResult: Codable, Equatable, Sendable {
    public var workspaceState: WorkspaceState
    public var modifiedWorkspaces: [String]
    public var deletedWorkspaces: [String]
    public var effectStatus: WorkspaceEffectStatus

    public init(
        workspaceState: WorkspaceState,
        modifiedWorkspaces: [String],
        deletedWorkspaces: [String],
        effectStatus: WorkspaceEffectStatus
    ) {
        self.workspaceState = workspaceState
        self.modifiedWorkspaces = modifiedWorkspaces
        self.deletedWorkspaces = deletedWorkspaces
        self.effectStatus = effectStatus
    }

    enum CodingKeys: String, CodingKey {
        case workspaceState = "workspace_state"
        case modifiedWorkspaces = "modified_workspaces"
        case deletedWorkspaces = "deleted_workspaces"
        case effectStatus = "effect_status"
    }
}
