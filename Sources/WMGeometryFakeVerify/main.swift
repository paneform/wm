import Foundation
import WMCore
import WMInventory
import WMProtocol

@main struct GeometryFakeVerify {
    static func main() async throws {
        let adapter = FakeAdapter(frame: .init(x: 0, y: 0, width: 400, height: 300))
        let service = WindowGeometryService(adapter: adapter)
        let window = NormalizedWindow(
            id: "window:fake", pid: 7, appName: "Fake", title: "Duplicate Title",
            role: "AXWindow", subrole: "AXStandardWindow",
            frame: .init(x: 0, y: 0, width: 400, height: 300),
            classification: .normal, management: .unmanaged, rejectionReasons: [],
            cgWindowID: nil, joinConfidence: .axOnly, joinSignals: ["pid"],
            health: .healthy, healthIssues: []
        )
        let requested = Rectangle(x: 100, y: 100, width: 900, height: 700)
        _ = try await service.set(window: window, params: .init(windowID: window.id, frame: requested))
        let observed = try await service.get(window: window)
        guard observed.frame == requested, await adapter.createdHandles == 1 else { throw VerificationError.continuity }

        let provider = FakeProvider(snapshot: .init(windows: [.init(id: window.id, frame: window.frame!)], displays: [], health: .init(status: .healthy), focusedWindowID: nil))
        let state = InventoryState(provider: provider)
        _ = try await state.refresh()
        let committed = try await state.update(window: FakeWindow(id: window.id, frame: InventoryRect(requested)))
        guard committed.snapshot.windows.first?.frame == InventoryRect(requested) else { throw VerificationError.inventory }

        await service.reconcile(windows: [])
        _ = try await service.get(window: window)
        guard await adapter.createdHandles == 1 else { throw VerificationError.retention }
        print("geometry fake verification passed")
    }
}

private enum VerificationError: Error { case continuity, inventory, retention }

private actor FakeAdapter: WindowGeometryAdapter {
    private var frame: InventoryRect
    private var handles: [String: WindowGeometryHandle] = [:]
    private(set) var createdHandles = 0

    init(frame: InventoryRect) { self.frame = frame }
    func reconcile(windows: [NormalizedWindow]) {}
    func resolve(_ window: NormalizedWindow) -> WindowGeometryHandle {
        if let handle = handles[window.id] { return handle }
        createdHandles += 1
        let handle = WindowGeometryHandle(rawValue: "handle:\(createdHandles)")
        handles[window.id] = handle
        return handle
    }
    func validateControllability(of handle: WindowGeometryHandle) {}
    func readFrame(of handle: WindowGeometryHandle) -> InventoryRect { frame }
    func write(_ component: WindowGeometryComponent, frame: InventoryRect, to handle: WindowGeometryHandle) { self.frame = frame }
    func delay() {}
}

private struct FakeWindow: Identifiable, Codable, Equatable, Sendable {
    var id: String
    var frame: InventoryRect
}

private struct FakeSnapshot: InventorySnapshotProtocol {
    var windows: [FakeWindow]
    var displays: [FakeWindow]
    var health: InventoryHealth
    var focusedWindowID: String?

    func replacingWindow(_ window: FakeWindow) -> Self? {
        guard let index = windows.firstIndex(where: { $0.id == window.id }) else { return nil }
        var copy = self
        copy.windows[index] = window
        return copy
    }
}

private struct FakeProvider: InventoryProvider {
    var snapshot: FakeSnapshot
    func inventory() -> FakeSnapshot { snapshot }
}

private extension InventoryRect {
    init(_ frame: Rectangle) { self.init(x: frame.x, y: frame.y, width: frame.width, height: frame.height) }
}
