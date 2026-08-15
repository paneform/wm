import Foundation
import WMConfiguration
import WMProtocol
import WMWebSocket

public enum JSONValue: Sendable, Equatable, Codable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

public struct CLIRequest: Sendable, Equatable, Codable {
    public let type: String
    public let requestID: String
    public let method: String
    public let params: [String: JSONValue]

    enum CodingKeys: String, CodingKey {
        case type, method, params
        case requestID = "request_id"
    }

    public init(requestID: String, method: String, params: [String: JSONValue] = [:]) {
        type = "request"
        self.requestID = requestID
        self.method = method
        self.params = params
    }
}

public struct CLISubscribeRequest: Sendable, Equatable, Codable {
    public let type: String
    public let requestID: String
    public let subscriptionID: String
    public let topics: [String]
    public let projection: CLIProjection
    public let detail: SnapshotDetail
    public let afterSequence: UInt64?

    enum CodingKeys: String, CodingKey {
        case type, topics, projection, detail
        case requestID = "request_id"
        case subscriptionID = "subscription_id"
        case afterSequence = "after_sequence"
    }

    public init(
        requestID: String,
        subscriptionID: String,
        topics: [String],
        projection: CLIProjection,
        detail: SnapshotDetail,
        afterSequence: UInt64?
    ) {
        type = "subscribe"
        self.requestID = requestID
        self.subscriptionID = subscriptionID
        self.topics = topics
        self.projection = projection
        self.detail = detail
        self.afterSequence = afterSequence
    }
}

extension CLIProjection: Codable {}

public struct CLIResponse: Sendable, Equatable {
    public let json: Data
    public let ok: Bool

    public init(json: Data, ok: Bool) {
        self.json = json
        self.ok = ok
    }
}

public protocol CLIWebSocketClient: Sendable {
    func request(_ message: Data, at url: URL) async throws -> CLIResponse
    func subscribe(_ message: Data, at url: URL) -> AsyncThrowingStream<Data, Error>
}

public struct ConcreteWebSocketClient: CLIWebSocketClient, Sendable {
    public init() {}

    public func request(_ message: Data, at url: URL) async throws -> CLIResponse {
        try await Task.detached {
            let client = WebSocketClient(url: url)
            try client.connect()
            defer { client.close() }
            _ = try client.receive()
            try client.send(text: try text(message))
            let response = Data(try client.receive().utf8)
            return CLIResponse(json: response, ok: try responseIsSuccessful(response))
        }.value
    }

    public func subscribe(_ message: Data, at url: URL) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            let task = Task.detached {
                let client = WebSocketClient(url: url)
                do {
                    try client.connect()
                    continuation.yield(Data(try client.receive().utf8))
                    try client.send(text: try text(message))
                    while !Task.isCancelled { continuation.yield(Data(try client.receive().utf8)) }
                    client.close()
                    continuation.finish()
                } catch {
                    client.close()
                    if !Task.isCancelled { continuation.finish(throwing: error) }
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

private func text(_ data: Data) throws -> String {
    guard let value = String(data: data, encoding: .utf8) else { throw CLIParseError("request is not UTF-8") }
    return value
}

private func responseIsSuccessful(_ data: Data) throws -> Bool {
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    return object?["type"] as? String == "response" && object?["ok"] as? Bool == true
}

public struct CLIOutput: Sendable {
    public var stdout: @Sendable (Data) -> Void
    public var stderr: @Sendable (Data) -> Void

    public init(
        stdout: @escaping @Sendable (Data) -> Void,
        stderr: @escaping @Sendable (Data) -> Void
    ) {
        self.stdout = stdout
        self.stderr = stderr
    }

    public func processing(pretty: Bool) -> CLIOutput {
        guard pretty else { return self }
        return CLIOutput(stdout: { data in stdout(prettyJSON(data)) }, stderr: stderr)
    }
}

private func prettyJSON(_ data: Data) -> Data {
    guard let value = try? JSONSerialization.jsonObject(with: data),
          var formatted = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    else { return data }
    if formatted.last != 0x0A { formatted.append(0x0A) }
    return formatted
}

public struct CLIRunner<Client: CLIWebSocketClient>: Sendable {
    private let client: Client
    private let output: CLIOutput
    private let id: @Sendable () -> String
    private let encoder: JSONEncoder
    private let configPath: URL

    public init(
        client: Client,
        output: CLIOutput,
        id: @escaping @Sendable () -> String = { UUID().uuidString },
        configPath: URL = ConfigurationFile.path()
    ) {
        self.client = client
        self.output = output
        self.id = id
        self.configPath = configPath
        encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    }

    public func run(arguments: [String]) async -> CLIExitCode {
        do {
            let invocation = try CLIParser().parseInvocation(arguments)
            return try await CLIRunner(
                client: client, output: output.processing(pretty: invocation.pretty), id: id, configPath: configPath
            )
                .run(invocation.command)
        } catch let error as CLIParseError {
            writeError(code: "usage", message: error.message)
            return .usage
        } catch {
            writeError(code: "connection_failed", message: String(describing: error))
            return .unavailable
        }
    }

    public func run(_ command: CLICommand) async throws -> CLIExitCode {
        switch command {
        case .help:
            writeLine(Data(CLIHelp.utf8), to: output.stdout)
            return .success
        case .configHelp:
            writeLine(Data(CLIConfigHelp.utf8), to: output.stdout)
            return .success
        case .configExample:
            writeLine(Data(try ConfigurationFile.example().utf8), to: output.stdout)
            return .success
        case .configInit:
            return runConfigInit()
        case .configValidate:
            return runConfigValidate()
        case .configAdoptState(let url):
            return try await runConfigAdoptState(url: url)
        case .request(let method, let params, let url):
            let response = try await client.request(try encoder.encode(CLIRequest(requestID: id(), method: method, params: params)), at: url)
            writeLine(response.json, to: output.stdout)
            return response.ok ? .success : .commandFailed
        case .subscribe(let configuration):
            let request = CLISubscribeRequest(
                requestID: id(), subscriptionID: id(), topics: configuration.topics,
                projection: configuration.projection, detail: configuration.detail,
                afterSequence: configuration.afterSequence
            )
            for try await message in client.subscribe(try encoder.encode(request), at: configuration.url) {
                writeLine(message, to: output.stdout)
            }
            return .success
        case .lifecycle(let command, _):
            writeError(code: "not_implemented", message: "lifecycle command is reserved: \(command.rawValue)")
            return .commandFailed
        case .daemon:
            writeError(code: "wiring_required", message: "daemon command requires executable wiring")
            return .unavailable
        case .benchmark(let configuration):
            return try await benchmark(configuration)
        case .verify:
            writeError(code: "wiring_required", message: "verification requires executable wiring")
            return .unavailable
        }
    }

    private func runConfigInit() -> CLIExitCode {
        let path = configPath
        do {
            try ConfigurationFile.initialize(at: path)
            writeLine(Data("created \(path.path)".utf8), to: output.stdout)
            return .success
        } catch {
            writeError(code: "config_init_failed", message: String(describing: error))
            return .commandFailed
        }
    }

    private func runConfigValidate() -> CLIExitCode {
        let path = configPath
        guard FileManager.default.fileExists(atPath: path.path) else {
            writeError(code: "config_not_found", message: ConfigCommandError.missing(path).description)
            return .commandFailed
        }
        do {
            _ = try ConfigurationFile.load(at: path)
            writeLine(Data("valid: \(path.path)".utf8), to: output.stdout)
            return .success
        } catch {
            writeError(code: "config_invalid", message: String(describing: error))
            return .commandFailed
        }
    }

    private func runConfigAdoptState(url: URL) async throws -> CLIExitCode {
        let response = try await client.request(
            try encoder.encode(CLIRequest(requestID: id(), method: "state.get")), at: url
        )
        guard response.ok else {
            writeLine(response.json, to: output.stdout)
            return .commandFailed
        }
        do {
            let state = try adoptedState(response.json)
            let path = configPath
            let existing = FileManager.default.fileExists(atPath: path.path)
                ? try ConfigurationFile.load(at: path)
                : Configuration()
            let adopted = ConfigurationFile.adopt(
                existing, workspaceDisplays: state.workspaceDisplays, windows: state.windows
            )
            try FileManager.default.createDirectory(
                at: path.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            try Data(ConfigurationFile.encode(adopted).utf8).write(to: path, options: .atomic)
            writeLine(Data("updated \(path.path)".utf8), to: output.stdout)
            return .success
        } catch {
            writeError(code: "config_adopt_failed", message: String(describing: error))
            return .commandFailed
        }
    }

    private func adoptedState(_ data: Data) throws -> (workspaceDisplays: [String: String], windows: [AdoptedWindow]) {
        guard case .object(let envelope) = try decoder().decode(JSONValue.self, from: data),
              case .object(let result)? = envelope["result"],
              case .object(let workspaceState)? = result["workspace_state"],
              case .array(let workspaces)? = workspaceState["workspaces"],
              case .array(let observedWindows)? = result["windows"] else {
            throw ConfigCommandError.invalidState
        }
        var workspaceDisplays: [String: String] = [:]
        var workspaceByWindow: [String: String] = [:]
        for value in workspaces {
            guard case .object(let workspace) = value,
                  case .string(let name)? = workspace["name"],
                  !name.isEmpty,
                  case .string(let display)? = workspace["display_id"],
                  !display.isEmpty,
                  case .array(let ids)? = workspace["window_ids"] else {
                throw ConfigCommandError.invalidState
            }
            workspaceDisplays[name] = display
            for id in ids {
                guard case .string(let id) = id, !id.isEmpty else { throw ConfigCommandError.invalidState }
                workspaceByWindow[id] = name
            }
        }
        let windows = try observedWindows.compactMap { value -> AdoptedWindow? in
            guard case .object(let window) = value,
                  case .string(let id)? = window["id"],
                  !id.isEmpty else { throw ConfigCommandError.invalidState }
            guard let workspace = workspaceByWindow[id] else { return nil }
            guard case .string(let path)? = window["executable_path"], !path.isEmpty else {
                throw ConfigCommandError.invalidState
            }
            return AdoptedWindow(executableName: URL(fileURLWithPath: path).lastPathComponent, workspace: workspace)
        }
        return (workspaceDisplays, windows)
    }

    private func decoder() -> JSONDecoder { JSONDecoder() }

    private func benchmark(_ configuration: BenchmarkConfiguration) async throws -> CLIExitCode {
        var durations: [Double] = []
        let clock = ContinuousClock()
        for _ in 0..<configuration.iterations {
            let started = clock.now
            let request = CLIRequest(requestID: id(), method: "daemon.ping")
            let response = try await client.request(try encoder.encode(request), at: configuration.url)
            guard response.ok else {
                writeLine(response.json, to: output.stdout)
                return .commandFailed
            }
            durations.append(Double(started.duration(to: clock.now).components.attoseconds) / 1e15)
        }
        let sorted = durations.sorted()
        let result: JSONValue = .object([
            "iterations": .number(Double(configuration.iterations)),
            "method": .string("daemon.ping"),
            "latency_ms": .object([
                "min": .number(sorted.first ?? 0),
                "median": .number(sorted[sorted.count / 2]),
                "max": .number(sorted.last ?? 0),
            ]),
            "ok": .bool(true),
        ])
        writeLine(try encoder.encode(result), to: output.stdout)
        return .success
    }

    private func writeError(code: String, message: String) {
        let value: JSONValue = .object([
            "error": .object(["code": .string(code), "message": .string(message)]),
            "ok": .bool(false),
        ])
        if let data = try? encoder.encode(value) { writeLine(data, to: output.stderr) }
    }

    private func writeLine(_ data: Data, to sink: @Sendable (Data) -> Void) {
        var line = data
        if line.last != 0x0A { line.append(0x0A) }
        sink(line)
    }
}
