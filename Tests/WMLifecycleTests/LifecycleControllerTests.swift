import Foundation
import Testing
@testable import WMLifecycle

private actor LaunchdMock: LaunchdControlling {
    var bootstrapped = false
    var operations: [String] = []
    func isBootstrapped(label: String) -> Bool { bootstrapped }
    func bootstrap(plist: URL) { bootstrapped = true; operations.append("bootstrap") }
    func kickstart(label: String) { operations.append("kickstart") }
    func bootout(label: String) { bootstrapped = false; operations.append("bootout") }
    func diagnostics(label: String) -> String { "diagnostic" }
}

private actor DaemonMock: DaemonControlling {
    var pingResponses: [Bool]
    var shutdownResponse: Bool
    init(ping: [Bool] = [], shutdown: Bool = true) { pingResponses = ping; shutdownResponse = shutdown }
    func ping(endpoint: URL) -> Bool { pingResponses.isEmpty ? false : pingResponses.removeFirst() }
    func shutdown(endpoint: URL) -> Bool { shutdownResponse }
}

private actor LegacyDaemonMock: DaemonControlling {
    var running: Bool
    let stopsOnShutdown: Bool
    private(set) var shutdownRequests = 0

    init(running: Bool = true, stopsOnShutdown: Bool) {
        self.running = running
        self.stopsOnShutdown = stopsOnShutdown
    }

    func ping(endpoint: URL) -> Bool { running }
    func shutdown(endpoint: URL) -> Bool {
        shutdownRequests += 1
        if stopsOnShutdown { running = false }
        return true
    }
}

private actor ManualStarterMock: ManualDaemonStarting {
    private(set) var starts = 0
    func start() { starts += 1 }
}

private final class ProcessMock: ProcessControlling, @unchecked Sendable {
    private let lock = NSLock()
    var running: [Bool]
    var signals: [Int32] = []
    var stopAfterKill = false
    init(running: [Bool]) { self.running = running }
    func isRunning(_ owner: DaemonOwnership) -> Bool { lock.withLock {
        if stopAfterKill, signals.last == SIGKILL { return false }
        return running.count > 1 ? running.removeFirst() : running.first ?? false
    } }
    func signal(_ owner: DaemonOwnership, _ signal: Int32) { lock.withLock { signals.append(signal) } }
}

private func currentOwner(mode: DaemonMode = .manual) throws -> DaemonOwnership {
    .init(pid: getpid(), processStartIdentity: try processStartIdentity(pid: getpid()), mode: mode,
          endpoint: WMServiceIdentity.endpoint(), readyState: .ready)
}

private func fixture(ping: [Bool], running: [Bool] = []) throws -> (LifecycleController, LaunchdMock, ProcessMock, URL) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let plist = directory.appendingPathComponent("service.plist")
    FileManager.default.createFile(atPath: plist.path, contents: Data())
    let launchd = LaunchdMock(), process = ProcessMock(running: running)
    let controller = LifecycleController(
        launchd: launchd, daemon: DaemonMock(ping: ping), processes: process,
        metadata: .init(url: directory.appendingPathComponent("owner.json")), plist: plist,
        operationLockURL: directory.appendingPathComponent("lifecycle.lock"),
        timing: .init(startupTimeout: .milliseconds(100), gracefulTimeout: .milliseconds(10),
                      terminationTimeout: .milliseconds(10), pollInterval: .milliseconds(1))
    )
    return (controller, launchd, process, directory)
}

@Test func startBootstrapsKickstartsAndWaitsForReady() async throws {
    let (controller, launchd, _, directory) = try fixture(ping: [false, false, true])
    defer { try? FileManager.default.removeItem(at: directory) }
    #expect(try await controller.start() == .init(action: "start", changed: true))
    #expect(await launchd.operations == ["bootstrap", "kickstart"])
}

@Test func manualStartSpawnsWithoutLaunchdAndWaitsForReady() async throws {
    let (base, launchd, process, directory) = try fixture(ping: [])
    defer { try? FileManager.default.removeItem(at: directory) }
    let starter = ManualStarterMock()
    let controller = LifecycleController(
        launchd: launchd, daemon: DaemonMock(ping: [false, true]), processes: process,
        metadata: base.metadata, plist: base.plist, operationLockURL: base.operationLockURL,
        timing: base.timing, manualStarter: starter
    )
    #expect(try await controller.start(manual: true) == .init(action: "start", changed: true))
    #expect(await starter.starts == 1)
    #expect(await launchd.operations.isEmpty)
}

@Test func manualStartIsIdempotentForHealthyOwner() async throws {
    let (base, launchd, process, directory) = try fixture(ping: [], running: [true])
    defer { try? FileManager.default.removeItem(at: directory) }
    try base.metadata.write(currentOwner())
    let starter = ManualStarterMock()
    let controller = LifecycleController(
        launchd: launchd, daemon: LegacyDaemonMock(running: true, stopsOnShutdown: false), processes: process,
        metadata: base.metadata, plist: base.plist, operationLockURL: base.operationLockURL,
        timing: base.timing, manualStarter: starter
    )
    #expect(try await controller.start(manual: true) == .init(action: "start", changed: false))
    #expect(await starter.starts == 0)
    #expect(await launchd.operations.isEmpty)
}

@Test func missingServiceIsStructuredFailure() async throws {
    let (controller, _, _, directory) = try fixture(ping: [])
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.removeItem(at: controller.plist)
    await #expect(throws: LifecycleFailure.serviceNotInstalled) { try await controller.start() }
}

@Test func stoppedStopIsIdempotent() async throws {
    let (controller, _, _, directory) = try fixture(ping: [])
    defer { try? FileManager.default.removeItem(at: directory) }
    #expect(try await controller.stop(force: false) == .init(action: "stop", changed: false))
}

@Test func stopGracefullyStopsReachableLegacyDaemonWithoutMetadata() async throws {
    let (base, launchd, process, directory) = try fixture(ping: [])
    defer { try? FileManager.default.removeItem(at: directory) }
    let daemon = LegacyDaemonMock(stopsOnShutdown: true)
    let controller = LifecycleController(
        launchd: launchd, daemon: daemon, processes: process, metadata: base.metadata,
        plist: base.plist, operationLockURL: base.operationLockURL,
        timing: base.timing, sleep: { _ in }
    )
    let result = try await controller.stop(force: false)
    #expect(result.changed)
    #expect(!result.forced)
    #expect(result.warnings.first?.contains("legacy daemon") == true)
    #expect(await daemon.shutdownRequests == 1)
}

@Test func forceStopRefusesToSignalReachableLegacyDaemonWithoutMetadata() async throws {
    let (base, launchd, process, directory) = try fixture(ping: [])
    defer { try? FileManager.default.removeItem(at: directory) }
    let daemon = LegacyDaemonMock(stopsOnShutdown: false)
    let controller = LifecycleController(
        launchd: launchd, daemon: daemon, processes: process, metadata: base.metadata,
        plist: base.plist, operationLockURL: base.operationLockURL,
        timing: base.timing, sleep: { _ in }
    )
    await #expect(throws: LifecycleFailure.ownershipMetadataMissing) {
        try await controller.stop(force: true)
    }
    #expect(process.signals.isEmpty)
}

@Test func ownershipMetadataRoundTripsAndRejectsReusedPIDIdentity() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = OwnershipMetadataStore(url: directory.appendingPathComponent("owner.json"))
    let owner = DaemonOwnership(pid: getpid(), processStartIdentity: try processStartIdentity(pid: getpid()),
                                mode: .manual, endpoint: WMServiceIdentity.endpoint(), readyState: .ready)
    try store.write(owner)
    #expect(try store.readVerified() == owner)
    var stale = owner
    stale.processStartIdentity += 1
    try store.write(stale)
    #expect(try store.readVerified() == nil)
    #expect(!FileManager.default.fileExists(atPath: store.url.path))
}

@Test func lifecycleLockFailsImmediatelyWhenAlreadyHeld() async throws {
    let (controller, _, _, directory) = try fixture(ping: [])
    defer { try? FileManager.default.removeItem(at: directory) }
    let held = try OperationLock(url: controller.operationLockURL)
    _ = held
    await #expect(throws: LifecycleFailure.lifecycleBusy) { try await controller.start() }
}

@Test func startupTimeoutLeavesLaunchdBootstrappedAndIncludesDiagnostics() async throws {
    let (controller, launchd, _, directory) = try fixture(ping: [])
    defer { try? FileManager.default.removeItem(at: directory) }
    await #expect(throws: LifecycleFailure.startupTimeout("diagnostic")) { try await controller.start() }
    #expect(await launchd.bootstrapped)
    #expect(await launchd.operations == ["bootstrap", "kickstart"])
}

@Test func deterministicStartupFailureReplacesLaunchdDiagnostics() async throws {
    let (base, launchd, process, directory) = try fixture(ping: [])
    defer { try? FileManager.default.removeItem(at: directory) }
    let expected = LifecycleFailure.permissionDenied("Enable Accessibility, then try again.")
    let controller = LifecycleController(
        launchd: launchd, daemon: base.daemon, processes: process, metadata: base.metadata,
        plist: base.plist, operationLockURL: base.operationLockURL, timing: base.timing,
        startupFailure: { expected }
    )
    await #expect(throws: expected) { try await controller.start() }
}

@Test func manualOwnerMustStopBeforeLaunchdStarts() async throws {
    let (controller, launchd, _, directory) = try fixture(ping: [], running: [true, true])
    defer { try? FileManager.default.removeItem(at: directory) }
    try controller.metadata.write(currentOwner())
    await #expect(throws: LifecycleFailure.gracefulTimeout) { try await controller.start() }
    #expect(await launchd.operations.isEmpty)
}

@Test func forceStopBootsOutServiceThenEscalatesToKill() async throws {
    let (controller, launchd, process, directory) = try fixture(
        ping: [], running: Array(repeating: true, count: 40)
    )
    defer { try? FileManager.default.removeItem(at: directory) }
    await launchd.bootstrap(plist: controller.plist)
    process.stopAfterKill = true
    try controller.metadata.write(currentOwner(mode: .service))
    let result = try await controller.stop(force: true)
    #expect(result.forced)
    #expect(result.escalation == ["bootout", "sigterm", "sigkill"])
    #expect(process.signals == [SIGTERM, SIGKILL])
}

private func serviceFixture(
    activeUser: uid_t? = geteuid(), remove: @escaping @Sendable (URL) throws -> Void = {
        try FileManager.default.removeItem(at: $0)
    }
) throws -> (ServiceInstaller, LaunchdMock, ProcessMock, URL) {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let plist = WMServiceIdentity.plistURL(homeDirectory: home)
    let executable = home.appendingPathComponent("bin/wm")
    try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: executable.path, contents: Data("binary".utf8), attributes: [.posixPermissions: 0o700])
    let launchd = LaunchdMock(), process = ProcessMock(running: [])
    return (ServiceInstaller(
        launchd: launchd, processes: process,
        metadata: .init(url: home.appendingPathComponent("state/owner.json")), plist: plist,
        operationLockURL: home.appendingPathComponent("state/lifecycle.lock"), executable: executable,
        logs: home.appendingPathComponent("state/logs"), activeGUIUser: { activeUser }, removeItem: remove
    ), launchd, process, home)
}

@Test func installWritesSafePlistAndBootstrapsWithoutStarting() async throws {
    let (installer, launchd, _, home) = try serviceFixture()
    defer { try? FileManager.default.removeItem(at: home) }
    #expect(try await installer.install() == .init(action: "install", changed: true))
    #expect(await launchd.operations == ["bootstrap"])
    let attributes = try FileManager.default.attributesOfItem(atPath: installer.plist.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    let data = try Data(contentsOf: installer.plist)
    let plist = try #require(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    #expect(plist["Label"] as? String == WMServiceIdentity.label)
    #expect(plist["RunAtLoad"] as? Bool == false)
    #expect((plist["KeepAlive"] as? [String: Bool])?["SuccessfulExit"] == false)
    #expect(plist["ThrottleInterval"] as? Int == 10)
    #expect((plist["ProgramArguments"] as? [String])?.last == "daemon")
}

@Test func installAcceptsStandardLaunchAgentsModeAndWarnsWithoutChangingIt() async throws {
    let (installer, _, _, home) = try serviceFixture()
    defer { try? FileManager.default.removeItem(at: home) }
    let directory = installer.plist.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: directory.path)
    let result = try await installer.install()
    #expect(result.warnings.count == 1)
    #expect(result.warnings[0].contains("mode 755"))
    let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o755)
}

@Test func installRejectsGroupOrWorldWritableLaunchAgentsDirectory() async throws {
    for mode in [0o720, 0o702, 0o777] {
        let (installer, _, _, home) = try serviceFixture()
        defer { try? FileManager.default.removeItem(at: home) }
        let directory = installer.plist.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: directory.path)
        await #expect(throws: LifecycleFailure.unsafeServiceFile) { try await installer.install() }
    }
}

@Test func installRejectsExistingServiceAndInactiveGUIUser() async throws {
    let (installer, _, _, home) = try serviceFixture()
    defer { try? FileManager.default.removeItem(at: home) }
    _ = try await installer.install()
    await #expect(throws: LifecycleFailure.serviceAlreadyInstalled) { try await installer.install() }
    let (inactive, _, _, otherHome) = try serviceFixture(activeUser: nil)
    defer { try? FileManager.default.removeItem(at: otherHome) }
    await #expect(throws: LifecycleFailure.activeSessionRequired) { try await inactive.install() }
}

@Test func uninstallBootsOutInactiveServiceAndRemovesPlist() async throws {
    let (installer, launchd, _, home) = try serviceFixture()
    defer { try? FileManager.default.removeItem(at: home) }
    _ = try await installer.install()
    #expect(try await installer.uninstall() == .init(action: "uninstall", changed: true))
    #expect(await launchd.operations == ["bootstrap", "bootout"])
    #expect(!FileManager.default.fileExists(atPath: installer.plist.path))
}

@Test func uninstallRefusesRunningServiceWithActionableMessage() async throws {
    let (installer, _, process, home) = try serviceFixture()
    defer { try? FileManager.default.removeItem(at: home) }
    _ = try await installer.install()
    process.running = [true]
    try installer.metadata.write(currentOwner(mode: .service))
    await #expect(throws: LifecycleFailure.serviceRunning) { try await installer.uninstall() }
    #expect(LifecycleFailure.serviceRunning.message.contains("Use `wm stop`"))
    #expect(LifecycleFailure.serviceRunning.message.contains("`wm uninstall` again"))
}

@Test func uninstallReportsPartialRemovalAfterBootout() async throws {
    let (installer, launchd, _, home) = try serviceFixture(remove: { _ in throw CocoaError(.fileWriteNoPermission) })
    defer { try? FileManager.default.removeItem(at: home) }
    _ = try await installer.install()
    do {
        _ = try await installer.uninstall()
        Issue.record("expected partial uninstall")
    } catch let failure as LifecycleFailure {
        #expect(failure.code == "partial_uninstall")
    }
    #expect(await launchd.operations == ["bootstrap", "bootout"])
}

@Test func uninstallRemovesMalformedExistingServiceFile() async throws {
    let (installer, launchd, _, home) = try serviceFixture()
    defer { try? FileManager.default.removeItem(at: home) }
    try FileManager.default.createDirectory(at: installer.plist.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("not a plist".utf8).write(to: installer.plist)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: installer.plist.path)
    #expect(try await installer.uninstall() == .init(action: "uninstall", changed: true))
    #expect(await launchd.operations.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: installer.plist.path))
}
