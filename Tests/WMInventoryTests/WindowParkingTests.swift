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

  func testSideBySideDisplaysOnlyAllowOutwardRuntimeCorners() {
    let left = InventoryRect(x: 0, y: 0, width: 1000, height: 1000)
    let right = InventoryRect(x: 1000, y: 0, width: 1000, height: 1000)
    let window = InventoryRect(x: 100, y: 100, width: 400, height: 300)

    XCTAssertEqual(
      WindowParkingPlan.alternatives(
        displayFrame: left, otherDisplayFrames: [right], windowFrame: window,
        diagnosis: diagnosis
      ).map(\.corner),
      [.bottomLeft, .topLeft])
    XCTAssertEqual(
      WindowParkingPlan.alternatives(
        displayFrame: right, otherDisplayFrames: [left], windowFrame: window,
        diagnosis: diagnosis
      ).map(\.corner),
      [.bottomRight, .topRight])
  }

  func testVerticallyStackedDisplaysRejectAdjoiningRuntimeCorners() {
    let top = InventoryRect(x: 0, y: 0, width: 1000, height: 1000)
    let bottom = InventoryRect(x: 0, y: 1000, width: 1000, height: 1000)
    let window = InventoryRect(x: 100, y: 100, width: 400, height: 300)

    XCTAssertEqual(
      WindowParkingPlan.alternatives(
        displayFrame: top, otherDisplayFrames: [bottom], windowFrame: window,
        diagnosis: diagnosis
      ).map(\.corner),
      [.topLeft, .topRight])
    XCTAssertEqual(
      WindowParkingPlan.alternatives(
        displayFrame: bottom, otherDisplayFrames: [top], windowFrame: window,
        diagnosis: diagnosis
      ).map(\.corner),
      [.bottomLeft, .bottomRight])
  }

  func testStaggeredBottomRightUsesActualDiagnosedTarget() {
    let assigned = InventoryRect(x: 0, y: 0, width: 1000, height: 1000)
    let upperRight = InventoryRect(x: 1000, y: 0, width: 1000, height: 900)
    let window = InventoryRect(x: 100, y: 100, width: 400, height: 300)

    let clearsNeighbor = WindowParkingPlan.alternatives(
      displayFrame: assigned, otherDisplayFrames: [upperRight], windowFrame: window,
      diagnosis: limitsDiagnosis(vertical: 52))
    XCTAssertTrue(clearsNeighbor.contains(where: { $0.corner == .bottomRight }))
    XCTAssertEqual(
      clearsNeighbor.first(where: { $0.corner == .bottomRight })?.targetFrame.y, 948)

    let overlapsNeighbor = WindowParkingPlan.alternatives(
      displayFrame: assigned, otherDisplayFrames: [upperRight], windowFrame: window,
      diagnosis: limitsDiagnosis(vertical: 101))
    XCTAssertFalse(overlapsNeighbor.contains(where: { $0.corner == .bottomRight }))
  }

  func testWindowSizeChangesRuntimeCornerFeasibility() {
    let assigned = InventoryRect(x: 0, y: 0, width: 1000, height: 1000)
    let lowerLeft = InventoryRect(x: -500, y: 948, width: 100, height: 300)
    let small = InventoryRect(x: 0, y: 0, width: 300, height: 300)
    let large = InventoryRect(x: 0, y: 0, width: 600, height: 300)

    XCTAssertTrue(
      WindowParkingPlan.alternatives(
        displayFrame: assigned, otherDisplayFrames: [lowerLeft], windowFrame: small,
        diagnosis: diagnosis
      ).contains(where: { $0.corner == .bottomLeft }))
    XCTAssertFalse(
      WindowParkingPlan.alternatives(
        displayFrame: assigned, otherDisplayFrames: [lowerLeft], windowFrame: large,
        diagnosis: diagnosis
      ).contains(where: { $0.corner == .bottomLeft }))
  }

  func testDisplayEdgeTouchingIsAllowedButOnePointOverlapIsRejected() {
    let assigned = InventoryRect(x: 0, y: 0, width: 1000, height: 1000)
    let window = InventoryRect(x: 100, y: 100, width: 400, height: 300)
    let touching = InventoryRect(x: 1000, y: 0, width: 1000, height: 948)
    let overlapping = InventoryRect(x: 1000, y: 0, width: 1000, height: 949)

    XCTAssertTrue(
      WindowParkingPlan.alternatives(
        displayFrame: assigned, otherDisplayFrames: [touching], windowFrame: window,
        diagnosis: diagnosis
      ).contains(where: { $0.corner == .bottomRight }))
    XCTAssertFalse(
      WindowParkingPlan.alternatives(
        displayFrame: assigned, otherDisplayFrames: [overlapping], windowFrame: window,
        diagnosis: diagnosis
      ).contains(where: { $0.corner == .bottomRight }))
  }

  func testAlternativesRemainInStableCornerPriorityOrder() {
    let diagnosed = ResolvedDiagnostic(
      value: ParkingLimits(corners: [
        .topRight: .init(horizontal: 1, vertical: 52),
        .bottomRight: .init(horizontal: 1, vertical: 52),
        .topLeft: .init(horizontal: 1, vertical: 52),
      ]), provenance: diagnosis.provenance)

    XCTAssertEqual(
      WindowParkingPlan.alternatives(
        displayFrame: display, otherDisplayFrames: [], windowFrame: window,
        diagnosis: diagnosed
      ).map(\.corner),
      [.bottomRight, .topLeft, .topRight])
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

  func testAcceptsRejectsNeighborIntersectionDespiteAssignedDisplayLimits() throws {
    let assigned = InventoryRect(x: 0, y: 0, width: 1000, height: 1000)
    let lowerLeft = InventoryRect(x: -900, y: 948, width: 400, height: 300)
    let window = InventoryRect(x: 100, y: 100, width: 400, height: 300)
    let plan = try XCTUnwrap(
      WindowParkingPlan(
        displayFrame: assigned, otherDisplayFrames: [lowerLeft], windowFrame: window,
        diagnosis: diagnosis))

    XCTAssertEqual(plan.corner, .bottomLeft)
    XCTAssertTrue(plan.accepts(plan.targetFrame))
    XCTAssertFalse(plan.accepts(.init(x: -501, y: 948, width: 400, height: 300)))
  }

  func testDiagnosticCornerFilteringNeverSweepsThroughNeighbors() {
    let left = InventoryRect(x: 0, y: 0, width: 1000, height: 1000)
    let right = InventoryRect(x: 1000, y: 0, width: 1000, height: 1000)
    let below = InventoryRect(x: 0, y: 1000, width: 1000, height: 1000)
    let window = InventoryRect(x: 100, y: 100, width: 400, height: 300)

    XCTAssertEqual(
      WindowParkingPlan.availableCorners(on: left, avoiding: [right], window: window),
      [.bottomLeft, .topLeft])
    XCTAssertEqual(
      WindowParkingPlan.availableCorners(on: left, avoiding: [below], window: window),
      [.topLeft, .topRight])
    XCTAssertEqual(
      WindowParkingPlan.availableCorners(on: left, avoiding: [right, below], window: window),
      [.topLeft])
  }

  func testDetectsWhetherRestoreFrameIntersectsADisplay() {
    XCTAssertTrue(
      isCenteredOnDisplay(.init(x: 100, y: 100, width: 500, height: 500), displays: [display]))
    XCTAssertFalse(
      isCenteredOnDisplay(.init(x: -1472, y: 950, width: 1512, height: 950), displays: [display]))
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

  func testJointSearchTestsAdjacentPointThenBinarySearches() async throws {
    let discovery = ParkingLimitDiscovery()
    let endpointObserved = try discovery.boundsIfClamped(
      observed: -550, endpoint: -600, direction: -1)
    let bounds = try XCTUnwrap(endpointObserved)
    XCTAssertEqual(bounds.acceptedCoordinate, -550)
    XCTAssertEqual(bounds.rejectedCoordinate, -599)

    let log = RequestLog()
    let resolved = try await ParkingJointDiscovery.search(
      base: InventoryRect(x: -600, y: 982, width: 600, height: 950), xAxis: bounds, yAxis: nil
    ) { target in
      await log.append(target.x)
      return InventoryRect(
        x: target.x < -575 ? -550 : target.x, y: target.y,
        width: target.width, height: target.height)
    }

    let requests = await log.recordedDoubles
    XCTAssertEqual(requests.first, -551, "second probe must test one point past the clamp")
    XCTAssertEqual(resolved.x, -575)
    XCTAssertNil(resolved.y)
    XCTAssertEqual(requests.last, -575, "winning combined frame must be re-probed for verification")
  }

  func testJointSearchWithClampsReturnsResolvedAxisBounds() async throws {
    let discovery = ParkingLimitDiscovery()
    let xBounds = try discovery.clampedAxisBounds(observed: -1472, endpoint: -1512, direction: -1)
    // Consistent OS clamp: anything past -1490 is pulled back to exactly -1490.
    let observeClosure = { @Sendable (target: InventoryRect) in
      InventoryRect(
        x: max(target.x, -1490), y: target.y, width: target.width, height: target.height)
    }

    let clamps = try await ParkingJointDiscovery.searchWithClamps(
      base: InventoryRect(x: -1512, y: 982, width: 600, height: 950), xAxis: xBounds, yAxis: nil,
      observe: observeClosure)

    let x = try XCTUnwrap(clamps.x)
    XCTAssertEqual(x.acceptedCoordinate, -1490)
    XCTAssertEqual(x.direction, -1)
    XCTAssertLessThanOrEqual(x.distance, xBounds.distance)
    XCTAssertEqual(x.coordinate(at: 0), x.acceptedCoordinate)
    XCTAssertNil(clamps.y, "retained axis must not report clamp bounds")

    // The coordinate projection used by the plain search agrees with the bounds.
    let projected = try await ParkingJointDiscovery.search(
      base: InventoryRect(x: -1512, y: 982, width: 600, height: 950), xAxis: xBounds, yAxis: nil,
      observe: observeClosure)
    XCTAssertEqual(projected.x, x.acceptedCoordinate)
  }

  func testJointSearchFindsDeepBoundaryPastInitialClamp() async throws {
    // X starts at 0 with endpoint -600. Values beyond -593 clamp back to -550, so the true
    // maximally off-screen retained position is exactly -593 despite the coarse initial clamp.
    let discovery = ParkingLimitDiscovery()
    let bounds = try discovery.clampedAxisBounds(observed: -550, endpoint: -600, direction: -1)

    let log = RequestLog()
    let resolved = try await ParkingJointDiscovery.search(
      base: InventoryRect(x: -600, y: 982, width: 600, height: 950), xAxis: bounds, yAxis: nil
    ) { target in
      await log.append(target.x)
      return InventoryRect(
        x: target.x < -593 ? -550 : target.x, y: target.y,
        width: target.width, height: target.height)
    }

    XCTAssertEqual(resolved.x, -593)
    let requests = await log.recordedDoubles
    XCTAssertEqual(requests.first, -551, "second probe must test one point past the clamp")
    XCTAssertEqual(requests.last, -593, "winning combined frame must be re-probed for verification")
  }

  func testExactLiveClampSequenceSearchesAxesIndependentlyAndPersistsSafeCoordinates() async throws {
    let discovery = ParkingLimitDiscovery()
    let xBounds = try discovery.clampedAxisBounds(observed: -1472, endpoint: -1512, direction: -1)
    let yBounds = try discovery.clampedAxisBounds(observed: 32, endpoint: 982, direction: 1)

    let log = RequestLog()
    let resolved = try await ParkingJointDiscovery.search(
      base: InventoryRect(x: -1512, y: 982, width: 1512, height: 950),
      xAxis: xBounds, yAxis: yBounds
    ) { target in
      await log.append(target)
      return InventoryRect(
        x: target.x, y: min(target.y, 918), width: target.width, height: target.height)
    }

    let lastRequest = await log.lastFrame
    XCTAssertEqual(resolved.x, -1511)
    XCTAssertEqual(resolved.y, 918)
    XCTAssertEqual(lastRequest?.x, -1511)
    XCTAssertEqual(lastRequest?.y, 918)
    XCTAssertEqual(
      WindowParkingPlan.visibility(
        for: .bottomLeft, display: .init(x: 0, y: 0, width: 1512, height: 982),
        accepted: .init(x: resolved.x!, y: resolved.y!, width: 1512, height: 950)),
      .init(horizontal: 1, vertical: 64))
  }

  func testMonotonicJointSearchHandlesBothDirectionSigns() async throws {
    let discovery = ParkingLimitDiscovery()
    let xBounds = try discovery.clampedAxisBounds(observed: -1472, endpoint: -1512, direction: -1)
    let yBounds = try discovery.clampedAxisBounds(observed: 918, endpoint: 982, direction: 1)

    let resolved = try await ParkingJointDiscovery.search(
      base: InventoryRect(x: -1512, y: 982, width: 1512, height: 950),
      xAxis: xBounds, yAxis: yBounds
    ) { target in
      InventoryRect(
        x: max(target.x, -1500), y: min(target.y, 950),
        width: target.width, height: target.height)
    }

    XCTAssertEqual(resolved.x, -1500)
    XCTAssertEqual(resolved.y, 950)
  }

  func testJointSearchHoldsEndpointForRetainedAxis() async throws {
    let discovery = ParkingLimitDiscovery()
    let yBounds = try discovery.clampedAxisBounds(observed: 900, endpoint: 982, direction: 1)

    let log = RequestLog()
    let resolved = try await ParkingJointDiscovery.search(
      base: InventoryRect(x: -1512, y: 982, width: 800, height: 600), xAxis: nil, yAxis: yBounds
    ) { target in
      await log.append(target)
      return InventoryRect(
        x: target.x, y: min(target.y, 940), width: target.width, height: target.height)
    }

    XCTAssertNil(resolved.x)
    XCTAssertEqual(resolved.y, 940)
    let requests = await log.recordedRects
    XCTAssertTrue(requests.allSatisfy { $0.x == -1512 })
  }

  func testJointSearchRejectsUnstableFinalFrame() async throws {
    let discovery = ParkingLimitDiscovery()
    let xBounds = try discovery.clampedAxisBounds(observed: -1472, endpoint: -1512, direction: -1)
    let seen = RequestRecorder()

    await XCTAssertThrowsErrorAsync {
      _ = try await ParkingJointDiscovery.search(
        base: InventoryRect(x: -1512, y: 982, width: 800, height: 600), xAxis: xBounds, yAxis: nil
      ) { target in
        // Retains every first-time request; the verification re-probe necessarily repeats a
        // coordinate and drifts, so joint retention cannot be confirmed.
        let drifted = await seen.isRepeat(target.x)
        await seen.record(target.x)
        return InventoryRect(
          x: drifted ? -1400 : target.x, y: target.y,
          width: target.width, height: target.height)
      }
    }
  }

  func testJointSearchDetectsCoupledAxesAsUnstable() async throws {
    let discovery = ParkingLimitDiscovery()
    let xBounds = try discovery.clampedAxisBounds(observed: -1400, endpoint: -1512, direction: -1)
    let yBounds = try discovery.clampedAxisBounds(observed: 900, endpoint: 982, direction: 1)

    await XCTAssertThrowsErrorAsync {
      _ = try await ParkingJointDiscovery.search(
        base: InventoryRect(x: -1512, y: 982, width: 800, height: 600),
        xAxis: xBounds, yAxis: yBounds
      ) { target in
        // Non-Cartesian platform: Y retains only while X stays shallow.
        InventoryRect(
          x: target.x, y: target.x >= -1420 ? target.y : min(target.y, 900),
          width: target.width, height: target.height)
      }
    }
  }

  func testGeneratedJointDiscoveryMatchesExhaustiveOracle() async throws {
    var random = SeededRandom(seed: 0xA572_0156_F116)
    let discovery = ParkingLimitDiscovery()

    struct AxisCase: Sendable {
      var anchor: Double
      var direction: Double
      var distance: Int
      var retainedAtEndpoint: Bool
      var optimalProgress: Int
      var clampCoordinate: Double
    }

    func makeAxis(_ random: inout SeededRandom) -> AxisCase {
      let direction = random.bool() ? 1.0 : -1.0
      let distance = random.int(in: 1...2_048)
      let anchor = Double(random.int(in: -4_000...4_000))
      let endpoint = anchor + direction * Double(distance)
      if random.bool() { return .init(anchor: anchor, direction: direction, distance: distance, retainedAtEndpoint: true, optimalProgress: distance, clampCoordinate: endpoint) }
      let optimal = random.int(in: 0...max(0, distance - 1))
      let clampProgress = random.int(in: 0...optimal)
      let fraction = [0.0, 0.25, 0.75][random.int(in: 0...2)]
      return .init(
        anchor: anchor, direction: direction, distance: distance, retainedAtEndpoint: false,
        optimalProgress: optimal,
        clampCoordinate: anchor + direction * (Double(clampProgress) + fraction))
    }

    for caseIndex in 0..<500 {
      var xCase = makeAxis(&random)
      var yCase = makeAxis(&random)
      if caseIndex.isMultiple(of: 7) { xCase.retainedAtEndpoint = true }
      if caseIndex.isMultiple(of: 11) { yCase.retainedAtEndpoint = true }
      let seedProgressX = random.int(in: 0...max(1, xCase.optimalProgress))
      let seedProgressY = random.int(in: 0...max(1, yCase.optimalProgress))

      let xEndpoint = xCase.anchor + xCase.direction * Double(xCase.distance)
      let yEndpoint = yCase.anchor + yCase.direction * Double(yCase.distance)
      let base = InventoryRect(
        x: xEndpoint, y: yEndpoint, width: Double(random.int(in: 200...800)),
        height: Double(random.int(in: 200...600)))

      @Sendable func observeCoordinate(_ requested: Double, _ axis: AxisCase) -> Double {
        guard !axis.retainedAtEndpoint else { return requested }
        let progress = Int(((requested - axis.anchor) * axis.direction).rounded())
        return progress <= axis.optimalProgress ? requested : axis.clampCoordinate
      }

      let xCaseValue = xCase
      let yCaseValue = yCase
      let probeCounter = ProbeCounter()

      let xObserved =
        xCase.retainedAtEndpoint
        ? xEndpoint : xCase.anchor + xCase.direction * Double(random.int(in: 0...xCase.optimalProgress))
      let yObserved =
        yCase.retainedAtEndpoint
        ? yEndpoint : yCase.anchor + yCase.direction * Double(random.int(in: 0...yCase.optimalProgress))

      let xBounds = try discovery.boundsIfClamped(
        observed: xObserved, endpoint: xEndpoint, direction: xCase.direction,
        acceptedSeed: random.bool() ? xCase.anchor + xCase.direction * Double(seedProgressX) : nil)
      let yBounds = try discovery.boundsIfClamped(
        observed: yObserved, endpoint: yEndpoint, direction: yCase.direction,
        acceptedSeed: random.bool() ? yCase.anchor + yCase.direction * Double(seedProgressY) : nil)

      if xBounds == nil && yBounds == nil { continue }

      let resolved = try await ParkingJointDiscovery.search(
        base: base, xAxis: xBounds, yAxis: yBounds
      ) { target in
        await probeCounter.increment()
        return InventoryRect(
          x: observeCoordinate(target.x, xCaseValue), y: observeCoordinate(target.y, yCaseValue),
          width: target.width, height: target.height)
      }

      if xCase.retainedAtEndpoint {
        XCTAssertNil(resolved.x, "case \(caseIndex)")
      } else {
        let exhaustive = min(xCase.optimalProgress, max(0, xCase.distance - 1))
        XCTAssertEqual(resolved.x, xCase.anchor + xCase.direction * Double(exhaustive), "case \(caseIndex)")
      }
      if yCase.retainedAtEndpoint {
        XCTAssertNil(resolved.y, "case \(caseIndex)")
      } else {
        let exhaustive = min(yCase.optimalProgress, max(0, yCase.distance - 1))
        XCTAssertEqual(resolved.y, yCase.anchor + yCase.direction * Double(exhaustive), "case \(caseIndex)")
      }
      let maximumDistance = max(xCase.distance, yCase.distance, 1)
      let bound = 2 * (Int(ceil(log2(Double(maximumDistance)))) + 3) + 3
      let probeCount = await probeCounter.count
      XCTAssertLessThanOrEqual(probeCount, bound, "case \(caseIndex)")
    }
  }

  func testEndpointEvidenceKeepsAxesIndependent() throws {
    let discovery = ParkingLimitDiscovery()
    for (xRetained, yRetained) in [(true, false), (false, true), (false, false), (true, true)] {
      let x = try discovery.boundsIfClamped(
        observed: xRetained ? -800 : -747.5, endpoint: -800, direction: -1)
      let y = try discovery.boundsIfClamped(
        observed: yRetained ? 1_080 : 1_000.25, endpoint: 1_080, direction: 1)
      XCTAssertEqual(x == nil, xRetained)
      XCTAssertEqual(y == nil, yRetained)
      if !xRetained && !yRetained {
        XCTAssertNotEqual(x?.distance, y?.distance)
      }
    }
  }

  func testParkedCurrentFrameSeedsOnlyUsableCornerAxes() {
    let display = InventoryRect(x: 0, y: 0, width: 1_000, height: 800)
    let window = InventoryRect(x: 0, y: 0, width: 400, height: 300)
    let parked = InventoryRect(x: -350, y: 760, width: 400, height: 300)
    let seeded = WindowParkingPlan.diagnosticStart(
      for: .bottomLeft, display: display, window: window, currentFrame: parked, avoiding: [])
    XCTAssertEqual(seeded.x, parked.x)
    XCTAssertEqual(seeded.y, parked.y)

    let wrongSide = InventoryRect(x: 700, y: -250, width: 400, height: 300)
    XCTAssertEqual(
      WindowParkingPlan.diagnosticStart(
        for: .bottomLeft, display: display, window: window, currentFrame: wrongSide, avoiding: []),
      WindowParkingPlan.visibleAnchor(for: .bottomLeft, display: display, window: window))
  }

  func testParkedSeedNarrowsClampSearchInterval() throws {
    let discovery = ParkingLimitDiscovery()
    let withoutSeed = try discovery.clampedAxisBounds(
      observed: -700.75, endpoint: -800, direction: -1)
    let withSeed = try discovery.clampedAxisBounds(
      observed: -700.75, endpoint: -800, direction: -1, acceptedSeed: -775)
    XCTAssertEqual(withSeed.acceptedCoordinate, -775)
    XCTAssertLessThan(withSeed.distance, withoutSeed.distance)
  }

  func testGeneratedTopologyChoicesMatchDirectIntersectionOracle() {
    var random = SeededRandom(seed: 0xC0FF_EE55_7A9E)
    for caseIndex in 0..<600 {
      let width = Double(random.int(in: 600...2_400))
      let height = Double(random.int(in: 500...1_600))
      let assigned = InventoryRect(x: 0, y: 0, width: width, height: height)
      let window = InventoryRect(
        x: 0, y: 0, width: Double(random.int(in: 200...Int(width))),
        height: Double(random.int(in: 150...Int(height))))
      let neighbor = generatedNeighbor(caseIndex % 5, assigned: assigned, random: &random)
      let limits = ParkingVisibility(
        horizontal: Double(random.int(in: 0...80)), vertical: Double(random.int(in: 0...100)))
      let generatedDiagnosis = limitsDiagnosis(
        horizontal: limits.horizontal, vertical: limits.vertical)

      let alternatives = WindowParkingPlan.alternatives(
        displayFrame: assigned, otherDisplayFrames: [neighbor], windowFrame: window,
        diagnosis: generatedDiagnosis
      ).map(\.corner)
      let expectedAlternatives = ParkingCorner.allCases.filter { corner in
        !rectanglesIntersect(
          WindowParkingPlan.target(
            for: corner, display: assigned, window: window, limits: limits), neighbor)
      }
      XCTAssertEqual(alternatives, expectedAlternatives, "runtime case \(caseIndex)")

      let available = WindowParkingPlan.availableCorners(
        on: assigned, avoiding: [neighbor], window: window)
      let expectedAvailable = ParkingCorner.allCases.filter { corner in
        let anchor = WindowParkingPlan.visibleAnchor(for: corner, display: assigned, window: window)
        let endpoint = WindowParkingPlan.offscreenEndpoint(
          for: corner, display: assigned, window: window)
        return !rectanglesIntersect(sweptRectangle(anchor, endpoint), neighbor)
      }
      XCTAssertEqual(available, expectedAvailable, "diagnostic case \(caseIndex)")
    }
  }

  func testNoTopologySafeDiagnosticCorner() {
    let assigned = InventoryRect(x: 0, y: 0, width: 1_000, height: 800)
    let window = InventoryRect(x: 0, y: 0, width: 400, height: 300)
    let neighbors = [
      InventoryRect(x: -1_000, y: 0, width: 1_000, height: 800),
      InventoryRect(x: 1_000, y: 0, width: 1_000, height: 800),
      InventoryRect(x: 0, y: -800, width: 1_000, height: 800),
      InventoryRect(x: 0, y: 800, width: 1_000, height: 800),
    ]
    XCTAssertTrue(
      WindowParkingPlan.availableCorners(on: assigned, avoiding: neighbors, window: window).isEmpty)
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

  func testFingerprintIgnoresNeighborArrangementButTracksOwnGeometry() throws {
    let os = OperatingSystemVersion(majorVersion: 26, minorVersion: 0, patchVersion: 0)
    let left = observedDisplay(id: "left", primary: true, frame: display)

    // Connecting, disconnecting, or rearranging neighbors never changes this display's key:
    // measured parking extents are display-local OS properties.
    let withRight = [left, observedDisplay(id: "right", primary: false, frame: .init(x: 1920, y: 0, width: 1920, height: 1080))]
    let withFarRight = [left, observedDisplay(id: "right", primary: false, frame: .init(x: 4000, y: -500, width: 1000, height: 900))]
    let keyWithRight = try ParkingDiagnosticIdentity.key(displayID: "left", displays: withRight, operatingSystem: os)
    XCTAssertEqual(
      keyWithRight,
      try ParkingDiagnosticIdentity.key(displayID: "left", displays: withFarRight, operatingSystem: os))
    XCTAssertEqual(
      keyWithRight,
      try ParkingDiagnosticIdentity.key(displayID: "left", displays: [left], operatingSystem: os))

    // The display's own geometry is part of the key.
    var movedLeft = left
    movedLeft.frame.x = 100
    XCTAssertNotEqual(
      keyWithRight,
      try ParkingDiagnosticIdentity.key(displayID: "left", displays: [movedLeft], operatingSystem: os))

    // Unknown displays cannot produce a key.
    XCTAssertThrowsError(
      try ParkingDiagnosticIdentity.key(
        displayID: "missing", displays: [left], operatingSystem: os))
  }

  func testNeighborOverhangDeterminesBottomRightViability() throws {
    // User scenario: A clamps at 60px vertical visibility; its bottom-right target spans
    // rows [740, 1040] and columns [999, 1399] for a 400x300 window.
    let assigned = InventoryRect(x: 0, y: 0, width: 1_000, height: 800)
    let limits = ParkingVisibility(horizontal: 1, vertical: 60)
    let windowFrame = InventoryRect(x: 0, y: 0, width: 400, height: 300)
    let diagnosis = ResolvedDiagnostic(
      value: ParkingLimits(corners: Dictionary(uniqueKeysWithValues: ParkingCorner.allCases.map {
        ($0, limits)
      })),
      provenance: .init(key: .init(id: "parking-limits", revision: 7, fingerprint: "test")))
    let target = WindowParkingPlan.target(
      for: .bottomRight, display: assigned, window: windowFrame, limits: limits)
    XCTAssertEqual(target.x, 999)
    XCTAssertEqual(target.y, 740)

    func bottomRightViable(_ neighbor: InventoryRect) -> Bool {
      WindowParkingPlan.alternatives(
        displayFrame: assigned, otherDisplayFrames: [neighbor], windowFrame: windowFrame,
        diagnosis: diagnosis
      ).contains { $0.corner == .bottomRight }
    }

    // Neighbor whose bottom sits only 30px above A's bottom overlaps the overhang and blocks
    // the corner; disconnecting it makes the corner viable.
    let closeBottomNeighbor = InventoryRect(x: 1_000, y: 770 - 900, width: 1_200, height: 900)
    XCTAssertTrue(rectanglesIntersect(target, closeBottomNeighbor))
    XCTAssertFalse(bottomRightViable(closeBottomNeighbor))

    // A neighbor whose bottom edge exactly meets the target's top edge only touches it, so the
    // corner stays viable.
    let exactNeighbor = InventoryRect(x: 1_000, y: 740 - 900, width: 1_200, height: 900)
    XCTAssertFalse(rectanglesIntersect(target, exactNeighbor))
    XCTAssertTrue(bottomRightViable(exactNeighbor))

    // That new neighbor's own bottom-left corner hangs left over A and is not viable.
    let neighborDiagnosis = ResolvedDiagnostic(
      value: ParkingLimits(corners: Dictionary(uniqueKeysWithValues: ParkingCorner.allCases.map {
        ($0, ParkingVisibility(horizontal: 1, vertical: 52))
      })),
      provenance: diagnosis.provenance)
    XCTAssertFalse(
      WindowParkingPlan.alternatives(
        displayFrame: exactNeighbor, otherDisplayFrames: [assigned], windowFrame: windowFrame,
        diagnosis: neighborDiagnosis
      ).contains { $0.corner == .bottomLeft })
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

private actor RequestLog {
  private var doubles: [Double] = []
  private var rects: [InventoryRect] = []
  func append(_ value: Double) { doubles.append(value) }
  func append(_ frame: InventoryRect) { rects.append(frame) }
  var recordedDoubles: [Double] { doubles }
  var recordedRects: [InventoryRect] { rects }
  var lastFrame: InventoryRect? { rects.last }
}

private actor ProbeCounter {
  private(set) var count = 0
  func increment() { count += 1 }
}

private actor RequestRecorder {
  private var seen: Set<Double> = []
  func isRepeat(_ value: Double) -> Bool { seen.contains(value) }
  func record(_ value: Double) { seen.insert(value) }
}

private struct SeededRandom {
  private var state: UInt64
  init(seed: UInt64) { state = seed }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var value = state
    value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
    value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
    return value ^ (value >> 31)
  }
  mutating func bool() -> Bool { next().isMultiple(of: 2) }
  mutating func int(in range: ClosedRange<Int>) -> Int {
    range.lowerBound + Int(next() % UInt64(range.count))
  }
}

private let diagnosis = ResolvedDiagnostic(
  value: ParkingLimits(
    corners: Dictionary(
      uniqueKeysWithValues: ParkingCorner.allCases.map {
        ($0, ParkingVisibility(horizontal: 1, vertical: 52))
      })),
  provenance: .init(key: .init(id: "parking-limits", revision: 1, fingerprint: "test")))

private func limitsDiagnosis(vertical: Double) -> ResolvedDiagnostic<ParkingLimits> {
  limitsDiagnosis(horizontal: 1, vertical: vertical)
}

private func limitsDiagnosis(horizontal: Double, vertical: Double) -> ResolvedDiagnostic<
  ParkingLimits
> {
  .init(
    value: .init(
      corners: Dictionary(
        uniqueKeysWithValues: ParkingCorner.allCases.map {
          ($0, ParkingVisibility(horizontal: horizontal, vertical: vertical))
        })),
    provenance: diagnosis.provenance)
}

private func rectanglesIntersect(_ lhs: InventoryRect, _ rhs: InventoryRect) -> Bool {
  lhs.x < rhs.x + rhs.width && lhs.x + lhs.width > rhs.x
    && lhs.y < rhs.y + rhs.height && lhs.y + lhs.height > rhs.y
}

private func sweptRectangle(_ start: InventoryRect, _ endpoint: InventoryRect) -> InventoryRect {
  .init(
    x: min(start.x, endpoint.x), y: min(start.y, endpoint.y),
    width: abs(endpoint.x - start.x) + start.width,
    height: abs(endpoint.y - start.y) + start.height)
}

private func generatedNeighbor(
  _ arrangement: Int, assigned: InventoryRect, random: inout SeededRandom
) -> InventoryRect {
  let gap = Double(random.int(in: 0...120))
  let width = Double(random.int(in: 300...1_800))
  let height = Double(random.int(in: 300...1_400))
  let staggerX = Double(random.int(in: -Int(width / 2)...Int(assigned.width / 2)))
  let staggerY = Double(random.int(in: -Int(height / 2)...Int(assigned.height / 2)))
  switch arrangement {
  case 0:
    return .init(x: assigned.width + gap, y: staggerY, width: width, height: height)
  case 1:
    return .init(x: -width - gap, y: staggerY, width: width, height: height)
  case 2:
    return .init(x: staggerX, y: assigned.height + gap, width: width, height: height)
  case 3:
    return .init(x: staggerX, y: -height - gap, width: width, height: height)
  default:
    return .init(
      x: assigned.width + gap, y: assigned.height + gap, width: width, height: height)
  }
}

private let display = InventoryRect(x: 0, y: 0, width: 1920, height: 1080)
private let window = InventoryRect(x: 200, y: 100, width: 800, height: 600)

private func observedDisplay(id: String, primary: Bool, frame: InventoryRect) -> DisplayObservation
{
  .init(
    id: id, name: id, isBuiltin: primary, isPrimary: primary, frame: frame, visibleFrame: frame,
    backingScale: 1, identifiers: .init())
}
