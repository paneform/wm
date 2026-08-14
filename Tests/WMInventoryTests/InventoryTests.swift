import Foundation
import XCTest
@testable import WMInventory

final class InventoryTests: XCTestCase {
    func testFocusedWindowFallsBackToFrontmostMainWindow() {
        let other = normalizedWindow(id: "other", pid: 1, main: true)
        let secondary = normalizedWindow(id: "secondary", pid: 2, main: false)
        let main = normalizedWindow(id: "main", pid: 2, main: true)

        XCTAssertEqual(resolveFocusedWindowID(windows: [other, secondary, main], frontmostPID: 2), "main")

        var explicitlyFocused = other
        explicitlyFocused.focused = true
        XCTAssertEqual(resolveFocusedWindowID(windows: [explicitlyFocused, main], frontmostPID: 2), "other")
    }
    func testDuplicateAndZeroCGIDsAreSafeAndExplained() {
        let frame = InventoryRect(x: 10, y: 20, width: 800, height: 600)
        let ax = [
            RawAXWindow(pid: 7, appName: "App", title: "One", role: "AXWindow", subrole: "AXStandardWindow", frame: frame, cgWindowID: 0),
            RawAXWindow(pid: 7, appName: "App", title: "Two", role: "AXWindow", subrole: "AXStandardWindow", frame: InventoryRect(x: 900, y: 20, width: 800, height: 600), cgWindowID: 44),
        ]
        let cg = [
            RawCGWindow(cgWindowID: 0, pid: 7, title: "One", layer: 0, frame: frame),
            RawCGWindow(cgWindowID: 44, pid: 7, title: "Two", layer: 0, frame: ax[1].frame),
            RawCGWindow(cgWindowID: 44, pid: 7, title: "Other", layer: 0, frame: InventoryRect(x: 1, y: 1, width: 10, height: 10)),
        ]

        let result = WindowNormalizer.normalize(ax: ax, cg: cg)

        XCTAssertEqual(result.windows.count, 2)
        XCTAssertEqual(result.decisions.count, 3)
        XCTAssertEqual(result.decisions[0].confidence, .strong)
        XCTAssertEqual(result.decisions[1].confidence, .exact)
        XCTAssertEqual(result.decisions[2].confidence, .cgOnly)
    }

    func testAmbiguousEqualEvidenceDoesNotGuess() {
        let ax = RawAXWindow(pid: 9, appName: "Tabbed", title: "Document", role: "AXWindow", subrole: "AXStandardWindow", frame: .init(x: 0, y: 0, width: 100, height: 100))
        let surface = RawCGWindow(cgWindowID: nil, pid: 9, title: "Document", layer: 0, frame: ax.frame)

        let result = WindowNormalizer.normalize(ax: [ax], cg: [surface, surface])

        XCTAssertEqual(result.windows[0].joinConfidence, .axOnly)
        XCTAssertTrue(result.decisions[0].reasons.contains { $0.contains("equal join evidence") })
        XCTAssertEqual(result.decisions.filter { $0.confidence == .cgOnly }.count, 2)
    }

    func testClassificationRetainsUncertainAndTransientRecords() {
        let uncertain = RawAXWindow(pid: 1, appName: "Broken", role: nil, frame: nil, readErrors: ["AXRole:-25205"])
        let dialog = RawAXWindow(pid: 2, appName: "App", role: "AXWindow", subrole: "AXDialog", frame: .init(x: 0, y: 0, width: 200, height: 100))

        let result = WindowNormalizer.normalize(ax: [uncertain, dialog], cg: [])

        XCTAssertEqual(result.windows.map(\.classification), [.uncertain, .transient])
        XCTAssertEqual(result.rejected.count, 1)
        XCTAssertFalse(result.windows[0].rejectionReasons.isEmpty)
        XCTAssertEqual(result.windows[1].management, .unmanaged)
    }

    func testScannerIsolatesFailedApplication() async {
        let good = ApplicationObservation(pid: 1, name: "Good")
        let bad = ApplicationObservation(pid: 2, name: "Bad")
        let sources = InventorySources(
            displays: StubDisplays(),
            accessibility: StubAX(applications: [good, bad], failedPID: bad.pid),
            coreGraphics: StubCG()
        )
        let snapshot = await InventoryScanner(sources: sources).scan()

        XCTAssertEqual(snapshot.rawAXWindows.count, 1)
        XCTAssertEqual(snapshot.appScans.first { $0.application.pid == good.pid }?.status, .succeeded)
        XCTAssertEqual(snapshot.appScans.first { $0.application.pid == bad.pid }?.status, .failed)
        XCTAssertEqual(snapshot.sourceHealth.first { $0.source == .accessibility }?.status, .degraded)
    }

    func testScannerBoundsCooperativeSlowApplication() async {
        let slow = ApplicationObservation(pid: 3, name: "Slow")
        let sources = InventorySources(
            displays: StubDisplays(),
            accessibility: SlowAX(application: slow),
            coreGraphics: StubCG()
        )
        let scanner = InventoryScanner(sources: sources, configuration: .init(perApplicationTimeout: .milliseconds(10)))
        let snapshot = await scanner.scan()

        XCTAssertEqual(snapshot.appScans.only?.status, .timedOut)
    }
}

private func normalizedWindow(id: String, pid: Int32, main: Bool) -> NormalizedWindow {
    .init(
        id: id, pid: pid, appName: "App", role: "AXWindow", subrole: "AXStandardWindow",
        frame: .init(x: 0, y: 0, width: 100, height: 100), classification: .normal,
        management: .unmanaged, rejectionReasons: [], joinConfidence: .exact,
        joinSignals: [], focused: false, main: main, health: .healthy, healthIssues: []
    )
}

private struct StubDisplays: DisplayInventorySource {
    func displays() async -> SourceResult<[DisplayObservation]> {
        SourceResult(value: [], health: SourceHealth(source: .displays, status: .healthy, permissionGranted: nil))
    }
}

private struct StubCG: CoreGraphicsInventorySource {
    func windows() async -> SourceResult<[RawCGWindow]> {
        SourceResult(value: [], health: SourceHealth(source: .coreGraphics, status: .healthy, permissionGranted: true))
    }
}

private struct StubAX: AccessibilityInventorySource {
    var applications: [ApplicationObservation]
    var failedPID: Int32

    func applications() async -> SourceResult<[ApplicationObservation]> {
        SourceResult(value: applications, health: SourceHealth(source: .accessibility, status: .healthy, permissionGranted: true))
    }

    func windows(for application: ApplicationObservation) async throws -> [RawAXWindow] {
        if application.pid == failedPID { throw TestError.failed }
        return [RawAXWindow(pid: application.pid, appName: application.name, role: "AXWindow", subrole: "AXStandardWindow", frame: .init(x: 0, y: 0, width: 100, height: 100))]
    }
}

private struct SlowAX: AccessibilityInventorySource {
    var application: ApplicationObservation

    func applications() async -> SourceResult<[ApplicationObservation]> {
        SourceResult(value: [application], health: SourceHealth(source: .accessibility, status: .healthy, permissionGranted: true))
    }

    func windows(for application: ApplicationObservation) async throws -> [RawAXWindow] {
        try await Task.sleep(for: .seconds(1))
        return []
    }
}

private enum TestError: Error { case failed }

private extension Array {
    var only: Element? { count == 1 ? self[0] : nil }
}
