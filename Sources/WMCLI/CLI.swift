import Foundation
import WMConfiguration
import WMProtocol

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
    public var detail: SnapshotDetail
    public var afterSequence: UInt64?
    public var url: URL

    public init(
        topics: [String],
        projection: CLIProjection = .delta,
        detail: SnapshotDetail = .concise,
        afterSequence: UInt64? = nil,
        url: URL = defaultWMWebSocketURL
    ) {
        self.topics = topics
        self.projection = projection
        self.detail = detail
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
    case install
    case uninstall
}

public enum CLICommand: Sendable, Equatable {
    case help
    case configHelp
    case configExample
    case configInit
    case configValidate
    case configAdoptState(URL)
    case permissions(request: Bool)
    case daemon(DaemonConfiguration)
    case request(method: String, params: [String: JSONValue] = [:], url: URL)
    case subscribe(SubscriptionConfiguration)
    case lifecycle(LifecycleCommand, force: Bool, manual: Bool = false)
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
        if arguments == ["help"] || arguments == ["--help"] {
            return CLIInvocation(command: .help)
        }
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
        case "help", "--help":
            guard rest.isEmpty else { throw CLIParseError("unexpected argument for help") }
            return .help
        case "daemon": return .daemon(try parseDaemon(rest))
        case "ping": return try request("daemon.ping", rest)
        case "pause": return try parsePause(rest)
        case "resume": return try request("daemon.resume", rest)
        case "state": return try parseState(rest)
        case "health": return try request("health.get", rest)
        case "permissions": return try parsePermissions(rest)
        case "display": return try parseDisplay(rest, command: "display")
        case "monitor": return try parseDisplay(rest, command: "monitor")
        case "window": return try parseWindow(rest)
        case "debug": return try parseDebug(rest)
        case "observe": return try parseObserve(rest)
        case "workspace": return try parseWorkspace(rest)
        case "layout-policy": return try parseLayoutPolicy(rest)
        case "geometry-policy": return try parseGeometryPolicy(rest)
        case "diagnostics": return try nestedRequest("diagnostics", child: "inventory", method: "diagnostics.inventory", rest)
        case "inventory": return try nestedRequest("inventory", child: "refresh", method: "inventory.refresh", rest)
        case "config", "configuration": return try parseConfiguration(rest)
        case "transaction": return try parseTransaction(rest)
        case "batch": return try parseBatch(rest)
        case "subscribe": return .subscribe(try parseSubscription(rest))
        case "start": return try lifecycle(command, rest, allowsForce: false, allowsManual: true)
        case "install", "uninstall": return try lifecycle(command, rest, allowsForce: false)
        case "stop": return try lifecycle(command, rest, allowsForce: true)
        case "restart": return try lifecycle(command, rest, allowsForce: true, allowsManual: true)
        case "benchmark": return .benchmark(try parseBenchmark(rest))
        case "verify": return .verify(try parseURLOnly(rest))
        default: throw CLIParseError("unknown command: \(command)")
        }
    }

    private func parseTransaction(_ arguments: [String]) throws -> CLICommand {
        guard arguments.first == "get", arguments.count >= 2 else { throw CLIParseError("expected 'transaction get ID'") }
        return .request(method: "transaction.get", params: ["transaction_id": .string(arguments[1])],
                        url: try parseURLOnly(Array(arguments.dropFirst(2))))
    }

    private func parsePermissions(_ arguments: [String]) throws -> CLICommand {
        switch arguments {
        case []: .permissions(request: false)
        case ["request"]: .permissions(request: true)
        default: throw CLIParseError("expected 'permissions' or 'permissions request'")
        }
    }

    private func parsePause(_ arguments: [String]) throws -> CLICommand {
        var toggle = false
        var url = defaultWMWebSocketURL
        var index = 0
        while index < arguments.count {
            switch arguments[index] {
            case "--toggle":
                guard !toggle else { throw CLIParseError("duplicate --toggle flag") }
                toggle = true
            case "--url": url = try webSocketURL(try value(after: &index, in: arguments))
            default: throw CLIParseError("unexpected pause argument: \(arguments[index])")
            }
            index += 1
        }
        return .request(method: "daemon.pause", params: toggle ? ["toggle": .bool(true)] : [:], url: url)
    }

    private func parseConfiguration(_ arguments: [String]) throws -> CLICommand {
        guard let operation = arguments.first else { return .configHelp }
        switch operation {
        case "help", "--help":
            guard arguments.count == 1 else { throw CLIParseError("unexpected argument for config help") }
            return .configHelp
        case "example":
            guard arguments.count == 1 else { throw CLIParseError("unexpected argument for config example") }
            return .configExample
        case "init":
            guard arguments.count == 1 else { throw CLIParseError("unexpected argument for config init") }
            return .configInit
        case "validate":
            guard arguments.count == 1 else { throw CLIParseError("unexpected argument for config validate") }
            return .configValidate
        case "adopt-state": return .configAdoptState(try parseURLOnly(Array(arguments.dropFirst())))
        case "reload": break
        default: throw CLIParseError("unknown config command: \(operation)")
        }
        let path = ConfigurationFile.path().path
        var params: [String: JSONValue] = ["path": .string(path)]
        var url = defaultWMWebSocketURL, index = 1
        while index < arguments.count {
            switch arguments[index] {
            case "--mode":
                let mode = try value(after: &index, in: arguments)
                guard ["delta", "full"].contains(mode) else { throw CLIParseError("invalid reload mode: \(mode)") }
                params["mode"] = .string(mode)
            case "--trigger":
                let trigger = try value(after: &index, in: arguments)
                guard ["hotload", "explicit"].contains(trigger) else { throw CLIParseError("invalid reload trigger: \(trigger)") }
                params["trigger"] = .string(trigger)
            case "--url": url = try webSocketURL(try value(after: &index, in: arguments))
            default: throw CLIParseError("unknown configuration argument: \(arguments[index])")
            }
            index += 1
        }
        return .request(method: "configuration.\(operation)", params: params, url: url)
    }

    private func parseBatch(_ arguments: [String]) throws -> CLICommand {
        guard let raw = arguments.first, arguments.count >= 1 else { throw CLIParseError("expected batch JSON") }
        guard let data = raw.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              case .array(let commands) = value else { throw CLIParseError("batch must be a JSON array") }
        return .request(method: "command.batch", params: ["commands": .array(commands)],
                        url: try parseURLOnly(Array(arguments.dropFirst())))
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
        case "focus", "move": return try parseWindowDirectional(child, Array(arguments.dropFirst()))
        case "frame": return try parseWindowFrame(Array(arguments.dropFirst()))
        default: throw CLIParseError("unknown window command: \(child)")
        }
    }

    private func parseWindowDirectional(_ operation: String, _ arguments: [String]) throws -> CLICommand {
        guard let direction = arguments.first,
              ["left", "down", "up", "right"].contains(direction) else {
            throw CLIParseError("expected 'window \(operation) left|down|up|right'")
        }
        return .request(
            method: "window.\(operation)", params: ["direction": .string(direction)],
            url: try parseURLOnly(Array(arguments.dropFirst()))
        )
    }

    private func parseDebug(_ arguments: [String]) throws -> CLICommand {
        guard let target = arguments.first else { throw CLIParseError("expected 'debug ax' or 'debug engine'") }
        switch target {
        case "ax": return try parseDebugAX(Array(arguments.dropFirst()))
        case "engine": return try parseDebugEngine(Array(arguments.dropFirst()))
        default: throw CLIParseError("expected 'debug ax' or 'debug engine'")
        }
    }

    private func parseDebugAX(_ arguments: [String]) throws -> CLICommand {
        if arguments.first == "probe" {
            guard arguments.count >= 2, !arguments[1].isEmpty else { throw CLIParseError("expected 'debug ax probe WINDOW_ID'") }
            return .request(method: "geometry.capability.probe", params: ["window_id": .string(arguments[1])], url: try parseURLOnly(Array(arguments.dropFirst(2))))
        }
        if arguments.first == "focus" {
            guard arguments.count >= 2, !arguments[1].isEmpty else { throw CLIParseError("missing window ID") }
            return .request(
                method: "debug.ax.focus", params: ["window_id": .string(arguments[1])],
                url: try parseURLOnly(Array(arguments.dropFirst(2)))
            )
        }
        guard arguments.first == "frame", arguments.count >= 3 else {
            throw CLIParseError("expected 'debug ax focus WINDOW_ID' or 'debug ax frame get|set WINDOW_ID'")
        }
        let operation = arguments[1]
        let values = Array(arguments.dropFirst(2))
        if operation == "get" {
            guard let windowID = values.first, !windowID.isEmpty else { throw CLIParseError("missing window ID") }
            return .request(method: "debug.ax.frame.get", params: ["window_id": .string(windowID)], url: try parseURLOnly(Array(values.dropFirst())))
        }
        guard operation == "set", values.count >= 6 else {
            throw CLIParseError("expected window ID, x, y, width, height, and write order")
        }
        let windowID = values[0]
        let names = ["x", "y", "width", "height"]
        var frame: [String: JSONValue] = [:]
        for (name, raw) in zip(names, values[1...4]) {
            guard let number = Double(raw), number.isFinite else { throw CLIParseError("invalid \(name): \(raw)") }
            if ["width", "height"].contains(name), number <= 0 { throw CLIParseError("\(name) must be greater than zero") }
            frame[name] = .number(number)
        }
        guard DebugAXWriteOrder(rawValue: values[5]) != nil else { throw CLIParseError("invalid AX write order: \(values[5])") }
        var settle = 0, url = defaultWMWebSocketURL, index = 6
        while index < values.count {
            switch values[index] {
            case "--settle-ms":
                let raw = try value(after: &index, in: values)
                guard let milliseconds = Int(raw), (0...10_000).contains(milliseconds) else {
                    throw CLIParseError("settle-ms must be between 0 and 10000")
                }
                settle = milliseconds
            case "--url": url = try webSocketURL(try value(after: &index, in: values))
            default: throw CLIParseError("unknown debug ax argument: \(values[index])")
            }
            index += 1
        }
        return .request(method: "debug.ax.frame.set", params: [
            "window_id": .string(windowID), "frame": .object(frame), "order": .string(values[5]),
            "settle_ms": .number(Double(settle)),
        ], url: url)
    }

    private func parseDebugEngine(_ arguments: [String]) throws -> CLICommand {
        guard let operation = arguments.first else { throw CLIParseError("expected 'debug engine get|set'") }
        if operation == "get" { return try request("debug.engine.get", Array(arguments.dropFirst())) }
        guard operation == "set", arguments.count >= 3, arguments[1] == "automatic-reconciliation",
              let enabled = ["on": true, "off": false][arguments[2]] else {
            throw CLIParseError("expected 'debug engine set automatic-reconciliation on|off'")
        }
        return .request(
            method: "debug.engine.set", params: ["automatic_reconciliation": .bool(enabled)],
            url: try parseURLOnly(Array(arguments.dropFirst(3)))
        )
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
        case "move-window-bulk": return try parseWorkspaceMoveWindowBulk(values)
        case "move": return try parseWorkspaceMoveDisplay(values)
        case "mode": return try parseWorkspaceMode(values)
        case "layout-policy": return try parseLayoutPolicy(values, workspace: true)
        default: throw CLIParseError("unknown workspace command: \(operation)")
        }
    }

    private func parseLayoutPolicy(
        _ arguments: [String], workspace: Bool = false
    ) throws -> CLICommand {
        let policyIndex = workspace ? 1 : 0
        guard arguments.count > policyIndex else {
            throw CLIParseError(workspace ? "expected workspace name and policy" : "expected policy")
        }
        let policy = arguments[policyIndex].split(separator: ",").map(String.init)
        guard !policy.isEmpty, Set(policy).count == policy.count,
              policy.allSatisfy({ ["greedy", "overlap", "stack", "overflow", "reject"].contains($0) }),
              policy.firstIndex(of: "reject").map({ $0 == policy.count - 1 }) != false else {
            throw CLIParseError("invalid layout policy chain")
        }
        var params: [String: JSONValue] = ["policy": .array(policy.map(JSONValue.string))]
        if workspace { params["workspace"] = .string(arguments[0]) }
        return .request(
            method: "layout_policy.set", params: params,
            url: try parseURLOnly(Array(arguments.dropFirst(policyIndex + 1)))
        )
    }

    private func parseGeometryPolicy(_ arguments: [String]) throws -> CLICommand {
        var params: [String: JSONValue] = [:]
        var url = defaultWMWebSocketURL, index = 0
        if let first = arguments.first, !first.hasPrefix("-") {
            params["workspace"] = .string(first)
            index = 1
        }
        while index < arguments.count {
            switch arguments[index] {
            case "--max-retries":
                let raw = try value(after: &index, in: arguments)
                guard let retries = Int(raw), (1...5).contains(retries) else {
                    throw CLIParseError("max-retries must be between 1 and 5")
                }
                params["max_geometry_retries"] = .number(Double(retries))
            case "--profile-mode":
                let mode = try value(after: &index, in: arguments)
                guard ["store", "infer", "optimistic"].contains(mode) else {
                    throw CLIParseError("invalid geometry profile mode: \(mode)")
                }
                params["geometry_profile_mode"] = .string(mode)
            case "--url": url = try webSocketURL(try value(after: &index, in: arguments))
            default: throw CLIParseError("unknown geometry-policy argument: \(arguments[index])")
            }
            index += 1
        }
        guard params["max_geometry_retries"] != nil || params["geometry_profile_mode"] != nil else {
            throw CLIParseError("geometry-policy requires --max-retries or --profile-mode")
        }
        return .request(method: "geometry_policy.set", params: params, url: url)
    }

    private func parseWorkspaceFocus(_ arguments: [String]) throws -> CLICommand {
        guard let name = arguments.first, !name.isEmpty else { throw CLIParseError("missing workspace name") }
        var display: JSONValue = .null, selector: JSONValue?
        var url = defaultWMWebSocketURL
        var index = 1
        while index < arguments.count {
            switch arguments[index] {
            case "--display": display = .string(try value(after: &index, in: arguments))
            case "--cg", "--core-graphics-display-id", "--core_graphics_display_id":
                selector = try displaySelector("core_graphics_display_id", value: value(after: &index, in: arguments), existing: selector)
            case "--ns", "--ns-screen-number", "--ns_screen_number":
                selector = try displaySelector("ns_screen_number", value: value(after: &index, in: arguments), existing: selector)
            case "--name":
                selector = try displaySelector("name", value: value(after: &index, in: arguments), existing: selector)
            case "--url": url = try webSocketURL(try value(after: &index, in: arguments))
            default: throw CLIParseError("unknown workspace focus argument: \(arguments[index])")
            }
            index += 1
        }
        var params: [String: JSONValue] = ["name": .string(name), "display_id": display]
        if let selector { params["display_selector"] = selector }
        return .request(method: "workspace.focus", params: params, url: url)
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

    private func parseWorkspaceMoveWindowBulk(_ arguments: [String]) throws -> CLICommand {
        guard let workspace = arguments.first, !workspace.isEmpty else { throw CLIParseError("missing workspace name") }
        var ids: [JSONValue] = [], url = defaultWMWebSocketURL, index = 1
        while index < arguments.count {
            if arguments[index] == "--url" { url = try webSocketURL(try value(after: &index, in: arguments)) }
            else {
                guard !arguments[index].hasPrefix("-") else { throw CLIParseError("unknown bulk argument: \(arguments[index])") }
                ids.append(.string(arguments[index]))
            }
            index += 1
        }
        guard !ids.isEmpty, ids.count <= 128 else { throw CLIParseError("bulk requires 1...128 window IDs") }
        return .request(method: "workspace.move_window_bulk", params: ["workspace": .string(workspace), "window_ids": .array(ids)], url: url)
    }

    private func parseWorkspaceMoveDisplay(_ arguments: [String]) throws -> CLICommand {
        guard let first = arguments.first, !first.isEmpty else { throw CLIParseError("missing workspace name") }
        if first == "next" {
            var params: [String: JSONValue] = ["next": .bool(true)]
            var index = 1
            if index < arguments.count, !arguments[index].hasPrefix("-") {
                params["workspace"] = .string(arguments[index]); index += 1
            }
            return .request(
                method: "workspace.move_display", params: params,
                url: try parseURLOnly(Array(arguments.dropFirst(index)))
            )
        }
        let workspace = first
        var params: [String: JSONValue] = ["workspace": .string(workspace)]
        var url = defaultWMWebSocketURL, selector: JSONValue?, index = 1
        if index < arguments.count, !arguments[index].hasPrefix("-") {
            params["display_id"] = .string(arguments[index]); index += 1
        }
        while index < arguments.count {
            switch arguments[index] {
            case "--cg", "--core-graphics-display-id", "--core_graphics_display_id":
                selector = try displaySelector("core_graphics_display_id", value: value(after: &index, in: arguments), existing: selector)
            case "--ns", "--ns-screen-number", "--ns_screen_number":
                selector = try displaySelector("ns_screen_number", value: value(after: &index, in: arguments), existing: selector)
            case "--name": selector = try displaySelector("name", value: value(after: &index, in: arguments), existing: selector)
            case "--url": url = try webSocketURL(try value(after: &index, in: arguments))
            default: throw CLIParseError("unknown workspace move argument: \(arguments[index])")
            }
            index += 1
        }
        guard params["display_id"] != nil || selector != nil else { throw CLIParseError("display selector is required") }
        guard !(params["display_id"] != nil && selector != nil) else { throw CLIParseError("specify one display selector") }
        if let selector { params["display_selector"] = selector }
        return .request(method: "workspace.move_display", params: params, url: url)
    }

    private func parseDisplay(_ arguments: [String], command: String) throws -> CLICommand {
        guard arguments.first == "list" else { throw CLIParseError("expected '\(command) list'") }
        var params: [String: JSONValue] = ["verbose": .bool(false)]
        var url = defaultWMWebSocketURL, index = 1
        while index < arguments.count {
            switch arguments[index] {
            case "--verbose": params["verbose"] = .bool(true)
            case "--url": url = try webSocketURL(try value(after: &index, in: arguments))
            default: throw CLIParseError("unknown \(command) list argument: \(arguments[index])")
            }
            index += 1
        }
        return .request(method: "display.list", params: params, url: url)
    }

    private func displaySelector(_ key: String, value: String, existing: JSONValue?) throws -> JSONValue {
        guard existing == nil, !value.isEmpty else { throw CLIParseError("specify one display selector") }
        return .object([key: .string(value)])
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
        var detail = SnapshotDetail.concise
        var afterSequence: UInt64?
        var url = defaultWMWebSocketURL
        var index = 0
        while index < arguments.count {
            switch arguments[index] {
            case "--projection":
                let raw = try value(after: &index, in: arguments)
                guard let parsed = CLIProjection(rawValue: raw) else { throw CLIParseError("invalid projection: \(raw)") }
                projection = parsed
            case "--detail":
                let raw = try value(after: &index, in: arguments)
                guard let parsed = SnapshotDetail(rawValue: raw) else { throw CLIParseError("invalid detail: \(raw)") }
                detail = parsed
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
        return SubscriptionConfiguration(topics: topics, projection: projection, detail: detail, afterSequence: afterSequence, url: url)
    }

    private func lifecycle(
        _ raw: String, _ arguments: [String], allowsForce: Bool, allowsManual: Bool = false
    ) throws -> CLICommand {
        guard let command = LifecycleCommand(rawValue: raw) else { throw CLIParseError("unknown lifecycle command: \(raw)") }
        let force = arguments.contains("--force")
        let manual = arguments.contains("--manual")
        guard arguments.count == Set(arguments).count,
              arguments.allSatisfy({ ($0 == "--force" && allowsForce) || ($0 == "--manual" && allowsManual) })
        else { throw CLIParseError("unexpected argument for \(raw)") }
        return .lifecycle(command, force: force, manual: manual)
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
