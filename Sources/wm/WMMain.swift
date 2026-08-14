import Dispatch
import Foundation
import AppKit
import WMCLI
import WMCore
import WMInventory
import WMProtocol
import WMPersistence
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
            case .daemon(let configuration): exit(await runDaemon(configuration))
            case .verify(let url): exit(await verify(url: url, output: output))
            default:
                exit(try await CLIRunner(client: ConcreteWebSocketClient(), output: output).run(invocation.command).rawValue)
            }
        } catch {
            FileHandle.standardError.write(Data("{\"ok\":false,\"error\":{\"code\":\"usage\",\"message\":\"\(escaped(String(describing: error)))\"}}\n".utf8))
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
        let scanner = InventoryScanner()
        let state = InventoryState(provider: SystemInventoryProvider(scanner: scanner))
        let workspaces: WorkspaceController
        do { workspaces = try WorkspaceController(buildVersion: "0.0.1-dev") } catch {
            FileHandle.standardError.write(Data("workspace state validation failed: \(error)\n".utf8))
            return CLIExitCode.unavailable.rawValue
        }
        let handler = DaemonHandler(state: state, workspaces: workspaces)
        do {
            let committed = try await state.refresh()
            let inventory = committed.snapshot.inventory
            guard committed.snapshot.health.capabilities["accessibility"] as? Bool == true,
                  committed.snapshot.health.capabilities["core_graphics"] as? Bool == true else {
                throw StartupError.permissionDenied
            }
            guard let displayID = (inventory.displays.first(where: \.isPrimary) ?? inventory.displays.first)?.id else {
                throw StartupError.noDisplay
            }
            try await handler.auditCommittedIntent(inventory)
            try await handler.reconcileObservedWindows(inventory, displayID: displayID)
        } catch {
            FileHandle.standardError.write(Data("inventory initialization failed: \(error)\n".utf8))
            return CLIExitCode.unavailable.rawValue
        }
        let server = WebSocketServer(configuration: .init(host: configuration.host, port: configuration.port, allowedOrigins: Set(configuration.allowedOrigins)), handler: handler)
        await handler.installSender { text, client in try? server.send(text, to: client) }
        do { try server.start() } catch {
            FileHandle.standardError.write(Data("daemon start failed: \(error)\n".utf8))
            return CLIExitCode.unavailable.rawValue
        }
        let observe: @Sendable () async throws -> Void = {
                let committed = try await state.refresh()
                let inventory = committed.snapshot.inventory
                guard committed.snapshot.health.capabilities["accessibility"] as? Bool == true,
                      committed.snapshot.health.capabilities["core_graphics"] as? Bool == true else {
                    await handler.beginTermination()
                    let failures = await handler.shutdown(inventory)
                    if !failures.isEmpty {
                        FileHandle.standardError.write(Data("permission revocation restore failed: \(failures.joined(separator: "; "))\n".utf8))
                    }
                    kill(getpid(), SIGTERM)
                    return
                }
                guard await !handler.isPaused() else { return }
                guard let displayID = (inventory.displays.first(where: \.isPrimary) ?? inventory.displays.first)?.id else { return }
                try await handler.reconcileObservedWindows(inventory, displayID: displayID)
                try await handler.reconcileExternalFocus(
                    windowID: committed.snapshot.focusedWindowID,
                    frontmostPID: NSWorkspace.shared.frontmostApplication?.processIdentifier,
                    inventory: inventory
                )
        }
        let observation = InventoryObservationLoop(
            observe: observe,
            report: { error in
                FileHandle.standardError.write(Data("automatic inventory refresh failed: \(error)\n".utf8))
            }
        )
        let observationTask = Task { await observation.run() }
        let activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { _ in
            Task { try? await observe() }
        }
        let stream = AsyncStream<Void> { continuation in
            signal(SIGINT, SIG_IGN)
            signal(SIGTERM, SIG_IGN)
            let sources = [SIGINT, SIGTERM].map { signal in
                let source = DispatchSource.makeSignalSource(signal: signal)
                source.setEventHandler { continuation.yield(); continuation.finish() }
                source.resume()
                return source
            }
            continuation.onTermination = { _ in sources.forEach { $0.cancel() } }
        }
        for await _ in stream { break }
        observationTask.cancel()
        await observationTask.value
        NSWorkspace.shared.notificationCenter.removeObserver(activationObserver)
        await handler.beginTermination()
        var shutdownFailures = ["inventory refresh failed"]
        if let refreshed = try? await state.refresh() {
            shutdownFailures = await handler.shutdown(refreshed.snapshot.inventory)
        }
        if !shutdownFailures.isEmpty {
            FileHandle.standardError.write(Data("graceful shutdown restore failed: \(shutdownFailures.joined(separator: "; "))\n".utf8))
        }
        server.stop()
        return shutdownFailures.isEmpty ? CLIExitCode.success.rawValue : CLIExitCode.commandFailed.rawValue
    }

    private static func verify(url: URL, output: CLIOutput) async -> Int32 {
        do {
            let client = WebSocketClient(url: url)
            try client.connect()
            defer { client.close() }
            guard case .welcome = try ProtocolCodec.decode(ServerMessage.self, from: Data(try client.receive().utf8)) else { throw VerifyError.expectedWelcome }
            let id = "verify-\(UUID().uuidString)"
            let request = try ProtocolCodec.encode(ClientMessage.request(.init(requestId: id, method: .daemonPing)))
            try client.send(text: String(data: request, encoding: .utf8)!)
            guard case .response(let response) = try ProtocolCodec.decode(ServerMessage.self, from: Data(try client.receive().utf8)), response.requestId == id, response.isSuccess else { throw VerifyError.expectedResponse }
            let subscriptionID = "verify-sub"
            let subscribe = ClientMessage.subscribe(.init(requestId: "verify-subscribe", subscriptionId: subscriptionID, topics: [.inventoryRefreshed]))
            try client.send(text: String(data: try ProtocolCodec.encode(subscribe), encoding: .utf8)!)
            guard case .response(let subscribed) = try ProtocolCodec.decode(ServerMessage.self, from: Data(try client.receive().utf8)), subscribed.isSuccess else { throw VerifyError.expectedSubscribeResponse }
            guard case .event = try ProtocolCodec.decode(ServerMessage.self, from: Data(try client.receive().utf8)) else { throw VerifyError.expectedEvent }
            let refresh = ClientMessage.request(.init(requestId: "verify-refresh", method: .inventoryRefresh))
            try client.send(text: String(data: try ProtocolCodec.encode(refresh), encoding: .utf8)!)
            var sawRefreshResponse = false
            var sawRefreshEvent = false
            while !sawRefreshResponse || !sawRefreshEvent {
                switch try ProtocolCodec.decode(ServerMessage.self, from: Data(try client.receive().utf8)) {
                case .response(let value) where value.requestId == "verify-refresh" && value.isSuccess: sawRefreshResponse = true
                case .event(let value) where value.topic == .inventoryRefreshed: sawRefreshEvent = true
                default: break
                }
            }
            let unsubscribe = ClientMessage.unsubscribe(.init(requestId: "verify-unsubscribe", subscriptionId: subscriptionID))
            try client.send(text: String(data: try ProtocolCodec.encode(unsubscribe), encoding: .utf8)!)
            guard case .response(let unsubscribed) = try ProtocolCodec.decode(ServerMessage.self, from: Data(try client.receive().utf8)), unsubscribed.isSuccess else { throw VerifyError.expectedUnsubscribeResponse }
            output.stdout(Data("{\"ok\":true,\"verified\":[\"welcome\",\"request_response\",\"subscribe_initial_event\",\"refresh_event\",\"unsubscribe\"]}\n".utf8))
            return 0
        } catch {
            FileHandle.standardError.write(Data("{\"ok\":false,\"error\":\"\(escaped(String(describing: error)))\"}\n".utf8))
            return 1
        }
    }
}

private enum VerifyError: Error { case expectedWelcome, expectedResponse, expectedSubscribeResponse, expectedEvent, expectedUnsubscribeResponse }
private enum StartupError: Error { case noDisplay, permissionDenied }
private extension DaemonConfiguration {
    var isSafe: Bool {
        ["127.0.0.1", "localhost", "::1"].contains(host) && port > 0 && allowedOrigins.allSatisfy { origin in
            guard let url = URL(string: origin) else { return false }
            return ["http", "https"].contains(url.scheme?.lowercased() ?? "") && url.host != nil
                && url.user == nil && url.password == nil && url.fragment == nil && (url.path.isEmpty || url.path == "/")
        }
    }
}
private func escaped(_ value: String) -> String { value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") }
