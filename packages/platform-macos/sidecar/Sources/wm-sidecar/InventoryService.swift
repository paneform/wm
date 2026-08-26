import AppKit
import Foundation

/// Periodic observation loop: topology by polling `CGGetOnlineDisplayList`
/// (~500 ms; AppKit screen notifications never deliver without an event loop
/// — bean wm-dm8l), windows by diffing successive AX+CG inventories (~1000 ms).
/// Emits wire events through the provided sink; the first pass is baseline
/// only. NSWorkspace sleep/wake/space/activation notifications are delivered
/// on the main run loop and trigger out-of-band refreshes.
@MainActor
final class InventoryService {
    typealias Sink = @Sendable (EventMessage) -> Void

    private let emit: Sink
    private var lastTopology: TopologyValue?
    private var lastWindows: [String: WindowValue] = [:]
    private var lastFocusedId: String?
    private var stalledPids: Set<Int32> = []
    private var started = false
    private let adapter = GeometryAdapter()

    init(emit: @escaping Sink) {
        self.emit = emit
    }

    func start() {
        guard !started else { return }
        started = true
        Task { await self.topologyLoop() }
        Task { await self.windowLoop() }
        Self.installWorkspaceObservers(service: self)
    }

    // MARK: Snapshots

    func currentTopology() -> TopologyValue? { lastTopology }

    func currentWindows() -> [WindowValue] {
        lastWindows.values.sorted { $0.id < $1.id }
    }

    func metadata(for id: String) -> WindowMeta? {
        lastMetas[id]
    }

    // MARK: Geometry/focus pass-through (all MainActor, AX bounded per element)

    func liveObservation(for meta: WindowMeta) -> WindowValue? {
        adapter.observation(for: meta)
    }

    func currentObservedFrame(for meta: WindowMeta) -> Rect? {
        try? adapter.readFrame(meta: meta)
    }

    func mergedTarget(meta: WindowMeta, replace: (inout Rect) -> Void) throws -> Rect {
        try adapter.mergedTarget(meta: meta, replace: replace)
    }

    func write(
        meta: WindowMeta,
        requested: Rect,
        components: [GeometryAdapter.Component],
        expectedIdentity: ExpectedIdentityValue? = nil
    ) async throws -> WriteValue {
        try await adapter.write(
            meta: meta,
            requested: requested,
            components: components,
            expectedIdentity: expectedIdentity
        )
    }

    func focus(meta: WindowMeta, expectedIdentity: ExpectedIdentityValue? = nil) async throws {
        try adapter.focus(meta: meta, expectedIdentity: expectedIdentity)
    }

    // MARK: Loops

    private func topologyLoop() async {
        while !Task.isCancelled {
            refreshTopology()
            try? await Task.sleep(for: .milliseconds(500))
        }
    }

    private func windowLoop() async {
        while !Task.isCancelled {
            await refreshWindows()
            try? await Task.sleep(for: .milliseconds(1000))
        }
    }

    /// Out-of-band refresh triggered by NSWorkspace notifications.
    func refreshSoon() {
        Task { @MainActor in
            self.refreshTopology()
            await self.refreshWindows()
        }
    }

    // MARK: Topology

    private func refreshTopology() {
        guard let online = TopologySource.onlineDisplayList() else { return }
        let screens = TopologySource.screenSnapshots()
        let topology = TopologySource.displays(online: online, screens: screens)
        if topology != lastTopology {
            lastTopology = topology
            emit(.topologyChanged)
        }
    }

    // MARK: Windows

    private var lastMetas: [String: WindowMeta] = [:]

    private func refreshWindows() async {
        let applications = WindowSource.knownApplications()
        let (axWindows, stalled) = await WindowSource.collectAXWindows(
            applications: applications,
            previouslyStalled: stalledPids)
        stalledPids = stalled
        let cgWindows = WindowSource.collectCGWindows()
        let joined = Normalizer.normalize(
            ax: axWindows,
            cg: cgWindows,
            hiddenPids: Self.hiddenPids())
        let metas = joined.map { WindowMeta(joined: $0) }
        adapter.reconcile(windows: metas)

        var current: [String: WindowValue] = [:]
        var metasByID: [String: WindowMeta] = [:]
        for (value, meta) in zip(joined.map(\.value), metas) {
            current[value.id] = value
            metasByID[value.id] = meta
        }
        lastMetas = metasByID

        diffAndEmit(current: current)
    }

    nonisolated private static func hiddenPids() -> Set<Int32> {
        Set(
            NSWorkspace.shared.runningApplications.filter(\.isHidden).map(\.processIdentifier)
                .filter { $0 > 0 })
    }

    private func diffAndEmit(current: [String: WindowValue]) {
        let previous = lastWindows
        lastWindows = current

        for (id, value) in current where previous[id] == nil {
            emit(.windowAdded(value))
        }
        for id in previous.keys where current[id] == nil {
            emit(.windowRemoved(windowId: id))
        }
        for (id, value) in current {
            guard let before = previous[id], before != value else { continue }
            emit(.windowChanged(value))
        }

        let focusedId = current.first(where: { $0.value.focused })?.key
        if focusedId != lastFocusedId {
            lastFocusedId = focusedId
            emit(.focusChanged(windowId: focusedId))
        }
    }

    // MARK: NSWorkspace observers

    nonisolated private static func installWorkspaceObservers(service: InventoryService) {
        func observe(_ name: Notification.Name, _ handle: @escaping @MainActor (InventoryService) -> Void) {
            NSWorkspace.shared.notificationCenter.addObserver(
                forName: name, object: nil, queue: .main
            ) { _ in
                Task { @MainActor in handle(service) }
            }
        }
        observe(NSWorkspace.willSleepNotification) { $0.forwardEvent(.sleep) }
        observe(NSWorkspace.didWakeNotification) {
            $0.forwardEvent(.wake)
            $0.refreshSoon()
        }
        observe(NSWorkspace.activeSpaceDidChangeNotification) {
            $0.forwardEvent(.spaceChanged)
            $0.refreshSoon()
        }
        observe(NSWorkspace.didActivateApplicationNotification) { $0.refreshSoon() }
    }

    fileprivate func forwardEvent(_ event: EventMessage) {
        emit(event)
    }
}
