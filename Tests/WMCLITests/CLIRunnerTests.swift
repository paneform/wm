import Foundation
import Testing
@testable import WMCLI

private actor Capture {
    var stdout: [Data] = []
    var stderr: [Data] = []
    func out(_ data: Data) { stdout.append(data) }
    func err(_ data: Data) { stderr.append(data) }
}

private final class MockClient: CLIWebSocketClient, @unchecked Sendable {
    private let lock = NSLock()
    var requests: [(Data, URL)] = []
    let response: CLIResponse
    let events: [Data]

    init(response: CLIResponse = .init(json: Data(#"{"type":"response","ok":true}"#.utf8), ok: true), events: [Data] = []) {
        self.response = response
        self.events = events
    }

    func request(_ message: Data, at url: URL) async throws -> CLIResponse {
        lock.withLock { requests.append((message, url)) }
        return response
    }

    func subscribe(_ message: Data, at url: URL) -> AsyncThrowingStream<Data, Error> {
        return AsyncThrowingStream { continuation in
            for event in events { continuation.yield(event) }
            continuation.finish()
        }
    }

    func capturedRequests() -> [(Data, URL)] {
        lock.withLock { requests }
    }
}

@Test func helpWritesStructuredTextWithoutInvokingClient() async throws {
    let capture = Capture()
    let client = MockClient()
    let runner = CLIRunner(client: client, output: .init(
        stdout: { data in Task { await capture.out(data) } },
        stderr: { data in Task { await capture.err(data) } }
    ))

    #expect(await runner.run(arguments: ["--help"]) == .success)
    try await Task.sleep(for: .milliseconds(10))
    let help = String(decoding: try #require(await capture.stdout.first), as: UTF8.self)
    #expect(help.contains("COMMANDS\n"))
    #expect(help.contains("    frame set WINDOW_ID X Y WIDTH HEIGHT"))
    #expect(help.contains("GLOBAL FLAGS\n  --pretty"))
    #expect(help.hasSuffix("\n"))
    #expect(await capture.stderr.isEmpty)
    #expect(client.capturedRequests().isEmpty)
}

@Test func runnerBuildsCanonicalRequestAndEmitsJSONLine() async throws {
    let capture = Capture()
    let client = MockClient()
    let output = CLIOutput(
        stdout: { data in Task { await capture.out(data) } },
        stderr: { data in Task { await capture.err(data) } }
    )
    let runner = CLIRunner(client: client, output: output, id: { "req-1" })
    #expect(await runner.run(arguments: ["state"]) == .success)
    try await Task.sleep(for: .milliseconds(10))
    let sent = client.capturedRequests()
    #expect(sent.count == 1)
    let json = try #require(JSONSerialization.jsonObject(with: sent[0].0) as? [String: Any])
    #expect(json["type"] as? String == "request")
    #expect(json["request_id"] as? String == "req-1")
    #expect(json["method"] as? String == "state.get")
    #expect((json["params"] as? [String: Any])?.isEmpty == true)
    #expect(await capture.stdout.first?.last == 0x0A)
    #expect(await capture.stderr.isEmpty)
}

@Test func daemonErrorResponseProducesFailureExit() async throws {
    let capture = Capture()
    let client = MockClient(response: .init(json: Data(#"{"type":"response","ok":false}"#.utf8), ok: false))
    let runner = CLIRunner(client: client, output: .init(
        stdout: { data in Task { await capture.out(data) } },
        stderr: { data in Task { await capture.err(data) } }
    ))
    #expect(await runner.run(arguments: ["ping"]) == .commandFailed)
}

@Test func frameSetSendsCanonicalParamsAndPassesThroughJSONResponse() async throws {
    let response = Data(#"{"type":"response","request_id":"req-1","ok":true,"result":{"verified":true},"state_version":1}"#.utf8)
    let capture = Capture()
    let client = MockClient(response: .init(json: response, ok: true))
    let runner = CLIRunner(client: client, output: .init(
        stdout: { data in Task { await capture.out(data) } },
        stderr: { data in Task { await capture.err(data) } }
    ), id: { "req-1" })

    #expect(await runner.run(arguments: ["window", "frame", "set", "window:1", "1", "2", "800", "600"]) == .success)
    try await Task.sleep(for: .milliseconds(10))
    let sent = try #require(client.capturedRequests().first)
    let json = try #require(JSONSerialization.jsonObject(with: sent.0) as? [String: Any])
    #expect(json["method"] as? String == "window.frame.set")
    let params = try #require(json["params"] as? [String: Any])
    #expect(params["window_id"] as? String == "window:1")
    #expect(params["tolerance"] as? Double == 1)
    #expect(params["attempts"] as? Int == 3)
    #expect(await capture.stdout == [response + Data([0x0A])])
}

@Test func workspaceFocusReturnsCompletionReceiptDirectly() async throws {
    let response = Data(#"{"type":"response","request_id":"req-1","ok":true,"result":{"transaction":{"transaction_id":"tx-1","phase":"committed","command":"workspace.focus","accepted_at":"2026-08-14T00:00:00Z","completed_at":"2026-08-14T00:00:01Z","coalesced_requests":0,"reconciliation_escalated":false},"result":{"effect_status":"verified"}},"state_version":2}"#.utf8)
    let capture = Capture()
    let client = MockClient(response: .init(json: response, ok: true))
    let runner = CLIRunner(client: client, output: .init(
        stdout: { data in Task { await capture.out(data) } },
        stderr: { data in Task { await capture.err(data) } }
    ), id: { "req-1" })

    #expect(await runner.run(arguments: ["workspace", "focus", "T"]) == .success)
    try await Task.sleep(for: .milliseconds(10))
    let request = try #require(client.capturedRequests().first)
    let json = try #require(JSONSerialization.jsonObject(with: request.0) as? [String: Any])
    let params = try #require(json["params"] as? [String: Any])
    #expect(json["method"] as? String == "workspace.focus")
    #expect(params["return_mode"] == nil)
    #expect(await capture.stdout == [response + Data([0x0A])])
}

@Test func invalidFrameNeverInvokesClient() async {
    let client = MockClient()
    let runner = CLIRunner(client: client, output: .init(stdout: { _ in }, stderr: { _ in }))
    #expect(await runner.run(arguments: ["window", "frame", "set", "window:1", "0", "0", "-1", "600"]) == .usage)
    #expect(client.capturedRequests().isEmpty)
}

@Test func localErrorsAreJSONOnStderr() async throws {
    let capture = Capture()
    let runner = CLIRunner(client: MockClient(), output: .init(
        stdout: { data in Task { await capture.out(data) } },
        stderr: { data in Task { await capture.err(data) } }
    ))
    #expect(await runner.run(arguments: ["unknown"]) == .usage)
    try await Task.sleep(for: .milliseconds(10))
    #expect(await capture.stdout.isEmpty)
    let line = try #require(await capture.stderr.first)
    #expect((try JSONSerialization.jsonObject(with: line) as? [String: Any]) != nil)
}

@Test func subscribeRequestUsesCanonicalFieldsAndWritesNDJSON() async throws {
    let capture = Capture()
    let event = Data(#"{"type":"event","sequence":1}"#.utf8)
    let client = MockClient(events: [event])
    let runner = CLIRunner(client: client, output: .init(
        stdout: { data in Task { await capture.out(data) } },
        stderr: { data in Task { await capture.err(data) } }
    ), id: { "fixed" })
    #expect(await runner.run(arguments: ["subscribe", "window.inventory", "--after-sequence", "3"]) == .success)
    try await Task.sleep(for: .milliseconds(10))
    #expect(await capture.stdout == [event + Data([0x0A])])
}

@Test func prettyFlagFormatsEveryStdoutMessageThroughOutputPipeline() async throws {
    let capture = Capture()
    let events = [
        Data(#"{"type":"event","sequence":1}"#.utf8),
        Data(#"{"type":"event","sequence":2}"#.utf8),
    ]
    let runner = CLIRunner(client: MockClient(events: events), output: .init(
        stdout: { data in Task { await capture.out(data) } },
        stderr: { data in Task { await capture.err(data) } }
    ), id: { "fixed" })

    #expect(await runner.run(arguments: ["subscribe", "window.inventory", "--pretty"]) == .success)
    try await Task.sleep(for: .milliseconds(10))
    let stdout = await capture.stdout
    #expect(stdout.count == 2)
    #expect(stdout.allSatisfy { String(decoding: $0, as: UTF8.self).contains("\n  \"sequence\"") })
    #expect(stdout.allSatisfy { $0.last == 0x0A })
}

@Test func outputPipelinePassesNonJSONThroughUnchanged() async throws {
    let capture = Capture()
    let output = CLIOutput(
        stdout: { data in Task { await capture.out(data) } },
        stderr: { data in Task { await capture.err(data) } }
    ).processing(pretty: true)
    let data = Data("not json\n".utf8)

    output.stdout(data)
    try await Task.sleep(for: .milliseconds(10))
    #expect(await capture.stdout == [data])
}
