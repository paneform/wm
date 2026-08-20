import Darwin
import Foundation
import WMProtocol
import WMWebSocket

public struct LifecycleTiming: Sendable {
    public var startupTimeout: Duration
    public var gracefulTimeout: Duration
    public var terminationTimeout: Duration
    public var pollInterval: Duration

    public init(startupTimeout: Duration = .seconds(15), gracefulTimeout: Duration = .seconds(5),
                terminationTimeout: Duration = .seconds(2), pollInterval: Duration = .milliseconds(100)) {
        self.startupTimeout = startupTimeout
        self.gracefulTimeout = gracefulTimeout
        self.terminationTimeout = terminationTimeout
        self.pollInterval = pollInterval
    }
}

public protocol LaunchdControlling: Sendable {
    func isBootstrapped(label: String) async -> Bool
    func bootstrap(plist: URL) async throws
    func kickstart(label: String) async throws
    func bootout(label: String) async throws
    func diagnostics(label: String) async -> String
}

public protocol DaemonControlling: Sendable {
    func ping(endpoint: URL) async -> Bool
    func shutdown(endpoint: URL) async -> Bool
}

public protocol ProcessControlling: Sendable {
    func isRunning(_ owner: DaemonOwnership) -> Bool
    func signal(_ owner: DaemonOwnership, _ signal: Int32) throws
}

public protocol ManualDaemonStarting: Sendable {
    func start() async throws
}

public struct LifecycleResult: Equatable, Sendable {
    public var action: String
    public var changed: Bool
    public var forced: Bool
    public var escalation: [String]
    public var warnings: [String]

    public init(action: String, changed: Bool, forced: Bool = false, escalation: [String] = [], warnings: [String] = []) {
        self.action = action; self.changed = changed; self.forced = forced
        self.escalation = escalation; self.warnings = warnings
    }
}

public enum LifecycleFailure: Error, Equatable, Sendable {
    case lifecycleBusy
    case serviceAlreadyInstalled
    case serviceNotInstalled
    case serviceRunning
    case activeSessionRequired
    case unsafeServiceFile
    case partialUninstall(String)
    case ownershipMetadataMissing
    case permissionDenied(String)
    case gracefulTimeout
    case startupTimeout(String)
    case operationFailed(String)

    public var code: String {
        switch self {
        case .lifecycleBusy: "lifecycle_busy"
        case .serviceAlreadyInstalled: "service_already_installed"
        case .serviceNotInstalled: "service_not_installed"
        case .serviceRunning: "service_running"
        case .activeSessionRequired: "active_session_required"
        case .unsafeServiceFile: "unsafe_service_file"
        case .partialUninstall: "partial_uninstall"
        case .ownershipMetadataMissing: "ownership_metadata_missing"
        case .permissionDenied: "permission_denied"
        case .gracefulTimeout: "graceful_shutdown_timeout"
        case .startupTimeout: "startup_timeout"
        case .operationFailed: "lifecycle_failed"
        }
    }

    public var message: String {
        switch self {
        case .lifecycleBusy: "Another wm lifecycle command is running. Wait for it to finish, then try again."
        case .serviceAlreadyInstalled: "The wm service is already installed. Use `wm uninstall` first if you need to reinstall it."
        case .serviceNotInstalled: "The wm service is not installed. Use `wm install`, then try again."
        case .serviceRunning: "The wm service cannot be uninstalled because it is currently running. Use `wm stop` to stop it first, then try `wm uninstall` again."
        case .activeSessionRequired: "The wm service can only be installed from the active macOS GUI session. Log in to that session, then try `wm install` again."
        case .unsafeServiceFile: "The wm service file is unsafe or invalid. Use `wm uninstall` to remove it before trying `wm install` again."
        case .partialUninstall(let path): "The wm service was unloaded, but its file could not be removed at \(path). Remove it, then try `wm uninstall` again."
        case .ownershipMetadataMissing: "The running wm daemon has no verified ownership metadata, so it cannot be force-stopped safely. Stop the legacy daemon manually, then use `wm start` to replace it."
        case .permissionDenied(let message): message
        case .gracefulTimeout: "daemon did not stop within 5 seconds; retry with --force"
        case .startupTimeout(let diagnostics): "daemon did not become ready. \(diagnostics)"
        case .operationFailed(let message): message
        }
    }
}

public struct LifecycleController: Sendable {
    public let launchd: any LaunchdControlling
    public let daemon: any DaemonControlling
    public let processes: any ProcessControlling
    public let metadata: OwnershipMetadataStore
    public let plist: URL
    public let operationLockURL: URL
    public let timing: LifecycleTiming
    public let fileExists: @Sendable (URL) -> Bool
    public let sleep: @Sendable (Duration) async throws -> Void
    public let startupFailure: @Sendable () -> LifecycleFailure?
    public let manualStarter: (any ManualDaemonStarting)?

    public init(launchd: any LaunchdControlling, daemon: any DaemonControlling, processes: any ProcessControlling,
                metadata: OwnershipMetadataStore, plist: URL, operationLockURL: URL,
                timing: LifecycleTiming = .init(), fileExists: @escaping @Sendable (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) },
                sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
                startupFailure: @escaping @Sendable () -> LifecycleFailure? = { nil },
                manualStarter: (any ManualDaemonStarting)? = nil) {
        self.launchd = launchd; self.daemon = daemon; self.processes = processes; self.metadata = metadata
        self.plist = plist; self.operationLockURL = operationLockURL; self.timing = timing
        self.fileExists = fileExists; self.sleep = sleep
        self.startupFailure = startupFailure
        self.manualStarter = manualStarter
    }

    public func start(manual: Bool = false) async throws -> LifecycleResult {
        let lock = try lifecycleLock()
        _ = lock
        return try await manual ? startManualLocked() : startLocked()
    }

    public func stop(force: Bool) async throws -> LifecycleResult {
        let lock = try lifecycleLock()
        _ = lock
        return try await stopLocked(force: force)
    }

    public func restart(force: Bool, manual: Bool = false) async throws -> LifecycleResult {
        let lock = try lifecycleLock()
        _ = lock
        if !manual { guard fileExists(plist) else { throw LifecycleFailure.serviceNotInstalled } }
        let stopped = try await stopLocked(force: force)
        let started = try await manual ? startManualLocked() : startLocked()
        return .init(action: "restart", changed: stopped.changed || started.changed,
                     forced: stopped.forced, escalation: stopped.escalation, warnings: stopped.warnings + started.warnings)
    }

    private func lifecycleLock() throws -> OperationLock {
        do { return try OperationLock(url: operationLockURL) }
        catch OwnershipMetadataError.unavailable(EWOULDBLOCK) { throw LifecycleFailure.lifecycleBusy }
        catch { throw LifecycleFailure.operationFailed(String(describing: error)) }
    }

    private func startLocked() async throws -> LifecycleResult {
        guard fileExists(plist) else { throw LifecycleFailure.serviceNotInstalled }
        let owner = try metadata.readVerified()
        if let owner, owner.mode == .service, processes.isRunning(owner), await daemon.ping(endpoint: owner.endpoint) {
            return .init(action: "start", changed: false)
        }
        if let owner, owner.mode == .manual, processes.isRunning(owner) {
            guard try await gracefulStop(owner: owner, timeout: timing.gracefulTimeout) else {
                throw LifecycleFailure.gracefulTimeout
            }
        }
        do {
            if !(await launchd.isBootstrapped(label: WMServiceIdentity.label)) { try await launchd.bootstrap(plist: plist) }
            try await launchd.kickstart(label: WMServiceIdentity.label)
        } catch { throw LifecycleFailure.operationFailed(String(describing: error)) }
        guard await waitUntil(timing.startupTimeout, condition: { await daemon.ping(endpoint: WMServiceIdentity.endpoint()) }) else {
            if let failure = startupFailure() { throw failure }
            throw LifecycleFailure.startupTimeout(await launchd.diagnostics(label: WMServiceIdentity.label))
        }
        return .init(action: "start", changed: true)
    }

    private func startManualLocked() async throws -> LifecycleResult {
        if let owner = try metadata.readVerified(), processes.isRunning(owner), await daemon.ping(endpoint: owner.endpoint) {
            return .init(action: "start", changed: false)
        }
        guard let manualStarter else {
            throw LifecycleFailure.operationFailed("Manual daemon startup is unavailable in this executable.")
        }
        do { try await manualStarter.start() }
        catch { throw LifecycleFailure.operationFailed("The manual wm daemon could not be started. \(error)") }
        guard await waitUntil(timing.startupTimeout, condition: { await daemon.ping(endpoint: WMServiceIdentity.endpoint()) }) else {
            if let failure = startupFailure() { throw failure }
            throw LifecycleFailure.startupTimeout("Check the wm state logs for manual startup errors.")
        }
        return .init(action: "start", changed: true)
    }

    private func stopLocked(force: Bool) async throws -> LifecycleResult {
        guard let owner = try metadata.readVerified(), processes.isRunning(owner) else {
            return try await stopWithoutMetadata(force: force)
        }
        if try await gracefulStop(owner: owner, timeout: timing.gracefulTimeout) {
            return .init(action: "stop", changed: true)
        }
        guard force else { throw LifecycleFailure.gracefulTimeout }
        var escalation: [String] = []
        if owner.mode == .service, await launchd.isBootstrapped(label: WMServiceIdentity.label) {
            try await launchd.bootout(label: WMServiceIdentity.label)
            escalation.append("bootout")
        }
        guard let verified = try metadata.readVerified(), verified == owner else {
            return .init(action: "stop", changed: true, forced: true, escalation: escalation)
        }
        try processes.signal(verified, SIGTERM)
        escalation.append("sigterm")
        if await waitUntil(timing.terminationTimeout, condition: { !processes.isRunning(verified) }) {
            return .init(action: "stop", changed: true, forced: true, escalation: escalation)
        }
        guard let killOwner = try metadata.readVerified(), killOwner == owner else {
            return .init(action: "stop", changed: true, forced: true, escalation: escalation)
        }
        try processes.signal(killOwner, SIGKILL)
        escalation.append("sigkill")
        guard await waitUntil(timing.terminationTimeout, condition: { !processes.isRunning(killOwner) }) else {
            throw LifecycleFailure.operationFailed("daemon remained running after SIGKILL")
        }
        return .init(action: "stop", changed: true, forced: true, escalation: escalation)
    }

    private func stopWithoutMetadata(force: Bool) async throws -> LifecycleResult {
        let endpoint = WMServiceIdentity.endpoint()
        guard await daemon.ping(endpoint: endpoint) else {
            return .init(action: "stop", changed: false)
        }
        if await daemon.shutdown(endpoint: endpoint),
           await waitUntil(timing.gracefulTimeout, condition: { !(await daemon.ping(endpoint: endpoint)) }) {
            return .init(action: "stop", changed: true, warnings: [
                "Stopped a legacy daemon without ownership metadata through graceful protocol shutdown."
            ])
        }
        if force { throw LifecycleFailure.ownershipMetadataMissing }
        throw LifecycleFailure.gracefulTimeout
    }

    private func gracefulStop(owner: DaemonOwnership, timeout: Duration) async throws -> Bool {
        guard await daemon.shutdown(endpoint: owner.endpoint) else { return false }
        return await waitUntil(timeout, condition: { !processes.isRunning(owner) })
    }

    private func waitUntil(_ timeout: Duration, condition: @escaping @Sendable () async -> Bool) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while clock.now < deadline {
            if await condition() { return true }
            try? await sleep(timing.pollInterval)
        }
        return await condition()
    }
}

public struct SystemLaunchdController: LaunchdControlling {
    public init() {}
    public func isBootstrapped(label: String) async -> Bool { await run(["print", "gui/\(getuid())/\(label)"]).status == 0 }
    public func bootstrap(plist: URL) async throws { try await requireSuccess(["bootstrap", "gui/\(getuid())", plist.path]) }
    public func kickstart(label: String) async throws { try await requireSuccess(["kickstart", "-k", "gui/\(getuid())/\(label)"]) }
    public func bootout(label: String) async throws { try await requireSuccess(["bootout", "gui/\(getuid())/\(label)"]) }
    public func diagnostics(label: String) async -> String { String(decoding: await run(["print", "gui/\(getuid())/\(label)"]).output, as: UTF8.self) }
    private func requireSuccess(_ arguments: [String]) async throws {
        let result = await run(arguments)
        guard result.status == 0 else { throw LifecycleFailure.operationFailed(String(decoding: result.output, as: UTF8.self)) }
    }
    private func run(_ arguments: [String]) async -> (status: Int32, output: Data) {
        await Task.detached {
            let process = Process(), pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl"); process.arguments = arguments
            process.standardOutput = pipe; process.standardError = pipe
            do { try process.run(); process.waitUntilExit() } catch { return (-1, Data(String(describing: error).utf8)) }
            return (process.terminationStatus, pipe.fileHandleForReading.readDataToEndOfFile())
        }.value
    }
}

public struct SystemDaemonController: DaemonControlling {
    public init() {}
    public func ping(endpoint: URL) async -> Bool { await request(.daemonPing, endpoint: endpoint) }
    public func shutdown(endpoint: URL) async -> Bool { await request(.daemonShutdown, endpoint: endpoint) }
    private func request(_ method: WMProtocol.Method, endpoint: URL) async -> Bool {
        (try? await Task.detached {
            let client = WebSocketClient(url: endpoint); try client.connect(); defer { client.close() }
            _ = try client.receive()
            let message = ClientMessage.request(.init(requestId: UUID().uuidString, method: method))
            try client.send(text: String(decoding: try ProtocolCodec.encode(message), as: UTF8.self))
            guard case .response(let response) = try ProtocolCodec.decode(ServerMessage.self, from: Data(try client.receive().utf8)) else { return false }
            return response.isSuccess
        }.value) ?? false
    }
}

public struct SystemProcessController: ProcessControlling {
    public init() {}
    public func isRunning(_ owner: DaemonOwnership) -> Bool { (try? processStartIdentity(pid: owner.pid)) == owner.processStartIdentity }
    public func signal(_ owner: DaemonOwnership, _ signal: Int32) throws {
        guard isRunning(owner) else { throw LifecycleFailure.operationFailed("daemon ownership changed before signal") }
        guard kill(owner.pid, signal) == 0 else { throw LifecycleFailure.operationFailed("signal failed: \(errno)") }
    }
}

public struct SystemManualDaemonStarter: ManualDaemonStarting {
    public let executable: URL
    public let logs: URL

    public init(executable: URL, logs: URL) {
        self.executable = executable
        self.logs = logs
    }

    public func start() async throws {
        try await Task.detached {
            try FileManager.default.createDirectory(
                at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let output = logs.appendingPathComponent("daemon.stdout.log")
            let error = logs.appendingPathComponent("daemon.stderr.log")
            FileManager.default.createFile(atPath: output.path, contents: nil)
            FileManager.default.createFile(atPath: error.path, contents: nil)
            let outputHandle = try FileHandle(forWritingTo: output)
            let errorHandle = try FileHandle(forWritingTo: error)
            try outputHandle.seekToEnd()
            try errorHandle.seekToEnd()
            let process = Process()
            process.executableURL = executable
            process.arguments = ["daemon"]
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = outputHandle
            process.standardError = errorHandle
            try process.run()
        }.value
    }
}
