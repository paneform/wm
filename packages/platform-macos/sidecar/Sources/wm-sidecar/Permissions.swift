import AppKit
import ApplicationServices

enum Permissions {
    static var accessibilityGranted: Bool { AXIsProcessTrusted() }

    /// Degraded screen recording reduces CG metadata (titles, off-process
    /// names) but never kills the CG source.
    static var screenRecordingGranted: Bool { CGPreflightScreenCaptureAccess() }
}
