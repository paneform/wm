import Foundation
import WMProtocol

public struct WindowGeometryHandle: Hashable, Sendable {
    public var rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }
}

public enum WindowGeometryComponent: Sendable {
    case position, size
}

public enum WindowGeometryAdapterError: Error, Equatable, Sendable {
    case notFound
    case ambiguous
    case stale
    case notControllable
    case rejected
    case readFailed
}

public protocol WindowGeometryAdapter: Sendable {
    func reconcile(windows: [NormalizedWindow]) async
    func resolve(_ window: NormalizedWindow) async throws -> WindowGeometryHandle
    func validateControllability(of handle: WindowGeometryHandle) async throws
    func readFrame(of handle: WindowGeometryHandle) async throws -> InventoryRect
    func write(_ component: WindowGeometryComponent, frame: InventoryRect, to handle: WindowGeometryHandle) async throws
    func delay() async throws
}

public extension WindowGeometryAdapter {
    func reconcile(windows: [NormalizedWindow]) async {}
}

public struct WindowGeometryFailure: Error, Equatable, Sendable {
    public var code: WindowGeometryErrorCode
    public var message: String
    public var observedFrame: Rectangle?

    public init(code: WindowGeometryErrorCode, message: String, observedFrame: Rectangle? = nil) {
        self.code = code
        self.message = message
        self.observedFrame = observedFrame
    }
}

public struct WindowGeometryService<Adapter: WindowGeometryAdapter>: Sendable {
    private let adapter: Adapter
    private let now: @Sendable () -> Date

    public init(adapter: Adapter, now: @escaping @Sendable () -> Date = Date.init) {
        self.adapter = adapter
        self.now = now
    }

    public func reconcile(windows: [NormalizedWindow]) async {
        await adapter.reconcile(windows: windows)
    }

    public func get(window: NormalizedWindow) async throws -> WindowFrameGetResult {
        let handle = try await resolve(window)
        let frame = try await read(handle)
        return WindowFrameGetResult(windowID: window.id, frame: frame.protocolFrame, observedAt: now())
    }

    public func set(window: NormalizedWindow, params: WindowFrameSetParams) async throws -> WindowFrameSetResult {
        let requested = InventoryRect(params.frame)
        try validate(requested, tolerance: params.tolerance, attempts: params.attempts)
        let handle = try await resolve(window)
        try await validateControllability(handle)
        let started = now()
        var observed = try await read(handle)
        let strategies = Array(WindowGeometryStrategy.all.prefix(params.attempts))
        for (index, strategy) in strategies.enumerated() {
            do {
                if strategy == .delayedPositionThenSize { try await adapter.delay() }
                for component in strategy.components { try await adapter.write(component, frame: requested, to: handle) }
            } catch {
                throw mapAdapter(error, defaultCode: .geometryRejected)
            }
            observed = try await read(handle)
            if observed.approximatelyEquals(requested, tolerance: params.tolerance) {
                return result(window.id, requested, observed, index + 1, strategy, started)
            }
        }
        throw WindowGeometryFailure(code: .geometryVerificationFailed, message: "window frame did not match the requested frame within tolerance", observedFrame: observed.protocolFrame)
    }

    private func resolve(_ window: NormalizedWindow) async throws -> WindowGeometryHandle {
        do { return try await adapter.resolve(window) }
        catch { throw mapAdapter(error, defaultCode: .inventoryStale) }
    }

    private func validateControllability(_ handle: WindowGeometryHandle) async throws {
        do { try await adapter.validateControllability(of: handle) }
        catch { throw mapAdapter(error, defaultCode: .windowNotControllable) }
    }

    private func read(_ handle: WindowGeometryHandle) async throws -> InventoryRect {
        do { return try await adapter.readFrame(of: handle) }
        catch { throw mapAdapter(error, defaultCode: .inventoryStale) }
    }

    private func validate(_ frame: InventoryRect, tolerance: Double, attempts: Int) throws {
        guard frame.isUsable, attempts >= 1, attempts <= 5, tolerance.isFinite, tolerance >= 0, tolerance <= 20 else {
            throw WindowGeometryFailure(code: .invalidFrame, message: "frame, tolerance, or attempts are outside supported bounds")
        }
    }

    private func result(_ id: String, _ requested: InventoryRect, _ observed: InventoryRect, _ attempts: Int, _ strategy: WindowGeometryStrategy, _ started: Date) -> WindowFrameSetResult {
        WindowFrameSetResult(windowID: id, requestedFrame: requested.protocolFrame, observedFrame: observed.protocolFrame, verified: true, attempts: attempts, strategy: strategy, durationMilliseconds: max(0, Int(now().timeIntervalSince(started) * 1_000)))
    }

    private func mapAdapter(_ error: Error, defaultCode: WindowGeometryErrorCode) -> WindowGeometryFailure {
        guard let error = error as? WindowGeometryAdapterError else { return .init(code: defaultCode, message: String(describing: error)) }
        switch error {
        case .notFound: return .init(code: .windowNotFound, message: "window no longer exists")
        case .ambiguous: return .init(code: .inventoryStale, message: "window identity is ambiguous")
        case .stale, .readFailed: return .init(code: .inventoryStale, message: "window inventory identity is stale")
        case .notControllable: return .init(code: .windowNotControllable, message: "window position or size is not writable")
        case .rejected: return .init(code: .geometryRejected, message: "platform rejected the frame change")
        }
    }
}

private extension WindowGeometryStrategy {
    static let all: [Self] = [.positionThenSize, .sizeThenPosition, .delayedPositionThenSize]

    var components: [WindowGeometryComponent] {
        switch self {
        case .positionThenSize, .delayedPositionThenSize: [.position, .size]
        case .sizeThenPosition: [.size, .position]
        }
    }
}

extension InventoryRect {
    init(_ frame: Rectangle) { self.init(x: frame.x, y: frame.y, width: frame.width, height: frame.height) }
    var protocolFrame: Rectangle { Rectangle(x: x, y: y, width: width, height: height) }
}
