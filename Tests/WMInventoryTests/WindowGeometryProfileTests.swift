import Foundation
import XCTest
import WMProtocol
@testable import WMInventory

final class WindowGeometryProfileTests: XCTestCase {
    func testRecorderLearnsConstraintAndCorrectiveAttempts() async throws {
        let recorder = WindowGeometryProfileRecorder()
        let window = profileWindow()
        for sample in 1...3 {
            try await recorder.record(.init(
                window: window, context: .init(applicationVersion: "1.0", topologyFingerprint: "display-a"),
                requested: .init(x: 0, y: 0, width: 300, height: 200),
                observed: .init(x: 0, y: 0, width: 480, height: 240), attempts: sample,
                outcome: .constrained, observedAt: Date(timeIntervalSince1970: Double(sample))
            ))
        }
        let catalog = await recorder.snapshot()
        let profile = try XCTUnwrap(catalog.profiles.first)
        XCTAssertEqual(profile.identity.application, "com.example.Test")
        XCTAssertEqual(profile.minimumWidth, 480)
        XCTAssertEqual(profile.minimumHeight, 240)
        XCTAssertEqual(profile.correctiveAttemptCount, 3)
        XCTAssertEqual(profile.confidence, .learned)
    }

    func testContextPartitionsAppVersionAndTopology() async throws {
        let recorder = WindowGeometryProfileRecorder()
        for version in ["1.0", "2.0"] {
            try await recorder.record(.init(
                window: profileWindow(), context: .init(applicationVersion: version, topologyFingerprint: "display-a"),
                requested: .init(x: 0, y: 0, width: 300, height: 200),
                observed: .init(x: 0, y: 0, width: 300, height: 200), attempts: 1,
                outcome: .exact, observedAt: .distantPast
            ))
        }
        let catalog = await recorder.snapshot()
        XCTAssertEqual(catalog.profiles.count, 2)
    }

    func testMinimumRequiresThreeConsistentClampSamples() async throws {
        let recorder = WindowGeometryProfileRecorder()
        for width in [480.0, 620, 480, 480] {
            try await recorder.record(.init(
                window: profileWindow(), context: .init(),
                requested: .init(x: 0, y: 0, width: 300, height: 200),
                observed: .init(x: 0, y: 0, width: width, height: 200), attempts: 1,
                outcome: .constrained, observedAt: .distantPast
            ))
        }
        let pending = await recorder.profile(for: profileWindow())
        XCTAssertNil(pending?.minimumWidth)
        try await recorder.record(.init(
            window: profileWindow(), context: .init(),
            requested: .init(x: 0, y: 0, width: 300, height: 200),
            observed: .init(x: 0, y: 0, width: 480, height: 200), attempts: 1,
            outcome: .constrained, observedAt: .distantPast
        ))
        let learned = await recorder.profile(for: profileWindow())
        XCTAssertEqual(learned?.minimumWidth, 480)
    }

    func testMaximumRequiresThreeConsistentClampSamples() async throws {
        let recorder = WindowGeometryProfileRecorder()
        for _ in 0..<3 {
            try await recorder.record(.init(
                window: profileWindow(), context: .init(),
                requested: .init(x: 0, y: 0, width: 1_000, height: 900),
                observed: .init(x: 0, y: 0, width: 723, height: 900), attempts: 1,
                outcome: .constrained, observedAt: .distantPast
            ))
        }
        let profile = await recorder.profile(for: profileWindow())
        XCTAssertEqual(profile?.maximumWidth, 723)
        XCTAssertNil(profile?.maximumHeight)
    }

    func testFailedStableClampsPromoteMinimumWithoutLearningRetryCount() async throws {
        let recorder = WindowGeometryProfileRecorder()
        for attempt in 2...4 {
            try await recorder.record(.init(
                window: profileWindow(), context: .init(),
                requested: .init(x: 0, y: 0, width: 300, height: 200),
                observed: .init(x: 0, y: 0, width: 480, height: 200),
                attempts: attempt, outcome: .failed, stableClamp: true,
                observedAt: .distantPast
            ))
        }

        let profile = await recorder.profile(for: profileWindow())
        XCTAssertEqual(profile?.minimumWidth, 480)
        XCTAssertEqual(profile?.successfulSampleCount, 0)
        XCTAssertEqual(profile?.correctiveAttemptCount, 1)
    }

    func testProgressingHybridDoesNotPromoteMinimumOrRetryCount() async throws {
        let recorder = WindowGeometryProfileRecorder()
        for _ in 0..<3 {
            try await recorder.record(.init(
                window: profileWindow(), context: .init(topologyFingerprint: "displays"),
                requested: .init(x: 0, y: 0, width: 300, height: 200),
                observed: .init(x: -1_000, y: 0, width: 480, height: 200),
                attempts: 5, outcome: .progressing, stableClamp: false,
                observedAt: .distantPast
            ))
        }

        let profile = await recorder.profile(
            for: profileWindow(), context: .init(topologyFingerprint: "displays")
        )
        XCTAssertNil(profile?.minimumWidth)
        XCTAssertEqual(profile?.correctiveAttemptCount, 1)
    }

    func testExactObservationCorrectsContradictedMinimum() async throws {
        let window = profileWindow()
        let recorder = WindowGeometryProfileRecorder(catalog: .init(profiles: [.init(
            identity: WindowGeometryProfileIdentity(window: window)!, context: .init(),
            minimumWidth: 1_496, correctiveAttemptCount: 4, sampleCount: 10,
            successfulSampleCount: 8, lastObservedAt: .init()
        )]))

        try await recorder.record(.init(
            window: window, context: .init(),
            requested: .init(x: 0, y: 0, width: 712, height: 950),
            observed: .init(x: 0, y: 0, width: 712, height: 950),
            attempts: 1, outcome: .exact, observedAt: .init()
        ))

        let profile = await recorder.profile(for: window)
        XCTAssertEqual(profile?.minimumWidth, 712)
        XCTAssertEqual(profile?.pendingMinimumWidthSamples, 0)
    }

    func testWorkAreaFlushObservationsDoNotLearnConstraints() async throws {
        let recorder = WindowGeometryProfileRecorder()
        let workArea = InventoryRect(x: 0, y: 25, width: 1_512, height: 982)
        for _ in 0..<3 {
            try await recorder.record(.init(
                window: profileWindow(), context: .init(),
                requested: .init(x: 756, y: 25, width: 900, height: 950),
                observed: .init(x: 756, y: 25, width: 756, height: 982), attempts: 1,
                outcome: .constrained, observedAt: .distantPast, workArea: workArea
            ))
        }
        let profile = await recorder.profile(for: profileWindow())
        XCTAssertEqual(profile?.sampleCount, 3)
        XCTAssertNil(profile?.maximumWidth)
        XCTAssertEqual(profile?.pendingMaximumWidthSamples, 0)
        XCTAssertNil(profile?.minimumHeight)
        XCTAssertEqual(profile?.pendingMinimumHeightSamples, 0)
    }

    func testLeftFlushObservationDoesNotLearnMinimum() async throws {
        let recorder = WindowGeometryProfileRecorder()
        let workArea = InventoryRect(x: 0, y: 0, width: 1_512, height: 982)
        for _ in 0..<3 {
            try await recorder.record(.init(
                window: profileWindow(), context: .init(),
                requested: .init(x: 0, y: 0, width: 300, height: 500),
                observed: .init(x: 0, y: 0, width: 480, height: 500), attempts: 1,
                outcome: .constrained, observedAt: .distantPast, workArea: workArea
            ))
        }
        let profile = await recorder.profile(for: profileWindow())
        XCTAssertNil(profile?.minimumWidth)
        XCTAssertEqual(profile?.pendingMinimumWidthSamples, 0)
    }

    func testInteriorObservationsStillLearnWithWorkAreaPresent() async throws {
        let recorder = WindowGeometryProfileRecorder()
        let workArea = InventoryRect(x: 0, y: 0, width: 3_440, height: 1_440)
        for _ in 0..<3 {
            try await recorder.record(.init(
                window: profileWindow(), context: .init(),
                requested: .init(x: 756, y: 0, width: 300, height: 500),
                observed: .init(x: 760, y: 10, width: 480, height: 510), attempts: 1,
                outcome: .constrained, observedAt: .distantPast, workArea: workArea
            ))
        }
        let profile = await recorder.profile(for: profileWindow())
        XCTAssertEqual(profile?.minimumWidth, 480)
        XCTAssertEqual(profile?.minimumHeight, 510)
    }

    func testCapabilityPrecedenceAndProfileMerge() async throws {
        var reportedFixed = profileWindow()
        reportedFixed.geometryCapabilities.position.reported = .fixed
        XCTAssertEqual(
            WindowCapabilityPolicy.admission(for: reportedFixed.geometryCapabilities), .unmanaged)
        reportedFixed.geometryCapabilities.position.confirmed = .supported
        reportedFixed.geometryCapabilities.size.reported = .fixed
        XCTAssertEqual(
            WindowCapabilityPolicy.admission(for: reportedFixed.geometryCapabilities), .floating)
        reportedFixed.geometryCapabilities.size.confirmed = .supported
        XCTAssertEqual(
            WindowCapabilityPolicy.admission(for: reportedFixed.geometryCapabilities), .bsp)

        let recorder = WindowGeometryProfileRecorder()
        try await recorder.recordCapabilities(
            .init(position: .init(confirmed: .supported), size: .init(confirmed: .fixed)),
            for: profileWindow())
        let merged = await recorder.mergingCapabilities(into: profileInventory(profileWindow()))
        XCTAssertEqual(merged.windows[0].geometryCapabilities.position.confirmed, .supported)
        XCTAssertEqual(merged.windows[0].geometryCapabilities.size.confirmed, .fixed)
    }
}

private func profileInventory(_ window: NormalizedWindow) -> InventorySnapshot {
    .init(
        timestamp: .distantPast, durationMilliseconds: 0, displays: [], rawAXWindows: [],
        rawCGWindows: [], windows: [window], rejectedAXWindows: [], joinDecisions: [],
        sourceHealth: [], appScans: [])
}

private func profileWindow() -> NormalizedWindow {
    .init(
        id: "window:1", pid: 1, appName: "Test", bundleID: "com.example.Test",
        role: "AXWindow", subrole: "AXStandardWindow", classification: .normal,
        management: .managed, rejectionReasons: [], joinConfidence: .exact, joinSignals: [],
        health: .healthy, healthIssues: []
    )
}
