import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

public struct AppKitDisplayInventorySource: DisplayInventorySource {
    public init() {}

    @MainActor
    public func displays() async -> SourceResult<[DisplayObservation]> {
        let screens = NSScreen.screens
        let observations = screens.map { screen in
            let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
            let displayID = number?.uint32Value
            let uuid = displayID.flatMap { displayID -> String? in
                guard let value = CGDisplayCreateUUIDFromDisplayID(displayID)?.takeRetainedValue() else { return nil }
                return CFUUIDCreateString(nil, value) as String
            }
            let identifiers = DisplayIdentifiers(
                nsscreenNumber: number?.stringValue,
                cgDirectDisplayID: displayID.map(String.init),
                uuid: uuid,
                vendorID: displayID.map { String(CGDisplayVendorNumber($0)) },
                productID: displayID.map { String(CGDisplayModelNumber($0)) },
                serialNumber: displayID.map { String(CGDisplaySerialNumber($0)) }
            )
            let canonical = uuid.map { "display:\($0.lowercased())" }
                ?? displayID.map { "display:\($0)" }
                ?? "display:nsscreen:\(screens.firstIndex(of: screen) ?? 0)"
            return DisplayObservation(
                id: canonical,
                name: screen.localizedName,
                isBuiltin: displayID.map { CGDisplayIsBuiltin($0) != 0 } ?? false,
                isPrimary: displayID.map { CGDisplayIsMain($0) != 0 } ?? false,
                frame: InventoryRect(screen.frame),
                visibleFrame: InventoryRect(screen.visibleFrame),
                backingScale: screen.backingScaleFactor,
                identifiers: identifiers
            )
        }
        return SourceResult(
            value: observations,
            health: SourceHealth(
                source: .displays,
                status: observations.isEmpty ? .unhealthy : .healthy,
                permissionGranted: nil,
                issues: observations.isEmpty ? ["AppKit reported no connected displays"] : []
            )
        )
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
        cgWindowID: cgWindowID,
        readErrors: errors
    )
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
