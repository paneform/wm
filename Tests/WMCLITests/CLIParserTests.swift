import Foundation
import Testing
import WMConfiguration
@testable import WMCLI

@Test func parsesHelpCommands() throws {
    let parser = CLIParser()
    #expect(try parser.parseInvocation(["help"]) == .init(command: .help))
    #expect(try parser.parseInvocation(["--help"]) == .init(command: .help))
    #expect(try parser.parse(["help"]) == .help)
    #expect(throws: CLIParseError.self) { try parser.parseInvocation(["help", "extra"]) }
}

@Test func parsesPrettyAsGlobalFlag() throws {
    let parser = CLIParser()
    #expect(try parser.parseInvocation(["--pretty", "state"]) == .init(
        command: .request(method: "state.get", params: [:], url: defaultWMWebSocketURL), pretty: true
    ))
    #expect(try parser.parseInvocation(["state", "--pretty"]).pretty)
    #expect(try parser.parseInvocation(["state"]).pretty == false)
    #expect(throws: CLIParseError.self) { try parser.parseInvocation(["--pretty", "state", "--pretty"]) }
}

@Test func documentedCommandsMapToCanonicalMethods() throws {
    let parser = CLIParser()
    let mappings: [([String], String)] = [
        (["ping"], "daemon.ping"),
        (["pause"], "daemon.pause"),
        (["resume"], "daemon.resume"),
        (["state"], "state.get"),
        (["state", "observed"], "state.observed"),
        (["health"], "health.get"),
        (["display", "list"], "display.list"),
        (["monitor", "list"], "display.list"),
        (["window", "list"], "window.list"),
        (["window", "manage", "window:1"], "window.manage"),
        (["window", "unmanage", "window:1"], "window.unmanage"),
        (["window", "focus", "left"], "window.focus"),
        (["window", "move", "down"], "window.move"),
        (["observe", "window"], "observe.window"),
        (["observe", "workspace", "T"], "observe.workspace"),
        (["diagnostics", "inventory"], "diagnostics.inventory"),
        (["inventory", "refresh"], "inventory.refresh"),
        (["config", "reload"], "configuration.reload"),
        (["transaction", "get", "transaction:1"], "transaction.get"),
        (["batch", #"[{"method":"workspace.focus","params":{"name":"T"}}]"#], "command.batch"),
        (["workspace", "move-window-bulk", "T", "window:1"], "workspace.move_window_bulk"),
    ]
    for (arguments, expected) in mappings {
        guard case .request(let method, _, let url) = try parser.parse(arguments) else {
            Issue.record("expected request for \(arguments)")
            continue
        }
        #expect(method == expected)
        #expect(url == defaultWMWebSocketURL)
    }
}

@Test func parsesDirectionalWindowCommands() throws {
    #expect(try CLIParser().parse(["window", "focus", "left"]) == .request(
        method: "window.focus", params: ["direction": .string("left")], url: defaultWMWebSocketURL
    ))
    #expect(try CLIParser().parse(["window", "move", "right", "--url", "ws://localhost:9000/v1"]) == .request(
        method: "window.move", params: ["direction": .string("right")], url: URL(string: "ws://localhost:9000/v1")!
    ))
    #expect(throws: CLIParseError.self) { try CLIParser().parse(["window", "focus", "next"]) }
    #expect(throws: CLIParseError.self) { try CLIParser().parse(["window", "move"]) }
}

@Test func parsesPauseToggle() throws {
    #expect(try CLIParser().parse(["pause"]) == .request(
        method: "daemon.pause", params: [:], url: defaultWMWebSocketURL
    ))
    #expect(try CLIParser().parse(["pause", "--toggle", "--url", "ws://localhost:9000/v1"]) == .request(
        method: "daemon.pause", params: ["toggle": .bool(true)], url: URL(string: "ws://localhost:9000/v1")!
    ))
    #expect(throws: CLIParseError.self) { try CLIParser().parse(["pause", "--toggle", "--toggle"]) }
}

@Test func parsesPermissionsCommands() throws {
    #expect(try CLIParser().parse(["permissions"]) == .permissions(request: false))
    #expect(try CLIParser().parse(["permissions", "request"]) == .permissions(request: true))
    #expect(throws: CLIParseError.self) { try CLIParser().parse(["permissions", "unknown"]) }
}

@Test func parsesConfigurationCommandsWithWebSocketParity() throws {
    #expect(try CLIParser().parse(["config"]) == .configHelp)
    #expect(try CLIParser().parse(["config", "help"]) == .configHelp)
    #expect(try CLIParser().parse(["config", "--help"]) == .configHelp)
    #expect(try CLIParser().parse(["config", "validate"]) == .configValidate)
    #expect(try CLIParser().parse(["config", "example"]) == .configExample)
    #expect(try CLIParser().parse(["config", "init"]) == .configInit)
    #expect(try CLIParser().parse(["config", "adopt-state"]) == .configAdoptState(defaultWMWebSocketURL))
    #expect(try CLIParser().parse(["configuration", "reload", "--mode", "delta", "--trigger", "hotload"]) == .request(
        method: "configuration.reload", params: ["path": .string(ConfigurationFile.path().path), "mode": .string("delta"), "trigger": .string("hotload")], url: defaultWMWebSocketURL
    ))
    #expect(throws: CLIParseError.self) { try CLIParser().parse(["config", "reload", "--mode", "bad"]) }
}

@Test func parsesWindowManagementCommands() throws {
    #expect(try CLIParser().parse(["window", "manage", "window:1"]) == .request(
        method: "window.manage", params: ["window_id": .string("window:1")], url: defaultWMWebSocketURL
    ))
    #expect(try CLIParser().parse(["window", "unmanage", "window:2", "--url", "ws://localhost:9000/v1"]) == .request(
        method: "window.unmanage", params: ["window_id": .string("window:2")], url: URL(string: "ws://localhost:9000/v1")!
    ))
    #expect(throws: CLIParseError.self) { try CLIParser().parse(["window", "manage"]) }
}

@Test func parsesObserveWorkspace() throws {
    #expect(try CLIParser().parse(["observe", "workspace", "T"]) == .request(
        method: "observe.workspace", params: ["name": .string("T")], url: defaultWMWebSocketURL
    ))
    #expect(try CLIParser().parse([
        "observe", "workspace", "T", "--url", "wss://example.test/v1",
    ]) == .request(
        method: "observe.workspace", params: ["name": .string("T")], url: URL(string: "wss://example.test/v1")!
    ))
    #expect(throws: CLIParseError.self) { try CLIParser().parse(["observe", "workspace"]) }
}

@Test func parsesObserveWindowFilters() throws {
    #expect(try CLIParser().parse([
        "observe", "window", "--pid", "1930", "--exe", "Ghostty", "--app", "ghost", "--id", "window:cg:155",
    ]) == .request(method: "observe.window", params: [
        "pid": .number(1930), "exe": .string("Ghostty"), "app": .string("ghost"), "window_id": .string("window:cg:155"),
    ], url: defaultWMWebSocketURL))
    #expect(throws: CLIParseError.self) { try CLIParser().parse(["observe", "window", "--pid", "nope"]) }
}

@Test func parsesDaemonAndClientOptions() throws {
    let parser = CLIParser()
    #expect(try parser.parse(["daemon", "--host", "localhost", "--port", "9000", "--allow-origin", "https://a.test", "--allow-origin", "http://b.test"]) == .daemon(.init(host: "localhost", port: 9000, allowedOrigins: ["https://a.test", "http://b.test"])))
    #expect(try parser.parse(["health", "--url", "wss://example.test/v1"]) == .request(method: "health.get", params: [:], url: URL(string: "wss://example.test/v1")!))
}

@Test func rejectsUnsafeDaemonBindAndOrigins() {
    #expect(throws: CLIParseError.self) { try CLIParser().parse(["daemon", "--host", "0.0.0.0"]) }
    #expect(throws: CLIParseError.self) { try CLIParser().parse(["daemon", "--allow-origin", "file:///tmp/x"]) }
    #expect(throws: CLIParseError.self) { try CLIParser().parse(["daemon", "--allow-origin", "https://user@example.test"]) }
}

@Test func parsesWindowFrameCommandsWithCanonicalParams() throws {
    let parser = CLIParser()
    #expect(try parser.parse(["window", "frame", "get", "window:1"]) == .request(
        method: "window.frame.get", params: ["window_id": .string("window:1")], url: defaultWMWebSocketURL
    ))
    #expect(try parser.parse([
        "window", "frame", "set", "window:1", "100", "-20.5", "900", "700",
        "--attempts", "5", "--tolerance", "0.5", "--url", "wss://example.test/v1",
    ]) == .request(method: "window.frame.set", params: [
        "window_id": .string("window:1"),
        "frame": .object(["x": .number(100), "y": .number(-20.5), "width": .number(900), "height": .number(700)]),
        "tolerance": .number(0.5), "attempts": .number(5),
    ], url: URL(string: "wss://example.test/v1")!))
}

@Test func rejectsInvalidWindowFrameBeforeRequest() {
    let invalid: [[String]] = [
        ["window", "frame", "get"],
        ["window", "frame", "set", "window:1", "x", "0", "1", "1"],
        ["window", "frame", "set", "window:1", "0", "0", "0", "1"],
        ["window", "frame", "set", "window:1", "0", "0", "1", "1", "--tolerance", "21"],
        ["window", "frame", "set", "window:1", "0", "0", "1", "1", "--attempts", "6"],
    ]
    for arguments in invalid {
        #expect(throws: CLIParseError.self) { try CLIParser().parse(arguments) }
    }
}

@Test func parsesRawAXDebugCommands() throws {
    let parser = CLIParser()
    #expect(try parser.parse(["debug", "ax", "focus", "window:1"]) == .request(
        method: "debug.ax.focus", params: ["window_id": .string("window:1")], url: defaultWMWebSocketURL
    ))
    #expect(try parser.parse(["debug", "ax", "frame", "get", "window:1"]) == .request(
        method: "debug.ax.frame.get", params: ["window_id": .string("window:1")], url: defaultWMWebSocketURL
    ))
    #expect(try parser.parse([
        "debug", "ax", "frame", "set", "window:1", "-1030", "-1408", "3440", "1408",
        "size_position_size", "--settle-ms", "600",
    ]) == .request(method: "debug.ax.frame.set", params: [
        "window_id": .string("window:1"),
        "frame": .object(["x": .number(-1030), "y": .number(-1408), "width": .number(3440), "height": .number(1408)]),
        "order": .string("size_position_size"), "settle_ms": .number(600),
    ], url: defaultWMWebSocketURL))
    #expect(throws: CLIParseError.self) {
        try parser.parse(["debug", "ax", "frame", "set", "window:1", "0", "0", "1", "1", "unknown"])
    }
}

@Test func parsesEngineDebugCommands() throws {
    let parser = CLIParser()
    #expect(try parser.parse(["debug", "engine", "get"]) == .request(
        method: "debug.engine.get", params: [:], url: defaultWMWebSocketURL
    ))
    #expect(try parser.parse(["debug", "engine", "set", "automatic-reconciliation", "off"]) == .request(
        method: "debug.engine.set", params: ["automatic_reconciliation": .bool(false)], url: defaultWMWebSocketURL
    ))
}

@Test func parsesSubscriptionInAnyOptionOrder() throws {
    let command = try CLIParser().parse([
        "subscribe", "window.inventory", "--url", "ws://localhost:9000/v1",
        "health.changed", "--after-sequence", "42", "--projection", "snapshot",
    ])
    #expect(command == .subscribe(.init(
        topics: ["window.inventory", "health.changed"], projection: .snapshot,
        afterSequence: 42, url: URL(string: "ws://localhost:9000/v1")!
    )))
}

@Test func parsesLifecycleAndBenchmark() throws {
    let parser = CLIParser()
    #expect(try parser.parse(["stop", "--force"]) == .lifecycle(.stop, force: true))
    #expect(try parser.parse(["restart", "--force"]) == .lifecycle(.restart, force: true))
    #expect(try parser.parse(["start"]) == .lifecycle(.start, force: false))
    #expect(try parser.parse(["start", "--manual"]) == .lifecycle(.start, force: false, manual: true))
    #expect(try parser.parse(["restart", "--manual", "--force"]) == .lifecycle(.restart, force: true, manual: true))
    #expect(try parser.parse(["install"]) == .lifecycle(.install, force: false))
    #expect(try parser.parse(["uninstall"]) == .lifecycle(.uninstall, force: false))
    #expect(throws: CLIParseError.self) { try parser.parse(["install-service"]) }
    #expect(throws: CLIParseError.self) { try parser.parse(["uninstall-service"]) }
    #expect(try parser.parse(["benchmark", "--iterations", "5"]) == .benchmark(.init(iterations: 5)))
}

@Test func rejectsInvalidArgumentsDeterministically() {
    #expect(throws: CLIParseError.self) { try CLIParser().parse([]) }
    #expect(throws: CLIParseError.self) { try CLIParser().parse(["monitor", "nope"]) }
    #expect(throws: CLIParseError.self) { try CLIParser().parse(["ping", "--url", "http://localhost"]) }
    #expect(throws: CLIParseError.self) { try CLIParser().parse(["subscribe", "--projection", "full"]) }
}

@Test func parsesWorkspaceCommandsWithCanonicalParams() throws {
    let parser = CLIParser()
    #expect(try parser.parse(["workspace", "list"]) == .request(
        method: "workspace.list", params: [:], url: defaultWMWebSocketURL
    ))
    #expect(try parser.parse(["workspace", "focus", "T"]) == .request(
        method: "workspace.focus", params: ["name": .string("T"), "display_id": .null], url: defaultWMWebSocketURL
    ))
    #expect(try parser.parse(["workspace", "focus", "T", "--display", "display:2"]) == .request(
        method: "workspace.focus", params: ["name": .string("T"), "display_id": .string("display:2")], url: defaultWMWebSocketURL
    ))
    #expect(try parser.parse(["workspace", "move-window", "T"]) == .request(
        method: "workspace.move_window", params: ["workspace": .string("T"), "window_ids": .array([])], url: defaultWMWebSocketURL
    ))
    #expect(try parser.parse(["workspace", "move-window", "T", "window:1", "window:2"]) == .request(
        method: "workspace.move_window", params: [
            "workspace": .string("T"), "window_ids": .array([.string("window:1"), .string("window:2")]),
        ], url: defaultWMWebSocketURL
    ))
    #expect(try parser.parse(["workspace", "move", "T", "display:2"]) == .request(
        method: "workspace.move_display", params: ["workspace": .string("T"), "display_id": .string("display:2")], url: defaultWMWebSocketURL
    ))
    #expect(try parser.parse(["workspace", "move", "T", "--cg", "1"]) == .request(
        method: "workspace.move_display", params: [
            "workspace": .string("T"), "display_selector": .object(["core_graphics_display_id": .string("1")]),
        ], url: defaultWMWebSocketURL
    ))
    #expect(try parser.parse(["workspace", "move", "T", "--ns_screen_number", "2"]) == .request(
        method: "workspace.move_display", params: [
            "workspace": .string("T"), "display_selector": .object(["ns_screen_number": .string("2")]),
        ], url: defaultWMWebSocketURL
    ))
    #expect(try parser.parse(["workspace", "move", "T", "--name", "Built-in Retina Display"]) == .request(
        method: "workspace.move_display", params: [
            "workspace": .string("T"), "display_selector": .object(["name": .string("Built-in Retina Display")]),
        ], url: defaultWMWebSocketURL
    ))
    #expect(try parser.parse(["workspace", "move", "next"]) == .request(
        method: "workspace.move_display", params: ["next": .bool(true)], url: defaultWMWebSocketURL
    ))
    #expect(try parser.parse(["workspace", "move", "next", "T"]) == .request(
        method: "workspace.move_display", params: ["next": .bool(true), "workspace": .string("T")], url: defaultWMWebSocketURL
    ))
    #expect(try parser.parse(["workspace", "mode", "T", "floating"]) == .request(
        method: "workspace.set_mode", params: ["workspace": .string("T"), "mode": .string("floating")], url: defaultWMWebSocketURL
    ))
    #expect(try parser.parse(["layout-policy", "stack,overflow"]) == .request(
        method: "layout_policy.set", params: ["policy": .array([.string("stack"), .string("overflow")])], url: defaultWMWebSocketURL
    ))
    #expect(try parser.parse(["workspace", "layout-policy", "T", "reject"]) == .request(
        method: "layout_policy.set",
        params: ["workspace": .string("T"), "policy": .array([.string("reject")])], url: defaultWMWebSocketURL
    ))
    #expect(try parser.parse(["geometry-policy", "--max-retries", "4", "--profile-mode", "store"]) == .request(
        method: "geometry_policy.set", params: [
            "max_geometry_retries": .number(4), "geometry_profile_mode": .string("store"),
        ], url: defaultWMWebSocketURL
    ))
    #expect(try parser.parse(["geometry-policy", "T", "--profile-mode", "optimistic"]) == .request(
        method: "geometry_policy.set", params: [
            "workspace": .string("T"), "geometry_profile_mode": .string("optimistic"),
        ], url: defaultWMWebSocketURL
    ))
}

@Test func rejectsInvalidWorkspaceCommands() {
    let invalid = [
        ["workspace"], ["workspace", "focus"], ["workspace", "move-window"],
        ["workspace", "move", "T"], ["workspace", "move-display", "T", "display:1"],
        ["workspace", "mode", "T", "stacked"],
        ["layout-policy", "float"],
        ["geometry-policy"], ["geometry-policy", "--max-retries", "0"],
        ["geometry-policy", "--profile-mode", "cached"],
    ]
    for arguments in invalid {
        #expect(throws: CLIParseError.self) { try CLIParser().parse(arguments) }
    }
}

@Test func parsesCompactAndVerboseDisplayLists() throws {
    #expect(try CLIParser().parse(["display", "list"]) == .request(
        method: "display.list", params: ["verbose": .bool(false)], url: defaultWMWebSocketURL
    ))
    #expect(try CLIParser().parse(["display", "list", "--verbose"]) == .request(
        method: "display.list", params: ["verbose": .bool(true)], url: defaultWMWebSocketURL
    ))
}
