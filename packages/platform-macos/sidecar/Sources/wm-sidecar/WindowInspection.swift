import AppKit
import ApplicationServices
import Foundation

enum AXDiagnosticValue: Encodable, Sendable {
    case none
    case boolean(Bool)
    case number(Double)
    case string(String)
    case point(Double, Double)
    case size(Double, Double)
    case element(pid: Int?, pidErrorCode: Int32, matchesTarget: Bool)
    case unsupported

    var valueType: String {
        switch self {
        case .none: "none"
        case .boolean: "boolean"
        case .number: "number"
        case .string: "string"
        case .point: "point"
        case .size: "size"
        case .element: "element"
        case .unsupported: "unsupported"
        }
    }

    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .none, .unsupported: try value.encodeNil()
        case .boolean(let raw): try value.encode(raw)
        case .number(let raw): try value.encode(raw)
        case .string(let raw): try value.encode(raw)
        case .point(let x, let y): try value.encode(["x": x, "y": y])
        case .size(let width, let height): try value.encode(["width": width, "height": height])
        case .element(let pid, let code, let matches):
            try value.encode(ElementValue(pid: pid, pidErrorCode: code, matchesTarget: matches))
        }
    }

    struct ElementValue: Encodable, Sendable {
        let pid: Int?
        let pidErrorCode: Int32
        let matchesTarget: Bool

        private enum Key: String, CodingKey { case pid, pidErrorCode, matchesTarget }
        func encode(to encoder: Encoder) throws {
            var value = encoder.container(keyedBy: Key.self)
            try value.encode(pid, forKey: .pid)
            try value.encode(pidErrorCode, forKey: .pidErrorCode)
            try value.encode(matchesTarget, forKey: .matchesTarget)
        }
    }
}

struct AXQueryResultValue: Encodable, Sendable {
    let scope: String
    let attribute: String
    let errorCode: Int32
    let errorName: String
    let valueType: String
    let value: AXDiagnosticValue
}

enum AXDiagnosticReader {
    static let timeout: CFTimeInterval = 0.05

    static func errorName(_ error: AXError) -> String {
        switch error {
        case .success: "success"
        case .noValue: "no_value"
        case .attributeUnsupported: "attribute_unsupported"
        case .cannotComplete: "cannot_complete"
        case .apiDisabled: "api_disabled"
        case .invalidUIElement: "invalid_ui_element"
        case .illegalArgument: "illegal_argument"
        case .notImplemented: "not_implemented"
        default: "ax_error_\(error.rawValue)"
        }
    }

    static func query(_ element: AXUIElement, scope: String, attribute: String, target: AXUIElement?) -> AXQueryResultValue {
        var raw: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &raw)
        let value = error == .success ? convert(raw, target: target) : .none
        return result(scope: scope, attribute: attribute, error: error, value: value)
    }

    static func result(scope: String, attribute: String, error: AXError, value: AXDiagnosticValue) -> AXQueryResultValue {
        let actual = error == .success ? value : .none
        return AXQueryResultValue(
            scope: scope, attribute: attribute, errorCode: error.rawValue,
            errorName: errorName(error), valueType: actual.valueType, value: actual)
    }

    static func settable(_ element: AXUIElement, attribute: String) -> AXQueryResultValue {
        var value = DarwinBoolean(false)
        let error = AXUIElementIsAttributeSettable(element, attribute as CFString, &value)
        return result(scope: "window", attribute: "\(attribute).settable", error: error, value: .boolean(value.boolValue))
    }

    private static func convert(_ raw: CFTypeRef?, target: AXUIElement?) -> AXDiagnosticValue {
        guard let raw else { return .none }
        let type = CFGetTypeID(raw)
        if type == CFBooleanGetTypeID() { return .boolean(CFBooleanGetValue((raw as! CFBoolean))) }
        if let number = raw as? NSNumber { return number.doubleValue.isFinite ? .number(number.doubleValue) : .unsupported }
        if let string = raw as? String { return .string(string) }
        if type == AXUIElementGetTypeID() { return elementValue(raw as! AXUIElement, target: target) }
        if type == AXValueGetTypeID() { return geometryValue(raw as! AXValue) }
        if let windows = raw as? [AXUIElement] { return .number(Double(windows.count)) }
        return .unsupported
    }

    static func identity(_ element: AXUIElement, target: AXUIElement?) -> AXDiagnosticValue.ElementValue {
        var pid: pid_t = 0
        let error = AXUIElementGetPid(element, &pid)
        return .init(
            pid: error == .success ? Int(pid) : nil, pidErrorCode: error.rawValue,
            matchesTarget: target.map { CFEqual(element, $0) } ?? false)
    }

    private static func elementValue(_ element: AXUIElement, target: AXUIElement?) -> AXDiagnosticValue {
        let value = identity(element, target: target)
        return .element(pid: value.pid, pidErrorCode: value.pidErrorCode, matchesTarget: value.matchesTarget)
    }

    static func windows(_ application: AXUIElement) -> (query: AXQueryResultValue, elements: [AXUIElement]) {
        var raw: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &raw)
        return windowList(error: error, raw: raw)
    }

    static func windowList(error: AXError, raw: CFTypeRef?) -> (query: AXQueryResultValue, elements: [AXUIElement]) {
        let elements = error == .success ? raw as? [AXUIElement] : nil
        let value: AXDiagnosticValue = elements.map { .number(Double($0.count)) } ?? .unsupported
        return (result(scope: "application", attribute: kAXWindowsAttribute, error: error, value: value), elements ?? [])
    }

    private static func geometryValue(_ raw: AXValue) -> AXDiagnosticValue {
        if AXValueGetType(raw) == .cgPoint {
            var point = CGPoint.zero
            if AXValueGetValue(raw, .cgPoint, &point), point.x.isFinite, point.y.isFinite { return .point(point.x, point.y) }
        }
        if AXValueGetType(raw) == .cgSize {
            var size = CGSize.zero
            if AXValueGetValue(raw, .cgSize, &size), size.width.isFinite, size.height.isFinite { return .size(size.width, size.height) }
        }
        return .unsupported
    }
}

struct WindowDiagnosticsValue: Encodable, Sendable {
    let platform = "macos-ax"
    let capturedAt: String
    let observer: Observer
    let target: Target
    let nsFrontmostPidBefore: Int?
    let nsFrontmostPidAfter: Int?
    let resolutionError: String?
    let queries: [AXQueryResultValue]
    var rawWindows: [RawWindow] = []

    struct RawWindow: Encodable, Sendable {
        let index: Int
        let identity: AXDiagnosticValue.ElementValue
        let queries: [AXQueryResultValue]
    }

    struct Observer: Encodable, Sendable {
        let pid: Int
        let bundleId: String?
        let accessibility: Bool
        let screenRecording: Bool
        private enum Key: String, CodingKey { case pid, bundleId, accessibility, screenRecording }
        func encode(to encoder: Encoder) throws {
            var value = encoder.container(keyedBy: Key.self)
            try value.encode(pid, forKey: .pid)
            try value.encode(bundleId, forKey: .bundleId)
            try value.encode(accessibility, forKey: .accessibility)
            try value.encode(screenRecording, forKey: .screenRecording)
        }
    }
    struct Target: Encodable, Sendable {
        let windowId: String?
        let pid: Int?
        let registered: Bool
        let activationPolicy: Int?
        let active: Bool?
        let hidden: Bool?
        private enum Key: String, CodingKey { case windowId, pid, registered, activationPolicy, active, hidden }
        func encode(to encoder: Encoder) throws {
            var value = encoder.container(keyedBy: Key.self)
            try value.encode(windowId, forKey: .windowId)
            try value.encode(pid, forKey: .pid)
            try value.encode(registered, forKey: .registered)
            try value.encode(activationPolicy, forKey: .activationPolicy)
            try value.encode(active, forKey: .active)
            try value.encode(hidden, forKey: .hidden)
        }
    }

    private enum Key: String, CodingKey {
        case platform, capturedAt, observer, target, nsFrontmostPidBefore, nsFrontmostPidAfter, resolutionError, queries, rawWindows
    }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        try container.encode(platform, forKey: .platform)
        try container.encode(capturedAt, forKey: .capturedAt)
        try container.encode(observer, forKey: .observer)
        try container.encode(target, forKey: .target)
        try container.encode(nsFrontmostPidBefore, forKey: .nsFrontmostPidBefore)
        try container.encode(nsFrontmostPidAfter, forKey: .nsFrontmostPidAfter)
        try container.encode(resolutionError, forKey: .resolutionError)
        try container.encode(queries, forKey: .queries)
        try container.encode(rawWindows, forKey: .rawWindows)
    }
}

struct WindowInspectionValue: Encodable, Sendable {
    let window: WindowValue?
    let diagnostics: WindowDiagnosticsValue
    private enum Key: String, CodingKey { case window, diagnostics }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        try container.encode(window, forKey: .window)
        try container.encode(diagnostics, forKey: .diagnostics)
    }
}

@MainActor
enum WindowInspector {
    static func collect(windowId: String?, meta: WindowMeta?, element: AXUIElement?, resolutionError: String?, pid: Int32? = nil) -> WindowDiagnosticsValue {
        let targetPid = pid ?? meta?.pid
        let before = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let app = targetPid.flatMap { NSRunningApplication(processIdentifier: $0) }
        let permissions = Permissions.current
        let window = windowQueries(element)
        let application = applicationQueries(targetPid, target: element)
        let queries = window + application.queries + systemQueries(target: element)
        return WindowDiagnosticsValue(
            capturedAt: ISO8601DateFormatter().string(from: Date()),
            observer: .init(
                pid: Int(getpid()), bundleId: Bundle.main.bundleIdentifier,
                accessibility: permissions.accessibility, screenRecording: permissions.screenRecording),
            target: .init(
                windowId: windowId, pid: targetPid.map(Int.init), registered: app != nil,
                activationPolicy: app.map { Int($0.activationPolicy.rawValue) }, active: app?.isActive, hidden: app?.isHidden),
            nsFrontmostPidBefore: before.map(Int.init),
            nsFrontmostPidAfter: (NSWorkspace.shared.frontmostApplication?.processIdentifier).map(Int.init),
            resolutionError: resolutionError, queries: queries, rawWindows: application.windows)
    }

    private static func windowQueries(_ element: AXUIElement?) -> [AXQueryResultValue] {
        guard let element else { return [] }
        let attributes = [
            "AXRole", "AXSubrole", "AXFocused", "AXMain", "AXMinimized", "AXFullScreen",
            "AXModal", "AXPosition", "AXSize", "AXWindowNumber", "AXMovable", "AXResizable",
        ]
        return attributes.map { AXDiagnosticReader.query(element, scope: "window", attribute: $0, target: element) }
            + [kAXPositionAttribute, kAXSizeAttribute, kAXMinimizedAttribute].map { AXDiagnosticReader.settable(element, attribute: $0) }
    }

    private static func applicationQueries(_ pid: Int32?, target: AXUIElement?) -> (queries: [AXQueryResultValue], windows: [WindowDiagnosticsValue.RawWindow])
    {
        guard let pid else { return ([], []) }
        let app = AXUIElementCreateApplication(pid)
        setMessagingTimeout(app, AXDiagnosticReader.timeout)
        let queries = [kAXFrontmostAttribute, kAXFocusedWindowAttribute].map {
            AXDiagnosticReader.query(app, scope: "application", attribute: $0, target: target)
        }
        let list = AXDiagnosticReader.windows(app)
        let windows = list.elements.enumerated().map { index, element in
            rawWindow(index: index, element: element, target: target)
        }
        return (queries + [list.query], windows)
    }

    private static func rawWindow(index: Int, element: AXUIElement, target: AXUIElement?) -> WindowDiagnosticsValue.RawWindow {
        setMessagingTimeout(element, AXDiagnosticReader.timeout)
        defer { setMessagingTimeout(element, 1.5) }
        return .init(index: index, identity: AXDiagnosticReader.identity(element, target: target), queries: windowQueries(element))
    }

    private static func systemQueries(target: AXUIElement?) -> [AXQueryResultValue] {
        let system = AXUIElementCreateSystemWide()
        setMessagingTimeout(system, AXDiagnosticReader.timeout)
        return [kAXFocusedApplicationAttribute, kAXFocusedUIElementAttribute].map {
            AXDiagnosticReader.query(system, scope: "system", attribute: $0, target: target)
        }
    }
}
