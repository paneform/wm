import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// Per-call AX messaging timeouts. Every AX call is bounded so one hung app
/// can never block the sidecar loop; per-app enumeration additionally runs
/// concurrently, isolating slow apps from the rest of the inventory.
private let axReadTimeout: CFTimeInterval = 1.5
private let axWriteTimeout: CFTimeInterval = 3.0

func setMessagingTimeout(_ element: AXUIElement, _ timeout: CFTimeInterval) {
    AXUIElementSetMessagingTimeout(element, Float(timeout))
}

struct RawCGWindow: Sendable {
    var cgWindowID: UInt32?
    var pid: Int32?
    var title: String?
    var onScreen: Bool?
    var frame: Rect?
}

struct RawAXWindow: Sendable {
    var pid: Int32
    var appName: String
    var bundleID: String?
    var executablePath: String?
    var title: String?
    var role: String?
    var subrole: String?
    var frame: Rect?
    var minimized: Bool?
    var fullscreen: Bool?
    var focused: Bool?
    var main: Bool?
    var modal: Bool?
    var hasParent: Bool
    var movable: Bool?
    var resizable: Bool?
    var cgWindowID: UInt32?
    var readErrors: [String]
}

struct CollectedInventory: Sendable {
    var cgWindows: [RawCGWindow]
    var axWindows: [RawAXWindow]
    /// pids whose app-level hide flag is set.
    var hiddenPids: Set<Int32>
    /// pids that failed or exceeded their AX budget this pass (excluded next pass).
    var stalledPids: Set<Int32>
}

enum WindowSource {
    // MARK: CoreGraphics

    /// CG windows are the existence oracle. Screen Recording degradation only
    /// reduces metadata richness; the source stays alive.
    static func collectCGWindows() -> [RawCGWindow] {
        let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
        guard let dictionaries = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[CFString: Any]] else {
            return []
        }
        return dictionaries.map { dictionary in
            RawCGWindow(
                cgWindowID: number(dictionary[kCGWindowNumber])?.uint32Value,
                pid: number(dictionary[kCGWindowOwnerPID])?.int32Value,
                title: dictionary[kCGWindowName] as? String,
                onScreen: number(dictionary[kCGWindowIsOnscreen])?.boolValue,
                frame: (dictionary[kCGWindowBounds] as? [String: Any]).flatMap(Rect.init))
        }
    }

    private static func number(_ value: Any?) -> NSNumber? { value as? NSNumber }

    // MARK: Accessibility

    struct KnownApplication: Sendable {
        var pid: Int32
        var name: String
        var bundleID: String?
        var executablePath: String?
    }

    @MainActor
    static func knownApplications() -> [KnownApplication] {
        NSWorkspace.shared.runningApplications.compactMap { app in
            guard !app.isTerminated,
                  app.processIdentifier > 0,
                  app.activationPolicy != .prohibited else { return nil }
            return KnownApplication(
                pid: app.processIdentifier,
                name: app.localizedName ?? app.bundleIdentifier ?? "pid \(app.processIdentifier)",
                bundleID: app.bundleIdentifier,
                executablePath: app.executableURL?.path)
        }
    }

    /// Enumerates every application's AX windows concurrently. A hung app is
    /// bounded by its messaging timeout and recorded as stalled so subsequent
    /// passes skip it instead of paying the latency again.
    static func collectAXWindows(
        applications: [KnownApplication],
        previouslyStalled: Set<Int32>,
        allowStalledRetryAfter: Bool = true
    ) async -> ([RawAXWindow], Set<Int32>) {
        let eligible = applications.filter { !previouslyStalled.contains($0.pid) }
        let retryable = allowStalledRetryAfter
            ? applications.filter { previouslyStalled.contains($0.pid) }
            : []

        var results: [(Int32, [RawAXWindow])] = []
        var stalled: Set<Int32> = []
        await withTaskGroup(of: (Int32, [RawAXWindow]?).self) { group in
            for app in eligible {
                group.addTask { (app.pid, enumerateAppWindows(app)) }
            }
            // Stalled apps get a single opportunistic probe pass so a
            // transiently-hung app recovers without stalling the cadence.
            for app in retryable.prefix(2) {
                group.addTask { (app.pid, enumerateAppWindows(app)) }
            }
            for await (pid, windows) in group {
                if let windows {
                    results.append((pid, windows))
                } else {
                    stalled.insert(pid)
                }
            }
        }
        return (results.flatMap(\.1), stalled)
    }

    /// Returns nil when the app failed its bounded AX budget this pass.
    nonisolated private static func enumerateAppWindows(_ app: KnownApplication) -> [RawAXWindow]? {
        let appElement = AXUIElementCreateApplication(app.pid)
        setMessagingTimeout(appElement, axReadTimeout)
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &value)
        guard result == .success else {
            return result == .noValue || result == .attributeUnsupported ? [] : nil
        }
        guard let elements = value as? [AXUIElement] else { return [] }
        return elements.map { readWindow($0, application: app) }
    }

    private static func readWindow(_ element: AXUIElement, application: KnownApplication) -> RawAXWindow {
        setMessagingTimeout(element, axReadTimeout)
        var errors: [String] = []
        let title: String? = read(element, kAXTitleAttribute, errors: &errors)
        let role: String? = read(element, kAXRoleAttribute, errors: &errors)
        let subrole: String? = read(element, kAXSubroleAttribute, errors: &errors)
        let minimized: Bool? = read(element, kAXMinimizedAttribute, errors: &errors)
        let fullscreen: Bool? = read(element, "AXFullScreen", errors: &errors)
        let focused: Bool? = read(element, kAXFocusedAttribute, errors: &errors)
        let main: Bool? = read(element, kAXMainAttribute, errors: &errors)
        let modal: Bool? = readOptional(element, kAXModalAttribute)
        let parent: AXUIElement? = readOptional(element, kAXParentAttribute)
        let parentRole: String? = parent.flatMap { readOptional($0, kAXRoleAttribute) }
        let movable: Bool? = readOptional(element, "AXMovable")
        let resizable: Bool? = readOptional(element, "AXResizable")
        let cgWindowID: UInt32? = read(element, "AXWindowNumber", errors: &errors)
            .flatMap { (numberValue: NSNumber) in numberValue.uint32Value }
        return RawAXWindow(
            pid: application.pid,
            appName: application.name,
            bundleID: application.bundleID,
            executablePath: application.executablePath,
            title: title,
            role: role,
            subrole: subrole,
            frame: readFrame(element, errors: &errors),
            minimized: minimized,
            fullscreen: fullscreen,
            focused: focused,
            main: main,
            modal: modal,
            hasParent: parentRole != nil && parentRole != kAXApplicationRole,
            movable: movable,
            resizable: resizable,
            cgWindowID: cgWindowID,
            readErrors: errors)
    }

    private static func readOptional<T>(_ element: AXUIElement, _ attribute: String) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
            return nil
        }
        return value as? T
    }

    private static func read<T>(_ element: AXUIElement, _ attribute: String, errors: inout [String]) -> T? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard result == .success else {
            if result != .noValue && result != .attributeUnsupported {
                errors.append("\(attribute):\(result.rawValue)")
            }
            return nil
        }
        return value as? T
    }

    private static func readFrame(_ element: AXUIElement, errors: inout [String]) -> Rect? {
        guard let positionValue: AXValue = read(element, kAXPositionAttribute, errors: &errors),
              let sizeValue: AXValue = read(element, kAXSizeAttribute, errors: &errors) else { return nil }
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &position),
              AXValueGetValue(sizeValue, .cgSize, &size) else {
            errors.append("position-or-size-unexpected-type")
            return nil
        }
        return Rect(x: position.x, y: position.y, width: size.width, height: size.height)
    }
}
