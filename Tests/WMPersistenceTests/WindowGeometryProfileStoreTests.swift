import Foundation
import WMInventory
import XCTest
@testable import WMPersistence

final class WindowGeometryProfileStoreTests: XCTestCase {
    func testPathUsesXDGStateHome() {
        XCTAssertEqual(
            WindowGeometryProfilePath.resolve(environment: ["XDG_STATE_HOME": "/state"]).path,
            "/state/wm/geometry-profiles.json"
        )
    }

    func testRoundTripUsesAtomicTemporaryRename() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("geometry-profiles.json")
        let store = WindowGeometryProfileStore(url: url)
        let catalog = WindowGeometryProfileCatalog(profiles: [.init(
            identity: .init(window: testWindow())!, context: .init(applicationVersion: "1"),
            minimumWidth: 400, minimumHeight: 300, correctiveAttemptCount: 2,
            sampleCount: 3, successfulSampleCount: 1, lastObservedAt: Date(timeIntervalSince1970: 10)
        )])
        try store.save(catalog)
        XCTAssertEqual(try store.load(), catalog)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["geometry-profiles.json"])
    }

    func testLegacyProfileDefaultsCapabilityEvidenceToUnknown() throws {
        let profile = WindowGeometryProfile(
            identity: .init(window: testWindow())!, context: .init(), correctiveAttemptCount: 1,
            sampleCount: 0, successfulSampleCount: 0, lastObservedAt: .distantPast)
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(profile)) as! [String: Any]
        object.removeValue(forKey: "geometryCapabilities")
        let decoded = try JSONDecoder().decode(
            WindowGeometryProfile.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(decoded.geometryCapabilities, .init())
    }
}

private func testWindow() -> NormalizedWindow {
    .init(
        id: "w", pid: 1, appName: "Test", executablePath: "/Applications/Test",
        role: "AXWindow", subrole: "AXStandardWindow", classification: .normal,
        management: .managed, rejectionReasons: [], joinConfidence: .exact, joinSignals: [],
        health: .healthy, healthIssues: []
    )
}
