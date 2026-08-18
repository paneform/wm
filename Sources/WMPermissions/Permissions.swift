import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

public enum WMPermission: String, CaseIterable, Sendable {
    case accessibility
    case screenRecording = "screen_recording"

    public var name: String {
        switch self {
        case .accessibility: "Accessibility"
        case .screenRecording: "Screen & System Audio Recording"
        }
    }

    public var reason: String {
        switch self {
        case .accessibility: "Required to focus, move, and resize application windows."
        case .screenRecording: "Required to identify windows reliably using titles and cross-process window metadata."
        }
    }

    public var instructions: String {
        "Open System Settings > Privacy & Security > \(name), add wm if needed, and enable it."
    }

    public var settingsURL: URL {
        let anchor = self == .accessibility ? "Privacy_Accessibility" : "Privacy_ScreenCapture"
        return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)")!
    }
}

public struct WMPermissionStatus: Equatable, Sendable {
    public var permission: WMPermission
    public var granted: Bool

    public init(permission: WMPermission, granted: Bool) {
        self.permission = permission
        self.granted = granted
    }
}

public struct PermissionController: Sendable {
    public let isGranted: @Sendable (WMPermission) -> Bool
    public let request: @Sendable (WMPermission) -> Void
    public let openSettings: @Sendable (URL) -> Void
    public let sleep: @Sendable (Duration) async throws -> Void

    public init(
        isGranted: @escaping @Sendable (WMPermission) -> Bool = systemPermissionGranted,
        request: @escaping @Sendable (WMPermission) -> Void = requestSystemPermission,
        openSettings: @escaping @Sendable (URL) -> Void = { url in
            Task { @MainActor in NSWorkspace.shared.open(url) }
        },
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.isGranted = isGranted
        self.request = request
        self.openSettings = openSettings
        self.sleep = sleep
    }

    public func statuses() -> [WMPermissionStatus] {
        WMPermission.allCases.map { .init(permission: $0, granted: isGranted($0)) }
    }

    public func requestMissing(
        timeout: Duration = .seconds(120),
        progress: @escaping @Sendable ([WMPermissionStatus], WMPermission?) -> Void
    ) async -> Bool {
        for permission in WMPermission.allCases where !isGranted(permission) {
            request(permission)
            openSettings(permission.settingsURL)
            progress(statuses(), permission)
            guard await waitForGrant(permission, timeout: timeout) else {
                progress(statuses(), permission)
                return false
            }
            progress(statuses(), nil)
        }
        progress(statuses(), nil)
        return statuses().allSatisfy(\.granted)
    }

    private func waitForGrant(_ permission: WMPermission, timeout: Duration) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while clock.now < deadline {
            if isGranted(permission) { return true }
            try? await sleep(.milliseconds(500))
        }
        return isGranted(permission)
    }
}

public func systemPermissionGranted(_ permission: WMPermission) -> Bool {
    switch permission {
    case .accessibility: AXIsProcessTrusted()
    case .screenRecording: CGPreflightScreenCaptureAccess()
    }
}

public func requestSystemPermission(_ permission: WMPermission) {
    switch permission {
    case .accessibility:
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    case .screenRecording:
        _ = CGRequestScreenCaptureAccess()
    }
}

public func missingPermissionMessage(_ statuses: [WMPermissionStatus]) -> String {
    let missing = statuses.filter { !$0.granted }
    guard !missing.isEmpty else { return "All required permissions are granted." }
    let details = missing.map { "\($0.permission.name): \($0.permission.instructions)" }.joined(separator: " ")
    return "wm cannot start because required permissions are missing. \(details) Run `wm permissions request` for guided setup, then try `wm start` again."
}
