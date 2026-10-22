import AppKit
import ApplicationServices
import Foundation

/// Periodic observation loop: topology by polling `CGGetOnlineDisplayList`
/// (~500 ms; AppKit screen notifications never deliver without an event loop
/// — bean wm-dm8l), windows by diffing successive AX+CG inventories (~1000 ms).
/// Emits wire events through the provided sink; the first pass is baseline
/// only. NSWorkspace sleep/wake/space/activation notifications are delivered
/// on the main run loop and trigger out-of-band refreshes.
@MainActor
final class InventoryService {
    typealias Sink = @MainActor @Sendable (EventMessage) -> Void

    private let emit: Sink
    private var lastTopology: TopologyValue?
    private var lastWindows: [String: WindowValue] = [:]
    private var lastFocusedId: String?
    private var windowReferences: [String: AXUIElement] = [:]
    private var stalledPids: Set<Int32> = []
    private var stalledRetryOffset = 0
    private var started = false
    private let adapter = GeometryAdapter()
    private var lifecycle = WindowLifecycle()
    private var unavailableWindowIds: [String] = []
    private var closedWindowIds: [String] = []
    private var inventoryAvailable = false
    private var sleeping = false
    private var refreshingWindows = false
    private var sessionGeneration = 0

    init(emit: @escaping Sink) {
        self.emit = emit
    }

    func start() {
        guard !started else { return }
        started = true
        Task { await self.topologyLoop() }
        Task { await self.windowLoop() }
        Task { await self.focusLoop() }
        Self.installWorkspaceObservers(service: self)
    }

    // MARK: Snapshots

    func currentTopology() -> TopologyValue? { lastTopology }

    func currentWindows() -> [WindowValue] {
        lastWindows.values.sorted { $0.id < $1.id }
    }

    func currentInventory() -> WindowInventoryValue? {
        guard inventoryAvailable, !sleeping else { return nil }
        return WindowInventoryValue(
            windows: currentWindows(),
            unavailableWindowIds: unavailableWindowIds, closedWindowIds: closedWindowIds)
    }

    func observationUnavailable(for id: String) -> Bool {
        sleeping || !inventoryAvailable || unavailableWindowIds.contains(id)
    }

    func metadata(for id: String) -> WindowMeta? {
        lastMetas[id]
    }

    /// Whether the app's AX enumeration is currently recorded as stalled —
    /// reported alongside write outcomes so stalled evidence is identifiable.
    func isStalled(pid: Int32) -> Bool { stalledPids.contains(pid) }

    // MARK: Geometry/focus pass-through (all MainActor, AX bounded per element)

    func liveObservation(for meta: WindowMeta) -> WindowValue? {
        adapter.observation(for: meta)
    }
    func inspectWindow(_ id: String) -> WindowInspectionValue {
        adapter.inspectWindow(id: id, meta: metadata(for: id))
    }

    func currentObservedFrame(for meta: WindowMeta) -> Rect? {
        try? adapter.readFrame(meta: meta)
    }

    func settleAfterRejectedWrite(
        meta: WindowMeta,
        requested: Rect,
        expectedIdentity: ExpectedIdentityValue?
    ) async throws -> GeometryAdapter.Settlement {
        try await adapter.settleAfterRejectedWrite(
            meta: meta, requested: requested, expectedIdentity: expectedIdentity)
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

    func focus(meta: WindowMeta, expectedIdentity: ExpectedIdentityValue? = nil) async -> FocusValue {
        adapter.focus(meta: meta, expectedIdentity: expectedIdentity)
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

    private func focusLoop() async {
        while !Task.isCancelled {
            refreshFocus()
            try? await Task.sleep(for: .milliseconds(25))
        }
    }

    /// Read only the active app, independently of slow all-app inventories.
    private func refreshFocus() {
        let focus = WindowFocus.current(timeout: 0.05)
        // A failed AX read is not a focus-loss signal. A readable but unknown
        // window clears managed focus until inventory can admit its identity.
        guard focus.window != nil || focus.pid == nil else { return }
        let id = Self.focusedWindowID(in: windowReferences, focus: focus)
        publishFocus(id)
    }

    private func publishFocus(_ id: String?) {
        guard id != lastFocusedId else { return }
        FocusLatencyTrace.record("focus_observed", windowId: id)
        lastWindows = lastWindows.mapValues { window in
            var updated = window
            updated.focused = window.id == id
            return updated
        }
        lastFocusedId = id
        emit(.focusChanged(windowId: id))
    }

    /// Out-of-band refresh triggered by NSWorkspace notifications.
    func refreshSoon() {
        refreshFocus()
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
        guard !sleeping, !refreshingWindows else { return }
        guard AXIsProcessTrusted() else {
            inventoryAvailable = false
            return
        }
        refreshingWindows = true
        defer { refreshingWindows = false }
        let generation = sessionGeneration
        guard let discoveryWindows = await Task.detached(operation: { WindowSource.readCGWindows() }).value else {
            inventoryAvailable = false
            return
        }
        let applications = WindowSource.knownApplications(cgWindows: discoveryWindows)
        let focus = WindowFocus.current()
        let frontmostPID = focus.pid
        let (axWindows, stalled) = await WindowSource.collectAXWindows(
            applications: applications,
            previouslyStalled: stalledPids,
            frontmostPID: frontmostPID,
            retryOffset: stalledRetryOffset)
        stalledRetryOffset += 2
        // Enumeration yields. Never publish focus sampled for an app that has
        // since lost activation (including activation by a wm focus command).
        guard !sleeping, generation == sessionGeneration, focus == WindowFocus.current() else { return }
        // Report stall transitions: entering the stalled set means the app's
        // AX messaging timed out during enumeration; leaving it means a probe
        // found the app responsive again (identification, not policy).
        for pid in stalled where !stalledPids.contains(pid) {
            emit(.axStall(pid: pid, app: applications.first { $0.pid == pid }?.name))
        }
        let runningPids = Set(applications.map(\.pid))
        for pid in stalledPids where !stalled.contains(pid) && runningPids.contains(pid) {
            emit(.axRecover(pid: pid))
        }
        stalledPids = stalled
        guard let cgWindows = await Task.detached(operation: { WindowSource.readCGWindows() }).value else {
            inventoryAvailable = false
            return
        }
        guard !sleeping, generation == sessionGeneration, focus == WindowFocus.current() else { return }
        let normalized = Normalizer.normalize(
            ax: axWindows,
            cg: cgWindows,
            hiddenPids: Self.hiddenPids())
        let observation = lifecycle.reconcile(joined: normalized, stalled: stalled, cgWindows: cgWindows)
        let joined = observation.windows
        unavailableWindowIds = observation.unavailable
        closedWindowIds = observation.closed
        inventoryAvailable = true
        for id in closedWindowIds { emit(.windowRemoved(windowId: id, closed: true)) }
        windowReferences = Dictionary(
            joined.compactMap { window in
                window.raw.reference.map { (window.value.id, $0.element) }
            }, uniquingKeysWith: { first, _ in first })
        let metas = joined.map { WindowMeta(joined: $0) }
        adapter.reconcile(windows: metas, references: windowReferences)

        var current: [String: WindowValue] = [:]
        var metasByID: [String: WindowMeta] = [:]
        for (value, meta) in zip(joined.map(\.value), metas) {
            current[value.id] = value
            metasByID[value.id] = meta
        }
        lastMetas = metasByID

        diffAndEmit(
            current: current,
            frontmostPID: frontmostPID)
    }

    nonisolated private static func hiddenPids() -> Set<Int32> {
        Set(
            NSWorkspace.shared.runningApplications.filter(\.isHidden).map(\.processIdentifier)
                .filter { $0 > 0 })
    }

    private func diffAndEmit(current: [String: WindowValue], frontmostPID: Int32?) {
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

        let focusedId = Self.focusedWindowID(in: current, frontmostPID: frontmostPID)
        publishFocus(focusedId)
        refreshFocus()
    }

    nonisolated static func focusedWindowID(
        in references: [String: AXUIElement], focus: WindowFocus.Snapshot
    ) -> String? {
        guard let focused = focus.window else { return nil }
        var pid: pid_t = 0
        guard AXUIElementGetPid(focused, &pid) == .success, pid == focus.pid else { return nil }
        return references.first { CFEqual($0.value, focused) }?.key
    }

    nonisolated static func focusedWindowID(
        in windows: [String: WindowValue],
        frontmostPID: Int32?
    ) -> String? {
        guard let frontmostPID else { return nil }
        return windows.first {
            $0.value.pid == Int(frontmostPID) && $0.value.focused
        }?.key
    }

    // MARK: NSWorkspace observers

    nonisolated private static func installWorkspaceObservers(service: InventoryService) {
        func observe(
            _ name: Notification.Name, _ handle: @escaping @MainActor (InventoryService) -> Void
        ) {
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
        switch event {
        case .sleep:
            sleeping = true
            inventoryAvailable = false
            sessionGeneration += 1
        case .wake:
            sleeping = false
            inventoryAvailable = false
            sessionGeneration += 1
        default: break
        }
        emit(event)
    }
}
