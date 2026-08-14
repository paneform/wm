import Foundation

public protocol InventorySnapshotProtocol: Codable, Equatable, Sendable {
    associatedtype Window: Identifiable & Codable & Equatable & Sendable where Window.ID: Comparable & Codable & Sendable
    associatedtype Display: Identifiable & Codable & Equatable & Sendable where Display.ID: Comparable & Codable & Sendable

    var windows: [Window] { get }
    var displays: [Display] { get }
    var health: InventoryHealth { get }
    var focusedWindowID: Window.ID? { get }
    func replacingWindow(_ window: Window) -> Self?
}

public extension InventorySnapshotProtocol {
    func replacingWindow(_ window: Window) -> Self? { nil }
}

public protocol InventoryProvider: Sendable {
    associatedtype Snapshot: InventorySnapshotProtocol
    func inventory() async throws -> Snapshot
}

public struct InventoryHealth: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable {
        case healthy, degraded, recovering, unhealthy
    }

    public var status: Status
    public var issues: [String]
    public var capabilities: [String: Bool?]

    public init(status: Status, issues: [String] = [], capabilities: [String: Bool?] = [:]) {
        self.status = status
        self.issues = issues
        self.capabilities = capabilities
    }
}

public struct EntityDelta<Entity: Identifiable & Codable & Equatable & Sendable>: Codable, Equatable, Sendable
where Entity.ID: Comparable & Codable & Sendable {
    public let added: [Entity]
    public let updated: [Entity]
    public let removed: [Entity]
}

public struct CommittedState<Snapshot: InventorySnapshotProtocol>: Codable, Equatable, Sendable {
    public let stateVersion: UInt64
    public let sequence: UInt64
    public let committedAt: Date
    public let snapshot: Snapshot
}

public enum InventoryTopic: String, Codable, CaseIterable, Sendable {
    case windowInventory = "window.inventory"
    case displayInventory = "display.inventory"
    case healthChanged = "health.changed"
    case inventoryRefreshed = "inventory.refreshed"
}

public enum EventProjection: String, Codable, Sendable {
    case delta, snapshot, invalidation
}

public enum EventData<Snapshot: InventorySnapshotProtocol>: Codable, Equatable, Sendable {
    case windows(EntityDelta<Snapshot.Window>)
    case displays(EntityDelta<Snapshot.Display>)
    case health(InventoryHealth)
    case refreshed
}

public struct InventoryEvent<Snapshot: InventorySnapshotProtocol>: Codable, Equatable, Sendable {
    public let sequence: UInt64
    public let stateVersion: UInt64
    public let timestamp: Date
    public let topic: InventoryTopic
    public let data: EventData<Snapshot>
}

public enum ProjectedEvent<Snapshot: InventorySnapshotProtocol>: Codable, Equatable, Sendable {
    case delta(InventoryEvent<Snapshot>)
    case snapshot(topic: InventoryTopic, state: CommittedState<Snapshot>)
    case invalidation(topic: InventoryTopic, sequence: UInt64, stateVersion: UInt64)
}

public struct ResyncRequired: Codable, Equatable, Sendable {
    public let subscriptionID: String
    public let requestedAfterSequence: UInt64
    public let oldestAvailableSequence: UInt64?
    public let currentSequence: UInt64
    public let stateVersion: UInt64
}

public enum SubscriptionMessage<Snapshot: InventorySnapshotProtocol>: Codable, Equatable, Sendable {
    case event(ProjectedEvent<Snapshot>)
    case resync(ResyncRequired)
}

public struct Subscription<Snapshot: InventorySnapshotProtocol>: Sendable {
    public let id: String
    public let stream: AsyncStream<SubscriptionMessage<Snapshot>>
}

public enum InventoryStateError: Error, Equatable, Sendable {
    case notReady
    case subscriptionNotFound
}

public actor InventoryState<Provider: InventoryProvider> {
    public typealias Snapshot = Provider.Snapshot

    private struct Subscriber {
        let topics: Set<InventoryTopic>
        let projection: EventProjection
        let continuation: AsyncStream<SubscriptionMessage<Snapshot>>.Continuation
    }

    private let provider: Provider
    private let replayLimit: Int
    private let replayAge: TimeInterval
    private let now: @Sendable () -> Date
    private var committed: CommittedState<Snapshot>?
    private var events: [InventoryEvent<Snapshot>] = []
    private var subscribers: [String: Subscriber] = [:]
    private var refreshTask: Task<CommittedState<Snapshot>, Error>?
    private var nextStateVersion: UInt64 = 1
    private var nextSequence: UInt64 = 1

    public init(
        provider: Provider,
        replayLimit: Int = 2_048,
        replayAge: TimeInterval = 300,
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.provider = provider
        self.replayLimit = max(0, replayLimit)
        self.replayAge = max(0, replayAge)
        self.now = now
    }

    public func state() throws -> CommittedState<Snapshot> {
        guard let committed else { throw InventoryStateError.notReady }
        return committed
    }

    public func windows() throws -> [Snapshot.Window] { try state().snapshot.windows }
    public func displays() throws -> [Snapshot.Display] { try state().snapshot.displays }
    public func health() throws -> InventoryHealth { try state().snapshot.health }

    public func refresh() async throws -> CommittedState<Snapshot> {
        if let refreshTask { return try await refreshTask.value }
        let provider = provider
        let task = Task { try await provider.inventory() }
        let commitTask = Task { [weak self] in
            let snapshot = try await task.value
            guard let self else { throw CancellationError() }
            return await self.commit(snapshot)
        }
        refreshTask = commitTask
        do {
            let result = try await commitTask.value
            refreshTask = nil
            return result
        } catch {
            refreshTask = nil
            throw error
        }
    }

    public func update(window: Snapshot.Window) throws -> CommittedState<Snapshot> {
        let current = try state()
        guard let snapshot = current.snapshot.replacingWindow(window) else { throw InventoryStateError.notReady }
        return commit(snapshot)
    }

    public func subscribe(
        id: String,
        topics: Set<InventoryTopic>,
        projection: EventProjection = .delta,
        afterSequence: UInt64? = nil,
        queueLimit: Int = 256
    ) throws -> Subscription<Snapshot> {
        let state = try state()
        var continuation: AsyncStream<SubscriptionMessage<Snapshot>>.Continuation!
        let stream = AsyncStream(bufferingPolicy: .bufferingNewest(max(1, queueLimit))) { continuation = $0 }
        subscribers[id]?.continuation.finish()
        subscribers[id] = Subscriber(topics: topics, projection: projection, continuation: continuation)
        continuation.onTermination = { [weak self] _ in Task { await self?.removeSubscriber(id) } }

        if let afterSequence {
            let oldest = events.first?.sequence
            if afterSequence < state.sequence, oldest == nil || afterSequence < oldest! - 1 {
                continuation.yield(.resync(.init(
                    subscriptionID: id,
                    requestedAfterSequence: afterSequence,
                    oldestAvailableSequence: oldest,
                    currentSequence: state.sequence,
                    stateVersion: state.stateVersion
                )))
            } else {
                for event in events where event.sequence > afterSequence && topics.contains(event.topic) {
                    continuation.yield(.event(project(event, as: projection, state: state)))
                }
            }
        } else {
            let topic = topics.sorted { $0.rawValue < $1.rawValue }.first ?? .inventoryRefreshed
            continuation.yield(.event(currentProjection(topic: topic, projection: projection, state: state)))
        }
        return Subscription(id: id, stream: stream)
    }

    public func unsubscribe(id: String) throws {
        guard let subscriber = subscribers.removeValue(forKey: id) else {
            throw InventoryStateError.subscriptionNotFound
        }
        subscriber.continuation.finish()
    }

    private func removeSubscriber(_ id: String) { subscribers.removeValue(forKey: id) }

    private func commit(_ snapshot: Snapshot) -> CommittedState<Snapshot> {
        let timestamp = now()
        let previous = committed
        let stateVersion = nextStateVersion
        nextStateVersion += 1
        var generated: [InventoryEvent<Snapshot>] = []

        if let previous {
            let windowDelta = Self.diff(previous.snapshot.windows, snapshot.windows)
            if !windowDelta.added.isEmpty || !windowDelta.updated.isEmpty || !windowDelta.removed.isEmpty {
                generated.append(makeEvent(.windowInventory, .windows(windowDelta), stateVersion, timestamp))
            }
            let displayDelta = Self.diff(previous.snapshot.displays, snapshot.displays)
            if !displayDelta.added.isEmpty || !displayDelta.updated.isEmpty || !displayDelta.removed.isEmpty {
                generated.append(makeEvent(.displayInventory, .displays(displayDelta), stateVersion, timestamp))
            }
            if previous.snapshot.health != snapshot.health {
                generated.append(makeEvent(.healthChanged, .health(snapshot.health), stateVersion, timestamp))
            }
        } else {
            generated.append(makeEvent(.windowInventory, .windows(Self.diff([], snapshot.windows)), stateVersion, timestamp))
            generated.append(makeEvent(.displayInventory, .displays(Self.diff([], snapshot.displays)), stateVersion, timestamp))
            generated.append(makeEvent(.healthChanged, .health(snapshot.health), stateVersion, timestamp))
        }
        generated.append(makeEvent(.inventoryRefreshed, .refreshed, stateVersion, timestamp))

        let state = CommittedState(stateVersion: stateVersion, sequence: generated.last!.sequence, committedAt: timestamp, snapshot: snapshot)
        committed = state
        events.append(contentsOf: generated)
        pruneEvents(at: timestamp)
        publish(generated, state: state)
        return state
    }

    private func makeEvent(_ topic: InventoryTopic, _ data: EventData<Snapshot>, _ version: UInt64, _ timestamp: Date) -> InventoryEvent<Snapshot> {
        defer { nextSequence += 1 }
        return InventoryEvent(sequence: nextSequence, stateVersion: version, timestamp: timestamp, topic: topic, data: data)
    }

    private func pruneEvents(at timestamp: Date) {
        events.removeAll { timestamp.timeIntervalSince($0.timestamp) > replayAge }
        if events.count > replayLimit { events.removeFirst(events.count - replayLimit) }
    }

    private func publish(_ newEvents: [InventoryEvent<Snapshot>], state: CommittedState<Snapshot>) {
        for subscriber in subscribers.values {
            for event in newEvents where subscriber.topics.contains(event.topic) {
                subscriber.continuation.yield(.event(project(event, as: subscriber.projection, state: state)))
            }
        }
    }

    private func project(_ event: InventoryEvent<Snapshot>, as projection: EventProjection, state: CommittedState<Snapshot>) -> ProjectedEvent<Snapshot> {
        switch projection {
        case .delta: .delta(event)
        case .snapshot: .snapshot(topic: event.topic, state: state)
        case .invalidation: .invalidation(topic: event.topic, sequence: event.sequence, stateVersion: event.stateVersion)
        }
    }

    private func currentProjection(topic: InventoryTopic, projection: EventProjection, state: CommittedState<Snapshot>) -> ProjectedEvent<Snapshot> {
        switch projection {
        case .snapshot: .snapshot(topic: topic, state: state)
        case .invalidation: .invalidation(topic: topic, sequence: state.sequence, stateVersion: state.stateVersion)
        case .delta:
            .delta(InventoryEvent(sequence: state.sequence, stateVersion: state.stateVersion, timestamp: state.committedAt, topic: topic, data: currentData(topic, state.snapshot)))
        }
    }

    private func currentData(_ topic: InventoryTopic, _ snapshot: Snapshot) -> EventData<Snapshot> {
        switch topic {
        case .windowInventory: .windows(Self.diff([], snapshot.windows))
        case .displayInventory: .displays(Self.diff([], snapshot.displays))
        case .healthChanged: .health(snapshot.health)
        case .inventoryRefreshed: .refreshed
        }
    }

    private static func diff<Entity>(_ old: [Entity], _ new: [Entity]) -> EntityDelta<Entity>
    where Entity: Identifiable & Codable & Equatable & Sendable, Entity.ID: Comparable & Codable & Sendable {
        let oldByID = Dictionary(uniqueKeysWithValues: old.map { ($0.id, $0) })
        let newByID = Dictionary(uniqueKeysWithValues: new.map { ($0.id, $0) })
        return EntityDelta(
            added: new.filter { oldByID[$0.id] == nil }.sorted { $0.id < $1.id },
            updated: new.filter { entity in
                oldByID[entity.id].map { $0 != entity } ?? false
            }.sorted { $0.id < $1.id },
            removed: old.filter { newByID[$0.id] == nil }.sorted { $0.id < $1.id }
        )
    }
}
