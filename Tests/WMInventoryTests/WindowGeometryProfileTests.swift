import Foundation
import XCTest
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
}

private func profileWindow() -> NormalizedWindow {
    .init(
        id: "window:1", pid: 1, appName: "Test", bundleID: "com.example.Test",
        role: "AXWindow", subrole: "AXStandardWindow", classification: .normal,
        management: .managed, rejectionReasons: [], joinConfidence: .exact, joinSignals: [],
        health: .healthy, healthIssues: []
    )
}
