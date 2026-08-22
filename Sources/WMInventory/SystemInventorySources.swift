import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import WMProtocol

public protocol CGDisplayEnumerator: Sendable {
    /// Returns the online display IDs, or nil when the CG query itself failed.
    /// The online list is authoritative for hot-plug: it tracks connect/disconnect
    /// without an AppKit event loop and includes sleeping/clamshell displays.
    func onlineDisplayList() -> [CGDirectDisplayID]?
    func isActive(_ displayID: CGDirectDisplayID) -> Bool
    func isBuiltin(_ displayID: CGDirectDisplayID) -> Bool
    func isMain(_ displayID: CGDirectDisplayID) -> Bool
    func bounds(of displayID: CGDirectDisplayID) -> CGRect
    func pixelWidth(of displayID: CGDirectDisplayID) -> Int
    func vendorNumber(of displayID: CGDirectDisplayID) -> UInt32
    func modelNumber(of displayID: CGDirectDisplayID) -> UInt32
    func serialNumber(of displayID: CGDirectDisplayID) -> UInt32
    func uuidString(for displayID: CGDirectDisplayID) -> String?
}

public struct CoreGraphicsDisplayEnumerator: CGDisplayEnumerator {
    public init() {}

    public func onlineDisplayList() -> [CGDirectDisplayID]? {
        var capacity: UInt32 = 8
        while true {
            var ids = [CGDirectDisplayID](repeating: 0, count: Int(capacity))
            var count: UInt32 = 0
            guard CGGetOnlineDisplayList(capacity, &ids, &count) == .success else { return nil }
            guard count > capacity else { return Array(ids.prefix(Int(count))) }
            capacity = count
        }
    }

    public func isActive(_ displayID: CGDirectDisplayID) -> Bool { CGDisplayIsActive(displayID) != 0 }
    public func isBuiltin(_ displayID: CGDirectDisplayID) -> Bool { CGDisplayIsBuiltin(displayID) != 0 }
    public func isMain(_ displayID: CGDirectDisplayID) -> Bool { CGDisplayIsMain(displayID) != 0 }
    public func bounds(of displayID: CGDirectDisplayID) -> CGRect { CGDisplayBounds(displayID) }

    public func pixelWidth(of displayID: CGDirectDisplayID) -> Int {
        let width = CGDisplayPixelsWide(displayID)
        return width > 0 ? Int(width) : 0
    }

    public func vendorNumber(of displayID: CGDirectDisplayID) -> UInt32 { CGDisplayVendorNumber(displayID) }
    public func modelNumber(of displayID: CGDirectDisplayID) -> UInt32 { CGDisplayModelNumber(displayID) }
    public func serialNumber(of displayID: CGDirectDisplayID) -> UInt32 { CGDisplaySerialNumber(displayID) }

    public func uuidString(for displayID: CGDirectDisplayID) -> String? {
        guard let value = CGDisplayCreateUUIDFromDisplayID(displayID)?.takeRetainedValue() else { return nil }
        return CFUUIDCreateString(nil, value) as String
    }
}

/// AppKit-side enrichment for a display, snapshotted from one `NSScreen`.
/// Frames are in NSScreen space (bottom-left origin, y-up) and are converted to
/// canonical OS space relative to their own display's frame during enrichment.
struct NSScreenSnapshot: Equatable, Sendable {
    var displayID: CGDirectDisplayID
    var name: String
    var frame: CGRect
    var visibleFrame: CGRect
    var backingScale: CGFloat
}

public enum DisplayCoordinateConversion {
    /// `CGDisplayBounds` already uses canonical OS space: top-left origin of the
    /// primary display, y-down — identical to AX global coordinates.
    public static func cgBoundsToOS(_ bounds: CGRect) -> CGRect { bounds }

    /// Converts an NSScreen-space rect (bottom-left origin, y-up, primary bottom
    /// at y=0) into canonical OS space, given the primary display's top edge in
    /// NSScreen space (`primaryTop == primary.frame.maxY`).
    public static func nsScreenRectToOS(_ rect: CGRect, primaryTop: CGFloat) -> CGRect {
        CGRect(x: rect.origin.x, y: primaryTop - rect.maxY, width: rect.width, height: rect.height)
    }

    /// Converts an NSScreen-space rect belonging to a specific display into
    /// canonical OS space. Horizontal position is shared between both conventions;
    /// vertical position is preserved relative to the display's own frame and
    /// re-anchored at the display's OS-frame top edge. Avoids needing global
    /// primary geometry for per-display enrichment.
    public static func nsScreenRectToOS(
        _ rect: CGRect, displayNSFrame: CGRect, displayOSFrame: CGRect
    ) -> CGRect {
        let localTopOffset = displayNSFrame.height - (rect.maxY - displayNSFrame.minY)
        return CGRect(
            x: rect.minX, y: displayOSFrame.minY + localTopOffset,
            width: rect.width, height: rect.height)
    }
}

/// CG-driven display inventory.
///
/// `NSScreen.screens` is a process-lifetime cache that never refreshes in this
/// daemon because no AppKit event loop runs, so enumeration is anchored on
/// `CGGetOnlineDisplayList` (fresh on every poll) and AppKit is only used to
/// enrich fields CG cannot provide. Online-but-inactive displays (sleeping
/// clamshell lid, mirrored-off) are deliberately kept in the inventory so
/// topology reconciliation does not migrate their workspaces during sleep.
public struct SystemDisplayInventorySource: DisplayInventorySource {
    let enumerator: any CGDisplayEnumerator

    public init(enumerator: any CGDisplayEnumerator = CoreGraphicsDisplayEnumerator()) {
        self.enumerator = enumerator
    }

    @MainActor
    public func displays() async -> SourceResult<[DisplayObservation]> {
        Self.result(enumerator: enumerator, screens: Self.screenSnapshots(NSScreen.screens))
    }

    @MainActor
    static func screenSnapshots(_ screens: [NSScreen]) -> [NSScreenSnapshot] {
        screens.compactMap { screen in
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
            return NSScreenSnapshot(
                displayID: number.uint32Value,
                name: screen.localizedName,
                frame: screen.frame,
                visibleFrame: screen.visibleFrame,
                backingScale: screen.backingScaleFactor
            )
        }
    }

    static func result(
        enumerator: some CGDisplayEnumerator,
        screens: [NSScreenSnapshot]
    ) -> SourceResult<[DisplayObservation]> {
        guard let online = enumerator.onlineDisplayList() else {
            return SourceResult(
                value: [],
                health: SourceHealth(
                    source: .displays,
                    status: .unhealthy,
                    permissionGranted: nil,
                    issues: ["CGGetOnlineDisplayList failed"]
                )
            )
        }
        let observations = observations(from: online, enumerator: enumerator, screens: screens)
        return SourceResult(
            value: observations,
            health: SourceHealth(
                source: .displays,
                status: observations.isEmpty ? .unhealthy : .healthy,
                permissionGranted: nil,
                issues: observations.isEmpty ? ["CoreGraphics reported no online displays"] : []
            )
        )
    }

    static func observations(
        from online: [CGDirectDisplayID],
        enumerator: some CGDisplayEnumerator,
        screens: [NSScreenSnapshot]
    ) -> [DisplayObservation] {
        let screensByDisplayID = Dictionary(
            screens.map { ($0.displayID, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        let displays = online.map { displayID -> DisplayObservation in
            let uuid = enumerator.uuidString(for: displayID)
            let identifiers = DisplayIdentifiers(
                nsscreenNumber: String(displayID),
                cgDirectDisplayID: String(displayID),
                uuid: uuid,
                vendorID: String(enumerator.vendorNumber(of: displayID)),
                productID: String(enumerator.modelNumber(of: displayID)),
                serialNumber: String(enumerator.serialNumber(of: displayID))
            )
            // Stability across reconnects depends on this canonical form.
            let canonical = uuid.map { "display:\($0.lowercased())" } ?? "display:\(displayID)"
            // CGDisplayBounds is already in canonical OS space.
            let frame = DisplayCoordinateConversion.cgBoundsToOS(enumerator.bounds(of: displayID))
            let isBuiltin = enumerator.isBuiltin(displayID)
            let screen = screensByDisplayID[displayID]
            // Fallbacks cover the hot-plug window where AppKit's cached screen list
            // does not yet (or ever) include the display: full-frame work area,
            // generic name, and a scale derived from CG pixel geometry.
            let name = screen?.name ?? (isBuiltin ? "Built-in Display" : "External Display")
            let visibleFrame =
                screen.map {
                    DisplayCoordinateConversion.nsScreenRectToOS(
                        $0.visibleFrame, displayNSFrame: $0.frame, displayOSFrame: frame)
                } ?? frame
            let backingScale: Double
            if let screen {
                backingScale = Double(screen.backingScale)
            } else {
                let pixels = enumerator.pixelWidth(of: displayID)
                backingScale = pixels > 0 && frame.width > 0 ? Double(pixels) / frame.width : 1
            }
            return DisplayObservation(
                id: canonical,
                name: name,
                isBuiltin: isBuiltin,
                isPrimary: enumerator.isMain(displayID),
                frame: InventoryRect(frame),
                visibleFrame: InventoryRect(visibleFrame),
                backingScale: backingScale,
                identifiers: identifiers
            )
        }
        return displays.sorted { lhs, rhs in
            if lhs.isPrimary != rhs.isPrimary { return lhs.isPrimary }
            if lhs.frame.x != rhs.frame.x { return lhs.frame.x < rhs.frame.x }
            if lhs.frame.y != rhs.frame.y { return lhs.frame.y < rhs.frame.y }
            return lhs.id < rhs.id
        }
    }
}

public struct SystemCoreGraphicsInventorySource: CoreGraphicsInventorySource {
    public init() {}

    public func windows() async -> SourceResult<[RawCGWindow]> {
        let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
        guard let dictionaries = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[CFString: Any]] else {
            return SourceResult(
                value: [],
                health: SourceHealth(source: .coreGraphics, status: .unhealthy, permissionGranted: false, issues: ["CGWindowListCopyWindowInfo returned no inventory"])
            )
        }
        let observations = dictionaries.map { dictionary in
            RawCGWindow(
                cgWindowID: number(dictionary[kCGWindowNumber])?.uint32Value,
                pid: number(dictionary[kCGWindowOwnerPID])?.int32Value,
                ownerName: dictionary[kCGWindowOwnerName] as? String,
                title: dictionary[kCGWindowName] as? String,
                layer: number(dictionary[kCGWindowLayer])?.intValue,
                alpha: number(dictionary[kCGWindowAlpha])?.doubleValue,
                onScreen: number(dictionary[kCGWindowIsOnscreen])?.boolValue,
                frame: (dictionary[kCGWindowBounds] as? [String: Any]).flatMap(InventoryRect.init)
            )
        }
        let canCapture = CGPreflightScreenCaptureAccess()
        var issues: [String] = []
        if !canCapture { issues.append("Screen Recording permission is not granted; titles and off-process metadata may be incomplete") }
        return SourceResult(
            value: observations,
            health: SourceHealth(source: .coreGraphics, status: canCapture ? .healthy : .degraded, permissionGranted: canCapture, issues: issues)
        )
    }
}

public struct SystemAccessibilityInventorySource: AccessibilityInventorySource {
    public init() {}

    @MainActor
    public func applications() async -> SourceResult<[ApplicationObservation]> {
        let trusted = AXIsProcessTrusted()
        let applications = NSWorkspace.shared.runningApplications.compactMap { app -> ApplicationObservation? in
            guard !app.isTerminated,
                  app.processIdentifier > 0,
                  app.activationPolicy != .prohibited else { return nil }
            return ApplicationObservation(
                pid: app.processIdentifier,
                name: app.localizedName ?? app.bundleIdentifier ?? "pid \(app.processIdentifier)",
                bundleID: app.bundleIdentifier,
                executablePath: app.executableURL?.path
            )
        }
        return SourceResult(
            value: trusted ? applications : [],
            health: SourceHealth(
                source: .accessibility,
                status: trusted ? .healthy : .unhealthy,
                permissionGranted: trusted,
                issues: trusted ? [] : ["Accessibility permission is not granted or not operational"]
            )
        )
    }

    public func windows(for application: ApplicationObservation) async throws -> [RawAXWindow] {
        try Task.checkCancellation()
        let app = AXUIElementCreateApplication(application.pid)
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value)
        guard result == .success else { throw AccessibilityReadError(attribute: kAXWindowsAttribute, code: result) }
        guard let elements = value as? [AXUIElement] else { return [] }
        return elements.map { element in readWindow(element, application: application) }
    }
}

public struct AccessibilityReadError: Error, CustomStringConvertible, Sendable {
    public var attribute: String
    public var code: AXError

    public init(attribute: String, code: AXError) {
        self.attribute = attribute
        self.code = code
    }

    public var description: String { "AX read \(attribute) failed with code \(code.rawValue)" }
}

private func readWindow(_ element: AXUIElement, application: ApplicationObservation) -> RawAXWindow {
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
    let positionSettable = attributeSettable(element, kAXPositionAttribute)
    let sizeSettable = attributeSettable(element, kAXSizeAttribute)
    let cgWindowID: UInt32? = read(element, "AXWindowNumber", errors: &errors).flatMap { (number: NSNumber) in number.uint32Value }
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
        geometryCapabilities: .init(
            position: reportedCapability(positionSettable),
            size: reportedCapability(sizeSettable)
        ),
        cgWindowID: cgWindowID,
        readErrors: errors
    )
}

private func attributeSettable(_ element: AXUIElement, _ attribute: String) -> Bool? {
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success else { return nil }
    return settable.boolValue
}

private func reportedCapability(_ settable: Bool?) -> GeometryCapability {
    guard let settable else { return .init() }
    let state: GeometryCapabilityState = settable ? .supported : .fixed
    return .init(reported: state, evidence: [.init(source: .platformReport, state: state)])
}

private func readOptional<T>(_ element: AXUIElement, _ attribute: String) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
        return nil
    }
    return value as? T
}

private func read<T>(_ element: AXUIElement, _ attribute: String, errors: inout [String]) -> T? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard result == .success else {
        if result != .noValue && result != .attributeUnsupported { errors.append("\(attribute):\(result.rawValue)") }
        return nil
    }
    return value as? T
}

private func readFrame(_ element: AXUIElement, errors: inout [String]) -> InventoryRect? {
    guard let positionValue: AXValue = read(element, kAXPositionAttribute, errors: &errors),
          let sizeValue: AXValue = read(element, kAXSizeAttribute, errors: &errors) else { return nil }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue, .cgPoint, &position), AXValueGetValue(sizeValue, .cgSize, &size) else {
        errors.append("AX position or size had an unexpected value type")
        return nil
    }
    return InventoryRect(x: position.x, y: position.y, width: size.width, height: size.height)
}

private func number(_ value: Any?) -> NSNumber? { value as? NSNumber }

private extension InventoryRect {
    init(_ rect: CGRect) {
        self.init(x: rect.origin.x, y: rect.origin.y, width: rect.width, height: rect.height)
    }

    init?(dictionary: [String: Any]) {
        guard let x = number(dictionary["X"])?.doubleValue,
              let y = number(dictionary["Y"])?.doubleValue,
              let width = number(dictionary["Width"])?.doubleValue,
              let height = number(dictionary["Height"])?.doubleValue else { return nil }
        self.init(x: x, y: y, width: width, height: height)
    }
}
