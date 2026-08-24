import AppKit
@preconcurrency import ApplicationServices

enum Permissions {
    static var accessibilityGranted: Bool { AXIsProcessTrusted() }

    /// Degraded screen recording reduces CG metadata (titles, off-process
    /// names) but never kills the CG source.
    static var screenRecordingGranted: Bool { CGPreflightScreenCaptureAccess() }

    /// Snapshot for wire responses.
    static var current: PermissionsValue {
        PermissionsValue(
            accessibility: accessibilityGranted,
            screenRecording: screenRecordingGranted)
    }

    /// Triggers the TCC Accessibility prompt if not yet trusted. MUST run in
    /// this executable so macOS attributes the request to wm-sidecar.
    /// Idempotent: returns immediately when already trusted.
    static func requestAccessibility() -> Bool {
        AXIsProcessTrustedWithOptions([
            kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true,
        ] as CFDictionary)
    }

    /// Triggers the Screen Recording prompt if not yet granted.
    static func requestScreenRecording() -> Bool {
        CGRequestScreenCaptureAccess()
    }

    /// Deep link into a System Settings privacy pane. Explicitly bounded to
    /// the two panes this product cares about; never mutates windows.
    static func openSettings(target: String) -> Bool {
        let pane: String
        switch target {
        case "accessibility": pane = "Privacy_Accessibility"
        case "screenRecording": pane = "Privacy_ScreenCapture"
        default: return false
        }
        guard let url = URL(string:
            "x-apple.systempreferences:com.apple.preference.security?\(pane)") else { return false }
        NSWorkspace.shared.open(url)
        return true
    }
}
