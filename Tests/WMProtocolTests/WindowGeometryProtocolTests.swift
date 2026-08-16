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
}
