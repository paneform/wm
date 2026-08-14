import Foundation

public struct InventoryObservationLoop: Sendable {
    public let interval: Duration
    private let sleep: @Sendable (Duration) async throws -> Void
    private let observe: @Sendable () async throws -> Void
    private let report: @Sendable (Error) -> Void

    public init(
        interval: Duration = .seconds(2),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        observe: @escaping @Sendable () async throws -> Void,
        report: @escaping @Sendable (Error) -> Void
    ) {
        self.interval = interval
        self.sleep = sleep
        self.observe = observe
        self.report = report
    }

    public func run() async {
        while !Task.isCancelled {
            do {
                try await sleep(interval)
                try Task.checkCancellation()
                try await observe()
            } catch is CancellationError {
                return
            } catch {
                report(error)
            }
        }
    }
}
