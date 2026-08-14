import Foundation

public struct CoreRequest: Codable, Equatable, Sendable {
    public let requestID: String
    public let method: String
    public let params: [String: String]

    public init(requestID: String, method: String, params: [String: String] = [:]) {
        self.requestID = requestID
        self.method = method
        self.params = params
    }
}

public struct CoreResponse: Codable, Equatable, Sendable {
    public struct Failure: Codable, Equatable, Sendable {
        public let code: String
        public let message: String
        public let retryable: Bool
    }

    public let requestID: String
    public let ok: Bool
    public let result: Data?
    public let error: Failure?
    public let stateVersion: UInt64
}

public struct RequestRouter<Provider: InventoryProvider>: Sendable {
    private let inventory: InventoryState<Provider>
    private let encoder: JSONEncoder

    public init(inventory: InventoryState<Provider>) {
        self.inventory = inventory
        self.encoder = JSONEncoder()
        self.encoder.keyEncodingStrategy = .convertToSnakeCase
        self.encoder.dateEncodingStrategy = .iso8601
    }

    public func route(_ request: CoreRequest) async -> CoreResponse {
        do {
            let result: Data
            switch request.method {
            case "state.get", "state.observed", "diagnostics.inventory":
                result = try encoder.encode(await inventory.state())
            case "health.get": result = try encoder.encode(await inventory.health())
            case "display.list": result = try encoder.encode(["displays": await inventory.displays()])
            case "window.list": result = try encoder.encode(["windows": await inventory.windows()])
            case "inventory.refresh": result = try encoder.encode(await inventory.refresh())
            case "daemon.ping": result = try encoder.encode(await inventory.state())
            default:
                return await failure(request, code: "method_not_found", message: "unknown method: \(request.method)")
            }
            let version = try await inventory.state().stateVersion
            return CoreResponse(requestID: request.requestID, ok: true, result: result, error: nil, stateVersion: version)
        } catch InventoryStateError.notReady {
            return await failure(request, code: "not_ready", message: "inventory is not ready")
        } catch {
            return await failure(request, code: "inventory_failed", message: String(describing: error), retryable: true)
        }
    }

    private func failure(_ request: CoreRequest, code: String, message: String, retryable: Bool = false) async -> CoreResponse {
        let version = (try? await inventory.state().stateVersion) ?? 0
        return CoreResponse(requestID: request.requestID, ok: false, result: nil, error: .init(code: code, message: message, retryable: retryable), stateVersion: version)
    }
}
