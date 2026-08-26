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
  var nativeId: String
  var frame: FrameValue
  var workArea: FrameValue
  var scale: Double
  var primary: Bool
}

struct TopologyValue: Codable, Equatable, Sendable {
  var displays: [DisplayValue]
}

/// Mirrors the engine's PermissionStatus schema exactly.
struct PermissionsValue: Codable, Equatable, Sendable {
  var accessibility: Bool
  var screenRecording: Bool
}

/// Mirrors the engine's WriteObservation schema exactly.
struct WriteValue: Codable, Equatable, Sendable {
  var requested: FrameValue
  var observed: FrameValue
  var stable: Bool
  var stableReads: Int? = nil
  var errorKind: String?
}

struct BatchOperationValue: Decodable, Sendable {
  var operationId: String
  var kind: String
  var windowId: String
  var frame: FrameValue?
  var expectedIdentity: ExpectedIdentityValue
  var dependsOn: [String]?
}

struct BatchErrorValue: Codable, Equatable, Sendable {
  var code: String
  var detail: String?
}

struct BatchOperationResultValue: Codable, Equatable, Sendable {
  var operationId: String
  var requested: FrameValue?
  var observed: FrameValue?
  var stable: Bool?
  var stableReads: Int?
  var error: BatchErrorValue?
}

struct BatchResultValue: Codable, Equatable, Sendable {
  var operations: [BatchOperationResultValue]
  var completed: Int
  var failed: Int
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
  case batch(BatchResultValue)
  case focused
  case permissions(PermissionsValue)
  case opened
  case keybindsConfigured(Int)

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
    case .batch(let batch):
      try container.encode(batch)
    case .focused:
      try container.encode(FocusedPayload(focused: true))
    case .permissions(let permissions):
      try container.encode(PermissionsPayload(permissions: permissions))
    case .opened:
      try container.encode(OpenedPayload(opened: true))
    case .keybindsConfigured(let count):
      try container.encode(KeybindsConfiguredPayload(configured: count))
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

  private struct PermissionsPayload: Encodable {
    let permissions: PermissionsValue
  }

  private struct OpenedPayload: Encodable {
    let opened: Bool
  }

  private struct KeybindsConfiguredPayload: Encodable {
    let configured: Int
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
  case keybind(action: String)

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
    case .keybind: "keybind"
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(name, forKey: .ev)
    switch self {
    case .topologyChanged, .spaceChanged, .sleep, .wake:
      break
    case .keybind(let action):
      try container.encode(action, forKey: .action)
    case .windowAdded(let window), .windowChanged(let window):
      try container.encode(window, forKey: .window)
    case .windowRemoved(let windowId):
      try container.encode(windowId, forKey: .windowId)
    case .focusChanged(let windowId):
      try container.encode(windowId, forKey: .windowId)
    }
  }

  private enum CodingKeys: String, CodingKey {
    case ev, window, windowId, action
  }
}

// MARK: - Inbound

/// Atomic identity precondition (generic adapter contract §4): compared
/// against live window metadata immediately before any component mutation;
/// mismatch aborts the write with `stale` and leaves the window untouched.
///
/// Single REQUIRED fingerprint token (`JSON.stringify([pid, role ?? null,
/// subrole ?? null])`) — deliberately avoids the absent-vs-null JSON
/// ambiguity for optional metadata fields.
struct ExpectedIdentityValue: Decodable, Sendable {
  var fingerprint: String

  /// MUST mirror the engine's canonical format exactly. AX roles/subroles
  /// are constrained identifiers; quotes are escaped defensively anyway.
  static func fingerprint(pid: Int, role: String?, subrole: String?) -> String {
    func enc(_ v: String?) -> String {
      guard let v else { return "null" }
      return "\""
        + v.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        + "\""
    }
    return "[\(pid),\(enc(role)),\(enc(subrole))]"
  }
}

struct RequestMessage: Decodable, Sendable {
  var op: String
  var reqId: String?
  var id: String?
  var frame: FrameValue?
  /// "frame" | "position" | "size"
  var mode: String?
  /// "accessibility" | "screenRecording" (openPermissionsSettings)
  var target: String?
  var expectedIdentity: ExpectedIdentityValue?
  var operations: [BatchOperationValue]?
  var keybinds: [String: String]?
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
