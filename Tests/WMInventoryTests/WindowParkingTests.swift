import XCTest
@testable import WMInventory

final class WindowParkingTests: XCTestCase {
    func testPrefersBottomLeftWhenCornerIsExposed() throws {
        let plan = try XCTUnwrap(WindowParkingPlan(displayFrame: display, otherDisplayFrames: [], windowFrame: window))

        XCTAssertEqual(plan.corner, .bottomLeft)
        XCTAssertEqual(plan.targetFrame, .init(x: -900, y: 1180, width: 800, height: 600))
    }

    func testRejectsCoveredCornersInPriorityOrder() throws {
        let bottomNeighbor = InventoryRect(x: -100, y: 1080, width: 2121, height: 1080)
        let leftNeighbor = InventoryRect(x: -1920, y: -1, width: 1920, height: 1082)
        let plan = try XCTUnwrap(WindowParkingPlan(displayFrame: display, otherDisplayFrames: [bottomNeighbor, leftNeighbor], windowFrame: window))

        XCTAssertEqual(plan.corner, .topRight)
    }

    func testConvertsDellAboveBuiltinToNegativeAXCoordinates() {
        let builtin = observedDisplay(id: "builtin", primary: true, frame: .init(x: 0, y: 0, width: 1512, height: 982))
        let dell = observedDisplay(id: "dell", primary: false, frame: .init(x: -1030, y: 982, width: 3440, height: 1440))
        let frames = axDisplayFrames([builtin, dell])

        XCTAssertEqual(frames["builtin"], .init(x: 0, y: 0, width: 1512, height: 982))
        XCTAssertEqual(frames["dell"], .init(x: -1030, y: -1440, width: 3440, height: 1440))
        let plan = WindowParkingPlan(displayFrame: frames["builtin"]!, otherDisplayFrames: [frames["dell"]!], windowFrame: window)
        XCTAssertEqual(plan?.corner, .bottomLeft)
    }

    func testAcceptsExactAndClampedEdgeFrames() throws {
        let plan = try XCTUnwrap(WindowParkingPlan(displayFrame: display, otherDisplayFrames: [], windowFrame: window))

        XCTAssertTrue(plan.accepts(plan.targetFrame))
        XCTAssertTrue(plan.accepts(.init(x: 0, y: 1030, width: 800, height: 600)))
        XCTAssertFalse(plan.accepts(.init(x: 0, y: 400, width: 800, height: 600)))
        XCTAssertFalse(plan.accepts(.init(x: 0, y: 1030, width: 700, height: 600)))
    }

    func testDetectsWhetherRestoreFrameIntersectsADisplay() {
        XCTAssertTrue(isCenteredOnDisplay(.init(x: 100, y: 100, width: 500, height: 500), displays: [display]))
        XCTAssertFalse(isCenteredOnDisplay(.init(x: -1472, y: 950, width: 1512, height: 950), displays: [display]))
    }
}

private let display = InventoryRect(x: 0, y: 0, width: 1920, height: 1080)
private let window = InventoryRect(x: 200, y: 100, width: 800, height: 600)

private func observedDisplay(id: String, primary: Bool, frame: InventoryRect) -> DisplayObservation {
    .init(id: id, name: id, isBuiltin: primary, isPrimary: primary, frame: frame, visibleFrame: frame, backingScale: 1, identifiers: .init())
}
