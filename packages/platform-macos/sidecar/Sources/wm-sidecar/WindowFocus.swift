import AppKit
import ApplicationServices
import Foundation

/// Window AXFocused flags are app-local and can remain true in inactive apps.
/// Global focus comes only from the frontmost application's AXFocusedWindow.
enum WindowFocus {
    struct Snapshot: Equatable {
        var pid: Int32?
        var window: AXUIElement?

        static func == (lhs: Snapshot, rhs: Snapshot) -> Bool {
            guard lhs.pid == rhs.pid else { return false }
            switch (lhs.window, rhs.window) {
            case (nil, nil): return true
            case (let lhs?, let rhs?): return CFEqual(lhs, rhs)
            default: return false
            }
        }
    }

    static func focusedWindow(in application: AXUIElement) -> AXUIElement? {
        var value: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &value)
                == .success,
            let value, CFGetTypeID(value) == AXUIElementGetTypeID()
        else { return nil }
        return (value as! AXUIElement)
    }

    static func matches(
        _ window: AXUIElement,
        pid: Int32,
        frontmostPID: Int32?,
        focusedWindow: AXUIElement?
    ) -> Bool {
        guard pid == frontmostPID, let focusedWindow else { return false }
        return CFEqual(window, focusedWindow)
    }

    @MainActor
    static func current(timeout: CFTimeInterval = 1.5) -> Snapshot {
        guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier else {
            return Snapshot()
        }
        let application = AXUIElementCreateApplication(pid)
        setMessagingTimeout(application, timeout)
        return Snapshot(pid: pid, window: focusedWindow(in: application))
    }

    @MainActor
    static func isFocused(_ window: AXUIElement, pid: Int32, timeout: CFTimeInterval = 1.5) -> Bool? {
        guard pid == NSWorkspace.shared.frontmostApplication?.processIdentifier else { return false }
        let focus = current(timeout: timeout)
        guard focus.window != nil else { return nil }
        return matches(window, pid: pid, frontmostPID: focus.pid, focusedWindow: focus.window)
    }
}
