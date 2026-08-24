import AppKit
import ApplicationServices
import Foundation

enum AdapterError: Error {
    case notFound
    case notControllable
    case stale
    case ambiguous
    case rejected

    var wireCode: String {
        switch self {
        case .notFound: "not_found"
        case .notControllable: "not_controllable"
        case .stale: "stale"
        case .ambiguous: "ambiguous"
        case .rejected: "rejected"
        }
    }
}

/// Identity + static metadata snapshot of one reportable window.
struct WindowMeta {
    var id: String
    var pid: Int32
    var role: String
    var subrole: String?
    var title: String?
    var frame: Rect
    var cgWindowID: UInt32?
    var bundleID: String?
    var executablePath: String?
    var hidden: Bool

    init(id: String, raw: RawAXWindow, cgTitle: String?, cgWindowID: UInt32?, hidden: Bool) {
        self.id = id
        self.pid = raw.pid
        self.role = raw.role ?? ""
        self.subrole = raw.subrole
        self.title = raw.title ?? cgTitle
        self.frame = raw.frame ?? Rect(x: 0, y: 0, width: 0, height: 0)
        self.cgWindowID = cgWindowID
        self.bundleID = raw.bundleID
        self.executablePath = raw.executablePath
        self.hidden = hidden
    }

    init(joined: Normalizer.Joined) {
        self.init(
            id: joined.value.id,
            raw: joined.raw,
            cgTitle: joined.value.title != joined.raw.title ? joined.value.title : nil,
            cgWindowID: joined.cgWindowID,
            hidden: joined.value.hidden)
    }
}

/// Ports the ground-truth `AXWindowGeometryAdapter` behavior: retained element
/// cache, identity validation around every component write, the
/// `AXEnhancedUserInterface` quirk, size→position→size bookends with 25 ms
/// inter-write delays, bounded settle polling, and the full focus sequence.
///
/// All entry points are MainActor-isolated; every AX call is bounded by the
/// per-element messaging timeout so one hung app cannot wedge the sidecar.
@MainActor
final class GeometryAdapter {
    private struct Record {
        var element: AXUIElement
        var meta: WindowMeta
    }

    private var records: [String: Record] = [:]
    private let interWriteDelayMs: UInt64
    private let settleIntervalMs: UInt64

    init(interWriteDelayMs: UInt64 = 25, settleIntervalMs: UInt64 = 17) {
        self.interWriteDelayMs = interWriteDelayMs
        self.settleIntervalMs = settleIntervalMs
    }

    // MARK: Cache maintenance (ground-truth `reconcile`)

    /// Drops retained elements whose logical window vanished or was replaced.
    func reconcile(windows: [WindowMeta]) {
        let byID = Dictionary(windows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for id in records.keys {
            guard let meta = byID[id], sameLogicalWindow(records[id]!.element, meta),
                  (try? frame(of: records[id]!.element)) != nil else {
                records.removeValue(forKey: id)
                continue
            }
        }
    }

    // MARK: Readback

    func readFrame(meta: WindowMeta) throws -> Rect {
        try frame(of: try resolve(meta))
    }

    /// Cheap live readback of one window for settle polling.
    func observation(for meta: WindowMeta) -> WindowValue? {
        guard let element = try? resolve(meta) else { return nil }
        var errors: [String] = []
        let liveFrame = Self.readFrame(element, errors: &errors) ?? meta.frame
        let title: String? = Self.optionalRead(element, kAXTitleAttribute)
        let minimized: Bool? = Self.optionalRead(element, kAXMinimizedAttribute)
        let fullscreen: Bool? = Self.optionalRead(element, "AXFullScreen")
        let focused: Bool? = Self.optionalRead(element, kAXFocusedAttribute)
        let movable: Bool? = Self.optionalRead(element, "AXMovable")
        let resizable: Bool? = Self.optionalRead(element, "AXResizable")
        return WindowValue(
            id: meta.id,
            pid: Int(meta.pid),
            bundleId: meta.bundleID,
            executablePath: meta.executablePath,
            title: title ?? meta.title,
            role: meta.role,
            subrole: meta.subrole,
            frame: liveFrame.frameValue,
            minimized: minimized ?? false,
            hidden: meta.hidden,
            fullscreen: fullscreen ?? false,
            focused: focused ?? false,
            capabilities: capabilityValue(movable: movable, resizable: resizable))
    }

    // MARK: Geometry writes

    enum Component {
        case position
        case size
    }

    /// Executes the component writes for one operation, settles against the
    /// target, and reports the observed outcome.
    ///
    /// - mode `.frame`: size→position→size bookends.
    /// - modes `.position` / `.size`: a single component write.
    func write(
        meta: WindowMeta,
        requested: Rect,
        components: [Component]
    ) async throws -> WriteValue {
        guard AXIsProcessTrusted() else { throw AdapterError.notControllable }
        let element = try resolve(meta)
        try validateControllability(element: element, components: components)

        try await withEnhancedUserInterfaceDisabled(pid: meta.pid) {
            for component in components {
                // Identity BEFORE the write: never mutate a replacement window.
                guard sameLogicalWindow(element, meta) else { throw AdapterError.stale }
                try writeComponent(component, requested, element: element)
                try await Task.sleep(for: .milliseconds(interWriteDelayMs))
                // Identity AFTER the write: abort rather than continue on a swap.
                guard sameLogicalWindow(element, meta) else { throw AdapterError.stale }
            }
        }

        let settlement = try await settle(element: element, requested: requested)
        return WriteValue(
            requested: requested.frameValue,
            observed: settlement.frame.frameValue,
            stable: settlement.stable,
            errorKind: nil)
    }

    /// Builds the effective request rect for position/size-only operations by
    /// merging onto the current observed frame.
    func mergedTarget(meta: WindowMeta, replace: (inout Rect) -> Void) throws -> Rect {
        var target = try frame(of: try resolve(meta))
        replace(&target)
        return target
    }

    private func writeComponent(_ component: Component, _ target: Rect, element: AXUIElement) throws {
        switch component {
        case .position:
            var point = CGPoint(x: target.x, y: target.y)
            guard let value = AXValueCreate(.cgPoint, &point),
                  AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, value) == .success else {
                throw AdapterError.rejected
            }
        case .size:
            var size = CGSize(width: target.width, height: target.height)
            guard let value = AXValueCreate(.cgSize, &size),
                  AXUIElementSetAttributeValue(element, kAXSizeAttribute as CFString, value) == .success else {
                throw AdapterError.rejected
            }
        }
    }

    private func validateControllability(element: AXUIElement, components: [Component]) throws {
        for component in components {
            let attribute = component == .position ? kAXPositionAttribute : kAXSizeAttribute
            var settable = DarwinBoolean(false)
            guard AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success else {
                throw AdapterError.notControllable
            }
            guard settable.boolValue else { throw AdapterError.notControllable }
        }
    }

    /// Requirement 5: temporarily clear `AXEnhancedUserInterface` around
    /// geometry writes and always restore it afterwards.
    private func withEnhancedUserInterfaceDisabled(pid: Int32, _ body: () async throws -> Void) async throws {
        let app = AXUIElementCreateApplication(pid)
        setMessagingTimeout(app, 1.5)
        let enhanced: Bool? = Self.optionalRead(app, "AXEnhancedUserInterface")
        if enhanced == true {
            _ = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse)
        }
        do {
            try await body()
        } catch {
            restoreEnhancedUserInterface(app, wasEnabled: enhanced == true)
            throw error
        }
        restoreEnhancedUserInterface(app, wasEnabled: enhanced == true)
    }

    private func restoreEnhancedUserInterface(_ app: AXUIElement, wasEnabled: Bool) {
        if wasEnabled {
            _ = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        }
    }

    // MARK: Settle polling (requirement 6)

    struct Settlement {
        var frame: Rect
        var stable: Bool
    }

    /// Up to 36 samples, 17 ms apart. Early exit on 3 consecutive target
    /// matches, or 3 consecutive stable reads (≤0.5 pt movement) whose
    /// normalized distance stopped improving.
    private func settle(element: AXUIElement, requested: Rect) async throws -> Settlement {
        let tolerance = 1.0
        var targetSamples = 0
        var stableSamples = 0
        var previous: Rect?
        var previousDistance = Double.infinity
        for _ in 0..<36 {
            var errors: [String] = []
            guard let observed = Self.readFrame(element, errors: &errors) else {
                throw AdapterError.stale
            }
            let matches = observed.approximatelyEquals(requested, tolerance: tolerance)
            targetSamples = matches ? targetSamples + 1 : 0
            stableSamples = previous?.approximatelyEquals(observed, tolerance: 0.5) == true ? stableSamples + 1 : 0
            let distance = normalizedDistance(observed, to: requested)
            if targetSamples >= 3 || (stableSamples >= 3 && distance >= previousDistance - 0.0001) {
                return Settlement(frame: observed, stable: true)
            }
            previous = observed
            previousDistance = distance
            try await Task.sleep(for: .milliseconds(settleIntervalMs))
        }
        var errors: [String] = []
        guard let final = Self.readFrame(element, errors: &errors) else {
            throw AdapterError.stale
        }
        return Settlement(frame: final, stable: false)
    }

    private func normalizedDistance(_ observed: Rect, to target: Rect) -> Double {
        abs(observed.x - target.x) / max(1, target.width)
            + abs(observed.y - target.y) / max(1, target.height)
            + abs(observed.width - target.width) / max(1, target.width)
            + abs(observed.height - target.height) / max(1, target.height)
    }

    // MARK: Focus (requirement 7)

    /// activate(activateAllWindows) → AXFrontmost → AXRaise → AXMain →
    /// AXFocused, verified via frontmost pid, with one delayed retry.
    func focus(meta: WindowMeta) throws {
        guard AXIsProcessTrusted() else { throw AdapterError.notControllable }
        let element = try resolve(meta)
        for attempt in 0..<2 {
            try raiseToFront(element, meta: meta)
            if frontmostPid() == meta.pid { return }
            if attempt == 0 {
                Thread.sleep(forTimeInterval: 0.15)
                guard sameLogicalWindow(element, meta) else { throw AdapterError.stale }
            }
        }
        throw AdapterError.rejected
    }

    private func raiseToFront(_ element: AXUIElement, meta: WindowMeta) throws {
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success, pid == meta.pid else {
            throw AdapterError.stale
        }
        guard let runningApplication = NSRunningApplication(processIdentifier: pid),
              runningApplication.activate(options: [.activateAllWindows]) else {
            throw AdapterError.rejected
        }
        let app = AXUIElementCreateApplication(pid)
        setMessagingTimeout(app, 3.0)
        guard AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue) == .success,
              AXUIElementPerformAction(element, kAXRaiseAction as CFString) == .success,
              AXUIElementSetAttributeValue(element, kAXMainAttribute as CFString, kCFBooleanTrue) == .success,
              AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else {
            throw AdapterError.rejected
        }
    }

    private func frontmostPid() -> Int32? {
        NSWorkspace.shared.frontmostApplication?.processIdentifier
    }

    // MARK: Element resolution (ground-truth `resolve`)

    private func resolve(_ meta: WindowMeta) throws -> AXUIElement {
        if let record = records[meta.id] {
            if sameLogicalWindow(record.element, meta), (try? frame(of: record.element)) != nil {
                return record.element
            }
            records.removeValue(forKey: meta.id)
            if !sameLogicalWindow(record.element, meta) { throw AdapterError.stale }
        }
        let app = AXUIElementCreateApplication(meta.pid)
        setMessagingTimeout(app, 3.0)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
              let elements = value as? [AXUIElement] else {
            throw AdapterError.notFound
        }
        if let index = axOccurrenceIndex(meta.id) {
            let candidates = elements.filter { matches($0, meta) }
            if candidates.indices.contains(index) {
                return store(candidates[index], meta: meta)
            }
        }
        let candidates = elements.filter { matches($0, meta) }
        guard !candidates.isEmpty else { throw AdapterError.notFound }
        guard candidates.count == 1 else { throw AdapterError.ambiguous }
        return store(candidates[0], meta: meta)
    }

    private func store(_ element: AXUIElement, meta: WindowMeta) -> AXUIElement {
        setMessagingTimeout(element, 1.5)
        records[meta.id] = Record(element: element, meta: meta)
        return element
    }

    /// Identity check: pid + role (+ AXWindowNumber↔cgWindowID when present).
    private func sameLogicalWindow(_ element: AXUIElement, _ meta: WindowMeta) -> Bool {
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success, pid == meta.pid else { return false }
        guard let role: String = Self.optionalRead(element, kAXRoleAttribute), role == meta.role, role == kAXWindowRole else {
            return false
        }
        if let expected = meta.cgWindowID, expected != 0 {
            let number: NSNumber? = Self.optionalRead(element, "AXWindowNumber")
            if let number { return number.uint32Value == expected }
        }
        return true
    }

    /// Broader match used when resolving a fresh element: identity plus
    /// window-number evidence, falling back to frame/title/subrole.
    private func matches(_ element: AXUIElement, _ meta: WindowMeta) -> Bool {
        guard sameLogicalWindow(element, meta) else { return false }
        if let expected = meta.cgWindowID, expected != 0 {
            let number: NSNumber? = Self.optionalRead(element, "AXWindowNumber")
            if let number { return number.uint32Value == expected }
        }
        guard let actualFrame = try? frame(of: element), actualFrame.approximatelyEquals(meta.frame) else {
            return false
        }
        let title: String? = Self.optionalRead(element, kAXTitleAttribute)
        let subrole: String? = Self.optionalRead(element, kAXSubroleAttribute)
        return title == meta.title && subrole == meta.subrole
    }

    private func axOccurrenceIndex(_ id: String) -> Int? {
        guard id.hasPrefix("window:ax:") else { return nil }
        return id.split(separator: ":").last.flatMap { Int($0) }
    }

    // MARK: Low-level AX helpers

    private func frame(of element: AXUIElement) throws -> Rect {
        var errors: [String] = []
        guard let rect = Self.readFrame(element, errors: &errors) else {
            throw AdapterError.notFound
        }
        return rect
    }

    fileprivate static func readFrame(_ element: AXUIElement, errors: inout [String]) -> Rect? {
        guard let positionValue: AXValue = optionalRead(element, kAXPositionAttribute),
              let sizeValue: AXValue = optionalRead(element, kAXSizeAttribute) else {
            return nil
        }
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &position),
              AXValueGetValue(sizeValue, .cgSize, &size) else {
            return nil
        }
        return Rect(x: position.x, y: position.y, width: size.width, height: size.height)
    }

    fileprivate static func optionalRead<T>(_ element: AXUIElement, _ attribute: String) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
            return nil
        }
        return value as? T
    }

    private func capabilityValue(movable: Bool?, resizable: Bool?) -> CapabilitiesValue {
        func state(_ reported: Bool?) -> String {
            switch reported {
            case .some(true): "supported"
            case .some(false): "fixed"
            case .none: "unknown"
            }
        }
        return CapabilitiesValue(
            movable: state(movable),
            resizable: state(resizable),
            movableEvidence: "platform_report",
            resizableEvidence: "platform_report")
    }
}
