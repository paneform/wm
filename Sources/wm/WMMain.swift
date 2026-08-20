import AppKit
import Dispatch
import Foundation
import WMCLI
import WMConfiguration
import WMCore
import WMInventory
import WMLifecycle
import WMPermissions
import WMPersistence
import WMProtocol
import WMWebSocket
import WMWorkspace

@main struct WMMain {
  static func main() async {
    let arguments = Array(CommandLine.arguments.dropFirst())
    do {
      let invocation = try CLIParser().parseInvocation(arguments)
      let output = CLIOutput(
        stdout: { FileHandle.standardOutput.write($0) },
        stderr: { FileHandle.standardError.write($0) }
      ).processing(pretty: invocation.pretty)
      switch invocation.command {
      case .help:
        output.stdout(Data(CLIHelp.utf8))
        exit(CLIExitCode.success.rawValue)
      case .daemon(let configuration): exit(await runDaemon(configuration))
      case .verify(let url): exit(await verify(url: url, output: output))
      default:
        exit(
          try await CLIRunner(
            client: ConcreteWebSocketClient(), output: output,
            lifecycle: lifecycleController(), serviceInstaller: try serviceInstaller()
          ).run(invocation.command).rawValue)
      }
    } catch {
      FileHandle.standardError.write(
        Data(
          "{\"ok\":false,\"error\":{\"code\":\"usage\",\"message\":\"\(escaped(String(describing: error)))\"}}\n"
            .utf8))
      exit(CLIExitCode.usage.rawValue)
    }
  }

  @MainActor private static func runDaemon(_ configuration: DaemonConfiguration) async -> Int32 {
    guard configuration.isSafe else {
      FileHandle.standardError.write(Data("invalid daemon configuration\n".utf8))
      return CLIExitCode.usage.rawValue
    }
    let processLock: DaemonProcessLock
    do { processLock = try DaemonProcessLock() } catch {
      FileHandle.standardError.write(Data("daemon lock failed: \(error)\n".utf8))
      return CLIExitCode.unavailable.rawValue
    }
    _ = processLock
    let stateDirectory = WMServiceIdentity.stateDirectory()
    let metadata = OwnershipMetadataStore(
      url: stateDirectory.appendingPathComponent("daemon-owner.json"))
    let mode: DaemonMode =
      ProcessInfo.processInfo.environment[WMServiceIdentity.serviceModeEnvironmentKey] == "1"
      ? .service : .manual
    var owner: DaemonOwnership
    do {
      owner = .init(
        pid: getpid(), processStartIdentity: try processStartIdentity(pid: getpid()), mode: mode,
        endpoint: WMServiceIdentity.endpoint(port: configuration.port), readyState: .starting)
      try metadata.write(owner)
    } catch {
      FileHandle.standardError.write(Data("daemon ownership metadata failed: \(error)\n".utf8))
      return CLIExitCode.unavailable.rawValue
    }
    defer { metadata.remove(ifOwnedBy: owner) }
    let scanner = InventoryScanner()
    let state = InventoryState(provider: SystemInventoryProvider(scanner: scanner))
    let workspaces: WorkspaceController
    do { workspaces = try WorkspaceController(buildVersion: "0.0.1-dev") } catch {
      FileHandle.standardError.write(Data("workspace state validation failed: \(error)\n".utf8))
      return CLIExitCode.unavailable.rawValue
    }
    let profileStore = WindowGeometryProfileStore()
    let profileCatalog: WindowGeometryProfileCatalog
    do { profileCatalog = try profileStore.load() } catch {
      FileHandle.standardError.write(Data("geometry profile load failed: \(error)\n".utf8))
      return CLIExitCode.unavailable.rawValue
    }
    let handler = DaemonHandler(
      state: state, workspaces: workspaces,
      geometryProfiles: .init(catalog: profileCatalog, persistence: profileStore)
    )
    let configPath = ConfigurationFile.path()
    do {
      let committed = try await state.refresh()
      let inventory = await handler.mergingPersistedCapabilities(into: committed.snapshot.inventory)
      guard committed.snapshot.health.capabilities["accessibility"] as? Bool == true,
        committed.snapshot.health.capabilities["core_graphics"] as? Bool == true
      else {
        throw StartupError.permissionDenied(PermissionController().statuses())
      }
      guard
        let displayID = (inventory.displays.first(where: \.isPrimary) ?? inventory.displays.first)?
          .id
      else {
        throw StartupError.noDisplay
      }
      var loadedConfiguration = Configuration()
      if FileManager.default.fileExists(atPath: configPath.path) {
        let source = try String(contentsOf: configPath, encoding: .utf8)
        loadedConfiguration = try ConfigurationParser.parse(source)
        _ = try await handler.loadConfiguration(source: source, inventory: inventory)
      }
      try await handler.recoverInvalidPersistedState(
        configuration: loadedConfiguration, inventory: inventory, defaultDisplayID: displayID
      )
      try await handler.auditStartupIntent(inventory)
      try await handler.reconcileObservedWindows(inventory, displayID: displayID)
    } catch StartupError.permissionDenied(let statuses) {
      FileHandle.standardError.write(
        Data("permission denied: \(missingPermissionMessage(statuses))\n".utf8))
      return CLIExitCode.unavailable.rawValue
    } catch {
      FileHandle.standardError.write(Data("inventory initialization failed: \(error)\n".utf8))
      return CLIExitCode.unavailable.rawValue
    }
    let server = WebSocketServer(
      configuration: .init(
        host: configuration.host, port: configuration.port,
        allowedOrigins: Set(configuration.allowedOrigins)), handler: handler)
    await handler.installSender { text, client in try? server.send(text, to: client) }
    await handler.installInternalErrorReporter { message in
      FileHandle.standardError.write(Data("\(message)\n".utf8))
    }
    do { try server.start() } catch {
      FileHandle.standardError.write(Data("daemon start failed: \(error)\n".utf8))
      return CLIExitCode.unavailable.rawValue
    }
    owner.readyState = .ready
    do { try metadata.write(owner) } catch {
      server.stop()
      FileHandle.standardError.write(Data("daemon ready metadata failed: \(error)\n".utf8))
      return CLIExitCode.unavailable.rawValue
    }
    let observe: @Sendable () async throws -> Void = {
      guard isGUIInventoryAvailable() else {
        await handler.beginSessionTransition(.lock)
        return
      }
      if await handler.isPaused() {
        try await handler.resynchronizeActivatedSession()
        return
      }
      let committed = try await state.refresh()
      let inventory = committed.snapshot.inventory
      guard committed.snapshot.health.capabilities["accessibility"] as? Bool == true,
        committed.snapshot.health.capabilities["core_graphics"] as? Bool == true
      else {
        await handler.beginTermination()
        let failures = await handler.shutdown(inventory)
        if !failures.isEmpty {
          FileHandle.standardError.write(
            Data("permission revocation restore failed: \(failures.joined(separator: "; "))\n".utf8)
          )
        }
        kill(getpid(), SIGTERM)
        return
      }
      guard isGUIInventoryAvailable() else {
        await handler.beginSessionTransition(.lock)
        return
      }
      guard
        let displayID = (inventory.displays.first(where: \.isPrimary) ?? inventory.displays.first)?
          .id
      else { return }
      try await handler.reconcilePeriodicObservation(
        inventory, displayID: displayID, focusedWindowID: committed.snapshot.focusedWindowID,
        frontmostPID: NSWorkspace.shared.frontmostApplication?.processIdentifier
      )
      await handler.publishStateSnapshot()
    }
    let observation = InventoryObservationLoop(
      observe: observe,
      report: { error in
        FileHandle.standardError.write(Data("automatic inventory refresh failed: \(error)\n".utf8))
      }
    )
    let observationTask = Task { await observation.run() }
    let configWatcher = ConfigurationWatcher()
    let configTask = Task {
      while !Task.isCancelled {
        do {
          if FileManager.default.fileExists(atPath: configPath.path) {
            try await configWatcher.poll(path: configPath) { _, source in
              let inventory = try await state.refresh().snapshot.inventory
              _ = try await handler.hotloadConfiguration(source: source, inventory: inventory)
            }
          }
        } catch {
          FileHandle.standardError.write(Data("configuration watch failed: \(error)\n".utf8))
        }
        try? await Task.sleep(for: .milliseconds(500))
      }
    }
    let activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification,
      object: nil,
      queue: .main
    ) { notification in
      guard
        let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
          as? NSRunningApplication
      else { return }
      Task {
        do {
          guard isGUIInventoryAvailable(), await !handler.isPaused() else { return }
          let committed = try await state.refresh()
          try await handler.reconcileApplicationActivation(
            frontmostPID: application.processIdentifier, inventory: committed.snapshot.inventory
          )
        } catch {
          FileHandle.standardError.write(
            Data("application activation reconciliation failed: \(error)\n".utf8))
        }
      }
    }
    let terminationObserver = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didTerminateApplicationNotification,
      object: nil,
      queue: .main
    ) { _ in
      Task {
        do {
          guard isGUIInventoryAvailable(), await !handler.isPaused() else { return }
          let committed = try await state.refresh()
          let inventory = committed.snapshot.inventory
          guard
            let displayID =
              (inventory.displays.first(where: \.isPrimary) ?? inventory.displays.first)?.id
          else { return }
          try await handler.reconcilePeriodicObservation(
            inventory, displayID: displayID,
            focusedWindowID: committed.snapshot.focusedWindowID,
            frontmostPID: NSWorkspace.shared.frontmostApplication?.processIdentifier
          )
          await handler.publishStateSnapshot()
        } catch {
          FileHandle.standardError.write(
            Data("application termination reconciliation failed: \(error)\n".utf8))
        }
      }
    }
    let workspaceCenter = NSWorkspace.shared.notificationCenter
    let sessionObservers: [NSObjectProtocol] = [
      workspaceCenter.addObserver(
        forName: NSWorkspace.willSleepNotification, object: nil, queue: .main
      ) { _ in
        Task { await handler.beginSessionTransition(.sleep) }
      },
      workspaceCenter.addObserver(
        forName: NSWorkspace.sessionDidResignActiveNotification, object: nil, queue: .main
      ) { _ in
        Task { await handler.beginSessionTransition(.lock) }
      },
      workspaceCenter.addObserver(
        forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
      ) { _ in
        Task { try? await handler.resynchronizeSession(.wake) }
      },
      workspaceCenter.addObserver(
        forName: NSWorkspace.sessionDidBecomeActiveNotification, object: nil, queue: .main
      ) { _ in
        Task { try? await handler.resynchronizeActivatedSession() }
      },
    ]
    let screenObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
    ) { _ in
      Task { try? await handler.resynchronizeSession(.clamshell) }
    }
    let stream = AsyncStream<Void> { continuation in
      signal(SIGINT, SIG_IGN)
      signal(SIGTERM, SIG_IGN)
      let sources = [SIGINT, SIGTERM].map { signal in
        let source = DispatchSource.makeSignalSource(signal: signal)
        source.setEventHandler {
          continuation.yield()
          continuation.finish()
        }
        source.resume()
        return source
      }
      continuation.onTermination = { _ in sources.forEach { $0.cancel() } }
      Task {
        await handler.installShutdownRequest {
          continuation.yield()
          continuation.finish()
        }
      }
    }
    for await _ in stream { break }
    observationTask.cancel()
    configTask.cancel()
    await observationTask.value
    await configTask.value
    NSWorkspace.shared.notificationCenter.removeObserver(activationObserver)
    NSWorkspace.shared.notificationCenter.removeObserver(terminationObserver)
    sessionObservers.forEach { workspaceCenter.removeObserver($0) }
    NotificationCenter.default.removeObserver(screenObserver)
    await handler.beginTermination()
    var shutdownFailures = ["inventory refresh failed"]
    if let refreshed = try? await state.refresh() {
      shutdownFailures = await handler.shutdown(refreshed.snapshot.inventory)
    }
    if !shutdownFailures.isEmpty {
      FileHandle.standardError.write(
        Data("graceful shutdown restore failed: \(shutdownFailures.joined(separator: "; "))\n".utf8)
      )
    }
    server.stop()
    return shutdownFailures.isEmpty
      ? CLIExitCode.success.rawValue : CLIExitCode.commandFailed.rawValue
  }

  private static func lifecycleController() -> LifecycleController {
    let stateDirectory = WMServiceIdentity.stateDirectory()
    let executable = try? currentExecutableURL()
    return LifecycleController(
      launchd: SystemLaunchdController(), daemon: SystemDaemonController(),
      processes: SystemProcessController(),
      metadata: .init(url: stateDirectory.appendingPathComponent("daemon-owner.json")),
      plist: WMServiceIdentity.plistURL(),
      operationLockURL: stateDirectory.appendingPathComponent("lifecycle.lock"),
      startupFailure: {
        let log = WMServiceIdentity.logDirectory().appendingPathComponent("daemon.stderr.log")
        guard let text = try? String(contentsOf: log, encoding: .utf8),
          let marker = text.components(separatedBy: "permission denied: ").last,
          marker != text
        else { return nil }
        return .permissionDenied(
          marker.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? marker)
      },
      manualStarter: executable.map {
        SystemManualDaemonStarter(executable: $0, logs: WMServiceIdentity.logDirectory())
      }
    )
  }

  private static func serviceInstaller() throws -> ServiceInstaller {
    let stateDirectory = WMServiceIdentity.stateDirectory()
    return ServiceInstaller(
      launchd: SystemLaunchdController(), processes: SystemProcessController(),
      metadata: .init(url: stateDirectory.appendingPathComponent("daemon-owner.json")),
      plist: WMServiceIdentity.plistURL(),
      operationLockURL: stateDirectory.appendingPathComponent("lifecycle.lock"),
      executable: try currentExecutableURL(), logs: WMServiceIdentity.logDirectory(),
      validateConfiguration: {
        let path = ConfigurationFile.path()
        if FileManager.default.fileExists(atPath: path.path) {
          _ = try ConfigurationFile.load(at: path)
        }
      }
    )
  }

  private static func verify(url: URL, output: CLIOutput) async -> Int32 {
    do {
      let client = WebSocketClient(url: url)
      try client.connect()
      defer { client.close() }
      guard
        case .welcome = try ProtocolCodec.decode(
          ServerMessage.self, from: Data(try client.receive().utf8))
      else { throw VerifyError.expectedWelcome }
      let id = "verify-\(UUID().uuidString)"
      let request = try ProtocolCodec.encode(
        ClientMessage.request(.init(requestId: id, method: .daemonPing)))
      try client.send(text: String(data: request, encoding: .utf8)!)
      guard
        case .response(let response) = try ProtocolCodec.decode(
          ServerMessage.self, from: Data(try client.receive().utf8)), response.requestId == id,
        response.isSuccess
      else { throw VerifyError.expectedResponse }
      let subscriptionID = "verify-sub"
      let subscribe = ClientMessage.subscribe(
        .init(
          requestId: "verify-subscribe", subscriptionId: subscriptionID,
          topics: [.inventoryRefreshed]))
      try client.send(text: String(data: try ProtocolCodec.encode(subscribe), encoding: .utf8)!)
      guard
        case .response(let subscribed) = try ProtocolCodec.decode(
          ServerMessage.self, from: Data(try client.receive().utf8)), subscribed.isSuccess
      else { throw VerifyError.expectedSubscribeResponse }
      guard
        case .event = try ProtocolCodec.decode(
          ServerMessage.self, from: Data(try client.receive().utf8))
      else { throw VerifyError.expectedEvent }
      let refresh = ClientMessage.request(
        .init(requestId: "verify-refresh", method: .inventoryRefresh))
      try client.send(text: String(data: try ProtocolCodec.encode(refresh), encoding: .utf8)!)
      var sawRefreshResponse = false
      var sawRefreshEvent = false
      while !sawRefreshResponse || !sawRefreshEvent {
        switch try ProtocolCodec.decode(ServerMessage.self, from: Data(try client.receive().utf8)) {
        case .response(let value) where value.requestId == "verify-refresh" && value.isSuccess:
          sawRefreshResponse = true
        case .event(let value) where value.topic == .inventoryRefreshed: sawRefreshEvent = true
        default: break
        }
      }
      let unsubscribe = ClientMessage.unsubscribe(
        .init(requestId: "verify-unsubscribe", subscriptionId: subscriptionID))
      try client.send(text: String(data: try ProtocolCodec.encode(unsubscribe), encoding: .utf8)!)
      guard
        case .response(let unsubscribed) = try ProtocolCodec.decode(
          ServerMessage.self, from: Data(try client.receive().utf8)), unsubscribed.isSuccess
      else { throw VerifyError.expectedUnsubscribeResponse }
      output.stdout(
        Data(
          "{\"ok\":true,\"verified\":[\"welcome\",\"request_response\",\"subscribe_initial_event\",\"refresh_event\",\"unsubscribe\"]}\n"
            .utf8))
      return 0
    } catch {
      FileHandle.standardError.write(
        Data("{\"ok\":false,\"error\":\"\(escaped(String(describing: error)))\"}\n".utf8))
      return 1
    }
  }
}

private enum VerifyError: Error {
  case expectedWelcome, expectedResponse, expectedSubscribeResponse, expectedEvent,
    expectedUnsubscribeResponse
}
private enum StartupError: Error {
  case noDisplay
  case permissionDenied([WMPermissionStatus])
}
extension DaemonConfiguration {
  fileprivate var isSafe: Bool {
    ["127.0.0.1", "localhost", "::1"].contains(host) && port > 0
      && allowedOrigins.allSatisfy { origin in
        guard let url = URL(string: origin) else { return false }
        return ["http", "https"].contains(url.scheme?.lowercased() ?? "") && url.host != nil
          && url.user == nil && url.password == nil && url.fragment == nil
          && (url.path.isEmpty || url.path == "/")
      }
  }
}
private func escaped(_ value: String) -> String {
  value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
}

private func isGUIInventoryAvailable() -> Bool {
  guard isConsoleSessionActive() else { return false }
  guard let application = NSWorkspace.shared.frontmostApplication else { return false }
  return application.bundleIdentifier != "com.apple.loginwindow"
    && application.executableURL?.lastPathComponent != "loginwindow"
}
