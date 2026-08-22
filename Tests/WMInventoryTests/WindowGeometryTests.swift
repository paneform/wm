import Foundation
import WMProtocol
import XCTest

@testable import WMInventory

final class WindowGeometryTests: XCTestCase {
  func testExactFrameSucceedsOnFirstStrategy() async throws {
    let adapter = FakeGeometryAdapter(frame: initialFrame)
    let service = WindowGeometryService(adapter: adapter, now: { fixedDate })
    let result = try await service.set(
      window: window, params: .init(windowID: window.id, frame: requestedFrame))

    XCTAssertTrue(result.verified)
    XCTAssertEqual(result.attempts, 1)
    XCTAssertEqual(result.strategy, .positionThenSize)
    let writes = await adapter.writes
    XCTAssertEqual(writes, [.position, .size])
  }

  func testClampedFrameFailsVerificationWithObservedFrame() async throws {
    let adapter = FakeGeometryAdapter(
      frame: initialFrame,
      transform: { frame, _ in
        InventoryRect(x: frame.x, y: frame.y, width: min(frame.width, 800), height: frame.height)
      })
    let service = WindowGeometryService(adapter: adapter)

    do {
      _ = try await service.set(
        window: window, params: .init(windowID: window.id, frame: requestedFrame, attempts: 3))
      XCTFail("expected verification failure")
    } catch let error as WindowGeometryFailure {
      XCTAssertEqual(error.code, .geometryVerificationFailed)
      XCTAssertEqual(error.observedFrame?.width, 800)
    }
  }

  func testSecondStrategyCanSucceed() async throws {
    let adapter = FakeGeometryAdapter(frame: initialFrame, acceptedAttempt: 2)
    let result = try await WindowGeometryService(adapter: adapter).set(
      window: window, params: .init(windowID: window.id, frame: requestedFrame))

    XCTAssertEqual(result.attempts, 2)
    XCTAssertEqual(result.strategy, .sizeThenPosition)
    let writes = await adapter.writes
    XCTAssertEqual(writes, [.position, .size, .size])
  }

  func testDefaultEnginePolicyRetriesFiveTimes() async throws {
    let adapter = TransactionGeometryAdapter(frame: initialFrame, exactTransaction: 5)
    let outcome = try await WindowGeometryService(adapter: adapter).setGeometry(
      window: window, request: .init(frame: .init(requestedFrame))
    )

    XCTAssertEqual(outcome.classification, .exact)
    XCTAssertEqual(outcome.attempts, 5)
  }

  func testEngineReportsProgressWhenRetryBudgetEndsMidTrajectory() async throws {
    let adapter = FakeGeometryAdapter(
      frame: initialFrame,
      transform: { requested, attempt in
        .init(
          x: requested.x, y: requested.y,
          width: 400 + Double(attempt * 50), height: 300 + Double(attempt * 50)
        )
      })
    let outcome = try await WindowGeometryService(adapter: adapter).setGeometry(
      window: window,
      request: .init(frame: .init(requestedFrame), policy: .init(maximumAttempts: 2))
    )

    XCTAssertEqual(outcome.classification, .progressing)
    XCTAssertEqual(outcome.attempts, 2)
  }

  func testKnownMinimumIsAcceptedAsStableConstraint() async throws {
    let recorder = WindowGeometryProfileRecorder(
      catalog: .init(profiles: [
        .init(
          identity: .init(window: window)!, context: .init(), minimumWidth: 1_000,
          correctiveAttemptCount: 1, sampleCount: 3, successfulSampleCount: 3,
          lastObservedAt: fixedDate
        )
      ]))
    let adapter = FakeGeometryAdapter(
      frame: initialFrame,
      transform: { requested, _ in
        .init(x: requested.x, y: requested.y, width: 1_000, height: requested.height)
      })
    let outcome = try await WindowGeometryService(adapter: adapter, profiles: recorder).setGeometry(
      window: window, request: .init(frame: .init(requestedFrame))
    )

    XCTAssertEqual(outcome.classification, .constrained)
    XCTAssertEqual(outcome.attempts, 1)
  }

  func testConstraintFromOtherTopologyIsNotAccepted() async throws {
    let recorder = WindowGeometryProfileRecorder(
      catalog: .init(profiles: [
        .init(
          identity: .init(window: window)!, context: .init(topologyFingerprint: "display-a"),
          minimumWidth: 1_000, correctiveAttemptCount: 1, sampleCount: 3,
          successfulSampleCount: 3, lastObservedAt: fixedDate
        )
      ]))
    let adapter = FakeGeometryAdapter(
      frame: initialFrame,
      transform: { requested, _ in
        .init(x: requested.x, y: requested.y, width: 1_000, height: requested.height)
      })
    let service = WindowGeometryService(
      adapter: adapter, profiles: recorder,
      profileContext: { _ in .init(topologyFingerprint: "display-b") }
    )
    let outcome = try await service.setGeometry(
      window: window,
      request: .init(frame: .init(requestedFrame), policy: .init(maximumAttempts: 2))
    )

    XCTAssertEqual(outcome.classification, .failed)
    XCTAssertEqual(outcome.attempts, 2)
  }

  func testStoreAndReuseDoesNotCapEscalationAtLearnedAttemptCount() async throws {
    let recorder = WindowGeometryProfileRecorder(
      catalog: .init(profiles: [
        .init(
          identity: .init(window: window)!, context: .init(), correctiveAttemptCount: 2,
          sampleCount: 3, successfulSampleCount: 3, lastObservedAt: fixedDate
        )
      ]))
    let adapter = TransactionGeometryAdapter(frame: initialFrame, exactTransaction: 4)
    let outcome = try await WindowGeometryService(adapter: adapter, profiles: recorder).setGeometry(
      window: window, request: .init(frame: .init(requestedFrame))
    )

    XCTAssertEqual(outcome.classification, .exact)
    XCTAssertEqual(outcome.attempts, 4)
    let transactions = await adapter.transactions
    XCTAssertEqual(transactions, Array(repeating: .sizePositionSize, count: 4))
  }

  func testInferEveryRequestIgnoresProfileForClassificationAndPersistence() async throws {
    let recorder = WindowGeometryProfileRecorder(
      catalog: .init(profiles: [
        .init(
          identity: .init(window: window)!, context: .init(), minimumWidth: 1_000,
          correctiveAttemptCount: 2, sampleCount: 3, successfulSampleCount: 3,
          lastObservedAt: fixedDate
        )
      ]))
    let adapter = FakeGeometryAdapter(
      frame: initialFrame,
      transform: { requested, _ in
        .init(x: requested.x, y: requested.y, width: 1_000, height: requested.height)
      })
    let outcome = try await WindowGeometryService(adapter: adapter, profiles: recorder).setGeometry(
      window: window,
      request: .init(
        frame: .init(requestedFrame),
        policy: .init(maximumAttempts: 3, mode: .inferEveryRequest)
      )
    )

    XCTAssertEqual(outcome.classification, .failed)
    XCTAssertEqual(outcome.attempts, 3)
    let profile = await recorder.profile(for: window)
    XCTAssertEqual(profile?.sampleCount, 3)
    XCTAssertEqual(profile?.correctiveAttemptCount, 2)
  }

  func testOptimisticIdealFirstUsesLearnedCorrectiveFallbackAndKeepsEscalating() async throws {
    let recorder = WindowGeometryProfileRecorder(
      catalog: .init(profiles: [
        .init(
          identity: .init(window: window)!, context: .init(), correctiveAttemptCount: 4,
          sampleCount: 3, successfulSampleCount: 3, lastObservedAt: fixedDate
        )
      ]))
    let adapter = TransactionGeometryAdapter(frame: initialFrame, exactTransaction: 4)
    let outcome = try await WindowGeometryService(adapter: adapter, profiles: recorder).setGeometry(
      window: window,
      request: .init(
        frame: .init(requestedFrame),
        policy: .init(maximumAttempts: 5, mode: .optimisticIdealFirst)
      )
    )

    XCTAssertEqual(outcome.classification, .exact)
    XCTAssertEqual(outcome.attempts, 4)
    let transactions = await adapter.transactions
    XCTAssertEqual(
      transactions, [.positionSize, .sizePositionSize, .sizePositionSize, .sizePositionSize])
  }

  func testUnknownStableClampIsLearnedButNotAccepted() async throws {
    let recorder = WindowGeometryProfileRecorder()
    let clamped = InventoryRect(x: 100, y: 100, width: 1_000, height: 700)
    for sample in 1...3 {
      let adapter = FakeGeometryAdapter(frame: initialFrame, transform: { _, _ in clamped })
      let outcome = try await WindowGeometryService(adapter: adapter, profiles: recorder)
        .setGeometry(
          window: window,
          request: .init(frame: .init(requestedFrame), policy: .init(maximumAttempts: 2))
        )
      XCTAssertEqual(outcome.classification, sample == 1 ? .failed : .constrained)
    }

    let profile = await recorder.profile(for: window)
    XCTAssertEqual(profile?.minimumWidth, 1_000)
    XCTAssertEqual(profile?.successfulSampleCount, 1)
    XCTAssertEqual(profile?.correctiveAttemptCount, 1)
  }

  func testUnknownStableClampIsPromotedWithinOneRequest() async throws {
    let recorder = WindowGeometryProfileRecorder()
    let requested = InventoryRect(x: 0, y: 32, width: 756, height: 950)
    let clamped = InventoryRect(x: 0, y: 32, width: 800, height: 950)
    let fullscreen = InventoryRect(x: 0, y: 32, width: 1_512, height: 950)
    let adapter = FakeGeometryAdapter(frame: fullscreen, transform: { _, _ in clamped })

    let outcome = try await WindowGeometryService(adapter: adapter, profiles: recorder).setGeometry(
      window: window,
      request: .init(frame: requested, policy: .init(maximumAttempts: 5))
    )

    XCTAssertEqual(outcome.classification, .constrained)
    XCTAssertEqual(outcome.observedFrame, clamped)
    XCTAssertEqual(outcome.attempts, 4)
    let profile = await recorder.profile(for: window)
    XCTAssertEqual(profile?.minimumWidth, 800)
  }

  func testWorkAreaClampedStableOutcomeIsNotPersistedAsAppConstraint() async throws {
    let recorder = WindowGeometryProfileRecorder()
    let workArea = InventoryRect(x: 0, y: 25, width: 1_512, height: 982)
    let requested = InventoryRect(x: 756, y: 25, width: 900, height: 982)
    let clamped = InventoryRect(x: 756, y: 25, width: 756, height: 982)
    for _ in 0..<3 {
      let adapter = FakeGeometryAdapter(frame: workArea, transform: { _, _ in clamped })
      let outcome = try await WindowGeometryService(adapter: adapter, profiles: recorder)
        .setGeometry(
          window: window,
          request: .init(
            frame: requested, policy: .init(maximumAttempts: 3), workArea: workArea)
        )
      XCTAssertEqual(outcome.classification, .failed)
    }

    let profile = await recorder.profile(for: window)
    XCTAssertNil(profile?.maximumWidth)
    XCTAssertEqual(profile?.pendingMaximumWidthSamples, 0)
    XCTAssertNil(profile?.minimumHeight)
    XCTAssertEqual(profile?.pendingMinimumHeightSamples, 0)
  }

  func testInteriorConstrainedOutcomeStillPersistsWithWorkAreaKnown() async throws {
    let recorder = WindowGeometryProfileRecorder()
    let workArea = InventoryRect(x: 0, y: 0, width: 3_440, height: 1_440)
    let requested = InventoryRect(x: 756, y: 32, width: 900, height: 982)
    let clamped = InventoryRect(x: 756, y: 32, width: 700, height: 982)
    let adapter = FakeGeometryAdapter(frame: requested, transform: { _, _ in clamped })
    let outcome = try await WindowGeometryService(adapter: adapter, profiles: recorder)
      .setGeometry(
        window: window,
        request: .init(
          frame: requested, policy: .init(maximumAttempts: 5), workArea: workArea)
      )

    XCTAssertEqual(outcome.classification, .constrained)
    let profile = await recorder.profile(for: window)
    XCTAssertEqual(profile?.maximumWidth, 700)
  }

  func testUnchangedInitialFrameIsNotLearnedAsMinimum() async throws {
    let recorder = WindowGeometryProfileRecorder()
    let fullscreen = InventoryRect(x: 100, y: 100, width: 1_512, height: 700)
    for _ in 0..<3 {
      let adapter = FakeGeometryAdapter(frame: fullscreen, transform: { _, _ in fullscreen })
      let outcome = try await WindowGeometryService(adapter: adapter, profiles: recorder)
        .setGeometry(
          window: window,
          request: .init(frame: .init(requestedFrame), policy: .init(maximumAttempts: 2))
        )
      XCTAssertEqual(outcome.classification, .failed)
    }

    let profile = await recorder.profile(for: window)
    XCTAssertNil(profile?.minimumWidth)
    XCTAssertEqual(profile?.pendingMinimumWidthSamples, 0)
  }

  func testSetDoesNotOverwriteProgressingAnimation() async throws {
    let adapter = TrajectoryGeometryAdapter(frames: [
      initialFrame,
      .init(x: 25, y: 25, width: 525, height: 400),
      .init(x: 50, y: 50, width: 650, height: 500),
      .init(requestedFrame), .init(requestedFrame), .init(requestedFrame),
    ])

    let result = try await WindowGeometryService(adapter: adapter).set(
      window: window, params: .init(windowID: window.id, frame: requestedFrame, attempts: 4)
    )

    XCTAssertEqual(result.attempts, 1)
    let transactions = await adapter.transactions
    XCTAssertEqual(transactions, 1)
  }

  func testSetPollsUntilAnimatedFrameSettles() async throws {
    let adapter = FakeGeometryAdapter(frame: initialFrame, settleAfterReads: 4)
    let result = try await WindowGeometryService(adapter: adapter).set(
      window: window, params: .init(windowID: window.id, frame: requestedFrame, attempts: 1)
    )

    XCTAssertEqual(result.observedFrame, requestedFrame)
    let reads = await adapter.readCalls
    XCTAssertGreaterThanOrEqual(reads, 4)
  }

  func testConvergedStrategyReappliesPositionAfterWindowReanchors() async throws {
    let adapter = ReanchoringGeometryAdapter(frame: initialFrame)
    let result = try await WindowGeometryService(adapter: adapter).set(
      window: window,
      params: .init(windowID: window.id, frame: requestedFrame, attempts: 4)
    )

    XCTAssertEqual(result.strategy, .convergedSizeThenPosition)
    XCTAssertEqual(result.observedFrame, requestedFrame)
  }

  func testNativeFitMustRemainInsideDestinationBounds() async throws {
    let bounds = InventoryRect(x: 0, y: 32, width: 1512, height: 950)
    let adapter = FakeGeometryAdapter(frame: InventoryRect(x: 0, y: 32, width: 2434, height: 974))
    await adapter.setFitFrame(bounds)
    let observed = try await WindowGeometryService(adapter: adapter).fit(
      window: window, within: bounds)

    XCTAssertEqual(observed, bounds)
  }

  func testFitAnchorsInsideDestinationBeforeExpanding() async throws {
    let bounds = InventoryRect(x: 0, y: 32, width: 1512, height: 950)
    let adapter = FakeGeometryAdapter(
      frame: InventoryRect(x: -1030, y: -1440, width: 3440, height: 1440))
    let observed = try await WindowGeometryService(adapter: adapter).fit(
      window: window, within: bounds)

    XCTAssertEqual(observed, bounds)
    let requested = await adapter.requestedFrames
    XCTAssertEqual(requested.first, InventoryRect(x: 0, y: 32, width: 1134, height: 712.5))
    XCTAssertEqual(requested.last, bounds)
  }

  func testFitRetriesPlatformConstrainedFrameUntilExactTarget() async throws {
    let bounds = InventoryRect(x: -1030, y: -1440, width: 3440, height: 1440)
    let constrained = InventoryRect(x: -1030, y: -1440, width: 1562, height: 950)
    let adapter = FakeGeometryAdapter(
      frame: initialFrame,
      transform: { requested, attempt in
        attempt < 4 && requested == bounds ? constrained : requested
      })
    let observed = try await WindowGeometryService(adapter: adapter).fit(
      window: window, within: bounds)

    XCTAssertEqual(observed, bounds)
  }

  func testFitAcceptsContainedPlatformConstraint() async throws {
    let bounds = InventoryRect(x: -1030, y: -1440, width: 3440, height: 1440)
    let constrained = InventoryRect(x: -1030, y: -1440, width: 1642, height: 950)
    let adapter = FakeGeometryAdapter(
      frame: initialFrame,
      transform: { requested, _ in
        requested == bounds ? constrained : requested
      })

    let observed = try await WindowGeometryService(adapter: adapter).fit(
      window: window, within: bounds)

    XCTAssertEqual(observed, constrained)
  }

  func testUnresolvedIdentityNeverWrites() async throws {
    for error in [WindowGeometryAdapterError.notFound, .stale, .ambiguous] {
      let adapter = FakeGeometryAdapter(frame: initialFrame, resolveError: error)
      do {
        _ = try await WindowGeometryService(adapter: adapter).set(
          window: window, params: .init(windowID: window.id, frame: requestedFrame))
        XCTFail("expected resolution failure")
      } catch is WindowGeometryFailure {}
      let writes = await adapter.writes
      XCTAssertTrue(writes.isEmpty)
    }
  }

  func testInvalidValuesRejectBeforePlatformCalls() async throws {
    let adapter = FakeGeometryAdapter(frame: initialFrame)
    let invalid = Rectangle(x: 0, y: 0, width: .infinity, height: 10)
    do {
      _ = try await WindowGeometryService(adapter: adapter).set(
        window: window,
        params: .init(windowID: window.id, frame: invalid, tolerance: 21, attempts: 6))
      XCTFail("expected invalid frame")
    } catch is WindowGeometryFailure {}
    let resolveCalls = await adapter.resolveCalls
    XCTAssertEqual(resolveCalls, 0)
  }

  func testSequentialCommandsReuseExplicitHandleAfterFrameChanges() async throws {
    let adapter = FakeGeometryAdapter(frame: initialFrame)
    let service = WindowGeometryService(adapter: adapter)
    _ = try await service.set(
      window: window, params: .init(windowID: window.id, frame: requestedFrame))
    let observed = try await service.get(window: window)

    XCTAssertEqual(observed.frame, requestedFrame)
    let resolveCalls = await adapter.resolveCalls
    let createdHandles = await adapter.createdHandles
    XCTAssertEqual(resolveCalls, 2)
    XCTAssertEqual(createdHandles, 1)
  }

  func testReconcileRetainsHandleAcrossTemporaryInventoryOmission() async throws {
    let adapter = FakeGeometryAdapter(frame: initialFrame)
    let service = WindowGeometryService(adapter: adapter)
    _ = try await service.get(window: window)
    await service.reconcile(windows: [])
    _ = try await service.get(window: window)

    let createdHandles = await adapter.createdHandles
    XCTAssertEqual(createdHandles, 1)
  }

  func testLifetimeEvictionDoesNotEvictSameIDReplacement() async throws {
    let adapter = FakeGeometryAdapter(frame: initialFrame)
    let service = WindowGeometryService(adapter: adapter)
    let replacement = NormalizedWindow(
      id: window.id, pid: 8, appName: window.appName, title: window.title, role: window.role,
      subrole: window.subrole, frame: window.frame, classification: .normal, management: .managed,
      rejectionReasons: [], cgWindowID: window.cgWindowID, joinConfidence: .exact, joinSignals: [],
      health: .healthy, healthIssues: []
    )
    _ = try await service.get(window: replacement)
    await service.evict(lifetimes: [.init(windowID: window.id, pid: 7)])
    _ = try await service.get(window: replacement)

    let createdHandles = await adapter.createdHandles
    XCTAssertEqual(createdHandles, 1)
  }

  func testProbeConfirmsMovementResizeAndRestores() async throws {
    let adapter = ProbeGeometryAdapter(frame: initialFrame)
    let result = try await WindowGeometryService(adapter: adapter).probeCapabilities(window: window)

    XCTAssertEqual(result.position.confirmed, .supported)
    XCTAssertEqual(result.size.confirmed, .supported)
    XCTAssertTrue(result.restoration.verified)
    XCTAssertEqual(result.finalFrame, initialFrame.protocolFrame)
  }

  func testProbeClassifiesNoObservedChangeAsInconclusive() async throws {
    let adapter = ProbeGeometryAdapter(frame: initialFrame, behavior: .fixed)
    let result = try await WindowGeometryService(adapter: adapter).probeCapabilities(window: window)

    XCTAssertEqual(result.position.confirmed, .inconclusive)
    XCTAssertEqual(result.size.confirmed, .inconclusive)
    XCTAssertTrue(result.restoration.verified)
  }

  func testProbeClassifiesClampingAsInconclusive() async throws {
    let adapter = ProbeGeometryAdapter(frame: initialFrame, behavior: .clamped)
    let result = try await WindowGeometryService(adapter: adapter).probeCapabilities(window: window)

    XCTAssertEqual(result.position.confirmed, .inconclusive)
    XCTAssertEqual(result.size.confirmed, .inconclusive)
    XCTAssertFalse(result.restoration.verified)
  }

  func testProbeReportsRestorationFailure() async throws {
    let adapter = ProbeGeometryAdapter(frame: initialFrame, behavior: .restorationFailure)
    let result = try await WindowGeometryService(adapter: adapter).probeCapabilities(window: window)

    XCTAssertTrue(result.restoration.attempted)
    XCTAssertFalse(result.restoration.verified)
    XCTAssertNotNil(result.restoration.error)
  }

  func testProbeStaleIdentityIsInconclusiveAndAttemptsRestoration() async throws {
    let adapter = ProbeGeometryAdapter(frame: initialFrame, behavior: .stale)
    let result = try await WindowGeometryService(adapter: adapter).probeCapabilities(window: window)

    XCTAssertEqual(result.position.confirmed, .inconclusive)
    XCTAssertEqual(result.size.confirmed, .inconclusive)
    XCTAssertTrue(result.restoration.attempted)
  }

  func testProbeCancellationRestoresAndRethrows() async throws {
    let adapter = ProbeGeometryAdapter(frame: initialFrame, behavior: .cancelled)
    do {
      _ = try await WindowGeometryService(adapter: adapter).probeCapabilities(window: window)
      XCTFail("expected cancellation")
    } catch is CancellationError {}
    let state = await adapter.state
    XCTAssertEqual(state.frame, initialFrame)
    XCTAssertEqual(state.writes, 2)
  }

  func testProbeIdentityReplacementStopsBeforeMutatingReplacement() async throws {
    let adapter = ProbeGeometryAdapter(frame: initialFrame, behavior: .replacement)
    let result = try await WindowGeometryService(adapter: adapter).probeCapabilities(window: window)
    let state = await adapter.state
    XCTAssertEqual(state.writes, 1)
    XCTAssertEqual(result.position.confirmed, .inconclusive)
    XCTAssertFalse(result.restoration.verified)
  }

  func testProbeStopsAfterIntermediateResetFailure() async throws {
    let adapter = ProbeGeometryAdapter(frame: initialFrame, behavior: .restorationFailure)
    _ = try await WindowGeometryService(adapter: adapter).probeCapabilities(window: window)
    let state = await adapter.state
    XCTAssertEqual(state.probeWrites, 1)
  }

  func testProbeRestoresWithChangedComponentOnly() async throws {
    let adapter = ProbeGeometryAdapter(frame: initialFrame, behavior: .combinedRestorationFailure)
    let result = try await WindowGeometryService(adapter: adapter).probeCapabilities(window: window)

    XCTAssertEqual(result.position.confirmed, .supported)
    XCTAssertEqual(result.size.confirmed, .supported)
    XCTAssertTrue(result.restoration.verified)
    XCTAssertEqual(result.finalFrame, initialFrame.protocolFrame)
  }

  func testProbeContinuesAfterRejectedDirection() async throws {
    let adapter = ProbeGeometryAdapter(frame: initialFrame, behavior: .rejectFirstSize)
    let result = try await WindowGeometryService(adapter: adapter).probeCapabilities(window: window)

    XCTAssertEqual(result.attempts.count, 8)
    XCTAssertEqual(result.attempts[4].dimension, .widthIn)
    XCTAssertNotNil(result.attempts[4].error)
    XCTAssertEqual(result.attempts[5].dimension, .widthOut)
    XCTAssertEqual(result.size.confirmed, .inconclusive)
    XCTAssertTrue(result.restoration.verified)
  }

  func testProbeConfirmsFixedSizeWhenEveryResizeIsRejected() async throws {
    let adapter = ProbeGeometryAdapter(frame: initialFrame, behavior: .rejectAllSize)
    let result = try await WindowGeometryService(adapter: adapter).probeCapabilities(window: window)

    XCTAssertEqual(result.size.confirmed, .fixed)
    XCTAssertEqual(result.attempts.filter { $0.error != nil }.count, 4)
    XCTAssertTrue(result.restoration.verified)
  }

  func testProbeCrossComponentOnlyChangeIsInconclusive() async throws {
    let adapter = ProbeGeometryAdapter(frame: initialFrame, behavior: .crossComponent)
    let result = try await WindowGeometryService(adapter: adapter).probeCapabilities(window: window)
    XCTAssertEqual(result.position.confirmed, .inconclusive)
    XCTAssertEqual(result.size.confirmed, .inconclusive)
  }

  func testPositionOnlyWritePreservesSizeAndRejectsCrossComponentChange() async throws {
    var positionOnly = window
    positionOnly.geometryCapabilities = .init(
      position: .init(confirmed: .supported), size: .init(confirmed: .fixed))
    let adapter = ProbeGeometryAdapter(frame: initialFrame)
    let observed = try await WindowGeometryService(adapter: adapter).setPosition(
      window: positionOnly, frame: .init(x: 50, y: 60, width: 1, height: 1))
    XCTAssertEqual(observed, .init(x: 50, y: 60, width: 400, height: 300))

    let crossChanging = ProbeGeometryAdapter(frame: initialFrame, behavior: .crossComponent)
    do {
      _ = try await WindowGeometryService(adapter: crossChanging).setPosition(
        window: positionOnly, frame: .init(x: 50, y: 60, width: 1, height: 1))
      XCTFail("expected cross-component verification failure")
    } catch let failure as WindowGeometryFailure {
      XCTAssertEqual(failure.code, .geometryVerificationFailed)
    }
  }

  func testPositionOnlyWriteCanReturnClampEvidenceWithoutAllowingSizeDrift() async throws {
    var positionOnly = window
    positionOnly.geometryCapabilities = .init(
      position: .init(confirmed: .supported), size: .init(confirmed: .fixed))
    let clamping = ProbeGeometryAdapter(frame: initialFrame, behavior: .clamped)

    let observed = try await WindowGeometryService(adapter: clamping).setPositionAllowingClamping(
      window: positionOnly, frame: .init(x: 50, y: 60, width: 1, height: 1))

    XCTAssertEqual(observed, .init(x: 53, y: 63, width: 400, height: 300))
  }
}

private actor ProbeGeometryAdapter: WindowGeometryAdapter {
  enum Behavior {
    case normal, fixed, clamped, restorationFailure, combinedRestorationFailure
    case stale, cancelled, replacement, crossComponent, rejectFirstSize, rejectAllSize
  }
  private var frame: InventoryRect
  private let original: InventoryRect
  private let behavior: Behavior
  private var writes = 0
  private var replaced = false

  init(frame: InventoryRect, behavior: Behavior = .normal) {
    self.frame = frame
    original = frame
    self.behavior = behavior
  }
  func resolve(_ window: NormalizedWindow) -> WindowGeometryHandle { .init(rawValue: window.id) }
  func validateControllability(of handle: WindowGeometryHandle) {}
  func validateIdentity(of handle: WindowGeometryHandle, expected window: NormalizedWindow) throws {
    if behavior == .replacement, replaced { throw WindowGeometryAdapterError.stale }
  }
  private var probeWrites = 0
  var state: (frame: InventoryRect, writes: Int, probeWrites: Int) {
    (frame, writes, probeWrites)
  }
  func readFrame(of handle: WindowGeometryHandle) throws -> InventoryRect {
    if behavior == .stale, writes > 0 { throw WindowGeometryAdapterError.stale }
    return frame
  }
  func delay() {}
  func write(
    _ component: WindowGeometryComponent, frame requested: InventoryRect,
    to handle: WindowGeometryHandle
  ) throws {
    writes += 1
    if requested != original { probeWrites += 1 }
    if behavior == .replacement { replaced = true }
    if behavior == .restorationFailure, requested == original, writes > 1 {
      throw WindowGeometryAdapterError.rejected
    }
    if behavior == .rejectFirstSize, component == .size, requested.width < original.width {
      throw WindowGeometryAdapterError.rejected
    }
    if behavior == .rejectAllSize, component == .size {
      throw WindowGeometryAdapterError.rejected
    }
    switch behavior {
    case .fixed: break
    case .clamped:
      frame =
        component == .position
        ? .init(
          x: requested.x + 3, y: requested.y + 3, width: requested.width, height: requested.height)
        : .init(
          x: requested.x, y: requested.y, width: requested.width + 3,
          height: requested.height + 3)
    case .stale where writes > 1: throw WindowGeometryAdapterError.stale
    case .cancelled: frame = requested
    case .crossComponent:
      frame =
        component == .position
        ? .init(x: original.x, y: original.y, width: original.width + 1, height: original.height)
        : .init(x: original.x + 1, y: original.y, width: original.width, height: original.height)
    default: frame = requested
    }
  }
  func transact(
    _ transaction: WindowGeometryTransaction, frame requested: InventoryRect,
    handle: WindowGeometryHandle
  ) throws {
    if behavior == .combinedRestorationFailure, requested == original, writes > 0 {
      throw WindowGeometryAdapterError.rejected
    }
    if behavior == .stale, writes > 0 { throw WindowGeometryAdapterError.stale }
    frame = requested
  }
  func settle(_ handle: WindowGeometryHandle, requested: InventoryRect, tolerance: Double) throws
    -> WindowGeometrySettlement
  {
    if behavior == .cancelled, writes == 1 { throw CancellationError() }
    return .init(frame: frame, reads: 1)
  }
}

private actor FakeGeometryAdapter: WindowGeometryAdapter {
  private var frame: InventoryRect
  private let transform: @Sendable (InventoryRect, Int) -> InventoryRect
  private let acceptedAttempt: Int
  private let resolveError: WindowGeometryAdapterError?
  private let settleAfterReads: Int
  private(set) var writes: [WindowGeometryComponent] = []
  private(set) var resolveCalls = 0
  private(set) var createdHandles = 0
  private var focused = false
  private(set) var requestedFrames: [InventoryRect] = []
  private(set) var readCalls = 0
  private var pendingFrame: InventoryRect?
  private var handles: [String: WindowGeometryHandle] = [:]
  private var pids: [String: Int32] = [:]
  private var fitFrame: InventoryRect?

  init(
    frame: InventoryRect, acceptedAttempt: Int = 1, resolveError: WindowGeometryAdapterError? = nil,
    settleAfterReads: Int = 0,
    transform: @escaping @Sendable (InventoryRect, Int) -> InventoryRect = { frame, _ in frame }
  ) {
    self.frame = frame
    self.acceptedAttempt = acceptedAttempt
    self.resolveError = resolveError
    self.settleAfterReads = settleAfterReads
    self.transform = transform
  }

  func resolve(_ window: NormalizedWindow) throws -> WindowGeometryHandle {
    resolveCalls += 1
    if let resolveError { throw resolveError }
    if let handle = handles[window.id] { return handle }
    createdHandles += 1
    let handle = WindowGeometryHandle(rawValue: "\(window.id):\(createdHandles)")
    handles[window.id] = handle
    pids[window.id] = window.pid
    return handle
  }

  func evict(lifetimes: Set<WindowLifetime>) {
    for lifetime in lifetimes where pids[lifetime.windowID] == lifetime.pid {
      handles.removeValue(forKey: lifetime.windowID)
      pids.removeValue(forKey: lifetime.windowID)
    }
  }

  func reconcile(windows: [NormalizedWindow]) {
    // Session handles survive temporary scan omissions.
  }

  func validateControllability(of handle: WindowGeometryHandle) {}
  func readFrame(of handle: WindowGeometryHandle) -> InventoryRect {
    readCalls += 1
    if let pendingFrame, readCalls >= settleAfterReads {
      frame = pendingFrame
      self.pendingFrame = nil
    }
    return frame
  }

  func write(
    _ component: WindowGeometryComponent, frame requested: InventoryRect,
    to handle: WindowGeometryHandle
  ) {
    writes.append(component)
    requestedFrames.append(requested)
    let attempt = (writes.count + 1) / 2
    if attempt >= acceptedAttempt {
      let transformed = transform(requested, attempt)
      if settleAfterReads > 0 { pendingFrame = transformed } else { frame = transformed }
    }
  }

  func delay() {}
  func focus(_ handle: WindowGeometryHandle) { focused = true }
  func isFocused(_ handle: WindowGeometryHandle) -> Bool { focused }
  func setFitFrame(_ frame: InventoryRect) { fitFrame = frame }
  func fit(_ handle: WindowGeometryHandle, within frame: InventoryRect) {
    guard let fitFrame else { return }
    self.frame = fitFrame
  }
}

private actor ReanchoringGeometryAdapter: WindowGeometryAdapter {
  private var frame: InventoryRect
  private var writes = 0

  init(frame: InventoryRect) { self.frame = frame }
  func resolve(_ window: NormalizedWindow) -> WindowGeometryHandle { .init(rawValue: window.id) }
  func validateControllability(of handle: WindowGeometryHandle) {}
  func readFrame(of handle: WindowGeometryHandle) -> InventoryRect { frame }
  func delay() {}

  func write(
    _ component: WindowGeometryComponent, frame requested: InventoryRect,
    to handle: WindowGeometryHandle
  ) {
    writes += 1
    guard writes >= 7 else { return }
    switch component {
    case .size:
      frame.width = requested.width
      frame.height = requested.height
    case .position:
      frame.x = requested.x
      frame.y = requested.y
    }
  }
}

private actor TrajectoryGeometryAdapter: WindowGeometryAdapter {
  private var frames: [InventoryRect]
  private(set) var transactions = 0

  init(frames: [InventoryRect]) { self.frames = frames }
  func resolve(_ window: NormalizedWindow) -> WindowGeometryHandle { .init(rawValue: window.id) }
  func validateControllability(of handle: WindowGeometryHandle) {}
  func readFrame(of handle: WindowGeometryHandle) -> InventoryRect {
    if frames.count > 1 { return frames.removeFirst() }
    return frames[0]
  }
  func write(
    _ component: WindowGeometryComponent, frame: InventoryRect, to handle: WindowGeometryHandle
  ) {}
  func delay() {}
  func transact(
    _ transaction: WindowGeometryTransaction, frame: InventoryRect, handle: WindowGeometryHandle
  ) {
    transactions += 1
  }
}

private actor TransactionGeometryAdapter: WindowGeometryAdapter {
  private var frame: InventoryRect
  private let exactTransaction: Int
  private(set) var transactions: [WindowGeometryTransaction] = []

  init(frame: InventoryRect, exactTransaction: Int) {
    self.frame = frame
    self.exactTransaction = exactTransaction
  }

  func resolve(_ window: NormalizedWindow) -> WindowGeometryHandle { .init(rawValue: window.id) }
  func validateControllability(of handle: WindowGeometryHandle) {}
  func readFrame(of handle: WindowGeometryHandle) -> InventoryRect { frame }
  func write(
    _ component: WindowGeometryComponent, frame: InventoryRect, to handle: WindowGeometryHandle
  ) {}
  func delay() {}
  func transact(
    _ transaction: WindowGeometryTransaction, frame requested: InventoryRect,
    handle: WindowGeometryHandle
  ) {
    transactions.append(transaction)
    if transactions.count >= exactTransaction { frame = requested }
  }
}

private let fixedDate = Date(timeIntervalSince1970: 1_700_000_000)
private let initialFrame = InventoryRect(x: 0, y: 0, width: 400, height: 300)
private let requestedFrame = Rectangle(x: 100, y: 100, width: 900, height: 700)
private let window = NormalizedWindow(
  id: "window:test", pid: 7, appName: "Test", bundleID: "com.example.Test", title: "Document",
  role: "AXWindow", subrole: "AXStandardWindow", frame: initialFrame, classification: .normal,
  management: .unmanaged, rejectionReasons: [], cgWindowID: 42, joinConfidence: .exact,
  joinSignals: ["cg_window_id"], health: .healthy, healthIssues: [])
