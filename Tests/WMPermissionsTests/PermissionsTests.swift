import Foundation
import Testing
@testable import WMPermissions

private final class PermissionState: @unchecked Sendable {
    private let lock = NSLock()
    private var granted: Set<WMPermission>
    private(set) var requested: [WMPermission] = []
    private(set) var opened: [URL] = []

    init(granted: Set<WMPermission> = []) { self.granted = granted }
    func contains(_ permission: WMPermission) -> Bool { lock.withLock { granted.contains(permission) } }
    func request(_ permission: WMPermission) { lock.withLock { requested.append(permission) } }
    func open(_ url: URL) { lock.withLock { opened.append(url) } }
    func grantNext() { lock.withLock {
        if let permission = requested.last { granted.insert(permission) }
    } }
}

@Test func permissionMetadataIsActionable() {
    for permission in WMPermission.allCases {
        #expect(!permission.reason.isEmpty)
        #expect(permission.instructions.contains("System Settings > Privacy & Security"))
        #expect(permission.settingsURL.scheme == "x-apple.systempreferences")
    }
}

@Test func requestMissingAdvancesSequentially() async {
    let state = PermissionState()
    let controller = PermissionController(
        isGranted: { state.contains($0) }, request: { state.request($0) }, openSettings: { state.open($0) },
        sleep: { _ in state.grantNext() }
    )
    #expect(await controller.requestMissing(timeout: .seconds(1), progress: { _, _ in }))
    #expect(state.requested == [.accessibility, .screenRecording])
    #expect(state.opened.count == 2)
    #expect(controller.statuses().allSatisfy { $0.granted })
}

@Test func missingMessageNamesSettingsAndFollowUp() {
    let message = missingPermissionMessage([
        .init(permission: .accessibility, granted: false),
        .init(permission: .screenRecording, granted: true),
    ])
    #expect(message.contains("Accessibility"))
    #expect(message.contains("System Settings > Privacy & Security > Accessibility"))
    #expect(message.contains("wm permissions request"))
    #expect(message.contains("wm start"))
}
