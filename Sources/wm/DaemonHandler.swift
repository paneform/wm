import Foundation
import WMCore
import WMInventory
import WMProtocol
import WMWebSocket
import WMWorkspace

actor DaemonHandler: WebSocketRequestHandler {
    typealias State = InventoryState<SystemInventoryProvider>

    private struct WorkspaceSubscription {
        let topics: Set<EventTopic>
        let projection: Projection
    }

    private let state: State
    private let router: RequestRouter<SystemInventoryProvider>
    private let geometry = WindowGeometryService(adapter: AXWindowGeometryAdapter())
    private let workspaces: WorkspaceController
    private let sessionID = UUID().uuidString
    private let version = "0.0.1-dev"
    private var subscriptions: [UUID: [String: Task<Void, Never>]] = [:]
    private var workspaceSubscriptions: [UUID: [String: WorkspaceSubscription]] = [:]
    private var stateSnapshotSubscriptions: [UUID: [String: SnapshotDetail]] = [:]
    private var workspaceSequence: UInt64 = 0
    private var windowMinimumSizes: [String: WorkspaceMinimumSize] = [:]
    private var observerGeometryReliability = ObserverGeometryReliability()
    private var sessionWindows: [String: NormalizedWindow] = [:]
    private var lifecycle = ManagedWindowLifecycle()
    private var daemonLifecycle = DaemonLifecycle()
    private let transactions = TransactionCoordinator<JSONValue>()
    private let sessionTransitions = SessionTransitionEpochs<[DisplayObservation], InventorySnapshot>()
    private var lastTransitionTrace: JSONValue = .null
    private var sender: (@Sendable (String, UUID) -> Void)?
    private var internalErrorReporter: (@Sendable (String) -> Void)?


    init(state: State, workspaces: WorkspaceController) {
        self.state = state
        self.workspaces = workspaces
        router = RequestRouter(inventory: state)
    }

    func installSender(_ sender: @escaping @Sendable (String, UUID) -> Void) { self.sender = sender }
    func installInternalErrorReporter(_ reporter: @escaping @Sendable (String) -> Void) { internalErrorReporter = reporter }

    func reconcileExternalFocus(
        windowID: String?, frontmostPID: Int32?, inventory: InventorySnapshot, allowWhilePaused: Bool = false
    ) async throws {
        if !allowWhilePaused { try daemonLifecycle.requireMutationAllowed() }
        try await reconcileExternalFocusAuthorized(windowID: windowID, frontmostPID: frontmostPID, inventory: inventory)
    }

    private func reconcileExternalFocusAuthorized(
        windowID: String?, frontmostPID: Int32?, inventory: InventorySnapshot,
        tolerateGeometryClamp: Bool = false
    ) async throws {
        retainSessionWindows(inventory.windows)
        let windowID = resolveRetainedFocusedWindowID(
            windows: Array(sessionWindows.values), focusedWindowID: windowID, frontmostPID: frontmostPID
        )
        guard let windowID else { return }
        let before = await workspaces.snapshot()
        guard let name = before.workspaceName(containing: windowID), name != before.focusedWorkspaceName else { return }
        let displayID = before[workspace: name]?.displayID
        var mutation = try await workspaces.previewFocus(name: name, displayID: displayID)
        mutation.workspaceState.setFocusedWindow(windowID, in: name)
        try await reconcileWorkspaceFocus(
            before: before, after: &mutation.workspaceState, name: name, inventory: inventory,
            tolerateGeometryClamp: tolerateGeometryClamp
        )
        try await workspaces.commitFocus(mutation)
        await publishWorkspaceMutation(mutation, before: before, reason: .workspaceFocused)
    }

    func reconcileApplicationActivation(frontmostPID: Int32, inventory: InventorySnapshot) async throws {
        let receipt = try await submitInternal(name: "observer.activation", idempotencyKey: "activation:\(frontmostPID)") { [weak self] in
            guard let self else { throw CancellationError() }
            try await self.reconcileExternalFocusAuthorized(
                windowID: nil, frontmostPID: frontmostPID, inventory: inventory, tolerateGeometryClamp: true
            )
        }
        if let failure = receipt.transaction.failure { throw failure }
    }

    func reconcilePeriodicObservation(
        _ inventory: InventorySnapshot, displayID: String, focusedWindowID: String?, frontmostPID: Int32?
    ) async throws {
        let receipt = try await submitInternal(name: "observer.periodic", idempotencyKey: "observer.periodic") { [weak self] in
            guard let self else { throw CancellationError() }
            try await self.reconcileObservedWindowsAuthorized(inventory, displayID: displayID)
            try await self.reconcileExternalFocusAuthorized(
                windowID: focusedWindowID, frontmostPID: frontmostPID, inventory: inventory, tolerateGeometryClamp: true
            )
        }
        if let failure = receipt.transaction.failure { throw failure }
    }

    static func focusCandidateIDs(
        workspace: WMWorkspace.Workspace, inventory: InventorySnapshot
    ) -> [String] {
        let liveIDs = Set(inventory.windows.map(\.id))
        let preferred = workspace.focusedWindowID.map { [$0] } ?? []
        return (preferred + workspace.windowIDs.reversed().filter { $0 != workspace.focusedWindowID })
            .filter(liveIDs.contains)
    }

    func reconcileObservedWindows(_ inventory: InventorySnapshot, displayID: String) async throws {
        try daemonLifecycle.requireMutationAllowed()
        try await reconcileObservedWindowsAuthorized(inventory, displayID: displayID)
    }

    private func reconcileObservedWindowsAuthorized(_ inventory: InventorySnapshot, displayID: String) async throws {
        let committed = await workspaces.snapshot()
        try await workspaces.commit(StartupIntentAudit.candidate(state: committed, inventory: inventory))
        let update = lifecycle.reconcile(inventory)
        try await applyLifecycleUpdate(update, displayID: displayID)
    }

    func auditCommittedIntent(
        _ inventory: InventorySnapshot, state proposed: WMWorkspace.WorkspaceState? = nil
    ) async throws {
        let committed: WMWorkspace.WorkspaceState
        if let proposed { committed = proposed } else { committed = await workspaces.snapshot() }
        retainSessionWindows(inventory.windows)
        await geometry.reconcile(windows: inventory.windows)
        let audit = WorkspaceIntentAudit(state: committed, inventory: inventory)
        for step in audit.orderedSteps {
            switch step.action {
            case .restore(let frame):
                _ = try await geometry.set(
                    window: resolveWindow(step.windowOrWorkspaceID, in: inventory.windows),
                    params: frameParams(step.windowOrWorkspaceID, frame)
                )
            case .park:
                try await parkCommittedWindow(step.windowOrWorkspaceID, state: committed, inventory: inventory)
            case .retile:
                await tileWorkspaceForObserver(
                    committed, named: step.windowOrWorkspaceID, inventory: inventory, forceStack: false
                )
            }
        }
    }

    func auditStartupIntent(_ inventory: InventorySnapshot) async throws {
        let committed = await workspaces.snapshot()
        let candidate = StartupIntentAudit.candidate(state: committed, inventory: inventory)
        try await auditCommittedIntent(inventory, state: candidate)
        try await workspaces.commit(candidate)
    }

    func beginTermination() { daemonLifecycle.beginTermination() }

    func shutdown(_ inventory: InventorySnapshot) async -> [String] {
        daemonLifecycle.beginTermination()
        retainSessionWindows(inventory.windows)
        await geometry.reconcile(windows: inventory.windows)
        let committed = await workspaces.snapshot()
        var failures: [String] = []
        for id in committed.parkedWindowFrames.keys.sorted() {
            guard let restore = committed.parkedWindowFrames[id], let window = sessionWindows[id] else {
                failures.append("\(id): not observed during shutdown")
                continue
            }
            do { _ = try await geometry.set(window: window, params: frameParams(id, restore.inventoryRect)) }
            catch { failures.append("\(id): \(error)") }
        }
        return failures
    }

    func isPaused() -> Bool { daemonLifecycle.isPaused }

    func beginSessionTransition(_ cause: SessionTransitionCause) async {
        await sessionTransitions.begin(cause) { [weak self] in await self?.pauseForSessionTransition(cause) }
    }

    func resynchronizeActivatedSession() async throws {
        try await resynchronizeSession(await sessionTransitions.activationCause())
    }

    func resynchronizeSession(_ cause: SessionTransitionCause) async throws {
        let result = try await sessionTransitions.resynchronize(
            cause: cause,
            pause: { [weak self] in await self?.pauseForSessionTransition(cause) },
            displays: { [state] in try await state.refresh().snapshot.inventory.displays },
            permissions: { [state] in
                let snapshot = try await state.refresh().snapshot
                guard snapshot.health.capabilities["accessibility"] as? Bool == true,
                      snapshot.health.capabilities["core_graphics"] as? Bool == true else {
                    throw DaemonLifecycleRequestError.permissionDenied
                }
            },
            recreateObservers: { [weak self] _ in await self?.discardStaleSessionHandles() },
            rebuildInventory: { [state] in try await state.refresh().snapshot.inventory },
            reconstructAndReconcile: { [weak self] inventory in
                guard let self else { throw CancellationError() }
                try await self.reconstructObservedState(inventory)
            },
            resume: { [weak self] in await self?.resumeAfterSessionTransition() }
        )
        await publishSessionEvent(.sessionResynchronized, data: .object([
            "epoch": .number(Double(result.epoch)),
            "cause": .string(result.cause.rawValue),
            "observer_generation": .number(Double(result.observerGeneration)),
            "display_stabilized": .bool(result.displayStabilized),
            "stabilization_attempts": .number(Double(result.stabilizationAttempts)),
        ]))
        if let health = try? await state.health() {
            await publishSessionEvent(.healthChanged, data: json(protocolHealth(health)))
        }
    }

    private func pauseForSessionTransition(_ cause: SessionTransitionCause) async {
        _ = daemonLifecycle.pause()
        await transactions.beginRecovery(reason: "session transition: \(cause.rawValue)")
        await publishSessionEvent(.daemonPaused, data: .object(["cause": .string(cause.rawValue)]))
    }

    private func discardStaleSessionHandles() async {
        sessionWindows.removeAll(keepingCapacity: true)
        windowMinimumSizes.removeAll(keepingCapacity: true)
        observerGeometryReliability = .init()
        lifecycle = .init()
        await geometry.reconcile(windows: [])
    }

    private func reconstructObservedState(_ inventory: InventorySnapshot) async throws {
        guard let displayID = (inventory.displays.first(where: \.isPrimary) ?? inventory.displays.first)?.id else {
            throw WorkspaceRequestError.displayRequired
        }
        let committed = await workspaces.snapshot()
        let candidate = StartupIntentAudit.candidate(state: committed, inventory: inventory)
        try await auditCommittedIntent(inventory, state: candidate)
        try await workspaces.commit(candidate)
        let update = lifecycle.reconcile(inventory)
        try await applyLifecycleUpdate(update, displayID: displayID)
    }

    private func resumeAfterSessionTransition() async {
        _ = daemonLifecycle.resume()
        await transactions.endRecovery(success: true)
        await publishSessionEvent(.daemonResumed, data: .object(["resynchronized": .bool(true)]))
    }

    private func publishSessionEvent(_ topic: EventTopic, data: JSONValue) async {
        workspaceSequence &+= 1
        let version = await currentVersion()
        for (clientID, subscriptions) in workspaceSubscriptions {
            for subscription in subscriptions.values where subscription.topics.contains(topic) {
                let projected = subscription.projection == .invalidation
                    ? JSONValue.object(["topic": .string(topic.rawValue), "state_version": .number(Double(version))])
                    : data
                sender?(encode(.event(.init(
                    sequence: workspaceSequence,
                    stateVersion: version,
                    timestamp: Date(),
                    topic: topic,
                    data: projected
                ))), clientID)
            }
        }
    }

    private func applyLifecycleUpdate(_ update: WindowLifecycleUpdate, displayID: String) async throws {
        let closedIDs = Set(update.verifiedClosedLifetimes.map(\.windowID))
        for lifetime in update.verifiedClosedLifetimes {
            if sessionWindows[lifetime.windowID]?.pid == lifetime.pid {
                sessionWindows.removeValue(forKey: lifetime.windowID)
            }
            windowMinimumSizes.removeValue(forKey: lifetime.windowID)
            observerGeometryReliability.clear(windowID: lifetime.windowID)
        }
        await geometry.evict(lifetimes: update.verifiedClosedLifetimes)
        let before = await workspaces.snapshot()
        let mutation = try await workspaces.reconcileObservedWindows(
            update.windows.map(\.id),
            removedIDs: closedIDs.union(update.newlyUnmanagedWindowIDs),
            displayID: displayID
        )
        retainSessionWindows(update.windows)
        await publishWorkspaceMutation(mutation, before: before, reason: .workspaceChanged)
    }

    func connected(clientID: UUID) async -> [String] {
        guard let committed = try? await state.state() else { return [] }
        let health = protocolHealth(committed.snapshot.health)
        return [encode(.welcome(.init(sessionId: sessionID, daemonVersion: version, currentSequence: committed.sequence, stateVersion: committed.stateVersion, health: health)))]
    }

    func handle(text: String, clientID: UUID) async -> [String] {
        let data = Data(text.utf8)
        guard let message = try? ProtocolCodec.decode(ClientMessage.self, from: data) else {
            return [encode(.response(.init(requestId: requestID(in: data) ?? "", error: .init(code: .invalidMessage, message: "invalid client message", retryable: false), stateVersion: await currentVersion())))]
        }
        switch message {
        case .request(let request):
            return [encode(await route(request))]
        case .subscribe(let request):
            return await subscribe(request, clientID: clientID)
        case .unsubscribe(let request):
            return await unsubscribe(request, clientID: clientID)
        }
    }

    func disconnected(clientID: UUID) async {
        for (id, task) in subscriptions.removeValue(forKey: clientID) ?? [:] {
            task.cancel()
            try? await state.unsubscribe(id: key(clientID, id))
        }
        workspaceSubscriptions.removeValue(forKey: clientID)
        stateSnapshotSubscriptions.removeValue(forKey: clientID)
    }

    private func subscribe(_ request: Subscribe, clientID: UUID) async -> [String] {
        if request.topics.contains(.stateSnapshot) {
            guard request.afterSequence == nil else {
                return [await errorResponse(request.requestId, .replayUnavailable, "state snapshot replay is unavailable")]
            }
            stateSnapshotSubscriptions[clientID, default: [:]][request.subscriptionId] = request.detail
            let response = encode(ServerMessage.response(.init(
                requestId: request.requestId,
                result: .object(["subscription_id": .string(request.subscriptionId)]),
                stateVersion: await currentVersion()
            )))
            return [response, await stateSnapshotEvent(detail: request.detail)]
        }
        let workspaceTopics = Set(request.topics.filter(\.isDaemonEvent))
        if !workspaceTopics.isEmpty {
            guard request.afterSequence == nil else {
                return [await errorResponse(request.requestId, .replayUnavailable, "workspace event replay is unavailable")]
            }
            workspaceSubscriptions[clientID, default: [:]][request.subscriptionId] = .init(
                topics: workspaceTopics,
                projection: request.projection
            )
            let response = encode(ServerMessage.response(.init(
                requestId: request.requestId,
                result: .object(["subscription_id": .string(request.subscriptionId)]),
                stateVersion: await currentVersion()
            )))
            return [response, await workspaceSnapshotEvent(topic: workspaceTopics.sorted(by: { $0.rawValue < $1.rawValue }).first!)]
        }
        do {
            let topics = Set(request.topics.compactMap { InventoryTopic(rawValue: $0.rawValue) })
            let subscription = try await state.subscribe(
                id: key(clientID, request.subscriptionId), topics: topics,
                projection: EventProjection(rawValue: request.projection.rawValue)!, afterSequence: request.afterSequence
            )
            let version = await currentVersion()
            let response = encode(ServerMessage.response(.init(requestId: request.requestId, result: .object(["subscription_id": .string(request.subscriptionId)]), stateVersion: version)))
            let sender = sender
            let task = Task {
                await Task.yield()
                for await item in subscription.stream {
                    guard !Task.isCancelled else { return }
                    sender?(encode(subscriptionMessage(item, id: request.subscriptionId)), clientID)
                }
            }
            subscriptions[clientID, default: [:]][request.subscriptionId]?.cancel()
            subscriptions[clientID, default: [:]][request.subscriptionId] = task
            return [response]
        } catch {
            return [await errorResponse(request.requestId, .notReady, "inventory is not ready")]
        }
    }

    private func unsubscribe(_ request: Unsubscribe, clientID: UUID) async -> [String] {
        if stateSnapshotSubscriptions[clientID]?.removeValue(forKey: request.subscriptionId) != nil {
            return [encode(.response(.init(requestId: request.requestId, result: .object([:]), stateVersion: await currentVersion())))]
        }
        if workspaceSubscriptions[clientID]?.removeValue(forKey: request.subscriptionId) != nil {
            return [encode(.response(.init(requestId: request.requestId, result: .object([:]), stateVersion: await currentVersion())))]
        }
        guard let task = subscriptions[clientID]?.removeValue(forKey: request.subscriptionId) else {
            return [await errorResponse(request.requestId, .subscriptionNotFound, "unknown subscription: \(request.subscriptionId)")]
        }
        task.cancel()
        try? await state.unsubscribe(id: key(clientID, request.subscriptionId))
        return [encode(.response(.init(requestId: request.requestId, result: .object([:]), stateVersion: await currentVersion())))]
    }

    private func coreResponse(_ response: CoreResponse) -> ServerMessage {
        if response.ok, let data = response.result, let result = try? ProtocolCodec.decode(JSONValue.self, from: data) {
            return .response(.init(requestId: response.requestID, result: result, stateVersion: response.stateVersion))
        }
        let code = ErrorCode(rawValue: response.error?.code ?? "internal_error") ?? .internalError
        return .response(.init(requestId: response.requestID, error: .init(code: code, message: response.error?.message ?? "internal error", retryable: response.error?.retryable ?? false), stateVersion: response.stateVersion))
    }

    private func route(_ request: Request) async -> ServerMessage {
        if request.method.isMutation && request.method != .daemonPause && request.method != .daemonResume {
            do {
                let mode = try returnMode(request.params["return_mode"])
                let key = request.method.isIdempotent ? canonicalKey(request) : nil
                let commandRequest = Request(
                    requestId: request.requestId, method: request.method,
                    params: request.params.filter { $0.key != "return_mode" }
                )
                let receipt = try await transactions.submit(.init(
                    name: request.method.rawValue, idempotencyKey: key,
                    authorize: { [weak self] in await self?.mutationBarrier() },
                    operate: { [weak self] in
                    guard let self else { throw CancellationError() }
                    let response = await self.routeDirect(commandRequest)
                    guard case let .response(value) = response else { throw CancellationError() }
                    if let error = value.error { throw TransactionFailure(error) }
                    return .init(result: value.result ?? .null, committedStateVersion: value.stateVersion)
                }, escalate: { [weak self] in try await self?.fullReconciliation() }), mode: mode)
                return .response(.init(requestId: request.requestId, result: json(receipt), stateVersion: await currentVersion()))
            } catch TransactionCoordinatorError.queueFull {
                return .response(.init(requestId: request.requestId, error: .init(code: .notReady, message: "transaction queue is full", retryable: true), stateVersion: await currentVersion()))
            } catch let error as WorkspaceRequestError {
                return .response(.init(requestId: request.requestId, error: .init(code: error.code, message: error.message, retryable: false), stateVersion: await currentVersion()))
            } catch {
                return .response(.init(requestId: request.requestId, error: .init(code: .internalError, message: "transaction submission failed", retryable: false), stateVersion: await currentVersion()))
            }
        }
        return await routeDirect(request)
    }

    private func routeDirect(_ request: Request) async -> ServerMessage {
        do {
            if request.method == .inventoryRefresh { _ = await router.route(.init(requestID: request.requestId, method: request.method.rawValue)) }
            var committed = try await state.state()
            let snapshot = committed.snapshot
            retainSessionWindows(snapshot.inventory.windows)
            await geometry.reconcile(windows: snapshot.inventory.windows)
            let result: JSONValue
            if request.method.isMutation && request.method != .daemonResume {
                try daemonLifecycle.requireMutationAllowed()
            }
            switch request.method {
            case .stateGet:
                var value = userState(committed)
                if case .object(var object) = value { object["transactions"] = json(await transactions.metadata()); value = .object(object) }
                result = value
            case .stateObserved: result = json(snapshot.inventory)
            case .healthGet: result = json(protocolHealth(snapshot.health))
            case .displayList: result = json(["displays": snapshot.inventory.displays])
            case .windowList: result = json(["windows": snapshot.inventory.windows])
            case .windowManage, .windowUnmanage:
                let params = try decodeParams(WindowManagementParams.self, from: .object(request.params))
                guard snapshot.inventory.windows.contains(where: { $0.id == params.windowID }) || sessionWindows[params.windowID] != nil else {
                    throw WorkspaceRequestError.windowNotFound(params.windowID)
                }
                let override: WindowManagementOverride = request.method == .windowManage ? .managed : .unmanaged
                guard let update = lifecycle.setOverride(override, for: params.windowID) else {
                    throw WorkspaceRequestError.windowNotFound(params.windowID)
                }
                let displayID = try resolveDisplay(nil, inventory: snapshot.inventory, workspaceState: await workspaces.snapshot())
                try await applyLifecycleUpdate(update, displayID: displayID)
                result = .object([
                    "window_id": .string(params.windowID),
                    "management": .string(request.method == .windowManage ? "managed" : "unmanaged"),
                ])
            case .observeWindow:
                committed = try await state.refresh()
                retainSessionWindows(committed.snapshot.inventory.windows)
                result = observeWindows(params: request.params, inventory: committed.snapshot.inventory, workspaceState: await workspaces.snapshot())
            case .observeWorkspace:
                let params = try decodeParams(ObserveWorkspaceParams.self, from: .object(request.params))
                committed = try await state.refresh()
                retainSessionWindows(committed.snapshot.inventory.windows)
                result = try observeWorkspace(
                    named: params.name,
                    inventory: committed.snapshot.inventory,
                    workspaceState: await workspaces.snapshot()
                )
            case .windowFrameGet:
                let params = try decodeParams(WindowFrameGetParams.self, from: .object(request.params))
                let window = try resolveWindow(params.windowID, in: snapshot.inventory.windows)
                result = json(try await geometry.get(window: window))
            case .windowFrameSet:
                let params = try decodeParams(WindowFrameSetParams.self, from: .object(request.params))
                var window = try resolveWindow(params.windowID, in: snapshot.inventory.windows)
                let setResult = try await geometry.set(window: window, params: params)
                window.frame = InventoryRect(
                    x: setResult.observedFrame.x,
                    y: setResult.observedFrame.y,
                    width: setResult.observedFrame.width,
                    height: setResult.observedFrame.height
                )
                committed = try await state.update(window: .init(id: window.id, value: window))
                result = json(setResult)
            case .diagnosticsInventory: result = json(snapshot.inventory)
            case .inventoryRefresh:
                let inventory = committed.snapshot.inventory
                if let displayID = (inventory.displays.first(where: \.isPrimary) ?? inventory.displays.first)?.id {
                    try await reconcileObservedWindows(inventory, displayID: displayID)
                }
                result = json(userState(committed))
            case .daemonPing: result = .object(["session_id": .string(sessionID), "daemon_version": .string(version), "ready": .bool(true), "paused": .bool(daemonLifecycle.isPaused), "current_sequence": .number(Double(committed.sequence)), "state_version": .number(Double(committed.stateVersion))])
            case .daemonPause:
                _ = daemonLifecycle.pause()
                result = .object(["paused": .bool(true)])
            case .daemonResume:
                await transactions.beginRecovery(reason: "daemon resume reconciliation")
                do {
                    committed = try await state.refresh()
                    guard committed.snapshot.health.capabilities["accessibility"] as? Bool == true,
                          committed.snapshot.health.capabilities["core_graphics"] as? Bool == true else {
                        throw DaemonLifecycleRequestError.permissionDenied
                    }
                    let inventory = committed.snapshot.inventory
                    try await auditCommittedIntent(inventory)
                    guard let displayID = (inventory.displays.first(where: \.isPrimary) ?? inventory.displays.first)?.id else {
                        throw WorkspaceRequestError.displayRequired
                    }
                    let update = lifecycle.reconcile(inventory)
                    try await applyLifecycleUpdate(update, displayID: displayID)
                    try await reconcileExternalFocus(
                        windowID: committed.snapshot.focusedWindowID, frontmostPID: nil, inventory: inventory,
                        allowWhilePaused: true
                    )
                    _ = daemonLifecycle.resume()
                    await transactions.endRecovery(success: true)
                    result = .object(["paused": .bool(false), "reconciled": .bool(true)])
                } catch {
                    await transactions.endRecovery(success: false, failure: .init(code: .notReady, message: "resume reconciliation failed", retryable: true))
                    throw error
                }
            case .transactionGet:
                guard case .string(let id)? = request.params["transaction_id"] else { throw WorkspaceRequestError.transactionRequired }
                result = json(try await transactions.status(id))
            case .commandBatch:
                let batch = try decodeParams(BatchRequest.self, from: .object(request.params))
                guard !batch.commands.isEmpty, batch.commands.count <= 64,
                      batch.commands.allSatisfy({ $0.method.isMutation && $0.method != .commandBatch }) else {
                    throw WorkspaceRequestError.invalidBatch
                }
                var values: [JSONValue] = [], stoppedAt: Int?
                for (index, command) in batch.commands.enumerated() {
                    let response = await routeDirect(.init(requestId: request.requestId, method: command.method, params: command.params))
                    guard case .response(let value) = response else { stoppedAt = index; break }
                    if let error = value.error {
                        values.append(.object(["ok": .bool(false), "error": json(error)])); stoppedAt = index; break
                    }
                    values.append(.object(["ok": .bool(true), "result": value.result ?? .null]))
                }
                result = json(BatchResult(results: values, stoppedAt: stoppedAt))
            case .workspaceList:
                result = workspaceList(await workspaces.snapshot())
            case .workspaceFocus:
                let params = try decodeParams(WorkspaceFocusParams.self, from: .object(request.params))
                let before = await workspaces.snapshot()
                let displayID = try resolveDisplay(params.displayId, inventory: snapshot.inventory, workspaceState: before)
                let mutation = try await workspaces.previewFocus(name: params.name, displayID: displayID)
                var reconciled = mutation
                reconciled.workspaceState = StartupIntentAudit.candidate(state: reconciled.workspaceState, inventory: snapshot.inventory)
                try await reconcileWorkspaceFocus(
                    before: before,
                    after: &reconciled.workspaceState,
                    name: params.name,
                    inventory: snapshot.inventory
                )
                try await workspaces.commitFocus(reconciled)
                await publishWorkspaceMutation(reconciled, before: before, reason: .workspaceFocused)
                result = workspaceMutation(reconciled)
            case .workspaceMoveWindow:
                let params = try decodeParams(WorkspaceMoveWindowParams.self, from: .object(request.params))
                if params.windowIds.isEmpty { committed = try await state.refresh() }
                let currentSnapshot = committed.snapshot
                var ids = params.windowIds
                if ids.isEmpty, let focused = currentSnapshot.focusedWindowID { ids = [focused] }
                guard !ids.isEmpty else { throw WorkspaceRequestError.windowRequired }
                try validateWindows(ids, inventory: currentSnapshot.inventory)
                let before = await workspaces.snapshot()
                let liveDisplayID = ids.compactMap { id in currentSnapshot.inventory.windows.first { $0.id == id }?.displayID }.first
                var mutation = try await workspaces.previewMoveWindows(ids, to: params.workspace, displayID: liveDisplayID)
                try await reconcileWorkspaceFocus(before: before, after: &mutation.workspaceState, name: params.workspace, inventory: currentSnapshot.inventory)
                try await workspaces.commitFocus(mutation)
                await publishWorkspaceMutation(mutation, before: before, reason: .workspaceFocused)
                result = workspaceMutation(mutation)
            case .workspaceMoveWindowBulk:
                let params = try decodeParams(WorkspaceMoveWindowParams.self, from: .object(request.params))
                let ids = Array(Set(params.windowIds)).sorted()
                guard !ids.isEmpty, ids.count <= 128, ids.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 256 }) else {
                    throw WorkspaceRequestError.invalidBulk
                }
                try validateWindows(ids, inventory: snapshot.inventory)
                let before = await workspaces.snapshot()
                let windowsByID = Dictionary(uniqueKeysWithValues: snapshot.inventory.windows.map { ($0.id, $0) })
                let displayID = ids.compactMap { windowsByID[$0]?.displayID }.first
                let mutation = try await workspaces.previewMoveWindows(ids, to: params.workspace, displayID: displayID)
                try await workspaces.commitFocus(mutation)
                var failures: [BulkItemFailure] = []
                do {
                    var reconciled = mutation.workspaceState
                    try await reconcileWorkspaceFocus(before: before, after: &reconciled, name: params.workspace, inventory: snapshot.inventory)
                } catch let failure as WindowGeometryFailure {
                    let itemFailure = TransactionFailure(
                        code: ErrorCode(rawValue: failure.code.rawValue) ?? .internalError,
                        message: failure.message, retryable: failure.code == .inventoryStale
                    )
                    failures = ids.map { .init(windowId: $0, failure: itemFailure) }
                } catch {
                    failures = ids.map { .init(windowId: $0, failure: .init(code: .internalError, message: "window operation failed", retryable: true)) }
                }
                await publishWorkspaceMutation(mutation, before: before, reason: .workspaceFocused)
                result = json(BulkTransactionResult(windowIds: ids, failures: failures))
            case .workspaceMoveDisplay:
                let params = try decodeParams(WorkspaceMoveDisplayParams.self, from: .object(request.params))
                _ = try resolveDisplay(params.displayId, inventory: snapshot.inventory, workspaceState: await workspaces.snapshot())
                let before = await workspaces.snapshot()
                var mutation = try await workspaces.previewMoveWorkspace(params.workspace, to: params.displayId)
                try await reconcileWorkspaceFocus(before: before, after: &mutation.workspaceState, name: params.workspace, inventory: snapshot.inventory)
                try await workspaces.commitFocus(mutation)
                await publishWorkspaceMutation(mutation, before: before, reason: .workspaceDisplayChanged)
                result = workspaceMutation(mutation)
            case .workspaceSetMode:
                let params = try decodeParams(WorkspaceSetModeParams.self, from: .object(request.params))
                let mode: WMWorkspace.WorkspaceMode = params.mode == .bsp ? .bsp : .floating
                let before = await workspaces.snapshot()
                var mutation = try await workspaces.previewSetMode(params.workspace, mode: mode)
                if mutation.workspaceState.focusedWorkspaceName == params.workspace {
                    try await reconcileWorkspaceFocus(before: before, after: &mutation.workspaceState, name: params.workspace, inventory: snapshot.inventory)
                }
                try await workspaces.commitFocus(mutation)
                await publishWorkspaceMutation(mutation, before: before, reason: .workspaceModeChanged)
                result = workspaceMutation(mutation)
            }
            return .response(.init(requestId: request.requestId, result: result, stateVersion: committed.stateVersion))
        } catch let failure as WindowGeometryFailure {
            return .response(.init(
                requestId: request.requestId,
                error: .init(
                    code: ErrorCode(rawValue: failure.code.rawValue) ?? .internalError,
                    message: failure.message,
                    retryable: failure.code == .inventoryStale,
                    details: failure.observedFrame.map { ["observed_frame": json($0)] } ?? [:]
                ),
                stateVersion: await currentVersion()
            ))
        } catch let error as WorkspaceMutationError {
            return .response(.init(requestId: request.requestId, error: workspaceError(error), stateVersion: await currentVersion()))
        } catch let error as WorkspaceRequestError {
            return .response(.init(requestId: request.requestId, error: .init(code: error.code, message: error.message, retryable: false), stateVersion: await currentVersion()))
        } catch DaemonLifecycleError.paused {
            return .response(.init(requestId: request.requestId, error: .init(code: .paused, message: "daemon is paused", retryable: true), stateVersion: await currentVersion()))
        } catch DaemonLifecycleError.terminating {
            return .response(.init(requestId: request.requestId, error: .init(code: .notReady, message: "daemon is terminating", retryable: false), stateVersion: await currentVersion()))
        } catch DaemonLifecycleRequestError.permissionDenied {
            return .response(.init(requestId: request.requestId, error: .init(code: .permissionDenied, message: "required permissions are unavailable", retryable: true), stateVersion: await currentVersion()))
        } catch {
            return .response(.init(requestId: request.requestId, error: .init(code: .inventoryFailed, message: String(describing: error), retryable: true), stateVersion: await currentVersion()))
        }
    }

    private func userState(_ committed: CommittedState<PrototypeSnapshot>) -> JSONValue {
        .object([
            "state_version": .number(Double(committed.stateVersion)),
            "sequence": .number(Double(committed.sequence)),
            "health": json(protocolHealth(committed.snapshot.health)),
            "focused_window_id": committed.snapshot.focusedWindowID.map(JSONValue.string) ?? .null,
            "displays": json(committed.snapshot.inventory.displays),
            "windows": json(committed.snapshot.inventory.windows),
        ])
    }

    private func subscriptionMessage(_ message: SubscriptionMessage<PrototypeSnapshot>, id: String) -> ServerMessage {
        switch message {
        case .resync(let value):
            return .resyncRequired(.init(subscriptionId: id, requestedAfterSequence: value.requestedAfterSequence, oldestAvailableSequence: value.oldestAvailableSequence ?? value.currentSequence, currentSequence: value.currentSequence, stateVersion: value.stateVersion))
        case .event(let projected):
            switch projected {
            case .delta(let event): return eventMessage(event)
            case .snapshot(let topic, let state): return .event(.init(sequence: state.sequence, stateVersion: state.stateVersion, timestamp: state.committedAt, topic: EventTopic(rawValue: topic.rawValue)!, data: json(state.snapshot)))
            case .invalidation(let topic, let sequence, let version): return .event(.init(sequence: sequence, stateVersion: version, timestamp: Date(), topic: EventTopic(rawValue: topic.rawValue)!, data: .object(["topic": .string(topic.rawValue), "state_version": .number(Double(version))])))
            }
        }
    }

    private func eventMessage(_ event: InventoryEvent<PrototypeSnapshot>) -> ServerMessage {
        let data: JSONValue
        switch event.data {
        case .windows(let delta): data = json(WindowDeltaPayload(added: delta.added.map(\.value), updated: delta.updated.map(\.value), removed: delta.removed.map(\.id)))
        case .displays(let delta): data = json(DisplayDeltaPayload(added: delta.added.map(\.value), updated: delta.updated.map(\.value), removed: delta.removed.map(\.id)))
        case .health(let health): data = json(protocolHealth(health))
        case .refreshed: data = .object([:])
        }
        return .event(.init(sequence: event.sequence, stateVersion: event.stateVersion, timestamp: event.timestamp, topic: EventTopic(rawValue: event.topic.rawValue)!, data: data))
    }

    func publishStateSnapshot() async {
        guard stateSnapshotSubscriptions.values.contains(where: { !$0.isEmpty }) else { return }
        for (clientID, subscriptions) in stateSnapshotSubscriptions {
            for detail in Set(subscriptions.values) {
                sender?(await stateSnapshotEvent(detail: detail), clientID)
            }
        }
    }

    private func stateSnapshotEvent(detail: SnapshotDetail) async -> String {
        let committed = try? await state.state()
        return encode(.event(.init(
            sequence: committed?.sequence ?? workspaceSequence,
            stateVersion: committed?.stateVersion ?? 0,
            timestamp: Date(),
            topic: .stateSnapshot,
            data: await stateSnapshot(committed, detail: detail)
        )))
    }

    private func stateSnapshot(
        _ committed: CommittedState<PrototypeSnapshot>?, detail: SnapshotDetail
    ) async -> JSONValue {
        guard let committed else { return .object(["displays": .array([]), "health": .null]) }
        let inventory = committed.snapshot.inventory
        let workspaceState = await workspaces.snapshot()
        let windows = Dictionary(uniqueKeysWithValues: inventory.windows.map { ($0.id, $0) })
        let displays = inventory.displays.map { display -> JSONValue in
            let workspaces = workspaceState.workspaces
                .filter { $0.displayID == display.id }
                .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            var result: [String: JSONValue] = [
                "id": .string(display.id),
                "name": .string(display.name),
                "identifiers": json(display.identifiers),
                "health": healthyState,
                "workspaces": .array(workspaces.map { workspaceSnapshot($0, windows: windows, detail: detail) }),
            ]
            if detail == .verbose { result["details"] = json(display) }
            return .object(result)
        }
        return .object([
            "session_id": .string(sessionID),
            "state_version": .number(Double(committed.stateVersion)),
            "sequence": .number(Double(committed.sequence)),
            "focused_workspace_name": workspaceState.focusedWorkspaceName.map(JSONValue.string) ?? .null,
            "health": json(protocolHealth(committed.snapshot.health)),
            "displays": .array(displays),
        ])
    }

    private func workspaceSnapshot(
        _ workspace: WMWorkspace.Workspace,
        windows: [String: NormalizedWindow],
        detail: SnapshotDetail
    ) -> JSONValue {
        var result: [String: JSONValue] = [
            "name": .string(workspace.name),
            "focused": .bool(workspace.focused),
            "visible": .bool(workspace.visible),
            "health": healthyState,
            "windows": .array(workspace.windowIDs.map { windowSnapshot(
                id: $0, window: windows[$0] ?? sessionWindows[$0], focused: workspace.focusedWindowID == $0,
                detail: detail
            ) }),
        ]
        if detail == .verbose { result["details"] = workspaceJSON(workspace) }
        return .object(result)
    }

    private func windowSnapshot(
        id: String, window: NormalizedWindow?, focused: Bool, detail: SnapshotDetail
    ) -> JSONValue {
        guard let window else {
            return .object([
                "id": .string(id), "exe": .null, "app_name": .null, "focused": .bool(focused),
                "health": .object(["status": .string("unhealthy"), "issues": .array([.string("window is not currently observed")])]),
            ])
        }
        var result: [String: JSONValue] = [
            "id": .string(id),
            "exe": window.executablePath.map(JSONValue.string) ?? .null,
            "app_name": .string(window.appName),
            "focused": .bool(focused),
            "health": .object([
                "status": .string(window.health.rawValue),
                "issues": .array(window.healthIssues.map(JSONValue.string)),
            ]),
        ]
        if detail == .verbose { result["details"] = json(window) }
        return .object(result)
    }

    private var healthyState: JSONValue {
        .object(["status": .string("healthy"), "issues": .array([])])
    }

    private func protocolHealth(_ value: InventoryHealth) -> Health {
        Health(status: HealthStatus(rawValue: value.status.rawValue)!, issues: value.issues, capabilities: .init(accessibility: value.capabilities["accessibility"] as? Bool ?? false, screenRecording: value.capabilities["core_graphics"] as? Bool ?? false, windowInventory: true, pointerWarp: nil))
    }

    private func currentVersion() async -> UInt64 { (try? await state.state().stateVersion) ?? 0 }
    private func key(_ client: UUID, _ id: String) -> String { "\(client.uuidString):\(id)" }
    private func errorResponse(_ id: String, _ code: ErrorCode, _ message: String) async -> String { encode(.response(.init(requestId: id, error: .init(code: code, message: message, retryable: false), stateVersion: await currentVersion()))) }
    private func encode(_ message: ServerMessage) -> String { String(data: (try? ProtocolCodec.encode(message)) ?? Data(), encoding: .utf8) ?? "{}" }
    private func json<T: Encodable>(_ value: T) -> JSONValue { (try? ProtocolCodec.decode(JSONValue.self, from: ProtocolCodec.encode(value))) ?? .null }
    private func returnMode(_ value: JSONValue?) throws -> TransactionReturnMode {
        guard let value else { return .completion }
        guard case .string(let raw) = value, let mode = TransactionReturnMode(rawValue: raw) else {
            throw WorkspaceRequestError.invalidReturnMode
        }
        return mode
    }
    private func mutationBarrier() -> TransactionFailure? {
        do { try daemonLifecycle.requireMutationAllowed(); return nil }
        catch DaemonLifecycleError.paused { return .init(code: .paused, message: "daemon is paused", retryable: true) }
        catch { return .init(code: .notReady, message: "daemon is terminating") }
    }
    private func fullReconciliation() async throws {
        let committed = try await state.refresh()
        try await auditCommittedIntent(committed.snapshot.inventory)
    }
    private func submitInternal(
        name: String, idempotencyKey: String? = nil, operation: @escaping @Sendable () async throws -> Void
    ) async throws -> TransactionReceipt<JSONValue> {
        try await transactions.submit(.init(
            name: name, idempotencyKey: idempotencyKey, authorize: { [weak self] in await self?.mutationBarrier() },
            operate: { [weak self] in
                try await operation()
                return .init(result: .object([:]), committedStateVersion: await self?.currentVersion() ?? 0)
            }, escalate: { [weak self] in try await self?.fullReconciliation() },
            reportInternalError: { [weak self] error in await self?.reportInternalTransactionError(name: name, error: error) }
        ))
    }
    private func reportInternalTransactionError(name: String, error: String) {
        internalErrorReporter?("internal transaction \(name) failed: \(String(error.prefix(512)))")
    }
    private func canonicalKey(_ request: Request) -> String {
        "\(request.method.rawValue):\(JSONValue.object(request.params.filter { $0.key != "return_mode" }).canonicalForm)"
    }
    private func requestID(in data: Data?) -> String? { data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["request_id"] as? String }

    private func decodeParams<T: Decodable>(_ type: T.Type, from value: JSONValue) throws -> T {
        try ProtocolCodec.decode(type, from: ProtocolCodec.encode(value))
    }

    private func resolveWindow(_ id: String, in windows: [NormalizedWindow]) throws -> NormalizedWindow {
        guard let window = windows.first(where: { $0.id == id }) ?? sessionWindows[id] else {
            throw WindowGeometryFailure(code: .windowNotFound, message: "unknown window: \(id)")
        }
        return window
    }

    private func retainSessionWindows(_ windows: [NormalizedWindow]) {
        for window in windows where window.classification == .normal {
            sessionWindows[window.id] = window
        }
    }

    private func observeWindows(
        params: [String: JSONValue],
        inventory: InventorySnapshot,
        workspaceState: WMWorkspace.WorkspaceState
    ) -> JSONValue {
        let liveByID = Dictionary(uniqueKeysWithValues: inventory.windows.map { ($0.id, $0) })
        let ids = Set(liveByID.keys).union(sessionWindows.keys).sorted()
        let reports = ids.compactMap { id -> JSONValue? in
            let observed = liveByID[id]
            let expected = sessionWindows[id]
            guard matchesObserveFilter(params, id: id, window: observed ?? expected) else { return nil }
            let workspace = workspaceState.workspaces.first { $0.windowIDs.contains(id) }
            let parked = workspaceState.parkedWindowFrames[id]
            return .object([
                "window_id": .string(id),
                "observed": observed.map(json) ?? .null,
                "expected": expected.map(json) ?? .null,
                "workspace": workspace.map { .string($0.name) } ?? .null,
                "workspace_visible": workspace.map { .bool($0.visible) } ?? .null,
                "expected_parked": .bool(parked != nil),
                "restore_frame": parked.map(json) ?? .null,
                "session_retained": .bool(expected != nil),
            ])
        }
        return .object([
            "focused_window_id": inventory.windows.first(where: { $0.focused == true }).map { .string($0.id) } ?? .null,
            "focused_workspace_name": workspaceState.focusedWorkspaceName.map(JSONValue.string) ?? .null,
            "last_transition": lastTransitionTrace,
            "windows": .array(reports),
        ])
    }

    private func matchesObserveFilter(_ params: [String: JSONValue], id: String, window: NormalizedWindow?) -> Bool {
        guard let window else { return false }
        if case .number(let pid)? = params["pid"], window.pid != Int32(pid) { return false }
        if case .string(let value)? = params["window_id"], id != value { return false }
        if case .string(let value)? = params["app"], !window.appName.localizedCaseInsensitiveContains(value) { return false }
        if case .string(let value)? = params["exe"], !(window.executablePath ?? "").localizedCaseInsensitiveContains(value) { return false }
        return true
    }

    private func observeWorkspace(
        named name: String,
        inventory: InventorySnapshot,
        workspaceState: WMWorkspace.WorkspaceState
    ) throws -> JSONValue {
        guard let workspace = workspaceState.workspaces.first(where: { $0.name == name }) else {
            throw WorkspaceMutationError.workspaceNotFound(name)
        }
        let liveByID = Dictionary(uniqueKeysWithValues: inventory.windows.map { ($0.id, $0) })
        return .object([
            "workspace": workspaceJSON(workspace),
            "windows": .array(workspace.windowIDs.map { id in
                .object([
                    "window_id": .string(id),
                    "observed": liveByID[id].map(json) ?? .null,
                    "expected": sessionWindows[id].map(json) ?? .null,
                    "restore_frame": workspaceState.parkedWindowFrames[id].map(json) ?? .null,
                    "session_retained": .bool(sessionWindows[id] != nil),
                ])
            }),
        ])
    }

    private func resolveDisplay(
        _ requested: String?, inventory: InventorySnapshot, workspaceState: WMWorkspace.WorkspaceState
    ) throws -> String {
        if let requested {
            guard inventory.displays.contains(where: { $0.id == requested }) else { throw WorkspaceRequestError.displayNotFound(requested) }
            return requested
        }
        if let focused = workspaceState.focusedWorkspaceName,
           let display = workspaceState.workspaces.first(where: { $0.name == focused })?.displayID {
            return display
        }
        if let focusedWindow = inventory.windows.first(where: { $0.focused == true }), let display = focusedWindow.displayID {
            return display
        }
        guard let display = inventory.displays.first(where: { $0.isPrimary }) ?? inventory.displays.first else {
            throw WorkspaceRequestError.displayRequired
        }
        return display.id
    }

    private func validateWindows(_ ids: [String], inventory: InventorySnapshot) throws {
        let known = Set(inventory.windows.map(\.id))
        if let missing = ids.first(where: { !known.contains($0) }) { throw WorkspaceRequestError.windowNotFound(missing) }
    }

    private func focusWorkspaceWindow(
        _ state: WMWorkspace.WorkspaceState,
        named name: String,
        inventory: InventorySnapshot
    ) async throws {
        guard let workspace = state.workspaces.first(where: { $0.name == name }) else { return }
        let ids = Self.focusCandidateIDs(workspace: workspace, inventory: inventory)
        guard !ids.isEmpty else { return }
        var lastFailure: WindowGeometryFailure?
        for id in ids {
            do {
                try await geometry.focus(window: resolveWindow(id, in: inventory.windows))
                return
            } catch let failure as WindowGeometryFailure {
                lastFailure = failure
            }
        }
        throw lastFailure ?? WindowGeometryFailure(code: .windowNotFound, message: "workspace has no observed windows")
    }

    private func reconcileWorkspaceFocus(
        before: WMWorkspace.WorkspaceState,
        after: inout WMWorkspace.WorkspaceState,
        name: String,
        inventory: InventorySnapshot,
        tolerateGeometryClamp: Bool = false
    ) async throws {
        let transition = WorkspaceTransitionPlan(before: before, after: after, destination: name)
        let incomingIDs = transition.incomingWindowIDs
        let outgoingIDs = transition.outgoingWindowIDs
        retainSessionWindows(inventory.windows)
        let windowsByID = sessionWindows
        let previousParkedFrames = after.parkedWindowFrames
        var restoredIDs: Set<String> = []
        var changed: [(NormalizedWindow, InventoryRect)] = []
        var parkingTrace: [JSONValue] = []
        lastTransitionTrace = .object([
            "destination": .string(name), "status": .string("running"),
            "incoming_window_ids": .array(incomingIDs.sorted().map(JSONValue.string)),
            "outgoing_window_ids": .array(outgoingIDs.sorted().map(JSONValue.string)),
        ])
        do {
            let displayFrames = axDisplayFrames(inventory.displays)
            let incomingDisplayID = after[workspace: name]?.displayID
            let incomingDisplay = incomingDisplayID.flatMap { displayFrames[$0] }
            let outgoingDisplayID = before.focusedWorkspaceName.flatMap { before[workspace: $0]?.displayID }
            let outgoingDisplay = inventory.displays.first { $0.id == outgoingDisplayID }
                ?? inventory.displays.first(where: \.isPrimary)
                ?? inventory.displays.first
            for id in outgoingIDs.sorted() {
                guard let window = windowsByID[id], let original = window.frame else { continue }
                guard let outgoingDisplay,
                      let outgoingFrame = displayFrames[outgoingDisplay.id],
                      let parking = WindowParkingPlan(
                        displayFrame: outgoingFrame,
                        otherDisplayFrames: displayFrames.filter { $0.key != outgoingDisplay.id }.map(\.value),
                        windowFrame: original
                      ) else {
                    throw WindowGeometryFailure(code: .geometryVerificationFailed, message: "no exposed display corner is available for parking")
                }
                changed.append((window, original))
                let observed = try await geometry.park(window: window, frame: parking.targetFrame)
                parkingTrace.append(.object([
                    "window_id": .string(id), "target": json(parking.targetFrame.protocolFrame),
                    "observed": json(observed.protocolFrame), "accepted": .bool(parking.accepts(observed)),
                ]))
                guard parking.accepts(observed) else {
                    throw WindowGeometryFailure(
                        code: .geometryVerificationFailed,
                        message: "window did not reach the parking corner",
                        observedFrame: observed.protocolFrame
                    )
                }
                after.parkedWindowFrames[id] = .init(original)
            }
            let incomingIsBSP = after[workspace: name]?.mode == .bsp
            for id in incomingIDs where !incomingIsBSP {
                guard let window = windowsByID[id], let restore = after.parkedWindowFrames[id], let current = window.frame else { continue }
                let saved = restore.inventoryRect
                let target = isCenteredOnDisplay(saved, displays: Array(displayFrames.values)) ? saved : incomingDisplay ?? saved
                do {
                    _ = try await geometry.set(window: window, params: frameParams(id, target))
                } catch let failure as WindowGeometryFailure {
                    guard failure.code == .geometryVerificationFailed,
                          let incomingDisplay,
                          target != incomingDisplay else { throw failure }
                    _ = try await geometry.set(window: window, params: frameParams(id, incomingDisplay))
                }
                changed.append((window, current))
                restoredIDs.insert(id)
            }
            if tolerateGeometryClamp {
                await tileWorkspaceForObserver(
                    after, named: name, inventory: inventory,
                    forceStack: incomingIsBSP && !incomingIDs.isDisjoint(with: after.parkedWindowFrames.keys)
                )
            } else {
                try await tileWorkspace(after, named: name, inventory: inventory, forceStack: incomingIsBSP && !incomingIDs.isDisjoint(with: after.parkedWindowFrames.keys))
            }
            try await focusWorkspaceWindow(after, named: name, inventory: inventory)
            if incomingIsBSP { restoredIDs.formUnion(incomingIDs) }
            for id in restoredIDs { after.parkedWindowFrames.removeValue(forKey: id) }
            lastTransitionTrace = .object([
                "destination": .string(name), "status": .string("succeeded"),
                "incoming_window_ids": .array(incomingIDs.sorted().map(JSONValue.string)),
                "outgoing_window_ids": .array(outgoingIDs.sorted().map(JSONValue.string)),
                "parking": .array(parkingTrace),
            ])
        } catch {
            for (window, previousFrame) in changed.reversed() {
                _ = try? await geometry.set(window: window, params: frameParams(window.id, previousFrame))
            }
            after.parkedWindowFrames = previousParkedFrames
            lastTransitionTrace = .object([
                "destination": .string(name), "status": .string("rolled_back"),
                "incoming_window_ids": .array(incomingIDs.sorted().map(JSONValue.string)),
                "outgoing_window_ids": .array(outgoingIDs.sorted().map(JSONValue.string)),
                "parking": .array(parkingTrace), "error": .string(String(describing: error)),
            ])
            throw error
        }
    }

    private func frameParams(_ id: String, _ frame: InventoryRect) -> WindowFrameSetParams {
        .init(windowID: id, frame: .init(x: frame.x, y: frame.y, width: frame.width, height: frame.height))
    }

    private func tileWorkspace(
        _ state: WMWorkspace.WorkspaceState,
        named name: String,
        inventory: InventorySnapshot,
        forceStack: Bool = false
    ) async throws {
        guard let workspace = state.workspaces.first(where: { $0.name == name }),
              workspace.mode == .bsp,
              !workspace.windowIDs.isEmpty,
              let display = inventory.displays.first(where: { $0.id == workspace.displayID }) else { return }
        let bounds = WorkspaceLayoutRect(
            x: display.visibleFrame.x,
            y: display.frame.y + display.frame.height - display.visibleFrame.y - display.visibleFrame.height,
            width: display.visibleFrame.width,
            height: display.visibleFrame.height
        )
        var targets = workspace.layout(in: bounds, minimumSizes: windowMinimumSizes)
        let windows = try workspace.windowIDs.map { try resolveWindow($0, in: inventory.windows) }
        if forceStack || !workspace.canFit(in: bounds, minimumSizes: windowMinimumSizes) {
            let fallback = WorkspaceLayoutRect(
                x: bounds.x + workspace.margin.left,
                y: bounds.y + workspace.margin.top,
                width: max(0, bounds.width - workspace.margin.left - workspace.margin.right),
                height: max(0, bounds.height - workspace.margin.top - workspace.margin.bottom)
            )
            for window in windows { _ = try await geometry.set(window: window, params: layoutParams(window.id, fallback)) }
            return
        }
        let originals = Dictionary(uniqueKeysWithValues: windows.compactMap { window in window.frame.map { (window.id, $0) } })
        var moved: [NormalizedWindow] = []
        do {
            for window in windows {
                guard let target = targets[window.id], target.width > 0, target.height > 0 else { continue }
                do {
                    _ = try await geometry.set(window: window, params: layoutParams(window.id, target))
                    moved.append(window)
                } catch let failure as WindowGeometryFailure {
                    guard failure.code == .geometryVerificationFailed,
                          let observed = failure.observedFrame,
                          observed.width >= target.width,
                          observed.height >= target.height else { throw failure }
                    windowMinimumSizes[window.id] = .init(width: observed.width, height: observed.height)
                    targets = workspace.layout(in: bounds, minimumSizes: windowMinimumSizes)
                    for changed in moved.reversed() {
                        guard let original = originals[changed.id] else { continue }
                        _ = try? await geometry.set(window: changed, params: frameParams(changed.id, original))
                    }
                    moved.removeAll()
                    for retryWindow in windows {
                        guard let retryTarget = targets[retryWindow.id], retryTarget.width > 0, retryTarget.height > 0 else { continue }
                        _ = try await geometry.set(window: retryWindow, params: layoutParams(retryWindow.id, retryTarget))
                        moved.append(retryWindow)
                    }
                    break
                }
            }
        } catch {
            for window in moved.reversed() {
                guard let original = originals[window.id] else { continue }
                _ = try? await geometry.set(window: window, params: .init(
                    windowID: window.id,
                    frame: .init(x: original.x, y: original.y, width: original.width, height: original.height)
                ))
            }
            throw error
        }
    }

    private func tileWorkspaceForObserver(
        _ state: WMWorkspace.WorkspaceState, named name: String, inventory: InventorySnapshot, forceStack: Bool
    ) async {
        guard let workspace = state[workspace: name], workspace.mode == .bsp,
              let display = inventory.displays.first(where: { $0.id == workspace.displayID }) else { return }
        let bounds = WorkspaceLayoutRect(
            x: display.visibleFrame.x,
            y: display.frame.y + display.frame.height - display.visibleFrame.y - display.visibleFrame.height,
            width: display.visibleFrame.width, height: display.visibleFrame.height
        )
        let fallback = WorkspaceLayoutRect(
            x: bounds.x + workspace.margin.left, y: bounds.y + workspace.margin.top,
            width: max(0, bounds.width - workspace.margin.left - workspace.margin.right),
            height: max(0, bounds.height - workspace.margin.top - workspace.margin.bottom)
        )
        let targets = forceStack || !workspace.canFit(in: bounds, minimumSizes: windowMinimumSizes)
            ? Dictionary(uniqueKeysWithValues: workspace.windowIDs.map { ($0, fallback) })
            : workspace.layout(in: bounds, minimumSizes: windowMinimumSizes)
        for id in workspace.windowIDs {
            guard let target = targets[id], target.width > 0, target.height > 0,
                  observerGeometryReliability.shouldAttempt(
                    windowID: id, requestedWidth: target.width, requestedHeight: target.height
                  ),
                  let window = try? resolveWindow(id, in: inventory.windows) else { continue }
            do {
                _ = try await geometry.set(window: window, params: layoutParams(id, target))
                observerGeometryReliability.clear(windowID: id)
            } catch let failure as WindowGeometryFailure {
                guard failure.code == .geometryVerificationFailed, let observed = failure.observedFrame else {
                    reportInternalTransactionError(name: "observer.geometry", error: String(describing: failure)); continue
                }
                let clamp = ObserverGeometryReliability.Clamp(
                    requestedWidth: target.width, requestedHeight: target.height,
                    observedWidth: observed.width, observedHeight: observed.height
                )
                if observerGeometryReliability.record(windowID: id, clamp: clamp) {
                    windowMinimumSizes[id] = .init(width: observed.width, height: observed.height)
                    reportInternalTransactionError(
                        name: "observer.geometry",
                        error: "window \(id) clamped requested \(target.width)x\(target.height) to \(observed.width)x\(observed.height)"
                    )
                }
            } catch {
                reportInternalTransactionError(name: "observer.geometry", error: String(describing: error))
            }
        }
    }

    private func layoutParams(_ id: String, _ frame: WorkspaceLayoutRect) -> WindowFrameSetParams {
        .init(windowID: id, frame: .init(x: frame.x, y: frame.y, width: frame.width, height: frame.height), attempts: 4)
    }

    private func restoreParkedWindows(
        _ committed: WMWorkspace.WorkspaceState, inventory: InventorySnapshot, all: Bool
    ) async throws {
        retainSessionWindows(inventory.windows)
        for workspace in committed.workspaces where all || workspace.visible {
            for id in workspace.windowIDs {
                guard let restore = committed.parkedWindowFrames[id], let window = sessionWindows[id] else { continue }
                _ = try await geometry.set(window: window, params: frameParams(id, restore.inventoryRect))
            }
        }
    }

    private func parkCommittedWindow(
        _ id: String, state: WMWorkspace.WorkspaceState, inventory: InventorySnapshot
    ) async throws {
        guard let window = sessionWindows[id], let original = window.frame,
              let workspaceName = state.workspaceName(containing: id),
              let displayID = state[workspace: workspaceName]?.displayID,
              let display = inventory.displays.first(where: { $0.id == displayID }),
              let displayFrame = axDisplayFrames(inventory.displays)[display.id],
              let plan = WindowParkingPlan(
                displayFrame: displayFrame,
                otherDisplayFrames: axDisplayFrames(inventory.displays).filter { $0.key != display.id }.map(\.value),
                windowFrame: original
              ) else { throw WindowGeometryFailure(code: .geometryVerificationFailed, message: "cannot plan committed parking for \(id)") }
        let observed = try await geometry.park(window: window, frame: plan.targetFrame)
        guard plan.accepts(observed) else {
            throw WindowGeometryFailure(code: .geometryVerificationFailed, message: "committed hidden window did not park", observedFrame: observed.protocolFrame)
        }
    }


    private func workspaceList(_ state: WMWorkspace.WorkspaceState) -> JSONValue {
        .object([
            "workspaces": .array(state.workspaces.map(workspaceJSON)),
            "focused_workspace_name": state.focusedWorkspaceName.map(JSONValue.string) ?? .null,
        ])
    }

    private func workspaceMutation(_ result: WMWorkspace.WorkspaceMutationResult) -> JSONValue {
        .object([
            "workspace_state": workspaceList(result.workspaceState),
            "modified_workspaces": .array(result.modifiedWorkspaces.map(JSONValue.string)),
            "deleted_workspaces": .array(result.deletedWorkspaces.map(JSONValue.string)),
            "effect_status": .string("verified"),
            "split_decision": result.splitDecision.map { .string($0.rawValue) } ?? .null,
        ])
    }

    private func workspaceJSON(_ workspace: WMWorkspace.Workspace) -> JSONValue {
        json(workspace)
    }

    private func publishWorkspaceMutation(
        _ result: WMWorkspace.WorkspaceMutationResult,
        before: WMWorkspace.WorkspaceState,
        reason: EventTopic
    ) async {
        guard result.workspaceState != before else { return }
        let previousNames = Set(before.workspaces.map(\.name))
        let currentNames = Set(result.workspaceState.workspaces.map(\.name))
        var topics: Set<EventTopic> = [.workspaceChanged, reason]
        if !currentNames.subtracting(previousNames).isEmpty { topics.insert(.workspaceCreated) }
        if !previousNames.subtracting(currentNames).isEmpty { topics.insert(.workspaceDeleted) }
        workspaceSequence += 1
        let eventData = workspaceMutation(result)
        let version = await currentVersion()
        for (clientID, clientSubscriptions) in workspaceSubscriptions {
            for subscription in clientSubscriptions.values {
                for topic in topics.intersection(subscription.topics) {
                    sender?(encode(.event(.init(
                        sequence: workspaceSequence,
                        stateVersion: version,
                        timestamp: Date(),
                        topic: topic,
                        data: subscription.projection == .invalidation
                            ? .object(["topic": .string(topic.rawValue), "state_version": .number(Double(version))])
                            : eventData
                    ))), clientID)
                }
            }
        }
        await publishStateSnapshot()
    }

    private func workspaceSnapshotEvent(topic: EventTopic) async -> String {
        let version = await currentVersion()
        return encode(.event(.init(
            sequence: workspaceSequence,
            stateVersion: version,
            timestamp: Date(),
            topic: topic,
            data: workspaceList(await workspaces.snapshot())
        )))
    }

    private func workspaceError(_ error: WorkspaceMutationError) -> ProtocolError {
        switch error {
        case .workspaceNotFound(let name): .init(code: .workspaceNotFound, message: "unknown workspace: \(name)", retryable: false)
        case .displayRequired(let name): .init(code: .invalidParams, message: "display required to create workspace: \(name)", retryable: false)
        case .windowNotFound(let id): .init(code: .windowNotFound, message: "window is not assigned to a workspace: \(id)", retryable: false)
        case .windowAlreadyInDestination(let id, let workspace): .init(code: .workspaceConflict, message: "window \(id) is already in workspace \(workspace)", retryable: false)
        case .duplicateWindowSelection(let id): .init(code: .invalidParams, message: "duplicate window selection: \(id)", retryable: false)
        case .invalidState(let issues): .init(code: .invalidWorkspaceState, message: "workspace invariant violation", retryable: false, details: ["issues": .array(issues.map { .string(String(describing: $0)) })])
        }
    }
}

private enum WorkspaceRequestError: Error {
    case displayRequired
    case displayNotFound(String)
    case windowRequired
    case windowNotFound(String)
    case transactionRequired
    case invalidReturnMode
    case invalidBatch
    case invalidBulk

    var code: ErrorCode {
        switch self {
        case .displayRequired: .invalidParams
        case .displayNotFound: .displayNotFound
        case .windowRequired: .windowNotFound
        case .windowNotFound: .windowNotFound
        case .transactionRequired: .invalidParams
        case .invalidReturnMode: .invalidParams
        case .invalidBatch, .invalidBulk: .invalidParams
        }
    }

    var message: String {
        switch self {
        case .displayRequired: "no display is available for workspace creation"
        case .displayNotFound(let id): "unknown display: \(id)"
        case .windowRequired: "no focused window is available"
        case .windowNotFound(let id): "unknown window: \(id)"
        case .transactionRequired: "transaction_id is required"
        case .invalidReturnMode: "return_mode must be completion or instant"
        case .invalidBatch: "batch requires 1...64 mutation commands"
        case .invalidBulk: "bulk requires 1...128 valid window IDs"
        }
    }
}

private enum DaemonLifecycleRequestError: Error { case permissionDenied }

private extension WMProtocol.Method {
    var isMutation: Bool {
        switch self {
        case .windowManage, .windowUnmanage, .windowFrameSet, .workspaceFocus, .workspaceMoveWindow,
             .workspaceMoveWindowBulk, .workspaceMoveDisplay, .workspaceSetMode, .inventoryRefresh,
             .commandBatch, .daemonPause, .daemonResume: true
        default: false
        }
    }

    var isIdempotent: Bool {
        switch self {
        case .windowManage, .windowUnmanage, .windowFrameSet, .workspaceFocus, .workspaceMoveDisplay,
             .workspaceSetMode, .inventoryRefresh: true
        default: false
        }
    }
}

private struct WindowDeltaPayload: Encodable { var added: [NormalizedWindow]; var updated: [NormalizedWindow]; var removed: [String] }
private struct DisplayDeltaPayload: Encodable { var added: [DisplayObservation]; var updated: [DisplayObservation]; var removed: [String] }

private extension ParkedWindowFrame {
    init(_ frame: InventoryRect) {
        self.init(x: frame.x, y: frame.y, width: frame.width, height: frame.height)
    }

    var inventoryRect: InventoryRect {
        .init(x: x, y: y, width: width, height: height)
    }
}

private extension EventTopic {
    var isDaemonEvent: Bool {
        switch self {
        case .workspaceChanged, .workspaceFocused, .workspaceCreated, .workspaceDeleted,
             .workspaceDisplayChanged, .workspaceModeChanged, .daemonPaused, .daemonResumed,
             .sessionResynchronized: true
        default: false
        }
    }
}
