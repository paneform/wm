import ApplicationServices
import AppKit
import Foundation

public struct AXWindowGeometryAdapter: WindowGeometryAdapter, @unchecked Sendable {
    private final class Storage: @unchecked Sendable {
        let lock = NSLock()
        var elements: [String: AXUIElement] = [:]
        var handlesByWindowID: [String: WindowGeometryHandle] = [:]
    }

    private let storage = Storage()
    private let delayDuration: Duration

    public init(delayDuration: Duration = .milliseconds(25)) {
        self.delayDuration = delayDuration
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
                    storage.elements.removeValue(forKey: handle.rawValue)
                }
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
                    storage.elements.removeValue(forKey: retained.rawValue)
                }
                if let adapterError = error as? WindowGeometryAdapterError, adapterError == .stale { throw adapterError }
                throw WindowGeometryAdapterError.notFound
            }
        }
        let app = AXUIElementCreateApplication(window.pid)
        let elements: [AXUIElement] = try copy(app, kAXWindowsAttribute)
        let candidates = elements.filter { matches($0, window) }
        guard !candidates.isEmpty else { throw WindowGeometryAdapterError.notFound }
        guard candidates.count == 1 else { throw WindowGeometryAdapterError.ambiguous }
        let handle = WindowGeometryHandle(rawValue: UUID().uuidString)
        storage.lock.withLock {
            storage.elements[handle.rawValue] = candidates[0]
            storage.handlesByWindowID[window.id] = handle
        }
        return handle
    }

    public func validateControllability(of handle: WindowGeometryHandle) async throws {
        let element = try element(for: handle)
        guard try isSettable(element, kAXPositionAttribute), try isSettable(element, kAXSizeAttribute) else {
            throw WindowGeometryAdapterError.notControllable
        }
        _ = try frame(element)
    }

    public func readFrame(of handle: WindowGeometryHandle) async throws -> InventoryRect {
        try frame(element(for: handle))
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
