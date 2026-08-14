import Foundation

public struct UserState: Codable, Equatable, Sendable {
    public var stateVersion: UInt64; public var sequence: UInt64; public var health: Health; public var focusedWindowId: String?; public var displays: [Display]; public var windows: [Window]
    public init(stateVersion: UInt64, sequence: UInt64, health: Health, focusedWindowId: String? = nil, displays: [Display], windows: [Window]) { self.stateVersion = stateVersion; self.sequence = sequence; self.health = health; self.focusedWindowId = focusedWindowId; self.displays = displays; self.windows = windows }
    enum CodingKeys: String, CodingKey { case stateVersion = "state_version", sequence, health, focusedWindowId = "focused_window_id", displays, windows }
}

public struct SourceHealth: Codable, Equatable, Sendable {
    public var status: HealthStatus; public var issues: [String]
    public init(status: HealthStatus, issues: [String] = []) { self.status = status; self.issues = issues }
}
public struct AppScanResult: Codable, Equatable, Sendable {
    public var pid: Int32; public var appName: String?; public var windowCount: Int; public var errors: [String]
    public init(pid: Int32, appName: String? = nil, windowCount: Int, errors: [String] = []) { self.pid = pid; self.appName = appName; self.windowCount = windowCount; self.errors = errors }
}
public struct RawCounts: Codable, Equatable, Sendable {
    public var accessibilityWindows: Int; public var coreGraphicsWindows: Int
    public init(accessibilityWindows: Int, coreGraphicsWindows: Int) { self.accessibilityWindows = accessibilityWindows; self.coreGraphicsWindows = coreGraphicsWindows }
}
public struct JoinStatistics: Codable, Equatable, Sendable {
    public var exact: Int; public var strong: Int; public var weak: Int; public var axOnly: Int; public var cgOnly: Int
    public init(exact: Int = 0, strong: Int = 0, weak: Int = 0, axOnly: Int = 0, cgOnly: Int = 0) { self.exact = exact; self.strong = strong; self.weak = weak; self.axOnly = axOnly; self.cgOnly = cgOnly }
}
public struct ObservedState: Codable, Equatable, Sendable {
    public var state: UserState; public var inventoryStartedAt: Date; public var inventoryCompletedAt: Date; public var scanDurationMilliseconds: Double; public var sourceHealth: [String: SourceHealth]; public var appScanResults: [AppScanResult]; public var rawCounts: RawCounts; public var joinStatistics: JoinStatistics
    public init(state: UserState, inventoryStartedAt: Date, inventoryCompletedAt: Date, scanDurationMilliseconds: Double, sourceHealth: [String: SourceHealth], appScanResults: [AppScanResult], rawCounts: RawCounts, joinStatistics: JoinStatistics) { self.state = state; self.inventoryStartedAt = inventoryStartedAt; self.inventoryCompletedAt = inventoryCompletedAt; self.scanDurationMilliseconds = scanDurationMilliseconds; self.sourceHealth = sourceHealth; self.appScanResults = appScanResults; self.rawCounts = rawCounts; self.joinStatistics = joinStatistics }
}
public struct RejectedAXWindow: Codable, Equatable, Sendable { public var window: RawAXWindow; public var reasons: [String]; public init(window: RawAXWindow, reasons: [String]) { self.window = window; self.reasons = reasons } }
public struct JoinDecision: Codable, Equatable, Sendable { public var axIndex: Int?; public var cgIndex: Int?; public var confidence: JoinConfidence; public var signals: [String]; public init(axIndex: Int? = nil, cgIndex: Int? = nil, confidence: JoinConfidence, signals: [String]) { self.axIndex = axIndex; self.cgIndex = cgIndex; self.confidence = confidence; self.signals = signals } }
public struct DiagnosticInventory: Codable, Equatable, Sendable {
    public var rawAxWindows: [RawAXWindow]; public var rawCgWindows: [RawCGWindow]; public var normalizedWindows: [Window]; public var rejectedAxWindows: [RejectedAXWindow]; public var joinDecisions: [JoinDecision]; public var sourceHealth: [String: SourceHealth]
    public init(rawAxWindows: [RawAXWindow], rawCgWindows: [RawCGWindow], normalizedWindows: [Window], rejectedAxWindows: [RejectedAXWindow], joinDecisions: [JoinDecision], sourceHealth: [String: SourceHealth]) { self.rawAxWindows = rawAxWindows; self.rawCgWindows = rawCgWindows; self.normalizedWindows = normalizedWindows; self.rejectedAxWindows = rejectedAxWindows; self.joinDecisions = joinDecisions; self.sourceHealth = sourceHealth }
}
public struct DisplayList: Codable, Equatable, Sendable { public var displays: [Display]; public init(displays: [Display]) { self.displays = displays } }
public struct WindowList: Codable, Equatable, Sendable { public var windows: [Window]; public init(windows: [Window]) { self.windows = windows } }
public struct DaemonPing: Codable, Equatable, Sendable { public var sessionId: String; public var daemonVersion: String; public var ready: Bool; public var currentSequence: UInt64; public var stateVersion: UInt64; public init(sessionId: String, daemonVersion: String, ready: Bool, currentSequence: UInt64, stateVersion: UInt64) { self.sessionId = sessionId; self.daemonVersion = daemonVersion; self.ready = ready; self.currentSequence = currentSequence; self.stateVersion = stateVersion } }

public enum Method: String, Codable, CaseIterable, Sendable { case stateGet = "state.get", stateObserved = "state.observed", healthGet = "health.get", displayList = "display.list", windowList = "window.list", windowManage = "window.manage", windowUnmanage = "window.unmanage", windowFrameGet = "window.frame.get", windowFrameSet = "window.frame.set", workspaceList = "workspace.list", workspaceFocus = "workspace.focus", workspaceMoveWindow = "workspace.move_window", workspaceMoveWindowBulk = "workspace.move_window_bulk", workspaceMoveDisplay = "workspace.move_display", workspaceSetMode = "workspace.set_mode", observeWindow = "observe.window", observeWorkspace = "observe.workspace", diagnosticsInventory = "diagnostics.inventory", inventoryRefresh = "inventory.refresh", daemonPing = "daemon.ping", daemonPause = "daemon.pause", daemonResume = "daemon.resume", transactionGet = "transaction.get", commandBatch = "command.batch" }
public enum EventTopic: String, Codable, CaseIterable, Sendable { case windowInventory = "window.inventory", displayInventory = "display.inventory", healthChanged = "health.changed", inventoryRefreshed = "inventory.refreshed", daemonReady = "daemon.ready", stateSnapshot = "state.snapshot", workspaceChanged = "workspace.changed", workspaceFocused = "workspace.focused", workspaceCreated = "workspace.created", workspaceDeleted = "workspace.deleted", workspaceDisplayChanged = "workspace.display_changed", workspaceModeChanged = "workspace.mode_changed" }
public enum Projection: String, Codable, CaseIterable, Sendable { case delta, snapshot, invalidation }
public enum SnapshotDetail: String, Codable, CaseIterable, Sendable { case concise, verbose }
public struct EntityDelta<Entity: Codable & Equatable & Sendable>: Codable, Equatable, Sendable { public var added: [Entity]; public var updated: [Entity]; public var removed: [String]; public init(added: [Entity], updated: [Entity], removed: [String]) { self.added = added; self.updated = updated; self.removed = removed } }
public struct Invalidation: Codable, Equatable, Sendable { public var topic: EventTopic; public var stateVersion: UInt64; public init(topic: EventTopic, stateVersion: UInt64) { self.topic = topic; self.stateVersion = stateVersion } }
