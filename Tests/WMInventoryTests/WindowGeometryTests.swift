import Foundation
import WMProtocol
import XCTest
@testable import WMInventory

final class WindowGeometryTests: XCTestCase {
func testExactFrameSucceedsOnFirstStrategy() async throws {
    let adapter = FakeGeometryAdapter(frame: initialFrame)
    let service = WindowGeometryService(adapter: adapter, now: { fixedDate })
    let result = try await service.set(window: window, params: .init(windowID: window.id, frame: requestedFrame))

    XCTAssertTrue(result.verified)
    XCTAssertEqual(result.attempts, 1)
    XCTAssertEqual(result.strategy, .positionThenSize)
    let writes = await adapter.writes
    XCTAssertEqual(writes, [.position, .size])
}

func testClampedFrameFailsVerificationWithObservedFrame() async throws {
    let adapter = FakeGeometryAdapter(frame: initialFrame, transform: { frame, _ in
        InventoryRect(x: frame.x, y: frame.y, width: min(frame.width, 800), height: frame.height)
    })
    let service = WindowGeometryService(adapter: adapter)

    do {
        _ = try await service.set(window: window, params: .init(windowID: window.id, frame: requestedFrame, attempts: 3))
        XCTFail("expected verification failure")
    } catch let error as WindowGeometryFailure {
        XCTAssertEqual(error.code, .geometryVerificationFailed)
        XCTAssertEqual(error.observedFrame?.width, 800)
    }
}

func testSecondStrategyCanSucceed() async throws {
    let adapter = FakeGeometryAdapter(frame: initialFrame, acceptedAttempt: 2)
    let result = try await WindowGeometryService(adapter: adapter).set(window: window, params: .init(windowID: window.id, frame: requestedFrame))

    XCTAssertEqual(result.attempts, 2)
    XCTAssertEqual(result.strategy, .sizeThenPosition)
    let writes = await adapter.writes
    XCTAssertEqual(writes, [.position, .size, .size, .position])
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

func testUnresolvedIdentityNeverWrites() async throws {
    for error in [WindowGeometryAdapterError.notFound, .stale, .ambiguous] {
        let adapter = FakeGeometryAdapter(frame: initialFrame, resolveError: error)
        do {
            _ = try await WindowGeometryService(adapter: adapter).set(window: window, params: .init(windowID: window.id, frame: requestedFrame))
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
        _ = try await WindowGeometryService(adapter: adapter).set(window: window, params: .init(windowID: window.id, frame: invalid, tolerance: 21, attempts: 6))
        XCTFail("expected invalid frame")
    } catch is WindowGeometryFailure {}
    let resolveCalls = await adapter.resolveCalls
    XCTAssertEqual(resolveCalls, 0)
}

func testSequentialCommandsReuseExplicitHandleAfterFrameChanges() async throws {
    let adapter = FakeGeometryAdapter(frame: initialFrame)
    let service = WindowGeometryService(adapter: adapter)
    _ = try await service.set(window: window, params: .init(windowID: window.id, frame: requestedFrame))
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
}

private actor FakeGeometryAdapter: WindowGeometryAdapter {
    private var frame: InventoryRect
    private let transform: @Sendable (InventoryRect, Int) -> InventoryRect
    private let acceptedAttempt: Int
    private let resolveError: WindowGeometryAdapterError?
    private(set) var writes: [WindowGeometryComponent] = []
    private(set) var resolveCalls = 0
    private(set) var createdHandles = 0
    private var handles: [String: WindowGeometryHandle] = [:]

    init(frame: InventoryRect, acceptedAttempt: Int = 1, resolveError: WindowGeometryAdapterError? = nil, transform: @escaping @Sendable (InventoryRect, Int) -> InventoryRect = { frame, _ in frame }) {
        self.frame = frame
        self.acceptedAttempt = acceptedAttempt
        self.resolveError = resolveError
        self.transform = transform
    }

    func resolve(_ window: NormalizedWindow) throws -> WindowGeometryHandle {
        resolveCalls += 1
        if let resolveError { throw resolveError }
        if let handle = handles[window.id] { return handle }
        createdHandles += 1
        let handle = WindowGeometryHandle(rawValue: "\(window.id):\(createdHandles)")
        handles[window.id] = handle
        return handle
    }

    func reconcile(windows: [NormalizedWindow]) {
        // Session handles survive temporary scan omissions.
    }

    func validateControllability(of handle: WindowGeometryHandle) {}
    func readFrame(of handle: WindowGeometryHandle) -> InventoryRect { frame }

    func write(_ component: WindowGeometryComponent, frame requested: InventoryRect, to handle: WindowGeometryHandle) {
        writes.append(component)
        let attempt = (writes.count + 1) / 2
        if attempt >= acceptedAttempt { frame = transform(requested, attempt) }
    }

    func delay() {}
}

private actor ReanchoringGeometryAdapter: WindowGeometryAdapter {
    private var frame: InventoryRect
    private var writes = 0

    init(frame: InventoryRect) { self.frame = frame }
    func resolve(_ window: NormalizedWindow) -> WindowGeometryHandle { .init(rawValue: window.id) }
    func validateControllability(of handle: WindowGeometryHandle) {}
    func readFrame(of handle: WindowGeometryHandle) -> InventoryRect { frame }
    func delay() {}

    func write(_ component: WindowGeometryComponent, frame requested: InventoryRect, to handle: WindowGeometryHandle) {
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

private let fixedDate = Date(timeIntervalSince1970: 1_700_000_000)
private let initialFrame = InventoryRect(x: 0, y: 0, width: 400, height: 300)
private let requestedFrame = Rectangle(x: 100, y: 100, width: 900, height: 700)
private let window = NormalizedWindow(id: "window:test", pid: 7, appName: "Test", title: "Document", role: "AXWindow", subrole: "AXStandardWindow", frame: initialFrame, classification: .normal, management: .unmanaged, rejectionReasons: [], cgWindowID: 42, joinConfidence: .exact, joinSignals: ["cg_window_id"], health: .healthy, healthIssues: [])
