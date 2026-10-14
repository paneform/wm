import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
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
    var ownerName: String? = nil
    var layer: Int? = nil
}

/// AX references are retained read-only across enumeration tasks and consumed
/// on the main actor for fast focus identity matching.
struct AXWindowReference: @unchecked Sendable {
    let element: AXUIElement
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
    var reference: AXWindowReference? = nil
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
        readCGWindows() ?? []
    }

    /// Nil means observation failed; an empty array is a successful read.
    static func readCGWindows() -> [RawCGWindow]? {
        let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
        guard
            let dictionaries = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[CFString: Any]]
        else {
            return nil
        }
        return dictionaries.map { dictionary in
            RawCGWindow(
                cgWindowID: number(dictionary[kCGWindowNumber])?.uint32Value,
                pid: number(dictionary[kCGWindowOwnerPID])?.int32Value,
                title: dictionary[kCGWindowName] as? String,
                onScreen: number(dictionary[kCGWindowIsOnscreen])?.boolValue,
                frame: (dictionary[kCGWindowBounds] as? [String: Any]).flatMap(Rect.init),
                ownerName: dictionary[kCGWindowOwnerName] as? String,
                layer: number(dictionary[kCGWindowLayer])?.intValue)
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
    static func knownApplications(cgWindows: [RawCGWindow]) -> [KnownApplication] {
        let registered = NSWorkspace.shared.runningApplications.compactMap { app -> KnownApplication? in
            guard !app.isTerminated,
                app.processIdentifier > 0,
                app.activationPolicy != .prohibited
            else { return nil }
            return KnownApplication(
                pid: app.processIdentifier,
                name: app.localizedName ?? app.bundleIdentifier ?? "pid \(app.processIdentifier)",
                bundleID: app.bundleIdentifier,
                executablePath: app.executableURL?.path)
        }
        return discoverApplications(registered: registered, cgWindows: cgWindows, resolve: applicationFromPID)
    }

    /// Launch Services can omit a live app. Normal CG window ownership supplies
    /// its PID; AX and the normalizer still decide whether its windows are manageable.
    static func discoverApplications(
        registered: [KnownApplication], cgWindows: [RawCGWindow],
        resolve: (Int32, String?) -> KnownApplication
    ) -> [KnownApplication] {
        var seen = Set(registered.map(\.pid))
        let missing = cgWindows.compactMap { window -> KnownApplication? in
            guard let pid = window.pid, pid > 0, window.layer == 0,
                window.frame?.isUsable == true, seen.insert(pid).inserted
            else { return nil }
            return resolve(pid, window.ownerName)
        }
        return registered + missing
    }

    private static func applicationFromPID(_ pid: Int32, ownerName: String?) -> KnownApplication {
        let executable = processExecutable(pid)
        let bundle = executable.flatMap(containingBundle)
        return KnownApplication(
            pid: pid,
            name: ownerName ?? bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "pid \(pid)",
            bundleID: bundle?.bundleIdentifier, executablePath: executable)
    }

    private static func processExecutable(_ pid: Int32) -> String? {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let capacity = UInt32(buffer.count)
        guard proc_pidpath(pid, &buffer, capacity) > 0 else { return nil }
        return String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }

    private static func containingBundle(_ executable: String) -> Bundle? {
        var directory = URL(fileURLWithPath: executable).deletingLastPathComponent()
        while directory.path != "/" {
            if directory.pathExtension == "app" { return Bundle(url: directory) }
            directory.deleteLastPathComponent()
        }
        return nil
    }

    /// Enumerates every application's AX windows concurrently. A hung app is
    /// bounded by its messaging timeout and recorded as stalled so subsequent
    /// passes skip it instead of paying the latency again.
    static func collectAXWindows(
        applications: [KnownApplication],
        previouslyStalled: Set<Int32>,
        frontmostPID: Int32?,
        allowStalledRetryAfter: Bool = true,
        retryOffset: Int = 0,
        enumerate: (@Sendable (KnownApplication, Int32?) -> [RawAXWindow]?)? = nil
    ) async -> ([RawAXWindow], Set<Int32>) {
        let readApp: @Sendable (KnownApplication, Int32?) -> [RawAXWindow]? =
            enumerate ?? {
                enumerateAppWindows($0, frontmostPID: $1)
            }
        let eligible = applications.filter { !previouslyStalled.contains($0.pid) || $0.pid == frontmostPID }
        let retryable =
            allowStalledRetryAfter
            ? applications.filter { previouslyStalled.contains($0.pid) && $0.pid != frontmostPID }
            : []
        let offset = max(0, retryOffset) % max(1, retryable.count)
        let retries = (Array(retryable.dropFirst(offset)) + retryable.prefix(offset)).prefix(2)

        var results: [(Int32, [RawAXWindow])] = []
        // Skipped probes are not recoveries. Retain their stall state until a
        // successful probe or process exit, and rotate retries fairly.
        var stalled = previouslyStalled.intersection(Set(applications.map(\.pid)))
        await withTaskGroup(of: (Int32, [RawAXWindow]?).self) { group in
            for app in eligible {
                group.addTask { (app.pid, readApp(app, frontmostPID)) }
            }
            // Stalled apps get a single opportunistic probe pass so a
            // transiently-hung app recovers without stalling the cadence.
            for app in retries {
                group.addTask { (app.pid, readApp(app, frontmostPID)) }
            }
            for await (pid, windows) in group {
                if let windows {
                    results.append((pid, windows))
                    stalled.remove(pid)
                } else {
                    stalled.insert(pid)
                }
            }
        }
        return (results.flatMap(\.1), stalled)
    }

    /// Returns nil when the app failed its bounded AX budget this pass.
    nonisolated private static func enumerateAppWindows(_ app: KnownApplication, frontmostPID: Int32?)
        -> [RawAXWindow]?
    {
        let appElement = AXUIElementCreateApplication(app.pid)
        setMessagingTimeout(appElement, axReadTimeout)
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &value)
        guard result == .success else {
            return result == .noValue || result == .attributeUnsupported ? [] : nil
        }
        guard let elements = value as? [AXUIElement] else { return [] }
        let focusedWindow = app.pid == frontmostPID ? WindowFocus.focusedWindow(in: appElement) : nil
        return elements.map {
            readWindow($0, application: app, frontmostPID: frontmostPID, focusedWindow: focusedWindow)
        }
    }

    private static func readWindow(
        _ element: AXUIElement,
        application: KnownApplication,
        frontmostPID: Int32?,
        focusedWindow: AXUIElement?
    ) -> RawAXWindow {
        setMessagingTimeout(element, axReadTimeout)
        var errors: [String] = []
        let title: String? = read(element, kAXTitleAttribute, errors: &errors)
        let role: String? = read(element, kAXRoleAttribute, errors: &errors)
        let subrole: String? = read(element, kAXSubroleAttribute, errors: &errors)
        let minimized: Bool? = read(element, kAXMinimizedAttribute, errors: &errors)
        let fullscreen: Bool? = read(element, "AXFullScreen", errors: &errors)
        let focused = WindowFocus.matches(
            element, pid: application.pid, frontmostPID: frontmostPID, focusedWindow: focusedWindow)
        let main: Bool? = read(element, kAXMainAttribute, errors: &errors)
        let modal: Bool? = readOptional(element, kAXModalAttribute)
        let parent: AXUIElement? = readOptional(element, kAXParentAttribute)
        let parentRole: String? = parent.flatMap { readOptional($0, kAXRoleAttribute) }
        let movable: Bool? =
            readOptional(element, "AXMovable")
            ?? attributeSettable(element, kAXPositionAttribute)
        let resizable: Bool? =
            readOptional(element, "AXResizable")
            ?? attributeSettable(element, kAXSizeAttribute)
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
            readErrors: errors,
            reference: AXWindowReference(element: element))
    }

    private static func readOptional<T>(_ element: AXUIElement, _ attribute: String) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
            return nil
        }
        return value as? T
    }

    private static func attributeSettable(_ element: AXUIElement, _ attribute: String) -> Bool? {
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success
        else {
            return nil
        }
        return settable.boolValue
    }

    private static func read<T>(_ element: AXUIElement, _ attribute: String, errors: inout [String])
        -> T?
    {
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
            let sizeValue: AXValue = read(element, kAXSizeAttribute, errors: &errors)
        else { return nil }
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &position),
            AXValueGetValue(sizeValue, .cgSize, &size)
        else {
            errors.append("position-or-size-unexpected-type")
            return nil
        }
        return Rect(x: position.x, y: position.y, width: size.width, height: size.height)
    }
}
