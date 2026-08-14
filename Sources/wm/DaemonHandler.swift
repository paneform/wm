import Foundation
import WMCore
import WMInventory
import WMProtocol
import WMWebSocket

actor DaemonHandler: WebSocketRequestHandler {
    typealias State = InventoryState<SystemInventoryProvider>

    private let state: State
    private let router: RequestRouter<SystemInventoryProvider>
    private let geometry = WindowGeometryService(adapter: AXWindowGeometryAdapter())
    private let sessionID = UUID().uuidString
    private let version = "0.0.1-dev"
    private var subscriptions: [UUID: [String: Task<Void, Never>]] = [:]
    private var sender: (@Sendable (String, UUID) -> Void)?

    init(state: State) {
        self.state = state
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
    }

    private func subscribe(_ request: Subscribe, clientID: UUID) async -> [String] {
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
            case .inventoryRefresh: result = json(userState(committed))
            case .daemonPing: result = .object(["session_id": .string(sessionID), "daemon_version": .string(version), "ready": .bool(true), "current_sequence": .number(Double(committed.sequence)), "state_version": .number(Double(committed.stateVersion))])
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
}

private struct WindowDeltaPayload: Encodable { var added: [NormalizedWindow]; var updated: [NormalizedWindow]; var removed: [String] }
private struct DisplayDeltaPayload: Encodable { var added: [DisplayObservation]; var updated: [DisplayObservation]; var removed: [String] }
