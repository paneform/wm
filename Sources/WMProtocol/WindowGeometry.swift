import Foundation

public struct WindowFrameGetParams: Codable, Equatable, Sendable {
    public var windowID: String

    public init(windowID: String) { self.windowID = windowID }

    enum CodingKeys: String, CodingKey { case windowID = "window_id" }
}

public struct WindowFrameSetParams: Codable, Equatable, Sendable {
    public var windowID: String
    public var frame: Rectangle
    public var tolerance: Double
    public var attempts: Int

    public init(windowID: String, frame: Rectangle, tolerance: Double = 1, attempts: Int = 3) {
        self.windowID = windowID
        self.frame = frame
        self.tolerance = tolerance
        self.attempts = attempts
    }

    enum CodingKeys: String, CodingKey { case windowID = "window_id", frame, tolerance, attempts }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        windowID = try container.decode(String.self, forKey: .windowID)
        frame = try container.decode(Rectangle.self, forKey: .frame)
        tolerance = try container.decodeIfPresent(Double.self, forKey: .tolerance) ?? 1
        attempts = try container.decodeIfPresent(Int.self, forKey: .attempts) ?? 3
    }
}

public struct WindowFrameGetResult: Codable, Equatable, Sendable {
    public var windowID: String
    public var frame: Rectangle
    public var observedAt: Date

    public init(windowID: String, frame: Rectangle, observedAt: Date) {
        self.windowID = windowID
        self.frame = frame
        self.observedAt = observedAt
    }

    enum CodingKeys: String, CodingKey { case windowID = "window_id", frame, observedAt = "observed_at" }
}

public enum WindowGeometryStrategy: String, Codable, Equatable, Sendable {
    case positionThenSize = "position_then_size"
    case sizeThenPosition = "size_then_position"
    case delayedPositionThenSize = "delayed_position_then_size"
    case convergedSizeThenPosition = "converged_size_then_position"
}

public struct WindowFrameSetResult: Codable, Equatable, Sendable {
    public var windowID: String
    public var requestedFrame: Rectangle
    public var observedFrame: Rectangle
    public var verified: Bool
    public var attempts: Int
    public var strategy: WindowGeometryStrategy
    public var durationMilliseconds: Int

    public init(windowID: String, requestedFrame: Rectangle, observedFrame: Rectangle, verified: Bool, attempts: Int, strategy: WindowGeometryStrategy, durationMilliseconds: Int) {
        self.windowID = windowID
        self.requestedFrame = requestedFrame
        self.observedFrame = observedFrame
        self.verified = verified
        self.attempts = attempts
        self.strategy = strategy
        self.durationMilliseconds = durationMilliseconds
    }

    enum CodingKeys: String, CodingKey {
        case windowID = "window_id", requestedFrame = "requested_frame", observedFrame = "observed_frame"
        case verified, attempts, strategy, durationMilliseconds = "duration_ms"
    }
}

public enum WindowGeometryErrorCode: String, Codable, CaseIterable, Sendable {
    case windowNotFound = "window_not_found"
    case windowNotControllable = "window_not_controllable"
    case invalidFrame = "invalid_frame"
    case geometryRejected = "geometry_rejected"
    case geometryVerificationFailed = "geometry_verification_failed"
    case inventoryStale = "inventory_stale"
}
