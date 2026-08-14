import Foundation
import Testing
@testable import WMCore

private struct Item: Identifiable, Codable, Equatable, Sendable { let id: String; let value: Int }
private struct Snapshot: InventorySnapshotProtocol {
    let windows: [Item]
    let displays: [Item]
    let health: InventoryHealth
    let focusedWindowID: String?

    func replacingWindow(_ window: Item) -> Self? {
        guard let index = windows.firstIndex(where: { $0.id == window.id }) else { return nil }
        var copy = self
        copy.windows[index] = window
        return copy
    }
}

private actor Provider: InventoryProvider {
    typealias Snapshot = WMCoreTestsSnapshot
    private var values: [Snapshot]
    private(set) var calls = 0
    init(_ values: [Snapshot]) { self.values = values }
    func inventory() async throws -> Snapshot {
        calls += 1
        try await Task.sleep(for: .milliseconds(10))
        return values.removeFirst()
    }
}
private typealias WMCoreTestsSnapshot = Snapshot

private let healthy = InventoryHealth(status: .healthy)

@Test func refreshesCoalesceAndVersionsIncrease() async throws {
    let provider = Provider([.init(windows: [], displays: [], health: healthy, focusedWindowID: nil)])
    let state = InventoryState(provider: provider)
    async let first = state.refresh()
    async let second = state.refresh()
    let (a, b) = try await (first, second)
    #expect(a == b)
    #expect(await provider.calls == 1)
    #expect(a.stateVersion == 1)
    #expect(a.sequence == 4)
}

@Test func diffsAreSortedAndReplayIsStrictlyAfterSequence() async throws {
    let provider = Provider([
        .init(windows: [.init(id: "b", value: 1), .init(id: "a", value: 1)], displays: [], health: healthy, focusedWindowID: nil),
        .init(windows: [.init(id: "c", value: 1), .init(id: "a", value: 2)], displays: [], health: healthy, focusedWindowID: nil),
    ])
    let state = InventoryState(provider: provider)
    let first = try await state.refresh()
    let second = try await state.refresh()
    #expect(second.stateVersion == 2)
    let subscription = try await state.subscribe(id: "s", topics: [.windowInventory], afterSequence: first.sequence)
    var iterator = subscription.stream.makeAsyncIterator()
    guard case let .event(.delta(event)) = await iterator.next(), case let .windows(delta) = event.data else {
        Issue.record("expected replayed window delta")
        return
    }
    #expect(delta.added.map(\.id) == ["c"])
    #expect(delta.updated.map(\.id) == ["a"])
    #expect(delta.removed.map(\.id) == ["b"])
}

@Test func expiredReplayRequiresResync() async throws {
    let provider = Provider([
        .init(windows: [], displays: [], health: healthy, focusedWindowID: nil),
        .init(windows: [.init(id: "a", value: 1)], displays: [], health: healthy, focusedWindowID: nil),
    ])
    let state = InventoryState(provider: provider, replayLimit: 1)
    _ = try await state.refresh()
    _ = try await state.refresh()
    let subscription = try await state.subscribe(id: "s", topics: [.windowInventory], afterSequence: 0)
    var iterator = subscription.stream.makeAsyncIterator()
    guard case let .resync(resync) = await iterator.next() else {
        Issue.record("expected resync")
        return
    }
    #expect(resync.requestedAfterSequence == 0)
    #expect(resync.oldestAvailableSequence != nil)
}

@Test func routerCorrelatesRequests() async throws {
    let provider = Provider([.init(windows: [], displays: [], health: healthy, focusedWindowID: nil)])
    let state = InventoryState(provider: provider)
    _ = try await state.refresh()
    let response = await RequestRouter(inventory: state).route(.init(requestID: "req-1", method: "health.get"))
    #expect(response.requestID == "req-1")
    #expect(response.ok)
    #expect(response.stateVersion == 1)
}

@Test func targetedWindowUpdateCommitsVisibleStateAndDelta() async throws {
    let provider = Provider([.init(windows: [.init(id: "a", value: 1)], displays: [], health: healthy, focusedWindowID: nil)])
    let state = InventoryState(provider: provider)
    let first = try await state.refresh()
    let updated = try await state.update(window: .init(id: "a", value: 2))

    #expect(updated.stateVersion == first.stateVersion + 1)
    #expect(try await state.windows() == [.init(id: "a", value: 2)])
}
