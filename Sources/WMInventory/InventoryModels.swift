import Foundation
import WMProtocol

public struct InventoryRect: Codable, Hashable, Sendable {
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

    public var isUsable: Bool {
        x.isFinite && y.isFinite && width.isFinite && height.isFinite && width > 0 && height > 0
    }

    public func approximatelyEquals(_ other: Self, tolerance: Double = 2) -> Bool {
        abs(x - other.x) <= tolerance && abs(y - other.y) <= tolerance
            && abs(width - other.width) <= tolerance && abs(height - other.height) <= tolerance
    }
}

public struct DisplayIdentifiers: Codable, Hashable, Sendable {
    public var nsscreenNumber: String?
    public var cgDirectDisplayID: String?
    public var uuid: String?
    public var vendorID: String?
    public var productID: String?
    public var serialNumber: String?

    public init(
        nsscreenNumber: String? = nil,
        cgDirectDisplayID: String? = nil,
        uuid: String? = nil,
        vendorID: String? = nil,
        productID: String? = nil,
        serialNumber: String? = nil
    ) {
        self.nsscreenNumber = nsscreenNumber
        self.cgDirectDisplayID = cgDirectDisplayID
        self.uuid = uuid
        self.vendorID = vendorID
        self.productID = productID
        self.serialNumber = serialNumber
    }

    enum CodingKeys: String, CodingKey {
        case nsscreenNumber = "nsscreen_number"
        case cgDirectDisplayID = "cg_direct_display_id"
        case uuid
        case vendorID = "vendor_id"
        case productID = "product_id"
        case serialNumber = "serial_number"
    }
}

public struct DisplayObservation: Codable, Hashable, Sendable, Identifiable {
    /// Display and work-area frames in canonical OS space: AX global coordinates,
    /// top-left origin of the primary display, y-axis pointing down. This is the same
    /// space window frames are observed and applied in, so no per-use conversion is
    /// needed. Platform sources convert once at enumeration time.
    public var id: String
    public var name: String
    public var isBuiltin: Bool
    public var isPrimary: Bool
    public var frame: InventoryRect
    public var visibleFrame: InventoryRect
    public var backingScale: Double
    public var identifiers: DisplayIdentifiers

    public init(
        id: String,
        name: String,
        isBuiltin: Bool,
        isPrimary: Bool,
        frame: InventoryRect,
        visibleFrame: InventoryRect,
        backingScale: Double,
        identifiers: DisplayIdentifiers
    ) {
        self.id = id
        self.name = name
        self.isBuiltin = isBuiltin
        self.isPrimary = isPrimary
        self.frame = frame
        self.visibleFrame = visibleFrame
        self.backingScale = backingScale
        self.identifiers = identifiers
    }

    enum CodingKeys: String, CodingKey {
        case id, name, frame, identifiers
        case isBuiltin = "is_builtin"
        case isPrimary = "is_primary"
        case visibleFrame = "visible_frame"
        case backingScale = "backing_scale"
    }
}

public struct DisplayTopologySnapshot: Equatable, Sendable {
    public var displays: [DisplayObservation]

    public init(displays: [DisplayObservation]) {
        self.displays = displays.sorted { $0.id < $1.id }
    }

    public var displayIDs: Set<String> { Set(displays.map(\.id)) }

    /// Display frames in canonical OS (AX global) space. Observations are already
    /// canonicalized at the platform boundary; this is a direct lookup.
    public var axFrames: [String: InventoryRect] {
        Dictionary(uniqueKeysWithValues: displays.map { ($0.id, $0.frame) })
    }

    /// Work areas in canonical OS (AX global) space. Direct lookup.
    public var axWorkAreas: [String: InventoryRect] {
        Dictionary(uniqueKeysWithValues: displays.map { ($0.id, $0.visibleFrame) })
    }

    public func axFrame(of displayID: String) -> InventoryRect? {
        axFrames[displayID]
    }

    public func axWorkArea(of displayID: String) -> InventoryRect? {
        axWorkAreas[displayID]
    }

    /// Projects an engine-local frame (y-down, origin at the display's work-area
    /// top-left) into canonical OS coordinates. The single projection for both
    /// single-display and multi-display setups: multi-display is encoded entirely
    /// in each display's work-area origin.
    public func project(_ local: InventoryRect, onDisplay displayID: String) -> InventoryRect? {
        guard let workArea = axWorkAreas[displayID] else { return nil }
        return InventoryRect(
            x: workArea.x + local.x, y: workArea.y + local.y,
            width: local.width, height: local.height)
    }

    /// Inverse of `project`: converts an observed OS-space frame back into
    /// engine-local coordinates relative to the display's work area.
    public func unproject(_ os: InventoryRect, onDisplay displayID: String) -> InventoryRect? {
        guard let workArea = axWorkAreas[displayID] else { return nil }
        return InventoryRect(
            x: os.x - workArea.x, y: os.y - workArea.y,
            width: os.width, height: os.height)
    }
}

public struct ApplicationObservation: Codable, Hashable, Sendable {
    public var pid: Int32
    public var name: String
    public var bundleID: String?
    public var executablePath: String?

    public init(pid: Int32, name: String, bundleID: String? = nil, executablePath: String? = nil) {
        self.pid = pid
        self.name = name
        self.bundleID = bundleID
        self.executablePath = executablePath
    }

    enum CodingKeys: String, CodingKey {
        case pid, name
        case bundleID = "bundle_id"
        case executablePath = "executable_path"
    }
}

public struct RawAXWindow: Codable, Hashable, Sendable {
    public let source = "accessibility"
    public var pid: Int32
    public var appName: String
    public var bundleID: String?
    public var executablePath: String?
    public var title: String?
    public var role: String?
    public var subrole: String?
    public var frame: InventoryRect?
    public var minimized: Bool?
    public var fullscreen: Bool?
    public var focused: Bool?
    public var main: Bool?
    public var modal: Bool?
    public var hasParent: Bool?
    public var movable: Bool?
    public var resizable: Bool?
    public var geometryCapabilities: GeometryCapabilities
    public var cgWindowID: UInt32?
    public var readErrors: [String]

    public init(
        pid: Int32,
        appName: String,
        bundleID: String? = nil,
        executablePath: String? = nil,
        title: String? = nil,
        role: String? = nil,
        subrole: String? = nil,
        frame: InventoryRect? = nil,
        minimized: Bool? = nil,
        fullscreen: Bool? = nil,
        focused: Bool? = nil,
        main: Bool? = nil,
        modal: Bool? = nil,
        hasParent: Bool? = nil,
        movable: Bool? = nil,
        resizable: Bool? = nil,
        geometryCapabilities: GeometryCapabilities = .init(),
        cgWindowID: UInt32? = nil,
        readErrors: [String] = []
    ) {
        self.pid = pid
        self.appName = appName
        self.bundleID = bundleID
        self.executablePath = executablePath
        self.title = title
        self.role = role
        self.subrole = subrole
        self.frame = frame
        self.minimized = minimized
        self.fullscreen = fullscreen
        self.focused = focused
        self.main = main
        self.modal = modal
        self.hasParent = hasParent
        self.movable = movable
        self.resizable = resizable
        self.geometryCapabilities = geometryCapabilities
        self.cgWindowID = cgWindowID
        self.readErrors = readErrors
    }

    enum CodingKeys: String, CodingKey {
        case source, pid, title, role, subrole, frame, minimized, fullscreen, focused, main, modal
        case hasParent = "has_parent"
        case movable, resizable
        case geometryCapabilities = "geometry_capabilities"
        case appName = "app_name"
        case bundleID = "bundle_id"
        case executablePath = "executable_path"
        case cgWindowID = "cg_window_id"
        case readErrors = "read_errors"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        pid = try container.decode(Int32.self, forKey: .pid); appName = try container.decode(String.self, forKey: .appName)
        bundleID = try container.decodeIfPresent(String.self, forKey: .bundleID); executablePath = try container.decodeIfPresent(String.self, forKey: .executablePath); title = try container.decodeIfPresent(String.self, forKey: .title); role = try container.decodeIfPresent(String.self, forKey: .role); subrole = try container.decodeIfPresent(String.self, forKey: .subrole); frame = try container.decodeIfPresent(InventoryRect.self, forKey: .frame); minimized = try container.decodeIfPresent(Bool.self, forKey: .minimized); fullscreen = try container.decodeIfPresent(Bool.self, forKey: .fullscreen); focused = try container.decodeIfPresent(Bool.self, forKey: .focused); main = try container.decodeIfPresent(Bool.self, forKey: .main); modal = try container.decodeIfPresent(Bool.self, forKey: .modal); hasParent = try container.decodeIfPresent(Bool.self, forKey: .hasParent); movable = try container.decodeIfPresent(Bool.self, forKey: .movable); resizable = try container.decodeIfPresent(Bool.self, forKey: .resizable); geometryCapabilities = try container.decodeIfPresent(GeometryCapabilities.self, forKey: .geometryCapabilities) ?? .init(); cgWindowID = try container.decodeIfPresent(UInt32.self, forKey: .cgWindowID); readErrors = try container.decodeIfPresent([String].self, forKey: .readErrors) ?? []
    }
}

public struct RawCGWindow: Codable, Hashable, Sendable {
    public let source = "core_graphics"
    public var cgWindowID: UInt32?
    public var pid: Int32?
    public var ownerName: String?
    public var title: String?
    public var layer: Int?
    public var alpha: Double?
    public var onScreen: Bool?
    public var frame: InventoryRect?

    public init(
        cgWindowID: UInt32?,
        pid: Int32?,
        ownerName: String? = nil,
        title: String? = nil,
        layer: Int? = nil,
        alpha: Double? = nil,
        onScreen: Bool? = nil,
        frame: InventoryRect? = nil
    ) {
        self.cgWindowID = cgWindowID
        self.pid = pid
        self.ownerName = ownerName
        self.title = title
        self.layer = layer
        self.alpha = alpha
        self.onScreen = onScreen
        self.frame = frame
    }

    enum CodingKeys: String, CodingKey {
        case source, pid, title, layer, alpha, frame
        case cgWindowID = "cg_window_id"
        case ownerName = "owner_name"
        case onScreen = "on_screen"
    }
}

public enum InventorySource: String, Codable, Hashable, Sendable {
    case displays
    case accessibility
    case coreGraphics = "core_graphics"
}

public enum SourceStatus: String, Codable, Hashable, Sendable {
    case healthy, degraded, unhealthy
}

public struct SourceHealth: Codable, Hashable, Sendable {
    public var source: InventorySource
    public var status: SourceStatus
    public var permissionGranted: Bool?
    public var issues: [String]

    public init(source: InventorySource, status: SourceStatus, permissionGranted: Bool?, issues: [String] = []) {
        self.source = source
        self.status = status
        self.permissionGranted = permissionGranted
        self.issues = issues
    }

    enum CodingKeys: String, CodingKey {
        case source, status, issues
        case permissionGranted = "permission_granted"
    }
}

public enum AppScanStatus: String, Codable, Hashable, Sendable {
  case succeeded, failed
  case timedOut = "timed_out"
}

public struct AppScanResult: Codable, Hashable, Sendable {
    public var application: ApplicationObservation
    public var status: AppScanStatus
    public var durationMilliseconds: Int
    public var windowCount: Int
    public var issues: [String]

    public init(application: ApplicationObservation, status: AppScanStatus, durationMilliseconds: Int, windowCount: Int, issues: [String]) {
        self.application = application
        self.status = status
        self.durationMilliseconds = durationMilliseconds
        self.windowCount = windowCount
        self.issues = issues
    }

    enum CodingKeys: String, CodingKey {
        case application, status, issues
        case durationMilliseconds = "duration_milliseconds"
        case windowCount = "window_count"
    }
}

public enum JoinConfidence: String, Codable, Hashable, Sendable {
    case exact, strong, weak
    case axOnly = "ax_only"
    case cgOnly = "cg_only"
}

public struct JoinDecision: Codable, Hashable, Sendable {
    public var axIndex: Int?
    public var cgIndex: Int?
    public var confidence: JoinConfidence
    public var signals: [String]
    public var reasons: [String]

    public init(axIndex: Int?, cgIndex: Int?, confidence: JoinConfidence, signals: [String], reasons: [String] = []) {
        self.axIndex = axIndex
        self.cgIndex = cgIndex
        self.confidence = confidence
        self.signals = signals
        self.reasons = reasons
    }

    enum CodingKeys: String, CodingKey {
        case confidence, signals, reasons
        case axIndex = "ax_index"
        case cgIndex = "cg_index"
    }
}

public enum WindowClassification: String, Codable, Hashable, Sendable {
    case normal, transient
    case systemUI = "system_ui"
    case uncertain
}

public enum WindowManagement: String, Codable, Hashable, Sendable {
    case managed, unmanaged, ineligible, pending
}

public struct NormalizedWindow: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var pid: Int32
    public var appName: String
    public var bundleID: String?
    public var executablePath: String?
    public var title: String?
    public var role: String?
    public var subrole: String?
    public var frame: InventoryRect?
    public var displayID: String?
    public var classification: WindowClassification
    public var management: WindowManagement
    public var rejectionReasons: [String]
    public var cgWindowID: UInt32?
    public var joinConfidence: JoinConfidence
    public var joinSignals: [String]
    public var minimized: Bool?
    public var fullscreen: Bool?
    public var focused: Bool?
    public var main: Bool?
    public var onScreen: Bool?
    public var health: SourceStatus
    public var healthIssues: [String]
    public var geometryCapabilities: GeometryCapabilities

    public init(
        id: String, pid: Int32, appName: String, bundleID: String? = nil, executablePath: String? = nil,
        title: String? = nil, role: String? = nil, subrole: String? = nil, frame: InventoryRect? = nil,
        displayID: String? = nil, classification: WindowClassification, management: WindowManagement,
        rejectionReasons: [String], cgWindowID: UInt32? = nil, joinConfidence: JoinConfidence,
        joinSignals: [String], minimized: Bool? = nil, fullscreen: Bool? = nil, focused: Bool? = nil,
        main: Bool? = nil, onScreen: Bool? = nil, health: SourceStatus, healthIssues: [String],
        geometryCapabilities: GeometryCapabilities = .init()
    ) {
        self.id = id; self.pid = pid; self.appName = appName; self.bundleID = bundleID
        self.executablePath = executablePath; self.title = title; self.role = role; self.subrole = subrole
        self.frame = frame; self.displayID = displayID; self.classification = classification
        self.management = management; self.rejectionReasons = rejectionReasons; self.cgWindowID = cgWindowID
        self.joinConfidence = joinConfidence; self.joinSignals = joinSignals; self.minimized = minimized
        self.fullscreen = fullscreen; self.focused = focused; self.main = main; self.onScreen = onScreen
        self.health = health; self.healthIssues = healthIssues; self.geometryCapabilities = geometryCapabilities
    }

    enum CodingKeys: String, CodingKey {
        case id, pid, title, role, subrole, frame, classification, management, minimized, fullscreen, focused, main, health
        case appName = "app_name"
        case bundleID = "bundle_id"
        case executablePath = "executable_path"
        case displayID = "display_id"
        case rejectionReasons = "rejection_reasons"
        case cgWindowID = "cg_window_id"
        case joinConfidence = "join_confidence"
        case joinSignals = "join_signals"
        case onScreen = "on_screen"
        case healthIssues = "health_issues"
        case geometryCapabilities = "geometry_capabilities"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id); pid = try container.decode(Int32.self, forKey: .pid); appName = try container.decode(String.self, forKey: .appName); bundleID = try container.decodeIfPresent(String.self, forKey: .bundleID); executablePath = try container.decodeIfPresent(String.self, forKey: .executablePath); title = try container.decodeIfPresent(String.self, forKey: .title); role = try container.decodeIfPresent(String.self, forKey: .role); subrole = try container.decodeIfPresent(String.self, forKey: .subrole); frame = try container.decodeIfPresent(InventoryRect.self, forKey: .frame); displayID = try container.decodeIfPresent(String.self, forKey: .displayID); classification = try container.decode(WindowClassification.self, forKey: .classification); management = try container.decode(WindowManagement.self, forKey: .management); rejectionReasons = try container.decodeIfPresent([String].self, forKey: .rejectionReasons) ?? []; cgWindowID = try container.decodeIfPresent(UInt32.self, forKey: .cgWindowID); joinConfidence = try container.decode(JoinConfidence.self, forKey: .joinConfidence); joinSignals = try container.decodeIfPresent([String].self, forKey: .joinSignals) ?? []; minimized = try container.decodeIfPresent(Bool.self, forKey: .minimized); fullscreen = try container.decodeIfPresent(Bool.self, forKey: .fullscreen); focused = try container.decodeIfPresent(Bool.self, forKey: .focused); main = try container.decodeIfPresent(Bool.self, forKey: .main); onScreen = try container.decodeIfPresent(Bool.self, forKey: .onScreen); health = try container.decode(SourceStatus.self, forKey: .health); healthIssues = try container.decodeIfPresent([String].self, forKey: .healthIssues) ?? []; geometryCapabilities = try container.decodeIfPresent(GeometryCapabilities.self, forKey: .geometryCapabilities) ?? .init()
    }
}

public struct RejectedAXWindow: Codable, Hashable, Sendable {
    public var axIndex: Int
    public var window: RawAXWindow
    public var reasons: [String]

    public init(axIndex: Int, window: RawAXWindow, reasons: [String]) {
        self.axIndex = axIndex
        self.window = window
        self.reasons = reasons
    }

    enum CodingKeys: String, CodingKey {
        case window, reasons
        case axIndex = "ax_index"
    }
}

public struct InventorySnapshot: Codable, Hashable, Sendable {
    public var timestamp: Date
    public var durationMilliseconds: Int
    public var displays: [DisplayObservation]
    public var rawAXWindows: [RawAXWindow]
    public var rawCGWindows: [RawCGWindow]
    public var windows: [NormalizedWindow]
    public var rejectedAXWindows: [RejectedAXWindow]
    public var joinDecisions: [JoinDecision]
    public var sourceHealth: [SourceHealth]
    public var appScans: [AppScanResult]

    public var applicationEnumerationSucceeded: Bool {
        guard let status = sourceHealth.first(where: { $0.source == .accessibility })?.status else {
            return false
        }
        return status != .unhealthy
    }

    public init(
        timestamp: Date,
        durationMilliseconds: Int,
        displays: [DisplayObservation],
        rawAXWindows: [RawAXWindow],
        rawCGWindows: [RawCGWindow],
        windows: [NormalizedWindow],
        rejectedAXWindows: [RejectedAXWindow],
        joinDecisions: [JoinDecision],
        sourceHealth: [SourceHealth],
        appScans: [AppScanResult]
    ) {
        self.timestamp = timestamp
        self.durationMilliseconds = durationMilliseconds
        self.displays = displays
        self.rawAXWindows = rawAXWindows
        self.rawCGWindows = rawCGWindows
        self.windows = windows
        self.rejectedAXWindows = rejectedAXWindows
        self.joinDecisions = joinDecisions
        self.sourceHealth = sourceHealth
        self.appScans = appScans
    }

    enum CodingKeys: String, CodingKey {
        case timestamp, displays, windows
        case durationMilliseconds = "duration_milliseconds"
        case rawAXWindows = "raw_ax_windows"
        case rawCGWindows = "raw_cg_windows"
        case rejectedAXWindows = "rejected_ax_windows"
        case joinDecisions = "join_decisions"
        case sourceHealth = "source_health"
        case appScans = "app_scans"
    }
}
