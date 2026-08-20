import ApplicationServices
import AppKit
import Foundation
import WMProtocol

public struct AXWindowGeometryAdapter: WindowGeometryAdapter, @unchecked Sendable {
    private final class Storage: @unchecked Sendable {
        let lock = NSLock()
        var elements: [String: AXUIElement] = [:]
        var handlesByWindowID: [String: WindowGeometryHandle] = [:]
        var lifetimesByWindowID: [String: WindowLifetime] = [:]
    }


    private let storage = Storage()
    private let delayDuration: Duration
    private let settlementInterval: Duration

    public init(delayDuration: Duration = .milliseconds(25), settlementInterval: Duration = .milliseconds(17)) {
        self.delayDuration = delayDuration
        self.settlementInterval = settlementInterval
    }

    public func reconcile(windows: [NormalizedWindow]) async {
        let windowsByID = Dictionary(uniqueKeysWithValues: windows.map { ($0.id, $0) })
        let retained = storage.lock.withLock { storage.handlesByWindowID }
        for (windowID, handle) in retained {
            guard let window = windowsByID[windowID],
                   let element = storage.lock.withLock({ storage.elements[handle.rawValue] }) else { continue }
            if !isSameLogicalWindow(element, window) || (try? frame(element)) == nil {
                storage.lock.withLock {
                    storage.handlesByWindowID.removeValue(forKey: windowID)
                    storage.lifetimesByWindowID.removeValue(forKey: windowID)
                    storage.elements.removeValue(forKey: handle.rawValue)
                }
            }
        }
    }

    public func evict(lifetimes: Set<WindowLifetime>) async {
        storage.lock.withLock {
            for lifetime in lifetimes where storage.lifetimesByWindowID[lifetime.windowID] == lifetime {
                guard let handle = storage.handlesByWindowID.removeValue(forKey: lifetime.windowID) else { continue }
                storage.lifetimesByWindowID.removeValue(forKey: lifetime.windowID)
                storage.elements.removeValue(forKey: handle.rawValue)
            }
        }
    }

    public func resolve(_ window: NormalizedWindow) async throws -> WindowGeometryHandle {
        guard AXIsProcessTrusted() else { throw WindowGeometryAdapterError.notControllable }
        if let retained = storage.lock.withLock({ storage.handlesByWindowID[window.id] }) {
            do {
                let element = try element(for: retained)
                guard isSameLogicalWindow(element, window) else { throw WindowGeometryAdapterError.stale }
                _ = try frame(element)
                return retained
            } catch {
                storage.lock.withLock {
                    storage.handlesByWindowID.removeValue(forKey: window.id)
                    storage.lifetimesByWindowID.removeValue(forKey: window.id)
                    storage.elements.removeValue(forKey: retained.rawValue)
                }
                if let adapterError = error as? WindowGeometryAdapterError, adapterError == .stale { throw adapterError }
                throw WindowGeometryAdapterError.notFound
            }
        }
        let app = AXUIElementCreateApplication(window.pid)
        let elements: [AXUIElement] = try copy(app, kAXWindowsAttribute)
        if let index = axWindowIndex(window.id) {
            let candidates = elements.filter { matches($0, window) }
            if candidates.indices.contains(index) {
                return store(candidates[index], for: window)
            }
        }
        let candidates = elements.filter { matches($0, window) }
        guard !candidates.isEmpty else { throw WindowGeometryAdapterError.notFound }
        guard candidates.count == 1 else { throw WindowGeometryAdapterError.ambiguous }
        return store(candidates[0], for: window)
    }

    private func store(_ element: AXUIElement, for window: NormalizedWindow) -> WindowGeometryHandle {
        let handle = WindowGeometryHandle(rawValue: UUID().uuidString)
        storage.lock.withLock {
            storage.elements[handle.rawValue] = element
            storage.handlesByWindowID[window.id] = handle
            storage.lifetimesByWindowID[window.id] = .init(windowID: window.id, pid: window.pid)
        }
        return handle
    }

    private func axWindowIndex(_ id: String) -> Int? {
        guard id.hasPrefix("window:ax:") else { return nil }
        return id.split(separator: ":").last.flatMap { Int($0) }
    }

    public func validateControllability(of handle: WindowGeometryHandle) async throws {
        let element = try element(for: handle)
        guard try isSettable(element, kAXPositionAttribute), try isSettable(element, kAXSizeAttribute) else {
            throw WindowGeometryAdapterError.notControllable
        }
        _ = try frame(element)
    }

    public func validateIdentity(of handle: WindowGeometryHandle, expected window: NormalizedWindow) async throws {
        guard isSameLogicalWindow(try element(for: handle), window) else { throw WindowGeometryAdapterError.stale }
    }

    public func readFrame(of handle: WindowGeometryHandle) async throws -> InventoryRect {
        try frame(element(for: handle))
    }

    public func rawFrame(_ window: NormalizedWindow) async throws -> InventoryRect {
        try await readFrame(of: resolve(window))
    }

    public func rawSetFrame(
        _ frame: InventoryRect,
        of window: NormalizedWindow,
        order: DebugAXWriteOrder,
        settleMilliseconds: Int = 0
    ) async throws -> InventoryRect {
        let handle = try await resolve(window)
        let element = try element(for: handle)
        switch order {
        case .position: try setPosition(frame, element: element)
        case .size: try setSize(frame, element: element)
        case .positionThenSize:
            try setPosition(frame, element: element)
            try setSize(frame, element: element)
        case .sizeThenPosition:
            try setSize(frame, element: element)
            try setPosition(frame, element: element)
        case .sizePositionSize:
            try setSize(frame, element: element)
            try setPosition(frame, element: element)
            try setSize(frame, element: element)
        }
        if settleMilliseconds > 0 { try await Task.sleep(for: .milliseconds(settleMilliseconds)) }
        return try self.frame(element)
    }

    public func write(_ component: WindowGeometryComponent, frame: InventoryRect, to handle: WindowGeometryHandle) async throws {
        let element = try element(for: handle)
        let result: AXError
        switch component {
        case .position:
            var point = CGPoint(x: frame.x, y: frame.y)
            guard let value = AXValueCreate(.cgPoint, &point) else { throw WindowGeometryAdapterError.rejected }
            result = AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, value)
        case .size:
            var size = CGSize(width: frame.width, height: frame.height)
            guard let value = AXValueCreate(.cgSize, &size) else { throw WindowGeometryAdapterError.rejected }
            result = AXUIElementSetAttributeValue(element, kAXSizeAttribute as CFString, value)
        }
        guard result == .success else { throw WindowGeometryAdapterError.rejected }
    }

    public func delay() async throws { try await Task.sleep(for: delayDuration) }

    public func settle(
        _ handle: WindowGeometryHandle, requested: InventoryRect, tolerance: Double
    ) async throws -> WindowGeometrySettlement {
        let element = try element(for: handle)
        var reads = 0
        var targetSamples = 0
        var stableSamples = 0
        var previous: InventoryRect?
        var previousDistance = Double.infinity
        for _ in 0..<36 {
            let observed = try frame(element)
            reads += 1
            let matches = observed.approximatelyEquals(requested, tolerance: tolerance)
            targetSamples = matches ? targetSamples + 1 : 0
            stableSamples = previous?.approximatelyEquals(observed, tolerance: 0.5) == true ? stableSamples + 1 : 0
            let distance = observed.normalizedDistance(to: requested)
            if targetSamples >= 3 || stableSamples >= 3 && distance >= previousDistance - 0.0001 {
                return .init(frame: observed, reads: reads)
            }
            previous = observed
            previousDistance = distance
            try await Task.sleep(for: settlementInterval)
        }
        return .init(frame: try frame(element), reads: reads + 1)
    }

    public func transact(
        _ transaction: WindowGeometryTransaction, frame: InventoryRect,
        handle: WindowGeometryHandle
    ) async throws {
        let element = try element(for: handle)
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success else { throw WindowGeometryAdapterError.stale }
        let app = AXUIElementCreateApplication(pid)
        let enhanced: Bool? = try? copy(app, "AXEnhancedUserInterface")
        if enhanced == true {
            _ = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse)
        }
        defer {
            if enhanced == true {
                _ = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
            }
        }
        switch transaction {
        case .positionSize:
            try setPosition(frame, element: element)
            try setSize(frame, element: element)
        case .sizeOnly:
            try setSize(frame, element: element)
        case .sizePositionSize:
            try setSize(frame, element: element)
            try setPosition(frame, element: element)
            try setSize(frame, element: element)
        }
    }

    public func focus(_ handle: WindowGeometryHandle) async throws {
        let element = try element(for: handle)
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success else { throw WindowGeometryAdapterError.stale }
        guard let runningApplication = NSRunningApplication(processIdentifier: pid),
              runningApplication.activate(options: [.activateAllWindows]) else {
            throw WindowGeometryAdapterError.rejected
        }
        let app = AXUIElementCreateApplication(pid)
        guard AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue) == .success,
              AXUIElementPerformAction(element, kAXRaiseAction as CFString) == .success,
              AXUIElementSetAttributeValue(element, kAXMainAttribute as CFString, kCFBooleanTrue) == .success,
              AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else {
            throw WindowGeometryAdapterError.rejected
        }
    }

    public func isFocused(_ handle: WindowGeometryHandle) async throws -> Bool {
        let element = try element(for: handle)
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success else { throw WindowGeometryAdapterError.stale }
        return NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
    }

    public func fit(_ handle: WindowGeometryHandle, within frame: InventoryRect) async throws {
        let element = try element(for: handle)
        var point = CGPoint(x: frame.x, y: frame.y)
        guard let position = AXValueCreate(.cgPoint, &point),
              AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, position) == .success,
              AXUIElementPerformAction(element, "AXZoomWindow" as CFString) == .success else {
            throw WindowGeometryAdapterError.rejected
        }
        try await delay()
    }


    private func matches(_ element: AXUIElement, _ window: NormalizedWindow) -> Bool {
        guard isSameLogicalWindow(element, window) else { return false }
        if let expected = window.cgWindowID, expected != 0 {
            let number: NSNumber? = try? copy(element, "AXWindowNumber")
            if let number { return number.uint32Value == expected }
        }
        guard let expectedFrame = window.frame, let actualFrame = try? frame(element), actualFrame.approximatelyEquals(expectedFrame) else { return false }
        let title: String? = try? copy(element, kAXTitleAttribute)
        let subrole: String? = try? copy(element, kAXSubroleAttribute)
        return title == window.title && subrole == window.subrole
    }

    private func isSameLogicalWindow(_ element: AXUIElement, _ window: NormalizedWindow) -> Bool {
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success, pid == window.pid else { return false }
        let role: String? = try? copy(element, kAXRoleAttribute)
        guard role == window.role, role == kAXWindowRole else { return false }
        if let expected = window.cgWindowID, expected != 0 {
            let number: NSNumber? = try? copy(element, "AXWindowNumber")
            if let number { return number.uint32Value == expected }
        }
        return true
    }

    private func element(for handle: WindowGeometryHandle) throws -> AXUIElement {
        guard let element = storage.lock.withLock({ storage.elements[handle.rawValue] }) else { throw WindowGeometryAdapterError.stale }
        return element
    }

    private func frame(_ element: AXUIElement) throws -> InventoryRect {
        let positionValue: AXValue = try copy(element, kAXPositionAttribute)
        let sizeValue: AXValue = try copy(element, kAXSizeAttribute)
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &position), AXValueGetValue(sizeValue, .cgSize, &size) else {
            throw WindowGeometryAdapterError.readFailed
        }
        return InventoryRect(x: position.x, y: position.y, width: size.width, height: size.height)
    }

    private func setPosition(_ frame: InventoryRect, element: AXUIElement) throws {
        var point = CGPoint(x: frame.x, y: frame.y)
        guard let value = AXValueCreate(.cgPoint, &point),
              AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, value) == .success else {
            throw WindowGeometryAdapterError.rejected
        }
    }

    private func setSize(_ frame: InventoryRect, element: AXUIElement) throws {
        var size = CGSize(width: frame.width, height: frame.height)
        guard let value = AXValueCreate(.cgSize, &size),
              AXUIElementSetAttributeValue(element, kAXSizeAttribute as CFString, value) == .success else {
            throw WindowGeometryAdapterError.rejected
        }
    }

    private func copy<T>(_ element: AXUIElement, _ attribute: String) throws -> T {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success, let typed = value as? T else {
            throw WindowGeometryAdapterError.readFailed
        }
        return typed
    }

    private func isSettable(_ element: AXUIElement, _ attribute: String) throws -> Bool {
        var settable = DarwinBoolean(false)
        let result = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable)
        guard result == .success else { throw WindowGeometryAdapterError.notControllable }
        return settable.boolValue
    }
}

extension InventoryRect {
    func normalizedDistance(to target: Self) -> Double {
        abs(x - target.x) / max(1, target.width)
            + abs(y - target.y) / max(1, target.height)
            + abs(width - target.width) / max(1, target.width)
            + abs(height - target.height) / max(1, target.height)
    }
}
