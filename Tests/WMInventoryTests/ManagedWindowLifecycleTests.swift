import XCTest

@testable import WMInventory

final class ManagedWindowLifecycleTests: XCTestCase {
  func testTransientOmissionRetainsWindowUntilSuccessfulAppScanConfirmsClosure() {
    var lifecycle = ManagedWindowLifecycle()
    XCTAssertEqual(
      lifecycle.reconcile(snapshot(windows: [window("a", pid: 7)], pids: [7])).windows.map(\.id),
      ["a"])

    let omitted = lifecycle.reconcile(snapshot(windows: [], pids: [7], status: .timedOut))
    XCTAssertEqual(omitted.windows.map(\.id), ["a"])
    XCTAssertTrue(omitted.verifiedClosedLifetimes.isEmpty)

    let suspected = lifecycle.reconcile(snapshot(windows: [], pids: [7]))
    XCTAssertEqual(suspected.windows.map(\.id), ["a"])
    XCTAssertTrue(suspected.verifiedClosedLifetimes.isEmpty)

    let closed = lifecycle.reconcile(snapshot(windows: [], pids: [7]))
    XCTAssertTrue(closed.windows.isEmpty)
    XCTAssertEqual(closed.verifiedClosedLifetimes, [.init(windowID: "a", pid: 7)])
  }

  func testObservedWindowResetsMissingConfirmation() {
    var lifecycle = ManagedWindowLifecycle()
    _ = lifecycle.reconcile(snapshot(windows: [window("a", pid: 7)], pids: [7]))
    _ = lifecycle.reconcile(snapshot(windows: [], pids: [7]))
    _ = lifecycle.reconcile(snapshot(windows: [window("a", pid: 7)], pids: [7]))

    let omittedAgain = lifecycle.reconcile(snapshot(windows: [], pids: [7]))

    XCTAssertEqual(omittedAgain.windows.map(\.id), ["a"])
    XCTAssertTrue(omittedAgain.verifiedClosedLifetimes.isEmpty)
  }

  func testManagedWindowBecomingTransientIsNewlyUnmanaged() {
    var lifecycle = ManagedWindowLifecycle()
    _ = lifecycle.reconcile(snapshot(windows: [window("a", pid: 7)], pids: [7]))

    let update = lifecycle.reconcile(
      snapshot(windows: [window("a", pid: 7, classification: .transient)], pids: [7]))

    XCTAssertTrue(update.windows.isEmpty)
    XCTAssertEqual(update.newlyUnmanagedWindowIDs, ["a"])
    XCTAssertTrue(update.verifiedClosedLifetimes.isEmpty)
  }

  func testManagedWindowBecomingSystemUIIsNewlyUnmanaged() {
    var lifecycle = ManagedWindowLifecycle()
    _ = lifecycle.reconcile(snapshot(windows: [window("a", pid: 7)], pids: [7]))

    let update = lifecycle.reconcile(
      snapshot(windows: [window("a", pid: 7, classification: .systemUI)], pids: [7]))

    XCTAssertTrue(update.windows.isEmpty)
    XCTAssertEqual(update.newlyUnmanagedWindowIDs, ["a"])
    XCTAssertTrue(update.verifiedClosedLifetimes.isEmpty)
  }

  func testCoordinatedOmissionDoesNotCloseRetainedWindows() {
    var lifecycle = ManagedWindowLifecycle()
    _ = lifecycle.reconcile(
      snapshot(
        windows: [window("a", pid: 7), window("b", pid: 8), window("c", pid: 9)], pids: [7, 8, 9]))

    for _ in 0..<3 {
      let update = lifecycle.reconcile(snapshot(windows: [window("c", pid: 9)], pids: [7, 8, 9]))
      XCTAssertEqual(update.windows.map(\.id), ["a", "b", "c"])
      XCTAssertTrue(update.verifiedClosedLifetimes.isEmpty)
    }
  }

  func testUnmanagedTransientOmissionDoesNotBlockManagedClosure() {
    var lifecycle = ManagedWindowLifecycle()
    _ = lifecycle.reconcile(
      snapshot(
        windows: [
          window("a", pid: 7), window("b", pid: 8), window("c", pid: 9),
          window("dialog", pid: 10, classification: .transient),
        ], pids: [7, 8, 9, 10]))

    _ = lifecycle.reconcile(
      snapshot(windows: [window("b", pid: 8), window("c", pid: 9)], pids: [7, 8, 9, 10]))
    let update = lifecycle.reconcile(
      snapshot(windows: [window("b", pid: 8), window("c", pid: 9)], pids: [7, 8, 9, 10]))

    XCTAssertTrue(update.verifiedClosedLifetimes.contains(.init(windowID: "a", pid: 7)))
    XCTAssertEqual(update.windows.map(\.id), ["b", "c"])
  }

  func testFailedTopLevelApplicationEnumerationCannotConfirmClosure() {
    var lifecycle = ManagedWindowLifecycle()
    _ = lifecycle.reconcile(snapshot(windows: [window("a", pid: 7)], pids: [7]))

    let failed = lifecycle.reconcile(
      snapshot(windows: [], pids: [], accessibilityStatus: .unhealthy))

    XCTAssertEqual(failed.windows.map(\.id), ["a"])
    XCTAssertTrue(failed.verifiedClosedLifetimes.isEmpty)
  }

  func testUnrelatedFailedAppScanDoesNotBlockTerminatedProcessClosure() {
    var lifecycle = ManagedWindowLifecycle()
    _ = lifecycle.reconcile(snapshot(windows: [window("a", pid: 7)], pids: [7]))
    var degraded = snapshot(windows: [], pids: [8], status: .failed, accessibilityStatus: .degraded)
    degraded.sourceHealth[0].permissionGranted = true

    let update = lifecycle.reconcile(degraded)

    XCTAssertTrue(update.windows.isEmpty)
    XCTAssertEqual(update.verifiedClosedLifetimes, [.init(windowID: "a", pid: 7)])
  }

  func testPIDRestartEvictsEveryOldWindowAndInsertsReplacementFresh() {
    var lifecycle = ManagedWindowLifecycle()
    _ = lifecycle.reconcile(
      snapshot(windows: [window("a", pid: 7), window("b", pid: 7)], pids: [7]))
    _ = lifecycle.setOverride(.unmanaged, for: "a")

    let restarted = lifecycle.reconcile(
      snapshot(windows: [window("a", pid: 8), window("c", pid: 8)], pids: [8]))

    XCTAssertEqual(
      restarted.verifiedClosedLifetimes,
      [
        .init(windowID: "a", pid: 7), .init(windowID: "b", pid: 7),
      ])
    XCTAssertEqual(restarted.windows.map(\.id), ["a", "c"])
    XCTAssertEqual(restarted.windows.first { $0.id == "a" }?.management, .managed)
  }

  func testTransientWindowCannotBeManagedByOverride() {
    var lifecycle = ManagedWindowLifecycle()
    _ = lifecycle.reconcile(
      snapshot(
        windows: [window("normal", pid: 7), window("dialog", pid: 7, classification: .transient)],
        pids: [7]))
    _ = lifecycle.setOverride(.unmanaged, for: "normal")
    _ = lifecycle.setOverride(.managed, for: "dialog")

    let updated = lifecycle.reconcile(
      snapshot(
        windows: [window("normal", pid: 7), window("dialog", pid: 7, classification: .transient)],
        pids: [7]))
    XCTAssertTrue(updated.windows.isEmpty)

    _ = lifecycle.reconcile(snapshot(windows: [], pids: []))
    let replacements = lifecycle.reconcile(
      snapshot(
        windows: [window("normal", pid: 7), window("dialog", pid: 7, classification: .transient)],
        pids: [7]))
    XCTAssertEqual(replacements.windows.map(\.id), ["normal"])
  }

  func testTransientCandidateDoesNotReplaceClosedManagedWindow() {
    var lifecycle = ManagedWindowLifecycle()
    _ = lifecycle.reconcile(snapshot(windows: [window("old", pid: 7)], pids: [7]))
    _ = lifecycle.reconcile(snapshot(windows: [], pids: [7]))

    let update = lifecycle.reconcile(
      snapshot(windows: [window("panel", pid: 7, classification: .transient)], pids: [7]))

    XCTAssertEqual(update.verifiedClosedLifetimes, [.init(windowID: "old", pid: 7)])
    XCTAssertTrue(update.replacements.isEmpty)
    XCTAssertTrue(update.windows.isEmpty)
  }

  func testManagementOverrideRejectsMismatchedProcessLifetime() {
    var lifecycle = ManagedWindowLifecycle()
    _ = lifecycle.reconcile(snapshot(windows: [window("a", pid: 7)], pids: [7]))

    XCTAssertNil(lifecycle.setOverride(.managed, for: "a", pid: 8))
    XCTAssertNotNil(lifecycle.setOverride(.managed, for: "a", pid: 7))
  }

  func testUnmanageAndManageProduceImmediateMembershipTransitionsWithoutClosure() throws {
    var lifecycle = ManagedWindowLifecycle()
    _ = lifecycle.reconcile(snapshot(windows: [window("a", pid: 7)], pids: [7]))
    var workspace = WorkspaceStateForLifecycle(windowID: "a")

    let unmanaged = try XCTUnwrap(lifecycle.setOverride(.unmanaged, for: "a"))
    XCTAssertEqual(unmanaged.newlyUnmanagedWindowIDs, ["a"])
    XCTAssertTrue(unmanaged.verifiedClosedLifetimes.isEmpty)
    workspace.reconcile(unmanaged)
    XCTAssertFalse(workspace.contains("a"))

    let managed = try XCTUnwrap(lifecycle.setOverride(.managed, for: "a"))
    XCTAssertTrue(managed.newlyUnmanagedWindowIDs.isEmpty)
    workspace.reconcile(managed)
    XCTAssertTrue(workspace.contains("a"))
  }

  func testUncertainPendingWindowIsNotAdopted() {
    var lifecycle = ManagedWindowLifecycle()
    var pending = window("pending", pid: 7, classification: .uncertain)
    pending.management = .pending

    let update = lifecycle.reconcile(snapshot(windows: [pending], pids: [7]))

    XCTAssertTrue(update.windows.isEmpty)
  }

  func testPositionFixedBecomesNewlyUnmanagedWhilePositionOnlyStaysManaged() {
    var lifecycle = ManagedWindowLifecycle()
    var supported = window("a", pid: 7)
    supported.geometryCapabilities = .init(
      position: .init(confirmed: .supported), size: .init(confirmed: .fixed))
    XCTAssertEqual(
      lifecycle.reconcile(snapshot(windows: [supported], pids: [7])).windows.map(\.id), ["a"])

    supported.geometryCapabilities.position.confirmed = .fixed
    let update = lifecycle.reconcile(snapshot(windows: [supported], pids: [7]))
    XCTAssertEqual(update.newlyUnmanagedWindowIDs, ["a"])
    XCTAssertTrue(update.windows.isEmpty)
  }

}

private struct WorkspaceStateForLifecycle {
  private var ids: Set<String>
  init(windowID: String) { ids = [windowID] }
  mutating func reconcile(_ update: WindowLifecycleUpdate) {
    ids.subtract(update.newlyUnmanagedWindowIDs)
    ids.formUnion(update.windows.map(\.id))
  }
  func contains(_ id: String) -> Bool { ids.contains(id) }
}

private func snapshot(
  windows: [NormalizedWindow], pids: [Int32], status: AppScanStatus = .succeeded,
  accessibilityStatus: SourceStatus = .healthy
) -> InventorySnapshot {
  InventorySnapshot(
    timestamp: .distantPast, durationMilliseconds: 0, displays: [], rawAXWindows: [],
    rawCGWindows: [],
    windows: windows, rejectedAXWindows: [], joinDecisions: [],
    sourceHealth: [
      .init(
        source: .accessibility, status: accessibilityStatus,
        permissionGranted: accessibilityStatus == .healthy)
    ],
    appScans: pids.map { pid in
      .init(
        application: .init(pid: pid, name: "App"), status: status, durationMilliseconds: 0,
        windowCount: windows.filter { $0.pid == pid }.count, issues: [])
    }
  )
}

private func window(_ id: String, pid: Int32, classification: WindowClassification = .normal)
  -> NormalizedWindow
{
  .init(
    id: id, pid: pid, appName: "App", role: "AXWindow", subrole: "AXStandardWindow",
    frame: .init(x: 0, y: 0, width: 100, height: 100), classification: classification,
    management: .unmanaged, rejectionReasons: [], joinConfidence: .exact, joinSignals: [],
    health: .healthy,
    healthIssues: []
  )
}
