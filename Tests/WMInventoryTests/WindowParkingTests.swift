import WMDiagnostics
import XCTest

@testable import WMInventory

final class WindowParkingTests: XCTestCase {
  func testPrefersBottomLeftWhenCornerIsExposed() throws {
    let plan = try XCTUnwrap(
      WindowParkingPlan(
        displayFrame: display, otherDisplayFrames: [], windowFrame: window, diagnosis: diagnosis))

    XCTAssertEqual(plan.corner, .bottomLeft)
    XCTAssertEqual(plan.targetFrame, .init(x: -799, y: 1028, width: 800, height: 600))
  }

  func testRejectsCoveredCornersInPriorityOrder() throws {
    let bottomNeighbor = InventoryRect(x: -100, y: 1080, width: 2121, height: 1080)
    let leftNeighbor = InventoryRect(x: -1920, y: -1, width: 1920, height: 1082)
    let plan = try XCTUnwrap(
      WindowParkingPlan(
        displayFrame: display, otherDisplayFrames: [bottomNeighbor, leftNeighbor],
        windowFrame: window, diagnosis: diagnosis))

    XCTAssertEqual(plan.corner, .topRight)
    XCTAssertEqual(
      WindowParkingPlan.alternatives(
        displayFrame: display, otherDisplayFrames: [bottomNeighbor, leftNeighbor],
        windowFrame: window, diagnosis: diagnosis
      ).map(\.corner),
      [.topRight]
    )
  }

  func testConvertsDellAboveBuiltinToNegativeAXCoordinates() {
    let builtin = observedDisplay(
      id: "builtin", primary: true, frame: .init(x: 0, y: 0, width: 1512, height: 982))
    let dell = observedDisplay(
      id: "dell", primary: false, frame: .init(x: -1030, y: 982, width: 3440, height: 1440))
    let frames = axDisplayFrames([builtin, dell])

    XCTAssertEqual(frames["builtin"], .init(x: 0, y: 0, width: 1512, height: 982))
    XCTAssertEqual(frames["dell"], .init(x: -1030, y: -1440, width: 3440, height: 1440))
    let plan = WindowParkingPlan(
      displayFrame: frames["builtin"]!, otherDisplayFrames: [frames["dell"]!], windowFrame: window,
      diagnosis: diagnosis)
    XCTAssertEqual(plan?.corner, .bottomLeft)
  }

  func testAcceptsExactAndClampedEdgeFrames() throws {
    let plan = try XCTUnwrap(
      WindowParkingPlan(
        displayFrame: display, otherDisplayFrames: [], windowFrame: window, diagnosis: diagnosis))

    XCTAssertTrue(plan.accepts(plan.targetFrame))
    XCTAssertFalse(plan.accepts(.init(x: -759, y: 988, width: 800, height: 600)))
    XCTAssertFalse(plan.accepts(.init(x: 0, y: 400, width: 800, height: 600)))
    XCTAssertFalse(plan.accepts(.init(x: 0, y: 1028, width: 700, height: 600)))
    XCTAssertFalse(plan.accepts(.init(x: -400, y: 1028, width: 800, height: 600)))
  }

  func testDetectsWhetherRestoreFrameIntersectsADisplay() {
    XCTAssertTrue(
      isCenteredOnDisplay(.init(x: 100, y: 100, width: 500, height: 500), displays: [display]))
    XCTAssertFalse(
      isCenteredOnDisplay(.init(x: -1472, y: 950, width: 1512, height: 950), displays: [display]))
  }

  func testBinarySearchFindsMaximumRetainedProgress() async throws {
    let result = try await ParkingLimitDiscovery().maximumAcceptedProgress(distance: 600) {
      $0 <= 548
    }
    XCTAssertEqual(result, 548)
  }

  func testBinarySearchReturnsIdealVisibilityWithoutSearching() async throws {
    let attempts = AttemptCounter()
    let result = try await ParkingLimitDiscovery().maximumAcceptedProgress(distance: 600) { value in
      await attempts.record(value)
      return true
    }
    XCTAssertEqual(result, 600)
    let values = await attempts.values
    XCTAssertEqual(values, [0, 600])
  }

  func testBinarySearchRejectsUnstableBoundary() async {
    let attempts = AttemptCounter()
    await XCTAssertThrowsErrorAsync {
      _ = try await ParkingLimitDiscovery().maximumAcceptedProgress(distance: 100) { value in
        let count = await attempts.recordAndCount(value)
        return value <= 90 && !(value == 90 && count > 1)
      }
    }
  }

  func testClampSeedExcludesEndpointAndDoesNotReturnToVisibleAnchor() throws {
    let bounds = try ParkingLimitDiscovery().clampedAxisBounds(
      observed: -747, endpoint: -800, direction: -1)

    XCTAssertEqual(bounds.acceptedCoordinate, -747)
    XCTAssertEqual(bounds.rejectedCoordinate, -799)
    XCTAssertEqual(bounds.distance, 52)
    XCTAssertEqual(bounds.coordinate(at: 0), -747)
    XCTAssertEqual(bounds.coordinate(at: bounds.distance), -799)
  }

  func testClampBoundsHandleAllAxisDirections() throws {
    let discovery = ParkingLimitDiscovery()
    let left = try discovery.clampedAxisBounds(observed: -747, endpoint: -800, direction: -1)
    let right = try discovery.clampedAxisBounds(observed: 1867, endpoint: 1920, direction: 1)
    let top = try discovery.clampedAxisBounds(observed: -547, endpoint: -600, direction: -1)
    let bottom = try discovery.clampedAxisBounds(observed: 1027, endpoint: 1080, direction: 1)

    XCTAssertEqual(left.coordinate(at: left.distance), -799)
    XCTAssertEqual(right.coordinate(at: right.distance), 1919)
    XCTAssertEqual(top.coordinate(at: top.distance), -599)
    XCTAssertEqual(bottom.coordinate(at: bottom.distance), 1079)
  }

  func testFractionalClampRoundsTowardFullyVisibleSide() throws {
    let discovery = ParkingLimitDiscovery()
    let decreasing = try discovery.clampedAxisBounds(
      observed: -747.75, endpoint: -800, direction: -1)
    let increasing = try discovery.clampedAxisBounds(
      observed: 1867.75, endpoint: 1920, direction: 1)

    XCTAssertEqual(decreasing.acceptedCoordinate, -747)
    XCTAssertEqual(increasing.acceptedCoordinate, 1867)
  }

  func testClampSeededSearchIsBoundedAndReconfirmsAcceptedCoordinate() async throws {
    let attempts = AttemptCounter()
    let result = try await ParkingLimitDiscovery().maximumAcceptedProgress(distance: 52) { value in
      await attempts.record(value)
      return value <= 51
    }

    XCTAssertEqual(result, 51)
    let values = await attempts.values
    XCTAssertEqual(values.last, 51)
    XCTAssertLessThanOrEqual(values.count, 10)
  }

  func testExactLiveClampSequenceSearchesAxesIndependentlyAndPersistsSafeCoordinates() async throws
  {
    let discovery = ParkingLimitDiscovery()
    let xBounds = try discovery.clampedAxisBounds(
      observed: -1472, endpoint: -1512, direction: -1)
    let yBounds = try discovery.clampedAxisBounds(observed: 32, endpoint: 982, direction: 1)

    let x = try await discovery.furthestRetainedCoordinate(bounds: xBounds) { $0 }
    let y = try await discovery.furthestRetainedCoordinate(bounds: yBounds) { requested in
      min(requested, 918)
    }

    XCTAssertEqual(x, -1511)
    XCTAssertEqual(y, 918)
    XCTAssertEqual(
      WindowParkingPlan.visibility(
        for: .bottomLeft, display: .init(x: 0, y: 0, width: 1512, height: 982),
        accepted: .init(x: x, y: y, width: 1512, height: 950)),
      .init(horizontal: 1, vertical: 64))
  }

  func testMonotonicAxisSearchHandlesBothDirectionSigns() async throws {
    let discovery = ParkingLimitDiscovery()
    let decreasing = try discovery.clampedAxisBounds(
      observed: -1472, endpoint: -1512, direction: -1)
    let increasing = try discovery.clampedAxisBounds(observed: 918, endpoint: 982, direction: 1)

    let left = try await discovery.furthestRetainedCoordinate(bounds: decreasing) { requested in
      max(requested, -1500)
    }
    let bottom = try await discovery.furthestRetainedCoordinate(bounds: increasing) { requested in
      min(requested, 950)
    }

    XCTAssertEqual(left, -1500)
    XCTAssertEqual(bottom, 950)
  }

  func testCornerGeometrySupportsZeroAndOneByFiftyTwoVisibility() {
    for corner in ParkingCorner.allCases {
      let anchor = WindowParkingPlan.visibleAnchor(for: corner, display: display, window: window)
      let endpoint = WindowParkingPlan.offscreenEndpoint(
        for: corner, display: display, window: window)
      XCTAssertEqual(
        WindowParkingPlan.visibility(for: corner, display: display, accepted: endpoint),
        .init(horizontal: 0, vertical: 0))
      let horizontal = WindowParkingPlan.axisTarget(
        from: anchor, to: endpoint, horizontal: true, progress: Int(window.width) - 1)
      let vertical = WindowParkingPlan.axisTarget(
        from: anchor, to: endpoint, horizontal: false, progress: Int(window.height) - 52)
      let accepted = InventoryRect(
        x: horizontal.x, y: vertical.y, width: window.width, height: window.height)
      XCTAssertEqual(
        WindowParkingPlan.visibility(for: corner, display: display, accepted: accepted),
        .init(horizontal: 1, vertical: 52))
    }
  }

  func testFingerprintDoesNotPersistDisplayNameOrSerial() throws {
    var display = observedDisplay(id: "stable", primary: true, frame: display)
    display.name = "Private Display Name"
    display.identifiers.serialNumber = "private-serial"
    let key = try ParkingDiagnosticIdentity.key(
      displayID: display.id, displays: [display],
      operatingSystem: .init(majorVersion: 26, minorVersion: 0, patchVersion: 0))
    XCTAssertFalse(key.fingerprint.contains("Private"))
    XCTAssertFalse(key.fingerprint.contains("private-serial"))
    XCTAssertEqual(key.fingerprint.count, 64)
  }

  func testFingerprintScopesFactsPerDisplay() throws {
    let displays = [
      observedDisplay(id: "left", primary: true, frame: display),
      observedDisplay(
        id: "right", primary: false, frame: .init(x: 1920, y: 0, width: 1920, height: 1080)),
    ]
    let os = OperatingSystemVersion(majorVersion: 26, minorVersion: 0, patchVersion: 0)
    let left = try ParkingDiagnosticIdentity.key(
      displayID: "left", displays: displays, operatingSystem: os)
    let right = try ParkingDiagnosticIdentity.key(
      displayID: "right", displays: displays, operatingSystem: os)
    XCTAssertNotEqual(left, right)
  }
}

private func XCTAssertThrowsErrorAsync(
  _ expression: () async throws -> Void,
  file: StaticString = #filePath, line: UInt = #line
) async {
  do {
    try await expression()
    XCTFail("expected error", file: file, line: line)
  } catch {}
}

private actor AttemptCounter {
  var values: [Int] = []
  func record(_ value: Int) { values.append(value) }
  func recordAndCount(_ value: Int) -> Int {
    values.append(value)
    return values.filter { $0 == value }.count
  }
}

private let diagnosis = ResolvedDiagnostic(
  value: ParkingLimits(
    corners: Dictionary(
      uniqueKeysWithValues: ParkingCorner.allCases.map {
        ($0, ParkingVisibility(horizontal: 1, vertical: 52))
      })),
  provenance: .init(key: .init(id: "parking-limits", revision: 1, fingerprint: "test")))

private let display = InventoryRect(x: 0, y: 0, width: 1920, height: 1080)
private let window = InventoryRect(x: 200, y: 100, width: 800, height: 600)

private func observedDisplay(id: String, primary: Bool, frame: InventoryRect) -> DisplayObservation
{
  .init(
    id: id, name: id, isBuiltin: primary, isPrimary: primary, frame: frame, visibleFrame: frame,
    backingScale: 1, identifiers: .init())
}
