import Foundation
import XCTest
@testable import WMProtocol

final class WMProtocolTests: XCTestCase {
    let rect = Rectangle(x: 8, y: 40, width: 1496, height: 934)
    lazy var capabilities = Capabilities(accessibility: true, screenRecording: true, windowInventory: true, pointerWarp: nil)
    lazy var health = Health(status: .healthy, issues: [], capabilities: capabilities)
    lazy var display = Display(id: "display:1", name: "Built-in", isBuiltin: true, isPrimary: true, frame: rect, visibleFrame: rect, backingScale: 2, identifiers: .init(nsscreenNumber: "1", cgDirectDisplayId: "1"))
    lazy var ax = RawAXWindow(pid: 1234, appName: "Ghostty", bundleId: "com.ghostty", title: "tmux", role: "AXWindow", subrole: "AXStandardWindow", frame: rect, minimized: false, fullscreen: false, focused: true, main: true, cgWindowId: 155)
    lazy var cg = RawCGWindow(cgWindowId: 155, pid: 1234, ownerName: "Ghostty", title: "tmux", layer: 0, alpha: 1, onScreen: true, frame: rect)
    lazy var window = Window(id: "window:1", pid: 1234, appName: "Ghostty", bundleId: "com.ghostty", executablePath: "/Ghostty", title: "tmux", role: "AXWindow", subrole: "AXStandardWindow", frame: rect, displayId: "display:1", classification: .normal, management: .unmanaged, identity: .init(cgWindowId: 155, joinConfidence: .exact, signals: ["pid", "cg_window_id"]), observations: .init(accessibility: true, coreGraphics: true, minimized: false, fullscreen: false, focused: true, main: true, onScreen: true), health: .init(status: .healthy, issues: []))
    lazy var state = UserState(stateVersion: 8, sequence: 43, health: health, focusedWindowId: "window:1", displays: [display], windows: [window])

    func roundTrip<T: Codable & Equatable>(_ value: T, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(try ProtocolCodec.decode(T.self, from: ProtocolCodec.encode(value)), value, file: file, line: line)
    }

    func testClientMessagesRoundTrip() throws {
        try roundTrip(ClientMessage.request(.init(requestId: "req-1", method: .stateGet)))
        try roundTrip(ClientMessage.subscribe(.init(requestId: "req-2", subscriptionId: "inventory", topics: [.windowInventory, .healthChanged], projection: .delta)))
        try roundTrip(ClientMessage.unsubscribe(.init(requestId: "req-3", subscriptionId: "inventory")))
        try roundTrip(ClientMessage.request(.init(
            requestId: "req-4", method: .windowManage,
            params: ["window_id": .string("window:1")]
        )))
        try roundTrip(WindowManagementParams(windowID: "window:1"))
        try roundTrip(WindowManagement.managed)
    }

    func testServerMessagesRoundTrip() throws {
        let date = Date(timeIntervalSince1970: 1_786_676_400)
        try roundTrip(ServerMessage.welcome(.init(sessionId: "session", daemonVersion: "0.0.1-dev", currentSequence: 42, stateVersion: 7, health: health)))
        try roundTrip(ServerMessage.response(.init(requestId: "req-1", result: .object([:]), stateVersion: 7)))
        try roundTrip(ServerMessage.response(.init(requestId: "req-1", error: .init(code: .methodNotFound, message: "unknown", retryable: false), stateVersion: 7)))
        try roundTrip(ServerMessage.event(.init(sequence: 43, stateVersion: 8, timestamp: date, topic: .windowInventory, data: .object(["added": .array([])]))))
        try roundTrip(ServerMessage.resyncRequired(.init(subscriptionId: "inventory", requestedAfterSequence: 10, oldestAvailableSequence: 30, currentSequence: 43, stateVersion: 8)))
    }

    func testInventoryAndStateModelsRoundTrip() throws {
        try roundTrip(rect); try roundTrip(health); try roundTrip(display); try roundTrip(ax); try roundTrip(cg); try roundTrip(window); try roundTrip(state)
        let observed = ObservedState(state: state, inventoryStartedAt: Date(timeIntervalSince1970: 100), inventoryCompletedAt: Date(timeIntervalSince1970: 101), scanDurationMilliseconds: 1000, sourceHealth: ["accessibility": .init(status: .healthy)], appScanResults: [.init(pid: 1234, appName: "Ghostty", windowCount: 1)], rawCounts: .init(accessibilityWindows: 1, coreGraphicsWindows: 1), joinStatistics: .init(exact: 1))
        try roundTrip(observed)
        try roundTrip(DiagnosticInventory(rawAxWindows: [ax], rawCgWindows: [cg], normalizedWindows: [window], rejectedAxWindows: [.init(window: ax, reasons: ["role"])], joinDecisions: [.init(axIndex: 0, cgIndex: 0, confidence: .exact, signals: ["pid"])], sourceHealth: ["core_graphics": .init(status: .healthy)]))
        try roundTrip(DisplayList(displays: [display])); try roundTrip(WindowList(windows: [window])); try roundTrip(DaemonPing(sessionId: "session", daemonVersion: "dev", ready: true, currentSequence: 43, stateVersion: 8))
        try roundTrip(EntityDelta(added: [window], updated: [], removed: ["window:old"])); try roundTrip(Invalidation(topic: .windowInventory, stateVersion: 8))
        let transaction = TransactionMetadata(transactionId: "transaction:1", phase: .queued, command: "workspace.focus", acceptedAt: Date(timeIntervalSince1970: 1), coalescedRequests: 2, reconciliationEscalated: true)
        try roundTrip(transaction)
        try roundTrip(TransactionQueryMetadata(pendingTransactions: [transaction], recovery: .init(active: true, reason: "topology", queuedTransactions: 1)))
        try roundTrip(BatchRequest(commands: [.init(method: .workspaceFocus, params: ["name": .string("T")])]))
        try roundTrip(BatchResult(results: [.object(["ok": .bool(true)])]))
    }

    func testCanonicalJSONIgnoresObjectInsertionOrderAndNormalizesNegativeZero() {
        let first = JSONValue.object(["nested": .object(["b": .number(-0.0), "a": .string("x")])])
        let second = JSONValue.object(["nested": .object(["a": .string("x"), "b": .number(0.0)])])
        XCTAssertEqual(first.canonicalForm, second.canonicalForm)
    }

    func testWireNamesAndNullsMatchContract() throws {
        let data = try ProtocolCodec.encode(ClientMessage.subscribe(.init(requestId: "req", subscriptionId: "sub", topics: [.displayInventory])))
        XCTAssertEqual(String(data: data, encoding: .utf8), #"{"after_sequence":null,"projection":"delta","request_id":"req","subscription_id":"sub","topics":["display.inventory"],"type":"subscribe"}"#)
        let displayJSON = try XCTUnwrap(String(data: ProtocolCodec.encode(display), encoding: .utf8))
        XCTAssertTrue(displayJSON.contains(#""is_builtin":true"#)); XCTAssertTrue(displayJSON.contains(#""cg_direct_display_id":"1""#)); XCTAssertFalse(displayJSON.contains(#""pointer_warp""#))
        let windowJSON = try XCTUnwrap(String(data: ProtocolCodec.encode(window), encoding: .utf8))
        XCTAssertTrue(windowJSON.contains(#""cg_window_id":155"#))
        let healthJSON = try XCTUnwrap(String(data: ProtocolCodec.encode(health), encoding: .utf8))
        XCTAssertTrue(healthJSON.contains(#""pointer_warp":null"#))
    }

    func testRejectsUnknownEnumsAndEnvelopeFields() {
        XCTAssertThrowsError(try ProtocolCodec.decode(ClientMessage.self, from: Data(#"{"type":"request","request_id":"r","method":"future.method","params":{}}"#.utf8)))
        XCTAssertThrowsError(try ProtocolCodec.decode(ClientMessage.self, from: Data(#"{"type":"request","request_id":"r","method":"state.get","params":{},"extra":1}"#.utf8)))
        XCTAssertThrowsError(try ProtocolCodec.decode(ServerMessage.self, from: Data(#"{"type":"future"}"#.utf8)))
    }

    func testRejectsMalformedResponseVariants() {
        XCTAssertThrowsError(try ProtocolCodec.decode(ServerMessage.self, from: Data(#"{"type":"response","request_id":"r","ok":true,"error":{"code":"internal_error","message":"x","retryable":false,"details":{}},"state_version":1}"#.utf8)))
        XCTAssertThrowsError(try ProtocolCodec.decode(ServerMessage.self, from: Data(#"{"type":"response","request_id":"r","ok":false,"result":{},"state_version":1}"#.utf8)))
    }

    func testResponseCorrelationIsPreserved() throws {
        let response = ServerMessage.response(.init(requestId: "req-correlated", result: .object([:]), stateVersion: 1))
        guard case let .response(decoded) = try ProtocolCodec.decode(ServerMessage.self, from: ProtocolCodec.encode(response)) else { return XCTFail("Wrong variant") }
        XCTAssertEqual(decoded.requestId, "req-correlated")
    }
}
