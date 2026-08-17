import Foundation
import WMInventory
import WMProtocol
import WMWorkspace

struct DaemonLifecycle {
    private(set) var isPaused = false
    private(set) var isTerminating = false

    mutating func pause() -> Bool {
        defer { isPaused = true }
        return !isPaused
    }

    mutating func resume() -> Bool {
        guard !isTerminating else { return false }
        defer { isPaused = false }
        return isPaused
    }

    mutating func beginTermination() {
        isPaused = true
        isTerminating = true
    }

    func requireMutationAllowed() throws {
        if isTerminating { throw DaemonLifecycleError.terminating }
        if isPaused { throw DaemonLifecycleError.paused }
    }
}

enum SessionTransitionCause: String, Codable, CaseIterable, Sendable {
    case sleep, wake, unlock
    case activeSession = "active_session"
    case clamshell
}

struct SessionTransitionResult: Equatable, Sendable {
    var epoch: UInt64
    var cause: SessionTransitionCause
    var observerGeneration: UInt64
    var displayStabilized: Bool
    var stabilizationAttempts: Int
}

enum SessionTransitionError: Error, Equatable {
    case displayTopologyUnstable(attempts: Int)
}

actor SessionTransitionEpochs<Display: Equatable & Sendable, Inventory: Sendable> {
    typealias Sleep = @Sendable (Duration) async throws -> Void
    typealias Run = @Sendable (SessionTransitionCause) async throws -> SessionTransitionResult

    private let maximumDisplayAttempts: Int
    private let stabilizationDelay: Duration
    private let sleep: Sleep
    private var epoch: UInt64 = 0
    private var observerGeneration: UInt64 = 0
    private var pendingCause: SessionTransitionCause?
    private var inFlight: Task<SessionTransitionResult, Error>?
    private var queuedCause: SessionTransitionCause?
    private var waiters: [CheckedContinuation<SessionTransitionResult, Error>] = []

    init(
        maximumDisplayAttempts: Int = 8,
        stabilizationDelay: Duration = .milliseconds(250),
        sleep: @escaping Sleep = { try await Task.sleep(for: $0) }
    ) {
        self.maximumDisplayAttempts = max(2, maximumDisplayAttempts)
        self.stabilizationDelay = stabilizationDelay
        self.sleep = sleep
    }

    func begin(_ cause: SessionTransitionCause, pause: @Sendable () async -> Void) async {
        pendingCause = cause
        await pause()
    }

    func activationCause() -> SessionTransitionCause {
        pendingCause == .sleep || pendingCause == .wake ? .unlock : .activeSession
    }

    func queuedTransitionCause() -> SessionTransitionCause? { queuedCause }

    func submit(
        cause: SessionTransitionCause,
        begin: @escaping @Sendable (SessionTransitionCause) async -> Void = { _ in },
        run: @escaping Run,
        complete: @escaping @Sendable () async -> Void = {},
        fail: @escaping @Sendable (Error) async -> Void = { _ in }
    ) async throws -> SessionTransitionResult {
        if inFlight != nil {
            queuedCause = cause
            return try await withCheckedThrowingContinuation { waiters.append($0) }
        }
        let task = Task {
            await begin(cause)
            do {
                let result = try await runPending(cause, run: run)
                await complete()
                return result
            } catch {
                await fail(error)
                throw error
            }
        }
        inFlight = task
        do {
            let result = try await task.value
            inFlight = nil
            waiters.forEach { $0.resume(returning: result) }
            waiters.removeAll(keepingCapacity: true)
            return result
        } catch {
            queuedCause = nil
            inFlight = nil
            waiters.forEach { $0.resume(throwing: error) }
            waiters.removeAll(keepingCapacity: true)
            throw error
        }
    }

    private func runPending(_ cause: SessionTransitionCause, run: Run) async throws -> SessionTransitionResult {
        var result = try await run(cause)
        while let cause = queuedCause {
            queuedCause = nil
            result = try await run(cause)
        }
        return result
    }

    func resynchronize(
        cause: SessionTransitionCause,
        pause: @Sendable () async -> Void,
        displays: @Sendable () async throws -> Display,
        permissions: @Sendable () async throws -> Void,
        recreateObservers: @Sendable (_ generation: UInt64) async throws -> Void,
        rebuildInventory: @Sendable () async throws -> Inventory,
        reconstructAndReconcile: @Sendable (Inventory) async throws -> Void,
        resume: @Sendable () async -> Void
    ) async throws -> SessionTransitionResult {
        await pause()
        pendingCause = cause
        epoch &+= 1
        let stabilization = try await stableDisplays(displays)
        guard stabilization.stable else {
            throw SessionTransitionError.displayTopologyUnstable(attempts: stabilization.attempts)
        }
        try await permissions()
        observerGeneration &+= 1
        try await recreateObservers(observerGeneration)
        let inventory = try await rebuildInventory()
        try await reconstructAndReconcile(inventory)
        pendingCause = nil
        await resume()
        return .init(
            epoch: epoch,
            cause: cause,
            observerGeneration: observerGeneration,
            displayStabilized: stabilization.stable,
            stabilizationAttempts: stabilization.attempts
        )
    }

    private func stableDisplays(
        _ snapshot: @Sendable () async throws -> Display
    ) async throws -> (stable: Bool, attempts: Int) {
        var previous = try await snapshot()
        for attempt in 2...maximumDisplayAttempts {
            try await sleep(stabilizationDelay)
            let current = try await snapshot()
            if current == previous { return (true, attempt) }
            previous = current
        }
        return (false, maximumDisplayAttempts)
    }
}

enum DaemonLifecycleError: Error, Equatable {
    case paused, terminating
}

struct ObserverGeometryReliability: Equatable {
    struct Clamp: Equatable {
        var requestedWidth: Double
        var requestedHeight: Double
        var observedWidth: Double
        var observedHeight: Double
    }
    private(set) var clamps: [String: Clamp] = [:]

    func shouldAttempt(windowID: String, requestedWidth: Double, requestedHeight: Double) -> Bool {
        guard let clamp = clamps[windowID] else { return true }
        return clamp.requestedWidth != requestedWidth || clamp.requestedHeight != requestedHeight
    }

    mutating func record(windowID: String, clamp: Clamp) -> Bool {
        guard clamps[windowID] != clamp else { return false }
        clamps[windowID] = clamp
        return true
    }

    mutating func clear(windowID: String) { clamps.removeValue(forKey: windowID) }
}

struct WorkspaceIntentAudit: Equatable {
    var restore: [String: InventoryRect]
    var park: Set<String>
    var reconcileVisible: Set<String>

    init(state: WMWorkspace.WorkspaceState, inventory: InventorySnapshot) {
        let live = Dictionary(uniqueKeysWithValues: inventory.windows.map { ($0.id, $0) })
        restore = [:]
        park = []
        reconcileVisible = []
        for workspace in state.workspaces {
            if workspace.visible {
                reconcileVisible.insert(workspace.name)
                for id in workspace.windowIDs where state.parkedWindowFrames[id] != nil {
                    if live[id] != nil { restore[id] = state.parkedWindowFrames[id]?.inventoryRect }
                }
            } else {
                for id in workspace.windowIDs where live[id] != nil { park.insert(id) }
            }
        }
    }
}

struct StartupIntentAudit {
    static func candidate(
        state: WMWorkspace.WorkspaceState, inventory: InventorySnapshot,
        replacements: [String: String] = [:]
    ) -> WMWorkspace.WorkspaceState {
        guard inventory.sourceHealth.first(where: { $0.source == .coreGraphics })?.status == .healthy else {
            return state
        }
        let liveIDs = Set(inventory.windows.map(\.id))
        var replacements = replacements
        let assigned = state.workspaces.flatMap(\.windowIDs)
        let legacyGroups = Dictionary(grouping: assigned.filter {
            $0.hasPrefix("window:ax:") && !liveIDs.contains($0)
        }) { $0.split(separator: ":").dropLast().joined(separator: ":") }
        for (prefix, oldIDs) in legacyGroups {
            let matches = inventory.windows.map(\.id).filter { $0.hasPrefix(prefix + ":") }.sorted()
            for (oldID, newID) in zip(oldIDs.sorted(), matches) { replacements[oldID] = newID }
        }
        var candidate = state
        if let displayID = inventory.displays.first(where: \.isPrimary)?.id
            ?? inventory.displays.first?.id {
            do {
                let result = try candidate.reconcileObservedWindows(
                    inventory.windows.filter { $0.classification == .normal }.map(\.id),
                    replacements: replacements, defaultDisplayID: displayID)
                candidate = result.workspaceState
            } catch {
                return state
            }
        }
        let livePIDs = Set(inventory.appScans.map(\.application.pid))
        let successfulPIDs = Set(inventory.appScans.filter { $0.status == .succeeded }.map(\.application.pid))
        func isDefinitivelyAbsentAXIdentity(_ id: String) -> Bool {
            guard id.hasPrefix("window:ax:"),
                let pid = Int32(id.split(separator: ":", maxSplits: 3)[2]) else { return false }
            return inventory.applicationEnumerationSucceeded && !livePIDs.contains(pid)
                || successfulPIDs.contains(pid)
        }
        for workspace in state.workspaces {
            for id in workspace.windowIDs where replacements[id] == nil
                && (inventory.windows.contains { $0.id == id && $0.management == .ineligible }
                    || ((id.hasPrefix("window:cg:") || isDefinitivelyAbsentAXIdentity(id))
                        && !liveIDs.contains(id))) {
                candidate.removeWindow(id, from: workspace.name)
            }
        }
        return candidate
    }

    static func run(
        state: WMWorkspace.WorkspaceState,
        inventory: InventorySnapshot,
        audit: (WMWorkspace.WorkspaceState) throws -> Void,
        commit: (WMWorkspace.WorkspaceState) throws -> Void
    ) throws {
        let candidate = candidate(state: state, inventory: inventory)
        try audit(candidate)
        try commit(candidate)
    }
}

struct WorkspaceIntentAuditStep: Equatable {
    enum Action: Equatable { case restore(InventoryRect), park, retile }
    var windowOrWorkspaceID: String
    var action: Action

    var isRequiredForRecovery: Bool {
        switch action {
        case .restore, .park: true
        case .retile: false
        }
    }
}

extension WorkspaceIntentAudit {
    var orderedSteps: [WorkspaceIntentAuditStep] {
        restore.keys.sorted().compactMap { id in restore[id].map { .init(windowOrWorkspaceID: id, action: .restore($0)) } }
            + park.sorted().map { .init(windowOrWorkspaceID: $0, action: .park) }
            + reconcileVisible.sorted().map { .init(windowOrWorkspaceID: $0, action: .retile) }
    }
}

private extension ParkedWindowFrame {
    var inventoryRect: InventoryRect { .init(x: x, y: y, width: width, height: height) }
}
