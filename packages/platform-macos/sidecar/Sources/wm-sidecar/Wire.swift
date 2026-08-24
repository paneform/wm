import Foundation

// Wire types for the newline-delimited JSON protocol defined in
// docs/rewrite/platform-contract.md. One JSON object per line; stdout carries
// protocol messages ONLY (human logs go to stderr).

struct FrameValue: Codable, Equatable, Sendable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double

    func approximatelyEquals(_ other: FrameValue, tolerance: Double = 0.5) -> Bool {
        abs(x - other.x) <= tolerance && abs(y - other.y) <= tolerance
            && abs(width - other.width) <= tolerance && abs(height - other.height) <= tolerance
    }
}

struct CapabilitiesValue: Codable, Equatable, Sendable {
    /// "unknown" | "supported" | "fixed" | "inconclusive"
    var movable: String
    var resizable: String
    var movableEvidence: String
    var resizableEvidence: String
}

/// Mirrors the engine's WindowObservation schema exactly.
struct WindowValue: Codable, Equatable, Sendable {
    var id: String
    var pid: Int
    var bundleId: String?
    var executablePath: String?
    var title: String?
    var role: String
    var subrole: String?
    var frame: FrameValue
    var minimized: Bool
    var hidden: Bool
    var fullscreen: Bool
    var focused: Bool
    var capabilities: CapabilitiesValue
}

/// Mirrors the engine's DisplayObservation schema exactly.
struct DisplayValue: Codable, Equatable, Sendable {
    var id: String
    var frame: FrameValue
    var workArea: FrameValue
    var scale: Double
    var primary: Bool
}

struct TopologyValue: Codable, Equatable, Sendable {
    var displays: [DisplayValue]
}

/// Mirrors the engine's WriteObservation schema exactly.
struct WriteValue: Codable, Equatable, Sendable {
    var requested: FrameValue
    var observed: FrameValue
    var stable: Bool
    var errorKind: String?
}

// MARK: - Outbound

struct ReadyMessage: Encodable {
    let ready = true
    let version: String
    let accessibility: Bool
    let screenRecording: Bool
}

enum ResultPayload: Encodable {
    case pong(version: String)
    case subscribed
    case topology(TopologyValue)
    case windows([WindowValue])
    case window(WindowValue?)
    case write(WriteValue)
    case focused

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .pong(let version):
            try container.encode(PongPayload(pong: true, version: version))
        case .subscribed:
            try container.encode(SubscribedPayload(subscribed: true))
        case .topology(let topology):
            try container.encode(TopologyPayload(topology: topology))
        case .windows(let windows):
            try container.encode(WindowsPayload(windows: windows))
        case .window(let window):
            try container.encode(WindowPayload(window: window))
        case .write(let write):
            try container.encode(write)
        case .focused:
            try container.encode(FocusedPayload(focused: true))
        }
    }

    private struct PongPayload: Encodable {
        let pong: Bool
        let version: String
    }

    private struct SubscribedPayload: Encodable {
        let subscribed: Bool
    }

    private struct TopologyPayload: Encodable {
        let topology: TopologyValue
    }

    private struct WindowsPayload: Encodable {
        let windows: [WindowValue]
    }

    /// Explicit wrapper so an absent window encodes as {"window": null}
    /// rather than being omitted or collapsing the result to null.
    private struct WindowPayload: Encodable {
        let window: WindowValue?

        private enum Key: String, CodingKey { case window }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: Key.self)
            try container.encode(window, forKey: .window)
        }
    }

    private struct FocusedPayload: Encodable {
        let focused: Bool
    }
}

struct ResultMessage: Encodable {
    let reqId: String
    let result: ResultPayload
}

struct ErrorMessage: Encodable {
    struct ErrorBody: Encodable {
        let code: String
        let detail: String?
    }

    let reqId: String?
    let error: ErrorBody
}

enum EventMessage: Encodable {
    case topologyChanged
    case windowAdded(WindowValue)
    case windowRemoved(windowId: String)
    case windowChanged(WindowValue)
    case focusChanged(windowId: String?)
    case spaceChanged
    case sleep
    case wake

    var name: String {
        switch self {
        case .topologyChanged: "topology_changed"
        case .windowAdded: "window_added"
        case .windowRemoved: "window_removed"
        case .windowChanged: "window_changed"
        case .focusChanged: "focus_changed"
        case .spaceChanged: "space_changed"
        case .sleep: "sleep"
        case .wake: "wake"
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .ev)
        switch self {
        case .topologyChanged, .spaceChanged, .sleep, .wake:
            break
        case .windowAdded(let window), .windowChanged(let window):
            try container.encode(window, forKey: .window)
        case .windowRemoved(let windowId):
            try container.encode(windowId, forKey: .windowId)
        case .focusChanged(let windowId):
            try container.encode(windowId, forKey: .windowId)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case ev, window, windowId
    }
}

// MARK: - Inbound

struct RequestMessage: Decodable, Sendable {
    var op: String
    var reqId: String?
    var id: String?
    var frame: FrameValue?
    /// "frame" | "position" | "size"
    var mode: String?
}

// MARK: - Codec helpers

enum Wire {
    static let version = "wm-sidecar 0.1.0"

    static func encodeLine<T: Encodable>(_ value: T) -> String? {
        let encoder = JSONEncoder()
        guard let data = try? encoder.encode(value) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    static func decodeRequest(_ line: String) -> RequestMessage? {
        guard let data = line.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(RequestMessage.self, from: data)
    }
}
