import Foundation

public struct Rectangle: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public init(x: Double, y: Double, width: Double, height: Double) { self.x = x; self.y = y; self.width = width; self.height = height }
}

public enum HealthStatus: String, Codable, Sendable { case healthy, degraded, recovering, unhealthy }

public struct Capabilities: Codable, Equatable, Sendable {
    public var accessibility: Bool
    public var screenRecording: Bool
    public var windowInventory: Bool
    public var pointerWarp: Bool?
    public init(accessibility: Bool, screenRecording: Bool, windowInventory: Bool, pointerWarp: Bool?) {
        self.accessibility = accessibility; self.screenRecording = screenRecording; self.windowInventory = windowInventory; self.pointerWarp = pointerWarp
    }
    enum CodingKeys: String, CodingKey {
        case accessibility
        case screenRecording = "screen_recording"
        case windowInventory = "window_inventory"
        case pointerWarp = "pointer_warp"
    }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(accessibility, forKey: .accessibility)
        try container.encode(screenRecording, forKey: .screenRecording)
        try container.encode(windowInventory, forKey: .windowInventory)
        try container.encode(pointerWarp, forKey: .pointerWarp)
    }
}

public struct Health: Codable, Equatable, Sendable {
    public var status: HealthStatus
    public var issues: [String]
    public var capabilities: Capabilities?
    public init(status: HealthStatus, issues: [String], capabilities: Capabilities? = nil) { self.status = status; self.issues = issues; self.capabilities = capabilities }
}

public struct DisplayIdentifiers: Codable, Equatable, Sendable {
    public var nsscreenNumber: String?
    public var cgDirectDisplayId: String?
    public var uuid: String?
    public var vendorId: String?
    public var productId: String?
    public var serialNumber: String?
    public init(nsscreenNumber: String? = nil, cgDirectDisplayId: String? = nil, uuid: String? = nil, vendorId: String? = nil, productId: String? = nil, serialNumber: String? = nil) {
        self.nsscreenNumber = nsscreenNumber; self.cgDirectDisplayId = cgDirectDisplayId; self.uuid = uuid; self.vendorId = vendorId; self.productId = productId; self.serialNumber = serialNumber
    }
    enum CodingKeys: String, CodingKey { case nsscreenNumber = "nsscreen_number", cgDirectDisplayId = "cg_direct_display_id", uuid, vendorId = "vendor_id", productId = "product_id", serialNumber = "serial_number" }
}

public struct Display: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var isBuiltin: Bool
    public var isPrimary: Bool
    public var frame: Rectangle
    public var visibleFrame: Rectangle
    public var backingScale: Double
    public var identifiers: DisplayIdentifiers
    public init(id: String, name: String, isBuiltin: Bool, isPrimary: Bool, frame: Rectangle, visibleFrame: Rectangle, backingScale: Double, identifiers: DisplayIdentifiers) {
        self.id = id; self.name = name; self.isBuiltin = isBuiltin; self.isPrimary = isPrimary; self.frame = frame; self.visibleFrame = visibleFrame; self.backingScale = backingScale; self.identifiers = identifiers
    }
    enum CodingKeys: String, CodingKey {
        case id, name, frame, identifiers
        case isBuiltin = "is_builtin"
        case isPrimary = "is_primary"
        case visibleFrame = "visible_frame"
        case backingScale = "backing_scale"
    }
}

public enum WindowSource: String, Codable, Sendable { case accessibility; case coreGraphics = "core_graphics" }

public struct RawAXWindow: Codable, Equatable, Sendable {
    public var source: WindowSource
    public var pid: Int32
    public var appName: String?
    public var bundleId: String?
    public var title: String?
    public var role: String?
    public var subrole: String?
    public var frame: Rectangle?
    public var minimized: Bool?
    public var fullscreen: Bool?
    public var focused: Bool?
    public var main: Bool?
    public var modal: Bool?
    public var hasParent: Bool?
    public var movable: Bool?
    public var resizable: Bool?
    public var geometryCapabilities: GeometryCapabilities
    public var cgWindowId: UInt32?
    public var readErrors: [String]
    public init(source: WindowSource = .accessibility, pid: Int32, appName: String? = nil, bundleId: String? = nil, title: String? = nil, role: String? = nil, subrole: String? = nil, frame: Rectangle? = nil, minimized: Bool? = nil, fullscreen: Bool? = nil, focused: Bool? = nil, main: Bool? = nil, modal: Bool? = nil, hasParent: Bool? = nil, movable: Bool? = nil, resizable: Bool? = nil, geometryCapabilities: GeometryCapabilities = .init(), cgWindowId: UInt32? = nil, readErrors: [String] = []) {
        self.source = source; self.pid = pid; self.appName = appName; self.bundleId = bundleId; self.title = title; self.role = role; self.subrole = subrole; self.frame = frame; self.minimized = minimized; self.fullscreen = fullscreen; self.focused = focused; self.main = main; self.modal = modal; self.hasParent = hasParent; self.movable = movable; self.resizable = resizable; self.geometryCapabilities = geometryCapabilities; self.cgWindowId = cgWindowId; self.readErrors = readErrors
    }
    enum CodingKeys: String, CodingKey { case source, pid, appName = "app_name", bundleId = "bundle_id", title, role, subrole, frame, minimized, fullscreen, focused, main, modal, hasParent = "has_parent", movable, resizable, geometryCapabilities = "geometry_capabilities", cgWindowId = "cg_window_id", readErrors = "read_errors" }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        source = try container.decodeIfPresent(WindowSource.self, forKey: .source) ?? .accessibility; pid = try container.decode(Int32.self, forKey: .pid); appName = try container.decodeIfPresent(String.self, forKey: .appName); bundleId = try container.decodeIfPresent(String.self, forKey: .bundleId); title = try container.decodeIfPresent(String.self, forKey: .title); role = try container.decodeIfPresent(String.self, forKey: .role); subrole = try container.decodeIfPresent(String.self, forKey: .subrole); frame = try container.decodeIfPresent(Rectangle.self, forKey: .frame); minimized = try container.decodeIfPresent(Bool.self, forKey: .minimized); fullscreen = try container.decodeIfPresent(Bool.self, forKey: .fullscreen); focused = try container.decodeIfPresent(Bool.self, forKey: .focused); main = try container.decodeIfPresent(Bool.self, forKey: .main); modal = try container.decodeIfPresent(Bool.self, forKey: .modal); hasParent = try container.decodeIfPresent(Bool.self, forKey: .hasParent); movable = try container.decodeIfPresent(Bool.self, forKey: .movable); resizable = try container.decodeIfPresent(Bool.self, forKey: .resizable); geometryCapabilities = try container.decodeIfPresent(GeometryCapabilities.self, forKey: .geometryCapabilities) ?? .init(); cgWindowId = try container.decodeIfPresent(UInt32.self, forKey: .cgWindowId); readErrors = try container.decodeIfPresent([String].self, forKey: .readErrors) ?? []
    }
}

public struct RawCGWindow: Codable, Equatable, Sendable {
    public var source: WindowSource
    public var cgWindowId: UInt32
    public var pid: Int32
    public var ownerName: String?
    public var title: String?
    public var layer: Int
    public var alpha: Double
    public var onScreen: Bool
    public var frame: Rectangle
    public init(source: WindowSource = .coreGraphics, cgWindowId: UInt32, pid: Int32, ownerName: String? = nil, title: String? = nil, layer: Int, alpha: Double, onScreen: Bool, frame: Rectangle) {
        self.source = source; self.cgWindowId = cgWindowId; self.pid = pid; self.ownerName = ownerName; self.title = title; self.layer = layer; self.alpha = alpha; self.onScreen = onScreen; self.frame = frame
    }
    enum CodingKeys: String, CodingKey { case source, cgWindowId = "cg_window_id", pid, ownerName = "owner_name", title, layer, alpha, onScreen = "on_screen", frame }
}

public enum WindowClassification: String, Codable, Sendable { case normal, transient; case systemUI = "system_ui"; case uncertain }
public enum WindowManagement: String, Codable, Sendable { case managed, unmanaged, ineligible, pending }
public enum JoinConfidence: String, Codable, Sendable { case exact, strong, weak; case axOnly = "ax_only"; case cgOnly = "cg_only" }

public enum GeometryCapabilityState: String, Codable, Hashable, Sendable {
    case unknown, supported, fixed, inconclusive
}

public enum GeometryCapabilityEvidenceSource: String, Codable, Hashable, Sendable {
    case platformReport = "platform_report"
    case behavioralProbe = "behavioral_probe"
    case geometryOperation = "geometry_operation"
}

public struct GeometryCapabilityEvidence: Codable, Hashable, Sendable {
    public var source: GeometryCapabilityEvidenceSource
    public var state: GeometryCapabilityState
    public init(source: GeometryCapabilityEvidenceSource, state: GeometryCapabilityState) {
        self.source = source; self.state = state
    }
}

public struct GeometryCapability: Codable, Hashable, Sendable {
    public var reported: GeometryCapabilityState
    public var confirmed: GeometryCapabilityState
    public var evidence: [GeometryCapabilityEvidence]
    public init(reported: GeometryCapabilityState = .unknown, confirmed: GeometryCapabilityState = .unknown, evidence: [GeometryCapabilityEvidence] = []) {
        self.reported = reported; self.confirmed = confirmed; self.evidence = evidence
    }
    enum CodingKeys: String, CodingKey { case reported, confirmed, evidence }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        reported = try container.decodeIfPresent(GeometryCapabilityState.self, forKey: .reported) ?? .unknown
        confirmed = try container.decodeIfPresent(GeometryCapabilityState.self, forKey: .confirmed) ?? .unknown
        evidence = try container.decodeIfPresent([GeometryCapabilityEvidence].self, forKey: .evidence) ?? []
    }
}

public struct GeometryCapabilities: Codable, Hashable, Sendable {
    public var position: GeometryCapability
    public var size: GeometryCapability
    public init(position: GeometryCapability = .init(), size: GeometryCapability = .init()) {
        self.position = position; self.size = size
    }
    enum CodingKeys: String, CodingKey { case position, size }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        position = try container.decodeIfPresent(GeometryCapability.self, forKey: .position) ?? .init()
        size = try container.decodeIfPresent(GeometryCapability.self, forKey: .size) ?? .init()
    }
}

public struct GeometryCapabilityProbeParams: Codable, Equatable, Sendable {
    public var windowID: String
    public init(windowID: String) { self.windowID = windowID }
    enum CodingKeys: String, CodingKey { case windowID = "window_id" }
}

public enum GeometryProbeDimension: String, Codable, Equatable, Sendable {
    case xNegative = "x_negative", xPositive = "x_positive"
    case yNegative = "y_negative", yPositive = "y_positive"
    case widthIn = "width_in", widthOut = "width_out"
    case heightIn = "height_in", heightOut = "height_out"
}

public struct GeometryProbeAttempt: Codable, Equatable, Sendable {
    public var dimension: GeometryProbeDimension
    public var requestedFrame: Rectangle
    public var observedFrame: Rectangle?
    public var changed: Bool?
    public var matchedRequest: Bool?
    public var error: String?
    public init(dimension: GeometryProbeDimension, requestedFrame: Rectangle, observedFrame: Rectangle? = nil, changed: Bool? = nil, matchedRequest: Bool? = nil, error: String? = nil) {
        self.dimension = dimension; self.requestedFrame = requestedFrame; self.observedFrame = observedFrame
        self.changed = changed; self.matchedRequest = matchedRequest; self.error = error
    }
    enum CodingKeys: String, CodingKey { case dimension, error; case requestedFrame = "requested_frame"; case observedFrame = "observed_frame"; case changed; case matchedRequest = "matched_request" }
}

public struct GeometryProbeRestoration: Codable, Equatable, Sendable {
    public var attempted: Bool
    public var succeeded: Bool
    public var verified: Bool
    public var error: String?
    public init(attempted: Bool, succeeded: Bool, verified: Bool, error: String? = nil) {
        self.attempted = attempted; self.succeeded = succeeded; self.verified = verified; self.error = error
    }
}

public struct GeometryCapabilityProbeResult: Codable, Equatable, Sendable {
    public var windowID: String
    public var originalFrame: Rectangle
    public var finalFrame: Rectangle?
    public var position: GeometryCapability
    public var size: GeometryCapability
    public var attempts: [GeometryProbeAttempt]
    public var restoration: GeometryProbeRestoration
    public var errors: [String]
    public init(windowID: String, originalFrame: Rectangle, finalFrame: Rectangle?, position: GeometryCapability, size: GeometryCapability, attempts: [GeometryProbeAttempt], restoration: GeometryProbeRestoration, errors: [String] = []) {
        self.windowID = windowID; self.originalFrame = originalFrame; self.finalFrame = finalFrame
        self.position = position; self.size = size; self.attempts = attempts
        self.restoration = restoration; self.errors = errors
    }
    enum CodingKeys: String, CodingKey { case position, size, attempts, restoration, errors; case windowID = "window_id"; case originalFrame = "original_frame"; case finalFrame = "final_frame" }
}

public struct WindowIdentity: Codable, Equatable, Sendable {
    public var cgWindowId: UInt32?
    public var joinConfidence: JoinConfidence
    public var signals: [String]
    public init(cgWindowId: UInt32? = nil, joinConfidence: JoinConfidence, signals: [String]) { self.cgWindowId = cgWindowId; self.joinConfidence = joinConfidence; self.signals = signals }
    enum CodingKeys: String, CodingKey { case cgWindowId = "cg_window_id", joinConfidence = "join_confidence", signals }
}

public struct WindowObservations: Codable, Equatable, Sendable {
    public var accessibility: Bool
    public var coreGraphics: Bool
    public var minimized: Bool?
    public var fullscreen: Bool?
    public var focused: Bool?
    public var main: Bool?
    public var onScreen: Bool?
    public init(accessibility: Bool, coreGraphics: Bool, minimized: Bool? = nil, fullscreen: Bool? = nil, focused: Bool? = nil, main: Bool? = nil, onScreen: Bool? = nil) {
        self.accessibility = accessibility; self.coreGraphics = coreGraphics; self.minimized = minimized; self.fullscreen = fullscreen; self.focused = focused; self.main = main; self.onScreen = onScreen
    }
}

public struct WindowHealth: Codable, Equatable, Sendable {
    public var status: HealthStatus
    public var issues: [String]
    public init(status: HealthStatus, issues: [String]) { self.status = status; self.issues = issues }
}

public struct Window: Codable, Equatable, Sendable {
    public var id: String; public var pid: Int32; public var appName: String?; public var bundleId: String?; public var executablePath: String?; public var title: String?; public var role: String?; public var subrole: String?; public var frame: Rectangle; public var displayId: String?; public var classification: WindowClassification; public var management: WindowManagement; public var rejectionReasons: [String]; public var identity: WindowIdentity; public var observations: WindowObservations; public var health: WindowHealth; public var geometryCapabilities: GeometryCapabilities
    public init(id: String, pid: Int32, appName: String? = nil, bundleId: String? = nil, executablePath: String? = nil, title: String? = nil, role: String? = nil, subrole: String? = nil, frame: Rectangle, displayId: String? = nil, classification: WindowClassification, management: WindowManagement, rejectionReasons: [String] = [], identity: WindowIdentity, observations: WindowObservations, health: WindowHealth, geometryCapabilities: GeometryCapabilities = .init()) {
        self.id = id; self.pid = pid; self.appName = appName; self.bundleId = bundleId; self.executablePath = executablePath; self.title = title; self.role = role; self.subrole = subrole; self.frame = frame; self.displayId = displayId; self.classification = classification; self.management = management; self.rejectionReasons = rejectionReasons; self.identity = identity; self.observations = observations; self.health = health; self.geometryCapabilities = geometryCapabilities
    }
    enum CodingKeys: String, CodingKey { case id, pid, title, role, subrole, frame, classification, management, observations, health; case appName = "app_name"; case bundleId = "bundle_id"; case executablePath = "executable_path"; case displayId = "display_id"; case rejectionReasons = "rejection_reasons"; case identity; case geometryCapabilities = "geometry_capabilities" }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id); pid = try container.decode(Int32.self, forKey: .pid)
        appName = try container.decodeIfPresent(String.self, forKey: .appName); bundleId = try container.decodeIfPresent(String.self, forKey: .bundleId); executablePath = try container.decodeIfPresent(String.self, forKey: .executablePath); title = try container.decodeIfPresent(String.self, forKey: .title); role = try container.decodeIfPresent(String.self, forKey: .role); subrole = try container.decodeIfPresent(String.self, forKey: .subrole)
        frame = try container.decode(Rectangle.self, forKey: .frame); displayId = try container.decodeIfPresent(String.self, forKey: .displayId); classification = try container.decode(WindowClassification.self, forKey: .classification); management = try container.decode(WindowManagement.self, forKey: .management); rejectionReasons = try container.decodeIfPresent([String].self, forKey: .rejectionReasons) ?? []; identity = try container.decode(WindowIdentity.self, forKey: .identity); observations = try container.decode(WindowObservations.self, forKey: .observations); health = try container.decode(WindowHealth.self, forKey: .health); geometryCapabilities = try container.decodeIfPresent(GeometryCapabilities.self, forKey: .geometryCapabilities) ?? .init()
    }
}
