import Foundation

public enum ErrorCode: String, Codable, CaseIterable, Sendable { case invalidMessage = "invalid_message", invalidParams = "invalid_params", methodNotFound = "method_not_found", notReady = "not_ready", paused, permissionDenied = "permission_denied", inventoryFailed = "inventory_failed", subscriptionNotFound = "subscription_not_found", replayUnavailable = "replay_unavailable", windowNotFound = "window_not_found", windowNotControllable = "window_not_controllable", displayNotFound = "display_not_found", workspaceNotFound = "workspace_not_found", workspaceConflict = "workspace_conflict", invalidWorkspaceState = "invalid_workspace_state", invalidFrame = "invalid_frame", geometryRejected = "geometry_rejected", geometryVerificationFailed = "geometry_verification_failed", inventoryStale = "inventory_stale", internalError = "internal_error" }
public struct ProtocolError: Codable, Equatable, Sendable { public var code: ErrorCode; public var message: String; public var retryable: Bool; public var details: [String: JSONValue]; public init(code: ErrorCode, message: String, retryable: Bool, details: [String: JSONValue] = [:]) { self.code = code; self.message = message; self.retryable = retryable; self.details = details } }

public struct Request: Codable, Equatable, Sendable { public var requestId: String; public var method: Method; public var params: [String: JSONValue]; public init(requestId: String, method: Method, params: [String: JSONValue] = [:]) { self.requestId = requestId; self.method = method; self.params = params } }
public struct Subscribe: Codable, Equatable, Sendable { public var requestId: String; public var subscriptionId: String; public var topics: [EventTopic]; public var projection: Projection; public var detail: SnapshotDetail; public var afterSequence: UInt64?; public init(requestId: String, subscriptionId: String, topics: [EventTopic], projection: Projection = .delta, detail: SnapshotDetail = .concise, afterSequence: UInt64? = nil) { self.requestId = requestId; self.subscriptionId = subscriptionId; self.topics = topics; self.projection = projection; self.detail = detail; self.afterSequence = afterSequence } }
public struct Unsubscribe: Codable, Equatable, Sendable { public var requestId: String; public var subscriptionId: String; public init(requestId: String, subscriptionId: String) { self.requestId = requestId; self.subscriptionId = subscriptionId } }

public enum ClientMessage: Codable, Equatable, Sendable {
    case request(Request), subscribe(Subscribe), unsubscribe(Unsubscribe)
    enum Keys: String, CodingKey, CaseIterable {
        case type, method, params, topics, projection, detail
        case requestId = "request_id"
        case subscriptionId = "subscription_id"
        case afterSequence = "after_sequence"
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self); let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "request": try rejectUnknownKeys(decoder, allowed: ["type", "request_id", "method", "params"]); self = .request(.init(requestId: try c.decode(String.self, forKey: .requestId), method: try c.decode(Method.self, forKey: .method), params: try c.decode([String: JSONValue].self, forKey: .params)))
        case "subscribe": try rejectUnknownKeys(decoder, allowed: ["type", "request_id", "subscription_id", "topics", "projection", "detail", "after_sequence"]); self = .subscribe(.init(requestId: try c.decode(String.self, forKey: .requestId), subscriptionId: try c.decode(String.self, forKey: .subscriptionId), topics: try c.decode([EventTopic].self, forKey: .topics), projection: try c.decodeIfPresent(Projection.self, forKey: .projection) ?? .delta, detail: try c.decodeIfPresent(SnapshotDetail.self, forKey: .detail) ?? .concise, afterSequence: try c.decodeIfPresent(UInt64.self, forKey: .afterSequence)))
        case "unsubscribe": try rejectUnknownKeys(decoder, allowed: ["type", "request_id", "subscription_id"]); self = .unsubscribe(.init(requestId: try c.decode(String.self, forKey: .requestId), subscriptionId: try c.decode(String.self, forKey: .subscriptionId)))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unknown client message type: \(type)")
        }
    }
    public func encode(to encoder: Encoder) throws { var c = encoder.container(keyedBy: Keys.self); switch self { case let .request(v): try c.encode("request", forKey: .type); try c.encode(v.requestId, forKey: .requestId); try c.encode(v.method, forKey: .method); try c.encode(v.params, forKey: .params); case let .subscribe(v): try c.encode("subscribe", forKey: .type); try c.encode(v.requestId, forKey: .requestId); try c.encode(v.subscriptionId, forKey: .subscriptionId); try c.encode(v.topics, forKey: .topics); try c.encode(v.projection, forKey: .projection); try c.encode(v.detail, forKey: .detail); try c.encode(v.afterSequence, forKey: .afterSequence); case let .unsubscribe(v): try c.encode("unsubscribe", forKey: .type); try c.encode(v.requestId, forKey: .requestId); try c.encode(v.subscriptionId, forKey: .subscriptionId) } }
}

public struct Welcome: Codable, Equatable, Sendable { public var sessionId: String; public var daemonVersion: String; public var currentSequence: UInt64; public var stateVersion: UInt64; public var health: Health; public init(sessionId: String, daemonVersion: String, currentSequence: UInt64, stateVersion: UInt64, health: Health) { self.sessionId = sessionId; self.daemonVersion = daemonVersion; self.currentSequence = currentSequence; self.stateVersion = stateVersion; self.health = health } }
public struct Response: Codable, Equatable, Sendable { public var requestId: String; public var result: JSONValue?; public var error: ProtocolError?; public var stateVersion: UInt64; public var isSuccess: Bool { error == nil }; public init(requestId: String, result: JSONValue, stateVersion: UInt64) { self.requestId = requestId; self.result = result; self.error = nil; self.stateVersion = stateVersion }; public init(requestId: String, error: ProtocolError, stateVersion: UInt64) { self.requestId = requestId; self.result = nil; self.error = error; self.stateVersion = stateVersion } }
public struct Event: Codable, Equatable, Sendable { public var sequence: UInt64; public var stateVersion: UInt64; public var timestamp: Date; public var topic: EventTopic; public var data: JSONValue; public init(sequence: UInt64, stateVersion: UInt64, timestamp: Date, topic: EventTopic, data: JSONValue) { self.sequence = sequence; self.stateVersion = stateVersion; self.timestamp = timestamp; self.topic = topic; self.data = data } }
public struct ResyncRequired: Codable, Equatable, Sendable { public var subscriptionId: String; public var requestedAfterSequence: UInt64; public var oldestAvailableSequence: UInt64; public var currentSequence: UInt64; public var stateVersion: UInt64; public init(subscriptionId: String, requestedAfterSequence: UInt64, oldestAvailableSequence: UInt64, currentSequence: UInt64, stateVersion: UInt64) { self.subscriptionId = subscriptionId; self.requestedAfterSequence = requestedAfterSequence; self.oldestAvailableSequence = oldestAvailableSequence; self.currentSequence = currentSequence; self.stateVersion = stateVersion } }

public enum ServerMessage: Codable, Equatable, Sendable {
    case welcome(Welcome), response(Response), event(Event), resyncRequired(ResyncRequired)
    enum Keys: String, CodingKey {
        case type, health, ok, result, error, sequence, timestamp, topic, data
        case sessionId = "session_id"
        case daemonVersion = "daemon_version"
        case currentSequence = "current_sequence"
        case stateVersion = "state_version"
        case requestId = "request_id"
        case subscriptionId = "subscription_id"
        case requestedAfterSequence = "requested_after_sequence"
        case oldestAvailableSequence = "oldest_available_sequence"
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self); let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "session.welcome": try rejectUnknownKeys(decoder, allowed: ["type", "session_id", "daemon_version", "current_sequence", "state_version", "health"]); self = .welcome(.init(sessionId: try c.decode(String.self, forKey: .sessionId), daemonVersion: try c.decode(String.self, forKey: .daemonVersion), currentSequence: try c.decode(UInt64.self, forKey: .currentSequence), stateVersion: try c.decode(UInt64.self, forKey: .stateVersion), health: try c.decode(Health.self, forKey: .health)))
        case "response":
            try rejectUnknownKeys(decoder, allowed: ["type", "request_id", "ok", "result", "error", "state_version"]); let ok = try c.decode(Bool.self, forKey: .ok); let id = try c.decode(String.self, forKey: .requestId); let version = try c.decode(UInt64.self, forKey: .stateVersion)
            if ok { guard c.contains(.result), !c.contains(.error) else { throw DecodingError.dataCorruptedError(forKey: .ok, in: c, debugDescription: "Successful response requires result and forbids error") }; self = .response(.init(requestId: id, result: try c.decode(JSONValue.self, forKey: .result), stateVersion: version)) }
            else { guard c.contains(.error), !c.contains(.result) else { throw DecodingError.dataCorruptedError(forKey: .ok, in: c, debugDescription: "Error response requires error and forbids result") }; self = .response(.init(requestId: id, error: try c.decode(ProtocolError.self, forKey: .error), stateVersion: version)) }
        case "event": try rejectUnknownKeys(decoder, allowed: ["type", "sequence", "state_version", "timestamp", "topic", "data"]); self = .event(.init(sequence: try c.decode(UInt64.self, forKey: .sequence), stateVersion: try c.decode(UInt64.self, forKey: .stateVersion), timestamp: try c.decode(Date.self, forKey: .timestamp), topic: try c.decode(EventTopic.self, forKey: .topic), data: try c.decode(JSONValue.self, forKey: .data)))
        case "resync.required": try rejectUnknownKeys(decoder, allowed: ["type", "subscription_id", "requested_after_sequence", "oldest_available_sequence", "current_sequence", "state_version"]); self = .resyncRequired(.init(subscriptionId: try c.decode(String.self, forKey: .subscriptionId), requestedAfterSequence: try c.decode(UInt64.self, forKey: .requestedAfterSequence), oldestAvailableSequence: try c.decode(UInt64.self, forKey: .oldestAvailableSequence), currentSequence: try c.decode(UInt64.self, forKey: .currentSequence), stateVersion: try c.decode(UInt64.self, forKey: .stateVersion)))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unknown server message type: \(type)")
        }
    }
    public func encode(to encoder: Encoder) throws { var c = encoder.container(keyedBy: Keys.self); switch self { case let .welcome(v): try c.encode("session.welcome", forKey: .type); try c.encode(v.sessionId, forKey: .sessionId); try c.encode(v.daemonVersion, forKey: .daemonVersion); try c.encode(v.currentSequence, forKey: .currentSequence); try c.encode(v.stateVersion, forKey: .stateVersion); try c.encode(v.health, forKey: .health); case let .response(v): try c.encode("response", forKey: .type); try c.encode(v.requestId, forKey: .requestId); try c.encode(v.isSuccess, forKey: .ok); try c.encodeIfPresent(v.result, forKey: .result); try c.encodeIfPresent(v.error, forKey: .error); try c.encode(v.stateVersion, forKey: .stateVersion); case let .event(v): try c.encode("event", forKey: .type); try c.encode(v.sequence, forKey: .sequence); try c.encode(v.stateVersion, forKey: .stateVersion); try c.encode(v.timestamp, forKey: .timestamp); try c.encode(v.topic, forKey: .topic); try c.encode(v.data, forKey: .data); case let .resyncRequired(v): try c.encode("resync.required", forKey: .type); try c.encode(v.subscriptionId, forKey: .subscriptionId); try c.encode(v.requestedAfterSequence, forKey: .requestedAfterSequence); try c.encode(v.oldestAvailableSequence, forKey: .oldestAvailableSequence); try c.encode(v.currentSequence, forKey: .currentSequence); try c.encode(v.stateVersion, forKey: .stateVersion) } }
}
