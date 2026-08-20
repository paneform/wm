import Foundation
import XCTest

@testable import WMProtocol

final class WindowGeometryProtocolTests: XCTestCase {
func testGeometryParamsApplyDefaultsAndUseWireKeys() throws {
    let data = Data(#"{"window_id":"window:1","frame":{"x":1,"y":2,"width":3,"height":4}}"#.utf8)
    let decoded = try ProtocolCodec.decode(WindowFrameSetParams.self, from: data)

    XCTAssertEqual(decoded.tolerance, 1)
    XCTAssertEqual(decoded.attempts, 3)
    XCTAssertEqual(Method.windowFrameGet.rawValue, "window.frame.get")
    XCTAssertEqual(Method.windowFrameSet.rawValue, "window.frame.set")
    XCTAssertEqual(Method.debugAXFrameGet.rawValue, "debug.ax.frame.get")
    XCTAssertEqual(Method.debugAXFrameSet.rawValue, "debug.ax.frame.set")
    XCTAssertEqual(Method.debugAXFocus.rawValue, "debug.ax.focus")
}

func testCompleteOldWireRawAXWindowAndWindowDecodeWithUnknownCapabilities() throws {
    let raw = Data(#"{"source":"accessibility","pid":7,"app_name":"App","bundle_id":"com.test","title":"One","role":"AXWindow","subrole":"AXStandardWindow","frame":{"x":1,"y":2,"width":3,"height":4},"minimized":false,"fullscreen":false,"focused":true,"main":true,"modal":false,"has_parent":false,"movable":true,"resizable":true,"cg_window_id":9,"read_errors":[]}"#.utf8)
    let oldWindow = Data(#"{"id":"window:1","pid":7,"app_name":"App","bundle_id":"com.test","title":"One","role":"AXWindow","subrole":"AXStandardWindow","frame":{"x":1,"y":2,"width":3,"height":4},"display_id":"display:1","classification":"normal","management":"managed","rejection_reasons":[],"identity":{"cg_window_id":9,"join_confidence":"exact","signals":[]},"observations":{"accessibility":true,"coreGraphics":true,"minimized":false,"fullscreen":false,"focused":true,"main":true,"onScreen":true},"health":{"status":"healthy","issues":[]}}"#.utf8)

    XCTAssertEqual(try ProtocolCodec.decode(RawAXWindow.self, from: raw).geometryCapabilities.position.reported, .unknown)
    XCTAssertEqual(try ProtocolCodec.decode(Window.self, from: oldWindow).geometryCapabilities.size.confirmed, .unknown)
}

func testNewWireCapabilityRoundTrips() throws {
    let capabilities = GeometryCapabilities(
        position: .init(reported: .supported, confirmed: .inconclusive, evidence: [
            .init(source: .platformReport, state: .supported),
            .init(source: .behavioralProbe, state: .inconclusive),
        ]),
        size: .init(reported: .fixed, confirmed: .supported, evidence: [
            .init(source: .geometryOperation, state: .supported)
        ]))
    let window = Window(
        id: "window:1", pid: 7, frame: .init(x: 1, y: 2, width: 3, height: 4),
        classification: .normal, management: .managed,
        identity: .init(joinConfidence: .exact, signals: []),
        observations: .init(accessibility: true, coreGraphics: true),
        health: .init(status: .healthy, issues: []), geometryCapabilities: capabilities)

    XCTAssertEqual(try ProtocolCodec.decode(Window.self, from: ProtocolCodec.encode(window)), window)
}
}
