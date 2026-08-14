import Foundation

public let defaultWMWebSocketURL = URL(string: "ws://127.0.0.1:17832/v1")!

public enum CLIExitCode: Int32, Sendable, Equatable {
    case success = 0
    case commandFailed = 1
    case usage = 2
    case unavailable = 3
    case interrupted = 130
}

public enum CLIProjection: String, Sendable, Equatable, CaseIterable {
    case delta
    case snapshot
    case invalidation
}

public struct DaemonConfiguration: Sendable, Equatable {
    public var host: String
    public var port: UInt16
    public var allowedOrigins: [String]

    public init(host: String = "127.0.0.1", port: UInt16 = 17_832, allowedOrigins: [String] = []) {
        self.host = host
        self.port = port
        self.allowedOrigins = allowedOrigins
    }
}

public struct SubscriptionConfiguration: Sendable, Equatable {
    public var topics: [String]
    public var projection: CLIProjection
    public var afterSequence: UInt64?
    public var url: URL

    public init(
        topics: [String],
        projection: CLIProjection = .delta,
        afterSequence: UInt64? = nil,
        url: URL = defaultWMWebSocketURL
    ) {
        self.topics = topics
        self.projection = projection
        self.afterSequence = afterSequence
        self.url = url
    }
}

public struct BenchmarkConfiguration: Sendable, Equatable {
    public var iterations: Int
    public var url: URL

    public init(iterations: Int = 10, url: URL = defaultWMWebSocketURL) {
        self.iterations = iterations
        self.url = url
    }
}

public enum LifecycleCommand: String, Sendable, Equatable {
    case start
    case stop
    case restart
    case installService = "install-service"
    case uninstallService = "uninstall-service"
}

public enum CLICommand: Sendable, Equatable {
    case daemon(DaemonConfiguration)
    case request(method: String, params: [String: JSONValue] = [:], url: URL)
    case subscribe(SubscriptionConfiguration)
    case lifecycle(LifecycleCommand, force: Bool)
    case benchmark(BenchmarkConfiguration)
    case verify(URL)
}

public struct CLIInvocation: Sendable, Equatable {
    public let command: CLICommand
    public let pretty: Bool

    public init(command: CLICommand, pretty: Bool = false) {
        self.command = command
        self.pretty = pretty
    }
}

public struct CLIParseError: Error, Sendable, Equatable, CustomStringConvertible {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var description: String { message }
}

public struct CLIParser: Sendable {
    public init() {}

    public func parseInvocation(_ arguments: [String]) throws -> CLIInvocation {
        let prettyCount = arguments.count(where: { $0 == "--pretty" })
        guard prettyCount < 2 else { throw CLIParseError("duplicate --pretty flag") }
        let pretty = prettyCount == 1
        let command = try parse(arguments.filter { $0 != "--pretty" })
        return CLIInvocation(command: command, pretty: pretty)
    }

    public func parse(_ arguments: [String]) throws -> CLICommand {
        guard let command = arguments.first else { throw CLIParseError("missing command") }
        let rest = Array(arguments.dropFirst())
        switch command {
        case "daemon": return .daemon(try parseDaemon(rest))
        case "ping": return try request("daemon.ping", rest)
        case "pause": return try request("daemon.pause", rest)
        case "resume": return try request("daemon.resume", rest)
        case "state": return try parseState(rest)
        case "health": return try request("health.get", rest)
        case "display": return try nestedRequest("display", child: "list", method: "display.list", rest)
        case "monitor": return try nestedRequest("monitor", child: "list", method: "display.list", rest)
        case "window": return try parseWindow(rest)
        case "observe": return try parseObserve(rest)
        case "workspace": return try parseWorkspace(rest)
        case "diagnostics": return try nestedRequest("diagnostics", child: "inventory", method: "diagnostics.inventory", rest)
        case "inventory": return try nestedRequest("inventory", child: "refresh", method: "inventory.refresh", rest)
        case "subscribe": return .subscribe(try parseSubscription(rest))
        case "start", "restart", "install-service", "uninstall-service":
            return try lifecycle(command, rest, allowsForce: false)
        case "stop": return try lifecycle(command, rest, allowsForce: true)
        case "benchmark": return .benchmark(try parseBenchmark(rest))
        case "verify": return .verify(try parseURLOnly(rest))
        default: throw CLIParseError("unknown command: \(command)")
        }
    }

    private func parseDaemon(_ arguments: [String]) throws -> DaemonConfiguration {
        var result = DaemonConfiguration()
        var index = 0
        while index < arguments.count {
            switch arguments[index] {
            case "--host": result.host = try value(after: &index, in: arguments)
            case "--port":
                let raw = try value(after: &index, in: arguments)
                guard let port = UInt16(raw), port > 0 else { throw CLIParseError("invalid port: \(raw)") }
                result.port = port
            case "--allow-origin": result.allowedOrigins.append(try value(after: &index, in: arguments))
            default: throw CLIParseError("unknown daemon argument: \(arguments[index])")
            }
            index += 1
        }
        guard ["127.0.0.1", "localhost", "::1"].contains(result.host) else {
            throw CLIParseError("daemon host must be loopback because the API is unauthenticated")
        }
        for origin in result.allowedOrigins {
            guard let url = URL(string: origin), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
                  url.host != nil, url.user == nil, url.password == nil, url.fragment == nil,
                  url.path.isEmpty || url.path == "/" else {
                throw CLIParseError("invalid allowed origin: \(origin)")
            }
        }
        return result
    }

    private func parseState(_ arguments: [String]) throws -> CLICommand {
        if arguments.first == "observed" {
            return try request("state.observed", Array(arguments.dropFirst()))
        }
        return try request("state.get", arguments)
    }

    private func parseWindow(_ arguments: [String]) throws -> CLICommand {
        guard let child = arguments.first else { throw CLIParseError("expected a window command") }
        switch child {
        case "list": return try request("window.list", Array(arguments.dropFirst()))
        case "manage", "unmanage": return try parseWindowManagement(child, Array(arguments.dropFirst()))
        case "frame": return try parseWindowFrame(Array(arguments.dropFirst()))
        default: throw CLIParseError("unknown window command: \(child)")
        }
    }

    private func parseWindowManagement(_ operation: String, _ arguments: [String]) throws -> CLICommand {
        guard let windowID = arguments.first, !windowID.isEmpty else { throw CLIParseError("missing window ID") }
        return .request(
            method: "window.\(operation)", params: ["window_id": .string(windowID)],
            url: try parseURLOnly(Array(arguments.dropFirst()))
        )
    }

    private func parseObserve(_ arguments: [String]) throws -> CLICommand {
        guard let target = arguments.first else { throw CLIParseError("expected 'observe window' or 'observe workspace'") }
        if target == "workspace" { return try parseObserveWorkspace(Array(arguments.dropFirst())) }
        guard target == "window" else { throw CLIParseError("expected 'observe window' or 'observe workspace'") }
        var params: [String: JSONValue] = [:]
        var url = defaultWMWebSocketURL
        var index = 1
        while index < arguments.count {
            switch arguments[index] {
            case "--pid":
                let raw = try value(after: &index, in: arguments)
                guard let pid = Int(raw), pid > 0 else { throw CLIParseError("invalid pid: \(raw)") }
                params["pid"] = .number(Double(pid))
            case "--exe": params["exe"] = .string(try value(after: &index, in: arguments))
            case "--app": params["app"] = .string(try value(after: &index, in: arguments))
            case "--id": params["window_id"] = .string(try value(after: &index, in: arguments))
            case "--url": url = try webSocketURL(try value(after: &index, in: arguments))
            default: throw CLIParseError("unknown observe window argument: \(arguments[index])")
            }
            index += 1
        }
        return .request(method: "observe.window", params: params, url: url)
    }

    private func parseObserveWorkspace(_ arguments: [String]) throws -> CLICommand {
        guard let name = arguments.first, !name.isEmpty else { throw CLIParseError("missing workspace name") }
        return .request(
            method: "observe.workspace",
            params: ["name": .string(name)],
            url: try parseURLOnly(Array(arguments.dropFirst()))
        )
    }

    private func parseWorkspace(_ arguments: [String]) throws -> CLICommand {
        guard let operation = arguments.first else { throw CLIParseError("missing workspace command") }
        let values = Array(arguments.dropFirst())
        switch operation {
        case "list": return try request("workspace.list", values)
        case "focus": return try parseWorkspaceFocus(values)
        case "move-window": return try parseWorkspaceMoveWindow(values)
        case "move-display": return try parseWorkspaceMoveDisplay(values)
        case "mode": return try parseWorkspaceMode(values)
        default: throw CLIParseError("unknown workspace command: \(operation)")
        }
    }

    private func parseWorkspaceFocus(_ arguments: [String]) throws -> CLICommand {
        guard let name = arguments.first, !name.isEmpty else { throw CLIParseError("missing workspace name") }
        var display: JSONValue = .null
        var url = defaultWMWebSocketURL
        var index = 1
        while index < arguments.count {
            switch arguments[index] {
            case "--display": display = .string(try value(after: &index, in: arguments))
            case "--url": url = try webSocketURL(try value(after: &index, in: arguments))
            default: throw CLIParseError("unknown workspace focus argument: \(arguments[index])")
            }
            index += 1
        }
        return .request(method: "workspace.focus", params: ["name": .string(name), "display_id": display], url: url)
    }

    private func parseWorkspaceMoveWindow(_ arguments: [String]) throws -> CLICommand {
        guard let workspace = arguments.first, !workspace.isEmpty else { throw CLIParseError("missing workspace name") }
        var windowIDs: [JSONValue] = []
        var url = defaultWMWebSocketURL
        var index = 1
        while index < arguments.count {
            if arguments[index] == "--url" {
                url = try webSocketURL(try value(after: &index, in: arguments))
            } else {
                guard !arguments[index].hasPrefix("-") else {
                    throw CLIParseError("unknown workspace move-window argument: \(arguments[index])")
                }
                windowIDs.append(.string(arguments[index]))
            }
            index += 1
        }
        return .request(method: "workspace.move_window", params: [
            "window_ids": .array(windowIDs), "workspace": .string(workspace),
        ], url: url)
    }

    private func parseWorkspaceMoveDisplay(_ arguments: [String]) throws -> CLICommand {
        guard arguments.count >= 2 else { throw CLIParseError("expected workspace name and display ID") }
        return .request(method: "workspace.move_display", params: [
            "workspace": .string(arguments[0]), "display_id": .string(arguments[1]),
        ], url: try parseURLOnly(Array(arguments.dropFirst(2))))
    }

    private func parseWorkspaceMode(_ arguments: [String]) throws -> CLICommand {
        guard arguments.count >= 2 else { throw CLIParseError("expected workspace name and mode") }
        guard ["bsp", "floating"].contains(arguments[1]) else {
            throw CLIParseError("invalid workspace mode: \(arguments[1])")
        }
        return .request(method: "workspace.set_mode", params: [
            "workspace": .string(arguments[0]), "mode": .string(arguments[1]),
        ], url: try parseURLOnly(Array(arguments.dropFirst(2))))
    }

    private func parseWindowFrame(_ arguments: [String]) throws -> CLICommand {
        guard let operation = arguments.first else { throw CLIParseError("expected 'window frame get' or 'window frame set'") }
        switch operation {
        case "get": return try parseFrameGet(Array(arguments.dropFirst()))
        case "set": return try parseFrameSet(Array(arguments.dropFirst()))
        default: throw CLIParseError("expected 'window frame get' or 'window frame set'")
        }
    }

    private func parseFrameGet(_ arguments: [String]) throws -> CLICommand {
        guard let windowID = arguments.first, !windowID.isEmpty else { throw CLIParseError("missing window ID") }
        return .request(
            method: "window.frame.get", params: ["window_id": .string(windowID)],
            url: try parseURLOnly(Array(arguments.dropFirst()))
        )
    }

    private func parseFrameSet(_ arguments: [String]) throws -> CLICommand {
        guard arguments.count >= 5 else { throw CLIParseError("expected window ID, x, y, width, and height") }
        let windowID = arguments[0]
        guard !windowID.isEmpty else { throw CLIParseError("missing window ID") }
        let names = ["x", "y", "width", "height"]
        var frame: [String: JSONValue] = [:]
        for (name, raw) in zip(names, arguments[1...4]) {
            guard let number = Double(raw), number.isFinite else { throw CLIParseError("invalid \(name): \(raw)") }
            if (name == "width" || name == "height") && number <= 0 { throw CLIParseError("\(name) must be greater than zero") }
            frame[name] = .number(number)
        }

        var tolerance = 1.0
        var attempts = 3
        var url = defaultWMWebSocketURL
        var index = 5
        while index < arguments.count {
            switch arguments[index] {
            case "--tolerance":
                let raw = try value(after: &index, in: arguments)
                guard let number = Double(raw), number.isFinite, (0...20).contains(number) else {
                    throw CLIParseError("tolerance must be between 0 and 20")
                }
                tolerance = number
            case "--attempts":
                let raw = try value(after: &index, in: arguments)
                guard let number = Int(raw), (1...5).contains(number) else {
                    throw CLIParseError("attempts must be between 1 and 5")
                }
                attempts = number
            case "--url": url = try webSocketURL(try value(after: &index, in: arguments))
            default: throw CLIParseError("unknown window frame set argument: \(arguments[index])")
            }
            index += 1
        }
        return .request(method: "window.frame.set", params: [
            "window_id": .string(windowID), "frame": .object(frame),
            "tolerance": .number(tolerance), "attempts": .number(Double(attempts)),
        ], url: url)
    }

    private func nestedRequest(
        _ parent: String,
        child: String,
        method: String,
        _ arguments: [String]
    ) throws -> CLICommand {
        guard arguments.first == child else { throw CLIParseError("expected '\(parent) \(child)'") }
        return try request(method, Array(arguments.dropFirst()))
    }

    private func request(_ method: String, _ arguments: [String]) throws -> CLICommand {
        .request(method: method, params: [:], url: try parseURLOnly(arguments))
    }

    private func parseURLOnly(_ arguments: [String]) throws -> URL {
        var url = defaultWMWebSocketURL
        var index = 0
        while index < arguments.count {
            guard arguments[index] == "--url" else { throw CLIParseError("unexpected argument: \(arguments[index])") }
            url = try webSocketURL(try value(after: &index, in: arguments))
            index += 1
        }
        return url
    }

    private func parseSubscription(_ arguments: [String]) throws -> SubscriptionConfiguration {
        var topics: [String] = []
        var projection = CLIProjection.delta
        var afterSequence: UInt64?
        var url = defaultWMWebSocketURL
        var index = 0
        while index < arguments.count {
            switch arguments[index] {
            case "--projection":
                let raw = try value(after: &index, in: arguments)
                guard let parsed = CLIProjection(rawValue: raw) else { throw CLIParseError("invalid projection: \(raw)") }
                projection = parsed
            case "--after-sequence":
                let raw = try value(after: &index, in: arguments)
                guard let parsed = UInt64(raw) else { throw CLIParseError("invalid sequence: \(raw)") }
                afterSequence = parsed
            case "--url": url = try webSocketURL(try value(after: &index, in: arguments))
            default:
                guard !arguments[index].hasPrefix("-") else { throw CLIParseError("unknown subscribe argument: \(arguments[index])") }
                topics.append(arguments[index])
            }
            index += 1
        }
        return SubscriptionConfiguration(topics: topics, projection: projection, afterSequence: afterSequence, url: url)
    }

    private func lifecycle(_ raw: String, _ arguments: [String], allowsForce: Bool) throws -> CLICommand {
        guard let command = LifecycleCommand(rawValue: raw) else { throw CLIParseError("unknown lifecycle command: \(raw)") }
        let force = arguments == ["--force"]
        guard arguments.isEmpty || (allowsForce && force) else { throw CLIParseError("unexpected argument for \(raw)") }
        return .lifecycle(command, force: force)
    }

    private func parseBenchmark(_ arguments: [String]) throws -> BenchmarkConfiguration {
        var result = BenchmarkConfiguration()
        var index = 0
        while index < arguments.count {
            switch arguments[index] {
            case "--iterations":
                let raw = try value(after: &index, in: arguments)
                guard let count = Int(raw), count > 0 else { throw CLIParseError("invalid iteration count: \(raw)") }
                result.iterations = count
            case "--url": result.url = try webSocketURL(try value(after: &index, in: arguments))
            default: throw CLIParseError("unknown benchmark argument: \(arguments[index])")
            }
            index += 1
        }
        return result
    }

    private func value(after index: inout Int, in arguments: [String]) throws -> String {
        index += 1
        guard index < arguments.count else { throw CLIParseError("missing value for \(arguments[index - 1])") }
        return arguments[index]
    }

    private func webSocketURL(_ raw: String) throws -> URL {
        guard let url = URL(string: raw), ["ws", "wss"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else {
            throw CLIParseError("invalid WebSocket URL: \(raw)")
        }
        return url
    }
}
