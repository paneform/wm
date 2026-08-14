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
    public var cgWindowId: UInt32?
    public var readErrors: [String]
    public init(source: WindowSource = .accessibility, pid: Int32, appName: String? = nil, bundleId: String? = nil, title: String? = nil, role: String? = nil, subrole: String? = nil, frame: Rectangle? = nil, minimized: Bool? = nil, fullscreen: Bool? = nil, focused: Bool? = nil, main: Bool? = nil, cgWindowId: UInt32? = nil, readErrors: [String] = []) {
        self.source = source; self.pid = pid; self.appName = appName; self.bundleId = bundleId; self.title = title; self.role = role; self.subrole = subrole; self.frame = frame; self.minimized = minimized; self.fullscreen = fullscreen; self.focused = focused; self.main = main; self.cgWindowId = cgWindowId; self.readErrors = readErrors
    }
    enum CodingKeys: String, CodingKey { case source, pid, appName = "app_name", bundleId = "bundle_id", title, role, subrole, frame, minimized, fullscreen, focused, main, cgWindowId = "cg_window_id", readErrors = "read_errors" }
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
public enum WindowManagement: String, Codable, Sendable { case unmanaged, ineligible, pending }
public enum JoinConfidence: String, Codable, Sendable { case exact, strong, weak; case axOnly = "ax_only"; case cgOnly = "cg_only" }

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
    public var id: String; public var pid: Int32; public var appName: String?; public var bundleId: String?; public var executablePath: String?; public var title: String?; public var role: String?; public var subrole: String?; public var frame: Rectangle; public var displayId: String?; public var classification: WindowClassification; public var management: WindowManagement; public var rejectionReasons: [String]; public var identity: WindowIdentity; public var observations: WindowObservations; public var health: WindowHealth
    public init(id: String, pid: Int32, appName: String? = nil, bundleId: String? = nil, executablePath: String? = nil, title: String? = nil, role: String? = nil, subrole: String? = nil, frame: Rectangle, displayId: String? = nil, classification: WindowClassification, management: WindowManagement, rejectionReasons: [String] = [], identity: WindowIdentity, observations: WindowObservations, health: WindowHealth) {
        self.id = id; self.pid = pid; self.appName = appName; self.bundleId = bundleId; self.executablePath = executablePath; self.title = title; self.role = role; self.subrole = subrole; self.frame = frame; self.displayId = displayId; self.classification = classification; self.management = management; self.rejectionReasons = rejectionReasons; self.identity = identity; self.observations = observations; self.health = health
    }
}
