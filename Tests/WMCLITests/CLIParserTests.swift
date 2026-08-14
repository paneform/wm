import Foundation
import Testing
@testable import WMCLI

@Test func documentedCommandsMapToCanonicalMethods() throws {
    let parser = CLIParser()
    let mappings: [([String], String)] = [
        (["ping"], "daemon.ping"),
        (["state"], "state.get"),
        (["state", "observed"], "state.observed"),
        (["health"], "health.get"),
        (["display", "list"], "display.list"),
        (["monitor", "list"], "display.list"),
        (["window", "list"], "window.list"),
        (["diagnostics", "inventory"], "diagnostics.inventory"),
        (["inventory", "refresh"], "inventory.refresh"),
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

@Test func parsesDaemonAndClientOptions() throws {
    let parser = CLIParser()
    #expect(try parser.parse(["daemon", "--host", "localhost", "--port", "9000", "--allow-origin", "a", "--allow-origin", "b"]) == .daemon(.init(host: "localhost", port: 9000, allowedOrigins: ["a", "b"])))
    #expect(try parser.parse(["health", "--url", "wss://example.test/v1"]) == .request(method: "health.get", params: [:], url: URL(string: "wss://example.test/v1")!))
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
    #expect(try parser.parse(["start"]) == .lifecycle(.start, force: false))
    #expect(try parser.parse(["benchmark", "--iterations", "5"]) == .benchmark(.init(iterations: 5)))
}

@Test func rejectsInvalidArgumentsDeterministically() {
    #expect(throws: CLIParseError.self) { try CLIParser().parse([]) }
    #expect(throws: CLIParseError.self) { try CLIParser().parse(["monitor", "nope"]) }
    #expect(throws: CLIParseError.self) { try CLIParser().parse(["ping", "--url", "http://localhost"]) }
    #expect(throws: CLIParseError.self) { try CLIParser().parse(["subscribe", "--projection", "full"]) }
}
