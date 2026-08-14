import Foundation
import WMCore
import WMInventory
import WMProtocol
import WMWebSocket
import WMWorkspace

actor DaemonHandler: WebSocketRequestHandler {
    typealias State = InventoryState<SystemInventoryProvider>

    private let state: State
    private let router: RequestRouter<SystemInventoryProvider>
    private let geometry = WindowGeometryService(adapter: AXWindowGeometryAdapter())
    private let workspaces: WorkspaceController
    private let sessionID = UUID().uuidString
    private let version = "0.0.1-dev"
    private var subscriptions: [UUID: [String: Task<Void, Never>]] = [:]
    private var workspaceSubscriptions: [UUID: [String: Set<EventTopic>]] = [:]
    private var workspaceSequence: UInt64 = 0
    private var windowMinimumSizes: [String: WorkspaceMinimumSize] = [:]
    private var sender: (@Sendable (String, UUID) -> Void)?

    init(state: State, workspaces: WorkspaceController) {
        self.state = state
        self.workspaces = workspaces
        router = RequestRouter(inventory: state)
    }

    func installSender(_ sender: @escaping @Sendable (String, UUID) -> Void) { self.sender = sender }

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
    }

    private func subscribe(_ request: Subscribe, clientID: UUID) async -> [String] {
        let workspaceTopics = Set(request.topics.filter(\.isWorkspace))
        if !workspaceTopics.isEmpty {
            guard request.afterSequence == nil else {
                return [await errorResponse(request.requestId, .replayUnavailable, "workspace event replay is unavailable")]
            }
            workspaceSubscriptions[clientID, default: [:]][request.subscriptionId] = workspaceTopics
            return [encode(.response(.init(
                requestId: request.requestId,
                result: .object(["subscription_id": .string(request.subscriptionId)]),
                stateVersion: await currentVersion()
            )))]
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
        do {
            if request.method == .inventoryRefresh { _ = await router.route(.init(requestID: request.requestId, method: request.method.rawValue)) }
            var committed = try await state.state()
            let snapshot = committed.snapshot
            await geometry.reconcile(windows: snapshot.inventory.windows)
            let result: JSONValue
            switch request.method {
            case .stateGet: result = json(userState(committed))
            case .stateObserved: result = json(snapshot.inventory)
            case .healthGet: result = json(protocolHealth(snapshot.health))
            case .displayList: result = json(["displays": snapshot.inventory.displays])
            case .windowList: result = json(["windows": snapshot.inventory.windows])
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
                    let ids = inventory.windows.filter { $0.classification == .normal }.map(\.id)
                    _ = try await workspaces.reconcileObservedWindows(ids, displayID: displayID)
                }
                result = json(userState(committed))
            case .daemonPing: result = .object(["session_id": .string(sessionID), "daemon_version": .string(version), "ready": .bool(true), "current_sequence": .number(Double(committed.sequence)), "state_version": .number(Double(committed.stateVersion))])
            case .workspaceList:
                result = workspaceList(await workspaces.snapshot())
            case .workspaceFocus:
                let params = try decodeParams(WorkspaceFocusParams.self, from: .object(request.params))
                let before = await workspaces.snapshot()
                let displayID = try resolveDisplay(params.displayId, inventory: snapshot.inventory, workspaceState: before)
                let mutation = try await workspaces.previewFocus(name: params.name, displayID: displayID)
                var reconciled = mutation
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
                var ids = params.windowIds
                if ids.isEmpty, let focused = snapshot.focusedWindowID { ids = [focused] }
                guard !ids.isEmpty else { throw WorkspaceRequestError.windowRequired }
                try validateWindows(ids, inventory: snapshot.inventory)
                let before = await workspaces.snapshot()
                let mutation = try await workspaces.moveWindows(ids, to: params.workspace)
                await publishWorkspaceMutation(mutation, before: before, reason: .workspaceFocused)
                result = workspaceMutation(mutation)
            case .workspaceMoveDisplay:
                let params = try decodeParams(WorkspaceMoveDisplayParams.self, from: .object(request.params))
                _ = try resolveDisplay(params.displayId, inventory: snapshot.inventory, workspaceState: await workspaces.snapshot())
                let before = await workspaces.snapshot()
                let mutation = try await workspaces.moveWorkspace(params.workspace, to: params.displayId)
                await publishWorkspaceMutation(mutation, before: before, reason: .workspaceDisplayChanged)
                result = workspaceMutation(mutation)
            case .workspaceSetMode:
                let params = try decodeParams(WorkspaceSetModeParams.self, from: .object(request.params))
                let mode: WMWorkspace.WorkspaceMode = params.mode == .bsp ? .bsp : .floating
                let before = await workspaces.snapshot()
                let mutation = try await workspaces.setMode(params.workspace, mode: mode)
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

    private func protocolHealth(_ value: InventoryHealth) -> Health {
        Health(status: HealthStatus(rawValue: value.status.rawValue)!, issues: value.issues, capabilities: .init(accessibility: value.capabilities["accessibility"] as? Bool ?? false, screenRecording: value.capabilities["core_graphics"] as? Bool ?? false, windowInventory: true, pointerWarp: nil))
    }

    private func currentVersion() async -> UInt64 { (try? await state.state().stateVersion) ?? 0 }
    private func key(_ client: UUID, _ id: String) -> String { "\(client.uuidString):\(id)" }
    private func errorResponse(_ id: String, _ code: ErrorCode, _ message: String) async -> String { encode(.response(.init(requestId: id, error: .init(code: code, message: message, retryable: false), stateVersion: await currentVersion()))) }
    private func encode(_ message: ServerMessage) -> String { String(data: (try? ProtocolCodec.encode(message)) ?? Data(), encoding: .utf8) ?? "{}" }
    private func json<T: Encodable>(_ value: T) -> JSONValue { (try? ProtocolCodec.decode(JSONValue.self, from: ProtocolCodec.encode(value))) ?? .null }
    private func requestID(in data: Data?) -> String? { data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["request_id"] as? String }

    private func decodeParams<T: Decodable>(_ type: T.Type, from value: JSONValue) throws -> T {
        try ProtocolCodec.decode(type, from: ProtocolCodec.encode(value))
    }

    private func resolveWindow(_ id: String, in windows: [NormalizedWindow]) throws -> NormalizedWindow {
        guard let window = windows.first(where: { $0.id == id }) else {
            throw WindowGeometryFailure(code: .windowNotFound, message: "unknown window: \(id)")
        }
        return window
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
        let preferred = workspace.focusedWindowID.map { [$0] } ?? []
        let ids = preferred + workspace.windowIDs.reversed().filter { $0 != workspace.focusedWindowID }
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
        inventory: InventorySnapshot
    ) async throws {
        let incomingIDs = Set(after[workspace: name]?.windowIDs ?? [])
        let outgoingIDs = Set(before.focusedWorkspaceName.flatMap { before[workspace: $0]?.windowIDs } ?? [])
        let windowsByID = Dictionary(uniqueKeysWithValues: inventory.windows.map { ($0.id, $0) })
        let previousParkedFrames = after.parkedWindowFrames
        var changed: [(NormalizedWindow, InventoryRect)] = []
        do {
            for id in incomingIDs {
                guard let window = windowsByID[id], let restore = after.parkedWindowFrames[id], let current = window.frame else { continue }
                _ = try await geometry.set(window: window, params: frameParams(id, restore.inventoryRect))
                changed.append((window, current))
                after.parkedWindowFrames.removeValue(forKey: id)
            }
            let rightEdge = inventory.displays.map { $0.frame.x + $0.frame.width }.max() ?? 0
            let bottomEdge = inventory.displays.map { $0.frame.y + $0.frame.height }.max() ?? 0
            for (index, id) in outgoingIDs.subtracting(incomingIDs).sorted().enumerated() {
                guard let window = windowsByID[id], let original = window.frame else { continue }
                let parked = InventoryRect(
                    x: rightEdge + 100 + Double(index * 40),
                    y: bottomEdge + 100 + Double(index * 40),
                    width: original.width,
                    height: original.height
                )
                changed.append((window, original))
                let observed = try await geometry.park(window: window, frame: parked)
                guard observed.x >= rightEdge - 40,
                      observed.y >= bottomEdge - 40,
                      observed.width == parked.width,
                      observed.height == parked.height else {
                    throw WindowGeometryFailure(
                        code: .geometryVerificationFailed,
                        message: "window did not reach the parking corner",
                        observedFrame: observed.protocolFrame
                    )
                }
                after.parkedWindowFrames[id] = .init(original)
            }
            try await tileWorkspace(after, named: name, inventory: inventory)
            try await focusWorkspaceWindow(after, named: name, inventory: inventory)
        } catch {
            for (window, previousFrame) in changed.reversed() {
                _ = try? await geometry.set(window: window, params: frameParams(window.id, previousFrame))
            }
            after.parkedWindowFrames = previousParkedFrames
            throw error
        }
    }

    private func frameParams(_ id: String, _ frame: InventoryRect) -> WindowFrameSetParams {
        .init(windowID: id, frame: .init(x: frame.x, y: frame.y, width: frame.width, height: frame.height))
    }

    private func tileWorkspace(
        _ state: WMWorkspace.WorkspaceState,
        named name: String,
        inventory: InventorySnapshot
    ) async throws {
        guard let workspace = state.workspaces.first(where: { $0.name == name }),
              workspace.mode == .bsp,
              workspace.windowIDs.count > 1,
              let display = inventory.displays.first(where: { $0.id == workspace.displayID }) else { return }
        let bounds = WorkspaceLayoutRect(
            x: display.visibleFrame.x,
            y: display.frame.y + display.frame.height - display.visibleFrame.y - display.visibleFrame.height,
            width: display.visibleFrame.width,
            height: display.visibleFrame.height
        )
        var targets = workspace.layout(in: bounds, minimumSizes: windowMinimumSizes)
        let windows = try workspace.windowIDs.map { try resolveWindow($0, in: inventory.windows) }
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

    private func layoutParams(_ id: String, _ frame: WorkspaceLayoutRect) -> WindowFrameSetParams {
        .init(windowID: id, frame: .init(x: frame.x, y: frame.y, width: frame.width, height: frame.height))
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
            for subscribedTopics in clientSubscriptions.values {
                for topic in topics.intersection(subscribedTopics) {
                    sender?(encode(.event(.init(
                        sequence: workspaceSequence,
                        stateVersion: version,
                        timestamp: Date(),
                        topic: topic,
                        data: eventData
                    ))), clientID)
                }
            }
        }
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

    var code: ErrorCode {
        switch self {
        case .displayRequired: .invalidParams
        case .displayNotFound: .displayNotFound
        case .windowRequired: .windowNotFound
        case .windowNotFound: .windowNotFound
        }
    }

    var message: String {
        switch self {
        case .displayRequired: "no display is available for workspace creation"
        case .displayNotFound(let id): "unknown display: \(id)"
        case .windowRequired: "no focused window is available"
        case .windowNotFound(let id): "unknown window: \(id)"
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
    var isWorkspace: Bool {
        switch self {
        case .workspaceChanged, .workspaceFocused, .workspaceCreated, .workspaceDeleted,
             .workspaceDisplayChanged, .workspaceModeChanged: true
        default: false
        }
    }
}
